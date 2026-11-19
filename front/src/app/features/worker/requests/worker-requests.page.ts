import { CommonModule } from '@angular/common';
import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../../core/api/api.service';
import { OrquestaApiError } from '../../../core/api/api-config';
import { formatFecha, humanize, precio } from '../../../shared/labels';
import {
  PaginatedResponse,
  PaymentDto,
  ReservationEstado,
  WorkerProfileStatusResponse,
  WorkerRequestItemDto,
  WorkerTipo,
} from '../../../core/api/models';

export interface WinningReservationConflict {
  reservation_id: string;
  event_id: string;
  ventana?: { inicio: string; fin: string };
  plazas?: number;
  aceptada_en?: string;
}

@Component({
  selector: 'app-worker-requests-page',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './worker-requests.page.html',
  styleUrl: './worker-requests.page.scss',
})
export class WorkerRequestsPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);

  readonly label = humanize;
  readonly formatFecha = formatFecha;
  readonly precio = precio;
  readonly requests = signal<WorkerRequestItemDto[]>([]);
  readonly workerTipo = signal<WorkerTipo>('persona');
  readonly filterEstado = signal<ReservationEstado | ''>('');
  readonly loading = signal(false);
  readonly nowMs = signal(Date.now());

  readonly partialPlazas = signal<Record<string, number>>({});
  readonly actionMotivo = signal<Record<string, string>>({});
  readonly paymentByRes = signal<Record<string, PaymentDto>>({});
  readonly overlapConflict = signal<{
    forReservationId: string;
    message: string;
    ganadora?: WinningReservationConflict;
    plazasDisponibles?: number;
  } | null>(null);

  readonly error = signal<string | null>(null);
  readonly success = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    if (typeof window !== 'undefined') {
      const tick = setInterval(() => this.nowMs.set(Date.now()), 1000);
      this.destroyRef.onDestroy(() => clearInterval(tick));
    }

    await Promise.all([this.loadProfileTipo(), this.loadRequests()]);
  }

  readonly noProfile = signal(false);
  readonly motivoOpen = signal<string | null>(null);

  async loadProfileTipo(): Promise<void> {
    try {
      const res = await this.api.get<WorkerProfileStatusResponse>('/v1/worker/profile');
      if (res.perfil?.tipo) {
        this.workerTipo.set(res.perfil.tipo);
      }
    } catch (err) {
      if (err instanceof OrquestaApiError && err.status === 404) this.noProfile.set(true);
    }
  }

  async loadRequests(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await this.api.get<PaginatedResponse<WorkerRequestItemDto>>('/v1/worker/requests', {
        params: {
          estado: this.filterEstado() || undefined,
          limit: 50,
        },
      });
      const items = res.items ?? [];
      this.requests.set(items);

      const plazasInit: Record<string, number> = { ...this.partialPlazas() };
      for (const item of items) {
        const id = this.getReqId(item);
        if (plazasInit[id] === undefined) {
          plazasInit[id] = item.plazas || 1;
        }
      }
      this.partialPlazas.set(plazasInit);
      // Estado del pago de lo aceptado, sin que el proveedor tenga que pedirlo.
      void Promise.all(
        items
          .filter((it) => it.estado === 'aceptada' || it.estado === 'completada')
          .map((it) => this.checkPaymentStatus(it, true)),
      );
    } catch (err) {
      if (err instanceof OrquestaApiError && err.status === 404) {
        this.noProfile.set(true);
        return;
      }
      this.error.set(
        err instanceof OrquestaApiError ? err.message : 'Error cargando solicitudes.',
      );
    } finally {
      this.loading.set(false);
    }
  }

  getReqId(item: WorkerRequestItemDto): string {
    return item.reservation_id ?? item.id ?? '';
  }

  setPartialPlazas(id: string, value: number): void {
    this.partialPlazas.update((curr) => ({ ...curr, [id]: Number(value) || 1 }));
  }

  setMotivo(id: string, value: string): void {
    this.actionMotivo.update((curr) => ({ ...curr, [id]: value }));
  }

  countdownLabel(expiraEn?: string): string {
    if (!expiraEn) return '—';
    const diff = Date.parse(expiraEn) - this.nowMs();
    if (Number.isNaN(diff)) return expiraEn;
    if (diff <= 0) return '0 min';
    const totalSec = Math.floor(diff / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  }

  async acceptRequest(item: WorkerRequestItemDto): Promise<void> {
    const id = this.getReqId(item);
    if (!id) return;
    this.error.set(null);
    this.success.set(null);
    this.overlapConflict.set(null);

    const plazas =
      this.workerTipo() === 'empresa' ? Math.max(1, this.partialPlazas()[id] ?? item.plazas) : item.plazas;

    try {
      const res = await this.api.post<{
        estado: string;
        plazas_aceptadas: number;
        plazas_devueltas?: number;
      }>(
        `/v1/worker/requests/${encodeURIComponent(id)}/accept`,
        { plazas },
        { idempotencyKey: `accept:${id}` },
      );

      this.success.set(
        `Aceptaste la solicitud con ${res.plazas_aceptadas} ${res.plazas_aceptadas === 1 ? 'persona' : 'personas'}.`,
      );
      await this.loadRequests();
    } catch (err) {
      if (err instanceof OrquestaApiError && err.code === 'RESERVATION_OVERLAP') {
        const ganadora = err.details['ganadora'] as WinningReservationConflict | undefined;
        const disp = err.details['plazas_disponibles'] as number | undefined;
        this.overlapConflict.set({
          forReservationId: id,
          message: err.message,
          ganadora,
          plazasDisponibles: disp,
        });
      } else {
        this.error.set(
          err instanceof OrquestaApiError ? err.message : 'No se pudo aceptar.',
        );
      }
    }
  }

  async rejectRequest(item: WorkerRequestItemDto): Promise<void> {
    const id = this.getReqId(item);
    if (!id) return;
    this.error.set(null);
    this.success.set(null);

    try {
      await this.api.post(
        `/v1/worker/requests/${encodeURIComponent(id)}/reject`,
        { motivo: (this.actionMotivo()[id] ?? '').trim() || undefined },
        { idempotencyKey: `reject:${id}` },
      );
      this.motivoOpen.set(null);
      this.success.set('Solicitud rechazada.');
      await this.loadRequests();
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? err.message : 'Error al rechazar.',
      );
    }
  }

  async cancelReservation(item: WorkerRequestItemDto): Promise<void> {
    const id = this.getReqId(item);
    const motivo = (this.actionMotivo()[id] ?? '').trim();
    if (!id || !motivo) {
      this.error.set('Escribe el motivo para cancelar la reserva.');
      return;
    }
    this.error.set(null);
    this.success.set(null);

    try {
      const res = await this.api.post<{ estado: string; alerta_planner?: string }>(
        `/v1/worker/reservations/${encodeURIComponent(id)}/cancel`,
        { motivo },
      );
      this.motivoOpen.set(null);
      this.success.set(
        'Reserva cancelada. Avisamos a la planner para que busque un reemplazo.',
      );
      await this.loadRequests();
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? err.message : 'No se pudo cancelar.',
      );
    }
  }

  async registerArrival(item: WorkerRequestItemDto): Promise<void> {
    const id = this.getReqId(item);
    if (!id) return;
    this.error.set(null);
    this.success.set(null);

    try {
      const res = await this.api.post<{ reservation_id: string; llegada_registrada_en: string }>(
        `/v1/worker/reservations/${encodeURIComponent(id)}/arrival`,
        { llegada_en: new Date().toISOString() },
      );
      this.success.set(`Llegada registrada: ${formatFecha(res.llegada_registrada_en)}.`);
      await this.loadRequests();
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError
          ? err.message
          : 'No se pudo registrar llegada.',
      );
    }
  }

  async checkPaymentStatus(item: WorkerRequestItemDto, silent = false): Promise<void> {
    const id = this.getReqId(item);
    if (!id) return;
    if (!silent) this.error.set(null);
    try {
      const pay = await this.api.get<PaymentDto>(
        `/v1/worker/reservations/${encodeURIComponent(id)}/payment`,
      );
      this.paymentByRes.update((curr) => ({ ...curr, [id]: pay }));
    } catch (err) {
      if (silent) return;
      this.error.set(
        err instanceof OrquestaApiError
          ? err.message
          : 'Sin pago registrado para esta reserva.',
      );
    }
  }
}
