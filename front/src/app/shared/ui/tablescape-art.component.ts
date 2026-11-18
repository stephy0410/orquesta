import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Línea base de la mesa dentro del viewBox. */
const B = 160;

const bottle = (x: number, top = 44) =>
  `M${x - 14} ${B} L${x - 14} ${top + 52} C${x - 14} ${top + 36} ${x - 6} ${top + 32} ${x - 5} ${top + 20}` +
  ` L${x - 5} ${top} L${x + 5} ${top} L${x + 5} ${top + 20} C${x + 6} ${top + 32} ${x + 14} ${top + 36} ${x + 14} ${top + 52} L${x + 14} ${B} Z` +
  ` M${x - 14} ${top + 74} L${x + 14} ${top + 74} M${x - 14} ${top + 98} L${x + 14} ${top + 98}` +
  ` M${x - 6} ${top + 4} L${x + 6} ${top + 4}` +
  ` M${x + 7} ${top + 60} C${x + 9} ${top + 66} ${x + 9} ${top + 70} ${x + 8} ${top + 72}`;

const wineGlass = (x: number) =>
  `M${x - 12} 98 C${x - 14} 122 ${x + 14} 122 ${x + 12} 98 Z M${x - 11} 106 L${x + 11} 106` +
  ` M${x} 119 L${x} 156 M${x - 10} ${B} C${x - 6} 154 ${x + 6} 154 ${x + 10} ${B}`;

const flute = (x: number) =>
  `M${x - 8} 86 L${x - 6} 126 C${x - 5} 133 ${x + 5} 133 ${x + 6} 126 L${x + 8} 86 Z M${x - 7} 96 L${x + 7} 96` +
  ` M${x} 132 L${x} 156 M${x - 9} ${B} C${x - 5} 154 ${x + 5} 154 ${x + 9} ${B}`;

const coupe = (x: number) =>
  `M${x - 17} 112 C${x - 15} 128 ${x + 15} 128 ${x + 17} 112 Z M${x - 13} 117 L${x + 13} 117` +
  ` M${x} 125 L${x} 155 M${x - 10} ${B} C${x - 6} 154 ${x + 6} 154 ${x + 10} ${B}`;

/** Vela larga: devuelve el cuerpo (relleno) y el portavelas (línea). */
const taper = (x: number, top: number, holder: 'block' | 'stick') => ({
  body: `M${x - 3.2} ${top} L${x - 3.2} ${holder === 'block' ? 150 : 138} L${x + 3.2} ${holder === 'block' ? 150 : 138} L${x + 3.2} ${top} Z`,
  flame: `M${x} ${top - 3} C${x - 4} ${top - 7} ${x - 2} ${top - 13} ${x} ${top - 17} C${x + 2} ${top - 13} ${x + 4} ${top - 7} ${x} ${top - 3} Z`,
  holder:
    holder === 'block'
      ? `M${x - 10} 150 L${x + 10} 150 L${x + 10} ${B} L${x - 10} ${B} Z M${x - 6} 154 L${x - 6} 158 M${x + 3} 153 L${x + 3} 158`
      : `M${x - 7} 138 L${x + 7} 138 M${x - 4} 138 C${x - 4} 144 ${x + 4} 144 ${x + 4} 138 M${x} 143 L${x} 152` +
        ` M${x - 8} ${B} C${x - 6} 152 ${x + 6} 152 ${x + 8} ${B} Z M${x - 3} 154 L${x - 3} 158 M${x + 3} 154 L${x + 3} 158`,
});

/** Margarita: centro + seis pétalos. */
const daisy = (cx: number, cy: number, r = 7) => {
  let d = '';
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const px = cx + Math.cos(a) * r;
    const py = cy + Math.sin(a) * r;
    const ox = Math.cos(a + Math.PI / 2) * (r * 0.42);
    const oy = Math.sin(a + Math.PI / 2) * (r * 0.42);
    d += ` M${cx.toFixed(1)} ${cy.toFixed(1)} Q${(px + ox).toFixed(1)} ${(py + oy).toFixed(1)} ${(cx + Math.cos(a) * r * 1.5).toFixed(1)} ${(cy + Math.sin(a) * r * 1.5).toFixed(1)} Q${(px - ox).toFixed(1)} ${(py - oy).toFixed(1)} ${cx.toFixed(1)} ${cy.toFixed(1)}`;
  }
  return d;
};

/**
 * Mesa puesta vista de frente, dibujada a línea: velas, botellas, copas y un florero.
 * Ilustración original y decorativa (aria-hidden) que hereda el color del contenedor.
 */
@Component({
  selector: 'app-tablescape-art',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-hidden': 'true' },
  template: `
    <svg viewBox="0 0 560 200" fill="none" xmlns="http://www.w3.org/2000/svg" focusable="false">
      <g [attr.stroke]="stroke()" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        @for (t of tapers; track $index) {
          <path [attr.d]="t.body" [attr.fill]="stroke()" />
          <path [attr.d]="t.flame" />
          <path [attr.d]="t.holder" />
        }
        @for (d of lines; track $index) {
          <path [attr.d]="d" />
        }
        <!-- florero con margaritas -->
        <path [attr.d]="stems" stroke-width="1.3" />
        @for (f of flowers; track $index) {
          <path [attr.d]="f.petals" [attr.fill]="fill()" />
          <circle [attr.cx]="f.x" [attr.cy]="f.y" r="2.4" [attr.fill]="stroke()" />
        }
        <path [attr.d]="vase" [attr.fill]="fill()" />
        <!-- botanas al frente -->
        @for (g of grapes; track $index) {
          <circle [attr.cx]="g.x" [attr.cy]="g.y" r="3.6" />
        }
        <path [attr.d]="snacks" stroke-width="1.3" />
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
export class TablescapeArtComponent {
  readonly stroke = input('currentColor');
  readonly fill = input('none');

  readonly tapers = [
    taper(26, 70, 'block'),
    taper(48, 62, 'block'),
    taper(232, 66, 'block'),
    taper(256, 58, 'stick'),
    taper(482, 80, 'stick'),
    taper(546, 74, 'block'),
  ];

  readonly lines = [
    bottle(92, 50),
    bottle(122, 38),
    coupe(166),
    flute(204),
    bottle(392, 50),
    wineGlass(434),
    flute(462),
    wineGlass(516),
  ];

  // Florero bulboso al centro y un vaso recto con ramitas
  readonly vase =
    'M320 160 C306 146 314 130 318 116 L330 116 C334 130 342 146 328 160 Z ' +
    'M286 160 L286 124 L304 124 L304 160 Z M290 132 L300 132';

  readonly stems =
    'M322 116 C318 98 312 86 306 74 M326 116 C328 94 334 80 340 66 M324 116 C324 100 322 92 324 82 ' +
    'M292 124 C288 112 284 104 280 96 M298 124 C300 112 304 106 308 100 ' +
    'M318 98 C310 96 306 90 306 86 C312 88 316 92 318 98 Z M332 92 C340 92 344 86 344 82 C338 84 334 88 332 92 Z';

  readonly flowers = [
    { x: 306, y: 72 },
    { x: 341, y: 63 },
    { x: 324, y: 80 },
    { x: 279, y: 94 },
    { x: 309, y: 98 },
  ].map((f, i) => ({ ...f, petals: daisy(f.x, f.y, i < 3 ? 7 : 5) }));

  readonly grapes = [
    { x: 492, y: 180 }, { x: 499, y: 177 }, { x: 506, y: 180 }, { x: 513, y: 177 },
    { x: 496, y: 186 }, { x: 503, y: 185 }, { x: 510, y: 186 }, { x: 500, y: 192 }, { x: 507, y: 192 },
  ];

  readonly snacks =
    // queso
    'M6 186 L6 172 L34 166 L40 176 L40 186 Z M6 172 L40 176 M14 180 a2 2 0 1 0 0.1 0 M28 182 a2.5 2.5 0 1 0 0.1 0 ' +
    // rodaja de limón
    'M150 182 a8 8 0 1 0 16 0 Z M158 182 L152 188 M158 182 L158 189 M158 182 L164 188 ' +
    // aceitunas
    'M214 180 a3 3 0 1 0 0.1 0 M222 184 a3 3 0 1 0 0.1 0 M230 179 a3 3 0 1 0 0.1 0 ' +
    // macarons
    'M352 176 C352 170 366 170 366 176 M352 176 L366 176 M352 179 C352 184 366 184 366 179 M352 179 L366 179 ' +
    'M370 182 C370 176 384 176 384 182 M370 182 L384 182 M370 185 C370 190 384 190 384 185 M370 185 L384 185 ' +
    // cucharita
    'M402 190 L426 186 M426 186 C428 182 438 182 438 186 C438 190 428 190 426 186 ' +
    // rama de las uvas
    'M503 174 C506 168 512 166 518 164 M512 166 C514 162 518 162 520 158';
}
