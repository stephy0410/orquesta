import { CommonModule } from '@angular/common';
import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../../core/api/api.service';
import { OrquestaApiError } from '../../../core/api/api-config';
import {
  DashboardEventItem,
  DashboardResponse,
  EventDto,
  PaginatedResponse,
} from '../../../core/api/models';
import { LiveAnnouncer } from './live-announcement';

export const DASHBOARD_POLL_MS = 3000;
export const DASHBOARD_MAX_LIMIT = 25;
const STALE_HEARTBEAT_MS = 5 * 60 * 1000;

const ESTADO_LABEL: Record<string, string> = {
  borrador: 'Borrador',
  publicado: 'Publicado',
  en_curso: 'En curso',
  cerrado: 'Cerrado',
  cancelado: 'Cancelado',
};

@Component({
  selector: 'app-planner-dashboard-page',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './planner-dashboard.page.html',
  styleUrl: './planner-dashboard.page.scss',
})
export class PlannerDashboardPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);

  readonly items = signal<DashboardEventItem[]>([]);
  readonly allEvents = signal<EventDto[]>([]);
  readonly showAllEventsFallback = signal(false);

  readonly generadoEn = signal<string | null>(null);
  readonly limit = signal<number>(DASHBOARD_MAX_LIMIT);
  readonly currentCursor = signal<string | null>(null);
  readonly nextCursor = signal<string | null>(null);
  readonly cursorStack = signal<Array<string | null>>([]);
  readonly expandedDevices = signal<Record<string, boolean>>({});

  readonly pollingActive = signal<boolean>(true);
  readonly loading = signal<boolean>(false);
  readonly error = signal<string | null>(null);
  /** Texto para la región aria-live; agrupado para no saturar al lector de pantalla. */
  readonly liveMessage = signal('');

  private readonly announcer = new LiveAnnouncer();

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    void this.fetchDashboard();
    this.startPolling();

    if (typeof document !== 'undefined') {
      const onVisibility = () => {
        if (document.visibilityState === 'visible' && this.pollingActive()) {
          void this.fetchDashboard();
        }
      };
      document.addEventListener('visibilitychange', onVisibility);
      this.destroyRef.onDestroy(() => document.removeEventListener('visibilitychange', onVisibility));
    }

    this.destroyRef.onDestroy(() => this.stopPolling());
  }

  startPolling(): void {
    if (this.pollTimer !== null || typeof window === 'undefined') return;
    this.pollTimer = setInterval(() => {
      if (
        this.pollingActive() &&
        (typeof document === 'undefined' || document.visibilityState === 'visible')
      ) {
        void this.fetchDashboard(true);
      }
    }, DASHBOARD_POLL_MS);
  }

  stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  togglePolling(): void {
    this.pollingActive.update((v) => !v);
    if (this.pollingActive()) {
      void this.fetchDashboard();
    }
  }

  onLimitChange(nextLimit: number): void {
    const clamped = Math.min(DASHBOARD_MAX_LIMIT, Math.max(1, Number(nextLimit) || DASHBOARD_MAX_LIMIT));
    this.limit.set(clamped);
    this.currentCursor.set(null);
    this.cursorStack.set([]);
    this.announcer.reset();
    void this.fetchDashboard();
  }

  async nextPage(): Promise<void> {
    const next = this.nextCursor();
    if (!next) return;
    this.cursorStack.update((s) => [...s, this.currentCursor()]);
    this.currentCursor.set(next);
    this.announcer.reset();
    await this.fetchDashboard();
  }

  async prevPage(): Promise<void> {
    const stack = this.cursorStack();
    if (stack.length === 0) return;
    const prev = stack[stack.length - 1] ?? null;
    this.cursorStack.set(stack.slice(0, -1));
    this.currentCursor.set(prev);
    this.announcer.reset();
    await this.fetchDashboard();
  }

  async fetchDashboard(silent = false): Promise<void> {
    if (!silent) {
      this.loading.set(true);
    }
    try {
      const res = await this.api.get<DashboardResponse>('/v1/dashboard', {
        params: {
          limit: Math.min(DASHBOARD_MAX_LIMIT, this.limit()),
          cursor: this.currentCursor() ?? undefined,
        },
      });
      const nextItems = res.items ?? [];
      const message = this.announcer.push(nextItems);
      if (message) this.liveMessage.set(message);
      this.items.set(nextItems);
      this.generadoEn.set(res.generado_en ?? null);
      this.nextCursor.set(res.next_cursor ?? null);
      this.error.set(null);
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError
          ? err.message
          : 'No pudimos actualizar el tablero. Revisa tu conexión; reintentamos cada 3 segundos.',
      );
    } finally {
      this.loading.set(false);
    }
  }

  async toggleAllEventsCatalog(): Promise<void> {
    const next = !this.showAllEventsFallback();
    this.showAllEventsFallback.set(next);
    if (next) {
      try {
        const res = await this.api.get<PaginatedResponse<EventDto>>('/v1/events', {
          params: { limit: 25 },
        });
        this.allEvents.set(res.items ?? []);
      } catch {
        // Ignore if error already surfaced
      }
    }
  }

  toggleDevices(eventId: string): void {
    this.expandedDevices.update((curr) => ({ ...curr, [eventId]: !curr[eventId] }));
  }

  isDeviceStale(heartbeatEn: string): boolean {
    const ms = Date.parse(heartbeatEn);
    if (Number.isNaN(ms)) return true;
    return Date.now() - ms > STALE_HEARTBEAT_MS;
  }

  estadoLabel(estado: string): string {
    return ESTADO_LABEL[estado] ?? estado;
  }

  /** Porcentaje de confirmados que ya llegaron (0–100). */
  arrivalPct(ev: DashboardEventItem): number {
    const { asistentes, confirmados } = ev.contadores;
    if (!confirmados) return 0;
    return Math.min(100, Math.round((asistentes / confirmados) * 100));
  }

  formatCorte(iso: string | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? iso
      : d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  /** Qué tan al día están los números, en palabras (el detalle en ms es para monitoreo). */
  freshnessLabel(lagMs: number | null): string {
    if (lagMs === null) return 'Sin datos recientes';
    if (lagMs < 5000) return 'Al día';
    const s = Math.round(lagMs / 1000);
    return s < 60 ? `Con ${s} s de retraso` : `Con ${Math.round(s / 60)} min de retraso`;
  }

  lagBadgeClass(lagMs: number | null): string {
    if (lagMs === null) return 'oq-badge-neutral';
    if (lagMs <= 5000) return 'oq-badge-success';
    if (lagMs <= 10000) return 'oq-badge-warning';
    return 'oq-badge-danger';
  }
}
