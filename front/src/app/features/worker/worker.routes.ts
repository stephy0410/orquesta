import { Routes } from '@angular/router';
import { workerGuard } from '../../core/auth/auth.guards';

export const WORKER_ROUTES: Routes = [
  {
    path: 'login',
    title: 'Inicia sesión como proveedor',
    loadComponent: () =>
      import('./worker-auth/worker-login.page').then((m) => m.WorkerLoginPage),
  },
  {
    path: 'register',
    title: 'Regístrate como proveedor',
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
        title: 'Solicitudes',
        loadComponent: () =>
          import('./requests/worker-requests.page').then((m) => m.WorkerRequestsPage),
      },
      {
        path: 'profile',
        title: 'Mi perfil',
        loadComponent: () =>
          import('./profile-otp/worker-profile.page').then((m) => m.WorkerProfilePage),
      },
      {
        path: 'availability',
        title: 'Disponibilidad',
        loadComponent: () =>
          import('./availability/worker-availability.page').then((m) => m.WorkerAvailabilityPage),
      },
    ],
  },
];
