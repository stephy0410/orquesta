import { DashboardEventItem } from '../../../core/api/models';

/** Ventana mínima entre anuncios al lector de pantalla (WCAG 4.1.3 sin saturar). */
export const LIVE_ANNOUNCE_MIN_MS = 15_000;

/**
 * Resume en una frase lo que cambió entre dos lecturas del tablero: llegadas y confirmaciones.
 * Devuelve null si no hubo cambios que valga la pena anunciar.
 */
export function buildLiveAnnouncement(
  prev: readonly DashboardEventItem[],
  next: readonly DashboardEventItem[],
): string | null {
  const before = new Map(prev.map((e) => [e.event_id, e.contadores]));
  const parts: string[] = [];
  for (const ev of next) {
    const old = before.get(ev.event_id);
    if (!old) continue;
    const llegaron = ev.contadores.asistentes - old.asistentes;
    const confirmaron = ev.contadores.confirmados - old.confirmados;
    const cambios: string[] = [];
    if (llegaron > 0) cambios.push(`${llegaron} ${llegaron === 1 ? 'llegada' : 'llegadas'}`);
    if (confirmaron > 0) {
      cambios.push(`${confirmaron} ${confirmaron === 1 ? 'confirmación' : 'confirmaciones'}`);
    }
    if (cambios.length > 0) {
      parts.push(
        `${ev.nombre}: ${cambios.join(' y ')}; van ${ev.contadores.asistentes} de ${ev.contadores.confirmados} confirmados`,
      );
    }
  }
  return parts.length > 0 ? `${parts.join('. ')}.` : null;
}

/**
 * Agrupa anuncios: el primero sale de inmediato y los siguientes esperan la ventana mínima.
 * Mientras se espera, se conserva la línea base anterior para que el anuncio sume todo lo ocurrido.
 */
export class LiveAnnouncer {
  private baseline: readonly DashboardEventItem[] | null = null;
  private lastAnnouncedAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly minIntervalMs = LIVE_ANNOUNCE_MIN_MS) {}

  /** Recibe la lectura nueva y devuelve el texto a anunciar, o null si toca callar. */
  push(items: readonly DashboardEventItem[], now = Date.now()): string | null {
    if (this.baseline === null) {
      this.baseline = items;
      return null;
    }
    if (now - this.lastAnnouncedAt < this.minIntervalMs) {
      return null;
    }
    const message = buildLiveAnnouncement(this.baseline, items);
    this.baseline = items;
    if (message) {
      this.lastAnnouncedAt = now;
    }
    return message;
  }

  reset(): void {
    this.baseline = null;
  }
}
