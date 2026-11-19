import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ProductTriptychComponent } from '../../shared/ui/product-triptych.component';

@Component({
  selector: 'app-home-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, RouterLink, ProductTriptychComponent],
  template: `
    <a class="oq-skip-link" href="#contenido">Saltar al contenido</a>
    <header class="oq-topbar">
      <div class="oq-topbar-inner">
        <nav class="oq-nav-links oq-topbar-start" aria-label="Cuentas">
          <a class="oq-nav-link" routerLink="/planner/login">Planners</a>
          <a class="oq-nav-link" routerLink="/worker/login">Proveedores</a>
        </nav>
        <a class="oq-brand" routerLink="/">Orquesta <small>event planning</small></a>
        <nav class="oq-nav-links oq-topbar-end" aria-label="Accesos rápidos">
          <a class="oq-nav-link" routerLink="/scan">Escáner</a>
          <a class="oq-nav-link" routerLink="/invitacion">Mi invitación</a>
        </nav>
      </div>
    </header>

    <main id="contenido" tabindex="-1">
      <app-product-triptych class="home-tri" />

      <section class="home-intro">
        <h1>Dirige todos tus eventos desde un solo lugar</h1>
        <p class="home-lede">
          Invitaciones con QR por SMS y correo, registro de entrada en la puerta aunque no haya señal, un
          tablero en vivo para todos los eventos del día y proveedores a un toque cuando algo
          falla.
        </p>
        <div class="home-ctas">
          <a class="oq-btn oq-btn-primary oq-btn-lg" routerLink="/planner/login">Entrar como planner</a>
          <a class="oq-link-cta" routerLink="/planner/register">Crear cuenta</a>
        </div>
      </section>

      <section class="home-roles" aria-labelledby="roles-title">
        <div class="home-roles-head">
          <span class="oq-script home-welcome" aria-hidden="true">Bienvenida a Orquesta</span>
          <h2 id="roles-title">Cada quien entra por su puerta</h2>
        </div>

        <article class="home-role">
          <h3>Planners</h3>
          <p>
            Crea el evento, importa tu lista de invitados desde Excel, envía las invitaciones,
            acomoda las mesas y contrata personal. El día del evento, ve llegadas y alertas de
            todos tus eventos en una sola pantalla.
          </p>
          <a class="oq-link-cta" routerLink="/planner/dashboard">Abrir el tablero</a>
        </article>

        <article class="home-role">
          <h3>Proveedores</h3>
          <p>
            Publica tu perfil, marca los horarios en que estás disponible y acepta solicitudes,
            también las de emergencia, desde el celular.
          </p>
          <a class="oq-link-cta" routerLink="/worker/requests">Ver mis solicitudes</a>
        </article>

        <article class="home-role">
          <h3>Staff en la puerta</h3>
          <p>
            Escanea los QR desde el navegador del celular. Funciona sin señal y sincroniza solo
            cuando vuelve la conexión; si la cámara falla, usa el código de 6 dígitos.
          </p>
          <a class="oq-link-cta" routerLink="/scan">Abrir el escáner</a>
        </article>

        <article class="home-role">
          <h3>Invitados</h3>
          <p>
            Confirma tu asistencia y guarda tu pase de entrada sin crear cuenta. Si tienes el
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
        </article>
      </section>
    </main>

    <footer class="home-footer">
      <span class="oq-brand">Orquesta <small>event planning</small></span>
      <p>Hecho en Guadalajara para planners de México.</p>
    </footer>
  `,
  styles: `
    main:focus {
      outline: none;
    }
    .home-tri {
      padding: 8px 8px 0;
    }
    .home-intro {
      max-width: 1000px;
      margin: 0 auto;
      padding: 5rem 1.5rem 5.5rem;
      text-align: center;
    }
    .home-intro h1 {
      font-size: clamp(2.7rem, 1.4rem + 5vw, 5.4rem);
      line-height: 0.98;
      letter-spacing: -0.02em;
      max-width: 15ch;
      margin: 0 auto 2rem;
    }
    .home-lede {
      font-size: 1.05rem;
      color: var(--oq-ink-muted);
      max-width: 54ch;
      margin: 0 auto 2.25rem;
    }
    .home-ctas {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      align-items: center;
      gap: 1.25rem 2rem;
    }
    .home-roles {
      max-width: 1100px;
      margin: 0 auto;
      padding: 0 1.5rem 5rem;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0 4rem;
    }
    .home-roles-head {
      grid-column: 1 / -1;
      text-align: center;
      padding: 3.5rem 0 2.5rem;
      border-top: 1px solid var(--oq-border);
    }
    .home-roles-head h2 {
      font-size: clamp(1.8rem, 1.3rem + 1.8vw, 2.6rem);
      text-transform: uppercase;
      margin: 0;
    }
    .home-welcome {
      display: block;
      font-size: 2rem;
      color: var(--oq-olive);
      transform: rotate(-5deg);
      margin-bottom: 0.25rem;
    }
    .home-role {
      padding: 2rem 0;
      border-top: 1px solid var(--oq-border);
    }
    .home-role h3 {
      font-size: 1.6rem;
      margin-bottom: 0.75rem;
    }
    .home-role p {
      color: var(--oq-ink-muted);
      max-width: 52ch;
      margin-bottom: 1.25rem;
    }
    .home-token {
      display: flex;
      flex-wrap: wrap;
      gap: 0.65rem;
    }
    .home-token .oq-input {
      flex: 1 1 200px;
    }
    .home-footer {
      border-top: 1px solid var(--oq-border);
      padding: 3rem 1.5rem 3.5rem;
      text-align: center;
      color: var(--oq-ink-muted);
      font-size: 0.85rem;
    }
    .home-footer p {
      margin: 1rem 0 0;
    }
    @media (max-width: 760px) {
      .home-intro {
        padding: 3.5rem 1.25rem 4rem;
      }
      .home-roles {
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
