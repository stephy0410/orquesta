import { Routes } from '@angular/router';
import { workerGuard } from '../../core/auth/auth.guards';

export const WORKER_ROUTES: Routes = [
  {
    path: 'login',
    loadComponent: () =>
      import('./worker-auth/worker-login.page').then((m) => m.WorkerLoginPage),
  },
  {
    path: 'register',
    loadComponent: () =>
      import('./worker-auth/worker-register.page').then((m) => m.WorkerRegisterPage),
  },
  {
    path: '',
    canActivate: [workerGuard],
    loadComponent: () =>
      import('./worker-shell/worker-shell.component').then((m) => m.WorkerShellComponent),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'requests' },
      {
        path: 'requests',
        loadComponent: () =>
          import('./requests/worker-requests.page').then((m) => m.WorkerRequestsPage),
      },
      {
        path: 'profile',
        loadComponent: () =>
          import('./profile-otp/worker-profile.page').then((m) => m.WorkerProfilePage),
      },
      {
        path: 'availability',
        loadComponent: () =>
          import('./availability/worker-availability.page').then((m) => m.WorkerAvailabilityPage),
      },
    ],
  },
];
