import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiService } from '../../../core/api/api.service';
import { OrquestaApiError } from '../../../core/api/api-config';
import {
  COMMON_TIMEZONES,
  EventDto,
  EventRequirementDto,
  PaginatedResponse,
  VenueDto,
  WORKER_CATEGORIES,
  WORKER_ZONES,
} from '../../../core/api/models';

@Component({
  selector: 'app-event-create-page',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './event-create.page.html',
})
export class EventCreatePage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);

  readonly timezones = COMMON_TIMEZONES;
  readonly zones = WORKER_ZONES;
  readonly roles = WORKER_CATEGORIES;

  readonly venues = signal<VenueDto[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  // Event fields
  readonly nombre = signal('');
  readonly fecha = signal('');
  readonly timezone = signal('America/Mexico_City');
  readonly customTimezone = signal('');
  readonly ventanaInicio = signal('');
  readonly ventanaFin = signal('');
  readonly venueId = signal('');
  readonly aforo = signal(200);
  readonly requerimientos = signal<EventRequirementDto[]>([{ rol: 'mesero', cantidad: 4 }]);

  // Inline venue creator
  readonly showNewVenue = signal(false);
  readonly venueNombre = signal('');
  readonly venueZona = signal('sur');
  readonly venueDireccion = signal('');

  async ngOnInit(): Promise<void> {
    await this.loadVenues();
  }

  async loadVenues(): Promise<void> {
    try {
      const res = await this.api.get<PaginatedResponse<VenueDto>>('/v1/venues', {
        params: { limit: 100 },
      });
      const list = res.items ?? [];
      this.venues.set(list);
      if (list.length > 0 && !this.venueId()) {
        this.venueId.set(list[0].id);
      } else if (list.length === 0) {
        this.showNewVenue.set(true);
      }
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? `${err.code}: ${err.message}` : 'Error cargando venues.',
      );
    }
  }

  async createVenue(): Promise<void> {
    this.error.set(null);
    if (!this.venueNombre().trim() || !this.venueDireccion().trim()) {
      this.error.set('Nombre y dirección del venue son obligatorios.');
      return;
    }
    try {
      const created = await this.api.post<VenueDto>('/v1/venues', {
        nombre: this.venueNombre().trim(),
        zona: this.venueZona(),
        direccion: this.venueDireccion().trim(),
      });
      this.venues.update((curr) => [created, ...curr]);
      this.venueId.set(created.id);
      this.venueNombre.set('');
      this.venueDireccion.set('');
      this.showNewVenue.set(false);
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? `${err.code}: ${err.message}` : 'No se pudo crear venue.',
      );
    }
  }

  addRequirement(): void {
    this.requerimientos.update((curr) => [...curr, { rol: 'staff_checkin', cantidad: 1 }]);
  }

  removeRequirement(idx: number): void {
    this.requerimientos.update((curr) => curr.filter((_, i) => i !== idx));
  }

  updateRequirement(idx: number, field: 'rol' | 'cantidad', value: string | number): void {
    this.requerimientos.update((curr) =>
      curr.map((item, i) =>
        i === idx
          ? {
              ...item,
              [field]: field === 'cantidad' ? Math.max(1, Number(value) || 1) : String(value),
            }
          : item,
      ),
    );
  }

  async createEvent(): Promise<void> {
    if (this.loading()) return;
    this.error.set(null);

    const tz = (this.customTimezone().trim() || this.timezone()).trim();
    const inicioIso = toIso(this.ventanaInicio());
    const finIso = toIso(this.ventanaFin());

    if (!this.nombre().trim() || !this.fecha() || !tz || !this.venueId() || !inicioIso || !finIso) {
      this.error.set('Nombre, fecha, zona horaria IANA, venue y ventana son obligatorios.');
      return;
    }

    this.loading.set(true);
    try {
      const created = await this.api.post<EventDto>('/v1/events', {
        nombre: this.nombre().trim(),
        fecha: this.fecha(),
        timezone: tz,
        ventana: { inicio: inicioIso, fin: finIso },
        venue_id: this.venueId(),
        aforo: Math.max(1, Number(this.aforo()) || 1),
        requerimientos: this.requerimientos(),
      });
      await this.router.navigate(['/planner/events', created.id]);
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError
          ? `${err.code}: ${err.message}`
          : 'No se pudo crear el evento.',
      );
    } finally {
      this.loading.set(false);
    }
  }
}

function toIso(val: string): string | null {
  if (!val) return null;
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
