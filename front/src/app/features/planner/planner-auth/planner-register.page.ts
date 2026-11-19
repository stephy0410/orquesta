import { CommonModule } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { OrquestaApiError } from '../../../core/api/api-config';
import { TablescapeArtComponent } from '../../../shared/ui/tablescape-art.component';
import { AuthService } from '../../../core/auth/auth.service';

@Component({
  selector: 'app-planner-register-page',
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
          <a class="oq-nav-link" routerLink="/planner/login">Iniciar sesión</a>
        </nav>
      </div>
    </header>

    <main id="contenido" class="oq-auth" tabindex="-1">
      <div class="oq-auth-form">
      <section class="oq-card">
        <h1>Crea tu cuenta de planner</h1>
        <p class="oq-page-subtitle">
          Regístrate con tu correo y verifícalo para comenzar a gestionar eventos.
        </p>

        @if (error()) {
          <div class="oq-alert oq-alert-error">{{ error() }}</div>
        }
        @if (success()) {
          <div class="oq-alert oq-alert-success">{{ success() }}</div>
        }

        <form class="oq-form-grid" (ngSubmit)="register()">
          <div class="oq-field">
            <label class="oq-label" for="regEmail">Correo electrónico</label>
            <input
              id="regEmail"
              name="email"
              class="oq-input"
              type="email"
              required
              [ngModel]="email()"
              (ngModelChange)="email.set($event)"
            />
          </div>

          <div class="oq-field">
            <label class="oq-label" for="regPass">Contraseña</label>
            <input
              id="regPass"
              name="password"
              class="oq-input"
              type="password"
              minlength="8"
              required
              [ngModel]="password()"
              (ngModelChange)="password.set($event)"
            />
          </div>

          <button type="submit" class="oq-btn oq-btn-primary oq-btn-lg" [disabled]="loading()">
            {{ loading() ? 'Creando cuenta...' : 'Registrarme como planner' }}
          </button>
          <p class="oq-hint">
            Al registrarte aceptas el <a routerLink="/privacidad">Aviso de privacidad</a>.
          </p>
        </form>

        <hr style="margin: 1.5rem 0; border: none; border-top: 1px solid var(--oq-border)" />

        <h2>Verificar correo electrónico</h2>
        <p class="oq-hint">Pega el código que te enviamos por correo. Vence en 72 horas.</p>
        <form class="oq-row" (ngSubmit)="verifyEmail()">
          <input
            name="verifyToken"
            class="oq-input mono"
            style="flex: 1 1 220px"
            aria-label="Código de verificación"
            autocomplete="one-time-code"
            placeholder="Código de verificación"
            [ngModel]="verifyToken()"
            (ngModelChange)="verifyToken.set($event)"
          />
          <button type="submit" class="oq-btn oq-btn-accent" [disabled]="loading()">
            Verificar correo
          </button>
        </form>

        <p class="oq-hint" style="margin-top: 1rem">
          ¿Ya verificaste tu correo? <a routerLink="/planner/login">Ir al login</a>
        </p>
      </section>
      </div>
      <aside class="oq-auth-art" aria-hidden="true">
        <app-tablescape-art stroke="#f5f2e8" fill="#56602a" />
        <blockquote>Tu lista de invitados ya no vive en Excel.</blockquote>
      </aside>
    </main>
  `,
})
export class PlannerRegisterPage {
  private readonly auth = inject(AuthService);

  readonly email = signal('');
  readonly password = signal('');
  readonly verifyToken = signal('');
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly success = signal<string | null>(null);

  async register(): Promise<void> {
    if (this.loading()) return;
    this.loading.set(true);
    this.error.set(null);
    this.success.set(null);

    try {
      const res = await this.auth.registerPlanner(this.email().trim(), this.password());
      this.success.set(
        res.email_verificado
          ? 'Cuenta creada. Ya puedes iniciar sesión.'
          : 'Cuenta creada. Te enviamos un código a tu correo para verificarla.',
      );
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? err.message : 'Error al registrar.',
      );
    } finally {
      this.loading.set(false);
    }
  }

  async verifyEmail(): Promise<void> {
    const token = this.verifyToken().trim();
    if (!token || this.loading()) return;
    this.loading.set(true);
    this.error.set(null);
    this.success.set(null);

    try {
      await this.auth.verifyEmail(token);
      this.success.set('Correo verificado. Ya puedes iniciar sesión.');
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? err.message : 'Ese código no es correcto o ya venció.',
      );
    } finally {
      this.loading.set(false);
    }
  }
}
