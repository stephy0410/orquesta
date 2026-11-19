import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../../core/api/api.service';
import { OrquestaApiError } from '../../../core/api/api-config';
import { formatFecha, humanize } from '../../../shared/labels';
import {
  AvailabilityWindowDto,
  ROLES_CATALOGO,
  WORKER_ZONES,
} from '../../../core/api/models';

@Component({
  selector: 'app-worker-availability-page',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './worker-availability.page.html',
})
export class WorkerAvailabilityPage implements OnInit {
  private readonly api = inject(ApiService);

  readonly label = humanize;
  readonly formatFecha = formatFecha;
  /** Solo los puestos y zonas del perfil: no tiene sentido ofrecer lo que el proveedor no hace. */
  readonly allRoles = signal<readonly string[]>(ROLES_CATALOGO);
  readonly allZones = signal<readonly string[]>(WORKER_ZONES);
  readonly noProfile = signal(false);

  readonly windows = signal<AvailabilityWindowDto[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly success = signal<string | null>(null);

  readonly editingId = signal<string | null>(null);
  readonly inicio = signal<string>('');
  readonly fin = signal<string>('');
  readonly zona = signal<string>('sur');
  readonly rol = signal<string>('mesero');

  async ngOnInit(): Promise<void> {
    await this.loadProfileOptions();
    if (!this.noProfile()) await this.loadWindows();
  }

  async loadProfileOptions(): Promise<void> {
    try {
      const res = await this.api.get<{ perfil: { categorias: string[]; zonas: string[] } | null }>(
        '/v1/worker/profile',
      );
      const p = res.perfil;
      if (!p) {
        this.noProfile.set(true);
        return;
      }
      if (p.categorias?.length) {
        this.allRoles.set(p.categorias);
        this.rol.set(p.categorias.length > 1 ? '*' : p.categorias[0]);
      }
      if (p.zonas?.length) {
        this.allZones.set(p.zonas);
        this.zona.set(p.zonas.length > 1 ? '*' : p.zonas[0]);
      }
    } catch (err) {
      if (err instanceof OrquestaApiError && err.status === 404) this.noProfile.set(true);
    }
  }

  async loadWindows(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await this.api.get<{ items: AvailabilityWindowDto[] }>('/v1/worker/availability');
      this.windows.set(res.items ?? []);
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? err.message : 'Error cargando ventanas.',
      );
    } finally {
      this.loading.set(false);
    }
  }

  startEdit(w: AvailabilityWindowDto): void {
    this.editingId.set(w.window_id);
    this.inicio.set(toLocalDatetimeInput(w.inicio));
    this.fin.set(toLocalDatetimeInput(w.fin));
    this.zona.set(w.zona);
    this.rol.set(w.rol);
  }

  cancelEdit(): void {
    this.editingId.set(null);
    this.inicio.set('');
    this.fin.set('');
  }

  async saveWindow(): Promise<void> {
    this.error.set(null);
    this.success.set(null);

    const inicioIso = toIsoString(this.inicio());
    const finIso = toIsoString(this.fin());
    if (!inicioIso || !finIso) {
      this.error.set('Revisa el horario: la hora de término debe ser después de la de inicio.');
      return;
    }

    const body = {
      inicio: inicioIso,
      fin: finIso,
      zona: this.zona(),
      rol: this.rol(),
    };

    try {
      const editId = this.editingId();
      if (editId) {
        await this.api.patch(`/v1/worker/availability/${encodeURIComponent(editId)}`, body);
        this.success.set('Horario actualizado.');
        this.cancelEdit();
      } else {
        // "Todos mis puestos / zonas" crea un horario por combinación: así cualquier planner puede contratarte.
        const roles = body.rol === '*' ? [...this.allRoles()] : [body.rol];
        const zonas = body.zona === '*' ? [...this.allZones()] : [body.zona];
        for (const rol of roles) {
          for (const zona of zonas) {
            await this.api.post('/v1/worker/availability', { ...body, rol, zona });
          }
        }
        this.success.set('Horario agregado.');
        this.inicio.set('');
        this.fin.set('');
      }
      await this.loadWindows();
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? err.message : 'No se pudo guardar.',
      );
    }
  }

  async deleteWindow(windowId: string): Promise<void> {
    this.error.set(null);
    this.success.set(null);
    try {
      await this.api.delete(`/v1/worker/availability/${encodeURIComponent(windowId)}`);
      this.success.set('Horario quitado.');
      await this.loadWindows();
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? err.message : 'No se pudo eliminar.',
      );
    }
  }
}

function toIsoString(localInput: string): string | null {
  if (!localInput) return null;
  const d = new Date(localInput);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toLocalDatetimeInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
