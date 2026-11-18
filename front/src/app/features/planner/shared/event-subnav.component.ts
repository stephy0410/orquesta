import { CommonModule } from '@angular/common';
import { Component, input } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

@Component({
  selector: 'app-event-subnav',
  standalone: true,
  imports: [CommonModule, RouterLink, RouterLinkActive],
  template: `
    <nav class="oq-tabs" aria-label="Secciones del evento">
      <a
        class="oq-tab"
        [routerLink]="['/planner/events', eventId()]"
        routerLinkActive="active"
        [routerLinkActiveOptions]="{ exact: true }"
      >
        Resumen y Accesos
      </a>
      <a
        class="oq-tab"
        [routerLink]="['/planner/events', eventId(), 'guests']"
        routerLinkActive="active"
      >
        Invitados y Envíos
      </a>
      <a
        class="oq-tab"
        [routerLink]="['/planner/events', eventId(), 'seating']"
        routerLinkActive="active"
      >
        Mesas y Seating
      </a>
      <a
        class="oq-tab"
        [routerLink]="['/planner/events', eventId(), 'workers']"
        routerLinkActive="active"
      >
        Personal y Pagos
      </a>
    </nav>
  `,
})
export class EventSubnavComponent {
  readonly eventId = input.required<string>();
}
