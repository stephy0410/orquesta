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
        ariaCurrentWhenActive="page"
        [routerLinkActiveOptions]="{ exact: true }"
      >
        Resumen y accesos
      </a>
      <a
        class="oq-tab"
        [routerLink]="['/planner/events', eventId(), 'guests']"
        routerLinkActive="active"
        ariaCurrentWhenActive="page"
      >
        Invitados y envíos
      </a>
      <a
        class="oq-tab"
        [routerLink]="['/planner/events', eventId(), 'seating']"
        routerLinkActive="active"
        ariaCurrentWhenActive="page"
      >
        Mesas
      </a>
      <a
        class="oq-tab"
        [routerLink]="['/planner/events', eventId(), 'workers']"
        routerLinkActive="active"
        ariaCurrentWhenActive="page"
      >
        Personal y pagos
      </a>
    </nav>
  `,
})
export class EventSubnavComponent {
  readonly eventId = input.required<string>();
}
