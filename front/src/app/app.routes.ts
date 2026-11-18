import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./features/home/home.page').then((m) => m.HomePage),
  },
  {
    path: 'planner',
    loadChildren: () =>
      import('./features/planner/planner.routes').then((m) => m.PLANNER_ROUTES),
  },
  {
    path: 'worker',
    loadChildren: () =>
      import('./features/worker/worker.routes').then((m) => m.WORKER_ROUTES),
  },
  {
    path: 'invitacion',
    loadComponent: () =>
      import('./features/invitation/invitation.page').then((m) => m.InvitationPage),
  },
  {
    path: 'scan',
    loadChildren: () =>
      import('./features/scanner/scanner.routes').then((m) => m.SCANNER_ROUTES),
  },
  {
    path: '**',
    redirectTo: '',
  },
];
