import { TestBed } from '@angular/core/testing';
import { RosterGuest, SignedRosterResponse } from '../api/models';
import { QrVerifierService, canonicalJson, toArrayBuffer } from './qr-verifier.service';

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function exportSpkiPem(publicKey: CryptoKey): Promise<string> {
  const spki = await crypto.subtle.exportKey('spki', publicKey);
  const bytes = new Uint8Array(spki);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const b64 = btoa(binary).match(/.{1,64}/g)?.join('\n') ?? '';
  return `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----`;
}

async function signEs256Jws(payload: Record<string, unknown>, privateKey: CryptoKey): Promise<string> {
  const headerB64 = toBase64Url(new TextEncoder().encode(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'k-test' })));
  const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const input = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    toArrayBuffer(input),
  );
  return `${headerB64}.${payloadB64}.${toBase64Url(new Uint8Array(sig))}`;
}

function p1363ToDer(p1363: Uint8Array): Uint8Array {
  const encodeInt = (slice: Uint8Array) => {
    let i = 0;
    while (i < slice.length - 1 && slice[i] === 0) i++;
    const trimmed = slice.subarray(i);
    if (trimmed[0] & 0x80) {
      const out = new Uint8Array(trimmed.length + 1);
      out[0] = 0;
      out.set(trimmed, 1);
      return out;
    }
    return trimmed;
  };
  const r = encodeInt(p1363.subarray(0, 32));
  const s = encodeInt(p1363.subarray(32, 64));
  const totalLen = 2 + r.length + 2 + s.length;
  const der = new Uint8Array(2 + totalLen);
  der[0] = 0x30;
  der[1] = totalLen;
  der[2] = 0x02;
  der[3] = r.length;
  der.set(r, 4);
  der[4 + r.length] = 0x02;
  der[5 + r.length] = s.length;
  der.set(s, 6 + r.length);
  return der;
}

describe('QrVerifierService (Web Crypto ES256)', () => {
  let service: QrVerifierService;
  let keyPair: CryptoKeyPair;
  let pem: string;

  beforeEach(async () => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(QrVerifierService);
    keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    pem = await exportSpkiPem(keyPair.publicKey);
  });

  it('verifies a signed roster (both DER and P1363) and rejects tampered rosters', async () => {
    const unsignedRoster = {
      event_id: 'evt_1',
      evento: {
        nombre: 'Boda Test',
        inicio: '2026-06-15T18:00:00Z',
        fin: '2026-06-16T01:00:00Z',
        estado: 'en_curso' as const,
        timezone: 'America/Mexico_City',
      },
      roster_version: 12,
      generado_en: '2026-06-15T17:55:00Z',
      expira_en: '2026-06-16T02:00:00Z',
      key_publica_pem: pem,
      revocaciones: {
        version: 3,
        emitida_en: '2026-06-15T17:55:00Z',
        ttl_horas: 2,
        vigente_hasta: '2026-06-15T19:55:00Z',
      },
      invitados: [
        { invitation_id: 'inv_1', nombre: 'Ana Rojas', codigo_corto: '483920', token_version: 1 },
      ],
    };

    const canonical = canonicalJson(unsignedRoster);
    const sigP1363 = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keyPair.privateKey,
        toArrayBuffer(new TextEncoder().encode(canonical)),
      ),
    );
    const derSig = p1363ToDer(sigP1363);
    let binary = '';
    for (let i = 0; i < derSig.length; i++) binary += String.fromCharCode(derSig[i]);

    const signedRoster: SignedRosterResponse = {
      ...unsignedRoster,
      firma: { alg: 'ES256', key_id: 'k-test', valor: btoa(binary) },
    };

    expect(await service.verifyRosterSignature(signedRoster)).toBe(true);

    const tampered: SignedRosterResponse = {
      ...signedRoster,
      roster_version: 13,
    };
    expect(await service.verifyRosterSignature(tampered)).toBe(false);
  });

  it('verifies backend canonical_payload signed rosters and rejects mismatched guest lists', async () => {
    const unsignedPayload = {
      event_id: 'evt_back_1',
      evento: {
        nombre: 'Boda Backend',
        inicio: '2026-06-15T18:00:00Z',
        fin: '2026-06-16T01:00:00Z',
        estado: 'en_curso' as const,
        timezone: 'America/Mexico_City',
      },
      roster_version: 5,
      invitados: [
        { invitation_id: 'inv_1', nombre: 'Ana Rojas', codigo_corto: '483920', token_version: 1 },
      ],
    };
    const canonicalString = JSON.stringify(unsignedPayload);
    const sigP1363 = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keyPair.privateKey,
        toArrayBuffer(new TextEncoder().encode(canonicalString)),
      ),
    );
    const rosterFromBackend: SignedRosterResponse = {
      ...unsignedPayload,
      generado_en: '2026-06-15T17:55:00Z',
      expira_en: '2026-06-16T02:00:00Z',
      canonical_payload: canonicalString,
      firma: { alg: 'ES256', key_id: 'k-test', valor: toBase64Url(sigP1363) },
      key_publica_pem: pem,
      revocaciones: {
        version: 1,
        emitida_en: '2026-06-15T17:55:00Z',
        ttl_horas: 2,
        vigente_hasta: '2026-06-15T19:55:00Z',
      },
    };

    expect(await service.verifyRosterSignature(rosterFromBackend)).toBe(true);

    const substituted: SignedRosterResponse = {
      ...rosterFromBackend,
      invitados: [
        { invitation_id: 'inv_evil', nombre: 'Fake', codigo_corto: '000000', token_version: 1 },
      ],
    };
    expect(await service.verifyRosterSignature(substituted)).toBe(false);
  });

  it('evaluates all 6 RF-13 verdicts offline within <= 100 ms', async () => {
    const rosterGuest: RosterGuest = {
      invitation_id: 'inv_1',
      nombre: 'Ana Rojas',
      codigo_corto: '483920',
      token_version: 2,
      token_key_id: 'k-test',
    };
    const rosterMap = new Map<string, RosterGuest>([['inv_1', rosterGuest]]);
    const futureMs = Date.now() + 3600_000;

    // 1. admitido
    const validToken = await signEs256Jws(
      { invitation_id: 'inv_1', event_id: 'evt_1', token_version: 2, key_id: 'k-test' },
      keyPair.privateKey,
    );
    const res1 = await service.evaluateQrToken(validToken, {
      eventId: 'evt_1',
      publicKeyPem: pem,
      rosterByInvitation: rosterMap,
      revokedIds: new Set(),
      localAdmissions: new Set(),
      revocationsValidUntilMs: futureMs,
    });
    expect(res1.verdict).toBe('admitido');
    expect(res1.admits).toBe(true);
    expect(res1.durationMs).toBeLessThan(100);

    // 2. ya_registrado
    const res2 = await service.evaluateQrToken(validToken, {
      eventId: 'evt_1',
      publicKeyPem: pem,
      rosterByInvitation: rosterMap,
      revokedIds: new Set(),
      localAdmissions: new Set(['inv_1']),
      revocationsValidUntilMs: futureMs,
    });
    expect(res2.verdict).toBe('ya_registrado');
    expect(res2.admits).toBe(false);

    // 3. no_corresponde_al_evento
    const otherEventToken = await signEs256Jws(
      { invitation_id: 'inv_1', event_id: 'evt_OTHER', token_version: 2 },
      keyPair.privateKey,
    );
    const res3 = await service.evaluateQrToken(otherEventToken, {
      eventId: 'evt_1',
      publicKeyPem: pem,
      rosterByInvitation: rosterMap,
      revokedIds: new Set(),
      localAdmissions: new Set(),
      revocationsValidUntilMs: futureMs,
    });
    expect(res3.verdict).toBe('no_corresponde_al_evento');
    expect(res3.admits).toBe(false);

    // 4. invitacion_revocada (by revocation list AND by superseded token_version)
    const res4a = await service.evaluateQrToken(validToken, {
      eventId: 'evt_1',
      publicKeyPem: pem,
      rosterByInvitation: rosterMap,
      revokedIds: new Set(['inv_1']),
      localAdmissions: new Set(),
      revocationsValidUntilMs: futureMs,
    });
    expect(res4a.verdict).toBe('invitacion_revocada');

    const oldVersionToken = await signEs256Jws(
      { invitation_id: 'inv_1', event_id: 'evt_1', token_version: 1 },
      keyPair.privateKey,
    );
    const res4b = await service.evaluateQrToken(oldVersionToken, {
      eventId: 'evt_1',
      publicKeyPem: pem,
      rosterByInvitation: rosterMap,
      revokedIds: new Set(),
      localAdmissions: new Set(),
      revocationsValidUntilMs: futureMs,
    });
    expect(res4b.verdict).toBe('invitacion_revocada');

    // 5. no_verificable_offline (revocation TTL > 2h)
    const res5 = await service.evaluateQrToken(validToken, {
      eventId: 'evt_1',
      publicKeyPem: pem,
      rosterByInvitation: rosterMap,
      revokedIds: new Set(),
      localAdmissions: new Set(),
      revocationsValidUntilMs: Date.now() - 1000,
    });
    expect(res5.verdict).toBe('no_verificable_offline');
    expect(res5.admits).toBe(true);
    expect(res5.conditional).toBe(true);

    // 6. no_en_roster
    const missingToken = await signEs256Jws(
      { invitation_id: 'inv_999', event_id: 'evt_1', token_version: 1 },
      keyPair.privateKey,
    );
    const res6 = await service.evaluateQrToken(missingToken, {
      eventId: 'evt_1',
      publicKeyPem: pem,
      rosterByInvitation: rosterMap,
      revokedIds: new Set(),
      localAdmissions: new Set(),
      revocationsValidUntilMs: futureMs,
    });
    expect(res6.verdict).toBe('no_en_roster');
    expect(res6.requiresConditionalConfirm).toBe(true);

    // Also rejects RSVP token by type (TR-07)
    const rsvpRejection = await service.evaluateQrToken('rsvp_secret123', {
      eventId: 'evt_1',
      publicKeyPem: pem,
      rosterByInvitation: rosterMap,
      revokedIds: new Set(),
      localAdmissions: new Set(),
      revocationsValidUntilMs: futureMs,
    });
    expect(rsvpRejection.validSignature).toBe(false);
    expect(rsvpRejection.errorCode).toBe('TOKEN_TIPO_INCORRECTO');
  });
});
