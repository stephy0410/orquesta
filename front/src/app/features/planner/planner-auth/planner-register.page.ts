import { CommonModule } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
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

        @if (step() === 'datos') {
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

        <p class="oq-hint" style="margin-top: 1rem">
          ¿Ya tienes cuenta? <a routerLink="/planner/login">Inicia sesión</a>
        </p>
        <p class="oq-hint">
          ¿Ya te registraste pero no verificaste tu correo?
          <button type="button" class="oq-link-button" (click)="step.set('codigo')">Ingresa tu código</button>
        </p>
        } @else {
        <h2>Revisa tu correo</h2>
        <p class="oq-hint">
          @if (email()) {
            Te enviamos un código a <strong>{{ email() }}</strong>. Pégalo aquí o usa el botón del correo;
          } @else {
            Pega el código que te llegó por correo o usa el botón «Verificar mi correo»;
          }
          vence en 72 horas. Revisa también spam.
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
        <form class="oq-form-grid" style="margin-top: 1rem" (ngSubmit)="resend()">
          <input
            name="resendEmail"
            type="email"
            class="oq-input"
            aria-label="Correo para reenviar el código"
            placeholder="Tu correo"
            [ngModel]="email()"
            (ngModelChange)="email.set($event)"
          />
          <button type="submit" class="oq-btn oq-btn-secondary" [disabled]="loading() || !email().trim()">
            ¿No te llegó? Reenviar correo
          </button>
        </form>
        }
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
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly step = signal<'datos' | 'codigo'>('datos');

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
      if (res.email_verificado) {
        await this.router.navigate(['/planner/login'], { queryParams: { email: this.email().trim(), listo: 1 } });
        return;
      }
      this.step.set('codigo');
    } catch (err) {
      this.error.set(
        err instanceof OrquestaApiError ? err.message : 'Error al registrar.',
      );
    } finally {
      this.loading.set(false);
    }
  }

  constructor() {
    // Enlace "Verificar mi correo": /…/register?codigo=vfy_… verifica en un clic.
    const codigo = this.route.snapshot.queryParamMap.get('codigo');
    if (codigo) {
      this.verifyToken.set(codigo);
      this.step.set('codigo');
      void this.verifyEmail();
    }
  }

  async resend(): Promise<void> {
    const email = this.email().trim();
    if (!email || this.loading()) return;
    this.loading.set(true);
    this.error.set(null);
    try {
      await this.auth.resendVerification(email);
      this.success.set(`Si ${email} tiene una cuenta sin verificar, te mandamos un correo nuevo. Revisa también spam.`);
    } catch (err) {
      this.error.set(err instanceof OrquestaApiError ? err.message : 'No pudimos reenviar el correo.');
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
      // Con el correo verificado entramos directo; si algo falla, mandamos al login ya llenado.
      try {
        await this.auth.login(this.email().trim(), this.password(), 'planner');
        await this.router.navigate(['/planner/dashboard']);
      } catch {
        await this.router.navigate(['/planner/login'], { queryParams: { email: this.email().trim(), listo: 1 } });
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
