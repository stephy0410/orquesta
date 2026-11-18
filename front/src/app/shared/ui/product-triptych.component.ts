import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TablescapeArtComponent } from './tablescape-art.component';
import { OliveSprigComponent } from './olive-sprig.component';

/** Patrón decorativo con forma de QR (no codifica nada). */
function buildQrGlyph(size = 21): { x: number; y: number }[] {
  const cells: { x: number; y: number }[] = [];
  const inFinder = (x: number, y: number) =>
    (x < 8 && y < 8) || (x > size - 9 && y < 8) || (x < 8 && y > size - 9);
  let seed = 7;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inFinder(x, y)) continue;
      if (rnd() > 0.52) cells.push({ x, y });
    }
  }
  return cells;
}

/**
 * Tríptico del hero: las tres etapas de un evento mostradas con la propia interfaz
 * (invitación, plano de mesas y tablero en vivo). Decorativo para lectores de pantalla:
 * cada panel lleva un pie de foto con texto real.
 */
@Component({
  selector: 'app-product-triptych',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TablescapeArtComponent, OliveSprigComponent],
  template: `
    <figure class="tri-panel tri-paper">
      <div class="tri-card" aria-hidden="true">
        <span class="tri-script">Tienes una invitación a</span>
        <span class="tri-title">Boda Robles–Puente</span>
        <app-olive-sprig [width]="96" />
        <span class="tri-meta">Sábado 21 de noviembre</span>
        <svg class="tri-qr" viewBox="0 0 21 21" focusable="false">
          @for (f of finders; track $index) {
            <rect [attr.x]="f.x" [attr.y]="f.y" width="7" height="7" fill="none" stroke="currentColor" />
            <rect [attr.x]="f.x + 2" [attr.y]="f.y + 2" width="3" height="3" fill="currentColor" />
          }
          @for (c of qr; track $index) {
            <rect [attr.x]="c.x" [attr.y]="c.y" width="1" height="1" fill="currentColor" />
          }
        </svg>
      </div>
      <figcaption><span>01</span> La invitación llega por SMS y correo, con su QR.</figcaption>
    </figure>

    <figure class="tri-panel tri-olive">
      <app-tablescape-art class="tri-plan" stroke="#f5f2e8" fill="#56602a" />
      <figcaption><span>02</span> Cada invitado tiene mesa antes de llegar.</figcaption>
    </figure>

    <figure class="tri-panel tri-deep">
      <div class="tri-live" aria-hidden="true">
        <span class="tri-live-dot">En vivo</span>
        <span class="tri-big">124</span>
        <span class="tri-of">de 180 confirmados ya llegaron</span>
        <span class="tri-meter"><span></span></span>
        <ul>
          <li><span>XV años de Fernanda</span><span>61 / 90</span></li>
          <li><span>Cena de gala ITESO</span><span>38 / 40</span></li>
        </ul>
      </div>
      <figcaption><span>03</span> La noche del evento, todo en una pantalla.</figcaption>
    </figure>
  `,
  styles: `
    :host {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
    }
    .tri-panel {
      margin: 0;
      position: relative;
      aspect-ratio: 4 / 5;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      padding: 2rem 1.75rem 3.5rem;
      overflow: hidden;
    }
    figcaption {
      position: absolute;
      left: 1.25rem;
      right: 1.25rem;
      bottom: 1rem;
      font-size: 0.8rem;
      display: flex;
      gap: 0.75rem;
    }
    figcaption span {
      font-family: var(--oq-font-display);
    }
    .tri-paper {
      background: var(--oq-sage-soft);
      color: var(--oq-ink);
    }
    .tri-olive {
      background: var(--oq-olive);
      color: var(--oq-bg);
    }
    .tri-deep {
      background: var(--oq-olive-deep);
      color: var(--oq-bg);
    }
    .tri-card {
      background: var(--oq-surface);
      width: min(100%, 250px);
      padding: 1.6rem 1.25rem 1.4rem;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.45rem;
      text-align: center;
      outline: 1px solid var(--oq-sage);
      outline-offset: -8px;
      box-shadow: 0 24px 40px -28px rgba(43, 46, 27, 0.6);
      transform: rotate(-2deg);
    }
    .tri-script {
      font-family: var(--oq-font-script);
      font-size: 1.35rem;
      color: var(--oq-olive);
    }
    .tri-title {
      font-family: var(--oq-font-display);
      text-transform: uppercase;
      font-size: 1.15rem;
      line-height: 1.1;
    }
    .tri-meta {
      font-size: 0.72rem;
      color: var(--oq-ink-muted);
    }
    .tri-qr {
      width: 72px;
      height: 72px;
      margin-top: 0.4rem;
      color: var(--oq-ink);
      shape-rendering: crispEdges;
    }
    .tri-plan {
      width: 150%;
      flex: none;
    }
    .tri-live {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
    }
    .tri-live-dot {
      font-size: 0.68rem;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
    }
    .tri-live-dot::before {
      content: '';
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--oq-sage);
    }
    .tri-big {
      font-family: var(--oq-font-display);
      font-size: clamp(4rem, 3rem + 4vw, 6.5rem);
      line-height: 0.9;
    }
    .tri-of {
      font-size: 0.85rem;
      opacity: 0.85;
    }
    .tri-meter {
      height: 4px;
      background: rgba(245, 242, 232, 0.2);
      margin: 0.5rem 0 1.25rem;
    }
    .tri-meter span {
      display: block;
      width: 69%;
      height: 100%;
      background: var(--oq-bg);
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
      font-size: 0.8rem;
    }
    li {
      display: flex;
      justify-content: space-between;
      padding: 0.55rem 0;
      border-top: 1px solid rgba(245, 242, 232, 0.2);
    }
    @media (max-width: 760px) {
      :host {
        grid-template-columns: repeat(3, 82%);
        overflow-x: auto;
        scroll-snap-type: x mandatory;
        padding-bottom: 0.5rem;
      }
      .tri-panel {
        scroll-snap-align: center;
      }
    }
  `,
})
export class ProductTriptychComponent {
  readonly qr = buildQrGlyph();
  readonly finders = [
    { x: 0, y: 0 },
    { x: 14, y: 0 },
    { x: 0, y: 14 },
  ];
}
