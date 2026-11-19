import { Injectable, inject } from '@angular/core';
import { ApiService } from '../api/api.service';
import { OrquestaApiError } from '../api/api-config';
import { UserRole, WorkerTipo } from '../api/models';
import { ScanStorageService } from '../storage/scan-storage.service';
import { ActiveScanSessionMeta, AuthTokenStore } from './auth-token.store';

export interface LoginResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export interface RegisterPlannerResponse {
  user_id: string;
  email: string;
  email_verificado: boolean;
}

export interface RegisterWorkerResponse {
  user_id: string;
  estado_email: string;
}

export interface EventSessionResponse {
  session_token: string;
  event_id: string;
  rol: string;
  expira_en: string;
}

export interface CreateScanSessionResponse {
  session_id: string;
  event_id: string;
  rol: string;
  roster_version: number;
  revocation_version: number;
  expira_en: string;
  permisos?: string[];
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly api = inject(ApiService);
  private readonly tokenStore = inject(AuthTokenStore);
  private readonly scanStorage = inject(ScanStorageService);

  readonly accessToken = this.tokenStore.accessToken;
  readonly userEmail = this.tokenStore.userEmail;
  readonly userRoles = this.tokenStore.userRoles;
  readonly isAuthenticated = this.tokenStore.isAuthenticated;
  readonly scanSession = this.tokenStore.scanSession;

  async registerPlanner(email: string, password: string): Promise<RegisterPlannerResponse> {
    return this.api.post<RegisterPlannerResponse>(
      '/v1/auth/register',
      { email, password },
      { skipIdempotency: true },
    );
  }

  async registerWorker(
    email: string,
    password: string,
    tipo: WorkerTipo,
  ): Promise<RegisterWorkerResponse> {
    return this.api.post<RegisterWorkerResponse>('/v1/auth/worker/register', {
      email,
      password,
      tipo,
    });
  }

  async verifyEmail(token: string): Promise<{ email_verificado: boolean }> {
    return this.api.post<{ email_verificado: boolean }>(
      '/v1/auth/verify-email',
      { token },
      { skipIdempotency: true },
    );
  }

  async requestPasswordReset(email: string): Promise<void> {
    await this.api.post('/v1/auth/password-reset', { email }, { skipIdempotency: true });
  }

  async confirmPasswordReset(token: string, password: string): Promise<void> {
    await this.api.post(
      '/v1/auth/password-reset/confirm',
      { token, password },
      { skipIdempotency: true },
    );
  }

  async login(email: string, password: string, expectedRole: UserRole): Promise<LoginResponse> {
    const res = await this.api.post<LoginResponse>(
      '/v1/auth/login',
      { email, password },
      { skipIdempotency: true },
    );

    const decodedRoles = decodeJwtRoles(res.access_token);
    const serverRoles = ((res as { user?: { roles?: string[] } }).user?.roles ?? []).filter(
      (r): r is UserRole => r === 'planner' || r === 'worker',
    );
    const known = decodedRoles.length > 0 ? decodedRoles : serverRoles;
    if (known.length > 0 && !known.includes(expectedRole)) {
      // Cuenta válida pero de otro tipo: no la dejamos entrar a esta área.
      try {
        await this.api.post('/v1/auth/logout', {}, { skipIdempotency: true });
      } catch {
        // La sesión de servidor puede no existir todavía.
      }
      this.tokenStore.clearAccountSession();
      throw new OrquestaApiError(
        403,
        'ROL_INCORRECTO',
        expectedRole === 'planner'
          ? 'Esta cuenta es de proveedor. Entra desde «Soy proveedor».'
          : 'Esta cuenta es de planner. Entra desde «Soy planner».',
      );
    }
    const roles: UserRole[] = known.length > 0 ? known : [expectedRole];

    this.tokenStore.setAccountSession(res.access_token ?? null, email, roles);
    this.tokenStore.markCookieSessionVerified(expectedRole);
    return res;
  }

  async logout(): Promise<void> {
    try {
      await this.api.post('/v1/auth/logout', {}, { skipIdempotency: true });
    } catch {
      // Always clear local session even if server cookie already expired
    } finally {
      this.tokenStore.clearAccountSession();
    }
  }

  async ensureAuthenticated(role: UserRole): Promise<boolean> {
    const roles = this.tokenStore.userRoles();
    if (roles.length > 0 && !roles.includes(role)) {
      return false;
    }
    if (this.tokenStore.accessToken() || this.tokenStore.cookieVerifiedRole() === role) {
      return true;
    }
    try {
      if (role === 'planner') {
        await this.api.get('/v1/dashboard', { params: { limit: 1 } });
      } else {
        await this.api.get('/v1/worker/profile');
      }
      this.tokenStore.markCookieSessionVerified(role);
      return true;
    } catch (err) {
      if (err instanceof OrquestaApiError && role === 'worker' && err.status === 404) {
        // Authenticated worker who has not created WorkerProfile yet
        this.tokenStore.markCookieSessionVerified('worker');
        return true;
      }
      return false;
    }
  }

  /**
   * Canjea un EventAccessToken (QR de acceso al evento, RF-19 / TR-19) y crea la ScanSession local.
   */
  async redeemEventAccessToken(accessToken: string): Promise<ActiveScanSessionMeta> {
    const deviceId = this.tokenStore.getOrCreateDeviceId();
    const exchanged = await this.api.post<EventSessionResponse>(
      '/v1/auth/event-session',
      { access_token: accessToken.trim(), device_id: deviceId },
      { skipIdempotency: true, publicNoCookies: true },
    );

    const created = await this.api.post<CreateScanSessionResponse>(
      '/v1/scan-sessions',
      { event_id: exchanged.event_id, device_id: deviceId },
      {
        scanSession: true,
        headers: { Authorization: `Bearer ${exchanged.session_token}` },
      },
    );

    const meta: ActiveScanSessionMeta = {
      session_id: created.session_id,
      session_token: exchanged.session_token,
      event_id: created.event_id,
      rol: created.rol ?? exchanged.rol,
      device_id: deviceId,
      expira_en: created.expira_en ?? exchanged.expira_en,
      roster_version: created.roster_version,
      revocation_version: created.revocation_version,
      last_sequence: 0,
      last_acked_sequence: 0,
      permisos: created.permisos ?? ['roster', 'checkin'],
    };

    const persisted = await this.scanStorage.initSession(meta);
    this.tokenStore.setScanSession(persisted);
    return persisted;
  }

  /**
   * Abre una ScanSession usando la cuenta ya autenticada (StaffAssignment, RF-19).
   */
  async openScanSessionFromAccount(eventId: string): Promise<ActiveScanSessionMeta> {
    const deviceId = this.tokenStore.getOrCreateDeviceId();
    const created = await this.api.post<CreateScanSessionResponse>(
      '/v1/scan-sessions',
      { event_id: eventId.trim(), device_id: deviceId },
    );

    const meta: ActiveScanSessionMeta = {
      session_id: created.session_id,
      session_token: this.tokenStore.accessToken() ?? '',
      event_id: created.event_id,
      rol: created.rol,
      device_id: deviceId,
      expira_en: created.expira_en,
      roster_version: created.roster_version,
      revocation_version: created.revocation_version,
      last_sequence: 0,
      last_acked_sequence: 0,
      permisos: created.permisos ?? ['roster', 'checkin', 'anulacion'],
    };

    const persisted = await this.scanStorage.initSession(meta);
    this.tokenStore.setScanSession(persisted);
    return persisted;
  }

  async hydrateScanSession(): Promise<ActiveScanSessionMeta | null> {
    const inMemory = this.tokenStore.scanSession();
    if (inMemory) {
      return inMemory;
    }
    try {
      const stored = await this.scanStorage.getActiveSession();
      if (stored) {
        this.tokenStore.setScanSession(stored);
        await this.scanStorage.refreshStats();
      }
      return stored;
    } catch {
      return null;
    }
  }

  async closeScanSession(): Promise<void> {
    await this.scanStorage.clearSession();
    this.tokenStore.setScanSession(null);
  }
}

function decodeJwtRoles(token: string | undefined | null): UserRole[] {
  if (!token || token.split('.').length !== 3) return [];
  try {
    const payloadPart = token.split('.')[1];
    const padded =
      payloadPart.replace(/-/g, '+').replace(/_/g, '/') +
      '='.repeat((4 - (payloadPart.length % 4)) % 4);
    const decoded = JSON.parse(atob(padded)) as { roles?: unknown };
    if (Array.isArray(decoded.roles)) {
      return decoded.roles.filter(
        (r): r is UserRole => r === 'planner' || r === 'worker',
      );
    }
  } catch {
    // Ignore non-JWT tokens
  }
  return [];
}
