import {
  derEcdsaToP1363,
  generateEs256KeyPair,
  signEs256Bytes,
  signEs256Jws,
  verifyEs256Bytes,
  verifyEs256Jws,
} from "./crypto.js";
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
  constructor({ clock = null } = {}) {
    // Reloj inyectable: createAppContext lo alinea con ctx.now() para que las pruebas que viajan
    // en el tiempo vean los cobros en el día correcto al conciliar.
    this.clock = clock || (() => new Date());
    this.charges = new Map(); // idempotencyKey -> record
    this.refunds = new Map();
    this.timeoutNextForKey = new Set(); // simula timeout donde PSP sí cobró pero caller vio unknown
    this.unknownStatusKeys = new Set();
    this.chargeExecutions = 0;
  }

  simulateTimeoutAfterCharge(idempotencyKey) {
    this.timeoutNextForKey.add(idempotencyKey);
  }

  simulateUnknownWithoutCharge(idempotencyKey) {
    this.unknownStatusKeys.add(idempotencyKey);
  }

  async charge({ idempotencyKey, amount, currency, metadata = {} }) {
    if (!idempotencyKey || typeof idempotencyKey !== "string") {
      throw new Error("idempotencyKey is required");
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

  async queryByKey(idempotencyKey) {
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
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), "utf8");
    const res = await client.send(
      new SignCommand({
        KeyId: this.activeKeyId,
        Message: buf,
        MessageType: "RAW",
        SigningAlgorithm: "ECDSA_SHA_256",
      })
    );
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
    const ids = [];
    for (let i = 0; i < list.length; i += 10) {
      const chunk = list.slice(i, i + 10);
      const res = await sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: this.projectionQueueUrl,
          Entries: chunk.map((m, idx) => ({
            Id: String(idx),
            MessageBody: JSON.stringify(m),
          })),
        })
      );
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
