import { HttpContextToken, HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { AuthTokenStore } from '../auth/auth-token.store';
import { buildApiUrl, ORQUESTA_API_BASE_URL, parseApiError } from './api-config';

export const IS_PUBLIC_INVITATION = new HttpContextToken<boolean>(() => false);
export const IS_SCAN_REQUEST = new HttpContextToken<boolean>(() => false);
export const SKIP_IDEMPOTENCY = new HttpContextToken<boolean>(() => false);

const NON_MUTATING_AUTH_PATHS = [
  '/v1/auth/login',
  '/v1/auth/logout',
  '/v1/auth/verify-email',
  '/v1/auth/password-reset',
  '/v1/auth/password-reset/confirm',
  '/v1/auth/event-session',
];

export function generateUuidV4(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function isApiPath(url: string): boolean {
  return url.startsWith('/v1/') || url === '/health' || /\/v1\//.test(url);
}

function shouldInjectIdempotencyKey(method: string, url: string, skip: boolean): boolean {
  if (skip || method.toUpperCase() !== 'POST') {
    return false;
  }
  return !NON_MUTATING_AUTH_PATHS.some((p) => url.includes(p));
}

export const apiInterceptor: HttpInterceptorFn = (req, next) => {
  const baseUrl = inject(ORQUESTA_API_BASE_URL);
  const tokenStore = inject(AuthTokenStore);

  const isPublic = req.context.get(IS_PUBLIC_INVITATION) || req.url.includes('/v1/public/');
  const isScan =
    req.context.get(IS_SCAN_REQUEST) || req.url.includes('/v1/scan-sessions');
  const skipIdempotency = req.context.get(SKIP_IDEMPOTENCY);

  const resolvedUrl =
    req.url.startsWith('/v1/') || req.url === '/health'
      ? buildApiUrl(baseUrl, req.url)
      : req.url;

  let headers = req.headers;

  if (!isPublic && !headers.has('Authorization')) {
    const scanToken = tokenStore.scanSession()?.session_token ?? null;
    const accountToken = tokenStore.accessToken();
    const bearer = isScan ? (scanToken ?? accountToken) : accountToken;
    if (bearer) {
      headers = headers.set('Authorization', `Bearer ${bearer}`);
    }
  }

  if (
    shouldInjectIdempotencyKey(req.method, resolvedUrl, skipIdempotency) &&
    !headers.has('Idempotency-Key')
  ) {
    headers = headers.set('Idempotency-Key', generateUuidV4());
  }

  const shouldSendCredentials = !isPublic && isApiPath(resolvedUrl);

  const cloned = req.clone({
    url: resolvedUrl,
    headers,
    withCredentials: shouldSendCredentials ? true : req.withCredentials,
  });

  return next(cloned).pipe(
    catchError((err: unknown) => {
      // Preserve 304 Not Modified responses for ETag conditional GETs
      if (err instanceof HttpErrorResponse && err.status === 304) {
        return throwError(() => err);
      }
      const mapped = parseApiError(err);
      if (mapped.status === 401 && mapped.code === 'AUTH_REQUIRED' && !isPublic) {
        if (!isScan) {
          tokenStore.cookieVerifiedRole.set(null);
        }
      }
      return throwError(() => mapped);
    }),
  );
};
