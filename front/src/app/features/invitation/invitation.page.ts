import { CommonModule } from '@angular/common';
import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import * as QRCode from 'qrcode';
import { ApiService } from '../../core/api/api.service';
import { OrquestaApiError } from '../../core/api/api-config';
import { PublicEventSummary, PublicRsvpStateResponse, RsvpRespuesta } from '../../core/api/models';

export interface InvitationHashParams {
  token: string | null;
  eventId: string | null;
  codigoCorto: string | null;
  qrToken: string | null;
  pngUrl: string | null;
}

export function extractInvitationParamsFromHash(hash: string): InvitationHashParams {
  const empty: InvitationHashParams = {
    token: null,
    eventId: null,
    codigoCorto: null,
    qrToken: null,
    pngUrl: null,
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

  const getClean = (k: string): string | null => {
    const v = params.get(k);
    return v && v.trim().length > 0 ? v.trim() : null;
  };

  return {
    token,
    eventId: getClean('e'),
    codigoCorto: getClean('c'),
    qrToken: getClean('q'),
    pngUrl: getClean('p'),
  };
}

export function extractRsvpTokenFromHash(hash: string): string | null {
  return extractInvitationParamsFromHash(hash).token;
}

@Component({
  selector: 'app-invitation-page',
  standalone: true,
  imports: [CommonModule, FormsModule],
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
    this.token.set(parsed.token);
    if (parsed.token && parsed.eventId) {
      void this.loadFromCachedSummary({
        rsvpToken: parsed.token,
        eventId: parsed.eventId,
        qrToken: parsed.qrToken,
        codigoCorto: parsed.codigoCorto,
        pngUrl: parsed.pngUrl,
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

  async loadFromCachedSummary(opts: {
    rsvpToken: string;
    eventId: string;
    qrToken?: string | null;
    codigoCorto?: string | null;
    pngUrl?: string | null;
  }): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const summary = await this.api.get<PublicEventSummary>(
        `/v1/public/events/${encodeURIComponent(opts.eventId)}/summary`,
        { publicNoCookies: true },
      );
      this.state.set({
        respuesta: null,
        respondido_en: null,
        qr: {
          token: opts.qrToken ?? '',
          codigo_corto: opts.codigoCorto ?? undefined,
          png_url: opts.pngUrl ?? undefined,
        },
        evento: summary,
      });
      await this.renderQr(opts.qrToken ?? null);
    } catch (err) {
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
    } finally {
      this.loading.set(false);
    }
  }

  async loadRsvpState(rsvpToken: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await this.api.get<PublicRsvpStateResponse>(
        `/v1/public/invitations/${encodeURIComponent(rsvpToken)}/rsvp`,
        { publicNoCookies: true },
      );
      this.state.set(res);
      await this.renderQr(res.qr?.token ?? null);
    } catch (err) {
      this.state.set(null);
      this.qrDataUrl.set(null);
      this.error.set(
        err instanceof OrquestaApiError
          ? err
          : new OrquestaApiError(500, 'UNKNOWN_ERROR', 'No se pudo cargar tu invitación.'),
      );
    } finally {
      this.loading.set(false);
    }
  }

  async respond(respuesta: RsvpRespuesta): Promise<void> {
    const rsvpToken = this.token();
    if (!rsvpToken || this.submitting()) return;

    this.submitting.set(true);
    this.error.set(null);
    this.lastActionBanner.set(null);

    try {
      const res = await this.api.post<PublicRsvpStateResponse>(
        `/v1/public/invitations/${encodeURIComponent(rsvpToken)}/rsvp`,
        { respuesta },
        { publicNoCookies: true },
      );
      this.state.update((prev) => ({
        ...res,
        evento: res.evento ?? prev?.evento,
      }));
      await this.renderQr(res.qr?.token ?? this.state()?.qr?.token ?? null);
      this.lastActionBanner.set(
        respuesta === 'confirma'
          ? 'Tu asistencia ha sido confirmada. Conserva este QR para el acceso.'
          : 'Registramos que no podrás asistir. Puedes cambiar tu respuesta en cualquier momento.',
      );
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError
          ? err
          : new OrquestaApiError(500, 'UNKNOWN_ERROR', 'No se pudo guardar tu respuesta.'),
      );
    } finally {
      this.submitting.set(false);
    }
  }

  private async renderQr(qrToken: string | null): Promise<void> {
    if (!qrToken) {
      this.qrDataUrl.set(null);
      return;
    }
    try {
      const svg = await QRCode.toString(qrToken, {
        type: 'svg',
        width: 260,
        margin: 2,
        errorCorrectionLevel: 'M',
        color: {
          dark: '#0f172a',
          light: '#ffffff',
        },
      });
      this.qrDataUrl.set(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    } catch {
      this.qrDataUrl.set(null);
    }
  }
}
