import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { BanquetArtComponent } from '../../shared/ui/banquet-art.component';

@Component({
  selector: 'app-home-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, RouterLink, BanquetArtComponent],
  template: `
    <a class="oq-skip-link" href="#contenido">Saltar al contenido</a>
    <header class="oq-topbar">
      <div class="oq-topbar-inner">
        <a class="oq-brand" routerLink="/">Orquesta</a>
        <nav class="oq-nav-links" aria-label="Accesos">
          <a class="oq-nav-link" routerLink="/planner/login">Planners</a>
          <a class="oq-nav-link" routerLink="/worker/login">Proveedores</a>
          <a class="oq-nav-link" routerLink="/scan">Escáner</a>
          <a class="oq-nav-link" routerLink="/invitacion">Mi invitación</a>
        </nav>
      </div>
    </header>

    <main id="contenido" tabindex="-1">
      <section class="home-hero">
        <div class="home-hero-copy">
          <h1>Dirige todos tus eventos desde un solo lugar</h1>
          <p class="home-lede">
            Invitaciones con QR por SMS y correo, check-in en la puerta aunque no haya señal, un
            tablero en vivo para todos los eventos del día y proveedores a un toque cuando algo
            falla.
          </p>
          <div class="oq-row">
            <a class="oq-btn oq-btn-primary oq-btn-lg" routerLink="/planner/login">Entrar como planner</a>
            <a class="oq-btn oq-btn-secondary oq-btn-lg" routerLink="/planner/register">Crear cuenta</a>
          </div>
        </div>

        <figure class="home-arch">
          <app-banquet-art stroke="#f5f2e8" />
          <figcaption>
            <span class="home-arch-time">Sábado, 21:40</span>
            Hacienda Las Moras · 124 de 180 invitados ya llegaron
          </figcaption>
        </figure>
      </section>

      <section class="home-doors" aria-labelledby="doors-title">
        <h2 id="doors-title">Cada quien entra por su puerta</h2>

        <article class="home-door">
          <h3>Planners</h3>
          <div>
            <p>
              Crea el evento, importa tu lista de invitados desde Excel, envía las invitaciones,
              acomoda las mesas y contrata personal. El día del evento, ve llegadas y alertas de
              todos tus eventos en una sola pantalla.
            </p>
            <div class="oq-row">
              <a class="oq-btn oq-btn-primary" routerLink="/planner/dashboard">Abrir tablero</a>
              <a class="oq-btn oq-btn-secondary" routerLink="/planner/register">Registrarme</a>
            </div>
          </div>
        </article>

        <article class="home-door">
          <h3>Proveedores y personal</h3>
          <div>
            <p>
              Publica tu perfil, marca los horarios en que estás disponible y acepta solicitudes,
              también las de emergencia, desde el celular.
            </p>
            <div class="oq-row">
              <a class="oq-btn oq-btn-primary" routerLink="/worker/requests">Ver solicitudes</a>
              <a class="oq-btn oq-btn-secondary" routerLink="/worker/register">Registrarme</a>
            </div>
          </div>
        </article>

        <article class="home-door">
          <h3>Staff en la puerta</h3>
          <div>
            <p>
              Escanea los QR desde el navegador del celular. Funciona sin señal y sincroniza solo
              cuando vuelve la conexión; si la cámara falla, usa el código de 6 dígitos.
            </p>
            <div class="oq-row">
              <a class="oq-btn oq-btn-primary" routerLink="/scan">Abrir escáner</a>
            </div>
          </div>
        </article>

        <article class="home-door">
          <h3>Invitados</h3>
          <div>
            <p>
              Confirma tu asistencia y guarda tu QR de entrada sin crear cuenta. Si tienes el
              código de tu invitación, pégalo aquí.
            </p>
            <form class="home-token" (ngSubmit)="openInvitation()">
              <label class="oq-sr-only" for="homeToken">Código de invitación</label>
              <input
                id="homeToken"
                name="homeToken"
                class="oq-input"
                placeholder="Código de invitación"
                autocomplete="off"
                [ngModel]="rsvpToken()"
                (ngModelChange)="rsvpToken.set($event)"
              />
              <button type="submit" class="oq-btn oq-btn-secondary">Abrir invitación</button>
            </form>
          </div>
        </article>
      </section>
    </main>

    <footer class="home-footer">
      <span class="oq-brand">Orquesta</span>
      <span>Hecho en Guadalajara para planners de México.</span>
    </footer>
  `,
  styles: `
    .home-hero {
      max-width: 1200px;
      margin: 0 auto;
      padding: 3rem 1.5rem 4rem;
      display: grid;
      grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr);
      gap: 3rem;
      align-items: center;
    }
    .home-hero-copy h1 {
      font-size: clamp(2.8rem, 1.8rem + 4vw, 5.2rem);
      line-height: 0.98;
      letter-spacing: -0.02em;
      margin: 0 0 1.5rem;
      max-width: 13ch;
    }
    .home-lede {
      font-size: 1.1rem;
      color: var(--oq-ink-muted);
      max-width: 52ch;
      margin-bottom: 2rem;
    }
    .home-arch {
      margin: 0;
      background: var(--oq-olive);
      color: var(--oq-bg);
      border-radius: var(--oq-radius-arch);
      padding: 4.5rem 2.25rem 2rem;
      aspect-ratio: 4 / 5;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 1.5rem;
    }
    .home-arch figcaption {
      font-size: 0.88rem;
      border-top: 1px solid rgba(245, 242, 232, 0.35);
      padding-top: 0.9rem;
    }
    .home-arch-time {
      display: block;
      font-family: var(--oq-font-display);
      font-style: italic;
      font-size: 1.5rem;
      line-height: 1.2;
    }
    .home-doors {
      max-width: 1200px;
      margin: 0 auto;
      padding: 0 1.5rem 4rem;
    }
    .home-doors > h2 {
      font-size: clamp(1.9rem, 1.5rem + 1.4vw, 2.6rem);
      margin-bottom: 1.5rem;
    }
    .home-door {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1.6fr);
      gap: 1rem 3rem;
      padding: 2rem 0;
      border-top: 1px solid var(--oq-border);
    }
    .home-door:last-child {
      border-bottom: 1px solid var(--oq-border);
    }
    .home-door h3 {
      font-size: 1.9rem;
      color: var(--oq-olive-deep);
    }
    .home-door p {
      color: var(--oq-ink-muted);
      max-width: 60ch;
      margin-bottom: 1rem;
    }
    .home-token {
      display: flex;
      flex-wrap: wrap;
      gap: 0.65rem;
      max-width: 520px;
    }
    .home-token .oq-input {
      flex: 1 1 220px;
    }
    .home-footer {
      max-width: 1200px;
      margin: 0 auto;
      padding: 2rem 1.5rem 3rem;
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: baseline;
      gap: 1rem;
      color: var(--oq-ink-muted);
      font-size: 0.88rem;
    }
    main:focus {
      outline: none;
    }
    @media (max-width: 860px) {
      .home-hero {
        grid-template-columns: 1fr;
        padding-top: 2rem;
      }
      .home-arch {
        max-width: 420px;
        width: 100%;
        justify-self: center;
      }
      .home-door {
        grid-template-columns: 1fr;
      }
    }
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
