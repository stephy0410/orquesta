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
    <a class="oq-skip-link" href="#contenido">Saltar al contenido</a>
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
        @if (needsVerification()) {
          <div style="display: flex; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 1rem">
            <button type="button" class="oq-btn oq-btn-secondary" [disabled]="loading()" (click)="resendVerification()">
              Reenviar correo de verificación
            </button>
            <a class="oq-btn oq-btn-primary" routerLink="/planner/register" [queryParams]="{ verificar: 1, email: email().trim() }">
              Ingresar mi código
            </a>
          </div>
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
                aria-label="Código de recuperación"
                autocomplete="one-time-code"
                placeholder="Código del correo"
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
  readonly needsVerification = signal(false);
  readonly info = signal<string | null>(null);

  readonly showReset = signal(false);
  readonly resetEmail = signal('');
  readonly resetToken = signal('');
  readonly resetNewPassword = signal('');

  constructor() {
    const q = this.route.snapshot.queryParamMap;
    const email = q.get('email');
    if (email) this.email.set(email);
    if (q.get('listo')) this.info.set('Tu correo quedó verificado. Escribe tu contraseña para entrar.');
  }

  async resendVerification(): Promise<void> {
    const email = this.email().trim();
    if (!email || this.loading()) return;
    this.loading.set(true);
    try {
      await this.auth.resendVerification(email);
      this.error.set(null);
      this.info.set(`Te mandamos un correo nuevo a ${email} con el botón «Verificar mi correo». Revisa también spam.`);
    } catch (err) {
      this.error.set(err instanceof OrquestaApiError ? err.message : 'No pudimos reenviar el correo.');
    } finally {
      this.loading.set(false);
    }
  }

  async submit(): Promise<void> {
    if (this.loading()) return;
    this.loading.set(true);
    this.error.set(null);
    this.needsVerification.set(false);
    this.info.set(null);

    try {
      await this.auth.login(this.email().trim(), this.password(), 'planner');
      const redirect = this.route.snapshot.queryParamMap.get('redirect') || '/planner/dashboard';
      await this.router.navigateByUrl(redirect);
    } catch (err) {
      if (err instanceof OrquestaApiError && err.code === 'EMAIL_NOT_VERIFIED') {
        this.needsVerification.set(true);
      }
      this.error.set(
        err instanceof OrquestaApiError ? err.message : 'Credenciales inválidas.',
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
        err instanceof OrquestaApiError ? err.message : 'No pudimos enviar el correo de recuperación.',
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
        err instanceof OrquestaApiError ? err.message : 'Ese código no es correcto o ya venció.',
      );
    }
  }
}
