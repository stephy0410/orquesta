import { CommonModule } from '@angular/common';
import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
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
import { humanize } from '../../../shared/labels';
import { EventSubnavComponent } from '../shared/event-subnav.component';

type Filtro = 'todos' | 'confirma' | 'declina' | 'pendiente' | 'sin_enviar';

@Component({
  selector: 'app-event-guests-page',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, EventSubnavComponent],
  templateUrl: './event-guests.page.html',
  styleUrl: './event-guests.page.scss',
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
  readonly uploadOpen = signal(false);
  readonly confirmDelete = signal<string | null>(null);
  readonly query = signal('');
  readonly filtro = signal<Filtro>('todos');
  readonly filtros: { id: Filtro; label: string }[] = [
    { id: 'todos', label: 'Invitados' },
    { id: 'confirma', label: 'Confirmaron' },
    { id: 'declina', label: 'No vienen' },
    { id: 'pendiente', label: 'Sin respuesta' },
    { id: 'sin_enviar', label: 'Sin enviar' },
  ];

  readonly counts = computed(() => {
    const c: Record<Filtro, number> = { todos: 0, confirma: 0, declina: 0, pendiente: 0, sin_enviar: 0 };
    for (const g of this.guests()) {
      c.todos++;
      c[this.filtroDe(g)]++;
    }
    return c;
  });

  readonly visibleGuests = computed(() => {
    const f = this.filtro();
    const q = this.normalize(this.query().trim());
    return this.guests().filter(
      (g) =>
        (f === 'todos' || this.filtroDe(g) === f) &&
        (!q || this.normalize(`${g.nombre} ${g.email ?? ''} ${g.telefono ?? ''}`).includes(q)),
    );
  });

  /** Regla del proyecto: no se envía la invitación a quien todavía no tiene mesa. */
  readonly sinMesaPorEnviar = computed(() =>
    this.guests().filter((g) => !g.deleted_at && this.filtroDe(g) === 'sin_enviar' && !g.table_id && !g.mesa),
  );

  readonly allVisibleSelected = computed(() => {
    const vis = this.visibleGuests();
    const sel = this.selectedGuestIds();
    return vis.length > 0 && vis.every((g) => sel.has(this.getGuestId(g)));
  });

  readonly resendCanal = signal<'sms' | 'email' | 'ambos'>('ambos');

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

  readonly label = humanize;

  private normalize(t: string): string {
    return t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  private filtroDe(g: GuestDto): Exclude<Filtro, 'todos'> {
    if (g.estado_rsvp === 'confirma') return 'confirma';
    if (g.estado_rsvp === 'declina') return 'declina';
    if (!g.estado_envio || g.estado_envio === 'pendiente_envio') return 'sin_enviar';
    return 'pendiente';
  }

  guestStatus(g: GuestDto): { label: string; tone: string } {
    switch (this.filtroDe(g)) {
      case 'confirma':
        return { label: 'Confirmó', tone: 'ok' };
      case 'declina':
        return { label: 'No viene', tone: 'no' };
      case 'sin_enviar':
        return { label: 'Sin enviar', tone: 'draft' };
      default:
        return { label: 'Sin respuesta', tone: 'wait' };
    }
  }

  clearSelection(): void {
    this.selectedGuestIds.set(new Set());
  }

  toggleAllVisible(): void {
    const ids = this.visibleGuests().map((g) => this.getGuestId(g));
    const all = this.allVisibleSelected();
    this.selectedGuestIds.update((curr) => {
      const next = new Set(curr);
      for (const id of ids) {
        if (all) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  guestName(guestId: string): string {
    const g = this.guests().find((x) => this.getGuestId(x) === guestId);
    return g?.nombre ?? 'Invitado';
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
        this.error.set(err.message);
      } else {
        this.error.set('No pudimos subir la lista. Revisa que sea un archivo CSV e inténtalo de nuevo.');
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
            `Lista subida: ${job.aceptadas} agregados, ${job.rechazadas} con errores y ${job.duplicadas_en_archivo} repetidos.`,
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
    const sel = this.selectedGuestIds();
    const sinMesa =
      alcance === 'seleccion'
        ? this.guests().filter((g) => sel.has(this.getGuestId(g)) && !g.table_id && !g.mesa)
        : this.sinMesaPorEnviar();
    if (sinMesa.length > 0) {
      this.error.set(
        sinMesa.length === 1
          ? `${sinMesa[0].nombre} todavía no tiene mesa. Asígnasela en Mesas antes de enviar su invitación.`
          : `${sinMesa.length} invitados todavía no tienen mesa. Asígnales mesa en Mesas antes de enviar sus invitaciones.`,
      );
      return;
    }
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
      this.error.set('No hay invitados por enviar.');
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
        `Listo: se están enviando ${res.entregas_encoladas} invitaciones por SMS y correo.`,
      );
      await Promise.all([this.loadPendingSummary(), this.loadGuests(), this.loadDeliveries()]);
    } catch (err) {
      if (err instanceof OrquestaApiError && err.code === 'CONFIRMACION_REQUERIDA') {
        await this.loadPendingSummary();
      }
      this.error.set(
        err instanceof OrquestaApiError ? err.message : 'Error disparando envío.',
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

    // Cada invitado admite un reenvío por ronda: probamos la siguiente ronda libre.
    let lastErr: unknown = null;
    for (const ventana of ['resend_1', 'resend_2', 'resend_3']) {
      try {
        const res = await this.api.post<SendInvitationsResponse>(
          `/v1/events/${encodeURIComponent(this.eventId())}/invitations/resend`,
          { guest_ids: ids, canal: this.resendCanal(), ventana },
        );
        if (res.entregas_encoladas === 0) continue;
        this.success.set(`Listo: se están reenviando ${res.entregas_encoladas} invitaciones.`);
        this.selectedGuestIds.set(new Set());
        await this.loadDeliveries();
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    this.error.set(
      lastErr instanceof OrquestaApiError
        ? lastErr.message
        : 'Ya se reenvió el máximo de veces a estos invitados.',
    );
  }

  /** Trae la lista completa (hasta 2000) para poder contar, filtrar y buscar al instante. */
  async loadGuests(): Promise<void> {
    try {
      const all: GuestDto[] = [];
      let cursor: string | undefined;
      do {
        const res = await this.api.get<PaginatedResponse<GuestDto>>(
          `/v1/events/${encodeURIComponent(this.eventId())}/guests`,
          { params: { limit: 100, cursor } },
        );
        all.push(...(res.items ?? []));
        cursor = res.next_cursor ?? undefined;
      } while (cursor && all.length < 2000);
      this.guests.set(all);
      this.guestsNextCursor.set(cursor ?? null);
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? err.message : 'No pudimos cargar la lista de invitados.',
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
      this.confirmDelete.set(null);
      this.success.set(
        res.asientos_liberados > 0
          ? 'Quitamos al invitado. Su invitación ya no funciona y su lugar en la mesa quedó libre.'
          : 'Quitamos al invitado. Su invitación ya no funciona.',
      );
      await Promise.all([this.loadGuests(), this.loadPendingSummary()]);
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? err.message : 'Error dando de baja.',
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
