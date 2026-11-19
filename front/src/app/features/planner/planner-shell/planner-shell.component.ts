import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from '../../../core/auth/auth.service';
import { ConnectivityService } from '../../../core/connectivity/connectivity.service';

@Component({
  selector: 'app-planner-shell',
  standalone: true,
  imports: [CommonModule, RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <a class="oq-skip-link" href="#contenido">Saltar al contenido</a>
    <header class="oq-topbar">
      <div class="oq-topbar-inner">
        <a class="oq-brand" routerLink="/planner/dashboard">
          Orquesta <small>para planners</small>
        </a>

        <nav class="oq-nav-links oq-topbar-start" aria-label="Navegación del planner">
          <a class="oq-nav-link" routerLink="/planner/dashboard" routerLinkActive="active" ariaCurrentWhenActive="page">
            Tablero en vivo
          </a>
          <a class="oq-nav-link" routerLink="/planner/proveedores" routerLinkActive="active" ariaCurrentWhenActive="page">
            Proveedores
          </a>
          <a class="oq-nav-link" routerLink="/planner/events/new" routerLinkActive="active" ariaCurrentWhenActive="page">
            Nuevo evento
          </a>
          <a class="oq-nav-link" routerLink="/scan" routerLinkActive="active" ariaCurrentWhenActive="page">
            Escáner
          </a>
        </nav>

        <div class="oq-row oq-topbar-end">
          <span
            class="oq-badge"
            role="status"
            [class.oq-badge-success]="connectivity.isOnline()"
            [class.oq-badge-danger]="!connectivity.isOnline()"
          >
            {{ connectivity.isOnline() ? 'En línea' : 'Sin conexión' }}
          </span>
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
      <router-outlet />
    </main>
  `,
})
export class PlannerShellComponent {
  readonly auth = inject(AuthService);
  readonly connectivity = inject(ConnectivityService);
  private readonly router = inject(Router);

  async logout(): Promise<void> {
    await this.auth.logout();
    await this.router.navigate(['/planner/login']);
  }
}
