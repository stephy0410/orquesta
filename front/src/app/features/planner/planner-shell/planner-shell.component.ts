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
    <header class="oq-topbar">
      <div class="oq-topbar-inner">
        <a class="oq-brand" routerLink="/planner/dashboard">
          <img src="icons/orquesta-icon.svg" alt="Orquesta" width="28" height="28" />
          <span>Orquesta · Planner</span>
        </a>

        <nav class="oq-nav-links" aria-label="Navegación del planner">
          <a class="oq-nav-link" routerLink="/planner/dashboard" routerLinkActive="active">
            Tablero en vivo
          </a>
          <a class="oq-nav-link" routerLink="/planner/events/new" routerLinkActive="active">
            Nuevo evento
          </a>
          <a class="oq-nav-link" routerLink="/scan" routerLinkActive="active">
            Escáner PWA
          </a>
        </nav>

        <div class="oq-row">
          <span
            class="oq-badge"
            [class.oq-badge-success]="connectivity.isOnline()"
            [class.oq-badge-danger]="!connectivity.isOnline()"
          >
            {{ connectivity.isOnline() ? 'API OK' : 'Offline' }}
          </span>
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
export class PlannerShellComponent {
  readonly auth = inject(AuthService);
  readonly connectivity = inject(ConnectivityService);
  private readonly router = inject(Router);

  async logout(): Promise<void> {
    await this.auth.logout();
    await this.router.navigate(['/planner/login']);
  }
}
