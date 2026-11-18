import { CommonModule } from '@angular/common';
import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

@Component({
  selector: 'app-home-page',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  template: `
    <header class="oq-topbar">
      <div class="oq-topbar-inner">
        <a class="oq-brand" routerLink="/">
          <img src="icons/orquesta-icon.svg" alt="Orquesta" width="28" height="28" />
          <span>Orquesta</span>
        </a>
        <nav class="oq-nav-links">
          <a class="oq-nav-link" routerLink="/planner/login">Planner</a>
          <a class="oq-nav-link" routerLink="/worker/login">Trabajador</a>
          <a class="oq-nav-link" routerLink="/scan">Escáner PWA</a>
          <a class="oq-nav-link" routerLink="/invitacion">Invitación</a>
        </nav>
      </div>
    </header>

    <main class="oq-container">
      <section class="oq-page-header">
        <div>
          <h1>Orquesta · Plataforma de Eventos y Check-in Offline-First</h1>
          <p class="oq-page-subtitle">
            Cuatro superficies web independientes en una arquitectura resiliente sin apps nativas.
          </p>
        </div>
      </section>

      <section class="oq-grid-2">
        <article class="oq-card">
          <span class="oq-badge oq-badge-info">Superficie 1</span>
          <h2 style="margin-top: 0.6rem">Consola del Planner</h2>
          <p class="oq-hint">
            Crea eventos con timezone y aforo duro, importa CSV de hasta 20 000 invitados, dispara
            envíos SMS + Email, acomoda mesas, contrata personal y monitorea el tablero en vivo cada 3 s.
          </p>
          <div class="oq-row">
            <a class="oq-btn oq-btn-primary" routerLink="/planner/dashboard">Abrir tablero</a>
            <a class="oq-btn oq-btn-secondary" routerLink="/planner/login">Iniciar sesión</a>
            <a class="oq-btn oq-btn-secondary" routerLink="/planner/register">Registrarse</a>
          </div>
        </article>

        <article class="oq-card">
          <span class="oq-badge oq-badge-info">Superficie 2</span>
          <h2 style="margin-top: 0.6rem">Consola del Trabajador</h2>
          <p class="oq-hint">
            Publica tu perfil persona o empresa (1–50 plazas), verifica email y teléfono por OTP,
            declara ventanas de disponibilidad y acepta o rechaza solicitudes.
          </p>
          <div class="oq-row">
            <a class="oq-btn oq-btn-primary" routerLink="/worker/requests">Bandeja de solicitudes</a>
            <a class="oq-btn oq-btn-secondary" routerLink="/worker/login">Iniciar sesión</a>
            <a class="oq-btn oq-btn-secondary" routerLink="/worker/register">Registrarse</a>
          </div>
        </article>

        <article class="oq-card">
          <span class="oq-badge oq-badge-success">Superficie 3 · PWA Offline</span>
          <h2 style="margin-top: 0.6rem">Vista de Escaneo en Venue</h2>
          <p class="oq-hint">
            Canjea el QR de acceso por evento, descarga el roster firmado ES256, verifica QRs sin
            red en ≤ 100 ms con RPO 0 en IndexedDB y usa fallback manual de 6 dígitos.
          </p>
          <div class="oq-row">
            <a class="oq-btn oq-btn-accent" routerLink="/scan">Abrir terminal de escaneo</a>
          </div>
        </article>

        <article class="oq-card">
          <span class="oq-badge oq-badge-neutral">Superficie 4 · Sin cuenta</span>
          <h2 style="margin-top: 0.6rem">Página Pública de Invitación</h2>
          <p class="oq-hint">
            Abre <code>/invitacion/#t=&lt;rsvp_token&gt;</code> sin cookies ni sesión para
            confirmar asistencia y mostrar tu QR de acceso.
          </p>
          <form class="oq-row" (ngSubmit)="openInvitation()">
            <input
              class="oq-input mono"
              style="flex: 1 1 180px"
              placeholder="rsvp_token..."
              [ngModel]="rsvpToken()"
              [ngModelOptions]="{ standalone: true }"
              (ngModelChange)="rsvpToken.set($event)"
            />
            <button type="submit" class="oq-btn oq-btn-secondary">Abrir</button>
          </form>
        </article>
      </section>
    </main>
  `,
})
export class HomePage {
  readonly rsvpToken = signal('');

  constructor(private readonly router: Router) {}

  async openInvitation(): Promise<void> {
    const t = this.rsvpToken().trim();
    if (!t) {
      await this.router.navigate(['/invitacion']);
      return;
    }
    await this.router.navigate(['/invitacion'], { fragment: `t=${encodeURIComponent(t)}` });
  }
}
