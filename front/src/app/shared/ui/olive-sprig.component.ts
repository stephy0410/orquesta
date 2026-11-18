import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Ramita de olivo dibujada a línea; separador decorativo (aria-hidden). */
@Component({
  selector: 'app-olive-sprig',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-hidden': 'true', class: 'oq-ornament' },
  template: `
    <svg
      [attr.width]="width()"
      viewBox="0 0 160 28"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      focusable="false"
    >
      <g stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 15c26-2 58-3 92-1 22 1 42 1 60-1" />
        <path d="M24 14.6c2-6 8-9 14-9-2 6-8 9-14 9Z" />
        <path d="M30 14.4c4 5 10 7 16 6-4-5-10-7-16-6Z" />
        <path d="M54 14.2c2-6 8-9 14-9-2 6-8 9-14 9Z" />
        <path d="M62 14.2c4 5 10 7 16 6-4-5-10-7-16-6Z" />
        <path d="M86 14.2c2-6 8-9 14-9-2 6-8 9-14 9Z" />
        <path d="M94 14.4c4 5 10 7 16 6-4-5-10-7-16-6Z" />
        <path d="M118 14.6c2-6 8-9 14-9-2 6-8 9-14 9Z" />
        <circle cx="138" cy="19" r="2.6" fill="currentColor" />
        <circle cx="146" cy="12" r="2.2" />
      </g>
    </svg>
  `,
})
export class OliveSprigComponent {
  readonly width = input(140);
}
