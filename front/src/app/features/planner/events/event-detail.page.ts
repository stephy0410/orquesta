import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import * as QRCode from 'qrcode';
import { ApiService } from '../../../core/api/api.service';
import { OrquestaApiError } from '../../../core/api/api-config';
import { humanize } from '../../../shared/labels';
import { formatEventDate } from '../../invitation/invitation.page';
import {
  COMMON_TIMEZONES,
  CheckinItemDto,
  EventAccessTokenDto,
  EventDto,
  EventMemberDto,
  PaginatedResponse,
  ROLES_CATALOGO,
  StaffAssignmentDto,
  StaffPermiso,
} from '../../../core/api/models';
import { EventSubnavComponent } from '../shared/event-subnav.component';

@Component({
  selector: 'app-event-detail-page',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, EventSubnavComponent],
  templateUrl: './event-detail.page.html',
  styleUrl: './event-detail.page.scss',
})
export class EventDetailPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);

  readonly label = humanize;
  readonly fechaLarga = formatEventDate;
  readonly timezones = COMMON_TIMEZONES;
  readonly rolesCatalog = ROLES_CATALOGO;

  readonly eventId = signal<string>('');
  readonly event = signal<EventDto | null>(null);
  readonly members = signal<EventMemberDto[]>([]);
  readonly checkins = signal<CheckinItemDto[]>([]);
  readonly issuedAccessToken = signal<EventAccessTokenDto | null>(null);
  readonly accessQrPng = signal<string | null>(null);
  readonly copied = signal(false);
  readonly annulOpen = signal<string | null>(null);
  readonly canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  /** Enlace que abre el escáner de este evento directamente (lo que codifica el QR). */
  readonly accessLink = computed(() => {
    const tok = this.issuedAccessToken();
    return tok ? `${location.origin}/scan?token=${encodeURIComponent(tok.qr_token)}` : '';
  });

  readonly whatsappHref = computed(() => {
    const nombre = this.event()?.nombre ?? 'el evento';
    const texto = `Hola, abre este enlace en tu celular para registrar las entradas de ${nombre}: ${this.accessLink()}`;
    return `https://wa.me/?text=${encodeURIComponent(texto)}`;
  });

  readonly timezoneOptions = computed(() => {
    const current = this.editTimezone();
    const list: string[] = [...this.timezones];
    return current && !list.includes(current) ? [current, ...list] : list;
  });
  readonly accessQrDataUrl = signal<string | null>(null);

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly success = signal<string | null>(null);

  // Edit event form
  readonly editNombre = signal('');
  readonly editFecha = signal('');
  readonly editTimezone = signal('');
  readonly editAforo = signal(200);
  readonly cancelMotivo = signal('');

  // Membership form
  readonly newMemberEmail = signal('');
  readonly newMemberUserId = signal('');

  // StaffAssignment form
  readonly staffUserId = signal('');
  readonly staffPermRoster = signal(true);
  readonly staffPermCheckin = signal(true);
  readonly staffPermAnulacion = signal(false);
  readonly lastStaffAssignment = signal<StaffAssignmentDto | null>(null);

  // EventAccessToken form
  readonly accessTokenRol = signal('scanner');

  // Annulment motivos
  readonly annulMotivos = signal<Record<string, string>>({});

  estadoLabel(estado: string): string {
    const labels: Record<string, string> = {
      borrador: 'Borrador',
      publicado: 'Publicado',
      en_curso: 'En curso',
      cerrado: 'Cerrado',
      cancelado: 'Cancelado',
    };
    return labels[estado] ?? estado;
  }

  verdictLabel(kind: string): string {
    if (kind === 'admitido') return 'Entró';
    if (kind === 'anulacion') return 'Anulada';
    if (kind === 'duplicado_tardio') return 'Repetida (tardía)';
    return kind;
  }

  permisosLabel(permisos: readonly string[]): string {
    const labels: Record<string, string> = {
      roster: 'lista de invitados',
      checkin: 'registrar entradas',
      anulacion: 'anular entradas',
    };
    return permisos.map((p) => labels[p] ?? p).join(', ');
  }

  formatFecha(iso: string | null | undefined): string {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? iso
      : d.toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
  }

  async ngOnInit(): Promise<void> {
    const id = this.route.snapshot.paramMap.get('id') ?? '';
    this.eventId.set(id);
    if (id) {
      await Promise.all([this.loadEvent(), this.loadMembers(), this.loadCheckins()]);
    }
  }

  async loadEvent(): Promise<void> {
    this.loading.set(true);
    try {
      const ev = await this.api.get<EventDto>(`/v1/events/${encodeURIComponent(this.eventId())}`);
      this.event.set(ev);
      this.editNombre.set(ev.nombre);
      this.editFecha.set(ev.fecha);
      this.editTimezone.set(ev.timezone);
      this.editAforo.set(ev.aforo);
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? err.message : 'Error cargando evento.',
      );
    } finally {
      this.loading.set(false);
    }
  }

  async loadMembers(): Promise<void> {
    try {
      const res = await this.api.get<PaginatedResponse<EventMemberDto>>(
        `/v1/events/${encodeURIComponent(this.eventId())}/members`,
        { params: { limit: 50 } },
      );
      this.members.set(res.items ?? []);
    } catch {
      // Ignore if editor cannot read or empty
    }
  }

  async loadCheckins(): Promise<void> {
    try {
      const res = await this.api.get<PaginatedResponse<CheckinItemDto>>(
        `/v1/events/${encodeURIComponent(this.eventId())}/checkins`,
        { params: { limit: 25 } },
      );
      this.checkins.set(res.items ?? []);
    } catch {
      // Ignore before event starts
    }
  }

  async saveEventEdits(): Promise<void> {
    this.error.set(null);
    this.success.set(null);
    try {
      const updated = await this.api.patch<EventDto>(
        `/v1/events/${encodeURIComponent(this.eventId())}`,
        {
          nombre: this.editNombre().trim(),
          fecha: this.editFecha(),
          timezone: this.editTimezone().trim(),
          aforo: Number(this.editAforo()),
        },
      );
      this.event.set(updated);
      this.success.set('Evento actualizado.');
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? err.message : 'Error al actualizar.',
      );
    }
  }

  async transition(action: 'publish' | 'start' | 'close' | 'cancel'): Promise<void> {
    this.error.set(null);
    this.success.set(null);
    if (action === 'cancel' && !this.cancelMotivo().trim()) {
      this.error.set('Ingresa un motivo para cancelar el evento.');
      return;
    }

    try {
      const body = action === 'cancel' ? { motivo: this.cancelMotivo().trim() } : {};
      const res = await this.api.post<Partial<EventDto>>(
        `/v1/events/${encodeURIComponent(this.eventId())}/${action}`,
        body,
      );
      this.success.set(
        res.estado ? `Listo: el evento ahora está ${this.estadoLabel(res.estado).toLowerCase()}.` : 'Listo.',
      );
      await this.loadEvent();
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? err.message : 'Transición rechazada.',
      );
    }
  }

  async addEditorMember(): Promise<void> {
    this.error.set(null);
    this.success.set(null);
    const body: Record<string, string> = { rol: 'editor' };
    if (this.newMemberEmail().trim()) body['email'] = this.newMemberEmail().trim();
    if (this.newMemberUserId().trim()) body['user_id'] = this.newMemberUserId().trim();
    if (!body['email'] && !body['user_id']) return;

    try {
      await this.api.post(
        `/v1/events/${encodeURIComponent(this.eventId())}/members`,
        body,
      );
      this.newMemberEmail.set('');
      this.newMemberUserId.set('');
      this.success.set('Listo: ya puede editar este evento.');
      await this.loadMembers();
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? err.message : 'Error agregando miembro.',
      );
    }
  }

  async removeMember(userId: string): Promise<void> {
    this.error.set(null);
    this.success.set(null);
    try {
      await this.api.delete(
        `/v1/events/${encodeURIComponent(this.eventId())}/members/${encodeURIComponent(userId)}`,
      );
      this.success.set('Acceso quitado.');
      await this.loadMembers();
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? err.message : 'Error revocando.',
      );
    }
  }

  async grantStaffAssignment(): Promise<void> {
    const uid = this.staffUserId().trim();
    if (!uid) return;
    const permisos: StaffPermiso[] = [];
    if (this.staffPermRoster()) permisos.push('roster');
    if (this.staffPermCheckin()) permisos.push('checkin');
    if (this.staffPermAnulacion()) permisos.push('anulacion');
    if (permisos.length === 0) return;

    this.error.set(null);
    this.success.set(null);
    try {
      const res = await this.api.post<StaffAssignmentDto>(
        `/v1/events/${encodeURIComponent(this.eventId())}/staff-assignments`,
        { user_id: uid, permisos },
      );
      this.lastStaffAssignment.set(res);
      this.staffUserId.set('');
      this.success.set(`Permiso guardado hasta el ${this.formatFecha(res.expira_en)}.`);
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError
          ? err.message
          : 'No se pudo otorgar permiso.',
      );
    }
  }

  async issueAccessToken(): Promise<void> {
    this.error.set(null);
    this.success.set(null);
    try {
      const tok = await this.api.post<EventAccessTokenDto>(
        `/v1/events/${encodeURIComponent(this.eventId())}/access-tokens`,
        { rol: this.accessTokenRol() },
      );
      this.issuedAccessToken.set(tok);
      const link = this.accessLink();
      const color = { dark: '#2b2e1b', light: '#ffffff' };
      const svg = await QRCode.toString(link, { type: 'svg', width: 220, margin: 2, color });
      this.accessQrDataUrl.set(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      this.accessQrPng.set(await QRCode.toDataURL(link, { width: 800, margin: 2, color }));
      this.copied.set(false);
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? err.message : 'Error emitiendo QR.',
      );
    }
  }

  async copyAccessLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.accessLink());
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2500);
    } catch {
      this.error.set('No pudimos copiar el enlace. Selecciónalo y cópialo a mano.');
    }
  }

  async shareAccess(): Promise<void> {
    try {
      await navigator.share({
        title: `Escáner de ${this.event()?.nombre ?? 'tu evento'}`,
        text: 'Abre este enlace en tu celular para registrar las entradas.',
        url: this.accessLink(),
      });
    } catch {
      // La persona cerró el menú de compartir.
    }
  }

  slug(nombre: string): string {
    return nombre
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
  }

  /** Qué toca hacer según el estado: un título, una explicación y, si aplica, una acción. */
  nextStep(estado: string): {
    titulo: string;
    texto: string;
    accion?: { action: 'publish' | 'start' | 'close'; label: string };
  } {
    switch (estado) {
      case 'borrador':
        return {
          titulo: 'Tu evento está en borrador',
          texto: 'Publícalo cuando tengas lista la información para poder enviar invitaciones.',
          accion: { action: 'publish', label: 'Publicar evento' },
        };
      case 'publicado':
        return {
          titulo: 'Listo para recibir invitados',
          texto: 'El día del evento, inícialo para empezar a registrar entradas en la puerta.',
          accion: { action: 'start', label: 'Iniciar evento' },
        };
      case 'en_curso':
        return {
          titulo: 'El evento está en curso',
          texto: 'Las entradas se registran en vivo. Ciérralo al terminar para ver el resumen final.',
          accion: { action: 'close', label: 'Cerrar evento' },
        };
      case 'cerrado':
        return {
          titulo: 'Evento cerrado',
          texto: 'Ya no se puede editar. Consulta las llegadas y quién no asistió en el tablero.',
        };
      default:
        return { titulo: 'Evento cancelado', texto: 'Este evento ya no está activo.' };
    }
  }

  setAnnulMotivo(checkinId: string, motivo: string): void {
    this.annulMotivos.update((curr) => ({ ...curr, [checkinId]: motivo }));
  }

  async annulCheckin(checkinId: string): Promise<void> {
    const motivo = (this.annulMotivos()[checkinId] ?? '').trim();
    if (!motivo) {
      this.error.set('Escribe el motivo para anular la entrada.');
      return;
    }
    this.error.set(null);
    this.success.set(null);
    try {
      await this.api.post(
        `/v1/events/${encodeURIComponent(this.eventId())}/checkins/${encodeURIComponent(checkinId)}/annulments`,
        { motivo, annuls_checkin_id: checkinId },
      );
      this.annulOpen.set(null);
      this.success.set('Entrada anulada.');
      await this.loadCheckins();
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? err.message : 'Error al anular.',
      );
    }
  }
}
