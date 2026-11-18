import { CommonModule } from '@angular/common';
import {
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import jsQR from 'jsqr';
import { ApiService } from '../../../core/api/api.service';
import { OrquestaApiError } from '../../../core/api/api-config';
import {
  CheckinItemDto,
  CheckinVerdict,
  PaginatedResponse,
  RosterGuest,
  StoredOutboundScanEvent,
} from '../../../core/api/models';
import { AuthService } from '../../../core/auth/auth.service';
import { ActiveScanSessionMeta } from '../../../core/auth/auth-token.store';
import { ConnectivityService } from '../../../core/connectivity/connectivity.service';
import { QrEvaluationResult, QrVerifierService } from '../../../core/crypto/qr-verifier.service';
import { ScanStorageService, StoredRosterGuest } from '../../../core/storage/scan-storage.service';
import { BatchSyncService } from '../../../core/sync/batch-sync.service';

interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<Array<{ rawValue?: string }>>;
}

export async function decodeVideoFrame(
  videoEl: HTMLVideoElement,
  detector: BarcodeDetectorLike | null,
  canvasCtx: CanvasRenderingContext2D | null,
  canvasEl: HTMLCanvasElement | null,
): Promise<string | null> {
  if (detector) {
    const codes = await detector.detect(videoEl);
    return codes[0]?.rawValue?.trim() || null;
  }
  if (!canvasCtx || !canvasEl) {
    return null;
  }
  const width = videoEl.videoWidth || 640;
  const height = videoEl.videoHeight || 480;
  if (canvasEl.width !== width) canvasEl.width = width;
  if (canvasEl.height !== height) canvasEl.height = height;
  canvasCtx.drawImage(videoEl, 0, 0, width, height);
  const imageData = canvasCtx.getImageData(0, 0, width, height);
  const result = jsQR(imageData.data, imageData.width, imageData.height, {
    inversionAttempts: 'dontInvert',
  });
  return result?.data?.trim() || null;
}

declare global {
  interface Window {
    BarcodeDetector?: new (options?: { formats?: string[] }) => BarcodeDetectorLike;
  }
}

export interface VerdictDisplayState {
  verdict: CheckinVerdict | 'error';
  title: string;
  subtitle: string;
  tone: 'success' | 'warning' | 'danger';
  guestName?: string;
  codigoCorto?: string;
  mesa?: string | number | null;
  durationMs: number;
  sequence?: number;
  pendingConditionalEvaluation?: QrEvaluationResult;
}

@Component({
  selector: 'app-scanner-terminal-page',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './scanner-terminal.page.html',
  styleUrl: './scanner-terminal.page.scss',
})
export class ScannerTerminalPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly storage = inject(ScanStorageService);
  private readonly verifier = inject(QrVerifierService);
  readonly sync = inject(BatchSyncService);
  readonly connectivity = inject(ConnectivityService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  @ViewChild('videoPreview') videoPreview?: ElementRef<HTMLVideoElement>;

  readonly activeTab = signal<'escaner' | 'manual' | 'actividad'>('escaner');
  readonly session = signal<ActiveScanSessionMeta | null>(null);
  readonly qrTokenInput = signal<string>('');
  readonly manualQuery = signal<string>('');
  readonly manualResults = signal<StoredRosterGuest[]>([]);
  readonly serverSearchResults = signal<Array<{ invitation_id: string; nombre: string; codigo_corto: string; estado?: string }>>([]);
  readonly recentLocalQueue = signal<StoredOutboundScanEvent[]>([]);
  readonly serverCheckins = signal<CheckinItemDto[]>([]);
  readonly annulMotivoMap = signal<Record<string, string>>({});

  readonly lastVerdict = signal<VerdictDisplayState | null>(null);
  readonly bannerError = signal<string | null>(null);
  readonly bannerInfo = signal<string | null>(null);

  readonly cameraSupported = signal<boolean>(
    typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia),
  );
  readonly usingCanvasFallback = signal<boolean>(
    typeof window !== 'undefined' && typeof window.BarcodeDetector !== 'function',
  );
  readonly cameraActive = signal<boolean>(false);
  readonly cameraError = signal<string | null>(null);

  readonly queueDepth = this.storage.queueDepth;
  readonly rosterCount = this.storage.rosterCount;
  readonly lastSequence = this.storage.lastSequence;
  readonly lastAckedSequence = this.storage.lastAckedSequence;
  readonly revocationsMeta = this.storage.revocationsMeta;
  readonly revocationsExpired = this.storage.revocationsExpired;

  readonly canAnnul = computed(() => {
    const perms = this.session()?.permisos ?? [];
    return perms.includes('anulacion') || perms.length === 0;
  });

  private rosterMap = new Map<string, StoredRosterGuest>();
  private revokedSet = new Set<string>();
  private localAdmissionsSet = new Set<string>();
  private cameraStream: MediaStream | null = null;
  private scanLoopTimer: ReturnType<typeof setInterval> | null = null;
  private lastScannedRaw = '';
  private lastScannedAtMs = 0;

  async ngOnInit(): Promise<void> {
    this.connectivity.startMonitoring();
    this.sync.startPeriodicSync();

    this.destroyRef.onDestroy(() => {
      this.stopCamera();
    });

    await this.reloadLocalCaches();
    await this.runManualSearch('');

    if (this.connectivity.isOnline()) {
      void this.sync.refreshRosterAndRevocationsIfNeeded().then(() => this.reloadLocalCaches());
      void this.loadServerCheckins();
    }
  }

  async reloadLocalCaches(): Promise<void> {
    const [ses, guests, rev, admissions, recent] = await Promise.all([
      this.storage.getActiveSession(),
      this.storage.getAllRosterGuests(),
      this.storage.getRevocationsState(),
      this.storage.getLocalAdmissionsSet(),
      this.storage.getRecentOutboundEvents(40),
    ]);

    this.session.set(ses);
    this.rosterMap = new Map(guests.map((g) => [g.invitation_id, g]));
    this.revokedSet = new Set(rev?.revocados ?? []);
    this.localAdmissionsSet = admissions;
    this.recentLocalQueue.set(recent);
  }

  async startCamera(): Promise<void> {
    if (this.cameraActive()) return;
    this.cameraError.set(null);

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      this.cameraError.set('El navegador no permite acceso a la cámara. Usa el fallback manual o pega el token.');
      return;
    }

    try {
      this.cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      this.cameraActive.set(true);

      setTimeout(() => {
        const videoEl = this.videoPreview?.nativeElement;
        if (videoEl && this.cameraStream) {
          videoEl.srcObject = this.cameraStream;
          void videoEl.play();
          this.startBarcodeLoop(videoEl);
        }
      }, 50);
    } catch {
      this.cameraError.set('Permiso de cámara denegado o sin cámara disponible. Usa el fallback manual.');
      this.stopCamera();
    }
  }

  stopCamera(): void {
    if (this.scanLoopTimer !== null) {
      clearInterval(this.scanLoopTimer);
      this.scanLoopTimer = null;
    }
    if (this.cameraStream) {
      for (const track of this.cameraStream.getTracks()) {
        track.stop();
      }
      this.cameraStream = null;
    }
    this.cameraActive.set(false);
  }

  private startBarcodeLoop(videoEl: HTMLVideoElement): void {
    const DetectorCtor = typeof window !== 'undefined' ? window.BarcodeDetector : undefined;
    const detector = DetectorCtor ? new DetectorCtor({ formats: ['qr_code'] }) : null;
    const canvasEl = detector || typeof document === 'undefined' ? null : document.createElement('canvas');
    const canvasCtx = canvasEl ? canvasEl.getContext('2d', { willReadFrequently: true }) : null;
    this.usingCanvasFallback.set(!detector);

    this.scanLoopTimer = setInterval(async () => {
      if (videoEl.readyState < 2) return;
      try {
        const raw = await decodeVideoFrame(videoEl, detector, canvasCtx, canvasEl);
        if (!raw) return;

        const now = Date.now();
        if (raw === this.lastScannedRaw && now - this.lastScannedAtMs < 2500) {
          return;
        }
        this.lastScannedRaw = raw;
        this.lastScannedAtMs = now;
        await this.processQrToken(raw);
      } catch {
        // Ignore single frame detection failures
      }
    }, 180);
  }

  async submitQrInput(): Promise<void> {
    const raw = this.qrTokenInput().trim();
    if (!raw) return;
    await this.processQrToken(raw);
    this.qrTokenInput.set('');
  }

  async processQrToken(rawToken: string): Promise<void> {
    const ses = this.session();
    if (!ses || !ses.key_publica_pem) {
      this.bannerError.set('Falta la sesión o clave pública del roster. Refresca la sesión.');
      return;
    }
    this.bannerError.set(null);

    const rev = this.revocationsMeta();
    const evaluation = await this.verifier.evaluateQrToken(rawToken, {
      eventId: ses.event_id,
      publicKeyPem: ses.key_publica_pem,
      rosterByInvitation: this.rosterMap,
      revokedIds: this.revokedSet,
      localAdmissions: this.localAdmissionsSet,
      revocationsValidUntilMs: rev?.vigente_hasta_ms ?? 0,
    });

    if (!evaluation.validSignature || !evaluation.verdict || !evaluation.invitationId) {
      this.lastVerdict.set({
        verdict: 'error',
        title: evaluation.errorCode === 'TOKEN_TIPO_INCORRECTO' ? 'Token incorrecto (RSVP)' : 'QR inválido',
        subtitle: evaluation.message,
        tone: 'danger',
        durationMs: evaluation.durationMs,
      });
      return;
    }

    if (evaluation.verdict === 'no_en_roster' && evaluation.requiresConditionalConfirm) {
      this.lastVerdict.set({
        verdict: 'no_en_roster',
        title: 'No está en el roster local (no_en_roster)',
        subtitle: evaluation.message,
        tone: 'warning',
        durationMs: evaluation.durationMs,
        pendingConditionalEvaluation: evaluation,
      });
      return;
    }

    await this.persistAndShowVerdict(evaluation, 'camara');
  }

  async confirmConditionalNoEnRoster(): Promise<void> {
    const current = this.lastVerdict();
    if (!current?.pendingConditionalEvaluation) return;
    const evalCopy: QrEvaluationResult = {
      ...current.pendingConditionalEvaluation,
      admits: true,
    };
    await this.persistAndShowVerdict(evalCopy, 'camara');
  }

  async runManualSearch(query: string): Promise<void> {
    this.manualQuery.set(query);
    const matches = await this.storage.searchRosterLocal(query, 30);
    this.manualResults.set(matches);
  }

  async searchOnServer(): Promise<void> {
    const ses = this.session();
    const q = this.manualQuery().trim();
    if (!ses || !q) return;
    this.bannerError.set(null);

    try {
      const params = /^\d{6}$/.test(q) ? { codigo_corto: q } : { nombre: q };
      const res = await this.api.get<{
        items: Array<{ invitation_id: string; nombre: string; codigo_corto: string; estado?: string }>;
      }>(`/v1/scan-sessions/${encodeURIComponent(ses.session_id)}/roster/search`, {
        params,
        scanSession: true,
      });
      this.serverSearchResults.set(res.items);
    } catch (err) {
      this.bannerError.set(
        err instanceof OrquestaApiError ? err.message : 'No se pudo consultar en servidor.',
      );
    }
  }

  async admitManualGuest(guest: RosterGuest): Promise<void> {
    const rev = this.revocationsMeta();
    const evaluation = await this.verifier.evaluateManualGuest(guest, {
      revokedIds: this.revokedSet,
      localAdmissions: this.localAdmissionsSet,
      revocationsValidUntilMs: rev?.vigente_hasta_ms ?? 0,
    });
    await this.persistAndShowVerdict(evaluation, 'codigo_corto');
  }

  private async persistAndShowVerdict(
    evaluation: QrEvaluationResult,
    modo: 'camara' | 'codigo_corto',
  ): Promise<void> {
    if (!evaluation.invitationId || !evaluation.verdict) return;
    const scannedAt = new Date().toISOString();

    // RPO 0: Write to IndexedDB readwrite transaction BEFORE showing verdict in UI (NFR-06)
    const persisted = await this.storage.recordScanAtomic({
      invitation_id: evaluation.invitationId,
      scanned_at: scannedAt,
      token_sha256: evaluation.tokenSha256,
      verdict_local: evaluation.verdict,
      modo,
      key_id: evaluation.keyId,
      guest_nombre: evaluation.guest?.nombre,
      grantsAdmission: evaluation.admits,
    });

    if (evaluation.admits) {
      this.localAdmissionsSet.add(evaluation.invitationId);
    }

    this.recentLocalQueue.set(await this.storage.getRecentOutboundEvents(40));
    this.lastVerdict.set(mapVerdictDisplay(evaluation, persisted.sequence));

    if (this.connectivity.isOnline() && this.queueDepth() >= 1) {
      void this.syncNow();
    }
  }

  async syncNow(): Promise<void> {
    this.bannerError.set(null);
    const ack = await this.sync.drainPendingBatches();
    this.recentLocalQueue.set(await this.storage.getRecentOutboundEvents(40));
    if (ack) {
      this.bannerInfo.set(
        `Sincronizado lote ${ack.batch_id}: ${ack.contadores.aceptados} aceptados, ${ack.contadores.duplicados} duplicados, ${ack.contadores.tardios} tardíos.`,
      );
      if (this.connectivity.isOnline()) {
        void this.loadServerCheckins();
      }
    } else if (this.sync.lastSyncError()) {
      this.bannerError.set(this.sync.lastSyncError());
    }
  }

  async refreshRosterNow(): Promise<void> {
    this.bannerError.set(null);
    try {
      const res = await this.sync.refreshRosterAndRevocations(false);
      await this.reloadLocalCaches();
      await this.runManualSearch(this.manualQuery());
      this.bannerInfo.set(
        res.rosterUpdated
          ? `Roster actualizado y verificado (${this.rosterCount()} invitados, ${res.revocationsCount} revocaciones).`
          : `Roster sin cambios (304). Lista de revocación renovada por 2 h (${res.revocationsCount} revocadas).`,
      );
    } catch (err) {
      this.bannerError.set(
        err instanceof OrquestaApiError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : 'No se pudo refrescar el roster.',
      );
    }
  }

  async loadServerCheckins(): Promise<void> {
    const ses = this.session();
    if (!ses || !this.connectivity.isOnline()) return;
    try {
      const res = await this.api.get<PaginatedResponse<CheckinItemDto>>(
        `/v1/events/${encodeURIComponent(ses.event_id)}/checkins`,
        {
          params: { limit: 25 },
          scanSession: true,
        },
      );
      this.serverCheckins.set(res.items);
    } catch {
      // Non-fatal while offline
    }
  }

  setAnnulMotivo(checkinId: string, motivo: string): void {
    this.annulMotivoMap.update((curr) => ({ ...curr, [checkinId]: motivo }));
  }

  async annulCheckin(checkinId: string): Promise<void> {
    const ses = this.session();
    const motivo = (this.annulMotivoMap()[checkinId] ?? '').trim();
    if (!ses || !motivo) {
      this.bannerError.set('Ingresa un motivo obligatorio para anular el check-in (RF-14).');
      return;
    }

    this.bannerError.set(null);
    const target = this.serverCheckins().find((c) => c.checkin_id === checkinId);
    try {
      await this.api.post(
        `/v1/events/${encodeURIComponent(ses.event_id)}/checkins/${encodeURIComponent(checkinId)}/annulments`,
        { motivo, annuls_checkin_id: checkinId },
        { scanSession: true },
      );
      if (target?.invitation_id) {
        await this.storage.removeLocalAdmission(target.invitation_id);
        this.localAdmissionsSet.delete(target.invitation_id);
      }
      this.bannerInfo.set(`Check-in ${checkinId} anulado con registro compensatorio (RF-14).`);
      await this.loadServerCheckins();
    } catch (err) {
      this.bannerError.set(
        err instanceof OrquestaApiError
          ? `${err.code}: ${err.message}`
          : 'No se pudo anular el check-in.',
      );
    }
  }

  async switchSession(): Promise<void> {
    this.stopCamera();
    await this.router.navigate(['/scan'], { queryParams: { switch: '1' } });
  }
}

function mapVerdictDisplay(evalRes: QrEvaluationResult, sequence: number): VerdictDisplayState {
  const titles: Record<CheckinVerdict, { title: string; tone: 'success' | 'warning' | 'danger' }> = {
    admitido: { title: 'Admitido', tone: 'success' },
    ya_registrado: { title: 'Ya registrado', tone: 'warning' },
    no_corresponde_al_evento: { title: 'No corresponde al evento', tone: 'danger' },
    invitacion_revocada: { title: 'Invitación revocada', tone: 'danger' },
    no_verificable_offline: {
      title: 'Admitido condicional (revocación > 2 h)',
      tone: 'warning',
    },
    no_en_roster: {
      title: 'Admitido condicional (no_en_roster)',
      tone: 'warning',
    },
  };

  const verdict = evalRes.verdict ?? 'admitido';
  const meta = titles[verdict];

  return {
    verdict,
    title: meta.title,
    subtitle: evalRes.message,
    tone: meta.tone,
    guestName: evalRes.guest?.nombre,
    codigoCorto: evalRes.guest?.codigo_corto,
    mesa: evalRes.guest?.mesa,
    durationMs: evalRes.durationMs,
    sequence,
  };
}
