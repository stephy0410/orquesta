import { Injectable, InjectionToken, computed, inject, signal } from '@angular/core';
import {
  BatchEventResult,
  CheckinVerdict,
  RevocationsResponse,
  RosterGuest,
  ScanModo,
  SignedRosterResponse,
  StoredOutboundScanEvent,
} from '../api/models';
import { ActiveScanSessionMeta } from '../auth/auth-token.store';

export const IDB_FACTORY = new InjectionToken<IDBFactory | null>('IDB_FACTORY', {
  providedIn: 'root',
  factory: () => (typeof indexedDB !== 'undefined' ? indexedDB : null),
});

export const SCAN_DB_NAME = 'orquesta_scan_db';
export const SCAN_DB_VERSION = 1;

export interface StoredSessionRecord extends ActiveScanSessionMeta {
  key: 'active_session';
}

export interface StoredRosterGuest extends RosterGuest {
  nombre_norm: string;
}

export interface StoredRevocationsState {
  key: 'current';
  version: number;
  emitida_en: string;
  ttl_horas: number;
  vigente_hasta: string;
  vigente_hasta_ms: number;
  refrescar_antes_de?: string;
  revocados: string[];
}

export interface LocalAdmissionRecord {
  invitation_id: string;
  admitted_at: string;
  sequence: number;
  verdict: CheckinVerdict;
}

export interface RecordScanInput {
  invitation_id: string;
  scanned_at: string;
  token_sha256: string;
  verdict_local: CheckinVerdict;
  modo: ScanModo;
  key_id?: string;
  guest_nombre?: string;
  grantsAdmission: boolean;
}

export function normalizeSearchText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

@Injectable({ providedIn: 'root' })
export class ScanStorageService {
  private readonly idbFactory = inject(IDB_FACTORY);
  private dbPromise: Promise<IDBDatabase> | null = null;

  readonly queueDepth = signal<number>(0);
  readonly lastSequence = signal<number>(0);
  readonly lastAckedSequence = signal<number>(0);
  readonly rosterCount = signal<number>(0);
  readonly revocationsMeta = signal<StoredRevocationsState | null>(null);

  readonly revocationsExpired = computed(() => {
    const rev = this.revocationsMeta();
    if (!rev) return true;
    return Date.now() > rev.vigente_hasta_ms;
  });

  private openDb(): Promise<IDBDatabase> {
    if (this.dbPromise) {
      return this.dbPromise;
    }
    const factory = this.idbFactory;
    if (!factory) {
      return Promise.reject(new Error('IndexedDB no está disponible en este entorno.'));
    }

    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(SCAN_DB_NAME, SCAN_DB_VERSION);

      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('session_meta')) {
          db.createObjectStore('session_meta', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('roster_guests')) {
          const guestStore = db.createObjectStore('roster_guests', { keyPath: 'invitation_id' });
          guestStore.createIndex('by_codigo_corto', 'codigo_corto', { unique: false });
          guestStore.createIndex('by_nombre_norm', 'nombre_norm', { unique: false });
        }
        if (!db.objectStoreNames.contains('revocations')) {
          db.createObjectStore('revocations', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('local_admissions')) {
          db.createObjectStore('local_admissions', { keyPath: 'invitation_id' });
        }
        if (!db.objectStoreNames.contains('outbound_queue')) {
          const queueStore = db.createObjectStore('outbound_queue', { keyPath: 'sequence' });
          queueStore.createIndex('by_synced', 'synced', { unique: false });
        }
      };

      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          this.dbPromise = null;
        };
        resolve(db);
      };

      req.onerror = () => {
        this.dbPromise = null;
        reject(req.error ?? new Error('No se pudo abrir IndexedDB.'));
      };
    });

    return this.dbPromise;
  }

  async initSession(meta: ActiveScanSessionMeta): Promise<ActiveScanSessionMeta> {
    const db = await this.openDb();
    const existing = await this.getActiveSession();

    const sameEventAndDevice =
      existing !== null &&
      existing.event_id === meta.event_id &&
      existing.device_id === meta.device_id;

    const merged: StoredSessionRecord = {
      ...meta,
      last_sequence: sameEventAndDevice ? existing.last_sequence : meta.last_sequence,
      last_acked_sequence: sameEventAndDevice
        ? Math.max(existing.last_acked_sequence, meta.last_acked_sequence)
        : meta.last_acked_sequence,
      etag: sameEventAndDevice ? (existing.etag ?? meta.etag ?? null) : (meta.etag ?? null),
      key_publica_pem: sameEventAndDevice
        ? (meta.key_publica_pem ?? existing.key_publica_pem ?? null)
        : (meta.key_publica_pem ?? null),
      key: 'active_session',
    };

    const stores = sameEventAndDevice
      ? ['session_meta']
      : ['session_meta', 'roster_guests', 'revocations', 'local_admissions', 'outbound_queue'];

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(stores, 'readwrite');
      if (!sameEventAndDevice) {
        tx.objectStore('roster_guests').clear();
        tx.objectStore('revocations').clear();
        tx.objectStore('local_admissions').clear();
        tx.objectStore('outbound_queue').clear();
      }
      tx.objectStore('session_meta').put(merged);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Error al guardar sesión en IndexedDB.'));
      tx.onabort = () => reject(tx.error ?? new Error('Transacción abortada en IndexedDB.'));
    });

    await this.refreshStats();
    const { key: _k, ...plain } = merged;
    return plain;
  }

  async getActiveSession(): Promise<ActiveScanSessionMeta | null> {
    const db = await this.openDb();
    const rec = await new Promise<StoredSessionRecord | undefined>((resolve, reject) => {
      const tx = db.transaction(['session_meta'], 'readonly');
      const req = tx.objectStore('session_meta').get('active_session');
      req.onsuccess = () => resolve(req.result as StoredSessionRecord | undefined);
      req.onerror = () => reject(req.error ?? new Error('Error leyendo session_meta.'));
    });
    if (!rec) return null;
    const { key: _k, ...meta } = rec;
    return meta;
  }

  async updateSessionMeta(patch: Partial<ActiveScanSessionMeta>): Promise<ActiveScanSessionMeta | null> {
    const db = await this.openDb();
    const updated = await new Promise<StoredSessionRecord | null>((resolve, reject) => {
      const tx = db.transaction(['session_meta'], 'readwrite');
      const store = tx.objectStore('session_meta');
      const getReq = store.get('active_session');
      let nextRecord: StoredSessionRecord | null = null;
      getReq.onsuccess = () => {
        const current = getReq.result as StoredSessionRecord | undefined;
        if (!current) {
          nextRecord = null;
          return;
        }
        nextRecord = { ...current, ...patch, key: 'active_session' };
        store.put(nextRecord);
      };
      tx.oncomplete = () => resolve(nextRecord);
      tx.onerror = () => reject(tx.error ?? new Error('Error actualizando session_meta.'));
    });

    if (!updated) return null;
    this.lastSequence.set(updated.last_sequence);
    this.lastAckedSequence.set(updated.last_acked_sequence);
    const { key: _k, ...plain } = updated;
    return plain;
  }

  async clearSession(): Promise<void> {
    const db = await this.openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(
        ['session_meta', 'roster_guests', 'revocations', 'local_admissions', 'outbound_queue'],
        'readwrite',
      );
      tx.objectStore('session_meta').clear();
      tx.objectStore('roster_guests').clear();
      tx.objectStore('revocations').clear();
      tx.objectStore('local_admissions').clear();
      tx.objectStore('outbound_queue').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Error limpiando IndexedDB.'));
    });
    this.queueDepth.set(0);
    this.lastSequence.set(0);
    this.lastAckedSequence.set(0);
    this.rosterCount.set(0);
    this.revocationsMeta.set(null);
  }

  async saveRoster(roster: SignedRosterResponse, etag: string | null): Promise<void> {
    const db = await this.openDb();
    const currentRev = await this.getRevocationsState();

    const vigenteHastaMs = Date.parse(roster.revocaciones.vigente_hasta);
    const nextRev: StoredRevocationsState = {
      key: 'current',
      version: roster.revocaciones.version,
      emitida_en: roster.revocaciones.emitida_en,
      ttl_horas: roster.revocaciones.ttl_horas,
      vigente_hasta: roster.revocaciones.vigente_hasta,
      vigente_hasta_ms: Number.isFinite(vigenteHastaMs)
        ? vigenteHastaMs
        : Date.now() + roster.revocaciones.ttl_horas * 3600 * 1000,
      refrescar_antes_de: roster.revocaciones.refrescar_antes_de,
      revocados: currentRev?.revocados ?? [],
    };

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['roster_guests', 'revocations', 'session_meta'], 'readwrite');
      const guestStore = tx.objectStore('roster_guests');
      guestStore.clear();
      for (const guest of roster.invitados) {
        const stored: StoredRosterGuest = {
          ...guest,
          nombre_norm: normalizeSearchText(guest.nombre),
        };
        guestStore.put(stored);
      }

      tx.objectStore('revocations').put(nextRev);

      const metaStore = tx.objectStore('session_meta');
      const getReq = metaStore.get('active_session');
      getReq.onsuccess = () => {
        const current = getReq.result as StoredSessionRecord | undefined;
        if (current) {
          metaStore.put({
            ...current,
            event_nombre: roster.evento.nombre,
            roster_version: roster.roster_version,
            revocation_version: roster.revocaciones.version,
            key_publica_pem: roster.key_publica_pem,
            etag: etag ?? `"roster-${roster.roster_version}"`,
            key: 'active_session',
          });
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Error guardando roster en IndexedDB.'));
    });

    this.revocationsMeta.set(nextRev);
    await this.refreshStats();
  }

  async saveRevocations(rev: RevocationsResponse): Promise<StoredRevocationsState> {
    const db = await this.openDb();
    const emitida = rev.emitida_en ?? new Date().toISOString();
    const vigenteHastaMs = Date.parse(rev.vigente_hasta);
    const record: StoredRevocationsState = {
      key: 'current',
      version: rev.version,
      emitida_en: emitida,
      ttl_horas: rev.ttl_horas,
      vigente_hasta: rev.vigente_hasta,
      vigente_hasta_ms: Number.isFinite(vigenteHastaMs)
        ? vigenteHastaMs
        : Date.now() + rev.ttl_horas * 3600 * 1000,
      revocados: rev.revocados ?? [],
    };

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['revocations', 'session_meta'], 'readwrite');
      tx.objectStore('revocations').put(record);
      const metaStore = tx.objectStore('session_meta');
      const getReq = metaStore.get('active_session');
      getReq.onsuccess = () => {
        const current = getReq.result as StoredSessionRecord | undefined;
        if (current) {
          metaStore.put({
            ...current,
            revocation_version: rev.version,
            key: 'active_session',
          });
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Error guardando revocaciones.'));
    });

    this.revocationsMeta.set(record);
    return record;
  }

  async getRevocationsState(): Promise<StoredRevocationsState | null> {
    const db = await this.openDb();
    const rec = await new Promise<StoredRevocationsState | undefined>((resolve, reject) => {
      const tx = db.transaction(['revocations'], 'readonly');
      const req = tx.objectStore('revocations').get('current');
      req.onsuccess = () => resolve(req.result as StoredRevocationsState | undefined);
      req.onerror = () => reject(req.error ?? new Error('Error leyendo revocaciones.'));
    });
    if (rec) {
      this.revocationsMeta.set(rec);
    }
    return rec ?? null;
  }

  async getRosterGuest(invitationId: string): Promise<StoredRosterGuest | null> {
    const db = await this.openDb();
    const rec = await new Promise<StoredRosterGuest | undefined>((resolve, reject) => {
      const tx = db.transaction(['roster_guests'], 'readonly');
      const req = tx.objectStore('roster_guests').get(invitationId);
      req.onsuccess = () => resolve(req.result as StoredRosterGuest | undefined);
      req.onerror = () => reject(req.error ?? new Error('Error leyendo roster_guests.'));
    });
    return rec ?? null;
  }

  async getAllRosterGuests(): Promise<StoredRosterGuest[]> {
    const db = await this.openDb();
    return new Promise<StoredRosterGuest[]>((resolve, reject) => {
      const tx = db.transaction(['roster_guests'], 'readonly');
      const req = tx.objectStore('roster_guests').getAll();
      req.onsuccess = () => resolve((req.result as StoredRosterGuest[]) ?? []);
      req.onerror = () => reject(req.error ?? new Error('Error listando roster_guests.'));
    });
  }

  async searchRosterLocal(query: string, limit = 25): Promise<StoredRosterGuest[]> {
    const norm = normalizeSearchText(query);
    if (!norm) {
      const all = await this.getAllRosterGuests();
      return all.slice(0, limit);
    }
    const guests = await this.getAllRosterGuests();
    const digitsOnly = /^\d{1,6}$/.test(norm);

    const exactCode: StoredRosterGuest[] = [];
    const partial: StoredRosterGuest[] = [];

    for (const g of guests) {
      if (g.codigo_corto === norm) {
        exactCode.push(g);
      } else if (
        (digitsOnly && g.codigo_corto.includes(norm)) ||
        g.nombre_norm.includes(norm)
      ) {
        partial.push(g);
      }
      if (exactCode.length + partial.length >= limit * 2) {
        break;
      }
    }

    return [...exactCode, ...partial].slice(0, limit);
  }

  async isLocallyAdmitted(invitationId: string): Promise<boolean> {
    const db = await this.openDb();
    const rec = await new Promise<LocalAdmissionRecord | undefined>((resolve, reject) => {
      const tx = db.transaction(['local_admissions'], 'readonly');
      const req = tx.objectStore('local_admissions').get(invitationId);
      req.onsuccess = () => resolve(req.result as LocalAdmissionRecord | undefined);
      req.onerror = () => reject(req.error ?? new Error('Error leyendo local_admissions.'));
    });
    return rec !== undefined;
  }

  async removeLocalAdmission(invitationId: string): Promise<void> {
    const db = await this.openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['local_admissions'], 'readwrite');
      tx.objectStore('local_admissions').delete(invitationId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Error eliminando admisión local.'));
    });
  }

  async getLocalAdmissionsSet(): Promise<Set<string>> {
    const db = await this.openDb();
    const rows = await new Promise<LocalAdmissionRecord[]>((resolve, reject) => {
      const tx = db.transaction(['local_admissions'], 'readonly');
      const req = tx.objectStore('local_admissions').getAll();
      req.onsuccess = () => resolve((req.result as LocalAdmissionRecord[]) ?? []);
      req.onerror = () => reject(req.error ?? new Error('Error listando local_admissions.'));
    });
    return new Set(rows.map((r) => r.invitation_id));
  }

  /**
   * Persiste atómicamente en IndexedDB (transacción readwrite) ANTES de emitir el veredicto en UI (RPO 0, NFR-06).
   */
  async recordScanAtomic(input: RecordScanInput): Promise<StoredOutboundScanEvent> {
    const db = await this.openDb();

    const persisted = await new Promise<StoredOutboundScanEvent>((resolve, reject) => {
      const tx = db.transaction(
        ['session_meta', 'local_admissions', 'outbound_queue'],
        'readwrite',
      );
      const metaStore = tx.objectStore('session_meta');
      const admissionsStore = tx.objectStore('local_admissions');
      const queueStore = tx.objectStore('outbound_queue');

      let eventToPersist: StoredOutboundScanEvent | null = null;
      let nextSeq = 1;

      const metaReq = metaStore.get('active_session');
      metaReq.onsuccess = () => {
        const current = metaReq.result as StoredSessionRecord | undefined;
        if (!current) {
          tx.abort();
          reject(new Error('No hay sesión de escaneo activa en IndexedDB.'));
          return;
        }

        nextSeq = (current.last_sequence ?? 0) + 1;
        eventToPersist = {
          sequence: nextSeq,
          invitation_id: input.invitation_id,
          scanned_at: input.scanned_at,
          token_sha256: input.token_sha256,
          verdict_local: input.verdict_local,
          modo: input.modo,
          key_id: input.key_id,
          synced: 0,
          guest_nombre: input.guest_nombre,
        };

        if (input.grantsAdmission) {
          const admission: LocalAdmissionRecord = {
            invitation_id: input.invitation_id,
            admitted_at: input.scanned_at,
            sequence: nextSeq,
            verdict: input.verdict_local,
          };
          admissionsStore.put(admission);
        }

        queueStore.put(eventToPersist);
        metaStore.put({
          ...current,
          last_sequence: nextSeq,
          key: 'active_session',
        });
      };

      tx.oncomplete = () => {
        if (eventToPersist) {
          resolve(eventToPersist);
        } else {
          reject(new Error('No se pudo persistir el evento de escaneo.'));
        }
      };
      tx.onerror = () => reject(tx.error ?? new Error('Error en transacción RPO-0 de IndexedDB.'));
      tx.onabort = () => reject(tx.error ?? new Error('Transacción RPO-0 abortada.'));
    });

    await this.refreshStats();
    return persisted;
  }

  async getPendingOutboundEvents(limit = 500): Promise<StoredOutboundScanEvent[]> {
    const db = await this.openDb();
    const all = await new Promise<StoredOutboundScanEvent[]>((resolve, reject) => {
      const tx = db.transaction(['outbound_queue'], 'readonly');
      const idx = tx.objectStore('outbound_queue').index('by_synced');
      const req = idx.getAll(0);
      req.onsuccess = () => resolve((req.result as StoredOutboundScanEvent[]) ?? []);
      req.onerror = () => reject(req.error ?? new Error('Error leyendo outbound_queue.'));
    });
    return all.sort((a, b) => a.sequence - b.sequence).slice(0, limit);
  }

  async getRecentOutboundEvents(limit = 50): Promise<StoredOutboundScanEvent[]> {
    const db = await this.openDb();
    const all = await new Promise<StoredOutboundScanEvent[]>((resolve, reject) => {
      const tx = db.transaction(['outbound_queue'], 'readonly');
      const req = tx.objectStore('outbound_queue').getAll();
      req.onsuccess = () => resolve((req.result as StoredOutboundScanEvent[]) ?? []);
      req.onerror = () => reject(req.error ?? new Error('Error leyendo historial local.'));
    });
    return all.sort((a, b) => b.sequence - a.sequence).slice(0, limit);
  }

  async assignBatchIdToPending(sequences: number[], batchId: string): Promise<void> {
    if (sequences.length === 0) return;
    const db = await this.openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['outbound_queue'], 'readwrite');
      const store = tx.objectStore('outbound_queue');
      for (const seq of sequences) {
        const req = store.get(seq);
        req.onsuccess = () => {
          const item = req.result as StoredOutboundScanEvent | undefined;
          if (item && item.synced === 0) {
            store.put({ ...item, batch_id: batchId });
          }
        };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Error asignando batch_id en cola.'));
    });
  }

  async markBatchSynced(
    batchId: string,
    ackHastaSequence: number,
    results: BatchEventResult[],
  ): Promise<void> {
    const db = await this.openDb();
    const resultBySeq = new Map<number, BatchEventResult>();
    for (const r of results) {
      resultBySeq.set(r.sequence, r);
    }

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['outbound_queue', 'session_meta'], 'readwrite');
      const queueStore = tx.objectStore('outbound_queue');
      const idx = queueStore.index('by_synced');
      const pendingReq = idx.getAll(0);

      pendingReq.onsuccess = () => {
        const items = (pendingReq.result as StoredOutboundScanEvent[]) ?? [];
        for (const item of items) {
          const matchedResult = resultBySeq.get(item.sequence);
          if (matchedResult || item.batch_id === batchId || item.sequence <= ackHastaSequence) {
            queueStore.put({
              ...item,
              synced: 1,
              batch_id: item.batch_id ?? batchId,
              server_result: matchedResult ?? item.server_result,
            });
          }
        }
      };

      const metaStore = tx.objectStore('session_meta');
      const metaReq = metaStore.get('active_session');
      metaReq.onsuccess = () => {
        const current = metaReq.result as StoredSessionRecord | undefined;
        if (current) {
          metaStore.put({
            ...current,
            last_acked_sequence: Math.max(current.last_acked_sequence ?? 0, ackHastaSequence),
            key: 'active_session',
          });
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Error confirmando lote en IndexedDB.'));
    });

    await this.refreshStats();
  }

  async refreshStats(): Promise<void> {
    try {
      const db = await this.openDb();
      const [meta, pendingCount, rosterCount, rev] = await Promise.all([
        this.getActiveSession(),
        new Promise<number>((resolve, reject) => {
          const tx = db.transaction(['outbound_queue'], 'readonly');
          const req = tx.objectStore('outbound_queue').index('by_synced').count(0);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        }),
        new Promise<number>((resolve, reject) => {
          const tx = db.transaction(['roster_guests'], 'readonly');
          const req = tx.objectStore('roster_guests').count();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        }),
        this.getRevocationsState(),
      ]);

      this.queueDepth.set(pendingCount);
      this.rosterCount.set(rosterCount);
      this.lastSequence.set(meta?.last_sequence ?? 0);
      this.lastAckedSequence.set(meta?.last_acked_sequence ?? 0);
      if (rev) {
        this.revocationsMeta.set(rev);
      }
    } catch {
      // Ignore if DB is not initialized yet
    }
  }
}
