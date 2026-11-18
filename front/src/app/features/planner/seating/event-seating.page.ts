import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiService } from '../../../core/api/api.service';
import { OrquestaApiError } from '../../../core/api/api-config';
import {
  GuestDto,
  PaginatedResponse,
  SeatAssignmentResponse,
  TableDto,
  UnseatedGuestDto,
} from '../../../core/api/models';
import { EventSubnavComponent } from '../shared/event-subnav.component';

@Component({
  selector: 'app-event-seating-page',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, EventSubnavComponent],
  templateUrl: './event-seating.page.html',
})
export class EventSeatingPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);

  readonly eventId = signal('');
  readonly tables = signal<TableDto[]>([]);
  readonly unseated = signal<UnseatedGuestDto[]>([]);
  readonly seatedGuests = signal<GuestDto[]>([]);
  readonly guestNamesById = signal<Record<string, string>>({});

  readonly newTableNombre = signal('');
  readonly newTableCapacidad = signal(10);
  readonly selectedTableByGuest = signal<Record<string, string>>({});

  readonly error = signal<string | null>(null);
  readonly success = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    const id = this.route.snapshot.paramMap.get('id') ?? '';
    this.eventId.set(id);
    if (id) {
      await this.refreshAll();
    }
  }

  async refreshAll(): Promise<void> {
    await Promise.all([this.loadTables(), this.loadUnseated(), this.loadGuestsIndex()]);
  }

  async loadTables(): Promise<void> {
    try {
      const res = await this.api.get<PaginatedResponse<TableDto>>(
        `/v1/events/${encodeURIComponent(this.eventId())}/tables`,
        { params: { limit: 100 } },
      );
      this.tables.set(res.items ?? []);
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? `${err.code}: ${err.message}` : 'Error cargando mesas.',
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
        err instanceof OrquestaApiError ? `${err.code}: ${err.message}` : 'Error cargando sin_mesa.',
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
      // Optional enrichment
    }
  }

  async createTable(): Promise<void> {
    if (!this.newTableNombre().trim()) return;
    this.error.set(null);
    this.success.set(null);
    try {
      await this.api.post<TableDto>(
        `/v1/events/${encodeURIComponent(this.eventId())}/tables`,
        {
          nombre: this.newTableNombre().trim(),
          capacidad: Math.max(1, Number(this.newTableCapacidad()) || 1),
        },
      );
      this.newTableNombre.set('');
      this.success.set('Mesa creada.');
      await this.loadTables();
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? `${err.code}: ${err.message}` : 'No se pudo crear mesa.',
      );
    }
  }

  setTargetTable(guestId: string, tableId: string): void {
    this.selectedTableByGuest.update((curr) => ({ ...curr, [guestId]: tableId }));
  }

  async assignSeat(guestId: string, explicitTableId?: string): Promise<void> {
    const tableId = explicitTableId ?? this.selectedTableByGuest()[guestId] ?? this.tables()[0]?.id;
    if (!tableId) {
      this.error.set('Crea o selecciona una mesa primero.');
      return;
    }

    this.error.set(null);
    this.success.set(null);
    try {
      const res = await this.api.post<SeatAssignmentResponse>(
        `/v1/events/${encodeURIComponent(this.eventId())}/seat-assignments`,
        { guest_id: guestId, table_id: tableId },
      );
      this.success.set(`Asiento ${res.estado} para ${this.guestNamesById()[guestId] ?? guestId}.`);
      await this.refreshAll();
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError
          ? `${err.code}: ${err.message}`
          : 'No se pudo asignar el asiento.',
      );
    }
  }

  async releaseSeat(guestId: string): Promise<void> {
    this.error.set(null);
    this.success.set(null);
    try {
      await this.api.delete(
        `/v1/events/${encodeURIComponent(this.eventId())}/seat-assignments/${encodeURIComponent(guestId)}`,
      );
      this.success.set('Asiento liberado y capacidad devuelta a la mesa.');
      await this.refreshAll();
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? `${err.code}: ${err.message}` : 'Error liberando asiento.',
      );
    }
  }
}
