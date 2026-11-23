import {
  derEcdsaToP1363,
  generateEs256KeyPair,
  signEs256Bytes,
  signEs256Jws,
  verifyEs256Bytes,
  verifyEs256Jws,
} from "./crypto.js";
import { createHash } from "node:crypto";
import { ulid } from "./ulid.js";

// ============================================================================
// SmsProvider (CaptureSmsAdapter / SnsSmsAdapter)
// ============================================================================
export class CaptureSmsAdapter {
  constructor() {
    this.captured = [];
    this.failRules = new Map(); // to -> remaining failures or fn
  }

  setFailCount(phone, count) {
    this.failRules.set(phone, count);
  }

  async send({ to, message, metadata = {} }) {
    const rule = this.failRules.get(to);
    if (typeof rule === "number" && rule > 0) {
      this.failRules.set(to, rule - 1);
      throw new Error(`Simulated SMS delivery failure to ${to}`);
    }
    if (rule === "always") {
      throw new Error(`Simulated permanent SMS bounce to ${to}`);
    }
    const entry = {
      provider_message_id: `sms_${ulid()}`,
      to,
      message,
      metadata,
      sent_at: new Date().toISOString(),
    };
    this.captured.push(entry);
    return { provider_message_id: entry.provider_message_id, status: "sent" };
  }
}

export class SnsSmsAdapter {
  constructor({ region = process.env.AWS_REGION || "us-east-1" } = {}) {
    this.region = region;
    this.client = null;
  }

  async _getClient() {
    if (!this.client) {
      const { SNSClient } = await import("@aws-sdk/client-sns");
      this.client = new SNSClient({ region: this.region });
    }
    return this.client;
  }

  async send({ to, message }) {
    const { PublishCommand } = await import("@aws-sdk/client-sns");
    const client = await this._getClient();
    const res = await client.send(
      new PublishCommand({
        PhoneNumber: to,
        Message: message,
        MessageAttributes: {
          "AWS.SNS.SMS.SMSType": { DataType: "String", StringValue: "Transactional" },
        },
      })
    );
    return { provider_message_id: res.MessageId, status: "sent" };
  }
}

// ============================================================================
// EmailProvider (CaptureEmailAdapter / SesEmailAdapter)
// ============================================================================
export class CaptureEmailAdapter {
  constructor() {
    this.captured = [];
    this.failRules = new Map();
  }

  setFailCount(email, count) {
    this.failRules.set(email.toLowerCase(), count);
  }

  async send({ to, subject, html, text, attachments = [], metadata = {} }) {
    const normalized = String(to).toLowerCase();
    const rule = this.failRules.get(normalized);
    if (typeof rule === "number" && rule > 0) {
      this.failRules.set(normalized, rule - 1);
      throw new Error(`Simulated Email delivery failure to ${normalized}`);
    }
    if (rule === "always") {
      throw new Error(`Simulated permanent Email bounce to ${normalized}`);
    }
    const entry = {
      provider_message_id: `eml_${ulid()}`,
      to: normalized,
      subject,
      html,
      text,
      attachments,
      metadata,
      sent_at: new Date().toISOString(),
    };
    this.captured.push(entry);
    return { provider_message_id: entry.provider_message_id, status: "sent" };
  }
}

export class SesEmailAdapter {
  constructor({
    region = process.env.AWS_REGION || "us-east-1",
    fromEmail = process.env.EMAIL_FROM || "no-reply@orquesta.local",
  } = {}) {
    this.region = region;
    this.fromEmail = fromEmail;
    this.client = null;
  }

  async _getClient() {
    if (!this.client) {
      const { SESClient } = await import("@aws-sdk/client-ses");
      this.client = new SESClient({ region: this.region });
    }
    return this.client;
  }

  async send({ to, subject, html, text }) {
    const { SendEmailCommand } = await import("@aws-sdk/client-ses");
    const client = await this._getClient();
    const res = await client.send(
      new SendEmailCommand({
        Source: this.fromEmail,
        Destination: { ToAddresses: [to] },
        Message: {
          Subject: { Data: subject, Charset: "UTF-8" },
          Body: {
            Html: { Data: html || text || "", Charset: "UTF-8" },
            Text: { Data: text || "", Charset: "UTF-8" },
          },
        },
      })
    );
    return { provider_message_id: res.MessageId, status: "sent" };
  }
}

// ============================================================================
// PaymentProvider (TR-14, D1, D5): MockPspTestAdapter + queryByKey
// ============================================================================
export class MockPspTestAdapter {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.checkout] simula Stripe Checkout: `charge` crea una sesión que la
   *   planner paga fuera (`completeCheckout`) en vez de cobrar al momento.
   */
  constructor({ clock = null, checkout = false } = {}) {
    // Reloj inyectable: createAppContext lo alinea con ctx.now() para que las pruebas que viajan
    // en el tiempo vean los cobros en el día correcto al conciliar.
    this.clock = clock || (() => new Date());
    this.charges = new Map(); // idempotencyKey -> record
    this.refunds = new Map();
    this.timeoutNextForKey = new Set(); // simula timeout donde PSP sí cobró pero caller vio unknown
    this.unknownStatusKeys = new Set();
    this.chargeExecutions = 0;
    this.checkout = checkout;
    this.sessions = new Map(); // reference -> sesión de checkout simulada
    this.sessionByRequestKey = new Map();
  }

  /** El cobro requiere que la planner complete un checkout hospedado (ver StripePspAdapter). */
  get requiresCustomerAction() {
    return this.checkout;
  }

  /** Simula que la planner pagó la sesión en la página del PSP. */
  completeCheckout(reference) {
    const s = this.sessions.get(reference);
    if (!s) throw new Error(`sesión ${reference} no existe`);
    s.status = "complete";
    const record = {
      status: "succeeded",
      psp_charge_id: `pi_mock_${ulid()}`,
      amount: s.amount,
      currency: s.currency,
      idempotency_key: s.idempotency_key,
      metadata: s.metadata,
      charged_at: new Date(this.clock()).toISOString(),
    };
    this.charges.set(s.idempotency_key, record);
    this.chargeExecutions += 1;
    return { ...record };
  }

  /** Simula que la sesión caducó sin pago. */
  expireCheckout(reference) {
    const s = this.sessions.get(reference);
    if (s && s.status === "open") s.status = "expired";
  }

  _createCheckout({ idempotencyKey, amount, currency, metadata, successUrl, cancelUrl, previousReference }) {
    const requestKey = `${idempotencyKey}:checkout:${previousReference || "1"}`;
    const existing = this.sessionByRequestKey.get(requestKey);
    const s = existing
      ? this.sessions.get(existing)
      : {
          reference: `cs_mock_${ulid()}`,
          status: "open",
          idempotency_key: idempotencyKey,
          amount: Number(Number(amount).toFixed(2)),
          currency: String(currency).toUpperCase(),
          metadata,
          success_url: successUrl,
          cancel_url: cancelUrl,
        };
    if (!existing) {
      this.sessions.set(s.reference, s);
      this.sessionByRequestKey.set(requestKey, s.reference);
    }
    return {
      status: "requires_action",
      reference: s.reference,
      checkout_url: `https://checkout.mock.test/${s.reference}`,
      idempotency_key: idempotencyKey,
    };
  }

  simulateTimeoutAfterCharge(idempotencyKey) {
    this.timeoutNextForKey.add(idempotencyKey);
  }

  simulateUnknownWithoutCharge(idempotencyKey) {
    this.unknownStatusKeys.add(idempotencyKey);
  }

  async charge({ idempotencyKey, amount, currency, metadata = {}, successUrl, cancelUrl, previousReference = null }) {
    if (!idempotencyKey || typeof idempotencyKey !== "string") {
      throw new Error("idempotencyKey is required");
    }
    if (this.checkout) {
      return this._createCheckout({ idempotencyKey, amount, currency, metadata, successUrl, cancelUrl, previousReference });
    }
    const existing = this.charges.get(idempotencyKey);
    if (existing) {
      return { ...existing };
    }

    if (this.unknownStatusKeys.has(idempotencyKey)) {
      this.unknownStatusKeys.delete(idempotencyKey);
      return {
        status: "unknown",
        psp_charge_id: null,
        amount: Number(amount),
        currency,
        idempotency_key: idempotencyKey,
      };
    }

    this.chargeExecutions += 1;
    const record = {
      status: "succeeded",
      psp_charge_id: `psp_ch_${ulid()}`,
      amount: Number(Number(amount).toFixed(2)),
      currency: String(currency).toUpperCase(),
      idempotency_key: idempotencyKey,
      metadata,
      charged_at: new Date(this.clock()).toISOString(),
    };
    this.charges.set(idempotencyKey, record);

    if (this.timeoutNextForKey.has(idempotencyKey)) {
      this.timeoutNextForKey.delete(idempotencyKey);
      // Simula timeout de red tras ejecutar el cobro en el PSP (AC-09)
      const err = new Error("PSP_TIMEOUT");
      err.isTimeout = true;
      throw err;
    }

    return { ...record };
  }

  async queryByKey(idempotencyKey, { reference = null } = {}) {
    const session = reference ? this.sessions.get(reference) : null;
    if (session && session.status === "open") {
      return {
        found: false,
        status: "open",
        reference,
        checkout_url: `https://checkout.mock.test/${reference}`,
        idempotency_key: idempotencyKey,
      };
    }
    if (session && session.status === "expired" && !this.charges.has(idempotencyKey)) {
      return { found: false, status: "expired", reference, psp_charge_id: null, idempotency_key: idempotencyKey };
    }
    const existing = this.charges.get(idempotencyKey);
    if (!existing) {
      return {
        found: false,
        status: "not_found",
        psp_charge_id: null,
        idempotency_key: idempotencyKey,
      };
    }
    return {
      found: true,
      ...existing,
    };
  }

  /**
   * Cobros exitosos con `charged_at` en [from, to). Equivale al reporte de transacciones que
   * expone cualquier PSP (p. ej. Stripe `charges.list` con `created[gte|lt]`). Usado por la
   * conciliación diaria (RF-11, FR6).
   */
  async listCharges({ from, to }) {
    const fromMs = new Date(from).getTime();
    const toMs = new Date(to).getTime();
    return [...this.charges.values()]
      .filter((c) => c.status === "succeeded")
      .filter((c) => {
        const t = new Date(c.charged_at).getTime();
        return t >= fromMs && t < toMs;
      })
      .map((c) => ({ ...c }));
  }

  async refund({ idempotencyKey, pspChargeId, amount, currency }) {
    const key = `refund:${idempotencyKey}`;
    if (this.refunds.has(key)) {
      return { ...this.refunds.get(key) };
    }
    const rec = {
      status: "refunded",
      psp_refund_id: `psp_rf_${ulid()}`,
      psp_charge_id: pspChargeId,
      amount: Number(Number(amount).toFixed(2)),
      currency: String(currency).toUpperCase(),
      refunded_at: new Date().toISOString(),
    };
    this.refunds.set(key, rec);
    return { ...rec };
  }
}

export const MockStripeTestAdapter = MockPspTestAdapter;

/**
 * Apariencia de la página de pago: la misma paleta y forma que el front (`front/src/styles.scss`).
 * Stripe no ofrece Figtree; Inter es la más cercana de su catálogo.
 */
export const ORQUESTA_CHECKOUT_BRANDING = Object.freeze({
  display_name: "Orquesta",
  background_color: "#f5f2e8", // --oq-bg
  button_color: "#56602a", // --oq-olive (botón primario)
  border_style: "rectangular", // --oq-radius-sm: esquinas casi rectas
  font_family: "inter",
});

export class StripeApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Stripe respondió ${status}`);
    this.name = "StripeApiError";
    this.status = status;
    this.type = body?.error?.type || null;
    this.code = body?.error?.code || null;
  }
}

/** Codifica objetos anidados al formato `a[b][0][c]=v` que espera la API de Stripe. */
export function stripeForm(obj, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") stripeForm(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

const toMinorUnits = (amount) => Math.round(Number(amount) * 100);
const fromMinorUnits = (n) => Math.round(Number(n)) / 100;

/**
 * PaymentProvider real sobre Stripe (FR6) con Stripe Checkout: la planner paga en la página
 * hospedada de Stripe, así que Orquesta nunca toca datos de tarjeta (PCI SAQ A).
 *
 *   - `charge` crea (o recupera) la sesión de Checkout y devuelve `requires_action` + `checkout_url`.
 *     La llave de idempotencia de Stripe es `<pay:reserva>:checkout:<sesión anterior|1>`: doble clic
 *     o reintentos devuelven la MISMA sesión; solo tras expirar una sesión se crea otra.
 *   - `queryByKey` consulta la sesión guardada (o busca el PaymentIntent por metadata) para
 *     confirmar al volver del checkout, en el barrido de conciliación o si se perdió el webhook.
 *   - `listCharges` alimenta la conciliación diaria con los PaymentIntent cobrados del día.
 *   - `refund` reembolsa con su propia llave de idempotencia.
 */
export class StripePspAdapter {
  constructor({
    secretKey,
    fetchImpl = globalThis.fetch,
    apiBase = "https://api.stripe.com",
    apiVersion = "2025-04-30.basil",
    timeoutMs = 15_000,
    branding = ORQUESTA_CHECKOUT_BRANDING,
    iconUrl = null,
    logoUrl = null,
    logoFileId = null,
    locale = "es-419",
    sessionTtlSec = 3600,
    clock = null,
  } = {}) {
    if (!secretKey || !/^(sk|rk)_(test|live)_/.test(secretKey)) {
      throw new Error("StripePspAdapter: STRIPE_SECRET_KEY inválida (se espera sk_test_… o sk_live_…)");
    }
    this.secretKey = secretKey;
    this.fetchImpl = fetchImpl;
    this.apiBase = apiBase.replace(/\/+$/, "");
    this.apiVersion = apiVersion;
    this.timeoutMs = timeoutMs;
    this.branding = branding;
    // Stripe descarga el ícono: solo sirve una URL pública https (no localhost).
    const publicHttps = (u) => (u && /^https:\/\//.test(u) && !/localhost|127\.0\.0\.1/.test(u) ? u : null);
    this.iconUrl = publicHttps(iconUrl);
    // Logo de Orquesta (verde) en el encabezado: archivo ya subido a Stripe (sirve en local) o URL pública.
    this.logoFileId = logoFileId && /^file_/.test(logoFileId) ? logoFileId : null;
    this.logoUrl = publicHttps(logoUrl);
    this.locale = locale;
    // Stripe acepta entre 30 min y 24 h. Una hora basta para pagar y libera pronto los abandonos.
    this.sessionTtlSec = Math.min(Math.max(sessionTtlSec, 1800), 86400);
    this.clock = clock || (() => new Date());
    this.mode = secretKey.includes("_live_") ? "live" : "test";
  }

  get requiresCustomerAction() {
    return true;
  }

  async _request(method, path, { params = null, idempotencyKey = null } = {}) {
    const headers = {
      Authorization: `Bearer ${this.secretKey}`,
      "Stripe-Version": this.apiVersion,
    };
    let url = `${this.apiBase}${path}`;
    let body;
    if (params && method === "GET") {
      url += `?${stripeForm(params).toString()}`;
    } else if (params) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = stripeForm(params).toString();
    }
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

    let res;
    try {
      res = await this.fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (cause) {
      // Sin respuesta: no sabemos si Stripe procesó la petición → el llamador lo trata como
      // `desconocido` y la conciliación lo resuelve por llave.
      const err = new Error(`Stripe sin respuesta: ${cause?.message || cause}`);
      err.isTimeout = true;
      throw err;
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new StripeApiError(res.status, json);
      if (res.status >= 500 || res.status === 429) err.isTimeout = true; // reintentable, resultado incierto
      throw err;
    }
    return json;
  }

  async charge({ idempotencyKey, amount, currency, metadata = {}, successUrl, cancelUrl, previousReference = null, description = null }) {
    if (!idempotencyKey) throw new Error("idempotencyKey is required");
    if (!successUrl || !cancelUrl) throw new Error("Stripe Checkout requiere success_url y cancel_url");
    const meta = { ...metadata, idempotency_key: idempotencyKey };
    const nowSec = Math.floor(new Date(this.clock()).getTime() / 1000);
    const branding = { ...this.branding };
    if (this.iconUrl) branding.icon = { type: "url", url: this.iconUrl };
    if (this.logoFileId) branding.logo = { type: "file", file: this.logoFileId };
    else if (this.logoUrl) branding.logo = { type: "url", url: this.logoUrl };
    const session = await this._request("POST", "/v1/checkout/sessions", {
      idempotencyKey: `${idempotencyKey}:checkout:${previousReference || "1"}`,
      params: {
        mode: "payment",
        locale: this.locale,
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: idempotencyKey,
        expires_at: nowSec + this.sessionTtlSec,
        submit_type: "pay",
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: String(currency).toLowerCase(),
              unit_amount: toMinorUnits(amount),
              product_data: { name: description || "Contratación de proveedor · Orquesta" },
            },
          },
        ],
        metadata: meta,
        payment_intent_data: { metadata: meta, description: description || undefined },
        branding_settings: branding,
      },
    });
    return this._mapSession(session, idempotencyKey);
  }

  _mapSession(s, idempotencyKey) {
    const base = { reference: s.id, idempotency_key: idempotencyKey };
    if (s.payment_status === "paid" || s.payment_status === "no_payment_required") {
      const pi = typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id;
      return {
        ...base,
        found: true,
        status: "succeeded",
        psp_charge_id: pi || s.id,
        amount: fromMinorUnits(s.amount_total),
        currency: String(s.currency || "").toUpperCase(),
      };
    }
    if (s.status === "open") {
      return { ...base, found: false, status: "requires_action", checkout_url: s.url };
    }
    if (s.status === "expired") return { ...base, found: false, status: "expired", psp_charge_id: null };
    // `complete` sin pagar: método asíncrono (p. ej. OXXO) en proceso.
    return { ...base, found: false, status: "pending", psp_charge_id: null };
  }

  async queryByKey(idempotencyKey, { reference = null } = {}) {
    if (reference) {
      const s = await this._request("GET", `/v1/checkout/sessions/${encodeURIComponent(reference)}`);
      const mapped = this._mapSession(s, idempotencyKey);
      if (mapped.status === "requires_action") mapped.status = "open";
      return mapped;
    }
    // Sin sesión guardada (p. ej. se perdió la respuesta al crearla): buscar el cobro por metadata.
    const safeKey = String(idempotencyKey).replace(/['\\]/g, "");
    const found = await this._request("GET", "/v1/payment_intents/search", {
      params: { query: `metadata['idempotency_key']:'${safeKey}' AND status:'succeeded'`, limit: 1 },
    });
    const pi = found?.data?.[0];
    if (!pi) return { found: false, status: "not_found", psp_charge_id: null, idempotency_key: idempotencyKey };
    return this._mapPaymentIntent(pi, idempotencyKey);
  }

  _mapPaymentIntent(pi, idempotencyKey = pi.metadata?.idempotency_key) {
    return {
      found: true,
      status: pi.status === "succeeded" ? "succeeded" : pi.status,
      psp_charge_id: pi.id,
      amount: fromMinorUnits(pi.amount_received ?? pi.amount),
      currency: String(pi.currency).toUpperCase(),
      idempotency_key: idempotencyKey,
      charged_at: new Date(pi.created * 1000).toISOString(),
    };
  }

  async listCharges({ from, to }) {
    const out = [];
    let startingAfter = null;
    for (let page = 0; page < 50; page += 1) {
      const res = await this._request("GET", "/v1/payment_intents", {
        params: {
          limit: 100,
          created: { gte: Math.floor(new Date(from).getTime() / 1000), lt: Math.floor(new Date(to).getTime() / 1000) },
          starting_after: startingAfter || undefined,
        },
      });
      for (const pi of res.data || []) {
        // Solo cobros de Orquesta (la cuenta puede tener otros movimientos).
        if (pi.status === "succeeded" && pi.metadata?.idempotency_key) out.push(this._mapPaymentIntent(pi));
      }
      if (!res.has_more || !res.data?.length) break;
      startingAfter = res.data[res.data.length - 1].id;
    }
    return out;
  }

  async refund({ idempotencyKey, pspChargeId, amount, currency }) {
    const r = await this._request("POST", "/v1/refunds", {
      idempotencyKey: `refund:${idempotencyKey}`,
      params: { payment_intent: pspChargeId, amount: toMinorUnits(amount), metadata: { idempotency_key: idempotencyKey } },
    });
    return {
      status: r.status === "failed" || r.status === "canceled" ? "failed" : "refunded",
      psp_refund_id: r.id,
      psp_charge_id: pspChargeId,
      amount: fromMinorUnits(r.amount),
      currency: String(r.currency || currency).toUpperCase(),
      refunded_at: new Date(r.created * 1000).toISOString(),
    };
  }
}

// Contract test reutilizable para cualquier adaptador PaymentProvider (TR-14)
export async function verifyPaymentProviderContract(providerFactory) {
  const psp = await providerFactory();
  const key = `pay:contract_${ulid()}`;

  const q0 = await psp.queryByKey(key);
  if (q0.found !== false) {
    throw new Error("Contract violation: queryByKey must return found=false before charge");
  }

  const c1 = await psp.charge({ idempotencyKey: key, amount: 1500, currency: "MXN" });
  const c2 = await psp.charge({ idempotencyKey: key, amount: 1500, currency: "MXN" });
  if (c1.status !== "succeeded" || c1.psp_charge_id !== c2.psp_charge_id) {
    throw new Error("Contract violation: repeated charge with same key must be idempotent");
  }

  const q1 = await psp.queryByKey(key);
  if (!q1.found || q1.status !== "succeeded" || q1.psp_charge_id !== c1.psp_charge_id) {
    throw new Error("Contract violation: queryByKey must recover existing charge");
  }

  const chargedAt = new Date(c1.charged_at || Date.now()).getTime();
  const listed = await psp.listCharges({ from: new Date(chargedAt - 60_000), to: new Date(chargedAt + 60_000) });
  if (!Array.isArray(listed) || !listed.some((c) => c.idempotency_key === key && c.status === "succeeded")) {
    throw new Error("Contract violation: listCharges must include succeeded charges in the window");
  }

  const r1 = await psp.refund({
    idempotencyKey: key,
    pspChargeId: c1.psp_charge_id,
    amount: 1500,
    currency: "MXN",
  });
  if (r1.status !== "refunded") {
    throw new Error("Contract violation: refund must return status=refunded");
  }
  return true;
}

// ============================================================================
// QrSigner (LocalQrSigner / KmsQrSigner) - ES256 P-256 (TR-06)
// ============================================================================
export class LocalQrSigner {
  constructor({ keyId = "k-2026-03", keyPair = null } = {}) {
    const pair = keyPair || generateEs256KeyPair(keyId);
    this.activeKeyId = pair.keyId || keyId;
    this.keys = new Map(); // keyId -> { keyId, privateKeyPem, publicKeyPem }
    this.keys.set(this.activeKeyId, {
      keyId: this.activeKeyId,
      privateKeyPem: pair.privateKeyPem,
      publicKeyPem: pair.publicKeyPem,
    });
  }

  rotateKey(newKeyId) {
    const pair = generateEs256KeyPair(newKeyId);
    this.keys.set(newKeyId, pair);
    this.activeKeyId = newKeyId;
    return pair;
  }

  async signJws(payload, keyId = this.activeKeyId) {
    const entry = this.keys.get(keyId);
    if (!entry) throw new Error(`Unknown QR signing key ${keyId}`);
    return signEs256Jws(payload, { privateKeyPem: entry.privateKeyPem, keyId: entry.keyId });
  }

  async signBytes(bytes, keyId = this.activeKeyId) {
    const entry = this.keys.get(keyId);
    if (!entry) throw new Error(`Unknown QR signing key ${keyId}`);
    return signEs256Bytes(bytes, entry.privateKeyPem);
  }

  async verifyJws(token) {
    const publicKeyMap = {};
    for (const [kid, k] of this.keys.entries()) {
      publicKeyMap[kid] = k.publicKeyPem;
    }
    return verifyEs256Jws(token, publicKeyMap);
  }

  async verifyBytes(bytes, sigB64Url, keyId = this.activeKeyId) {
    const entry = this.keys.get(keyId);
    if (!entry) return false;
    return verifyEs256Bytes(bytes, sigB64Url, entry.publicKeyPem);
  }

  async getPublicKey(keyId = this.activeKeyId) {
    const entry = this.keys.get(keyId);
    if (!entry) throw new Error(`Unknown QR public key ${keyId}`);
    return { key_id: entry.keyId, public_key_pem: entry.publicKeyPem };
  }
}

/**
 * Petición a KMS Sign. KMS acepta hasta 4096 bytes en modo RAW y el roster firmado de un evento
 * pesa mucho más, así que se manda el digest SHA-256 (MessageType DIGEST). Con ECDSA_SHA_256 la
 * firma es la misma que sobre el mensaje completo: el escáner la verifica igual (Web Crypto
 * ECDSA P-256 / SHA-256).
 */
export function kmsSignInput(keyId, bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), "utf8");
  return {
    KeyId: keyId,
    Message: createHash("sha256").update(buf).digest(),
    MessageType: "DIGEST",
    SigningAlgorithm: "ECDSA_SHA_256",
  };
}

export class KmsQrSigner {
  constructor({ keyId, region = process.env.AWS_REGION || "us-east-1" }) {
    this.activeKeyId = keyId;
    this.region = region;
    this.client = null;
    this.cachedPublicKeyPem = null;
  }

  async _getClient() {
    if (!this.client) {
      const { KMSClient } = await import("@aws-sdk/client-kms");
      this.client = new KMSClient({ region: this.region });
    }
    return this.client;
  }

  async getPublicKey() {
    if (!this.cachedPublicKeyPem) {
      const { GetPublicKeyCommand } = await import("@aws-sdk/client-kms");
      const client = await this._getClient();
      const res = await client.send(new GetPublicKeyCommand({ KeyId: this.activeKeyId }));
      const b64 = Buffer.from(res.PublicKey).toString("base64");
      const lines = b64.match(/.{1,64}/g).join("\n");
      this.cachedPublicKeyPem = `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----`;
    }
    return { key_id: this.activeKeyId, public_key_pem: this.cachedPublicKeyPem };
  }

  async signBytes(bytes) {
    const { SignCommand } = await import("@aws-sdk/client-kms");
    const client = await this._getClient();
    const res = await client.send(new SignCommand(kmsSignInput(this.activeKeyId, bytes)));
    const p1363 = derEcdsaToP1363(Buffer.from(res.Signature));
    return p1363.toString("base64url");
  }

  async signJws(payload) {
    const headerB64 = Buffer.from(
      JSON.stringify({ alg: "ES256", typ: "JWT", kid: this.activeKeyId }),
      "utf8"
    ).toString("base64url");
    const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signingInput = `${headerB64}.${payloadB64}`;
    const sigB64 = await this.signBytes(Buffer.from(signingInput, "utf8"));
    return `${signingInput}.${sigB64}`;
  }

  async verifyJws(token) {
    const { public_key_pem } = await this.getPublicKey();
    return verifyEs256Jws(token, public_key_pem);
  }
}

// ============================================================================
// ObjectStorage (MemoryObjectStorage / S3ObjectStorage)
// ============================================================================
export class MemoryObjectStorage {
  constructor({ publicBaseUrl = "https://cdn.orquesta.test" } = {}) {
    this.objects = new Map(); // `${bucket}/${key}` -> { body: Buffer, contentType, cacheControl }
    this.publicBaseUrl = publicBaseUrl;
  }

  async putObject({ bucket, key, body, contentType = "application/octet-stream", cacheControl = null }) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
    this.objects.set(`${bucket}/${key}`, {
      bucket,
      key,
      body: buf,
      contentType,
      cacheControl,
    });
    return { bucket, key, url: this.getPublicUrl({ bucket, key }) };
  }

  async getObject({ bucket, key }) {
    const rec = this.objects.get(`${bucket}/${key}`);
    if (!rec) return null;
    return { ...rec };
  }

  getPublicUrl({ key }) {
    return `${this.publicBaseUrl}/${key}`;
  }
}

export class S3ObjectStorage {
  constructor({ region = process.env.AWS_REGION || "us-east-1", publicBaseUrl = null } = {}) {
    this.region = region;
    this.publicBaseUrl = publicBaseUrl;
    this.client = null;
  }

  async _getClient() {
    if (!this.client) {
      const { S3Client } = await import("@aws-sdk/client-s3");
      this.client = new S3Client({ region: this.region });
    }
    return this.client;
  }

  async putObject({ bucket, key, body, contentType = "application/octet-stream", cacheControl = null }) {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this._getClient();
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ...(cacheControl ? { CacheControl: cacheControl } : {}),
      })
    );
    return { bucket, key, url: this.getPublicUrl({ bucket, key }) };
  }

  async getObject({ bucket, key }) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this._getClient();
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const chunks = [];
    for await (const chunk of res.Body) {
      chunks.push(Buffer.from(chunk));
    }
    return {
      bucket,
      key,
      body: Buffer.concat(chunks),
      contentType: res.ContentType,
    };
  }

  getPublicUrl({ bucket, key }) {
    if (this.publicBaseUrl) return `${this.publicBaseUrl}/${key}`;
    return `https://${bucket}.s3.${this.region}.amazonaws.com/${key}`;
  }
}

// ============================================================================
// QueueBus (MemoryQueueBus / SqsSnsQueueBus)
// ============================================================================
export class MemoryQueueBus {
  constructor() {
    this.queues = {
      import_jobs: [],
      projection: [],
      notify_sms: [],
      notify_email: [],
    };
    this.consumers = {};
  }

  registerConsumer(queueName, handler) {
    this.consumers[queueName] = handler;
  }

  async sendToImportQueue(message) {
    const record = { messageId: `msg_${ulid()}`, body: JSON.stringify(message) };
    this.queues.import_jobs.push(record);
    return record.messageId;
  }

  async sendToProjection(messages) {
    const list = Array.isArray(messages) ? messages : [messages];
    const ids = [];
    for (const msg of list) {
      const record = { messageId: `msg_${ulid()}`, body: JSON.stringify(msg) };
      this.queues.projection.push(record);
      ids.push(record.messageId);
    }
    return ids;
  }

  async publishNotification(message, canal = "ambos") {
    const ids = [];
    if (canal === "sms" || canal === "ambos") {
      const rec = { messageId: `msg_${ulid()}`, body: JSON.stringify(message) };
      this.queues.notify_sms.push(rec);
      ids.push(rec.messageId);
    }
    if (canal === "email" || canal === "ambos") {
      const rec = { messageId: `msg_${ulid()}`, body: JSON.stringify(message) };
      this.queues.notify_email.push(rec);
      ids.push(rec.messageId);
    }
    return ids;
  }

  async drainQueue(queueName) {
    const consumer = this.consumers[queueName];
    const queue = this.queues[queueName];
    if (!consumer || !queue || queue.length === 0) return { processed: 0, failures: 0 };
    const batch = queue.splice(0, queue.length);
    const res = await consumer({ Records: batch });
    const failedIds = new Set((res?.batchItemFailures || []).map((f) => f.itemIdentifier));
    if (failedIds.size > 0) {
      for (const rec of batch) {
        if (failedIds.has(rec.messageId)) {
          queue.push(rec);
        }
      }
    }
    return { processed: batch.length - failedIds.size, failures: failedIds.size };
  }

  async drainAll() {
    let total = 0;
    for (const q of ["import_jobs", "projection", "notify_sms", "notify_email"]) {
      const res = await this.drainQueue(q);
      total += res.processed;
    }
    return total;
  }
}

export class SqsSnsQueueBus {
  constructor({
    region = process.env.AWS_REGION || "us-east-1",
    importQueueUrl = process.env.IMPORT_QUEUE_URL,
    projectionQueueUrl = process.env.PROJECTION_QUEUE_URL,
    notificationsSnsArn = process.env.NOTIFICATIONS_SNS_ARN,
  } = {}) {
    this.region = region;
    this.importQueueUrl = importQueueUrl;
    this.projectionQueueUrl = projectionQueueUrl;
    this.notificationsSnsArn = notificationsSnsArn;
    this.sqs = null;
    this.sns = null;
  }

  async _getSqs() {
    if (!this.sqs) {
      const { SQSClient } = await import("@aws-sdk/client-sqs");
      this.sqs = new SQSClient({ region: this.region });
    }
    return this.sqs;
  }

  async _getSns() {
    if (!this.sns) {
      const { SNSClient } = await import("@aws-sdk/client-sns");
      this.sns = new SNSClient({ region: this.region });
    }
    return this.sns;
  }

  async sendToImportQueue(message) {
    const { SendMessageCommand } = await import("@aws-sdk/client-sqs");
    const sqs = await this._getSqs();
    const res = await sqs.send(
      new SendMessageCommand({
        QueueUrl: this.importQueueUrl,
        MessageBody: JSON.stringify(message),
      })
    );
    return res.MessageId;
  }

  async sendToProjection(messages) {
    const { SendMessageBatchCommand } = await import("@aws-sdk/client-sqs");
    const sqs = await this._getSqs();
    const list = Array.isArray(messages) ? messages : [messages];
    // Lotes de 10 (máximo de SQS) en paralelo: un flush no espera N viajes en serie.
    const chunks = [];
    for (let i = 0; i < list.length; i += 10) chunks.push(list.slice(i, i + 10));
    const results = await Promise.all(
      chunks.map((chunk) =>
        sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: this.projectionQueueUrl,
            Entries: chunk.map((m, idx) => ({
              Id: String(idx),
              MessageBody: JSON.stringify(m),
            })),
          })
        )
      )
    );
    const ids = [];
    for (const res of results) {
      // Una entrada rechazada por SQS no puede marcarse como publicada.
      if (res.Failed?.length) throw new Error(`SQS rechazó ${res.Failed.length} mensajes de proyección`);
      for (const s of res.Successful || []) ids.push(s.MessageId);
    }
    return ids;
  }

  async publishNotification(message, canal = "ambos") {
    const { PublishCommand } = await import("@aws-sdk/client-sns");
    const sns = await this._getSns();
    const res = await sns.send(
      new PublishCommand({
        TopicArn: this.notificationsSnsArn,
        Message: JSON.stringify(message),
        MessageAttributes: {
          canal: { DataType: "String", StringValue: canal },
        },
      })
    );
    return [res.MessageId];
  }
}

export function createPortsFromEnv(overrides = {}) {
  const smsMode = overrides.smsMode || process.env.SMS_PROVIDER_MODE || "capture";
  const emailMode = overrides.emailMode || process.env.EMAIL_PROVIDER_MODE || "capture";
  const storageMode = overrides.storageMode || (process.env.IMPORTS_BUCKET && process.env.DB_HOST ? "s3" : "memory");
  const queueMode = overrides.queueMode || (process.env.PROJECTION_QUEUE_URL && process.env.DB_HOST ? "aws" : "memory");
  const kmsKeyId = overrides.kmsKeyId ?? process.env.KMS_SIGNER_KEY_ID ?? "";

  const smsProvider =
    overrides.smsProvider || (smsMode === "sns" ? new SnsSmsAdapter() : new CaptureSmsAdapter());
  const emailProvider =
    overrides.emailProvider || (emailMode === "ses" ? new SesEmailAdapter() : new CaptureEmailAdapter());
  const paymentProvider = overrides.paymentProvider || new MockPspTestAdapter();
  const qrSigner =
    overrides.qrSigner ||
    (kmsKeyId ? new KmsQrSigner({ keyId: kmsKeyId }) : new LocalQrSigner());
  const objectStorage =
    overrides.objectStorage ||
    (storageMode === "s3"
      ? new S3ObjectStorage({
          publicBaseUrl: process.env.PUBLIC_ASSETS_URL || process.env.PUBLIC_BASE_URL || null,
        })
      : new MemoryObjectStorage());
  const queueBus =
    overrides.queueBus || (queueMode === "aws" ? new SqsSnsQueueBus() : new MemoryQueueBus());

  return {
    smsProvider,
    emailProvider,
    paymentProvider,
    qrSigner,
    objectStorage,
    queueBus,
  };
}
