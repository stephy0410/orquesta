import { CommonModule } from '@angular/common';
import { Component, ElementRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
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
import { formatFecha, humanize, humanizeList, precio, total } from '../../../shared/labels';

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
  private readonly router = inject(Router);

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
  readonly total = total;

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
  readonly cancelOpen = signal<string | null>(null);

  // Pago con Stripe
  private readonly checkoutDialog = viewChild<ElementRef<HTMLDialogElement>>('checkout');
  readonly checkoutFor = signal<WorkerRequestItemDto | null>(null);
  readonly paying = signal(false);
  readonly payError = signal<string | null>(null);

  /** Proveedores del mismo puesto que la contratación que se va a reemplazar. */
  readonly replacementOptions = computed(() => {
    const req = this.requests().find((r) => this.getResId(r) === this.replacementForResId());
    return this.workers().filter(
      (w) => w.worker_id !== req?.worker_id && (!req || (w.categorias ?? []).includes(req.rol)),
    );
  });

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
      await Promise.all([this.loadWorkerNames(), this.loadPayments()]);
      this.handleCheckoutReturn();
    }
  }

  /** Stripe Checkout regresa con ?pago=exito o ?pago=cancelado. */
  private handleCheckoutReturn(): void {
    const pago = this.route.snapshot.queryParamMap.get('pago');
    if (!pago) return;
    if (pago === 'exito') this.success.set('Pago recibido. Puede tardar unos segundos en aparecer como pagado.');
    if (pago === 'cancelado') this.error.set('No se hizo ningún cargo. Puedes intentar pagar de nuevo.');
    void this.router.navigate([], { queryParams: { pago: null }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  isPaid(pay: PaymentDto | undefined): boolean {
    return !!pay && (pay.estado === 'confirmado' || pay.estado === 'pagado');
  }

  requestStateLabel(estado: string): string {
    const map: Record<string, string> = {
      solicitada: 'Esperando respuesta',
      aceptada: 'Pago pendiente',
      rechazada: 'Rechazó',
      cancelada: 'Cancelada',
      sin_cubrir: 'Sin cubrir',
      completada: 'Completada',
    };
    return map[estado] ?? humanize(estado);
  }

  /** Estado de pago de cada contratación aceptada, para mostrar "Pagado" al entrar. */
  async loadPayments(): Promise<void> {
    const aceptadas = this.requests().filter((r) => r.estado === 'aceptada' || r.estado === 'completada');
    await Promise.all(aceptadas.map((r) => this.queryPaymentStatus(this.getResId(r), true)));
  }

  openCheckout(r: WorkerRequestItemDto): void {
    this.payError.set(null);
    this.checkoutFor.set(r);
    this.checkoutDialog()?.nativeElement.showModal();
  }

  closeCheckout(): void {
    this.checkoutDialog()?.nativeElement.close();
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
      this.cancelOpen.set(null);
      this.success.set(res.estado === 'cancelada' ? 'Contratación cancelada.' : `Contratación: ${humanize(res.estado).toLowerCase()}.`);
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
   * Cobra la contratación. Siempre usa la misma clave `pay:<reserva>` para que reintentar no cobre
   * dos veces. Si el backend responde con `checkout_url` (Stripe Checkout), mandamos a la planner a
   * esa página; al terminar Stripe regresa a esta misma pantalla con ?pago=exito|cancelado.
   */
  async confirmPayment(r: WorkerRequestItemDto): Promise<void> {
    const reservationId = this.getResId(r);
    this.paying.set(true);
    this.payError.set(null);
    try {
      const back = `${location.origin}/planner/events/${encodeURIComponent(this.eventId())}/workers`;
      const res = await this.api.post<PaymentDto & { checkout_url?: string }>(
        `/v1/reservations/${encodeURIComponent(reservationId)}/payments`,
        { success_url: `${back}?pago=exito`, cancel_url: `${back}?pago=cancelado` },
        { idempotencyKey: `pay:${reservationId}` },
      );
      if (res.checkout_url) {
        location.assign(res.checkout_url);
        return;
      }
      this.paymentsByRes.update((curr) => ({ ...curr, [reservationId]: res }));
      if (res.estado === 'desconocido') {
        this.payError.set('No pudimos confirmar el pago con el banco. Revisa en unos minutos antes de reintentar.');
      } else if (!this.isPaid(res)) {
        this.payError.set('El pago quedó pendiente. Te avisaremos cuando se confirme.');
      }
    } catch (err) {
      this.payError.set(err instanceof OrquestaApiError ? err.message : 'No pudimos procesar el pago. Intenta de nuevo.');
    } finally {
      this.paying.set(false);
    }
  }

  async queryPaymentStatus(reservationId: string, silent = false): Promise<void> {
    if (!silent) this.error.set(null);
    try {
      const res = await this.api.get<PaginatedResponse<PaymentDto>>(
        `/v1/reservations/${encodeURIComponent(reservationId)}/payments`,
      );
      const latest = res.items?.[0];
      if (latest) {
        this.paymentsByRes.update((curr) => ({ ...curr, [reservationId]: latest }));
      }
    } catch (err) {
      if (!silent) {
        this.error.set(err instanceof OrquestaApiError ? err.message : 'Sin cobros registrados.');
      }
    }
  }
}
