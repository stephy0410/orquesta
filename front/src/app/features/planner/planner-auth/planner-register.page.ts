import { CommonModule } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { OrquestaApiError } from '../../../core/api/api-config';
import { AuthService } from '../../../core/auth/auth.service';

@Component({
  selector: 'app-planner-register-page',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  template: `
    <header class="oq-topbar">
      <div class="oq-topbar-inner">
        <a class="oq-brand" routerLink="/">
          <img src="icons/orquesta-icon.svg" alt="Orquesta" width="28" height="28" />
          <span>Orquesta · Planner</span>
        </a>
        <div class="oq-nav-links">
          <a class="oq-nav-link" routerLink="/planner/login">Iniciar sesión</a>
        </div>
      </div>
    </header>

    <main class="oq-container-narrow">
      <section class="oq-card">
        <h1>Crear cuenta de Planner (RF-19)</h1>
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
        </form>

        <hr style="margin: 1.5rem 0; border: none; border-top: 1px solid var(--oq-border)" />

        <h2>Verificar correo electrónico</h2>
        <p class="oq-hint">Ingresa el token de verificación (uso único, 72 h).</p>
        <form class="oq-row" (ngSubmit)="verifyEmail()">
          <input
            name="verifyToken"
            class="oq-input mono"
            style="flex: 1 1 220px"
            placeholder="Token de verificación"
            [ngModel]="verifyToken()"
            (ngModelChange)="verifyToken.set($event)"
          />
          <button type="submit" class="oq-btn oq-btn-accent" [disabled]="loading()">
            Verificar email
          </button>
        </form>

        <p class="oq-hint" style="margin-top: 1rem">
          ¿Ya verificaste tu correo? <a routerLink="/planner/login">Ir al login</a>
        </p>
      </section>
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
        `Usuario creado (${res.user_id}). Email verificado: ${res.email_verificado ? 'Sí' : 'Pendiente'}.`,
      );
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? `${err.code}: ${err.message}` : 'Error al registrar.',
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
      this.success.set('Email verificado correctamente. Ya puedes iniciar sesión.');
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? `${err.code}: ${err.message}` : 'Token inválido o vencido.',
      );
    } finally {
      this.loading.set(false);
    }
  }
}
