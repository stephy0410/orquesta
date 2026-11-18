import { HttpErrorResponse } from '@angular/common/http';
import { InjectionToken } from '@angular/core';
import { environment } from '../../../environments/environment';

declare global {
  interface Window {
    __ORQUESTA_API__?: string | { baseUrl?: string };
  }
}

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'EVENT_STATE_INVALID'
  | 'AUTH_REQUIRED'
  | 'INVALID_CREDENTIALS'
  | 'EMAIL_NOT_VERIFIED'
  | 'FORBIDDEN_EVENT_SCOPE'
  | 'EMAIL_YA_REGISTRADA'
  | 'NOT_FOUND'
  | 'GUEST_SIN_CLAVE'
  | 'GUEST_CLAVE_INVALIDA'
  | 'GUEST_DUPLICADO'
  | 'AFORO_EXCEDIDO'
  | 'IMPORT_FILAS_EXCEDIDAS'
  | 'CONFIRMACION_REQUERIDA'
  | 'SIN_DESTINATARIOS_PENDIENTES'
  | 'MESA_SIN_CAPACIDAD'
  | 'WINDOW_NOT_AVAILABLE'
  | 'RESERVATION_OVERLAP'
  | 'TRABAJADOR_SIN_TARIFA'
  | 'CORRECTION_WINDOW_CLOSED'
  | 'INVITACION_REVOCADA'
  | 'TOKEN_INVALIDO'
  | 'TOKEN_TIPO_INCORRECTO'
  | 'IDEMPOTENCY_CONFLICT'
  | 'PROFILE_NOT_VERIFIED'
  | 'RESERVATION_NOT_PENDING'
  | 'RESERVATION_NOT_ACCEPTED'
  | 'PLAZAS_INVALIDAS'
  | 'REQUEST_EXPIRED'
  | 'CHECKIN_NOT_FOUND'
  | 'BATCH_TOO_LARGE'
  | 'BATCH_CHECKSUM_MISMATCH'
  | 'BATCH_OUT_OF_ORDER'
  | 'RATE_LIMITED'
  | 'NETWORK_ERROR'
  | 'UNKNOWN_ERROR';

export interface ApiErrorEnvelope {
  error: {
    code: ApiErrorCode | string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export class OrquestaApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | string;
  readonly details: Record<string, unknown>;

  constructor(
    status: number,
    code: ApiErrorCode | string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'OrquestaApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function resolveApiBaseUrl(): string {
  let raw = environment.apiBaseUrl ?? '';
  if (typeof window !== 'undefined' && window.__ORQUESTA_API__ !== undefined) {
    const runtime = window.__ORQUESTA_API__;
    if (typeof runtime === 'string') {
      raw = runtime;
    } else if (runtime && typeof runtime.baseUrl === 'string') {
      raw = runtime.baseUrl;
    }
  }
  return raw.replace(/\/+$/, '');
}

export function buildApiUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

export const ORQUESTA_API_BASE_URL = new InjectionToken<string>('ORQUESTA_API_BASE_URL', {
  providedIn: 'root',
  factory: () => resolveApiBaseUrl(),
});

export function parseApiError(err: unknown): OrquestaApiError {
  if (err instanceof OrquestaApiError) {
    return err;
  }
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) {
      return new OrquestaApiError(
        0,
        'NETWORK_ERROR',
        'No se pudo conectar con el servidor de Orquesta. Verifica tu conexión.',
      );
    }
    const body = err.error as Partial<ApiErrorEnvelope> | null | undefined;
    if (body && typeof body === 'object' && body.error && typeof body.error === 'object') {
      const env = body.error;
      return new OrquestaApiError(
        err.status,
        env.code || 'UNKNOWN_ERROR',
        env.message || err.message || 'Error en la solicitud.',
        env.details ?? {},
      );
    }
    const fallbackMessage =
      typeof err.error === 'string' && err.error.trim().length > 0
        ? err.error
        : err.message || `Error HTTP ${err.status}`;
    return new OrquestaApiError(err.status, mapStatusToDefaultCode(err.status), fallbackMessage);
  }
  if (err instanceof Error) {
    return new OrquestaApiError(500, 'UNKNOWN_ERROR', err.message);
  }
  return new OrquestaApiError(500, 'UNKNOWN_ERROR', 'Error inesperado.');
}

function mapStatusToDefaultCode(status: number): ApiErrorCode {
  switch (status) {
    case 401:
      return 'AUTH_REQUIRED';
    case 403:
      return 'FORBIDDEN_EVENT_SCOPE';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'IDEMPOTENCY_CONFLICT';
    case 422:
      return 'VALIDATION_ERROR';
    case 429:
      return 'RATE_LIMITED';
    default:
      return 'UNKNOWN_ERROR';
  }
}
