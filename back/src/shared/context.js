import { getPool, loadAppSecrets, PgStore } from "./db.js";
import { MetricsEmitter } from "./observability.js";
import { createPortsFromEnv } from "./ports.js";
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

  return {
    store,
    metrics,
    ...ports,
    piiKey,
    sessionSecret,
    pspWebhookSecret,
    canalesActivos,
    assetsBucket: options.assetsBucket || process.env.ASSETS_BUCKET || "orquesta-assets",
    importsBucket: options.importsBucket || process.env.IMPORTS_BUCKET || "orquesta-imports",
    autoFlushOutbox: options.autoFlushOutbox ?? true,
    now: options.now || (() => new Date()),
  };
}

/**
 * Immediate Outbox Flush post-commit (07-system-design §2.3, NFR-03):
 * publica inmediatamente los eventos pendientes de `outbox_event` hacia `projection` / `SNS`.
 */
export async function flushOutboxNow(ctx, limit = 100) {
  const pending = await ctx.store.fetchPendingOutbox(limit);
  if (!pending || pending.length === 0) return { flushed: 0 };

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

  await ctx.store.markOutboxPublished(publishedIds, ctx.now());
  return { flushed: publishedIds.length };
}
