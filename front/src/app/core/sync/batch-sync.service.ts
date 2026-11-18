import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { ApiService } from '../api/api.service';
import { OrquestaApiError } from '../api/api-config';
import {
  BatchUploadRequest,
  BatchUploadResponse,
  OutboundScanEvent,
  RevocationsResponse,
  SignedRosterResponse,
  StoredOutboundScanEvent,
} from '../api/models';
import { ConnectivityService } from '../connectivity/connectivity.service';
import { QrVerifierService, canonicalJson } from '../crypto/qr-verifier.service';
import { ScanStorageService } from '../storage/scan-storage.service';

export const MAX_BATCH_SIZE = 500;
const HEARTBEAT_INTERVAL_MS = 60_000;
const BASE_BACKOFF_MS = 1_500;
const MAX_BACKOFF_MS = 60_000;

@Injectable({ providedIn: 'root' })
export class BatchSyncService {
  private readonly api = inject(ApiService);
  private readonly storage = inject(ScanStorageService);
  private readonly verifier = inject(QrVerifierService);
  private readonly connectivity = inject(ConnectivityService);
  private readonly destroyRef = inject(DestroyRef);

  readonly syncing = signal<boolean>(false);
  readonly lastSyncAt = signal<string | null>(null);
  readonly lastBatchResult = signal<BatchUploadResponse | null>(null);
  readonly lastSyncError = signal<string | null>(null);
  readonly retryAttempt = signal<number>(0);

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.destroyRef.onDestroy(() => this.stopPeriodicSync());
  }

  startPeriodicSync(): void {
    if (this.heartbeatTimer !== null || typeof window === 'undefined') {
      return;
    }
    this.heartbeatTimer = setInterval(() => {
      if (this.connectivity.isOnline()) {
        void this.sendHeartbeat();
        void this.drainPendingBatches();
        void this.refreshRosterAndRevocationsIfNeeded();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  stopPeriodicSync(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  async computeEventsChecksum(events: OutboundScanEvent[]): Promise<string> {
    const sorted = [...events].sort((a, b) => a.sequence - b.sequence);
    const canonical = canonicalJson(sorted);
    return this.verifier.sha256Hex(canonical);
  }

  async refreshRosterAndRevocations(forceRoster = false): Promise<{
    rosterUpdated: boolean;
    revocationsCount: number;
  }> {
    const session = await this.storage.getActiveSession();
    if (!session) {
      throw new Error('No hay sesión de escaneo activa.');
    }

    let rosterUpdated = false;
    const ifNoneMatch = forceRoster ? null : (session.etag ?? `"roster-${session.roster_version}"`);
    const rosterRes = await this.api.getConditional<SignedRosterResponse>(
      `/v1/scan-sessions/${encodeURIComponent(session.session_id)}/roster`,
      ifNoneMatch,
      {
        params: forceRoster ? undefined : { version: session.roster_version },
        scanSession: true,
      },
    );

    if (!rosterRes.notModified && rosterRes.body) {
      const sigOk = await this.verifier.verifyRosterSignature(rosterRes.body);
      if (!sigOk) {
        throw new Error('La firma ES256 del roster recibido es inválida.');
      }
      await this.storage.saveRoster(rosterRes.body, rosterRes.etag);
      rosterUpdated = true;
    }

    const revRes = await this.api.get<RevocationsResponse>(
      `/v1/scan-sessions/${encodeURIComponent(session.session_id)}/revocations`,
      {
        params: { version: session.revocation_version },
        scanSession: true,
      },
    );
    await this.storage.saveRevocations(revRes);

    return {
      rosterUpdated,
      revocationsCount: revRes.revocados.length,
    };
  }

  async refreshRosterAndRevocationsIfNeeded(): Promise<void> {
    const rev = this.storage.revocationsMeta();
    const shouldRefresh =
      !rev ||
      Date.now() > rev.vigente_hasta_ms - 10 * 60 * 1000;
    if (!shouldRefresh) return;
    try {
      await this.refreshRosterAndRevocations(false);
    } catch {
      // Non-fatal background refresh error
    }
  }

  async drainPendingBatches(): Promise<BatchUploadResponse | null> {
    if (this.syncing()) {
      return null;
    }
    const session = await this.storage.getActiveSession();
    if (!session) {
      return null;
    }

    this.syncing.set(true);
    this.lastSyncError.set(null);
    let lastAck: BatchUploadResponse | null = null;

    try {
      while (true) {
        const pending = await this.storage.getPendingOutboundEvents(MAX_BATCH_SIZE);
        if (pending.length === 0) {
          break;
        }

        const chunk = pending.slice(0, MAX_BATCH_SIZE);
        const wireEvents: OutboundScanEvent[] = chunk
          .map((item) => toWireEvent(item))
          .sort((a, b) => a.sequence - b.sequence);

        const seqDesde = wireEvents[0].sequence;
        const seqHasta = wireEvents[wireEvents.length - 1].sequence;
        const batchId =
          chunk[0].batch_id ??
          `${session.session_id}:${session.device_id}:${String(seqDesde).padStart(4, '0')}`;

        await this.storage.assignBatchIdToPending(
          wireEvents.map((e) => e.sequence),
          batchId,
        );

        const checksum = await this.computeEventsChecksum(wireEvents);
        const totalPendingNow = this.storage.queueDepth();
        const remainingAfterThisBatch = Math.max(totalPendingNow - wireEvents.length, 0);

        const payload: BatchUploadRequest = {
          batch_id: batchId,
          device_id: session.device_id,
          event_id: session.event_id,
          key_id: wireEvents.find((e) => e.key_id)?.key_id,
          roster_version: session.roster_version,
          revocation_version: session.revocation_version,
          seq_desde: seqDesde,
          seq_hasta: seqHasta,
          checksum: {
            alg: 'sha256',
            valor: checksum,
            sobre: 'events_json_canonico_ordenado_por_sequence',
          },
          cola_reportada: remainingAfterThisBatch,
          heartbeat_en: new Date().toISOString(),
          events: wireEvents,
        };

        const ack = await this.api.post<BatchUploadResponse>(
          `/v1/scan-sessions/${encodeURIComponent(session.session_id)}/batches`,
          payload,
          {
            idempotencyKey: batchId,
            scanSession: true,
          },
        );

        await this.storage.markBatchSynced(batchId, ack.ack_hasta_sequence, ack.results);
        lastAck = ack;
        this.lastBatchResult.set(ack);
        this.lastSyncAt.set(new Date().toISOString());
        this.retryAttempt.set(0);

        if (pending.length === MAX_BATCH_SIZE) {
          // §6.6: Space out drain chunks with small jitter so backlog doesn't compete with live ingestion
          await sleep(150 + Math.floor(Math.random() * 250));
        }
      }

      await this.sendHeartbeat();
      return lastAck;
    } catch (err) {
      const apiErr = err instanceof OrquestaApiError ? err : null;
      const msg = apiErr?.message ?? (err instanceof Error ? err.message : 'Error de sincronización.');
      this.lastSyncError.set(msg);

      if (apiErr?.status !== 403 && apiErr?.status !== 400) {
        this.scheduleBackoffRetry();
      }
      return lastAck;
    } finally {
      this.syncing.set(false);
    }
  }

  async sendHeartbeat(): Promise<void> {
    const session = await this.storage.getActiveSession();
    if (!session) return;

    try {
      await this.api.put(
        `/v1/scan-sessions/${encodeURIComponent(session.session_id)}/sync-state`,
        {
          cola_reportada: this.storage.queueDepth(),
          ultima_seq_ackeada: this.storage.lastAckedSequence(),
          heartbeat_en: new Date().toISOString(),
        },
        { scanSession: true },
      );
    } catch {
      // Heartbeat failure is non-blocking; TR-18 marks stale devices as 'desconocido' after 5 min
    }
  }

  private scheduleBackoffRetry(): void {
    if (this.retryTimer !== null || typeof window === 'undefined') {
      return;
    }
    const attempt = this.retryAttempt() + 1;
    this.retryAttempt.set(attempt);
    const exp = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt - 1), MAX_BACKOFF_MS);
    const jitter = Math.floor(Math.random() * BASE_BACKOFF_MS);
    const delay = exp + jitter;

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.connectivity.isOnline()) {
        void this.drainPendingBatches();
      }
    }, delay);
  }
}

function toWireEvent(item: StoredOutboundScanEvent): OutboundScanEvent {
  const out: OutboundScanEvent = {
    sequence: item.sequence,
    invitation_id: item.invitation_id,
    scanned_at: item.scanned_at,
    token_sha256: item.token_sha256,
    verdict_local: item.verdict_local,
    modo: item.modo,
  };
  if (item.key_id) {
    out.key_id = item.key_id;
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
