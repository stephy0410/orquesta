import { HttpClient, HttpContext, HttpErrorResponse, HttpHeaders, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, firstValueFrom, map, of, retry, throwError, timer } from 'rxjs';
import { IS_PUBLIC_INVITATION, IS_SCAN_REQUEST, SKIP_IDEMPOTENCY, generateUuidV4 } from './api.interceptor';

export interface RequestOptions {
  params?: Record<string, string | number | boolean | readonly string[] | undefined | null>;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  publicNoCookies?: boolean;
  scanSession?: boolean;
  skipIdempotency?: boolean;
}

export interface ConditionalResult<T> {
  notModified: boolean;
  etag: string | null;
  body: T | null;
}

/**
 * Reintentos ante saturación momentánea (pico de tráfico, límite de concurrencia de Lambda).
 * Lecturas: 429/502/503/504. Escrituras: solo con llave de idempotencia propia y solo 429/503,
 * que garantizan que el servidor no ejecutó la petición; así un reintento nunca duplica nada.
 */
const READ_RETRY_STATUS = new Set([429, 502, 503, 504]);
const WRITE_RETRY_STATUS = new Set([429, 503]);
const MAX_RETRIES = 3;
export const RETRY_BASE_MS = { value: 400 };

function statusOf(err: unknown): number {
  return typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : -1;
}

function withRetry<T>(source: Observable<T>, retryable: ReadonlySet<number>): Observable<T> {
  return source.pipe(
    retry({
      count: MAX_RETRIES,
      delay: (err: unknown, attempt: number) => {
        if (!retryable.has(statusOf(err))) return throwError(() => err);
        // Backoff exponencial con jitter: los clientes no vuelven todos al mismo tiempo.
        const base = RETRY_BASE_MS.value * 2 ** (attempt - 1);
        return timer(base + Math.random() * RETRY_BASE_MS.value);
      },
    }),
  );
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  newIdempotencyKey(): string {
    return generateUuidV4();
  }

  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return firstValueFrom(
      withRetry(this.http.get<T>(path, this.buildAngularOptions(options)), READ_RETRY_STATUS),
    );
  }

  getConditional<T>(path: string, ifNoneMatch?: string | null, options?: RequestOptions): Promise<ConditionalResult<T>> {
    const mergedHeaders: Record<string, string> = { ...(options?.headers ?? {}) };
    if (ifNoneMatch) {
      mergedHeaders['If-None-Match'] = ifNoneMatch;
    }
    const angularOpts = this.buildAngularOptions({ ...options, headers: mergedHeaders });

    return firstValueFrom(
      withRetry(this.http.get<T>(path, { ...angularOpts, observe: 'response' }), READ_RETRY_STATUS)
        .pipe(
          map((res) => ({
            notModified: false,
            etag: res.headers.get('ETag'),
            body: res.body,
          })),
          catchError((err: unknown): Observable<ConditionalResult<T>> => {
            if (err instanceof HttpErrorResponse && err.status === 304) {
              return of({
                notModified: true,
                etag: err.headers.get('ETag') ?? ifNoneMatch ?? null,
                body: null,
              });
            }
            return throwError(() => err);
          }),
        ),
    );
  }

  post<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
    return firstValueFrom(
      this.writeRetry(this.http.post<T>(path, body, this.buildAngularOptions(options)), options),
    );
  }

  postMultipart<T>(path: string, formData: FormData, options?: RequestOptions): Promise<T> {
    return firstValueFrom(
      this.http.post<T>(path, formData, this.buildAngularOptions(options)),
    );
  }

  put<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
    return firstValueFrom(
      this.writeRetry(this.http.put<T>(path, body, this.buildAngularOptions(options)), options),
    );
  }

  patch<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
    return firstValueFrom(
      this.writeRetry(this.http.patch<T>(path, body, this.buildAngularOptions(options)), options),
    );
  }

  delete<T>(path: string, options?: RequestOptions): Promise<T> {
    return firstValueFrom(
      this.writeRetry(this.http.delete<T>(path, this.buildAngularOptions(options)), options),
    );
  }

  private writeRetry<T>(source: Observable<T>, options?: RequestOptions): Observable<T> {
    return options?.idempotencyKey ? withRetry(source, WRITE_RETRY_STATUS) : source;
  }

  private buildAngularOptions(options?: RequestOptions): {
    params?: HttpParams;
    headers?: HttpHeaders;
    context: HttpContext;
  } {
    let params = new HttpParams();
    if (options?.params) {
      for (const [key, value] of Object.entries(options.params)) {
        if (value === undefined || value === null || value === '') continue;
        if (Array.isArray(value)) {
          for (const item of value) {
            if (item !== undefined && item !== null && item !== '') {
              params = params.append(key, String(item));
            }
          }
        } else {
          params = params.set(key, String(value));
        }
      }
    }

    let headers = new HttpHeaders(options?.headers ?? {});
    if (options?.idempotencyKey && !headers.has('Idempotency-Key')) {
      headers = headers.set('Idempotency-Key', options.idempotencyKey);
    }

    const context = new HttpContext();
    if (options?.publicNoCookies) {
      context.set(IS_PUBLIC_INVITATION, true);
    }
    if (options?.scanSession) {
      context.set(IS_SCAN_REQUEST, true);
    }
    if (options?.skipIdempotency) {
      context.set(SKIP_IDEMPOTENCY, true);
    }

    return { params, headers, context };
  }
}
