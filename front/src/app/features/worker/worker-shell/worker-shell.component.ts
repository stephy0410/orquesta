import { CommonModule } from '@angular/common';
import { Component, DestroyRef, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { ApiService } from '../../../core/api/api.service';
import { WorkerProfileStatusResponse } from '../../../core/api/models';
import { AuthService } from '../../../core/auth/auth.service';

@Component({
  selector: 'app-worker-shell',
  standalone: true,
  imports: [CommonModule, RouterOutlet, RouterLink, RouterLinkActive],
  styles: [`.ws-visibility { margin-bottom: 1.25rem; } .ws-visibility a { margin-left: 0.4rem; }`],
  template: `
    <a class="oq-skip-link" href="#contenido">Saltar al contenido</a>
    <header class="oq-topbar">
      <div class="oq-topbar-inner">
        <a class="oq-brand" routerLink="/worker/requests">
          Orquesta <small>para proveedores</small>
        </a>

        <nav class="oq-nav-links oq-topbar-start" aria-label="Navegación del proveedor">
          <a class="oq-nav-link" routerLink="/worker/requests" routerLinkActive="active" ariaCurrentWhenActive="page">Solicitudes</a>
          <a class="oq-nav-link" routerLink="/worker/profile" routerLinkActive="active" ariaCurrentWhenActive="page">Perfil</a>
          <a class="oq-nav-link" routerLink="/worker/availability" routerLinkActive="active" ariaCurrentWhenActive="page">Disponibilidad</a>
        </nav>

        <div class="oq-row oq-topbar-end">
          @if (auth.userEmail()) {
            <span class="oq-hint">{{ auth.userEmail() }}</span>
          }
          <button type="button" class="oq-btn oq-btn-sm oq-btn-secondary" (click)="logout()">
            Cerrar sesión
          </button>
        </div>
      </div>
    </header>

    <main id="contenido" class="oq-container" tabindex="-1">
      @if (missing().length > 0) {
        <div class="oq-alert oq-alert-warning ws-visibility" role="status">
          <strong>Las planners todavía no te ven en la búsqueda.</strong>
          Te falta: {{ missing().join(', ') }}.
          @if (!onProfile()) {
            <a routerLink="/worker/profile">Ir a mi perfil</a>
          }
        </div>
      }
      <router-outlet />
    </main>
  `,
})
export class WorkerShellComponent {
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly api = inject(ApiService);

  /** Lo que le falta al proveedor para aparecer en la búsqueda (perfil, verificaciones, publicar). */
  readonly missing = signal<string[]>([]);
  readonly onProfile = signal(false);

  constructor() {
    const sub = this.router.events
      .pipe(filter((e) => e instanceof NavigationEnd))
      .subscribe(() => void this.checkVisibility());
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
    void this.checkVisibility();
  }

  async checkVisibility(): Promise<void> {
    this.onProfile.set(this.router.url.startsWith('/worker/profile'));
    try {
      const res = await this.api.get<WorkerProfileStatusResponse>('/v1/worker/profile');
      const falta: string[] = [];
      if (!res.perfil) falta.push('crear tu perfil');
      if (!res.verificado?.email) falta.push('verificar tu correo');
      if (!res.verificado?.telefono) falta.push('verificar tu teléfono');
      if (res.perfil && res.perfil.estado !== 'publicado') falta.push('publicar tu perfil');
      this.missing.set(falta);
    } catch {
      // Sin perfil todavía: la página de solicitudes ya muestra la bienvenida.
      this.missing.set([]);
    }
  }

  async logout(): Promise<void> {
    await this.auth.logout();
    await this.router.navigate(['/worker/login']);
  }
}
