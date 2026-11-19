import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ORQUESTA_API_BASE_URL, OrquestaApiError } from './api-config';
import { apiInterceptor } from './api.interceptor';
import { ApiService, RETRY_BASE_MS } from './api.service';

const URL = 'https://api.orquesta.test/v1/events';
const busy = { error: { code: 'ERR', message: 'Service Unavailable' } };
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

describe('ApiService: reintentos ante saturación', () => {
  let api: ApiService;
  let httpMock: HttpTestingController;
  const retryBase = RETRY_BASE_MS.value;

  beforeAll(() => (RETRY_BASE_MS.value = 1));
  afterAll(() => (RETRY_BASE_MS.value = retryBase));

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        { provide: ORQUESTA_API_BASE_URL, useValue: 'https://api.orquesta.test' },
        provideHttpClient(withInterceptors([apiInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    api = TestBed.inject(ApiService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('una lectura reintenta un 503 y termina bien', async () => {
    const p = api.get<{ items: unknown[] }>('/v1/events');
    httpMock.expectOne(URL).flush(busy, { status: 503, statusText: 'Service Unavailable' });
    await tick();
    httpMock.expectOne(URL).flush({ items: [] });
    await expect(p).resolves.toEqual({ items: [] });
  });

  it('una lectura se rinde después de 3 reintentos', async () => {
    const p = api.get('/v1/events');
    const settled = p.catch((e: unknown) => e);
    for (let i = 0; i <= 3; i++) {
      if (i > 0) await tick();
      httpMock.expectOne(URL).flush(busy, { status: 503, statusText: 'Service Unavailable' });
    }
    const err = await settled;
    expect(err).toBeInstanceOf(OrquestaApiError);
    expect((err as OrquestaApiError).status).toBe(503);
  });

  it('un error de negocio (404) no se reintenta', async () => {
    const p = api.get('/v1/events').catch((e: unknown) => e);
    httpMock.expectOne(URL).flush({ error: { code: 'NOT_FOUND', message: 'x' } }, { status: 404, statusText: 'Not Found' });
    expect(((await p) as OrquestaApiError).status).toBe(404);
  });

  it('una escritura sin llave de idempotencia propia nunca se reintenta', async () => {
    const p = api.post('/v1/events', { nombre: 'Boda' }).catch((e: unknown) => e);
    httpMock.expectOne(URL).flush(busy, { status: 503, statusText: 'Service Unavailable' });
    expect(((await p) as OrquestaApiError).status).toBe(503);
  });

  it('una escritura con llave reintenta un 503 con la misma llave, pero no un 502 (pudo ejecutarse)', async () => {
    const ok = api.post('/v1/events', { nombre: 'Boda' }, { idempotencyKey: 'pay:01ABC' });
    const first = httpMock.expectOne(URL);
    expect(first.request.headers.get('Idempotency-Key')).toBe('pay:01ABC');
    first.flush(busy, { status: 503, statusText: 'Service Unavailable' });
    await tick();
    const second = httpMock.expectOne(URL);
    expect(second.request.headers.get('Idempotency-Key')).toBe('pay:01ABC');
    second.flush({ id: 'e1' });
    await expect(ok).resolves.toEqual({ id: 'e1' });

    const bad = api.post('/v1/events', {}, { idempotencyKey: 'pay:01XYZ' }).catch((e: unknown) => e);
    httpMock.expectOne(URL).flush(busy, { status: 502, statusText: 'Bad Gateway' });
    expect(((await bad) as OrquestaApiError).status).toBe(502);
  });
});
