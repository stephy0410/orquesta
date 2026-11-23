import { Routes } from '@angular/router';
import { plannerGuard } from '../../core/auth/auth.guards';

export const PLANNER_ROUTES: Routes = [
  {
    path: 'login',
    title: 'Inicia sesión',
    loadComponent: () =>
      import('./planner-auth/planner-login.page').then((m) => m.PlannerLoginPage),
  },
  {
    path: 'register',
    title: 'Crea tu cuenta',
    loadComponent: () =>
      import('./planner-auth/planner-register.page').then((m) => m.PlannerRegisterPage),
  },
  {
    path: '',
    canActivate: [plannerGuard],
    loadComponent: () =>
      import('./planner-shell/planner-shell.component').then((m) => m.PlannerShellComponent),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      {
        path: 'dashboard',
        title: 'Tablero en vivo',
        loadComponent: () =>
          import('./dashboard/planner-dashboard.page').then((m) => m.PlannerDashboardPage),
      },
      {
        path: 'proveedores',
        title: 'Proveedores',
        loadComponent: () =>
          import('./marketplace/marketplace.page').then((m) => m.MarketplacePage),
      },
      {
        path: 'events/new',
        title: 'Nuevo evento',
        loadComponent: () =>
          import('./events/event-create.page').then((m) => m.EventCreatePage),
      },
      {
        path: 'events/:id',
        title: 'Evento',
        loadComponent: () =>
          import('./events/event-detail.page').then((m) => m.EventDetailPage),
      },
      {
        path: 'events/:id/guests',
        title: 'Invitados',
        loadComponent: () =>
          import('./guests-import/event-guests.page').then((m) => m.EventGuestsPage),
      },
      {
        path: 'events/:id/seating',
        title: 'Mesas',
        loadComponent: () =>
          import('./seating/event-seating.page').then((m) => m.EventSeatingPage),
      },
      {
        path: 'events/:id/workers',
        title: 'Proveedores del evento',
        loadComponent: () =>
          import('./workers-hire/event-workers.page').then((m) => m.EventWorkersPage),
      },
    ],
  },
];
