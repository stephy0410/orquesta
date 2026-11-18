import { CommonModule } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { OrquestaApiError } from '../../../core/api/api-config';
import { WorkerTipo } from '../../../core/api/models';
import { TablescapeArtComponent } from '../../../shared/ui/tablescape-art.component';
import { AuthService } from '../../../core/auth/auth.service';

@Component({
  selector: 'app-worker-register-page',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, TablescapeArtComponent],
  template: `
    <a class="oq-skip-link" href="#contenido">Saltar al contenido</a>
    <header class="oq-topbar">
      <div class="oq-topbar-inner">
        <a class="oq-brand" routerLink="/">
          Orquesta <small>para proveedores</small>
        </a>
        <nav class="oq-nav-links oq-topbar-end" aria-label="Accesos">
          <a class="oq-nav-link" routerLink="/worker/login">Iniciar sesión</a>
        </nav>
      </div>
    </header>

    <main id="contenido" class="oq-auth" tabindex="-1">
      <div class="oq-auth-form">
      <section class="oq-card">
        <h1>Registra tu perfil de proveedor</h1>
        <p class="oq-page-subtitle">
          Crea tu cuenta como persona independiente o empresa con cuadrilla (1–50 plazas).
        </p>

        @if (error()) {
          <div class="oq-alert oq-alert-error">{{ error() }}</div>
        }
        @if (success()) {
          <div class="oq-alert oq-alert-success">{{ success() }}</div>
        }

        <form class="oq-form-grid" (ngSubmit)="register()">
          <div class="oq-field">
            <label class="oq-label" for="regTipo">Tipo de perfil</label>
            <select
              id="regTipo"
              name="tipo"
              class="oq-select"
              [ngModel]="tipo()"
              (ngModelChange)="tipo.set($event)"
            >
              <option value="persona">Persona (1 plaza)</option>
              <option value="empresa">Empresa (1–50 plazas)</option>
            </select>
          </div>

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
            {{ loading() ? 'Registrando...' : 'Crear cuenta de trabajador' }}
          </button>
        </form>

        <hr style="margin: 1.5rem 0; border: none; border-top: 1px solid var(--oq-border)" />

        <h2>Verificar correo electrónico</h2>
        <form class="oq-row" (ngSubmit)="verifyEmail()">
          <input
            name="verifyToken"
            class="oq-input mono"
            style="flex: 1 1 220px"
            placeholder="Token de verificación recibido por email"
            [ngModel]="verifyToken()"
            (ngModelChange)="verifyToken.set($event)"
          />
          <button type="submit" class="oq-btn oq-btn-accent" [disabled]="loading()">
            Confirmar email
          </button>
        </form>

        <p class="oq-hint" style="margin-top: 1rem">
          ¿Ya verificaste tu correo? <a routerLink="/worker/login">Ir al login</a>
        </p>
      </section>
      </div>
      <aside class="oq-auth-art" aria-hidden="true">
        <app-tablescape-art stroke="#f5f2e8" fill="#56602a" />
        <blockquote>Que las planners te encuentren cuando más te necesitan.</blockquote>
      </aside>
    </main>
  `,
})
export class WorkerRegisterPage {
  private readonly auth = inject(AuthService);

  readonly tipo = signal<WorkerTipo>('persona');
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
      const res = await this.auth.registerWorker(this.email().trim(), this.password(), this.tipo());
      this.success.set(
        `Cuenta creada (${res.user_id}). Estado email: ${res.estado_email}. Verifica tu correo para iniciar sesión.`,
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
      this.success.set('Correo verificado correctamente. Ya puedes iniciar sesión.');
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? `${err.code}: ${err.message}` : 'Token inválido.',
      );
    } finally {
      this.loading.set(false);
    }
  }
}
