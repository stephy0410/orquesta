import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from '../../../core/auth/auth.service';

@Component({
  selector: 'app-worker-shell',
  standalone: true,
  imports: [CommonModule, RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <header class="oq-topbar">
      <div class="oq-topbar-inner">
        <a class="oq-brand" routerLink="/worker/requests">
          <img src="icons/orquesta-icon.svg" alt="Orquesta" width="28" height="28" />
          <span>Orquesta · Trabajador</span>
        </a>

        <nav class="oq-nav-links" aria-label="Navegación de trabajador">
          <a class="oq-nav-link" routerLink="/worker/requests" routerLinkActive="active">Solicitudes</a>
          <a class="oq-nav-link" routerLink="/worker/profile" routerLinkActive="active">Perfil y OTP</a>
          <a class="oq-nav-link" routerLink="/worker/availability" routerLinkActive="active">Disponibilidad</a>
          <a class="oq-nav-link" routerLink="/scan">Escáner QR</a>
        </nav>

        <div class="oq-row">
          @if (auth.userEmail()) {
            <span class="oq-hint mono" style="color: #cbd5e1">{{ auth.userEmail() }}</span>
          }
          <button type="button" class="oq-btn oq-btn-sm oq-btn-secondary" (click)="logout()">
            Salir
          </button>
        </div>
      </div>
    </header>

    <main class="oq-container">
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
