import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { ORQUESTA_API_BASE_URL } from '../../../core/api/api-config';
import { apiInterceptor } from '../../../core/api/api.interceptor';
import { EventSeatingPage, SEATING_CONFLICT_MESSAGE } from './event-seating.page';

const API = 'https://api.orquesta.test';
const EV = 'ev_1';
const TABLES_URL = `${API}/v1/events/${EV}/tables?limit=100`;
const UNSEATED_URL = `${API}/v1/events/${EV}/seat-assignments/unseated?limit=100`;
const GUESTS_URL = `${API}/v1/events/${EV}/guests?limit=100`;

describe('EventSeatingPage · control de versión optimista (FR7, issue #5)', () => {
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [EventSeatingPage],
      providers: [
        { provide: ORQUESTA_API_BASE_URL, useValue: API },
        provideHttpClient(withInterceptors([apiInterceptor])),
        provideHttpClientTesting(),
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ id: EV }) } },
        },
      ],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  function flushLoad(planVersion: number, ocupacionMesa1 = 0): void {
    httpMock.expectOne(TABLES_URL).flush({
      items: [
        { id: 'tb_1', nombre: 'Mesa 1', capacidad: 8, ocupacion: ocupacionMesa1 },
        { id: 'tb_2', nombre: 'Mesa 2', capacidad: 8, ocupacion: 0 },
      ],
      next_cursor: null,
      plan_version: planVersion,
    });
    httpMock.expectOne(UNSEATED_URL).flush({
      items: [{ guest_id: 'g_1', nombre: 'Ana', estado_rsvp: 'confirma' }],
      next_cursor: null,
    });
    httpMock.expectOne(GUESTS_URL).flush({ items: [], next_cursor: null });
  }

  async function settle(): Promise<void> {
    await new Promise((r) => setTimeout(r, 10));
  }

  it('guarda plan_version al cargar y lo manda en If-Match al asignar', async () => {
    const fixture = TestBed.createComponent(EventSeatingPage);
    const comp = fixture.componentInstance;
    fixture.detectChanges();
    flushLoad(4);
    await settle();
    expect(comp.planVersion()).toBe(4);

    const assign = comp.assignSeat('g_1', 'tb_2');
    const req = httpMock.expectOne(`${API}/v1/events/${EV}/seat-assignments`);
    expect(req.request.headers.get('If-Match')).toBe('"4"');
    req.flush({ guest_id: 'g_1', table_id: 'tb_2', estado: 'asignado', plan_version: 5 });
    await settle();
    expect(comp.planVersion()).toBe(5);
    flushLoad(5);
    await assign;
    expect(comp.conflict()).toBeNull();
  });

  it('ante 409 SEATING_VERSION_CONFLICT avisa con role=alert, recarga y conserva la selección', async () => {
    const fixture = TestBed.createComponent(EventSeatingPage);
    const comp = fixture.componentInstance;
    fixture.detectChanges();
    flushLoad(7);
    await settle();

    comp.setTargetTable('g_1', 'tb_2');
    const assign = comp.assignSeat('g_1');
    const req = httpMock.expectOne(`${API}/v1/events/${EV}/seat-assignments`);
    expect(req.request.headers.get('If-Match')).toBe('"7"');
    req.flush(
      {
        error: {
          code: 'SEATING_VERSION_CONFLICT',
          message: 'El plano cambió desde tu última lectura; recarga y reintenta',
          details: { version_esperada: 7, version_actual: 8 },
        },
      },
      { status: 409, statusText: 'Conflict' },
    );
    await settle();
    // Recarga con lo que guardó la otra persona
    flushLoad(8, 1);
    await assign;

    expect(comp.conflict()).toBe(SEATING_CONFLICT_MESSAGE);
    expect(comp.error()).toBeNull();
    expect(comp.planVersion()).toBe(8);
    expect(comp.tables()[0].ocupacion).toBe(1);
    expect(comp.selectedTableByGuest()['g_1']).toBe('tb_2');

    fixture.detectChanges();
    const alert = (fixture.nativeElement as HTMLElement).querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Otra persona modificó el plano');
  });

  it('manda If-Match al liberar un lugar', async () => {
    const fixture = TestBed.createComponent(EventSeatingPage);
    const comp = fixture.componentInstance;
    fixture.detectChanges();
    flushLoad(2);
    await settle();

    const release = comp.releaseSeat('g_1');
    const req = httpMock.expectOne(`${API}/v1/events/${EV}/seat-assignments/g_1`);
    expect(req.request.method).toBe('DELETE');
    expect(req.request.headers.get('If-Match')).toBe('"2"');
    req.flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    flushLoad(3);
    await release;
    expect(comp.planVersion()).toBe(3);
  });
});
