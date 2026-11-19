import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ORQUESTA_API_BASE_URL } from '../../core/api/api-config';
import { apiInterceptor } from '../../core/api/api.interceptor';
import {
  InvitationPage,
  extractRsvpTokenFromHash,
  formatEventDate,
  formatEventTime,
} from './invitation.page';

describe('InvitationPage (RF-18, NFR-02)', () => {
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    window.history.replaceState(null, '', '#t=rsvp_tok_xyz');
    await TestBed.configureTestingModule({
      imports: [InvitationPage],
      providers: [
        { provide: ORQUESTA_API_BASE_URL, useValue: 'https://api.orquesta.test' },
        provideHttpClient(withInterceptors([apiInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    window.history.replaceState(null, '', '#');
    httpMock.verify();
  });

  it('extracts rsvp_token from hash fragment', () => {
    expect(extractRsvpTokenFromHash('#t=rsvp_123')).toBe('rsvp_123');
    expect(extractRsvpTokenFromHash('#foo=1&t=rsvp_456')).toBe('rsvp_456');
    expect(extractRsvpTokenFromHash('')).toBeNull();
  });

  it('muestra fecha y hora legibles en la zona horaria del evento', () => {
    expect(formatEventDate('2026-11-21')).toBe('sábado, 21 de noviembre de 2026');
    expect(formatEventTime('2026-11-22T01:00:00.000Z', 'America/Mexico_City')).toBe('19:00');
    expect(formatEventTime('2026-11-22T01:00:00.000Z', 'America/Cancun')).toBe('20:00');
    expect(formatEventTime('19:00')).toBe('19:00');
  });

  it('loads invitation without cookies, keeps QR visible, and updates state on confirma/declina', async () => {
    const fixture = TestBed.createComponent(InvitationPage);
    fixture.detectChanges();

    const getReq = httpMock.expectOne(
      'https://api.orquesta.test/v1/public/invitations/rsvp_tok_xyz/rsvp',
    );
    expect(getReq.request.withCredentials).toBe(false);
    expect(getReq.request.headers.has('Authorization')).toBe(false);

    getReq.flush({
      respuesta: null,
      respondido_en: null,
      qr: { token: 'chk_qr_token_1', codigo_corto: '483920' },
      evento: { nombre: 'Gala Orquesta', fecha: '2026-06-15', inicio: '19:00', lugar: 'Salon Sur' },
    });

    await new Promise((r) => setTimeout(r, 25));
    await fixture.whenStable();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Gala Orquesta');
    expect(el.textContent).toContain('483920');
    expect(el.querySelector('img.inv-qr-img')).toBeTruthy();

    const comp = fixture.componentInstance;
    const postPromise = comp.respond('confirma');
    const postReq = httpMock.expectOne(
      'https://api.orquesta.test/v1/public/invitations/rsvp_tok_xyz/rsvp',
    );
    expect(postReq.request.method).toBe('POST');
    expect(postReq.request.withCredentials).toBe(false);
    expect(postReq.request.body).toEqual({ respuesta: 'confirma' });

    postReq.flush({
      respuesta: 'confirma',
      respondido_en: '2026-06-01T12:00:00Z',
      qr: { token: 'chk_qr_token_1', codigo_corto: '483920' },
      recordatorios_cancelados: 2,
      evento: { nombre: 'Gala Orquesta', fecha: '2026-06-15', inicio: '19:00', lugar: 'Salon Sur' },
    });

    await postPromise;
    fixture.detectChanges();
    expect(comp.state()?.respuesta).toBe('confirma');
    expect(el.textContent).toContain('Asistencia confirmada');
    expect(el.querySelector('img.inv-qr-img')).toBeTruthy();

    // Guest can change response (RF-05, RF-18)
    const changePromise = comp.respond('declina');
    const changeReq = httpMock.expectOne(
      'https://api.orquesta.test/v1/public/invitations/rsvp_tok_xyz/rsvp',
    );
    expect(changeReq.request.body).toEqual({ respuesta: 'declina' });
    changeReq.flush({
      respuesta: 'declina',
      respondido_en: '2026-06-01T12:05:00Z',
      superseded_at: '2026-06-01T12:00:00Z',
      qr: { token: 'chk_qr_token_1', codigo_corto: '483920' },
      recordatorios_cancelados: 0,
      evento: { nombre: 'Gala Orquesta', fecha: '2026-06-15', inicio: '19:00', lugar: 'Salon Sur' },
    });
    await changePromise;
    fixture.detectChanges();
    expect(comp.state()?.respuesta).toBe('declina');
    expect(el.querySelector('img.inv-qr-img')).toBeTruthy();
  });

  it('renders cached event summary first and hydrates RSVP state & QR in background when eventId (e=...) is in hash (NFR-02, AC-23)', async () => {
    window.history.replaceState(null, '', '#t=rsvp_tok_xyz&e=evt_01');
    const fixture = TestBed.createComponent(InvitationPage);
    fixture.detectChanges();

    // Primero pide el resumen cacheable del evento (sin pedir /rsvp antes).
    httpMock.expectNone('https://api.orquesta.test/v1/public/invitations/rsvp_tok_xyz/rsvp');
    const summaryReq = httpMock.expectOne(
      'https://api.orquesta.test/v1/public/events/evt_01/summary',
    );
    expect(summaryReq.request.method).toBe('GET');
    expect(summaryReq.request.withCredentials).toBe(false);
    expect(summaryReq.request.headers.has('Authorization')).toBe(false);

    summaryReq.flush({
      event_id: 'evt_01',
      nombre: 'Gala Cacheada',
      fecha: '2026-06-15',
      inicio: '19:00',
      venue: { nombre: 'Salon Norte', zona: 'norte', direccion: 'Av. 1' },
    });

    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(fixture.componentInstance.loading()).toBe(false);
    expect(el.textContent).toContain('Gala Cacheada');

    // Justo después hidrata el estado real y el QR vigente en segundo plano.
    const rsvpReq = httpMock.expectOne(
      'https://api.orquesta.test/v1/public/invitations/rsvp_tok_xyz/rsvp',
    );
    expect(rsvpReq.request.method).toBe('GET');
    expect(rsvpReq.request.withCredentials).toBe(false);
    rsvpReq.flush({
      respuesta: 'confirma',
      respondido_en: '2026-06-01T12:00:00Z',
      qr: { token: 'chk_qr_token_vigente', codigo_corto: '483920' },
      evento: { nombre: 'Gala Cacheada', fecha: '2026-06-15', inicio: '19:00', lugar: 'Salon Norte' },
      bajas: { sms: false, email: false },
    });

    await new Promise((r) => setTimeout(r, 25));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.state()?.respuesta).toBe('confirma');
    expect(el.textContent).toContain('Asistencia confirmada');
    expect(el.textContent).toContain('483920');
    expect(el.querySelector('img.inv-qr-img')).toBeTruthy();

    const postPromise = fixture.componentInstance.respond('declina');
    const postReq = httpMock.expectOne(
      'https://api.orquesta.test/v1/public/invitations/rsvp_tok_xyz/rsvp',
    );
    expect(postReq.request.method).toBe('POST');
    postReq.flush({
      respuesta: 'declina',
      respondido_en: '2026-06-01T12:05:00Z',
      qr: { token: 'chk_qr_token_vigente', codigo_corto: '483920' },
      evento: { nombre: 'Gala Cacheada', fecha: '2026-06-15', inicio: '19:00', lugar: 'Salon Norte' },
    });
    await postPromise;
    expect(fixture.componentInstance.state()?.respuesta).toBe('declina');
  });

  it('keeps cached summary view if background RSVP hydration fails (NFR-02)', async () => {
    window.history.replaceState(null, '', '#t=rsvp_tok_xyz&e=evt_01');
    const fixture = TestBed.createComponent(InvitationPage);
    fixture.detectChanges();

    httpMock
      .expectOne('https://api.orquesta.test/v1/public/events/evt_01/summary')
      .flush({
        event_id: 'evt_01',
        nombre: 'Gala Cacheada',
        fecha: '2026-06-15',
        inicio: '19:00',
        venue: { nombre: 'Salon Norte', zona: 'norte', direccion: 'Av. 1' },
      });

    await Promise.resolve();
    await Promise.resolve();

    httpMock
      .expectOne('https://api.orquesta.test/v1/public/invitations/rsvp_tok_xyz/rsvp')
      .flush({ error: { code: 'ERR', message: 'fail' } }, { status: 503, statusText: 'Unavailable' });

    await new Promise((r) => setTimeout(r, 25));
    await fixture.whenStable();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(fixture.componentInstance.error()).toBeNull();
    expect(fixture.componentInstance.state()?.evento.nombre).toBe('Gala Cacheada');
    expect(el.textContent).toContain('Gala Cacheada');
  });

  it('clears cached summary and surfaces error when background hydration reports INVITACION_REVOCADA (410)', async () => {
    window.history.replaceState(null, '', '#t=rsvp_tok_xyz&e=evt_01');
    const fixture = TestBed.createComponent(InvitationPage);
    fixture.detectChanges();

    httpMock
      .expectOne('https://api.orquesta.test/v1/public/events/evt_01/summary')
      .flush({
        event_id: 'evt_01',
        nombre: 'Gala Cacheada',
        fecha: '2026-06-15',
        inicio: '19:00',
        venue: { nombre: 'Salon Norte', zona: 'norte', direccion: 'Av. 1' },
      });

    await Promise.resolve();
    await Promise.resolve();

    httpMock
      .expectOne('https://api.orquesta.test/v1/public/invitations/rsvp_tok_xyz/rsvp')
      .flush(
        { error: { code: 'INVITACION_REVOCADA', message: 'La invitación fue revocada' } },
        { status: 410, statusText: 'Gone' },
      );

    await new Promise((r) => setTimeout(r, 25));
    await fixture.whenStable();
    fixture.detectChanges();

    const comp = fixture.componentInstance;
    expect(comp.state()).toBeNull();
    expect(comp.qrDataUrl()).toBeNull();
    expect(comp.error()?.code).toBe('INVITACION_REVOCADA');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('La invitación fue revocada');
  });

  it('ignores stale background GET /rsvp response if respond() ran while it was in flight', async () => {
    window.history.replaceState(null, '', '#t=rsvp_tok_xyz&e=evt_01');
    const fixture = TestBed.createComponent(InvitationPage);
    fixture.detectChanges();

    httpMock
      .expectOne('https://api.orquesta.test/v1/public/events/evt_01/summary')
      .flush({
        event_id: 'evt_01',
        nombre: 'Gala Cacheada',
        fecha: '2026-06-15',
        inicio: '19:00',
        venue: { nombre: 'Salon Norte', zona: 'norte', direccion: 'Av. 1' },
      });

    await Promise.resolve();
    await Promise.resolve();

    // GET /rsvp en vuelo
    const staleGetReq = httpMock.expectOne(
      'https://api.orquesta.test/v1/public/invitations/rsvp_tok_xyz/rsvp',
    );
    expect(staleGetReq.request.method).toBe('GET');

    // Usuario responde antes de que termine el GET /rsvp en segundo plano
    const postPromise = fixture.componentInstance.respond('confirma');
    const postReq = httpMock.expectOne(
      (r) =>
        r.url === 'https://api.orquesta.test/v1/public/invitations/rsvp_tok_xyz/rsvp' &&
        r.method === 'POST',
    );
    postReq.flush({
      respuesta: 'confirma',
      respondido_en: '2026-06-01T12:00:00Z',
      qr: { token: 'chk_qr_token_nuevo', codigo_corto: '483920' },
      evento: { nombre: 'Gala Cacheada', fecha: '2026-06-15', inicio: '19:00', lugar: 'Salon Norte' },
    });
    await postPromise;

    // Ahora llega la respuesta vieja del GET /rsvp con respuesta: null
    staleGetReq.flush({
      respuesta: null,
      respondido_en: null,
      qr: { token: 'chk_qr_token_viejo', codigo_corto: '483920' },
      evento: { nombre: 'Gala Cacheada', fecha: '2026-06-15', inicio: '19:00', lugar: 'Salon Norte' },
    });

    await new Promise((r) => setTimeout(r, 25));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.state()?.respuesta).toBe('confirma');
    expect(fixture.componentInstance.state()?.qr?.token).toBe('chk_qr_token_nuevo');
  });

  it('permite darse de baja por canal sin cuenta y conserva el pase (FR8)', async () => {
    const fixture = TestBed.createComponent(InvitationPage);
    fixture.detectChanges();
    httpMock
      .expectOne('https://api.orquesta.test/v1/public/invitations/rsvp_tok_xyz/rsvp')
      .flush({
        respuesta: 'confirma',
        respondido_en: '2026-06-01T12:00:00Z',
        qr: { token: 'chk_qr_token_1', codigo_corto: '483920' },
        evento: { nombre: 'Gala Orquesta', fecha: '2026-06-15', inicio: '19:00', lugar: 'Salon Sur' },
        bajas: { sms: false, email: false },
      });
    await new Promise((r) => setTimeout(r, 25));
    await fixture.whenStable();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Dejar de recibir SMS');
    expect(el.querySelector('a[href="/privacidad"]')).toBeTruthy();

    const comp = fixture.componentInstance;
    const p = comp.unsubscribe('sms');
    const req = httpMock.expectOne(
      'https://api.orquesta.test/v1/public/invitations/rsvp_tok_xyz/unsubscribe',
    );
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ canal: 'sms' });
    expect(req.request.withCredentials).toBe(false);
    req.flush({ bajas: { sms: true, email: false } });
    await p;
    fixture.detectChanges();

    expect(comp.state()?.bajas).toEqual({ sms: true, email: false });
    expect(el.textContent).not.toContain('Dejar de recibir SMS');
    expect(el.textContent).toContain('Dejar de recibir correos');
    expect(el.textContent).toContain('ya no te enviaremos mensajes SMS');
    expect(el.querySelector('img.inv-qr-img')).toBeTruthy();
  });
});
