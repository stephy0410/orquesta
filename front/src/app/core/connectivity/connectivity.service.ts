import { DestroyRef, Injectable, InjectionToken, computed, inject, signal } from '@angular/core';
import { ORQUESTA_API_BASE_URL, buildApiUrl } from '../api/api-config';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const HEALTH_FETCH_FN = new InjectionToken<FetchLike>('HEALTH_FETCH_FN', {
  providedIn: 'root',
  factory: () => {
    if (typeof globalThis.fetch === 'function') {
      return globalThis.fetch.bind(globalThis);
    }
    return async () => new Response(null, { status: 503 });
  },
});

@Injectable({ providedIn: 'root' })
export class ConnectivityService {
  private readonly baseUrl = inject(ORQUESTA_API_BASE_URL);
  private readonly fetchFn = inject(HEALTH_FETCH_FN);
  private readonly destroyRef = inject(DestroyRef);

  readonly browserOnline = signal<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  readonly serverReachable = signal<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  readonly checking = signal<boolean>(false);
  readonly lastCheckedAt = signal<string | null>(null);
  readonly latencyMs = signal<number | null>(null);

  readonly isOnline = computed(() => this.browserOnline() && this.serverReachable());

  private monitorTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      const onOnline = () => {
        this.browserOnline.set(true);
        void this.checkHealth();
      };
      const onOffline = () => {
        this.browserOnline.set(false);
        this.serverReachable.set(false);
      };

      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);

      this.destroyRef.onDestroy(() => {
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
        this.stopMonitoring();
      });
    }
  }

  startMonitoring(intervalMs = 30000): void {
    if (this.monitorTimer !== null || typeof window === 'undefined') {
      return;
    }
    void this.checkHealth();
    this.monitorTimer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        void this.checkHealth();
      }
    }, intervalMs);
  }

  stopMonitoring(): void {
    if (this.monitorTimer !== null) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
  }

  async checkHealth(timeoutMs = 4000): Promise<boolean> {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this.browserOnline.set(false);
      this.serverReachable.set(false);
      this.lastCheckedAt.set(new Date().toISOString());
      return false;
    }

    this.browserOnline.set(true);
    this.checking.set(true);

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    const started = typeof performance !== 'undefined' ? performance.now() : Date.now();

    try {
      const url = buildApiUrl(this.baseUrl, '/health');
      const res = await this.fetchFn(url, {
        method: 'GET',
        cache: 'no-store',
        signal: controller?.signal,
      });
      const elapsed = Math.round(
        (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started,
      );
      this.latencyMs.set(elapsed);
      this.lastCheckedAt.set(new Date().toISOString());
      const ok = res.ok;
      this.serverReachable.set(ok);
      return ok;
    } catch {
      this.serverReachable.set(false);
      this.latencyMs.set(null);
      this.lastCheckedAt.set(new Date().toISOString());
      return false;
    } finally {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      this.checking.set(false);
    }
  }
}
