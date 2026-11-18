import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ORQUESTA_API_BASE_URL } from '../api/api-config';
import { apiInterceptor } from '../api/api.interceptor';
import { AuthTokenStore } from '../auth/auth-token.store';
import { IDB_FACTORY, ScanStorageService } from '../storage/scan-storage.service';
import { BatchSyncService } from './batch-sync.service';

describe('BatchSyncService', () => {
  let sync: BatchSyncService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        { provide: ORQUESTA_API_BASE_URL, useValue: 'https://api.orquesta.test' },
        { provide: IDB_FACTORY, useValue: null },
        provideHttpClient(withInterceptors([apiInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    sync = TestBed.inject(BatchSyncService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('computes deterministic SHA-256 checksum over canonical events sorted by sequence', async () => {
    const hashA = await sync.computeEventsChecksum([
      {
        sequence: 2,
        invitation_id: 'inv_2',
        scanned_at: '2026-06-15T18:02:00Z',
        token_sha256: '222',
        verdict_local: 'admitido',
        modo: 'camara',
      },
      {
        sequence: 1,
        invitation_id: 'inv_1',
        scanned_at: '2026-06-15T18:01:00Z',
        token_sha256: '111',
        verdict_local: 'admitido',
        modo: 'camara',
      },
    ]);

    const hashB = await sync.computeEventsChecksum([
      {
        sequence: 1,
        invitation_id: 'inv_1',
        scanned_at: '2026-06-15T18:01:00Z',
        token_sha256: '111',
        verdict_local: 'admitido',
        modo: 'camara',
      },
      {
        sequence: 2,
        invitation_id: 'inv_2',
        scanned_at: '2026-06-15T18:02:00Z',
        token_sha256: '222',
        verdict_local: 'admitido',
        modo: 'camara',
      },
    ]);

    expect(hashA).toMatch(/^[0-9a-f]{64}$/);
    expect(hashA).toBe(hashB);
  });

  it('drains queued events in batches and sends PUT /sync-state', async () => {
    const storage = TestBed.inject(ScanStorageService);
    const tokenStore = TestBed.inject(AuthTokenStore);
    const ses = {
      session_id: 'ses_sync',
      session_token: 'tok_sync',
      event_id: 'evt_1',
      rol: 'staff_checkin',
      device_id: 'dev_9',
      expira_en: new Date(Date.now() + 3600_000).toISOString(),
      roster_version: 5,
      revocation_version: 2,
      last_sequence: 1,
      last_acked_sequence: 0,
    };
    tokenStore.setScanSession(ses);

    vi.spyOn(storage, 'getActiveSession').mockResolvedValue(ses);
    const pendingSpy = vi
      .spyOn(storage, 'getPendingOutboundEvents')
      .mockResolvedValueOnce([
        {
          sequence: 1,
          invitation_id: 'inv_1',
          scanned_at: '2026-06-15T18:01:00Z',
          token_sha256: 'abc',
          verdict_local: 'admitido',
          modo: 'camara',
          synced: 0,
        },
      ])
      .mockResolvedValueOnce([]);
    vi.spyOn(storage, 'assignBatchIdToPending').mockResolvedValue();
    vi.spyOn(storage, 'markBatchSynced').mockResolvedValue();

    const drainPromise = sync.drainPendingBatches();
    await new Promise((r) => setTimeout(r, 20));

    const batchReq = httpMock.expectOne(
      'https://api.orquesta.test/v1/scan-sessions/ses_sync/batches',
    );
    expect(batchReq.request.method).toBe('POST');
    expect(batchReq.request.body.seq_desde).toBe(1);
    expect(batchReq.request.body.seq_hasta).toBe(1);
    expect(batchReq.request.body.checksum.alg).toBe('sha256');
    expect(batchReq.request.headers.get('Idempotency-Key')).toBe(batchReq.request.body.batch_id);

    batchReq.flush({
      batch_id: batchReq.request.body.batch_id,
      estado: 'aplicado',
      recibido_en: '2026-06-15T18:01:05Z',
      ack_hasta_sequence: 1,
      contadores: { aceptados: 1, tardios: 0, duplicados: 0, rechazados: 0 },
      results: [{ sequence: 1, invitation_id: 'inv_1', verdict: 'admitido', tardio: false, duplicado: false }],
      sync_state: {
        device_id: 'dev_9',
        pendientes: 0,
        ultima_seq_ackeada: 1,
        heartbeat_en: '2026-06-15T18:01:05Z',
      },
    });

    await new Promise((r) => setTimeout(r, 20));
    const hbReq = httpMock.expectOne(
      'https://api.orquesta.test/v1/scan-sessions/ses_sync/sync-state',
    );
    expect(hbReq.request.method).toBe('PUT');
    hbReq.flush({ pendientes: 0, ultima_seq_ackeada: 1, heartbeat_en: '2026-06-15T18:01:05Z' });

    const ack = await drainPromise;
    expect(ack?.ack_hasta_sequence).toBe(1);
    expect(pendingSpy).toHaveBeenCalledTimes(2);
  });
});
