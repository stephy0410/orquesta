import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ORQUESTA_API_BASE_URL } from '../../core/api/api-config';
import { apiInterceptor } from '../../core/api/api.interceptor';
import { InvitationPage, extractRsvpTokenFromHash } from './invitation.page';

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

  it('loads cacheable event summary without hitting origin GET /rsvp when eventId (e=...) is present in hash (NFR-02, AC-23)', async () => {
    window.history.replaceState(
      null,
      '',
      '#t=rsvp_tok_xyz&e=evt_01&c=483920&q=chk_qr_token_1',
    );
    const fixture = TestBed.createComponent(InvitationPage);
    fixture.detectChanges();

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

    await new Promise((r) => setTimeout(r, 25));
    await fixture.whenStable();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Gala Cacheada');
    expect(el.textContent).toContain('483920');
    expect(el.querySelector('img.inv-qr-img')).toBeTruthy();

    const postPromise = fixture.componentInstance.respond('confirma');
    const postReq = httpMock.expectOne(
      'https://api.orquesta.test/v1/public/invitations/rsvp_tok_xyz/rsvp',
    );
    expect(postReq.request.method).toBe('POST');
    postReq.flush({
      respuesta: 'confirma',
      respondido_en: '2026-06-01T12:00:00Z',
      qr: { token: 'chk_qr_token_1', codigo_corto: '483920' },
      evento: { nombre: 'Gala Cacheada', fecha: '2026-06-15', inicio: '19:00', lugar: 'Salon Norte' },
    });
    await postPromise;
    expect(fixture.componentInstance.state()?.respuesta).toBe('confirma');
  });
});
