import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

export const plannerGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const ok = await auth.ensureAuthenticated('planner');
  if (ok) {
    return true;
  }
  return router.createUrlTree(['/planner/login'], {
    queryParams: { redirect: state.url },
  });
};

export const workerGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const ok = await auth.ensureAuthenticated('worker');
  if (ok) {
    return true;
  }
  return router.createUrlTree(['/worker/login'], {
    queryParams: { redirect: state.url },
  });
};

export const scanSessionGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const session = await auth.hydrateScanSession();
  if (session) {
    return true;
  }
  return router.createUrlTree(['/scan']);
};
