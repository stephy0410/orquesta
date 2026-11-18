import { Injectable, computed, signal } from '@angular/core';
import { UserRole } from '../api/models';

export interface ActiveScanSessionMeta {
  session_id: string;
  session_token: string;
  event_id: string;
  event_nombre?: string;
  rol: string;
  device_id: string;
  expira_en: string;
  roster_version: number;
  revocation_version: number;
  last_sequence: number;
  last_acked_sequence: number;
  etag?: string | null;
  key_publica_pem?: string | null;
  permisos?: string[];
}

const TOKEN_STORAGE_KEY = 'orquesta.session.token';
const EMAIL_STORAGE_KEY = 'orquesta.session.email';
const ROLES_STORAGE_KEY = 'orquesta.session.roles';
const DEVICE_ID_STORAGE_KEY = 'orquesta.device_id';

@Injectable({ providedIn: 'root' })
export class AuthTokenStore {
  readonly accessToken = signal<string | null>(readSessionStorage(TOKEN_STORAGE_KEY));
  readonly userEmail = signal<string | null>(readSessionStorage(EMAIL_STORAGE_KEY));
  readonly userRoles = signal<UserRole[]>(readRolesFromStorage());
  readonly cookieVerifiedRole = signal<UserRole | null>(null);

  readonly scanSession = signal<ActiveScanSessionMeta | null>(null);

  readonly isAuthenticated = computed(
    () => Boolean(this.accessToken()) || this.cookieVerifiedRole() !== null,
  );
  readonly hasScanSession = computed(() => {
    const ses = this.scanSession();
    if (!ses) return false;
    return Date.parse(ses.expira_en) > Date.now();
  });

  setAccountSession(accessToken: string | null, email: string | null, roles: UserRole[]): void {
    this.accessToken.set(accessToken);
    this.userEmail.set(email);
    this.userRoles.set(roles);
    writeSessionStorage(TOKEN_STORAGE_KEY, accessToken);
    writeSessionStorage(EMAIL_STORAGE_KEY, email);
    writeSessionStorage(ROLES_STORAGE_KEY, roles.length > 0 ? JSON.stringify(roles) : null);
  }

  markCookieSessionVerified(role: UserRole): void {
    this.cookieVerifiedRole.set(role);
    if (!this.userRoles().includes(role)) {
      const next = [...this.userRoles(), role];
      this.userRoles.set(next);
      writeSessionStorage(ROLES_STORAGE_KEY, JSON.stringify(next));
    }
  }

  clearAccountSession(): void {
    this.accessToken.set(null);
    this.userEmail.set(null);
    this.userRoles.set([]);
    this.cookieVerifiedRole.set(null);
    writeSessionStorage(TOKEN_STORAGE_KEY, null);
    writeSessionStorage(EMAIL_STORAGE_KEY, null);
    writeSessionStorage(ROLES_STORAGE_KEY, null);
  }

  setScanSession(meta: ActiveScanSessionMeta | null): void {
    this.scanSession.set(meta);
  }

  getOrCreateDeviceId(): string {
    if (typeof window === 'undefined' || !window.localStorage) {
      return `dev_${generateShortId()}`;
    }
    const existing = window.localStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (existing && existing.trim().length > 0) {
      return existing;
    }
    const created = `dev_${generateShortId()}`;
    window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, created);
    return created;
  }
}

function generateShortId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  }
  return Math.random().toString(36).slice(2, 14);
}

function readSessionStorage(key: string): string | null {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return null;
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSessionStorage(key: string, value: string | null): void {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return;
    if (value === null) {
      window.sessionStorage.removeItem(key);
    } else {
      window.sessionStorage.setItem(key, value);
    }
  } catch {
    // Ignore storage quota / privacy mode restrictions
  }
}

function readRolesFromStorage(): UserRole[] {
  const raw = readSessionStorage(ROLES_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as UserRole[]) : [];
  } catch {
    return [];
  }
}
