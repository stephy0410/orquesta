import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiService } from '../../../core/api/api.service';
import { OrquestaApiError } from '../../../core/api/api-config';
import {
  EventDto,
  EventRequirementDto,
  EventRequirementsCoverageDto,
  PaginatedResponse,
  PaymentDto,
  PlannerAlertDto,
  PlannerWorkerRequestsResponse,
  PublicWorkerDto,
  ROLES_CATALOGO,
  TarifaUnidad,
  WORKER_CATEGORIES,
  WORKER_ZONES,
  WorkerAvailabilityOccupiedResponse,
  WorkerRequestItemDto,
} from '../../../core/api/models';
import { EventSubnavComponent } from '../shared/event-subnav.component';

@Component({
  selector: 'app-event-workers-page',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, EventSubnavComponent],
  templateUrl: './event-workers.page.html',
})
export class EventWorkersPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);

  readonly allCategories = WORKER_CATEGORIES;
  readonly allRoles = ROLES_CATALOGO;
  readonly allZones = WORKER_ZONES;

  readonly eventId = signal('');
  readonly event = signal<EventDto | null>(null);
  readonly requirements = signal<EventRequirementDto[]>([]);
  readonly coverage = signal<EventRequirementDto[]>([]);
  readonly requests = signal<WorkerRequestItemDto[]>([]);
  readonly alerts = signal<PlannerAlertDto[]>([]);

  // 3D search filters (RF-07)
  readonly filterCategorias = signal<string[]>([]);
  readonly filterZonas = signal<string[]>([]);
  readonly filterRadioKm = signal<number | null>(null);
  readonly filterTarifaMin = signal<number | null>(null);
  readonly filterTarifaMax = signal<number | null>(null);
  readonly filterUnidad = signal<TarifaUnidad | ''>('');
  readonly workers = signal<PublicWorkerDto[]>([]);
  readonly occupiedByWorker = signal<Record<string, WorkerAvailabilityOccupiedResponse>>({});

  // Request creation form (RF-08, TR-20)
  readonly selectedWorker = signal<PublicWorkerDto | null>(null);
  readonly reqRol = signal('mesero');
  readonly reqPlazas = signal(1);
  readonly reqInicio = signal('');
  readonly reqFin = signal('');
  readonly reqHoraLlegada = signal('');

  // Emergency replacement & payments
  readonly replacementForResId = signal<string | null>(null);
  readonly replacementWorkerId = signal('');
  readonly cancelMotivos = signal<Record<string, string>>({});
  readonly paymentsByRes = signal<Record<string, PaymentDto>>({});

  readonly error = signal<string | null>(null);
  readonly success = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    const id = this.route.snapshot.paramMap.get('id') ?? '';
    this.eventId.set(id);
    if (id) {
      await Promise.all([
        this.loadEvent(),
        this.loadRequirements(),
        this.loadRequests(),
        this.loadAlerts(),
      ]);
      await this.searchWorkers();
    }
  }

  async loadEvent(): Promise<void> {
    try {
      const ev = await this.api.get<EventDto>(`/v1/events/${encodeURIComponent(this.eventId())}`);
      this.event.set(ev);
      if (ev.ventana?.inicio && !this.reqInicio()) {
        this.reqInicio.set(toLocalDatetime(ev.ventana.inicio));
        this.reqHoraLlegada.set(toLocalDatetime(ev.ventana.inicio));
      }
      if (ev.ventana?.fin && !this.reqFin()) {
        this.reqFin.set(toLocalDatetime(ev.ventana.fin));
      }
      if (ev.venue?.zona && this.filterZonas().length === 0) {
        this.filterZonas.set([ev.venue.zona]);
      }
    } catch {
      // Handled elsewhere
    }
  }

  private extractCoverageRows(
    cobertura?: EventRequirementDto[] | EventRequirementsCoverageDto,
  ): EventRequirementDto[] {
    if (!cobertura) return [];
    return Array.isArray(cobertura) ? cobertura : (cobertura.por_rol ?? []);
  }

  async loadAlerts(): Promise<void> {
    try {
      const res = await this.api.get<PaginatedResponse<PlannerAlertDto>>(
        `/v1/events/${encodeURIComponent(this.eventId())}/alerts`,
      );
      this.alerts.set(res.items ?? []);
    } catch {
      // Non-fatal
    }
  }

  async loadRequirements(): Promise<void> {
    try {
      const res = await this.api.get<
        PaginatedResponse<EventRequirementDto> & {
          cobertura?: EventRequirementDto[] | EventRequirementsCoverageDto;
        }
      >(`/v1/events/${encodeURIComponent(this.eventId())}/requirements`);
      this.requirements.set(res.items ?? []);
      if (res.cobertura) {
        this.coverage.set(this.extractCoverageRows(res.cobertura));
      }
    } catch {
      // Ignore
    }
  }

  addRequirementRow(): void {
    this.requirements.update((curr) => [...curr, { rol: 'mesero', cantidad: 1 }]);
  }

  updateReqRow(idx: number, field: 'rol' | 'cantidad', val: string | number): void {
    this.requirements.update((curr) =>
      curr.map((r, i) =>
        i === idx
          ? {
              ...r,
              [field]: field === 'cantidad' ? Math.max(1, Number(val) || 1) : String(val),
            }
          : r,
      ),
    );
  }

  removeReqRow(idx: number): void {
    this.requirements.update((curr) => curr.filter((_, i) => i !== idx));
  }

  async saveRequirements(): Promise<void> {
    this.error.set(null);
    this.success.set(null);
    try {
      const res = await this.api.put<{
        requerimientos: EventRequirementDto[];
        cobertura?: EventRequirementDto[] | EventRequirementsCoverageDto;
      }>(`/v1/events/${encodeURIComponent(this.eventId())}/requirements`, {
        requerimientos: this.requirements().map((r) => ({ rol: r.rol, cantidad: r.cantidad })),
      });
      this.requirements.set(res.requerimientos ?? this.requirements());
      if (res.cobertura) this.coverage.set(this.extractCoverageRows(res.cobertura));
      this.success.set('Requerimientos actualizados (RF-22).');
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? `${err.code}: ${err.message}` : 'Error guardando.',
      );
    }
  }

  toggleFilterCategory(cat: string): void {
    this.filterCategorias.update((curr) =>
      curr.includes(cat) ? curr.filter((c) => c !== cat) : [...curr, cat],
    );
  }

  toggleFilterZone(z: string): void {
    this.filterZonas.update((curr) =>
      curr.includes(z) ? curr.filter((x) => x !== z) : [...curr, z],
    );
  }

  async searchWorkers(): Promise<void> {
    this.error.set(null);
    const ev = this.event();
    try {
      const res = await this.api.get<PaginatedResponse<PublicWorkerDto>>('/v1/workers', {
        params: {
          categorias: this.filterCategorias(),
          zonas: this.filterZonas(),
          radio_km: this.filterRadioKm() ?? undefined,
          tarifa_min: this.filterTarifaMin() ?? undefined,
          tarifa_max: this.filterTarifaMax() ?? undefined,
          unidad: this.filterUnidad() || undefined,
          desde: ev?.ventana?.inicio,
          hasta: ev?.ventana?.fin,
          limit: 25,
        },
      });
      this.workers.set(res.items ?? []);
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? `${err.code}: ${err.message}` : 'Error buscando personal.',
      );
    }
  }

  async checkWorkerAvailability(workerId: string): Promise<void> {
    const ev = this.event();
    try {
      const res = await this.api.get<WorkerAvailabilityOccupiedResponse>(
        `/v1/workers/${encodeURIComponent(workerId)}/availability`,
        {
          params: {
            desde: ev?.ventana?.inicio,
            hasta: ev?.ventana?.fin,
          },
        },
      );
      this.occupiedByWorker.update((curr) => ({ ...curr, [workerId]: res }));
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError
          ? `${err.code}: ${err.message}`
          : 'Error consultando disponibilidad.',
      );
    }
  }

  selectWorkerForRequest(w: PublicWorkerDto): void {
    this.selectedWorker.set(w);
    if (w.categorias.length > 0) {
      this.reqRol.set(w.categorias[0]);
    }
    this.reqPlazas.set(1);
  }

  async sendWorkerRequest(): Promise<void> {
    const worker = this.selectedWorker();
    if (!worker) return;

    const inicio = toIso(this.reqInicio());
    const fin = toIso(this.reqFin());
    const horaLlegada = toIso(this.reqHoraLlegada());
    if (!inicio || !fin || !horaLlegada) {
      this.error.set('Ventana y hora de llegada válidas son obligatorias.');
      return;
    }

    this.error.set(null);
    this.success.set(null);
    try {
      const res = await this.api.post<WorkerRequestItemDto>(
        `/v1/events/${encodeURIComponent(this.eventId())}/worker-requests`,
        {
          worker_id: worker.worker_id,
          rol: this.reqRol(),
          plazas: Math.max(1, Number(this.reqPlazas()) || 1),
          ventana: { inicio, fin },
          hora_llegada: horaLlegada,
        },
      );
      this.success.set(
        `Solicitud enviada (${res.id ?? res.reservation_id}). Costo congelado: ${res.costo_congelado.monto} ${res.costo_congelado.moneda}/${res.costo_congelado.unidad}.`,
      );
      this.selectedWorker.set(null);
      await this.loadRequests();
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? `${err.code}: ${err.message}` : 'Error enviando solicitud.',
      );
    }
  }

  async loadRequests(): Promise<void> {
    try {
      const res = await this.api.get<PlannerWorkerRequestsResponse>(
        `/v1/events/${encodeURIComponent(this.eventId())}/worker-requests`,
        { params: { limit: 50 } },
      );
      this.requests.set(res.items ?? []);
      if (res.cobertura) this.coverage.set(this.extractCoverageRows(res.cobertura));
    } catch {
      // Ignore empty
    }
  }

  getResId(item: WorkerRequestItemDto): string {
    return item.id ?? item.reservation_id ?? '';
  }

  setCancelMotivo(id: string, val: string): void {
    this.cancelMotivos.update((curr) => ({ ...curr, [id]: val }));
  }

  async cancelRequest(reservationId: string): Promise<void> {
    const motivo = (this.cancelMotivos()[reservationId] ?? '').trim() || 'Cancelación del planner';
    this.error.set(null);
    this.success.set(null);
    try {
      const res = await this.api.post<{ estado: string; plazas_liberadas?: number }>(
        `/v1/events/${encodeURIComponent(this.eventId())}/worker-requests/${encodeURIComponent(reservationId)}/cancel`,
        { motivo },
      );
      this.success.set(
        `Reserva ${reservationId} → ${res.estado}. Plazas liberadas: ${res.plazas_liberadas ?? 0}.`,
      );
      await Promise.all([this.loadRequests(), this.loadAlerts()]);
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? `${err.code}: ${err.message}` : 'Error al cancelar.',
      );
    }
  }

  async sendEmergencyReplacement(): Promise<void> {
    const resId = this.replacementForResId();
    const workerId = this.replacementWorkerId().trim();
    if (!resId) return;

    this.error.set(null);
    this.success.set(null);
    try {
      const res = await this.api.post<{
        id?: string;
        estado: string;
        modo_emergencia?: boolean;
        alerta?: boolean;
      }>(
        `/v1/events/${encodeURIComponent(this.eventId())}/worker-requests/${encodeURIComponent(resId)}/replacements`,
        { worker_id: workerId || null },
      );
      if (res.estado === 'sin_cubrir') {
        this.error.set('SIN_CANDIDATO: La reserva quedó marcada como sin_cubrir con alerta.');
      } else {
        this.success.set(
          `Reemplazo de emergencia solicitado (${res.id ?? resId}, SLA 15 min).`,
        );
      }
      this.replacementForResId.set(null);
      this.replacementWorkerId.set('');
      await Promise.all([this.loadRequests(), this.loadAlerts()]);
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError
          ? `${err.code}: ${err.message}`
          : 'No se pudo enviar el reemplazo.',
      );
    }
  }

  /**
   * TR-09: Reusa siempre la misma idempotency key `pay:${reservationId}` sin incrementarla.
   */
  async payReservationTestMode(reservationId: string): Promise<void> {
    const key = `pay:${reservationId}`;
    this.error.set(null);
    this.success.set(null);
    try {
      const pay = await this.api.post<PaymentDto>(
        `/v1/reservations/${encodeURIComponent(reservationId)}/payments`,
        {},
        { idempotencyKey: key },
      );
      this.paymentsByRes.update((curr) => ({ ...curr, [reservationId]: pay }));
      this.success.set(
        pay.estado === 'desconocido'
          ? `Resultado PSP desconocido (${pay.payment_id}). Consulta el estado antes de reintentar (TR-09).`
          : `Pago en modo test ${pay.estado}: ${pay.monto} (key ${key}).`,
      );
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? `${err.code}: ${err.message}` : 'Error ejecutando pago.',
      );
    }
  }

  async queryPaymentStatus(reservationId: string): Promise<void> {
    this.error.set(null);
    try {
      const res = await this.api.get<PaginatedResponse<PaymentDto>>(
        `/v1/reservations/${encodeURIComponent(reservationId)}/payments`,
      );
      const latest = res.items?.[0];
      if (latest) {
        this.paymentsByRes.update((curr) => ({ ...curr, [reservationId]: latest }));
      }
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? `${err.code}: ${err.message}` : 'Sin cobros registrados.',
      );
    }
  }
}

function toIso(localVal: string): string | null {
  if (!localVal) return null;
  const d = new Date(localVal);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toLocalDatetime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
