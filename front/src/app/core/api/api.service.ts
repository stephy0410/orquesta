import { HttpClient, HttpContext, HttpErrorResponse, HttpHeaders, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, firstValueFrom, map, of, throwError } from 'rxjs';
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

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  newIdempotencyKey(): string {
    return generateUuidV4();
  }

  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return firstValueFrom(
      this.http.get<T>(path, this.buildAngularOptions(options)),
    );
  }

  getConditional<T>(path: string, ifNoneMatch?: string | null, options?: RequestOptions): Promise<ConditionalResult<T>> {
    const mergedHeaders: Record<string, string> = { ...(options?.headers ?? {}) };
    if (ifNoneMatch) {
      mergedHeaders['If-None-Match'] = ifNoneMatch;
    }
    const angularOpts = this.buildAngularOptions({ ...options, headers: mergedHeaders });

    return firstValueFrom(
      this.http
        .get<T>(path, { ...angularOpts, observe: 'response' })
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
      this.http.post<T>(path, body, this.buildAngularOptions(options)),
    );
  }

  postMultipart<T>(path: string, formData: FormData, options?: RequestOptions): Promise<T> {
    return firstValueFrom(
      this.http.post<T>(path, formData, this.buildAngularOptions(options)),
    );
  }

  put<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
    return firstValueFrom(
      this.http.put<T>(path, body, this.buildAngularOptions(options)),
    );
  }

  patch<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
    return firstValueFrom(
      this.http.patch<T>(path, body, this.buildAngularOptions(options)),
    );
  }

  delete<T>(path: string, options?: RequestOptions): Promise<T> {
    return firstValueFrom(
      this.http.delete<T>(path, this.buildAngularOptions(options)),
    );
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
