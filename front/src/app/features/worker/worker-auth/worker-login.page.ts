import { CommonModule } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { OrquestaApiError } from '../../../core/api/api-config';
import { BanquetArtComponent } from '../../../shared/ui/banquet-art.component';
import { AuthService } from '../../../core/auth/auth.service';

@Component({
  selector: 'app-worker-login-page',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, BanquetArtComponent],
  template: `
    <header class="oq-topbar">
      <div class="oq-topbar-inner">
        <a class="oq-brand" routerLink="/">
          Orquesta <small>para proveedores</small>
        </a>
        <nav class="oq-nav-links oq-topbar-end" aria-label="Accesos">
          <a class="oq-nav-link" routerLink="/planner/login">Soy planner</a>
          <a class="oq-nav-link" routerLink="/scan">Escáner</a>
        </nav>
      </div>
    </header>

    <a class="oq-skip-link" href="#contenido">Saltar al contenido</a>
    <main id="contenido" class="oq-auth" tabindex="-1">
      <div class="oq-auth-form">
      <section class="oq-card">
        <h1>Entra como proveedor</h1>
        <p class="oq-page-subtitle">
          Administra tu perfil contratable, ventanas de disponibilidad, solicitudes y pagos.
        </p>

        @if (error()) {
          <div class="oq-alert oq-alert-error">{{ error() }}</div>
        }

        <form class="oq-form-grid" (ngSubmit)="submit()">
          <div class="oq-field">
            <label class="oq-label" for="workerEmail">Correo electrónico</label>
            <input
              id="workerEmail"
              name="email"
              class="oq-input"
              type="email"
              required
              [ngModel]="email()"
              (ngModelChange)="email.set($event)"
            />
          </div>

          <div class="oq-field">
            <label class="oq-label" for="workerPassword">Contraseña</label>
            <input
              id="workerPassword"
              name="password"
              class="oq-input"
              type="password"
              required
              [ngModel]="password()"
              (ngModelChange)="password.set($event)"
            />
          </div>

          <button type="submit" class="oq-btn oq-btn-primary oq-btn-lg" [disabled]="loading()">
            {{ loading() ? 'Ingresando...' : 'Entrar' }}
          </button>
        </form>

        <p class="oq-hint" style="margin-top: 1rem">
          ¿Aún no tienes cuenta de trabajador?
          <a routerLink="/worker/register">Regístrate aquí</a>
        </p>
      </section>
      </div>
      <aside class="oq-auth-art" aria-hidden="true">
        <app-banquet-art stroke="#f5f2e8" />
        <blockquote>Las solicitudes llegan a tu celular, también las urgentes.</blockquote>
      </aside>
    </main>
  `,
})
export class WorkerLoginPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly email = signal('');
  readonly password = signal('');
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  async submit(): Promise<void> {
    if (this.loading()) return;
    this.loading.set(true);
    this.error.set(null);
    try {
      await this.auth.login(this.email().trim(), this.password(), 'worker');
      const redirect = this.route.snapshot.queryParamMap.get('redirect') || '/worker/requests';
      await this.router.navigateByUrl(redirect);
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? `${err.code}: ${err.message}` : 'Credenciales inválidas.',
      );
    } finally {
      this.loading.set(false);
    }
  }
}
