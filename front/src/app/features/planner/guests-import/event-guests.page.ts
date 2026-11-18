import { CommonModule } from '@angular/common';
import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiService } from '../../../core/api/api.service';
import { OrquestaApiError } from '../../../core/api/api-config';
import {
  CanalEntrega,
  DeliveryDto,
  GuestDto,
  GuestImportJobDto,
  PaginatedResponse,
  PendingSummaryResponse,
  SendInvitationsResponse,
} from '../../../core/api/models';
import { EventSubnavComponent } from '../shared/event-subnav.component';

@Component({
  selector: 'app-event-guests-page',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, EventSubnavComponent],
  templateUrl: './event-guests.page.html',
})
export class EventGuestsPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  readonly eventId = signal('');
  readonly selectedFile = signal<File | null>(null);
  readonly fileIdempotencyKey = signal<string | null>(null);

  readonly importJob = signal<GuestImportJobDto | null>(null);
  readonly importing = signal(false);

  readonly pendingSummary = signal<PendingSummaryResponse | null>(null);
  readonly confirmSendOpen = signal(false);
  readonly sendAlcance = signal<'pendiente_envio' | 'seleccion'>('pendiente_envio');
  readonly lastSendResult = signal<SendInvitationsResponse | null>(null);

  readonly guests = signal<GuestDto[]>([]);
  readonly guestsNextCursor = signal<string | null>(null);
  readonly selectedGuestIds = signal<Set<string>>(new Set());
  readonly filterSinMesa = signal(false);
  readonly filterDeleted = signal(false);

  readonly resendCanal = signal<'sms' | 'email' | 'ambos'>('ambos');
  readonly resendVentana = signal('resend_1');

  readonly deliveries = signal<DeliveryDto[]>([]);
  readonly deliveryEstado = signal('');
  readonly deliveryCanal = signal<CanalEntrega | ''>('');

  readonly error = signal<string | null>(null);
  readonly success = signal<string | null>(null);

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get('id') ?? '';
    this.eventId.set(id);
    this.destroyRef.onDestroy(() => this.stopImportPoll());
    if (id) {
      void Promise.all([this.loadPendingSummary(), this.loadGuests(), this.loadDeliveries()]);
    }
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    this.selectedFile.set(file);
    this.fileIdempotencyKey.set(file ? this.api.newIdempotencyKey() : null);
  }

  downloadSampleCsv(): void {
    const csv = 'nombre,email,telefono\nAna Ruiz,ana@example.com,+525512345678\nLuis Prado,,+525500001111\n';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'orquesta-invitados-ejemplo.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  async uploadCsv(): Promise<void> {
    const file = this.selectedFile();
    if (!file || this.importing()) return;

    this.importing.set(true);
    this.error.set(null);
    this.success.set(null);

    const formData = new FormData();
    formData.append('file', file, file.name);

    const key = this.fileIdempotencyKey() ?? this.api.newIdempotencyKey();
    this.fileIdempotencyKey.set(key);

    try {
      const job = await this.api.postMultipart<GuestImportJobDto>(
        `/v1/events/${encodeURIComponent(this.eventId())}/guests/import`,
        formData,
        { idempotencyKey: key },
      );
      this.importJob.set(job);

      if (job.estado === 'en_proceso') {
        this.startImportPoll(job.import_id);
      } else {
        this.importing.set(false);
        await Promise.all([this.loadPendingSummary(), this.loadGuests()]);
      }
    } catch (err) {
      this.importing.set(false);
      if (err instanceof OrquestaApiError) {
        const extra = err.details['errores'];
        if (Array.isArray(extra)) {
          this.importJob.set({
            import_id: 'rejected',
            estado: 'fallido',
            progreso: 1,
            total_filas: extra.length,
            aceptadas: 0,
            rechazadas: extra.length,
            duplicadas_en_archivo: 0,
            errores: extra as GuestImportJobDto['errores'],
          });
        }
        this.error.set(`${err.code}: ${err.message}`);
      } else {
        this.error.set('No se pudo subir el CSV.');
      }
    }
  }

  private startImportPoll(importId: string): void {
    this.stopImportPoll();
    this.pollTimer = setInterval(async () => {
      try {
        const job = await this.api.get<GuestImportJobDto>(
          `/v1/events/${encodeURIComponent(this.eventId())}/guests/imports/${encodeURIComponent(importId)}`,
        );
        this.importJob.set(job);
        if (job.estado !== 'en_proceso') {
          this.stopImportPoll();
          this.importing.set(false);
          this.success.set(
            `Import ${job.estado}: ${job.aceptadas} aceptadas, ${job.rechazadas} rechazadas, ${job.duplicadas_en_archivo} duplicadas.`,
          );
          await Promise.all([this.loadPendingSummary(), this.loadGuests()]);
        }
      } catch {
        this.stopImportPoll();
        this.importing.set(false);
      }
    }, 1000);
  }

  private stopImportPoll(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async loadPendingSummary(): Promise<void> {
    try {
      const summary = await this.api.get<PendingSummaryResponse>(
        `/v1/events/${encodeURIComponent(this.eventId())}/invitations/pending-summary`,
      );
      this.pendingSummary.set(summary);
    } catch {
      // Ignore if event is still loading
    }
  }

  async prepareSend(alcance: 'pendiente_envio' | 'seleccion'): Promise<void> {
    this.error.set(null);
    await this.loadPendingSummary();
    this.sendAlcance.set(alcance);
    this.confirmSendOpen.set(true);
  }

  async confirmAndSend(): Promise<void> {
    const summary = this.pendingSummary();
    const alcance = this.sendAlcance();
    const selectedIds = [...this.selectedGuestIds()];
    const confirmedCount =
      alcance === 'seleccion' ? selectedIds.length : (summary?.destinatarios ?? 0);

    if (confirmedCount <= 0) {
      this.error.set('No hay destinatarios confirmados para enviar.');
      return;
    }

    this.error.set(null);
    this.success.set(null);
    try {
      const res = await this.api.post<SendInvitationsResponse>(
        `/v1/events/${encodeURIComponent(this.eventId())}/invitations/send`,
        {
          alcance,
          guest_ids: alcance === 'seleccion' ? selectedIds : undefined,
          destinatarios_confirmados: confirmedCount,
        },
      );
      this.lastSendResult.set(res);
      this.confirmSendOpen.set(false);
      this.success.set(
        `Envío ${res.envio_id} encolado: ${res.entregas_encoladas} entregas por SMS y Email.`,
      );
      await Promise.all([this.loadPendingSummary(), this.loadGuests(), this.loadDeliveries()]);
    } catch (err) {
      if (err instanceof OrquestaApiError && err.code === 'CONFIRMACION_REQUERIDA') {
        await this.loadPendingSummary();
      }
      this.error.set(
        err instanceof OrquestaApiError ? `${err.code}: ${err.message}` : 'Error disparando envío.',
      );
    }
  }

  async triggerResend(): Promise<void> {
    const ids = [...this.selectedGuestIds()];
    if (ids.length === 0) {
      this.error.set('Selecciona al menos un invitado para reenviar.');
      return;
    }
    this.error.set(null);
    this.success.set(null);

    try {
      const res = await this.api.post<SendInvitationsResponse>(
        `/v1/events/${encodeURIComponent(this.eventId())}/invitations/resend`,
        {
          guest_ids: ids,
          canal: this.resendCanal(),
          ventana: this.resendVentana().trim() || 'resend_1',
        },
      );
      this.success.set(
        `Reenvío ${res.envio_id} encolado (${res.entregas_encoladas} entregas).`,
      );
      await this.loadDeliveries();
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? `${err.code}: ${err.message}` : 'No se pudo reenviar.',
      );
    }
  }

  async loadGuests(cursor?: string): Promise<void> {
    try {
      const res = await this.api.get<PaginatedResponse<GuestDto>>(
        `/v1/events/${encodeURIComponent(this.eventId())}/guests`,
        {
          params: {
            limit: 25,
            cursor,
            sin_mesa: this.filterSinMesa() ? 'true' : undefined,
            deleted: this.filterDeleted() ? 'true' : undefined,
          },
        },
      );
      this.guests.set(res.items ?? []);
      this.guestsNextCursor.set(res.next_cursor ?? null);
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? `${err.code}: ${err.message}` : 'Error listando invitados.',
      );
    }
  }

  getGuestId(g: GuestDto): string {
    return g.guest_id ?? g.id ?? '';
  }

  toggleGuestSelection(id: string): void {
    this.selectedGuestIds.update((curr) => {
      const next = new Set(curr);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async softDeleteGuest(guestId: string): Promise<void> {
    this.error.set(null);
    this.success.set(null);
    try {
      const res = await this.api.delete<{
        guest_id: string;
        deleted_at: string;
        token_revocado: boolean;
        jobs_cancelados: number;
        asientos_liberados: number;
      }>(`/v1/events/${encodeURIComponent(this.eventId())}/guests/${encodeURIComponent(guestId)}`);
      this.success.set(
        `Invitado dado de baja (${res.deleted_at}). Token revocado, ${res.jobs_cancelados} jobs cancelados, ${res.asientos_liberados} asientos liberados.`,
      );
      await Promise.all([this.loadGuests(), this.loadPendingSummary()]);
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? `${err.code}: ${err.message}` : 'Error dando de baja.',
      );
    }
  }

  async loadDeliveries(): Promise<void> {
    try {
      const res = await this.api.get<PaginatedResponse<DeliveryDto>>(
        `/v1/events/${encodeURIComponent(this.eventId())}/invitations/deliveries`,
        {
          params: {
            estado: this.deliveryEstado() || undefined,
            canal: this.deliveryCanal() || undefined,
            limit: 50,
          },
        },
      );
      this.deliveries.set(res.items ?? []);
    } catch {
      // Ignore empty deliveries
    }
  }
}
