import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from '../../../core/auth/auth.service';

@Component({
  selector: 'app-worker-shell',
  standalone: true,
  imports: [CommonModule, RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <a class="oq-skip-link" href="#contenido">Saltar al contenido</a>
    <header class="oq-topbar">
      <div class="oq-topbar-inner">
        <a class="oq-brand" routerLink="/worker/requests">
          Orquesta <small>para proveedores</small>
        </a>

        <nav class="oq-nav-links" aria-label="Navegación del proveedor">
          <a class="oq-nav-link" routerLink="/worker/requests" routerLinkActive="active" ariaCurrentWhenActive="page">Solicitudes</a>
          <a class="oq-nav-link" routerLink="/worker/profile" routerLinkActive="active" ariaCurrentWhenActive="page">Perfil</a>
          <a class="oq-nav-link" routerLink="/worker/availability" routerLinkActive="active" ariaCurrentWhenActive="page">Disponibilidad</a>
          <a class="oq-nav-link" routerLink="/scan">Escáner</a>
        </nav>

        <div class="oq-row">
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
export class WorkerShellComponent {
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  async logout(): Promise<void> {
    await this.auth.logout();
    await this.router.navigate(['/worker/login']);
  }
}
