#!/usr/bin/env node
/**
 * Servidor local de desarrollo: el backend completo en http://localhost:3000, para usar el
 * frontend (`cd front && npx ng serve`, que apunta a ese puerto) sin desplegar en AWS.
 *
 * - Envuelve el MISMO handler de la Lambda `api` (formato API Gateway HTTP API v2).
 * - Corre los workers en proceso: import de invitados, proyector del tablero, SMS, email y el
 *   outbox-poller (recordatorios, expiraciones, conciliación de pagos).
 * - Email y SMS en modo *capture*: se imprimen en consola (tokens de verificación, OTP y links de
 *   invitación) para poder copiarlos al navegador.
 * - CORS para el front en http://localhost:4200 (en AWS lo resuelve API Gateway).
 *
 * Uso:
 *   npm run db:up && npm run dev          # PostgreSQL local (docker compose, puerto 55432)
 *   npm run dev -- --memory               # sin Docker: datos en memoria (se pierden al salir)
 * Variables: PORT (3000), FRONT_ORIGIN (http://localhost:4200), PUBLIC_BASE_URL (http://localhost:4200).
 */
import http from "node:http";
import { parseArgs } from "node:util";

const { values: opt } = parseArgs({ options: { memory: { type: "boolean", default: false } } });
const PORT = Number(process.env.PORT || 3000);
const FRONT_ORIGIN = process.env.FRONT_ORIGIN || "http://localhost:4200";
process.env.PUBLIC_BASE_URL ||= FRONT_ORIGIN;
process.env.ORQUESTA_SILENT_EMF ||= "1";

const { createAppContext, flushOutboxNow } = await import("../src/shared/context.js");
const { createApiHandler } = await import("../src/lambdas/api/index.js");
const { createImportWorkerHandler } = await import("../src/lambdas/import-worker/index.js");
const { createProjectorHandler } = await import("../src/lambdas/projector/index.js");
const { createNotifySmsHandler } = await import("../src/lambdas/notify-sms/index.js");
const { createNotifyEmailHandler } = await import("../src/lambdas/notify-email/index.js");
const { createOutboxPollerHandler } = await import("../src/lambdas/outbox-poller/index.js");

async function buildStore() {
  if (opt.memory) return { store: undefined, dbMode: "memory", label: "memoria (sin persistencia)" };
  const pg = (await import("pg")).default;
  const { PgStore, runMigrations } = await import("../src/shared/db.js");
  const pool = new pg.Pool({
    host: process.env.PGHOST || "127.0.0.1",
    port: Number(process.env.PGPORT || 55432),
    user: process.env.PGUSER || "orquesta_admin",
    password: process.env.PGPASSWORD || "orquesta",
    database: process.env.PGDATABASE || "orquesta",
    max: 10,
  });
  try {
    const { applied } = await runMigrations(pool);
    if (applied?.length) console.log(`migraciones aplicadas: ${applied.join(", ")}`);
  } catch (err) {
    console.error(`\nNo pude conectar a PostgreSQL (${err.message}).\nCorre "npm run db:up" o usa "npm run dev -- --memory".\n`);
    process.exit(1);
  }
  return { store: new PgStore({ pool, piiKey: "orquesta-dev-pii-key-32bytes!" }), dbMode: "aurora", label: "PostgreSQL localhost:55432" };
}

const { store, dbMode, label } = await buildStore();
const ctx = await createAppContext({ dbMode, store, silentMetrics: true });
ctx.queueBus.registerConsumer("import_jobs", createImportWorkerHandler(ctx));
ctx.queueBus.registerConsumer("projection", createProjectorHandler(ctx));
ctx.queueBus.registerConsumer("notify_sms", createNotifySmsHandler(ctx));
ctx.queueBus.registerConsumer("notify_email", createNotifyEmailHandler(ctx));
const api = createApiHandler(ctx);
const poller = createOutboxPollerHandler(ctx);

// --- "Bandeja" de mensajes capturados -----------------------------------------
const seen = { email: 0, sms: 0 };
function printOutbox() {
  const emails = ctx.emailProvider.captured || [];
  const sms = ctx.smsProvider.captured || [];
  for (; seen.email < emails.length; seen.email++) {
    const m = emails[seen.email];
    const md = m.metadata || {};
    console.log(`\n📧 EMAIL → ${m.to}\n   ${m.subject || ""}`);
    if (md.token) console.log(`   token de verificación: ${md.token}`);
    if (md.rsvp_url) console.log(`   invitación: ${md.rsvp_url}`);
    if (md.codigo_otp) console.log(`   código OTP: ${md.codigo_otp}`);
  }
  for (; seen.sms < sms.length; seen.sms++) {
    const m = sms[seen.sms];
    const md = m.metadata || {};
    console.log(`\n📱 SMS → ${m.to}\n   ${m.message || ""}`);
    if (md.codigo_otp) console.log(`   código OTP: ${md.codigo_otp}`);
  }
}

// --- Workers: drenar colas seguido y el poller cada 30 s ------------------------
let draining = false;
setInterval(async () => {
  if (draining) return;
  draining = true;
  try {
    await flushOutboxNow(ctx);
    await ctx.queueBus.drainAll();
    printOutbox();
  } catch (err) {
    console.error("worker:", err.message);
  } finally {
    draining = false;
  }
}, 500);
setInterval(() => poller().catch((err) => console.error("outbox-poller:", err.message)), 30_000);

// --- HTTP -----------------------------------------------------------------------
function corsHeaders(origin) {
  return {
    "access-control-allow-origin": origin || FRONT_ORIGIN,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "Authorization,Content-Type,Idempotency-Key,If-None-Match,If-Match",
    "access-control-expose-headers": "ETag,Idempotency-Key,Retry-After",
    vary: "Origin",
  };
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const allowedOrigin = origin && (origin === FRONT_ORIGIN || /^http:\/\/localhost:\d+$/.test(origin)) ? origin : FRONT_ORIGIN;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(allowedOrigin));
    return res.end();
  }

  // Solo en el servidor local (no existe en la Lambda): bandeja de emails/SMS capturados, para
  // scripts como `npm run seed` que necesitan tokens de verificación, OTP o links de invitación.
  if (req.method === "GET" && url.pathname === "/__dev/messages") {
    const pick = (m) => ({ to: m.to, subject: m.subject, message: m.message, metadata: m.metadata });
    res.writeHead(200, { ...corsHeaders(allowedOrigin), "content-type": "application/json" });
    return res.end(
      JSON.stringify({
        emails: (ctx.emailProvider.captured || []).map(pick),
        sms: (ctx.smsProvider.captured || []).map(pick),
      })
    );
  }

  const contentType = req.headers["content-type"] || "";
  const isBinary = raw.length > 0 && !/json|text|x-www-form-urlencoded/.test(contentType);
  const event = {
    version: "2.0",
    requestContext: { http: { method: req.method, path: url.pathname, sourceIp: req.socket.remoteAddress } },
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : v])),
    cookies: req.headers.cookie ? req.headers.cookie.split(";").map((c) => c.trim()) : [],
    body: raw.length ? (isBinary ? raw.toString("base64") : raw.toString("utf8")) : undefined,
    isBase64Encoded: isBinary,
  };

  const t0 = Date.now();
  const out = await api(event);
  const headers = { ...corsHeaders(allowedOrigin), ...(out.headers || {}) };
  // `Secure` impide guardar la cookie en http://localhost en algunos navegadores (Safari).
  if (out.cookies?.length) headers["set-cookie"] = out.cookies.map((c) => c.replace(/;\s*Secure/i, ""));
  res.writeHead(out.statusCode, headers);
  res.end(out.isBase64Encoded ? Buffer.from(out.body || "", "base64") : out.body || "");
  console.log(`${req.method} ${url.pathname} → ${out.statusCode} (${Date.now() - t0} ms)`);
});

server.listen(PORT, () => {
  console.log(`\nOrquesta API local en http://localhost:${PORT}  ·  datos: ${label}`);
  console.log(`Front: cd front && npx ng serve  →  ${FRONT_ORIGIN}`);
  console.log("Los emails y SMS se imprimen aquí abajo (tokens, OTP y links de invitación).\n");
});
