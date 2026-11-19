import { CommonModule } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
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

        @if (step() === 'datos') {
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
            {{ loading() ? 'Registrando...' : 'Crear cuenta de proveedor' }}
          </button>
          <p class="oq-hint">
            Al registrarte aceptas el <a routerLink="/privacidad">Aviso de privacidad</a>.
          </p>
        </form>

        <p class="oq-hint" style="margin-top: 1rem">
          ¿Ya tienes cuenta? <a routerLink="/worker/login">Inicia sesión</a>
        </p>
        } @else {
        <h2>Revisa tu correo</h2>
        <p class="oq-hint">
          Te enviamos un código a <strong>{{ email() }}</strong>. Pégalo aquí para activar tu cuenta;
          vence en 72 horas.
        </p>
        <form class="oq-form-grid" (ngSubmit)="verifyEmail()">
          <input
            name="verifyToken"
            class="oq-input mono"
            aria-label="Código de verificación"
            autocomplete="one-time-code"
            placeholder="Código de verificación"
            [ngModel]="verifyToken()"
            (ngModelChange)="verifyToken.set($event)"
          />
          <button type="submit" class="oq-btn oq-btn-primary oq-btn-lg" [disabled]="loading() || !verifyToken().trim()">
            {{ loading() ? 'Verificando…' : 'Verificar y entrar' }}
          </button>
        </form>
        <p class="oq-hint" style="margin-top: 1rem">
          ¿Te equivocaste de correo? <button type="button" class="oq-link-button" (click)="step.set('datos')">Cambiarlo</button>
        </p>
        }
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
  private readonly router = inject(Router);

  readonly step = signal<'datos' | 'codigo'>('datos');

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
      await this.auth.registerWorker(this.email().trim(), this.password(), this.tipo());
      this.step.set('codigo');
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
      // Verificado: entra directo a armar su perfil, que es lo primero que necesita.
      try {
        await this.auth.login(this.email().trim(), this.password(), 'worker');
        await this.router.navigate(['/worker/profile'], { queryParams: { nuevo: 1 } });
      } catch {
        await this.router.navigate(['/worker/login']);
      }
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? err.message : 'Ese código no es correcto o ya venció.',
      );
    } finally {
      this.loading.set(false);
    }
  }
}
