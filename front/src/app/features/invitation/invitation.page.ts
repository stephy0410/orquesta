import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { ApiService } from '../../core/api/api.service';
import { OrquestaApiError } from '../../core/api/api-config';
import {
  CanalBaja,
  PublicEventSummary,
  PublicRsvpStateResponse,
  PublicUnsubscribeResponse,
  RsvpRespuesta,
} from '../../core/api/models';
import { OliveSprigComponent } from '../../shared/ui/olive-sprig.component';

export interface InvitationHashParams {
  token: string | null;
  eventId: string | null;
}

export function extractInvitationParamsFromHash(hash: string): InvitationHashParams {
  const empty: InvitationHashParams = {
    token: null,
    eventId: null,
  };
  if (!hash) return empty;
  const trimmed = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!trimmed) return empty;

  const params = new URLSearchParams(trimmed.startsWith('?') ? trimmed.slice(1) : trimmed);
  const rawToken = params.get('t') ?? params.get('token');
  let token = rawToken && rawToken.trim().length > 0 ? rawToken.trim() : null;
  if (!token) {
    const match = trimmed.match(/(?:^|&)t=([^&]+)/);
    if (match && match[1]) {
      token = decodeURIComponent(match[1]).trim() || null;
    }
  }

  const rawEventId = params.get('e');
  const eventId = rawEventId && rawEventId.trim().length > 0 ? rawEventId.trim() : null;

  return {
    token,
    eventId,
  };
}

export function extractRsvpTokenFromHash(hash: string): string | null {
  return extractInvitationParamsFromHash(hash).token;
}

/** "sábado, 21 de noviembre de 2026" a partir de YYYY-MM-DD (sin desfase de zona). */
export function formatEventDate(fecha: string | null | undefined): string {
  if (!fecha) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(fecha);
  if (!m) return fecha;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  return d.toLocaleDateString('es-MX', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Hora local del evento ("19:00") a partir de un ISO; deja pasar "19:00" tal cual. */
export function formatEventTime(value: string | null | undefined, timeZone?: string | null): string {
  if (!value) return '';
  if (/^\d{1,2}:\d{2}$/.test(value)) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  try {
    return d.toLocaleTimeString('es-MX', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: timeZone || undefined,
    });
  } catch {
    return d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
}

@Component({
  selector: 'app-invitation-page',
  standalone: true,
  // Sin FormsModule ni CommonModule: esta ruta es pública y su bundle debe ser mínimo (issue #8).
  imports: [OliveSprigComponent],
  templateUrl: './invitation.page.html',
  styleUrl: './invitation.page.scss',
})
export class InvitationPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);

  readonly token = signal<string | null>(null);
  readonly manualTokenInput = signal<string>('');
  readonly loading = signal<boolean>(false);
  readonly submitting = signal<boolean>(false);
  readonly error = signal<OrquestaApiError | null>(null);
  readonly state = signal<PublicRsvpStateResponse | null>(null);
  readonly qrDataUrl = signal<string | null>(null);
  readonly lastActionBanner = signal<string | null>(null);
  readonly changing = signal(false);
  readonly unsubscribing = signal<boolean>(false);
  readonly bajaBanner = signal<string | null>(null);
  private stateVersion = 0;

  readonly fechaLabel = computed(() => formatEventDate(this.state()?.evento.fecha));
  readonly horarioLabel = computed(() => {
    const ev = this.state()?.evento;
    if (!ev) return '';
    const inicio = formatEventTime(ev.inicio, ev.timezone);
    const fin = formatEventTime(ev.fin, ev.timezone);
    return fin ? `${inicio} a ${fin} h` : `${inicio} h`;
  });
  readonly respondidoLabel = computed(() => {
    const iso = this.state()?.respondido_en;
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? iso
      : d.toLocaleString('es-MX', { dateStyle: 'long', timeStyle: 'short' });
  });

  readonly venueLabel = computed(() => {
    const ev = this.state()?.evento;
    if (!ev) return '';
    if (ev.lugar) return ev.lugar;
    if (typeof ev.venue === 'string') return ev.venue;
    if (ev.venue && typeof ev.venue === 'object') {
      return [ev.venue.nombre, ev.venue.direccion].filter(Boolean).join(' · ');
    }
    return '';
  });

  onManualTokenInput(event: Event): void {
    this.manualTokenInput.set((event.target as HTMLInputElement).value);
  }

  ngOnInit(): void {
    this.syncTokenFromLocation();

    if (typeof window !== 'undefined') {
      const onHashChange = () => this.syncTokenFromLocation();
      window.addEventListener('hashchange', onHashChange);
      this.destroyRef.onDestroy(() => window.removeEventListener('hashchange', onHashChange));
    }
  }

  syncTokenFromLocation(): void {
    const hash = typeof window !== 'undefined' ? window.location.hash : '';
    const parsed = extractInvitationParamsFromHash(hash);
    if (parsed.token && parsed.token === this.token() && (this.loading() || this.state() !== null)) {
      return;
    }
    this.stateVersion++;
    this.token.set(parsed.token);
    if (parsed.token && parsed.eventId) {
      void this.loadFromCachedSummary({
        rsvpToken: parsed.token,
        eventId: parsed.eventId,
      });
    } else if (parsed.token) {
      void this.loadRsvpState(parsed.token);
    } else {
      this.state.set(null);
      this.qrDataUrl.set(null);
    }
  }

  openManualToken(): void {
    const cleaned = this.manualTokenInput().trim();
    if (!cleaned) return;
    if (typeof window !== 'undefined') {
      window.location.hash = `t=${encodeURIComponent(cleaned)}`;
    } else {
      this.token.set(cleaned);
      void this.loadRsvpState(cleaned);
    }
  }

  async loadFromCachedSummary(opts: { rsvpToken: string; eventId: string }): Promise<void> {
    const version = ++this.stateVersion;
    this.loading.set(true);
    this.error.set(null);
    try {
      const summary = await this.api.get<PublicEventSummary>(
        `/v1/public/events/${encodeURIComponent(opts.eventId)}/summary`,
        { publicNoCookies: true },
      );
      if (this.token() !== opts.rsvpToken || version !== this.stateVersion) return;
      this.state.set({
        respuesta: null,
        respondido_en: null,
        qr: { token: '' },
        evento: summary,
      });
      this.loading.set(false);
      // Hidratar estado real (respuesta, bajas y QR vigente) en segundo plano sin bloquear el primer render.
      void this.hydrateRsvpState(opts.rsvpToken, version);
    } catch (err) {
      if (this.token() !== opts.rsvpToken || version !== this.stateVersion) return;
      if (err instanceof OrquestaApiError && err.status === 404) {
        await this.loadRsvpState(opts.rsvpToken);
        return;
      }
      this.state.set(null);
      this.qrDataUrl.set(null);
      this.error.set(
        err instanceof OrquestaApiError
          ? err
          : new OrquestaApiError(500, 'UNKNOWN_ERROR', 'No se pudo cargar tu invitación.'),
      );
      this.loading.set(false);
    }
  }

  private async hydrateRsvpState(rsvpToken: string, version: number): Promise<void> {
    try {
      const res = await this.api.get<PublicRsvpStateResponse>(
        `/v1/public/invitations/${encodeURIComponent(rsvpToken)}/rsvp`,
        { publicNoCookies: true },
      );
      if (this.token() !== rsvpToken || version !== this.stateVersion) return;
      this.state.update((prev) => ({
        ...res,
        evento: res.evento ?? prev?.evento,
      }));
      await this.renderQr(res.qr?.token ?? null);
    } catch (err) {
      if (this.token() !== rsvpToken || version !== this.stateVersion) return;
      if (
        err instanceof OrquestaApiError &&
        (err.code === 'INVITACION_REVOCADA' ||
          err.code === 'TOKEN_INVALIDO' ||
          err.code === 'TOKEN_TIPO_INCORRECTO' ||
          err.status === 404 ||
          err.status === 410)
      ) {
        this.state.set(null);
        this.qrDataUrl.set(null);
        this.error.set(err);
      }
      // Para otros errores (red, 5xx) se conserva la vista cacheada del resumen.
    }
  }

  async loadRsvpState(rsvpToken: string): Promise<void> {
    const version = ++this.stateVersion;
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await this.api.get<PublicRsvpStateResponse>(
        `/v1/public/invitations/${encodeURIComponent(rsvpToken)}/rsvp`,
        { publicNoCookies: true },
      );
      if (version !== this.stateVersion) return;
      this.state.set(res);
      await this.renderQr(res.qr?.token ?? null);
    } catch (err) {
      if (version !== this.stateVersion) return;
      this.state.set(null);
      this.qrDataUrl.set(null);
      this.error.set(
        err instanceof OrquestaApiError
          ? err
          : new OrquestaApiError(500, 'UNKNOWN_ERROR', 'No se pudo cargar tu invitación.'),
      );
    } finally {
      if (version === this.stateVersion) {
        this.loading.set(false);
      }
    }
  }

  async respond(respuesta: RsvpRespuesta): Promise<void> {
    const rsvpToken = this.token();
    if (!rsvpToken || this.submitting()) return;

    const version = ++this.stateVersion;
    this.submitting.set(true);
    this.error.set(null);
    this.lastActionBanner.set(null);

    try {
      const res = await this.api.post<PublicRsvpStateResponse>(
        `/v1/public/invitations/${encodeURIComponent(rsvpToken)}/rsvp`,
        { respuesta },
        { publicNoCookies: true },
      );
      if (this.token() !== rsvpToken || version !== this.stateVersion) return;
      this.state.update((prev) => ({
        ...res,
        invitado: res.invitado ?? prev?.invitado,
        evento: res.evento ?? prev?.evento,
      }));
      this.changing.set(false);
      await this.renderQr(res.qr?.token ?? this.state()?.qr?.token ?? null);
      this.lastActionBanner.set(
        respuesta === 'confirma'
          ? 'Tu asistencia ha sido confirmada. Conserva este QR para el acceso.'
          : 'Registramos que no podrás asistir. Puedes cambiar tu respuesta en cualquier momento.',
      );
    } catch (err) {
      if (this.token() !== rsvpToken || version !== this.stateVersion) return;
      this.error.set(
        err instanceof OrquestaApiError
          ? err
          : new OrquestaApiError(500, 'UNKNOWN_ERROR', 'No se pudo guardar tu respuesta.'),
      );
    } finally {
      this.submitting.set(false);
    }
  }

  /**
   * Baja de mensajes por canal (README FR8: "se respeta la baja del invitado"). No afecta la
   * invitación: el QR sigue siendo válido y el invitado puede seguir confirmando.
   */
  async unsubscribe(canal: CanalBaja): Promise<void> {
    const rsvpToken = this.token();
    if (!rsvpToken || this.unsubscribing()) return;
    const version = ++this.stateVersion;
    this.unsubscribing.set(true);
    this.error.set(null);
    this.bajaBanner.set(null);
    try {
      const res = await this.api.post<PublicUnsubscribeResponse>(
        `/v1/public/invitations/${encodeURIComponent(rsvpToken)}/unsubscribe`,
        { canal },
        { publicNoCookies: true },
      );
      if (this.token() !== rsvpToken || version !== this.stateVersion) return;
      this.state.update((prev) => (prev ? { ...prev, bajas: res.bajas } : prev));
      this.bajaBanner.set(
        canal === 'sms'
          ? 'Listo: ya no te enviaremos mensajes SMS sobre este evento.'
          : canal === 'email'
            ? 'Listo: ya no te enviaremos correos sobre este evento.'
            : 'Listo: ya no te enviaremos mensajes sobre este evento.',
      );
    } catch (err) {
      if (this.token() !== rsvpToken || version !== this.stateVersion) return;
      this.error.set(
        err instanceof OrquestaApiError
          ? err
          : new OrquestaApiError(500, 'UNKNOWN_ERROR', 'No se pudo registrar tu baja.'),
      );
    } finally {
      this.unsubscribing.set(false);
    }
  }

  private async renderQr(qrToken: string | null): Promise<void> {
    if (!qrToken) {
      this.qrDataUrl.set(null);
      return;
    }
    try {
      // Import diferido: la librería de QR (~45 KB) no bloquea el primer render de la invitación.
      const mod = await import('qrcode');
      const QRCode = (mod as unknown as { default?: typeof mod }).default ?? mod;
      const svg = await QRCode.toString(qrToken, {
        type: 'svg',
        width: 260,
        margin: 2,
        errorCorrectionLevel: 'M',
        color: {
          dark: '#2b2e1b',
          light: '#ffffff',
        },
      });
      this.qrDataUrl.set(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    } catch {
      this.qrDataUrl.set(null);
    }
  }
}
