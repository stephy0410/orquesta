import { CommonModule } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { OrquestaApiError } from '../../../core/api/api-config';
import { TablescapeArtComponent } from '../../../shared/ui/tablescape-art.component';
import { AuthService } from '../../../core/auth/auth.service';

@Component({
  selector: 'app-planner-login-page',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, TablescapeArtComponent],
  template: `
    <header class="oq-topbar">
      <div class="oq-topbar-inner">
        <a class="oq-brand" routerLink="/">
          Orquesta <small>para planners</small>
        </a>
        <nav class="oq-nav-links oq-topbar-end" aria-label="Accesos">
          <a class="oq-nav-link" routerLink="/worker/login">Soy proveedor</a>
          <a class="oq-nav-link" routerLink="/scan">Escáner</a>
        </nav>
      </div>
    </header>

    <a class="oq-skip-link" href="#contenido">Saltar al contenido</a>
    <main id="contenido" class="oq-auth" tabindex="-1">
      <div class="oq-auth-form">
      <section class="oq-card">
        <h1>Entra a tu consola</h1>
        <p class="oq-page-subtitle">
          Usa el correo y la contraseña con los que verificaste tu cuenta.
        </p>

        @if (error()) {
          <div class="oq-alert oq-alert-error">{{ error() }}</div>
        }
        @if (info()) {
          <div class="oq-alert oq-alert-success">{{ info() }}</div>
        }

        <form class="oq-form-grid" (ngSubmit)="submit()">
          <div class="oq-field">
            <label class="oq-label" for="plannerEmail">Correo electrónico</label>
            <input
              id="plannerEmail"
              name="email"
              class="oq-input"
              type="email"
              required
              [ngModel]="email()"
              (ngModelChange)="email.set($event)"
            />
          </div>

          <div class="oq-field">
            <label class="oq-label" for="plannerPass">Contraseña</label>
            <input
              id="plannerPass"
              name="password"
              class="oq-input"
              type="password"
              required
              [ngModel]="password()"
              (ngModelChange)="password.set($event)"
            />
          </div>

          <button type="submit" class="oq-btn oq-btn-primary oq-btn-lg" [disabled]="loading()">
            {{ loading() ? 'Ingresando...' : 'Iniciar sesión' }}
          </button>
        </form>

        <div class="oq-between" style="margin-top: 1rem">
          <a routerLink="/planner/register">Crear cuenta de planner</a>
          <button
            type="button"
            class="oq-btn oq-btn-secondary oq-btn-sm"
            (click)="showReset.set(!showReset())"
          >
            Recuperar contraseña
          </button>
        </div>

        @if (showReset()) {
          <hr style="margin: 1.25rem 0; border: none; border-top: 1px solid var(--oq-border)" />
          <h3>Recuperación por email</h3>
          <div class="oq-form-grid">
            <div class="oq-row">
              <input
                class="oq-input"
                style="flex: 1 1 200px"
                type="email"
                placeholder="Tu email registrado"
                [ngModel]="resetEmail()"
                (ngModelChange)="resetEmail.set($event)"
              />
              <button type="button" class="oq-btn oq-btn-secondary" (click)="sendReset()">
                Solicitar enlace
              </button>
            </div>
            <div class="oq-row">
              <input
                class="oq-input mono"
                style="flex: 1 1 150px"
                placeholder="Token de recuperación"
                [ngModel]="resetToken()"
                (ngModelChange)="resetToken.set($event)"
              />
              <input
                class="oq-input"
                style="flex: 1 1 150px"
                type="password"
                placeholder="Nueva contraseña"
                [ngModel]="resetNewPassword()"
                (ngModelChange)="resetNewPassword.set($event)"
              />
              <button type="button" class="oq-btn oq-btn-accent" (click)="confirmReset()">
                Confirmar
              </button>
            </div>
          </div>
        }
      </section>
      </div>
      <aside class="oq-auth-art" aria-hidden="true">
        <app-tablescape-art stroke="#f5f2e8" fill="#56602a" />
        <blockquote>Tres eventos el mismo sábado, una sola pantalla.</blockquote>
      </aside>
    </main>
  `,
})
export class PlannerLoginPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly email = signal('');
  readonly password = signal('');
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly info = signal<string | null>(null);

  readonly showReset = signal(false);
  readonly resetEmail = signal('');
  readonly resetToken = signal('');
  readonly resetNewPassword = signal('');

  async submit(): Promise<void> {
    if (this.loading()) return;
    this.loading.set(true);
    this.error.set(null);
    this.info.set(null);

    try {
      await this.auth.login(this.email().trim(), this.password(), 'planner');
      const redirect = this.route.snapshot.queryParamMap.get('redirect') || '/planner/dashboard';
      await this.router.navigateByUrl(redirect);
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? `${err.code}: ${err.message}` : 'Credenciales inválidas.',
      );
    } finally {
      this.loading.set(false);
    }
  }

  async sendReset(): Promise<void> {
    if (!this.resetEmail().trim()) return;
    this.error.set(null);
    try {
      await this.auth.requestPasswordReset(this.resetEmail().trim());
      this.info.set('Si el correo existe, enviamos instrucciones de recuperación.');
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? `${err.code}: ${err.message}` : 'Error solicitando reset.',
      );
    }
  }

  async confirmReset(): Promise<void> {
    if (!this.resetToken().trim() || !this.resetNewPassword()) return;
    this.error.set(null);
    try {
      await this.auth.confirmPasswordReset(this.resetToken().trim(), this.resetNewPassword());
      this.info.set('Contraseña actualizada. Ya puedes iniciar sesión.');
      this.showReset.set(false);
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? `${err.code}: ${err.message}` : 'Token inválido o vencido.',
      );
    }
  }
}
