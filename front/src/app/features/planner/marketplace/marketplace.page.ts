import {
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiService } from '../../../core/api/api.service';
import { OrquestaApiError } from '../../../core/api/api-config';
import {
  EventDto,
  PaginatedResponse,
  PublicWorkerDto,
  WORKER_CATEGORIES,
  WORKER_ZONES,
  WorkerAvailabilityOccupiedResponse,
  WorkerRequestItemDto,
} from '../../../core/api/models';
import { formatFecha, humanize, humanizeList, precio } from '../../../shared/labels';

type Orden = 'relevancia' | 'precio_asc' | 'precio_desc' | 'experiencia';

/** Tono de la portada de cada tarjeta según la categoría principal. */
const COVER_TONE: Record<string, string> = {
  mesero: 'olive',
  catering: 'olive',
  bartender: 'bark',
  dj: 'deep',
  iluminacion_sonido: 'deep',
  fotografo: 'sage',
  video: 'sage',
  maquillista: 'bark',
  decoracion: 'sage',
  coordinacion: 'olive',
  seguridad: 'deep',
  animacion: 'bark',
};

/** "2026-11-21T01:00:00Z" → valor para <input type="datetime-local"> en hora local. */
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Marketplace de proveedores: catálogo con búsqueda, filtros, ficha del proveedor y contratación
 * para cualquiera de los eventos de la planner. La búsqueda se lanza sola al cambiar un filtro.
 */
@Component({
  selector: 'app-marketplace-page',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './marketplace.page.html',
  styleUrl: './marketplace.page.scss',
})
export class MarketplacePage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  readonly label = humanize;
  readonly labelList = humanizeList;
  readonly precio = precio;
  readonly formatFecha = formatFecha;
  readonly categories = WORKER_CATEGORIES;
  readonly zones = WORKER_ZONES;

  // Filtros
  readonly query = signal('');
  readonly categoria = signal<string>('');
  readonly zonasSel = signal<string[]>([]);
  readonly tarifaMin = signal<number | null>(null);
  readonly tarifaMax = signal<number | null>(null);
  readonly unidad = signal('');
  readonly orden = signal<Orden>('relevancia');
  readonly eventoId = signal('');
  readonly soloDisponibles = signal(true);
  readonly filtersOpen = signal(false);

  // Datos
  readonly events = signal<EventDto[]>([]);
  readonly results = signal<PublicWorkerDto[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  // Ficha y contratación
  readonly selected = signal<PublicWorkerDto | null>(null);
  readonly busy = signal<WorkerAvailabilityOccupiedResponse | null>(null);
  readonly hireEvento = signal('');
  readonly hireRol = signal('');
  readonly hirePlazas = signal(1);
  readonly hireInicio = signal('');
  readonly hireFin = signal('');
  readonly hireLlegada = signal('');
  readonly hiring = signal(false);
  readonly hireError = signal<string | null>(null);
  readonly hireDone = signal<{ eventId: string; texto: string } | null>(null);

  private readonly drawer = viewChild<ElementRef<HTMLElement>>('drawer');
  private lastTrigger: HTMLElement | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private searchSeq = 0;

  readonly eventoSel = computed(() => this.events().find((e) => e.id === this.eventoId()) ?? null);

  readonly activeFilterCount = computed(
    () =>
      this.zonasSel().length +
      (this.tarifaMin() !== null ? 1 : 0) +
      (this.tarifaMax() !== null ? 1 : 0) +
      (this.unidad() ? 1 : 0),
  );

  /** Resultados del API + búsqueda por texto + orden, todo en el cliente. */
  readonly visible = computed(() => {
    const q = this.query()
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '');
    let items = this.results();
    if (q) {
      items = items.filter((w) => {
        const hay = [
          w.nombre_publico,
          ...w.categorias.map((c) => humanize(c)),
          ...(w.servicios ?? []).map((s) => humanize(s)),
          ...w.zonas.map((z) => humanize(z)),
        ]
          .join(' ')
          .toLowerCase()
          .normalize('NFD')
          .replace(/[̀-ͯ]/g, '');
        return hay.includes(q);
      });
    }
    const orden = this.orden();
    if (orden !== 'relevancia') {
      items = [...items].sort((a, b) => {
        if (orden === 'precio_asc') return a.tarifa.monto - b.tarifa.monto;
        if (orden === 'precio_desc') return b.tarifa.monto - a.tarifa.monto;
        return this.years(b) - this.years(a);
      });
    }
    return items;
  });

  constructor() {
    // Búsqueda automática (con un pequeño retraso) cada vez que cambia un filtro del servidor.
    effect(() => {
      const filtros = {
        categoria: this.categoria(),
        zonas: this.zonasSel(),
        min: this.tarifaMin(),
        max: this.tarifaMax(),
        unidad: this.unidad(),
        evento: this.eventoSel(),
        solo: this.soloDisponibles(),
      };
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => void this.search(filtros), 250);
    });
    this.destroyRef.onDestroy(() => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
    });
  }

  async ngOnInit(): Promise<void> {
    const pre = this.route.snapshot.queryParamMap.get('evento');
    const cat = this.route.snapshot.queryParamMap.get('categoria');
    if (cat) this.categoria.set(cat);
    await this.loadEvents();
    if (pre && this.events().some((e) => e.id === pre)) this.eventoId.set(pre);
  }

  async loadEvents(): Promise<void> {
    try {
      const res = await this.api.get<PaginatedResponse<EventDto>>('/v1/events', {
        params: { limit: 50 },
      });
      this.events.set(
        (res.items ?? []).filter((e) => e.estado !== 'cerrado' && e.estado !== 'cancelado'),
      );
    } catch {
      // El marketplace funciona sin eventos; solo no se puede contratar.
    }
  }

  private async search(f: {
    categoria: string;
    zonas: string[];
    min: number | null;
    max: number | null;
    unidad: string;
    evento: EventDto | null;
    solo: boolean;
  }): Promise<void> {
    const seq = ++this.searchSeq;
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await this.api.get<PaginatedResponse<PublicWorkerDto>>('/v1/workers', {
        params: {
          categorias: f.categoria ? [f.categoria] : [],
          zonas: f.zonas,
          tarifa_min: f.min ?? undefined,
          tarifa_max: f.max ?? undefined,
          unidad: f.unidad || undefined,
          desde: f.evento && f.solo ? f.evento.ventana.inicio : undefined,
          hasta: f.evento && f.solo ? f.evento.ventana.fin : undefined,
          limit: 50,
        },
      });
      if (seq === this.searchSeq) this.results.set(res.items ?? []);
    } catch (err) {
      if (seq === this.searchSeq) {
        this.error.set(
          err instanceof OrquestaApiError
            ? err.message
            : 'No pudimos cargar los proveedores. Revisa tu conexión.',
        );
      }
    } finally {
      if (seq === this.searchSeq) this.loading.set(false);
    }
  }

  setCategoria(c: string): void {
    this.categoria.set(this.categoria() === c ? '' : c);
  }

  toggleZona(z: string): void {
    this.zonasSel.update((curr) => (curr.includes(z) ? curr.filter((x) => x !== z) : [...curr, z]));
  }

  numOrNull(v: unknown): number | null {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  clearFilters(): void {
    this.query.set('');
    this.categoria.set('');
    this.zonasSel.set([]);
    this.tarifaMin.set(null);
    this.tarifaMax.set(null);
    this.unidad.set('');
    this.orden.set('relevancia');
  }

  years(w: PublicWorkerDto): number {
    return Number(w.anios_experiencia ?? w['años_experiencia'] ?? 0) || 0;
  }

  /** "8 eventos, 12 años de experiencia" o "Nuevo en Orquesta, 3 años de experiencia". */
  trackRecord(w: PublicWorkerDto): string {
    const n = w.eventos_completados;
    const ev = n === 0 ? 'Nuevo en Orquesta' : `${n} ${n === 1 ? 'evento' : 'eventos'} con Orquesta`;
    const y = this.years(w);
    return y ? `${ev}, ${y} años de experiencia` : ev;
  }

  initials(name: string): string {
    return name
      .split(/\s+/)
      .filter((p) => /^[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(p))
      .slice(0, 2)
      .map((p) => p[0].toUpperCase())
      .join('');
  }

  tone(w: PublicWorkerDto): string {
    return COVER_TONE[w.categorias[0] ?? ''] ?? 'olive';
  }

  // --- Ficha del proveedor -------------------------------------------------------------

  async open(w: PublicWorkerDto, ev: Event): Promise<void> {
    this.lastTrigger = ev.currentTarget as HTMLElement;
    this.selected.set(w);
    this.busy.set(null);
    this.hireError.set(null);
    this.hireDone.set(null);
    this.hireRol.set(this.categoria() && w.categorias.includes(this.categoria()) ? this.categoria() : w.categorias[0] ?? '');
    this.hirePlazas.set(1);
    this.setHireEvento(this.eventoId() || this.events()[0]?.id || '');
    setTimeout(() => this.drawer()?.nativeElement.focus(), 0);
  }

  close(): void {
    this.selected.set(null);
    this.lastTrigger?.focus();
  }

  onDrawerKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') this.close();
  }

  setHireEvento(id: string): void {
    this.hireEvento.set(id);
    const e = this.events().find((x) => x.id === id);
    this.hireInicio.set(toLocalInput(e?.ventana.inicio));
    this.hireFin.set(toLocalInput(e?.ventana.fin));
    this.hireLlegada.set(toLocalInput(e?.ventana.inicio));
    void this.loadBusy();
  }

  private async loadBusy(): Promise<void> {
    const w = this.selected();
    const e = this.events().find((x) => x.id === this.hireEvento());
    if (!w || !e) {
      this.busy.set(null);
      return;
    }
    try {
      this.busy.set(
        await this.api.get<WorkerAvailabilityOccupiedResponse>(
          `/v1/workers/${encodeURIComponent(w.worker_id)}/availability`,
          { params: { desde: e.ventana.inicio, hasta: e.ventana.fin } },
        ),
      );
    } catch {
      this.busy.set(null);
    }
  }

  async hire(): Promise<void> {
    const w = this.selected();
    const eventId = this.hireEvento();
    if (!w || !eventId || this.hiring()) return;
    const inicio = toIso(this.hireInicio());
    const fin = toIso(this.hireFin());
    const llegada = toIso(this.hireLlegada());
    if (!inicio || !fin || !llegada || fin <= inicio || llegada < inicio || llegada >= fin) {
      this.hireError.set('Revisa el horario: la llegada debe estar entre el inicio y el término.');
      return;
    }
    this.hiring.set(true);
    this.hireError.set(null);
    try {
      const res = await this.api.post<WorkerRequestItemDto>(
        `/v1/events/${encodeURIComponent(eventId)}/worker-requests`,
        {
          worker_id: w.worker_id,
          rol: this.hireRol(),
          plazas: Math.max(1, Math.min(Number(this.hirePlazas()) || 1, w.plazas_ofrecidas ?? 1)),
          ventana: { inicio, fin },
          hora_llegada: llegada,
        },
      );
      this.hireDone.set({
        eventId,
        texto: `Le enviamos tu solicitud a ${w.nombre_publico}. El precio queda fijo en ${precio(res.costo_congelado)}; te avisaremos cuando responda.`,
      });
    } catch (err) {
      this.hireError.set(
        err instanceof OrquestaApiError
          ? /disponibilidad/i.test(err.message)
            ? 'Este proveedor no marcó disponibilidad que cubra todo ese horario para ese puesto. Prueba un horario más corto o con otro proveedor.'
            : err.message
          : 'No pudimos enviar la solicitud.',
      );
    } finally {
      this.hiring.set(false);
    }
  }
}
