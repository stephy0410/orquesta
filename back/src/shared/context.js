import { getPool, loadAppSecrets, PgStore } from "./db.js";
import { MetricsEmitter } from "./observability.js";
import { createPortsFromEnv, StripePspAdapter } from "./ports.js";
import { InMemoryStore } from "./store.js";

/**
 * Crea el contexto compartido de ejecución para las 6 Lambdas y pruebas.
 * Soporta tanto PostgreSQL (`PgStore`) como modo standalone en memoria (`InMemoryStore`).
 */
export async function createAppContext(options = {}) {
  const metrics = options.metrics || new MetricsEmitter({ silent: options.silentMetrics ?? false });
  const ports = options.ports || createPortsFromEnv(options.portOverrides || {});
  const dbMode = options.dbMode || process.env.DB_MODE || (process.env.DB_HOST ? "aurora" : "memory");
  const secrets =
    dbMode !== "memory" && (process.env.SECRETS_ARN || process.env.DB_HOST)
      ? await loadAppSecrets()
      : {};

  const piiKey =
    options.piiKey ||
    process.env.PII_ENCRYPTION_KEY ||
    secrets.pii_encryption_key ||
    "orquesta-dev-pii-key-32bytes!";
  const sessionSecret =
    options.sessionSecret ||
    process.env.SESSION_SECRET ||
    secrets.session_secret ||
    "orquesta-dev-session-secret";
  const pspWebhookSecret =
    options.pspWebhookSecret ||
    process.env.PSP_WEBHOOK_SECRET ||
    secrets.psp_webhook_secret ||
    "orquesta-dev-psp-secret";

  // Stripe real si hay llave (env o Secrets Manager); si no, el PSP simulado de siempre.
  const stripeSecretKey =
    options.stripeSecretKey ??
    (process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET || secrets.stripe_secret_key || "");
  const stripeWebhookSecret =
    options.stripeWebhookSecret ??
    (process.env.STRIPE_WEBHOOK_SECRET || secrets.stripe_webhook_secret || "");
  if (stripeSecretKey && !options.ports && !options.portOverrides?.paymentProvider) {
    const publicBase = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
    ports.paymentProvider = new StripePspAdapter({
      secretKey: stripeSecretKey,
      iconUrl: publicBase ? `${publicBase}/icons/icon-512x512.png` : null,
      logoUrl: publicBase ? `${publicBase}/brand/orquesta-logo-verde.png` : null,
      logoFileId: process.env.STRIPE_LOGO_FILE_ID || secrets.stripe_logo_file_id || null,
    });
  }

  const canalesEnv = process.env.CANALES_ACTIVOS || "sms,email";
  const canalesActivos = options.canalesActivos || canalesEnv.split(",").map((s) => s.trim()).filter(Boolean);

  let store = options.store;
  if (!store) {
    if (dbMode !== "memory" && (process.env.DB_HOST || secrets.db_host)) {
      const pool = options.pool || (await getPool());
      store = new PgStore({ pool, piiKey, metrics });
    } else {
      store = new InMemoryStore({ piiKey, metrics });
    }
  } else {
    store.metrics = store.metrics || metrics;
  }

  const now = options.now || (() => new Date());
  // El PSP simulado usa el mismo reloj que la app (ver ADR-5, reloj único).
  if (ports.paymentProvider && "clock" in ports.paymentProvider) ports.paymentProvider.clock = now;

  return {
    store,
    metrics,
    ...ports,
    piiKey,
    sessionSecret,
    pspWebhookSecret,
    stripeWebhookSecret,
    canalesActivos,
    assetsBucket: options.assetsBucket || process.env.ASSETS_BUCKET || "orquesta-assets",
    importsBucket: options.importsBucket || process.env.IMPORTS_BUCKET || "orquesta-imports",
    autoFlushOutbox: options.autoFlushOutbox ?? true,
    now,
  };
}

/**
 * Immediate Outbox Flush post-commit (07-system-design §2.3, NFR-03):
 * publica inmediatamente los eventos pendientes de `outbox_event` hacia `projection` / `SNS`.
 *
 * Cada flush RECLAMA sus filas (FOR UPDATE SKIP LOCKED en PgStore): medido en AWS, cuando cada
 * petición leía los mismos 100 pendientes sin bloquearlos, 30 Lambdas concurrentes reenviaban los
 * mismos mensajes una y otra vez (≈ 10 llamadas a SQS por petición) y el p99 del check-in subía a
 * 1.7 s. Una falla al publicar deja las filas pendientes para el siguiente flush o el poller.
 */
export async function flushOutboxNow(ctx, limit = 100) {
  const publish = async (pending) => {
    const projectionMsgs = [];
    const publishedIds = [];
    for (const row of pending) {
      if (row.topic === "projection") {
        projectionMsgs.push({
          outbox_event_id: row.id,
          event_id: row.event_id,
          event_type: row.event_type,
          payload: row.payload,
          t_ingest: row.t_ingest,
        });
        publishedIds.push(row.id);
      } else if (row.topic === "notifications") {
        await ctx.queueBus.publishNotification(
          {
            outbox_event_id: row.id,
            event_id: row.event_id,
            event_type: row.event_type,
            ...row.payload,
          },
          row.canal || "ambos"
        );
        publishedIds.push(row.id);
      }
    }
    if (projectionMsgs.length > 0) {
      await ctx.queueBus.sendToProjection(projectionMsgs);
    }
    return publishedIds;
  };

  if (typeof ctx.store.publishPendingOutbox === "function") {
    const ids = await ctx.store.publishPendingOutbox(limit, publish, ctx.now());
    return { flushed: ids.length };
  }
  const pending = await ctx.store.fetchPendingOutbox(limit);
  if (!pending || pending.length === 0) return { flushed: 0 };
  const publishedIds = await publish(pending);
  await ctx.store.markOutboxPublished(publishedIds, ctx.now());
  return { flushed: publishedIds.length };
}
