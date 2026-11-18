import { Routes } from '@angular/router';
import { scanSessionGuard } from '../../core/auth/auth.guards';

export const SCANNER_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./scanner-setup/scanner-setup.page').then((m) => m.ScannerSetupPage),
  },
  {
    path: 'terminal',
    canActivate: [scanSessionGuard],
    loadComponent: () =>
      import('./scanner-terminal/scanner-terminal.page').then((m) => m.ScannerTerminalPage),
  },
];
