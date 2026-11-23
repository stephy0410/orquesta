import { Routes } from '@angular/router';
import { InvitationPage } from './features/invitation/invitation.page';

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
    // Ruta pública con NFR de LCP (FR1, issue #8): va en el bundle inicial para ahorrar un viaje
    // de red en 4G. Pesa ~4 KB comprimido; planner, proveedor y escáner siguen en carga diferida.
    path: 'invitacion',
    title: 'Tu invitación',
    component: InvitationPage,
  },
  {
    path: 'scan',
    loadChildren: () =>
      import('./features/scanner/scanner.routes').then((m) => m.SCANNER_ROUTES),
  },
  {
    path: 'privacidad',
    title: 'Aviso de privacidad',
    loadComponent: () =>
      import('./features/privacy/privacy.page').then((m) => m.PrivacyPage),
  },
  {
    path: '**',
    redirectTo: '',
  },
];
