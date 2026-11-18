import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { ORQUESTA_API_BASE_URL, OrquestaApiError } from './api-config';
import { apiInterceptor } from './api.interceptor';
import { ApiService } from './api.service';
import { AuthTokenStore } from '../auth/auth-token.store';

describe('apiInterceptor & ApiService', () => {
  let http: HttpClient;
  let api: ApiService;
  let httpMock: HttpTestingController;
  let tokenStore: AuthTokenStore;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        { provide: ORQUESTA_API_BASE_URL, useValue: 'https://api.orquesta.test' },
        provideHttpClient(withInterceptors([apiInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
    api = TestBed.inject(ApiService);
    httpMock = TestBed.inject(HttpTestingController);
    tokenStore = TestBed.inject(AuthTokenStore);
    tokenStore.clearAccountSession();
    tokenStore.setScanSession(null);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('sets withCredentials, base URL, Bearer, and automatic UUID v4 Idempotency-Key on mutating POST', async () => {
    tokenStore.setAccountSession('jwt_planner_1', 'p@orquesta.test', ['planner']);

    const promise = firstValueFrom(http.post('/v1/events', { nombre: 'Boda' }));
    const req = httpMock.expectOne('https://api.orquesta.test/v1/events');

    expect(req.request.withCredentials).toBe(true);
    expect(req.request.headers.get('Authorization')).toBe('Bearer jwt_planner_1');
    const idemKey = req.request.headers.get('Idempotency-Key');
    expect(idemKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

    req.flush({ id: 'evt_1' });
    await promise;
  });

  it('preserves explicit Idempotency-Key and uses scan session token for scan requests', async () => {
    tokenStore.setScanSession({
      session_id: 'ses_1',
      session_token: 'scan_jwt_99',
      event_id: 'evt_1',
      rol: 'staff_checkin',
      device_id: 'dev_1',
      expira_en: new Date(Date.now() + 3600_000).toISOString(),
      roster_version: 1,
      revocation_version: 1,
      last_sequence: 0,
      last_acked_sequence: 0,
    });

    const promise = api.post('/v1/scan-sessions/ses_1/batches', { events: [] }, {
      idempotencyKey: 'ses_1:dev_1:0001',
      scanSession: true,
    });

    const req = httpMock.expectOne('https://api.orquesta.test/v1/scan-sessions/ses_1/batches');
    expect(req.request.headers.get('Idempotency-Key')).toBe('ses_1:dev_1:0001');
    expect(req.request.headers.get('Authorization')).toBe('Bearer scan_jwt_99');

    req.flush({ batch_id: 'ses_1:dev_1:0001' });
    await promise;
  });

  it('never sends cookies or Authorization on public invitation endpoints (NFR-02)', async () => {
    tokenStore.setAccountSession('jwt_planner_1', 'p@orquesta.test', ['planner']);

    const promise = api.get('/v1/public/invitations/rsvp_tok/rsvp', { publicNoCookies: true });
    const req = httpMock.expectOne('https://api.orquesta.test/v1/public/invitations/rsvp_tok/rsvp');

    expect(req.request.withCredentials).toBe(false);
    expect(req.request.headers.has('Authorization')).toBe(false);

    req.flush({ respuesta: null });
    await promise;
  });

  it('maps backend error envelope into typed OrquestaApiError', async () => {
    const promise = api.post('/v1/worker/requests/res_1/accept', { plazas: 1 });
    const req = httpMock.expectOne('https://api.orquesta.test/v1/worker/requests/res_1/accept');

    req.flush(
      {
        error: {
          code: 'RESERVATION_OVERLAP',
          message: 'Solapamiento con reserva ganadora',
          details: { ganadora: { reservation_id: 'res_0' } },
        },
      },
      { status: 409, statusText: 'Conflict' },
    );

    await expect(promise).rejects.toMatchObject({
      status: 409,
      code: 'RESERVATION_OVERLAP',
      message: 'Solapamiento con reserva ganadora',
      details: { ganadora: { reservation_id: 'res_0' } },
    } satisfies Partial<OrquestaApiError>);
  });

  it('handles 304 Not Modified in getConditional without throwing', async () => {
    const promise = api.getConditional('/v1/scan-sessions/ses_1/roster', '"roster-5"', {
      scanSession: true,
    });
    const req = httpMock.expectOne('https://api.orquesta.test/v1/scan-sessions/ses_1/roster');
    expect(req.request.headers.get('If-None-Match')).toBe('"roster-5"');

    req.flush(null, { status: 304, statusText: 'Not Modified', headers: { ETag: '"roster-5"' } });
    const result = await promise;
    expect(result.notModified).toBe(true);
    expect(result.etag).toBe('"roster-5"');
  });
});
