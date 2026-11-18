import { Injectable } from '@angular/core';
import { CheckinVerdict, RosterGuest, SignedRosterResponse } from '../api/models';

export interface ParsedQrPayload {
  invitation_id: string;
  event_id: string;
  token_version?: number;
  key_id?: string;
  typ?: string;
  purpose?: string;
  [k: string]: unknown;
}

export interface OfflineVerifyContext {
  eventId: string;
  publicKeyPem: string;
  rosterByInvitation: ReadonlyMap<string, RosterGuest>;
  revokedIds: ReadonlySet<string>;
  localAdmissions: ReadonlySet<string>;
  revocationsValidUntilMs: number;
  nowMs?: number;
}

export interface QrEvaluationResult {
  validSignature: boolean;
  verdict: CheckinVerdict | null;
  admits: boolean;
  conditional: boolean;
  requiresConditionalConfirm: boolean;
  errorCode?: 'TOKEN_TIPO_INCORRECTO' | 'TOKEN_INVALIDO' | 'MISSING_PUBLIC_KEY';
  message: string;
  invitationId: string | null;
  keyId?: string;
  tokenSha256: string;
  guest?: RosterGuest;
  payload?: ParsedQrPayload;
  durationMs: number;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${entries.join(',')}}`;
}

export function base64UrlToUint8Array(b64u: string): Uint8Array {
  const padded = b64u.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64u.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function base64ToUint8Array(b64: string): Uint8Array {
  return base64UrlToUint8Array(b64.replace(/\s+/g, ''));
}

export function uint8ArrayToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/**
 * Normalizes ECDSA P-256 signatures from either IEEE P1363 (64 bytes, JWS ES256)
 * or ASN.1 DER (SEQUENCE { INTEGER r, INTEGER s }, e.g. AWS KMS / OpenSSL)
 * into 64-byte IEEE P1363 required by Web Crypto SubtleCrypto.verify.
 */
export function normalizeEcdsaSignatureToP1363(sig: Uint8Array): Uint8Array | null {
  if (sig.length === 64) {
    return sig;
  }
  if (sig.length < 8 || sig[0] !== 0x30) {
    return null;
  }

  let offset = 2;
  if (sig[1] & 0x80) {
    const lenBytes = sig[1] & 0x7f;
    offset = 2 + lenBytes;
  }
  if (offset >= sig.length || sig[offset] !== 0x02) {
    return null;
  }
  const rLen = sig[offset + 1];
  const rStart = offset + 2;
  const rEnd = rStart + rLen;
  if (rEnd >= sig.length || sig[rEnd] !== 0x02) {
    return null;
  }
  const sLen = sig[rEnd + 1];
  const sStart = rEnd + 2;
  const sEnd = sStart + sLen;
  if (sEnd > sig.length) {
    return null;
  }

  const r = sig.subarray(rStart, rEnd);
  const s = sig.subarray(sStart, sEnd);

  const out = new Uint8Array(64);
  copyScalarRightAligned(r, out, 0);
  copyScalarRightAligned(s, out, 32);
  return out;
}

function copyScalarRightAligned(src: Uint8Array, dest: Uint8Array, destOffset: number): void {
  let start = 0;
  while (start < src.length && src[start] === 0) {
    start++;
  }
  const trimmed = src.subarray(start);
  if (trimmed.length > 32) {
    dest.set(trimmed.subarray(trimmed.length - 32), destOffset);
  } else {
    dest.set(trimmed, destOffset + (32 - trimmed.length));
  }
}

@Injectable({ providedIn: 'root' })
export class QrVerifierService {
  private readonly keyCache = new Map<string, Promise<CryptoKey>>();

  async sha256Hex(input: string | Uint8Array): Promise<string> {
    const subtle = this.getSubtleCrypto();
    const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    const digest = await subtle.digest('SHA-256', toArrayBuffer(bytes));
    return uint8ArrayToHex(new Uint8Array(digest));
  }

  async importEcdsaPublicKey(pem: string): Promise<CryptoKey> {
    const normalized = pem.trim();
    const cached = this.keyCache.get(normalized);
    if (cached) {
      return cached;
    }

    const promise = (async () => {
      const subtle = this.getSubtleCrypto();
      const body = normalized
        .replace(/-----BEGIN PUBLIC KEY-----/g, '')
        .replace(/-----END PUBLIC KEY-----/g, '')
        .replace(/\s+/g, '');
      const spki = base64ToUint8Array(body);
      return subtle.importKey(
        'spki',
        toArrayBuffer(spki),
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['verify'],
      );
    })();

    this.keyCache.set(normalized, promise);
    try {
      return await promise;
    } catch (err) {
      this.keyCache.delete(normalized);
      throw err;
    }
  }

  async verifyRosterSignature(roster: SignedRosterResponse): Promise<boolean> {
    if (!roster.firma || roster.firma.alg !== 'ES256' || !roster.firma.valor || !roster.key_publica_pem) {
      return false;
    }
    try {
      const subtle = this.getSubtleCrypto();
      const key = await this.importEcdsaPublicKey(roster.key_publica_pem);
      const rawSig = base64ToUint8Array(roster.firma.valor);
      const p1363Sig = normalizeEcdsaSignatureToP1363(rawSig);
      if (!p1363Sig) return false;

      const encoder = new TextEncoder();

      // Backend signs canonical_payload = JSON.stringify({ event_id, evento, roster_version, invitados })
      if (typeof roster.canonical_payload === 'string' && roster.canonical_payload.length > 0) {
        const parsed = JSON.parse(roster.canonical_payload) as Partial<SignedRosterResponse>;
        const matchesRoster =
          parsed.event_id === roster.event_id &&
          parsed.roster_version === roster.roster_version &&
          JSON.stringify(parsed.invitados ?? []) === JSON.stringify(roster.invitados);
        if (!matchesRoster) {
          return false;
        }
        return subtle.verify(
          { name: 'ECDSA', hash: 'SHA-256' },
          key,
          toArrayBuffer(p1363Sig),
          toArrayBuffer(encoder.encode(roster.canonical_payload)),
        );
      }

      const corePayload = JSON.stringify({
        event_id: roster.event_id,
        evento: roster.evento,
        roster_version: roster.roster_version,
        invitados: roster.invitados,
      });
      const okCore = await subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        toArrayBuffer(p1363Sig),
        toArrayBuffer(encoder.encode(corePayload)),
      );
      if (okCore) return true;

      const { firma: _firma, canonical_payload: _cp, ...withoutFirma } = roster;
      const fullCanonical = canonicalJson(withoutFirma);
      const okFull = await subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        toArrayBuffer(p1363Sig),
        toArrayBuffer(encoder.encode(fullCanonical)),
      );
      if (okFull) return true;

      // Also support backends that exclude key_publica_pem from the signed canonical payload
      const { key_publica_pem: _pem, ...withoutFirmaOrPem } = withoutFirma;
      const reducedCanonical = canonicalJson(withoutFirmaOrPem);
      return subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        toArrayBuffer(p1363Sig),
        toArrayBuffer(encoder.encode(reducedCanonical)),
      );
    } catch {
      return false;
    }
  }

  async evaluateQrToken(rawInput: string, ctx: OfflineVerifyContext): Promise<QrEvaluationResult> {
    const startMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const elapsed = () =>
      Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - startMs) * 100) / 100;

    const token = rawInput.trim();
    const tokenSha256 = await this.sha256Hex(token);

    if (!token) {
      return {
        validSignature: false,
        verdict: null,
        admits: false,
        conditional: false,
        requiresConditionalConfirm: false,
        errorCode: 'TOKEN_INVALIDO',
        message: 'Código QR vacío.',
        invitationId: null,
        tokenSha256,
        durationMs: elapsed(),
      };
    }

    if (token.startsWith('rsvp_') || token.includes('#t=')) {
      return {
        validSignature: false,
        verdict: null,
        admits: false,
        conditional: false,
        requiresConditionalConfirm: false,
        errorCode: 'TOKEN_TIPO_INCORRECTO',
        message: 'Este código corresponde al enlace de RSVP, no al QR de check-in (TR-07).',
        invitationId: null,
        tokenSha256,
        durationMs: elapsed(),
      };
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
      return {
        validSignature: false,
        verdict: null,
        admits: false,
        conditional: false,
        requiresConditionalConfirm: false,
        errorCode: 'TOKEN_INVALIDO',
        message: 'Formato de token QR inválido (se esperaba JWS compacto ES256).',
        invitationId: null,
        tokenSha256,
        durationMs: elapsed(),
      };
    }

    let header: { alg?: string; kid?: string; typ?: string };
    let payload: ParsedQrPayload;
    let sigBytes: Uint8Array | null;

    try {
      const headerJson = new TextDecoder().decode(base64UrlToUint8Array(parts[0]));
      const payloadJson = new TextDecoder().decode(base64UrlToUint8Array(parts[1]));
      header = JSON.parse(headerJson) as { alg?: string; kid?: string; typ?: string };
      payload = JSON.parse(payloadJson) as ParsedQrPayload;
      sigBytes = normalizeEcdsaSignatureToP1363(base64UrlToUint8Array(parts[2]));
    } catch {
      return {
        validSignature: false,
        verdict: null,
        admits: false,
        conditional: false,
        requiresConditionalConfirm: false,
        errorCode: 'TOKEN_INVALIDO',
        message: 'No se pudo decodificar el contenido del QR.',
        invitationId: null,
        tokenSha256,
        durationMs: elapsed(),
      };
    }

    if (header.typ === 'rsvp' || payload.typ === 'rsvp' || payload.purpose === 'rsvp') {
      return {
        validSignature: false,
        verdict: null,
        admits: false,
        conditional: false,
        requiresConditionalConfirm: false,
        errorCode: 'TOKEN_TIPO_INCORRECTO',
        message: 'Token de RSVP rechazado en el escáner de check-in (TR-07).',
        invitationId: null,
        tokenSha256,
        durationMs: elapsed(),
      };
    }

    if (header.alg !== 'ES256' || !sigBytes || !payload.invitation_id || !payload.event_id) {
      return {
        validSignature: false,
        verdict: null,
        admits: false,
        conditional: false,
        requiresConditionalConfirm: false,
        errorCode: 'TOKEN_INVALIDO',
        message: 'Algoritmo o claims del QR inválidos.',
        invitationId: null,
        tokenSha256,
        durationMs: elapsed(),
      };
    }

    if (!ctx.publicKeyPem) {
      return {
        validSignature: false,
        verdict: null,
        admits: false,
        conditional: false,
        requiresConditionalConfirm: false,
        errorCode: 'MISSING_PUBLIC_KEY',
        message: 'Falta la clave pública del evento en el almacenamiento local.',
        invitationId: payload.invitation_id,
        tokenSha256,
        durationMs: elapsed(),
      };
    }

    let signatureValid = false;
    try {
      const cryptoKey = await this.importEcdsaPublicKey(ctx.publicKeyPem);
      const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
      signatureValid = await this.getSubtleCrypto().verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        cryptoKey,
        toArrayBuffer(sigBytes),
        toArrayBuffer(signingInput),
      );
    } catch {
      signatureValid = false;
    }

    if (!signatureValid) {
      return {
        validSignature: false,
        verdict: null,
        admits: false,
        conditional: false,
        requiresConditionalConfirm: false,
        errorCode: 'TOKEN_INVALIDO',
        message: 'Firma criptográfica ECDSA P-256 inválida. Acceso rechazado.',
        invitationId: payload.invitation_id,
        tokenSha256,
        durationMs: elapsed(),
      };
    }

    const keyId = payload.key_id ?? header.kid;
    const guest = ctx.rosterByInvitation.get(payload.invitation_id);

    // RF-13 State Machine (after valid signature)
    if (payload.event_id !== ctx.eventId) {
      return {
        validSignature: true,
        verdict: 'no_corresponde_al_evento',
        admits: false,
        conditional: false,
        requiresConditionalConfirm: false,
        message: 'Este QR pertenece a otro evento.',
        invitationId: payload.invitation_id,
        keyId,
        tokenSha256,
        payload,
        durationMs: elapsed(),
      };
    }

    const versionSuperseded =
      guest?.token_version !== undefined &&
      payload.token_version !== undefined &&
      payload.token_version < guest.token_version;

    if (ctx.revokedIds.has(payload.invitation_id) || versionSuperseded) {
      return {
        validSignature: true,
        verdict: 'invitacion_revocada',
        admits: false,
        conditional: false,
        requiresConditionalConfirm: false,
        message: 'Invitación revocada o reemplazada por un QR más reciente.',
        invitationId: payload.invitation_id,
        keyId,
        tokenSha256,
        guest,
        payload,
        durationMs: elapsed(),
      };
    }

    if (ctx.localAdmissions.has(payload.invitation_id)) {
      return {
        validSignature: true,
        verdict: 'ya_registrado',
        admits: false,
        conditional: false,
        requiresConditionalConfirm: false,
        message: 'Invitación ya registrada previamente en este dispositivo.',
        invitationId: payload.invitation_id,
        keyId,
        tokenSha256,
        guest,
        payload,
        durationMs: elapsed(),
      };
    }

    if (!guest) {
      return {
        validSignature: true,
        verdict: 'no_en_roster',
        admits: false,
        conditional: true,
        requiresConditionalConfirm: true,
        message:
          'QR con firma válida, pero el invitado no figura en el roster precargado (puede haberse agregado después).',
        invitationId: payload.invitation_id,
        keyId,
        tokenSha256,
        payload,
        durationMs: elapsed(),
      };
    }

    const nowMs = ctx.nowMs ?? Date.now();
    if (nowMs > ctx.revocationsValidUntilMs) {
      return {
        validSignature: true,
        verdict: 'no_verificable_offline',
        admits: true,
        conditional: true,
        requiresConditionalConfirm: false,
        message:
          'Lista de revocación vencida (> 2 h). Admisión condicional marcada para validar al sincronizar.',
        invitationId: payload.invitation_id,
        keyId,
        tokenSha256,
        guest,
        payload,
        durationMs: elapsed(),
      };
    }

    return {
      validSignature: true,
      verdict: 'admitido',
      admits: true,
      conditional: false,
      requiresConditionalConfirm: false,
      message: `Acceso admitido para ${guest.nombre}.`,
      invitationId: payload.invitation_id,
      keyId,
      tokenSha256,
      guest,
      payload,
      durationMs: elapsed(),
    };
  }

  async evaluateManualGuest(
    guest: RosterGuest,
    ctx: Pick<
      OfflineVerifyContext,
      'revokedIds' | 'localAdmissions' | 'revocationsValidUntilMs' | 'nowMs'
    >,
  ): Promise<QrEvaluationResult> {
    const startMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const elapsed = () =>
      Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - startMs) * 100) / 100;

    const tokenSha256 = await this.sha256Hex(`manual:${guest.invitation_id}:${guest.codigo_corto}`);

    if (ctx.revokedIds.has(guest.invitation_id)) {
      return {
        validSignature: true,
        verdict: 'invitacion_revocada',
        admits: false,
        conditional: false,
        requiresConditionalConfirm: false,
        message: 'La invitación está revocada en la lista local.',
        invitationId: guest.invitation_id,
        keyId: guest.token_key_id,
        tokenSha256,
        guest,
        durationMs: elapsed(),
      };
    }

    if (ctx.localAdmissions.has(guest.invitation_id)) {
      return {
        validSignature: true,
        verdict: 'ya_registrado',
        admits: false,
        conditional: false,
        requiresConditionalConfirm: false,
        message: `${guest.nombre} ya fue registrado previamente en este dispositivo.`,
        invitationId: guest.invitation_id,
        keyId: guest.token_key_id,
        tokenSha256,
        guest,
        durationMs: elapsed(),
      };
    }

    const nowMs = ctx.nowMs ?? Date.now();
    if (nowMs > ctx.revocationsValidUntilMs) {
      return {
        validSignature: true,
        verdict: 'no_verificable_offline',
        admits: true,
        conditional: true,
        requiresConditionalConfirm: false,
        message: 'Admisión manual condicional (lista de revocación > 2 h).',
        invitationId: guest.invitation_id,
        keyId: guest.token_key_id,
        tokenSha256,
        guest,
        durationMs: elapsed(),
      };
    }

    return {
      validSignature: true,
      verdict: 'admitido',
      admits: true,
      conditional: false,
      requiresConditionalConfirm: false,
      message: `Acceso manual admitido para ${guest.nombre}.`,
      invitationId: guest.invitation_id,
      keyId: guest.token_key_id,
      tokenSha256,
      guest,
      durationMs: elapsed(),
    };
  }

  private getSubtleCrypto(): SubtleCrypto {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
      throw new Error('Web Crypto SubtleCrypto no está disponible (requiere HTTPS o localhost).');
    }
    return subtle;
  }
}
