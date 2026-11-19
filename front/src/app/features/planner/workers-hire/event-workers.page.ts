import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
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
  WORKER_CATEGORIES,
  WorkerRequestItemDto,
} from '../../../core/api/models';
import { EventSubnavComponent } from '../shared/event-subnav.component';
import { formatFecha, humanize, humanizeList, precio } from '../../../shared/labels';

@Component({
  selector: 'app-event-workers-page',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, EventSubnavComponent],
  templateUrl: './event-workers.page.html',
  styleUrl: './event-workers.page.scss',
})
export class EventWorkersPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);

  readonly labelList = humanizeList;
  readonly allCategories = WORKER_CATEGORIES;
  readonly allRoles = ROLES_CATALOGO;

  readonly eventId = signal('');
  readonly event = signal<EventDto | null>(null);
  readonly requirements = signal<EventRequirementDto[]>([]);
  readonly coverage = signal<EventRequirementDto[]>([]);
  readonly requests = signal<WorkerRequestItemDto[]>([]);
  readonly alerts = signal<PlannerAlertDto[]>([]);

  readonly label = humanize;
  readonly formatFecha = formatFecha;
  readonly precio = precio;

  workerName(workerId: string | null | undefined): string {
    return this.workers().find((w) => w.worker_id === workerId)?.nombre_publico ?? 'Proveedor';
  }

  /** Catálogo publicado, solo para mostrar el nombre del proveedor en cada contratación. */
  readonly workers = signal<PublicWorkerDto[]>([]);

  /** Puestos con gente pendiente por contratar, en palabras ("Mesero (6), DJ (1)"). */
  readonly missingRoles = computed(() =>
    this.coverage()
      .filter((c) => (c.cubiertos ?? 0) + (c.pendientes ?? 0) < c.cantidad)
      .map((c) => `${humanize(c.rol)} (${c.cantidad - (c.cubiertos ?? 0) - (c.pendientes ?? 0)})`)
      .join(', '),
  );

  readonly firstMissingCategory = computed(() => {
    const cats: readonly string[] = WORKER_CATEGORIES;
    return (
      this.coverage().find(
        (c) => (c.cubiertos ?? 0) + (c.pendientes ?? 0) < c.cantidad && cats.includes(c.rol),
      )?.rol ?? ''
    );
  });

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
      await this.loadWorkerNames();
    }
  }

  async loadEvent(): Promise<void> {
    try {
      const ev = await this.api.get<EventDto>(`/v1/events/${encodeURIComponent(this.eventId())}`);
      this.event.set(ev);
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
      this.success.set('Listo: guardamos cuánta gente necesitas.');
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? err.message : 'Error guardando.',
      );
    }
  }







  async loadWorkerNames(): Promise<void> {
    try {
      const res = await this.api.get<PaginatedResponse<PublicWorkerDto>>('/v1/workers', {
        params: { limit: 50 },
      });
      this.workers.set(res.items ?? []);
    } catch {
      // Solo enriquece los nombres; las contrataciones se muestran igual.
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
        `Reserva ${humanize(res.estado).toLowerCase()}.`,
      );
      await Promise.all([this.loadRequests(), this.loadAlerts()]);
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? err.message : 'Error al cancelar.',
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
        this.error.set('Marcamos el puesto como sin cubrir. Te avisaremos en este evento.');
      } else {
        this.success.set(
          'Solicitud urgente enviada. El proveedor tiene 15 minutos para aceptar.',
        );
      }
      this.replacementForResId.set(null);
      this.replacementWorkerId.set('');
      await Promise.all([this.loadRequests(), this.loadAlerts()]);
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError
          ? err.message
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
          ? 'No sabemos todavía si el pago pasó. Revisa su estado antes de intentarlo otra vez.'
          : `Pago de prueba: ${humanize(pay.estado).toLowerCase()} (${pay.monto}).`,
      );
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? err.message : 'Error ejecutando pago.',
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
        err instanceof OrquestaApiError ? err.message : 'Sin cobros registrados.',
      );
    }
  }
}
