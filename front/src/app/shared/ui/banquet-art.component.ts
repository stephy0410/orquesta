import { ChangeDetectionStrategy, Component, input } from '@angular/core';

interface Chair {
  x: number;
  y: number;
}

interface RoundTable {
  cx: number;
  cy: number;
  r: number;
  chairs: Chair[];
  filled: number;
}

function buildTable(cx: number, cy: number, seats: number, filled: number): RoundTable {
  const r = 17;
  const chairs: Chair[] = [];
  for (let i = 0; i < seats; i++) {
    const a = (i / seats) * Math.PI * 2 - Math.PI / 2;
    chairs.push({ x: cx + Math.cos(a) * (r + 8), y: cy + Math.sin(a) * (r + 8) });
  }
  return { cx, cy, r, chairs, filled };
}

/**
 * Plano de un salón visto desde arriba (mesa de honor + mesas redondas) dibujado a línea.
 * Las sillas "llenas" sugieren invitados que ya llegaron. Decorativo: aria-hidden.
 */
@Component({
  selector: 'app-banquet-art',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-hidden': 'true' },
  template: `
    <svg viewBox="0 0 300 330" fill="none" xmlns="http://www.w3.org/2000/svg" focusable="false">
      <g [attr.stroke]="stroke()" stroke-width="1.1" stroke-linecap="round">
        <!-- mesa de honor -->
        <rect x="70" y="22" width="160" height="22" rx="3" />
        @for (i of headSeats; track i) {
          <circle [attr.cx]="82 + i * 17" cy="56" r="4.2" [attr.fill]="i % 3 === 1 ? 'none' : stroke()" />
        }
        <!-- pista -->
        <ellipse cx="150" cy="186" rx="40" ry="26" stroke-dasharray="2 4" />
        @for (t of tables; track $index) {
          <circle [attr.cx]="t.cx" [attr.cy]="t.cy" [attr.r]="t.r" />
          <circle [attr.cx]="t.cx" [attr.cy]="t.cy" r="3" [attr.fill]="stroke()" opacity="0.55" />
          @for (c of t.chairs; track $index) {
            <circle
              [attr.cx]="c.x"
              [attr.cy]="c.y"
              r="4.2"
              [attr.fill]="$index < t.filled ? stroke() : 'none'"
            />
          }
        }
      </g>
    </svg>
  `,
  styles: `
    :host {
      display: block;
    }
    svg {
      display: block;
      width: 100%;
      height: auto;
    }
  `,
})
export class BanquetArtComponent {
  readonly stroke = input('currentColor');

  readonly headSeats = Array.from({ length: 9 }, (_, i) => i);

  readonly tables: RoundTable[] = [
    buildTable(60, 112, 8, 8),
    buildTable(150, 106, 8, 5),
    buildTable(240, 112, 8, 7),
    buildTable(48, 196, 8, 3),
    buildTable(252, 196, 8, 8),
    buildTable(78, 280, 8, 6),
    buildTable(150, 268, 8, 2),
    buildTable(222, 280, 8, 4),
  ];
}
