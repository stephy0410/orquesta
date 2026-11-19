import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiService } from '../../../core/api/api.service';
import { OrquestaApiError } from '../../../core/api/api-config';
import {
  GuestDto,
  PaginatedResponse,
  SeatAssignmentResponse,
  TableDto,
  TableListResponse,
  UnseatedGuestDto,
} from '../../../core/api/models';
import { EventSubnavComponent } from '../shared/event-subnav.component';

export const SEATING_CONFLICT_MESSAGE =
  'Otra persona modificó el plano de mesas. Cargamos sus cambios; revisa y vuelve a intentarlo.';

/**
 * Acomodo de mesas (FR7) con control de versión optimista.
 * Cada edición manda `If-Match: "<plan_version>"`; si alguien más cambió el plano, el backend
 * responde 409 SEATING_VERSION_CONFLICT sin sobrescribir nada y aquí se avisa y se recarga,
 * conservando las mesas que la persona ya había elegido en los selectores.
 */
@Component({
  selector: 'app-event-seating-page',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, EventSubnavComponent],
  templateUrl: './event-seating.page.html',
  styleUrl: './event-seating.page.scss',
})
export class EventSeatingPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);

  readonly eventId = signal('');
  readonly tables = signal<TableDto[]>([]);
  readonly unseated = signal<UnseatedGuestDto[]>([]);
  readonly seatedGuests = signal<GuestDto[]>([]);
  readonly guestNamesById = signal<Record<string, string>>({});

  /** Versión del plano que leyó esta pestaña; null mientras no se haya cargado. */
  readonly planVersion = signal<number | null>(null);

  readonly newTableNombre = signal('');
  readonly newTableCapacidad = signal(10);
  readonly selectedTableByGuest = signal<Record<string, string>>({});
  readonly busy = signal(false);

  readonly error = signal<string | null>(null);
  readonly success = signal<string | null>(null);
  readonly conflict = signal<string | null>(null);


  /** Todos los que no declinaron necesitan mesa: la invitación se envía hasta tenerla. */
  readonly porSentar = computed(() => this.unseated().filter((u) => u.estado_rsvp !== 'declina'));
  readonly noVienen = computed(() => this.unseated().filter((u) => u.estado_rsvp === 'declina').length);

  readonly seatedByTable = computed(() => {
    const byId: Record<string, GuestDto[]> = {};
    const byName: Record<string, string> = {};
    for (const t of this.tables()) byName[this.tableLabel(t)] = t.id;
    for (const g of this.seatedGuests()) {
      const tid = g.table_id ?? byName[String(g.mesa ?? '')] ?? '';
      if (!tid) continue;
      (byId[tid] ??= []).push(g);
    }
    return byId;
  });

  readonly tableNameById = computed(() => {
    const map: Record<string, string> = {};
    for (const t of this.tables()) map[t.id] = this.tableLabel(t);
    return map;
  });

  async ngOnInit(): Promise<void> {
    const id = this.route.snapshot.paramMap.get('id') ?? '';
    this.eventId.set(id);
    if (id) {
      await this.refreshAll();
    }
  }

  rsvpLabel(estado: string | null | undefined): string {
    if (estado === 'confirma') return 'Confirmó';
    if (estado === 'declina') return 'Declinó';
    return 'Sin respuesta';
  }

  tableLabel(t: TableDto): string {
    // El número es lo que ve el escáner en la puerta, así que siempre va al frente.
    const num = t.numero ? `Mesa ${t.numero}` : 'Mesa';
    return t.nombre && !/^mesa\b/i.test(t.nombre.trim()) ? `${num} · ${t.nombre}` : t.nombre?.trim() || num;
  }

  async refreshAll(): Promise<void> {
    await Promise.all([this.loadTables(), this.loadUnseated(), this.loadGuestsIndex()]);
  }

  async loadTables(): Promise<void> {
    try {
      const res = await this.api.get<TableListResponse>(
        `/v1/events/${encodeURIComponent(this.eventId())}/tables`,
        { params: { limit: 100 } },
      );
      this.tables.set(res.items ?? []);
      this.rememberVersion(res.plan_version);
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? err.message : 'No pudimos cargar las mesas. Recarga la página.',
      );
    }
  }

  async loadUnseated(): Promise<void> {
    try {
      const res = await this.api.get<PaginatedResponse<UnseatedGuestDto>>(
        `/v1/events/${encodeURIComponent(this.eventId())}/seat-assignments/unseated`,
        { params: { limit: 100 } },
      );
      this.unseated.set(res.items ?? []);
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError
          ? err.message
          : 'No pudimos cargar a los invitados sin mesa. Recarga la página.',
      );
    }
  }

  async loadGuestsIndex(): Promise<void> {
    try {
      const res = await this.api.get<PaginatedResponse<GuestDto>>(
        `/v1/events/${encodeURIComponent(this.eventId())}/guests`,
        { params: { limit: 100 } },
      );
      const map: Record<string, string> = {};
      const seated: GuestDto[] = [];
      for (const g of res.items ?? []) {
        const gid = g.guest_id ?? g.id ?? '';
        if (gid) map[gid] = g.nombre;
        if (g.table_id || g.mesa) seated.push(g);
      }
      this.guestNamesById.set(map);
      this.seatedGuests.set(seated);
    } catch {
      // Enriquecimiento opcional
    }
  }

  async createTable(): Promise<void> {
    const nombre = this.newTableNombre().trim();
    if (!nombre) {
      this.error.set('Escribe el nombre o número de la mesa.');
      return;
    }
    await this.mutate(async () => {
      const created = await this.api.post<TableDto>(
        `/v1/events/${encodeURIComponent(this.eventId())}/tables`,
        { nombre, capacidad: Math.max(1, Number(this.newTableCapacidad()) || 1) },
        { headers: this.ifMatchHeaders() },
      );
      this.rememberVersion(created.plan_version);
      this.newTableNombre.set('');
      this.success.set(`Mesa “${nombre}” creada.`);
      await this.loadTables();
    }, 'No se pudo crear la mesa.');
  }

  setTargetTable(guestId: string, tableId: string): void {
    this.selectedTableByGuest.update((curr) => ({ ...curr, [guestId]: tableId }));
  }

  async assignSeat(guestId: string, explicitTableId?: string): Promise<void> {
    const tableId = explicitTableId ?? this.selectedTableByGuest()[guestId] ?? this.tables()[0]?.id;
    if (!tableId) {
      this.error.set('Crea una mesa antes de asignar invitados.');
      return;
    }
    const nombre = this.guestNamesById()[guestId] ?? 'el invitado';
    await this.mutate(async () => {
      const res = await this.api.post<SeatAssignmentResponse>(
        `/v1/events/${encodeURIComponent(this.eventId())}/seat-assignments`,
        { guest_id: guestId, table_id: tableId },
        { headers: this.ifMatchHeaders() },
      );
      this.rememberVersion(res.plan_version);
      this.success.set(`${nombre} quedó en ${this.tableNameById()[tableId] ?? 'la mesa elegida'}.`);
      this.clearSelection(guestId);
      await this.refreshAll();
    }, 'No se pudo asignar el lugar.');
  }

  async releaseSeat(guestId: string): Promise<void> {
    const nombre = this.guestNamesById()[guestId] ?? 'El invitado';
    await this.mutate(async () => {
      // 204 sin cuerpo: la versión nueva llega al recargar las mesas.
      await this.api.delete(
        `/v1/events/${encodeURIComponent(this.eventId())}/seat-assignments/${encodeURIComponent(guestId)}`,
        { headers: this.ifMatchHeaders() },
      );
      this.success.set(`${nombre} ya no tiene mesa; su lugar quedó libre.`);
      await this.refreshAll();
    }, 'No se pudo liberar el lugar.');
  }

  /** Cabecera If-Match con la versión que vio esta pestaña (formato ETag fuerte). */
  ifMatchHeaders(): Record<string, string> {
    const v = this.planVersion();
    return v === null ? {} : { 'If-Match': `"${v}"` };
  }

  private rememberVersion(v: number | undefined | null): void {
    if (typeof v === 'number' && Number.isInteger(v)) {
      this.planVersion.set(v);
    }
  }

  private clearSelection(guestId: string): void {
    this.selectedTableByGuest.update((curr) => {
      const next = { ...curr };
      delete next[guestId];
      return next;
    });
  }

  private async mutate(action: () => Promise<void>, fallback: string): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    this.success.set(null);
    this.conflict.set(null);
    try {
      await action();
    } catch (err) {
      if (err instanceof OrquestaApiError && err.code === 'SEATING_VERSION_CONFLICT') {
        await this.handleConflict(err);
      } else {
        this.error.set(err instanceof OrquestaApiError ? err.message : fallback);
      }
    } finally {
      this.busy.set(false);
    }
  }

  private async handleConflict(err: OrquestaApiError): Promise<void> {
    this.conflict.set(SEATING_CONFLICT_MESSAGE);
    const actual = err.details?.['version_actual'];
    this.rememberVersion(typeof actual === 'number' ? actual : null);
    // selectedTableByGuest se conserva: la elección de la persona sobrevive a la recarga.
    await this.refreshAll();
  }
}
