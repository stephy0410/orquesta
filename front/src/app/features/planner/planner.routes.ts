import { Routes } from '@angular/router';
import { plannerGuard } from '../../core/auth/auth.guards';

export const PLANNER_ROUTES: Routes = [
  {
    path: 'login',
    loadComponent: () =>
      import('./planner-auth/planner-login.page').then((m) => m.PlannerLoginPage),
  },
  {
    path: 'register',
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
        loadComponent: () =>
          import('./dashboard/planner-dashboard.page').then((m) => m.PlannerDashboardPage),
      },
      {
        path: 'proveedores',
        title: 'Proveedores · Orquesta',
        loadComponent: () =>
          import('./marketplace/marketplace.page').then((m) => m.MarketplacePage),
      },
      {
        path: 'events/new',
        loadComponent: () =>
          import('./events/event-create.page').then((m) => m.EventCreatePage),
      },
      {
        path: 'events/:id',
        loadComponent: () =>
          import('./events/event-detail.page').then((m) => m.EventDetailPage),
      },
      {
        path: 'events/:id/guests',
        loadComponent: () =>
          import('./guests-import/event-guests.page').then((m) => m.EventGuestsPage),
      },
      {
        path: 'events/:id/seating',
        loadComponent: () =>
          import('./seating/event-seating.page').then((m) => m.EventSeatingPage),
      },
      {
        path: 'events/:id/workers',
        loadComponent: () =>
          import('./workers-hire/event-workers.page').then((m) => m.EventWorkersPage),
      },
    ],
  },
];
