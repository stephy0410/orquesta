import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createApiHandler } from "../src/lambdas/api/index.js";
import { createImportWorkerHandler } from "../src/lambdas/import-worker/index.js";
import { createNotifyEmailHandler } from "../src/lambdas/notify-email/index.js";
import { createNotifySmsHandler } from "../src/lambdas/notify-sms/index.js";
import { createOutboxPollerHandler } from "../src/lambdas/outbox-poller/index.js";
import { createProjectorHandler } from "../src/lambdas/projector/index.js";
import { createAppContext } from "../src/shared/context.js";
import {
  computeBatchChecksum,
  signWebhookHmac,
  verifyEs256Jws,
} from "../src/shared/crypto.js";
import { parseGuestsCsv } from "../src/shared/domain-helpers.js";
import { MockPspTestAdapter, verifyPaymentProviderContract } from "../src/shared/ports.js";
import { createHmac } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// TEST_DB=pg corre la misma suite contra PostgreSQL real (PgStore + migraciones);
// por defecto usa InMemoryStore. Ver back/README.md §Pruebas.
const TEST_DB = process.env.TEST_DB === "pg" ? "pg" : "memory";

async function createTestHarness({ nowDate = new Date("2026-06-10T12:00:00Z"), paymentProvider = null } = {}) {
  let currentNow = new Date(nowDate);
  const pgStore = TEST_DB === "pg" ? await createFreshPgStore() : null;
  const ctx = await createAppContext({
    dbMode: TEST_DB === "pg" ? "aurora" : "memory",
    store: pgStore || undefined,
    silentMetrics: true,
    now: () => new Date(currentNow),
    // Nunca llamar a Stripe real desde la suite, aunque haya STRIPE_SECRET_KEY en el entorno.
    stripeSecretKey: "",
    portOverrides: paymentProvider ? { paymentProvider } : undefined,
  });
  const introspect = pgStore ? pgIntrospection(pgStore) : memoryIntrospection(ctx.store);
  // PG: alinea el reloj de prueba de la BD con el reloj simulado antes de cada operación.
  const syncDbClock = pgStore
    ? () => pgStore.pool.query(`UPDATE test_clock SET now = $1`, [new Date(currentNow).toISOString()])
    : async () => {};

  const api = createApiHandler(ctx);
  const importWorker = createImportWorkerHandler(ctx);
  const projector = createProjectorHandler(ctx);
  const notifySms = createNotifySmsHandler(ctx);
  const notifyEmail = createNotifyEmailHandler(ctx);
  const outboxPoller = createOutboxPollerHandler(ctx);

  ctx.queueBus.registerConsumer("import_jobs", importWorker);
  ctx.queueBus.registerConsumer("projection", projector);
  ctx.queueBus.registerConsumer("notify_sms", notifySms);
  ctx.queueBus.registerConsumer("notify_email", notifyEmail);

  async function request(method, rawPath, { body = null, headers = {}, cookies = [], rawBody = null, query = {} } = {}) {
    await syncDbClock();
    const qs = new URLSearchParams(query).toString();
    const isStringBody = typeof rawBody === "string";
    const serialized =
      rawBody !== null
        ? isStringBody
          ? rawBody
          : Buffer.from(rawBody).toString("base64")
        : body !== null
          ? JSON.stringify(body)
          : undefined;
    const event = {
      version: "2.0",
      requestContext: { http: { method, path: rawPath } },
      rawPath,
      rawQueryString: qs,
      headers: {
        ...(body !== null && !headers["content-type"] ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      cookies,
      body: serialized,
      isBase64Encoded: rawBody !== null && !isStringBody,
    };
    const res = await api(event);
    const parsed = res.body ? JSON.parse(res.body) : null;
    return { status: res.statusCode, headers: res.headers, cookies: res.cookies || [], body: parsed };
  }

  async function registerAndLoginUser({ email, password = "Password123!", role = "planner", tipo = "persona" }) {
    const regPath = role === "worker" ? "/v1/auth/worker/register" : "/v1/auth/register";
    const reg = await request("POST", regPath, { body: { email, password, tipo } });
    assert.equal(reg.status, role === "worker" ? 201 : 201);
    await ctx.queueBus.drainQueue("notify_email");
    const emailMsg = [...ctx.emailProvider.captured].reverse().find((m) => m.to === email.toLowerCase());
    assert.ok(emailMsg, `Verification email should be captured for ${email}`);
    const vfy = await request("POST", "/v1/auth/verify-email", { body: { token: emailMsg.metadata.token } });
    assert.equal(vfy.status, 200);
    const login = await request("POST", "/v1/auth/login", { body: { email, password } });
    assert.equal(login.status, 200);
    const cookieHeader = (login.cookies[0] || "").split(";")[0];
    return {
      userId: reg.body.user_id,
      token: login.body.access_token,
      cookie: cookieHeader,
      headers: { authorization: `Bearer ${login.body.access_token}` },
    };
  }

  return {
    ctx,
    introspect,
    request,
    registerAndLoginUser,
    drainAll: async () => {
      await syncDbClock();
      return ctx.queueBus.drainAll();
    },
    outboxPoller: async (...args) => {
      await syncDbClock();
      return outboxPoller(...args);
    },
    setNow: (d) => {
      currentNow = new Date(d);
    },
    advanceMs: (ms) => {
      currentNow = new Date(currentNow.getTime() + ms);
    },
  };
}

// --- Backends de prueba -------------------------------------------------------

/**
 * Cada harness obtiene un esquema PostgreSQL recién creado (aislamiento entre tests
 * sin depender del orden de ejecución). Requiere PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE.
 */
let pgSchemaSeq = 0;
const openPools = [];
const createdSchemas = [];
async function createFreshPgStore() {
  const pg = (await import("pg")).default;
  const { PgStore, runMigrations } = await import("../src/shared/db.js");
  const schema = `t_${process.pid}_${Date.now().toString(36)}_${pgSchemaSeq++}`;
  const baseConfig = {
    host: process.env.PGHOST || "127.0.0.1",
    port: Number(process.env.PGPORT || 55432),
    user: process.env.PGUSER || "orquesta_admin",
    password: process.env.PGPASSWORD || "orquesta",
    database: process.env.PGDATABASE || "orquesta",
  };
  const admin = new pg.Pool({ ...baseConfig, max: 1 });
  // Extensiones en `public` para que todos los esquemas de prueba las vean.
  await admin.query(`CREATE EXTENSION IF NOT EXISTS btree_gist SCHEMA public`);
  await admin.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA public`);
  await admin.query(`CREATE SCHEMA ${schema}`);
  createdSchemas.push(schema);
  await admin.end();
  const pool = new pg.Pool({
    ...baseConfig,
    max: Number(process.env.DB_POOL_MAX || 20),
    options: `-c search_path=${schema},public`,
  });
  openPools.push(pool);
  await runMigrations(pool);
  // Reloj de prueba: los tests viajan en el tiempo con `now()` simulado de la app; en producción
  // ambos relojes coinciden. Solo en estos esquemas efímeros, `set_updated_at()` (que alimenta
  // la "última actividad" de NFR-08) lee el reloj simulado en vez de `now()` de la BD.
  await pool.query(`CREATE TABLE test_clock (now timestamptz)`);
  await pool.query(`INSERT INTO test_clock VALUES (NULL)`);
  await pool.query(`
    CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
    BEGIN
      NEW.updated_at = COALESCE((SELECT now FROM test_clock LIMIT 1), now());
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql`);
  return new PgStore({ pool, piiKey: "orquesta-dev-pii-key-32bytes!" });
}

test.after(async () => {
  await Promise.all(openPools.map((p) => p.end().catch(() => {})));
  if (createdSchemas.length === 0 || process.env.KEEP_TEST_SCHEMAS === "1") return;
  const pg = (await import("pg")).default;
  const admin = new pg.Pool({
    host: process.env.PGHOST || "127.0.0.1",
    port: Number(process.env.PGPORT || 55432),
    user: process.env.PGUSER || "orquesta_admin",
    password: process.env.PGPASSWORD || "orquesta",
    database: process.env.PGDATABASE || "orquesta",
    max: 1,
  });
  for (const schema of createdSchemas) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
});

function memoryIntrospection(store) {
  return {
    async rawUser(userId) {
      return store.users.get(userId);
    },
    async rsvpTokenFor(invitationId) {
      return store._dec(store.invitations.get(invitationId).rsvp_token_cifrado);
    },
    async reminderJobCount() {
      return store.reminderJobs.size;
    },
    async outboxPayloads(eventType) {
      return store.outboxEvents.filter((o) => o.event_type === eventType).map((o) => o.payload);
    },
    async guestRow(guestId) {
      return store.guests.get(guestId);
    },
    async reminderJobsForGuest(guestId) {
      return [...store.reminderJobs.values()].filter((j) => j.guest_id === guestId);
    },
  };
}

function pgIntrospection(store) {
  return {
    async rawUser(userId) {
      const r = await store.pool.query(`SELECT * FROM "user" WHERE id = $1`, [userId]);
      return r.rows[0];
    },
    async rsvpTokenFor(invitationId) {
      const r = await store.pool.query(`SELECT rsvp_token_cifrado FROM invitation WHERE id = $1`, [invitationId]);
      return store._dec(r.rows[0].rsvp_token_cifrado);
    },
    async reminderJobCount() {
      const r = await store.pool.query(`SELECT count(*)::int AS n FROM reminder_job`);
      return r.rows[0].n;
    },
    async outboxPayloads(eventType) {
      const r = await store.pool.query(`SELECT payload FROM outbox_event WHERE event_type = $1`, [eventType]);
      return r.rows.map((x) => x.payload);
    },
    async guestRow(guestId) {
      const r = await store.pool.query(`SELECT * FROM guest WHERE id = $1`, [guestId]);
      return r.rows[0];
    },
    async reminderJobsForGuest(guestId) {
      const r = await store.pool.query(`SELECT * FROM reminder_job WHERE guest_id = $1`, [guestId]);
      return r.rows;
    },
  };
}

function buildMultipartCsv(csvText, boundary = "----OrquestaBoundary123") {
  const payload =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="guests.csv"\r\n` +
    `Content-Type: text/csv\r\n\r\n` +
    `${csvText}\r\n` +
    `--${boundary}--\r\n`;
  return {
    rawBody: payload,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

// ============================================================================
// 0. DDL SQL e Integridad de Migración
// ============================================================================
test("001_initial_schema.sql contiene las 22 entidades, extensiones, vistas y triggers normativos", async () => {
  const sql = await readFile(path.join(__dirname, "../migrations/001_initial_schema.sql"), "utf8");
  for (const required of [
    "CREATE EXTENSION IF NOT EXISTS btree_gist",
    "CREATE EXTENSION IF NOT EXISTS pgcrypto",
    "set_updated_at()",
    'CREATE TABLE "user"',
    "CREATE TABLE event_membership",
    "CREATE TABLE venue",
    "CREATE TABLE event",
    "CREATE TABLE event_requirement",
    "CREATE TABLE guest",
    "CREATE TABLE invitation",
    "CREATE TABLE event_access_token",
    "CREATE TABLE staff_assignment",
    "CREATE TABLE invitation_delivery",
    "CREATE TABLE rsvp_response",
    "CREATE TABLE checkin_event",
    "CREATE TABLE device_sync_state",
    "CREATE TABLE event_table",
    "CREATE TABLE seat_assignment",
    "CREATE TABLE reminder_job",
    "CREATE TABLE audit_entry",
    "CREATE TABLE worker_profile",
    "CREATE TABLE availability_window",
    "CREATE TABLE worker_reservation",
    "CREATE TABLE payment",
    "CREATE TABLE payment_entry",
    "CREATE OR REPLACE VIEW worker_profile_publico",
    "CREATE TABLE event_counters",
    "CREATE TABLE outbox_event",
    "CREATE TABLE idempotency_record",
    "CREATE TABLE projector_applied",
    "CREATE TABLE verification_challenge",
    "assert_transaccion_balanceada()",
    "DEFERRABLE INITIALLY DEFERRED",
    "aceptar_worker_reservation",
    "pg_advisory_xact_lock",
  ]) {
    assert.ok(sql.includes(required), `SQL migration missing: ${required}`);
  }
});

// ============================================================================
// 1. Health, Auth, Cookie httpOnly, OTP (AC-25), PII AES-256-GCM y WebCrypto ES256
// ============================================================================
test("Auth, OTP, unicidad de teléfono (AC-25), AES-256-GCM y firma ES256 compatible con Web Crypto", async () => {
  const h = await createTestHarness();

  // Health
  const health = await h.request("GET", "/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.status, "ok");

  // Registro sin verificar bloquea login (RF-19)
  const reg = await h.request("POST", "/v1/auth/register", {
    body: { email: "planner1@orquesta.test", password: "Password123!" },
  });
  assert.equal(reg.status, 201);
  const blockedLogin = await h.request("POST", "/v1/auth/login", {
    body: { email: "planner1@orquesta.test", password: "Password123!" },
  });
  assert.equal(blockedLogin.status, 403);
  assert.equal(blockedLogin.body.error.code, "EMAIL_NOT_VERIFIED");

  // Verificar email + login emite cookie httpOnly + Bearer
  await h.ctx.queueBus.drainQueue("notify_email");
  const verifyTok = h.ctx.emailProvider.captured[0].metadata.token;
  const vfy1 = await h.request("POST", "/v1/auth/verify-email", { body: { token: verifyTok } });
  assert.equal(vfy1.status, 200);
  // Segundo uso es idempotente
  const vfy2 = await h.request("POST", "/v1/auth/verify-email", { body: { token: verifyTok } });
  assert.equal(vfy2.status, 200);

  const login = await h.request("POST", "/v1/auth/login", {
    body: { email: "planner1@orquesta.test", password: "Password123!" },
  });
  assert.equal(login.status, 200);
  assert.ok(login.cookies[0].includes("HttpOnly"));
  assert.ok(login.cookies[0].includes("SameSite=Lax"));

  // Autenticación usando Cookie httpOnly sin header Authorization
  const cookieOnlyEvents = await h.request("GET", "/v1/events", {
    cookies: [login.cookies[0].split(";")[0]],
  });
  assert.equal(cookieOnlyEvents.status, 200);

  // Verificar que PII en store está cifrada con AES-256-GCM (NFR-07)
  const rawUser = await h.introspect.rawUser(reg.body.user_id);
  assert.ok(rawUser.email_cifrado.startsWith("enc:v1:"));
  assert.ok(rawUser.email == null, "el email nunca se persiste en claro (NFR-07)");

  // Trabajador 1: alta, perfil completo, invisible sin OTP, visible tras OTP (AC-25)
  const w1 = await h.registerAndLoginUser({ email: "worker1@orquesta.test", role: "worker" });
  const prof1 = await h.request("POST", "/v1/worker/profile", {
    headers: w1.headers,
    body: {
      tipo: "persona",
      nombre_publico: "Chef Sofía",
      categorias: ["mesero"],
      servicios: ["servicio_mesa"],
      tarifa: { modo: "fijo", monto: 500, moneda: "MXN", unidad: "hora" },
      zonas: ["sur"],
      telefono_e164: "+525511223344",
    },
  });
  assert.equal(prof1.status, 201);

  // Intentar publicar antes de OTP -> PROFILE_NOT_VERIFIED
  const pubFail = await h.request("POST", "/v1/worker/profile/publish", { headers: w1.headers });
  assert.equal(pubFail.status, 409);
  assert.equal(pubFail.body.error.code, "PROFILE_NOT_VERIFIED");

  // Incluso si estado se marca 'publicado' antes de verificar teléfono, búsqueda devuelve 0 (AC-25)
  await h.request("PATCH", "/v1/worker/profile", {
    headers: w1.headers,
    body: { estado: "publicado" },
  });
  const plannerHeaders = { authorization: `Bearer ${login.body.access_token}` };
  const searchBeforeOtp = await h.request("GET", "/v1/workers", {
    headers: plannerHeaders,
    query: { categorias: "mesero", zonas: "sur" },
  });
  assert.equal(searchBeforeOtp.status, 200);
  assert.equal(searchBeforeOtp.body.items.length, 0);

  // Verificar teléfono por OTP SMS (y duplicado por email D11)
  const chal = await h.request("POST", "/v1/worker/profile/verifications", {
    headers: w1.headers,
    body: { canal: "telefono" },
  });
  assert.equal(chal.status, 202);
  await h.drainAll();
  const otpSms = h.ctx.smsProvider.captured.find((s) => s.to === "+525511223344");
  assert.ok(otpSms);
  const confirmOtp = await h.request("POST", `/v1/worker/profile/verifications/${chal.body.desafio_id}/confirm`, {
    headers: w1.headers,
    body: { codigo_otp: otpSms.metadata.codigo_otp },
  });
  assert.equal(confirmOtp.status, 200);
  assert.equal(confirmOtp.body.visible_en_busqueda, true);

  // Ahora SÍ aparece en búsqueda, SIN exponer datos de contacto (NFR-11 exc. 2)
  const searchAfterOtp = await h.request("GET", "/v1/workers", {
    headers: plannerHeaders,
    query: { categorias: "mesero", zonas: "sur" },
  });
  assert.equal(searchAfterOtp.body.items.length, 1);
  assert.equal(searchAfterOtp.body.items[0].worker_id, prof1.body.worker_id);
  assert.equal(searchAfterOtp.body.items[0].telefono_e164, undefined);

  // Trabajador 2 intentando verificar el mismo teléfono -> rechazado (AC-25)
  const w2 = await h.registerAndLoginUser({ email: "worker2@orquesta.test", role: "worker" });
  await h.request("POST", "/v1/worker/profile", {
    headers: w2.headers,
    body: {
      tipo: "persona",
      nombre_publico: "Otro Mesero",
      categorias: ["mesero"],
      zonas: ["sur"],
      tarifa: { monto: 400, moneda: "MXN", unidad: "hora" },
    },
  });
  const dupPhoneReq = await h.request("POST", "/v1/worker/profile/verifications", {
    headers: w2.headers,
    body: { canal: "telefono", telefono_e164: "+525511223344" },
  });
  assert.equal(dupPhoneReq.status, 409);
  assert.equal(dupPhoneReq.body.error.code, "TELEFONO_YA_REGISTRADO");

  // Interoperabilidad 100% Web Crypto SubtleCrypto ECDSA P-256 / SHA-256 (TR-06)
  const jws = await h.ctx.qrSigner.signJws({
    typ: "checkin_qr",
    invitation_id: "inv_test_1",
    event_id: "evt_test_1",
    token_version: 1,
    key_id: "k-2026-03",
  });
  const { public_key_pem } = await h.ctx.qrSigner.getPublicKey();
  const spkiDer = Buffer.from(
    public_key_pem.replace(/-----BEGIN PUBLIC KEY-----|\r|\n|-----END PUBLIC KEY-----/g, ""),
    "base64"
  );
  const webCryptoKey = await globalThis.crypto.subtle.importKey(
    "spki",
    spkiDer,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
  const [hdr, pld, sig] = jws.split(".");
  const webVerified = await globalThis.crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    webCryptoKey,
    Buffer.from(sig, "base64url"),
    Buffer.from(`${hdr}.${pld}`, "utf8")
  );
  assert.equal(webVerified, true);
  assert.equal(verifyEs256Jws(jws, public_key_pem).payload.invitation_id, "inv_test_1");
});

// ============================================================================
// 2. Creación de evento, Aforo, Import Idempotente, Envío Paralelo, RSVP y Baja
//    (AC-20, AC-11, AC-13, AC-21, AC-06, AC-12, AC-23, AC-24)
// ============================================================================
test("Ciclo completo del invitado: evento, import CSV, envíos SMS+Email, RSVP sin cuenta y baja lógica", async () => {
  const h = await createTestHarness({ nowDate: "2026-06-01T12:00:00Z" });
  const plannerA = await h.registerAndLoginUser({ email: "pa@orquesta.test" });
  const plannerB = await h.registerAndLoginUser({ email: "pb@orquesta.test" });

  const venue = await h.request("POST", "/v1/venues", {
    headers: plannerA.headers,
    body: { nombre: "Hacienda Sol", zona: "sur", direccion: "Av. Reforma 100" },
  });
  assert.equal(venue.status, 201);

  // AC-20: sin timezone/nombre/fecha/venue responde error determinista
  const badEvt = await h.request("POST", "/v1/events", {
    headers: plannerA.headers,
    body: {
      nombre: "Boda Sin TZ",
      fecha: "2026-06-15",
      ventana: { inicio: "2026-06-15T18:00:00-06:00", fin: "2026-06-16T01:00:00-06:00" },
      venue_id: venue.body.id,
      aforo: 2,
    },
  });
  assert.equal(badEvt.status, 422);
  assert.equal(badEvt.body.error.code, "VALIDATION_ERROR");

  // Crear evento con aforo = 2
  const evt = await h.request("POST", "/v1/events", {
    headers: { ...plannerA.headers, "idempotency-key": "evt-create-1" },
    body: {
      nombre: "Boda Robles",
      fecha: "2026-06-15",
      timezone: "America/Mexico_City",
      ventana: { inicio: "2026-06-15T18:00:00-06:00", fin: "2026-06-16T01:00:00-06:00" },
      venue_id: venue.body.id,
      aforo: 2,
    },
  });
  assert.equal(evt.status, 201);
  const eventId = evt.body.id;

  // Replay misma Idempotency-Key -> mismo evento; distinto cuerpo -> 409 IDEMPOTENCY_CONFLICT
  const evtReplay = await h.request("POST", "/v1/events", {
    headers: { ...plannerA.headers, "idempotency-key": "evt-create-1" },
    body: {
      nombre: "Boda Robles",
      fecha: "2026-06-15",
      timezone: "America/Mexico_City",
      ventana: { inicio: "2026-06-15T18:00:00-06:00", fin: "2026-06-16T01:00:00-06:00" },
      venue_id: venue.body.id,
      aforo: 2,
    },
  });
  assert.equal(evtReplay.body.id, eventId);
  const evtConflict = await h.request("POST", "/v1/events", {
    headers: { ...plannerA.headers, "idempotency-key": "evt-create-1" },
    body: { nombre: "Otro" },
  });
  assert.equal(evtConflict.status, 409);
  assert.equal(evtConflict.body.error.code, "IDEMPOTENCY_CONFLICT");

  // AC-20 / AC-15: no aparece en tablero de planner B
  const dashB = await h.request("GET", "/v1/dashboard", { headers: plannerB.headers });
  assert.equal(dashB.body.items.length, 0);

  // AC-20: Import que excede aforo (3 válidos > aforo 2) -> 422 AFORO_EXCEDIDO con 0 creados
  const overCsv = buildMultipartCsv(
    "nombre,email,telefono\nAna,ana@x.com,+525500000001\nLuis,luis@x.com,+525500000002\nEva,eva@x.com,+525500000003\n"
  );
  const overRes = await h.request("POST", `/v1/events/${eventId}/guests/import`, {
    headers: { ...plannerA.headers, "content-type": overResContentType(overCsv) },
    rawBody: overCsv.rawBody,
  });
  function overResContentType(mp) {
    return mp.contentType;
  }
  assert.equal(overRes.status, 422);
  assert.equal(overRes.body.error.code, "AFORO_EXCEDIDO");
  const guestsAfterOver = await h.request("GET", `/v1/events/${eventId}/guests`, { headers: plannerA.headers });
  assert.equal(guestsAfterOver.body.items.length, 0);

  // AC-11 & AC-21: CSV con 1 sin clave, 1 duplicado interno, 2 válidos (0 mensajes enviados al importar)
  const csv1 = buildMultipartCsv(
    "nombre,email,telefono\n" +
      "Ana Ruiz,ANA@Example.com ,+52 55 1234 5678\n" +
      "Luis Prado,,+52 55 0000 1111\n" +
      "Sofía Nava,,\n" +
      "Ana Duplicada,ana@example.com,\n"
  );
  const imp1 = await h.request("POST", `/v1/events/${eventId}/guests/import`, {
    headers: { ...plannerA.headers, "content-type": csv1.contentType, "idempotency-key": "imp-k1" },
    rawBody: csv1.rawBody,
  });
  assert.equal(imp1.status, 202);
  await h.drainAll();

  const report1 = await h.request("GET", `/v1/events/${eventId}/guests/imports/${imp1.body.import_id}`, {
    headers: plannerA.headers,
  });
  assert.equal(report1.status, 200);
  assert.equal(report1.body.estado, "completado");
  assert.equal(report1.body.aceptadas, 2);
  assert.equal(report1.body.rechazadas, 1);
  assert.equal(report1.body.duplicadas_en_archivo, 1);
  assert.deepEqual(report1.body.errores, [
    { linea: 4, motivo: "GUEST_SIN_CLAVE" },
    { linea: 5, motivo: "GUEST_DUPLICADO" },
  ]);
  assert.equal(h.ctx.smsProvider.captured.length, 0);
  assert.equal(h.ctx.emailProvider.captured.length, 2); // solo los 2 de verify-email previos

  // Reimportar mismo CSV con distinta Idempotency-Key -> 0 invitados nuevos, 0 notificaciones (AC-11)
  const imp2 = await h.request("POST", `/v1/events/${eventId}/guests/import`, {
    headers: { ...plannerA.headers, "content-type": csv1.contentType, "idempotency-key": "imp-k2" },
    rawBody: csv1.rawBody,
  });
  assert.equal(imp2.status, 202);
  await h.drainAll();
  const report2 = await h.request("GET", `/v1/events/${eventId}/guests/imports/${imp2.body.import_id}`, {
    headers: plannerA.headers,
  });
  assert.equal(report2.body.aceptadas, 0);

  // Envío falla en borrador -> 409 EVENT_STATE_INVALID
  const sendDraft = await h.request("POST", `/v1/events/${eventId}/invitations/send`, {
    headers: plannerA.headers,
    body: { alcance: "pendiente_envio", destinatarios_confirmados: 2 },
  });
  assert.equal(sendDraft.status, 409);
  assert.equal(sendDraft.body.error.code, "EVENT_STATE_INVALID");

  // Publicar y validar confirmación requerida (RF-16)
  await h.request("POST", `/v1/events/${eventId}/publish`, { headers: plannerA.headers });
  const pendingSummary = await h.request("GET", `/v1/events/${eventId}/invitations/pending-summary`, {
    headers: plannerA.headers,
  });
  assert.equal(pendingSummary.body.destinatarios, 2);
  assert.deepEqual(pendingSummary.body.por_canal, { sms: 2, email: 1 });

  const wrongConfirm = await h.request("POST", `/v1/events/${eventId}/invitations/send`, {
    headers: plannerA.headers,
    body: { alcance: "pendiente_envio", destinatarios_confirmados: 99 },
  });
  assert.equal(wrongConfirm.status, 409);
  assert.equal(wrongConfirm.body.error.code, "CONFIRMACION_REQUERIDA");

  // Simular fallo de SMS (3 intentos -> rebotado) para +525512345678 (Ana) para probar entrega parcial (RF-04)
  h.ctx.smsProvider.setFailCount("+525512345678", 5);

  const sendOk = await h.request("POST", `/v1/events/${eventId}/invitations/send`, {
    headers: { ...plannerA.headers, "idempotency-key": "send-1" },
    body: { alcance: "pendiente_envio", destinatarios_confirmados: 2 },
  });
  assert.equal(sendOk.status, 202);
  assert.equal(sendOk.body.entregas_encoladas, 3); // Ana: sms+email, Luis: sms

  // Drenar colas (3 reintentos SMS para Ana hasta rebotado)
  await h.drainAll();
  await h.drainAll();
  await h.drainAll();
  await h.drainAll();

  const deliveries = await h.request("GET", `/v1/events/${eventId}/invitations/deliveries`, {
    headers: plannerA.headers,
  });
  const anaSms = deliveries.body.items.find((d) => d.canal === "sms" && d.estado === "rebotado");
  const anaEmail = deliveries.body.items.find((d) => d.canal === "email" && d.estado === "entregado");
  const luisSms = deliveries.body.items.find((d) => d.canal === "sms" && d.estado === "entregado");
  assert.ok(anaSms && anaSms.intentos === 3);
  assert.ok(anaEmail);
  assert.ok(luisSms);

  // Segundo envío automático sin pendientes -> 409 SIN_DESTINATARIOS_PENDIENTES (AC-21)
  const sendEmpty = await h.request("POST", `/v1/events/${eventId}/invitations/send`, {
    headers: plannerA.headers,
    body: { alcance: "pendiente_envio", destinatarios_confirmados: 0 },
  });
  assert.equal(sendEmpty.status, 409);
  assert.equal(sendEmpty.body.error.code, "SIN_DESTINATARIOS_PENDIENTES");

  // AC-13: Dedupe concurrente de entregas por clave TR-12
  const guestList = await h.request("GET", `/v1/events/${eventId}/guests`, { headers: plannerA.headers });
  const anaGuest = guestList.body.items.find((g) => g.nombre === "Ana Ruiz");
  const luisGuest = guestList.body.items.find((g) => g.nombre === "Luis Prado");

  const [rs1, rs2] = await Promise.all([
    h.request("POST", `/v1/events/${eventId}/invitations/resend`, {
      headers: plannerA.headers,
      body: { guest_ids: [anaGuest.id], canal: "email", ventana: "resend_1" },
    }),
    h.request("POST", `/v1/events/${eventId}/invitations/resend`, {
      headers: plannerA.headers,
      body: { guest_ids: [anaGuest.id], canal: "email", ventana: "resend_1" },
    }),
  ]);
  assert.equal(rs1.body.entregas_encoladas + rs2.body.entregas_encoladas, 1);
  await h.drainAll();

  // AC-23, AC-06, AC-12: Página pública de invitación sin cookie, separación de tokens y cancelación de recordatorio
  const anaEmailMsg = h.ctx.emailProvider.captured.find(
    (m) => m.to === "ana@example.com" && m.metadata?.rsvp_url
  );
  const rsvpHashParams = new URLSearchParams(anaEmailMsg.metadata.rsvp_url.split("#")[1] || "");
  const rsvpToken = rsvpHashParams.get("t");
  assert.ok(rsvpToken);
  assert.equal(rsvpHashParams.get("e"), eventId);
  assert.equal(rsvpHashParams.get("q"), null);
  assert.equal(rsvpHashParams.get("c"), null);

  const smsInvMsg = h.ctx.smsProvider.captured.find(
    (m) => m.metadata?.plantilla === "invitacion" && m.message.includes("#")
  );
  assert.ok(smsInvMsg);
  const smsHashParams = new URLSearchParams(smsInvMsg.message.split("#")[1] || "");
  assert.ok(smsHashParams.get("t"));
  assert.equal(smsHashParams.get("e"), eventId);
  assert.equal(smsHashParams.get("q"), null);
  assert.equal(smsHashParams.get("c"), null);

  const pubSummary = await h.request("GET", `/v1/public/events/${eventId}/summary`);
  assert.equal(pubSummary.status, 200);
  assert.ok(pubSummary.headers["cache-control"].includes("s-maxage=300"));

  const pubGet = await h.request("GET", `/v1/public/invitations/${rsvpToken}/rsvp`);
  assert.equal(pubGet.status, 200);
  assert.equal(pubGet.headers["cache-control"], "no-store");
  assert.equal(pubGet.body.respuesta, null);
  assert.ok(pubGet.body.qr.token);

  // AC-06 / TR-07: usar QR de check-in como token de RSVP -> 400 TOKEN_TIPO_INCORRECTO
  const wrongTokenType = await h.request("POST", `/v1/public/invitations/${pubGet.body.qr.token}/rsvp`, {
    body: { respuesta: "confirma" },
  });
  assert.equal(wrongTokenType.status, 400);
  assert.equal(wrongTokenType.body.error.code, "TOKEN_TIPO_INCORRECTO");

  // Confirmar RSVP -> 201, QR sigue visible, cancela recordatorios pendientes T-7d y T-1d (AC-12)
  const rsvpConfirm = await h.request("POST", `/v1/public/invitations/${rsvpToken}/rsvp`, {
    body: { respuesta: "confirma" },
  });
  assert.equal(rsvpConfirm.status, 201);
  assert.equal(rsvpConfirm.body.respuesta, "confirma");
  assert.equal(rsvpConfirm.body.recordatorios_cancelados, 4); // 2 canales x (t_7d, t_1d)
  assert.ok(rsvpConfirm.body.qr.token);

  // Declinar y volver a confirmar: NO reactiva jobs cancelados (AC-12)
  const rsvpDecline = await h.request("POST", `/v1/public/invitations/${rsvpToken}/rsvp`, {
    body: { respuesta: "declina" },
  });
  assert.equal(rsvpDecline.status, 200);
  assert.ok(rsvpDecline.body.superseded_at);

  const rsvpReconfirm = await h.request("POST", `/v1/public/invitations/${rsvpToken}/rsvp`, {
    body: { respuesta: "confirma" },
  });
  assert.equal(rsvpReconfirm.status, 200);

  // Avanzar a T-1d y correr outboxPoller: NO debe enviar recordatorio para Ana (ya respondió)
  h.setNow("2026-06-15T12:00:00Z");
  const emailsBeforePoller = h.ctx.emailProvider.captured.length;
  await h.outboxPoller();
  await h.drainAll();
  const anaReminderSent = h.ctx.emailProvider.captured
    .slice(emailsBeforePoller)
    .some((m) => m.to === "ana@example.com");
  assert.equal(anaReminderSent, false);

  // Tablero refleja invitados=2, confirmados=1, entregas_parciales=1
  const reLoginA = await h.request("POST", "/v1/auth/login", {
    body: { email: "pa@orquesta.test", password: "Password123!" },
  });
  const plannerA15 = { authorization: `Bearer ${reLoginA.body.access_token}` };
  const dashA = await h.request("GET", "/v1/dashboard", { headers: plannerA15 });
  assert.equal(dashA.body.items[0].contadores.invitados, 2);
  assert.equal(dashA.body.items[0].contadores.confirmados, 1);
  assert.equal(dashA.body.items[0].contadores.entregas_parciales, 1);
  assert.equal(dashA.body.items[0].no_show, null);

  // AC-24: Baja lógica de invitado revoca tokens, conserva historial y NO libera aforo
  const delAna = await h.request("DELETE", `/v1/events/${eventId}/guests/${anaGuest.id}`, {
    headers: plannerA15,
  });
  assert.equal(delAna.status, 200);
  assert.equal(delAna.body.token_revocado, true);

  const pubRevoked = await h.request("GET", `/v1/public/invitations/${rsvpToken}/rsvp`);
  assert.equal(pubRevoked.status, 410);
  assert.equal(pubRevoked.body.error.code, "INVITACION_REVOCADA");

  // Aforo sigue ocupado (2/2): intentar importar otro invitado nuevo falla con AFORO_EXCEDIDO
  const thirdCsv = buildMultipartCsv("nombre,email,telefono\nPedro,pedro@x.com,\n");
  const overAfterDel = await h.request("POST", `/v1/events/${eventId}/guests/import`, {
    headers: { ...plannerA15, "content-type": thirdCsv.contentType },
    rawBody: thirdCsv.rawBody,
  });
  assert.equal(overAfterDel.status, 422);
  assert.equal(overAfterDel.body.error.code, "AFORO_EXCEDIDO");
  assert.ok(luisGuest.id);
});

// ============================================================================
// 3. Check-in Offline, Replay, Convergencia Cross-Dispositivo, Anulación y Cierre Tardío
//    (AC-03, AC-05, AC-16, AC-17, TR-01, TR-03, TR-17, TR-18)
// ============================================================================
test("Check-in offline, replay idempotente, convergencia cross-dispositivo, anulación y tardío post-cierre", async () => {
  const h = await createTestHarness({ nowDate: "2026-06-15T10:00:00Z" });
  const planner = await h.registerAndLoginUser({ email: "scan-planner@orquesta.test" });
  const staff = await h.registerAndLoginUser({ email: "staff@orquesta.test", role: "worker" });

  const venue = await h.request("POST", "/v1/venues", {
    headers: planner.headers,
    body: { nombre: "Foro Centro", zona: "centro", direccion: "Calle 1" },
  });
  const evt = await h.request("POST", "/v1/events", {
    headers: planner.headers,
    body: {
      nombre: "Gala Tech",
      fecha: "2026-06-15",
      timezone: "America/Mexico_City",
      ventana: { inicio: "2026-06-15T18:00:00-06:00", fin: "2026-06-16T02:00:00-06:00" },
      venue_id: venue.body.id,
      aforo: 50,
    },
  });
  const eventId = evt.body.id;
  await h.request("POST", `/v1/events/${eventId}/publish`, { headers: planner.headers });
  await h.request("POST", `/v1/events/${eventId}/start`, { headers: planner.headers });

  const csv = buildMultipartCsv(
    "nombre,email,telefono\nCarlos Uno,carlos@x.com,+525511111111\nDiana Dos,diana@x.com,+525522222222\nElena Tres,elena@x.com,+525533333333\n"
  );
  await h.request("POST", `/v1/events/${eventId}/guests/import`, {
    headers: { ...planner.headers, "content-type": csv.contentType },
    rawBody: csv.rawBody,
  });
  await h.drainAll();

  const guests = (await h.request("GET", `/v1/events/${eventId}/guests`, { headers: planner.headers })).body.items;
  const invCarlos = guests[0].invitation_id;
  const invDiana = guests[1].invitation_id;
  const invElena = guests[2].invitation_id;

  // Dar de baja a Elena antes de sincronizar
  await h.request("DELETE", `/v1/events/${eventId}/guests/${guests[2].id}`, { headers: planner.headers });

  // StaffAssignment + EventAccessToken
  await h.request("POST", `/v1/events/${eventId}/staff-assignments`, {
    headers: planner.headers,
    body: { user_id: staff.userId, permisos: ["roster", "checkin", "anulacion"] },
  });
  const accTok = await h.request("POST", `/v1/events/${eventId}/access-tokens`, {
    headers: planner.headers,
    body: { rol: "staff" },
  });
  assert.equal(accTok.status, 201);

  const sess1Ex = await h.request("POST", "/v1/auth/event-session", {
    body: { access_token: accTok.body.qr_token, device_id: "dev_1" },
  });
  assert.equal(sess1Ex.status, 200);
  const dev1Headers = { authorization: `Bearer ${sess1Ex.body.session_token}` };

  const sess2Ex = await h.request("POST", "/v1/auth/event-session", {
    body: { access_token: accTok.body.qr_token, device_id: "dev_2" },
  });
  const dev2Headers = { authorization: `Bearer ${sess2Ex.body.session_token}` };

  // Roster firmado + ETag 304 + fallback búsqueda por código corto
  const roster = await h.request("GET", `/v1/scan-sessions/${sess1Ex.body.session_id}/roster`, {
    headers: dev1Headers,
  });
  assert.equal(roster.status, 200);
  assert.equal(roster.body.invitados.length, 2); // Elena ya está dada de baja
  const roster304 = await h.request("GET", `/v1/scan-sessions/${sess1Ex.body.session_id}/roster`, {
    headers: { ...dev1Headers, "if-none-match": roster.headers.etag },
  });
  assert.equal(roster304.status, 304);

  const searchShort = await h.request(
    "GET",
    `/v1/scan-sessions/${sess1Ex.body.session_id}/roster/search`,
    { headers: dev1Headers, query: { codigo_corto: guests[0].codigo_corto } }
  );
  assert.equal(searchShort.body.items[0].invitation_id, invCarlos);

  // Checksum mismatch -> 400 BATCH_CHECKSUM_MISMATCH
  const evsDev1 = [
    {
      sequence: 1,
      invitation_id: invCarlos,
      scanned_at: "2026-06-15T19:00:00-06:00",
      verdict_local: "admitido",
      modo: "camara",
    },
    {
      sequence: 2,
      invitation_id: invElena,
      scanned_at: "2026-06-15T19:01:00-06:00",
      verdict_local: "no_verificable_offline",
      modo: "camara",
    },
  ];
  const badBatch = await h.request("POST", `/v1/scan-sessions/${sess1Ex.body.session_id}/batches`, {
    headers: dev1Headers,
    body: {
      batch_id: "b1",
      device_id: "dev_1",
      event_id: eventId,
      seq_desde: 1,
      seq_hasta: 2,
      checksum: { alg: "sha256", valor: "0".repeat(64) },
      events: evsDev1,
    },
  });
  assert.equal(badBatch.status, 400);
  assert.equal(badBatch.body.error.code, "BATCH_CHECKSUM_MISMATCH");

  // AC-03: Replay del mismo lote 3 veces -> idéntico resultado, contador = 1
  const validPayload1 = {
    batch_id: "b1",
    device_id: "dev_1",
    event_id: eventId,
    seq_desde: 1,
    seq_hasta: 2,
    checksum: { alg: "sha256", valor: computeBatchChecksum(evsDev1) },
    cola_reportada: 0,
    events: evsDev1,
  };
  const b1r1 = await h.request("POST", `/v1/scan-sessions/${sess1Ex.body.session_id}/batches`, {
    headers: dev1Headers,
    body: validPayload1,
  });
  const b1r2 = await h.request("POST", `/v1/scan-sessions/${sess1Ex.body.session_id}/batches`, {
    headers: dev1Headers,
    body: validPayload1,
  });
  const b1r3 = await h.request("POST", `/v1/scan-sessions/${sess1Ex.body.session_id}/batches`, {
    headers: dev1Headers,
    body: validPayload1,
  });
  assert.equal(b1r1.status, 200);
  assert.deepEqual(b1r2.body, b1r1.body);
  assert.deepEqual(b1r3.body, b1r1.body);
  assert.equal(b1r1.body.results[0].verdict, "admitido");
  assert.equal(b1r1.body.results[1].verdict, "invitacion_revocada");
  assert.equal(b1r1.body.results[1].resolucion_al_sincronizar, "invalidado_al_sincronizar");

  // AC-05: Dispositivo 2 escaneó a Carlos offline (incluso con reloj más temprano!) -> al sincronizar queda duplicado_tardio
  const evsDev2 = [
    {
      sequence: 1,
      invitation_id: invCarlos,
      scanned_at: "2026-06-15T18:55:00-06:00",
      verdict_local: "admitido",
      modo: "camara",
    },
  ];
  const b2 = await h.request("POST", `/v1/scan-sessions/${sess2Ex.body.session_id}/batches`, {
    headers: dev2Headers,
    body: {
      batch_id: "b2",
      device_id: "dev_2",
      event_id: eventId,
      seq_desde: 1,
      seq_hasta: 1,
      checksum: { alg: "sha256", valor: computeBatchChecksum(evsDev2) },
      cola_reportada: 0,
      events: evsDev2,
    },
  });
  assert.equal(b2.status, 200);
  assert.equal(b2.body.results[0].kind, "duplicado_tardio");
  assert.equal(b2.body.results[0].verdict, "ya_registrado");
  assert.equal(b2.body.results[0].vigente_checkin_id, b1r1.body.results[0].checkin_id);

  await h.drainAll();
  const dash1 = await h.request("GET", "/v1/dashboard", { headers: planner.headers });
  assert.equal(dash1.body.items[0].contadores.asistentes, 1);

  // AC-16: Anular check-in -> baja asistentes 1 -> 0, replay es no-op, re-escanear vuelve a admitir
  const carlosCheckinId = b1r1.body.results[0].checkin_id;
  const ann1 = await h.request("POST", `/v1/events/${eventId}/checkins/${carlosCheckinId}/annulments`, {
    headers: staff.headers,
    body: { motivo: "Escaneo accidental" },
  });
  assert.equal(ann1.status, 201);
  assert.equal(ann1.body.asistentes, 0);

  const ann2 = await h.request("POST", `/v1/events/${eventId}/checkins/${carlosCheckinId}/annulments`, {
    headers: staff.headers,
    body: { motivo: "Escaneo accidental" },
  });
  assert.equal(ann2.status, 200);
  await h.drainAll();
  const dashAfterAnn = await h.request("GET", "/v1/dashboard", { headers: planner.headers });
  assert.equal(dashAfterAnn.body.items[0].contadores.asistentes, 0);

  // Re-escaneo de Carlos tras anulación -> admitido nuevamente!
  const reScanEv = [
    {
      sequence: 3,
      invitation_id: invCarlos,
      scanned_at: "2026-06-15T19:15:00-06:00",
      verdict_local: "admitido",
      modo: "camara",
    },
  ];
  const reScanBatch = await h.request("POST", `/v1/scan-sessions/${sess1Ex.body.session_id}/batches`, {
    headers: dev1Headers,
    body: {
      batch_id: "b1-rescan",
      device_id: "dev_1",
      event_id: eventId,
      seq_desde: 3,
      seq_hasta: 3,
      checksum: { alg: "sha256", valor: computeBatchChecksum(reScanEv) },
      events: reScanEv,
    },
  });
  assert.equal(reScanBatch.status, 200);
  assert.equal(reScanBatch.body.results[0].verdict, "admitido");

  // AC-17: Cerrar evento y sincronizar escaneo de Diana hecho DENTRO de la ventana del evento -> aceptado como `tardio`
  h.setNow("2026-06-16T07:30:00Z");
  const closeRes = await h.request("POST", `/v1/events/${eventId}/close`, { headers: planner.headers });
  assert.equal(closeRes.status, 200);
  assert.equal(closeRes.body.estado, "cerrado");

  const lateEv = [
    {
      sequence: 2,
      invitation_id: invDiana,
      scanned_at: "2026-06-15T20:00:00-06:00", // dentro de ventana
      verdict_local: "admitido",
      modo: "camara",
    },
    {
      sequence: 3,
      invitation_id: invDiana,
      scanned_at: "2026-06-17T20:00:00-06:00", // fuera de ventana -> rechazado individualmente
      verdict_local: "admitido",
      modo: "camara",
    },
  ];
  const lateBatch = await h.request("POST", `/v1/scan-sessions/${sess2Ex.body.session_id}/batches`, {
    headers: dev2Headers,
    body: {
      batch_id: "b2-late",
      device_id: "dev_2",
      event_id: eventId,
      seq_desde: 2,
      seq_hasta: 3,
      checksum: { alg: "sha256", valor: computeBatchChecksum(lateEv) },
      events: lateEv,
    },
  });
  assert.equal(lateBatch.status, 200);
  assert.equal(lateBatch.body.contadores.tardios, 1);
  assert.equal(lateBatch.body.contadores.rechazados, 1);
  assert.equal(lateBatch.body.results[0].tardio, true);
  assert.equal(lateBatch.body.results[0].verdict, "admitido");
  assert.equal(lateBatch.body.results[1].status, 400);

  // TR-18: Sin heartbeat en 5 min -> tablero reporta `desconocido`, nunca 0
  h.advanceMs(6 * 60 * 1000);
  const dashStale = await h.request("GET", "/v1/dashboard", { headers: planner.headers });
  assert.equal(dashStale.body.items[0].pendientes.estado, "desconocido");
  assert.equal(dashStale.body.items[0].pendientes.valor, null);
});

// ============================================================================
// 4. Seating Concurrency (AC-14)
// ============================================================================
test("Seating: 50 asignaciones concurrentes a mesa de 40, movimiento concurrente y liberación por RSVP declina (AC-14)", async () => {
  const h = await createTestHarness();
  const planner = await h.registerAndLoginUser({ email: "seat@orquesta.test" });
  const venue = await h.request("POST", "/v1/venues", {
    headers: planner.headers,
    body: { nombre: "Salón Mesas", zona: "centro", direccion: "Calle 2" },
  });
  const evt = await h.request("POST", "/v1/events", {
    headers: planner.headers,
    body: {
      nombre: "Cena 50",
      fecha: "2026-07-01",
      timezone: "America/Mexico_City",
      ventana: { inicio: "2026-07-01T18:00:00-06:00", fin: "2026-07-02T01:00:00-06:00" },
      venue_id: venue.body.id,
      aforo: 100,
    },
  });
  const eventId = evt.body.id;

  const lines = ["nombre,email,telefono"];
  for (let i = 1; i <= 50; i++) {
    lines.push(`Invitado ${i},inv${i}@x.com,`);
  }
  const csv = buildMultipartCsv(lines.join("\n"));
  await h.request("POST", `/v1/events/${eventId}/guests/import`, {
    headers: { ...planner.headers, "content-type": csv.contentType },
    rawBody: csv.rawBody,
  });
  await h.drainAll();
  const guests = (
    await h.request("GET", `/v1/events/${eventId}/guests`, {
      headers: planner.headers,
      query: { limit: "100" },
    })
  ).body.items;
  assert.equal(guests.length, 50);

  const mesa1 = await h.request("POST", `/v1/events/${eventId}/tables`, {
    headers: planner.headers,
    body: { nombre: "Mesa Grande", capacidad: 40 },
  });
  const mesa2 = await h.request("POST", `/v1/events/${eventId}/tables`, {
    headers: planner.headers,
    body: { nombre: "Mesa 2", capacidad: 10 },
  });

  // 50 asignaciones concurrentes sobre capacidad 40 -> 40 aceptadas, 10 MESA_SIN_CAPACIDAD
  const seatResponses = await Promise.all(
    guests.map((g) =>
      h.request("POST", `/v1/events/${eventId}/seat-assignments`, {
        headers: planner.headers,
        body: { guest_id: g.id, table_id: mesa1.body.id },
      })
    )
  );
  const okCount = seatResponses.filter((r) => r.status === 201 || r.status === 200).length;
  const fullCount = seatResponses.filter(
    (r) => r.status === 409 && r.body.error.code === "MESA_SIN_CAPACIDAD"
  ).length;
  assert.equal(okCount, 40);
  assert.equal(fullCount, 10);

  // Reintentar 3x una ganadora -> idempotente, ocupación sigue en 40
  const winnerIdx = seatResponses.findIndex((r) => r.status === 201);
  const winnerGuest = guests[winnerIdx];
  for (let k = 0; k < 3; k++) {
    const r = await h.request("POST", `/v1/events/${eventId}/seat-assignments`, {
      headers: planner.headers,
      body: { guest_id: winnerGuest.id, table_id: mesa1.body.id },
    });
    assert.equal(r.status, 200);
  }
  const tablesAfter = await h.request("GET", `/v1/events/${eventId}/tables`, { headers: planner.headers });
  assert.equal(tablesAfter.body.items[0].ocupacion, 40);

  // Mover invitado a mesa 2 y luego declinar RSVP -> libera capacidad
  await h.request("POST", `/v1/events/${eventId}/seat-assignments`, {
    headers: planner.headers,
    body: { guest_id: winnerGuest.id, table_id: mesa2.body.id },
  });
  const rsvpToken = await h.introspect.rsvpTokenFor(winnerGuest.invitation_id);
  const declineRes = await h.request("POST", `/v1/public/invitations/${rsvpToken}/rsvp`, {
    body: { respuesta: "declina" },
  });
  assert.equal(declineRes.status, 201);
  const tablesFinal = await h.request("GET", `/v1/events/${eventId}/tables`, { headers: planner.headers });
  assert.equal(tablesFinal.body.items[0].ocupacion, 39);
  assert.equal(tablesFinal.body.items[1].ocupacion, 0);
});

// ============================================================================
// 5. Concurrencia de Reservas (plazas=1 y plazas=6 parcial), Costo Congelado,
//    Emergencia, Cierre -> Completada y Aislamiento (AC-07, AC-15, AC-22, AC-26, AC-27, AC-29)
// ============================================================================
test("Contratación: 100 solicitudes concurrentes, plazas=1, empresa parcial plazas=6, costo congelado, emergencia y aislamiento", async () => {
  const h = await createTestHarness({ nowDate: "2026-06-01T12:00:00Z" });
  const wPersona = await h.registerAndLoginUser({ email: "wp1@orquesta.test", role: "worker" });
  const wEmpresa = await h.registerAndLoginUser({ email: "we1@orquesta.test", role: "worker", tipo: "empresa" });

  // Configurar perfil persona (plazas=1) y verificar OTP
  const pPers = await h.request("POST", "/v1/worker/profile", {
    headers: wPersona.headers,
    body: {
      tipo: "persona",
      nombre_publico: "DJ Único",
      categorias: ["dj"],
      tarifa: { monto: 850, moneda: "MXN", unidad: "evento" },
      zonas: ["centro"],
      telefono_e164: "+525533334444",
    },
  });
  const chPers = await h.request("POST", "/v1/worker/profile/verifications", {
    headers: wPersona.headers,
    body: { canal: "telefono" },
  });
  await h.drainAll();
  const otpPers = h.ctx.smsProvider.captured.find((s) => s.to === "+525533334444").metadata.codigo_otp;
  await h.request("POST", `/v1/worker/profile/verifications/${chPers.body.desafio_id}/confirm`, {
    headers: wPersona.headers,
    body: { codigo_otp: otpPers },
  });
  await h.request("POST", "/v1/worker/profile/publish", { headers: wPersona.headers });
  await h.request("POST", "/v1/worker/availability", {
    headers: wPersona.headers,
    body: {
      inicio: "2026-06-10T16:00:00Z",
      fin: "2026-06-11T04:00:00Z",
      zona: "centro",
      rol: "dj",
    },
  });

  // Configurar perfil empresa (plazas=6) y verificar OTP
  const pEmp = await h.request("POST", "/v1/worker/profile", {
    headers: wEmpresa.headers,
    body: {
      tipo: "empresa",
      plazas_ofrecidas: 6,
      nombre_publico: "Staff Co",
      categorias: ["mesero"],
      tarifa: { monto: 400, moneda: "MXN", unidad: "persona_hora" },
      zonas: ["centro"],
      telefono_e164: "+525544445555",
    },
  });
  const chEmp = await h.request("POST", "/v1/worker/profile/verifications", {
    headers: wEmpresa.headers,
    body: { canal: "telefono" },
  });
  await h.drainAll();
  const otpEmp = h.ctx.smsProvider.captured.find((s) => s.to === "+525544445555").metadata.codigo_otp;
  await h.request("POST", `/v1/worker/profile/verifications/${chEmp.body.desafio_id}/confirm`, {
    headers: wEmpresa.headers,
    body: { codigo_otp: otpEmp },
  });
  await h.request("POST", "/v1/worker/profile/publish", { headers: wEmpresa.headers });
  await h.request("POST", "/v1/worker/availability", {
    headers: wEmpresa.headers,
    body: {
      inicio: "2026-06-10T16:00:00Z",
      fin: "2026-06-11T04:00:00Z",
      zona: "centro",
      rol: "mesero",
    },
  });

  // AC-07: 100 eventos distintos solicitan concurrentemente al mismo DJ (plazas=1)
  const mainPlanner = await h.registerAndLoginUser({ email: "mainplanner@orquesta.test" });
  const venue = await h.request("POST", "/v1/venues", {
    headers: mainPlanner.headers,
    body: { nombre: "Expo", zona: "centro", direccion: "Av 5" },
  });

  const eventIds = await Promise.all(
    Array.from({ length: 100 }, async (_, i) => {
      const p = await h.registerAndLoginUser({ email: `pl_${i}@orquesta.test` });
      const ev = await h.request("POST", "/v1/events", {
        headers: p.headers,
        body: {
          nombre: `Ev ${i}`,
          fecha: "2026-06-10",
          timezone: "America/Mexico_City",
          ventana: { inicio: "2026-06-10T18:00:00Z", fin: "2026-06-11T02:00:00Z" },
          venue_id: venue.body.id,
          aforo: 50,
          requerimientos: [{ rol: "dj", cantidad: 1 }],
        },
      });
      return { headers: p.headers, eventId: ev.body.id };
    })
  );

  // Solicitudes concurrentes -> las 100 quedan `solicitada` (0 rechazadas por concurrencia)
  const reqResults = await Promise.all(
    eventIds.map((e) =>
      h.request("POST", `/v1/events/${e.eventId}/worker-requests`, {
        headers: e.headers,
        body: {
          worker_id: pPers.body.worker_id,
          rol: "dj",
          plazas: 1,
          ventana: { inicio: "2026-06-10T19:00:00Z", fin: "2026-06-10T23:00:00Z" },
          hora_llegada: "2026-06-10T19:00:00Z",
        },
      })
    )
  );
  assert.equal(reqResults.filter((r) => r.status === 201 && r.body.estado === "solicitada").length, 100);

  // AC-26: Trabajador sube tarifa a 1500 antes de aceptar -> la reserva conserva costo_congelado = 850
  await h.request("PATCH", "/v1/worker/profile", {
    headers: wPersona.headers,
    body: { tarifa: { monto: 1500, moneda: "MXN", unidad: "evento" } },
  });

  // Aceptar 2 en paralelo -> exactamente 1 ganadora, 1 conflicto determinista que nombra a la ganadora
  const r0 = reqResults[0].body.id;
  const r1 = reqResults[1].body.id;
  const [acc0, acc1] = await Promise.all([
    h.request("POST", `/v1/worker/requests/${r0}/accept`, { headers: wPersona.headers, body: {} }),
    h.request("POST", `/v1/worker/requests/${r1}/accept`, { headers: wPersona.headers, body: {} }),
  ]);
  const winner = acc0.status === 200 ? acc0 : acc1;
  const loser = acc0.status === 409 ? acc0 : acc1;
  assert.equal(winner.status, 200);
  assert.equal(winner.body.costo_congelado.monto, 850);
  assert.equal(loser.status, 409);
  assert.equal(loser.body.error.code, "RESERVATION_OVERLAP");
  assert.equal(loser.body.error.details.ganadora.reservation_id, winner.body.reservation_id);

  // AC-15: Aislamiento cross-planner + disponibilidad devuelve solo {worker_id, ventana_ocupada}
  const availResp = await h.request("GET", `/v1/workers/${pPers.body.worker_id}/availability`, {
    headers: mainPlanner.headers,
  });
  assert.equal(availResp.status, 200);
  assert.deepEqual(Object.keys(availResp.body), ["worker_id", "ventana_ocupada"]);
  assert.equal(availResp.body.ventana_ocupada.length, 1);
  assert.equal(availResp.body.ventana_ocupada[0].event_id, undefined);

  // Trabajador contratado SIN StaffAssignment no puede abrir sesión de escaneo (NFR-11, AC-15)
  const winnerEvent = eventIds[acc0.status === 200 ? 0 : 1];
  await h.request("POST", `/v1/events/${winnerEvent.eventId}/publish`, { headers: winnerEvent.headers });
  const unauthScan = await h.request("POST", "/v1/scan-sessions", {
    headers: wPersona.headers,
    body: { event_id: winnerEvent.eventId, device_id: "dev_worker" },
  });
  assert.equal(unauthScan.status, 404);

  // AC-15: Editor agregado y luego revocado -> primero 200, luego 403 FORBIDDEN_EVENT_SCOPE
  await h.request("POST", `/v1/events/${winnerEvent.eventId}/members`, {
    headers: winnerEvent.headers,
    body: { email: "mainplanner@orquesta.test", rol: "editor" },
  });
  const editorOk = await h.request("GET", `/v1/events/${winnerEvent.eventId}`, { headers: mainPlanner.headers });
  assert.equal(editorOk.status, 200);
  await h.request("DELETE", `/v1/events/${winnerEvent.eventId}/members/${mainPlanner.userId}`, {
    headers: winnerEvent.headers,
  });
  const editorRevoked = await h.request("GET", `/v1/events/${winnerEvent.eventId}`, {
    headers: mainPlanner.headers,
  });
  assert.equal(editorRevoked.status, 403);
  assert.equal(editorRevoked.body.error.code, "FORBIDDEN_EVENT_SCOPE");

  // AC-07: Empresa plazas_ofrecidas = 6: aceptar 4 y luego 4 -> segunda acepta 2 y devuelve 2, tercera falla
  const empReq1 = await h.request("POST", `/v1/events/${eventIds[0].eventId}/worker-requests`, {
    headers: eventIds[0].headers,
    body: {
      worker_id: pEmp.body.worker_id,
      rol: "mesero",
      plazas: 4,
      ventana: { inicio: "2026-06-10T19:00:00Z", fin: "2026-06-10T23:00:00Z" },
      hora_llegada: "2026-06-10T19:00:00Z",
    },
  });
  const empReq2 = await h.request("POST", `/v1/events/${eventIds[1].eventId}/worker-requests`, {
    headers: eventIds[1].headers,
    body: {
      worker_id: pEmp.body.worker_id,
      rol: "mesero",
      plazas: 4,
      ventana: { inicio: "2026-06-10T19:00:00Z", fin: "2026-06-10T23:00:00Z" },
      hora_llegada: "2026-06-10T19:00:00Z",
    },
  });
  const empReq3 = await h.request("POST", `/v1/events/${eventIds[2].eventId}/worker-requests`, {
    headers: eventIds[2].headers,
    body: {
      worker_id: pEmp.body.worker_id,
      rol: "mesero",
      plazas: 1,
      ventana: { inicio: "2026-06-10T19:00:00Z", fin: "2026-06-10T23:00:00Z" },
      hora_llegada: "2026-06-10T19:00:00Z",
    },
  });
  const ea1 = await h.request("POST", `/v1/worker/requests/${empReq1.body.id}/accept`, {
    headers: wEmpresa.headers,
    body: {},
  });
  assert.equal(ea1.status, 200);
  assert.equal(ea1.body.plazas_aceptadas, 4);

  const ea2 = await h.request("POST", `/v1/worker/requests/${empReq2.body.id}/accept`, {
    headers: wEmpresa.headers,
    body: {},
  });
  assert.equal(ea2.status, 200);
  assert.equal(ea2.body.plazas_aceptadas, 2);
  assert.equal(ea2.body.plazas_devueltas, 2);

  const ea3 = await h.request("POST", `/v1/worker/requests/${empReq3.body.id}/accept`, {
    headers: wEmpresa.headers,
    body: {},
  });
  assert.equal(ea3.status, 409);
  assert.equal(ea3.body.error.code, "RESERVATION_OVERLAP");

  // AC-22: Solicitud fuera de AvailabilityWindow -> 422 WINDOW_NOT_AVAILABLE
  const outAvail = await h.request("POST", `/v1/events/${eventIds[3].eventId}/worker-requests`, {
    headers: eventIds[3].headers,
    body: {
      worker_id: pEmp.body.worker_id,
      rol: "mesero",
      plazas: 1,
      ventana: { inicio: "2026-06-12T19:00:00Z", fin: "2026-06-12T23:00:00Z" },
      hora_llegada: "2026-06-12T19:00:00Z",
    },
  });
  assert.equal(outAvail.status, 422);
  assert.equal(outAvail.body.error.code, "WINDOW_NOT_AVAILABLE");

  // AC-27: Emergencia: trabajador cancela en vivo -> alerta al planner + reemplazo sin candidato -> sin_cubrir
  await h.request("POST", `/v1/events/${eventIds[0].eventId}/publish`, { headers: eventIds[0].headers });
  await h.request("POST", `/v1/events/${eventIds[0].eventId}/start`, { headers: eventIds[0].headers });
  const wCancel = await h.request("POST", `/v1/worker/reservations/${empReq1.body.id}/cancel`, {
    headers: wEmpresa.headers,
    body: { motivo: "Imprevisto" },
  });
  assert.equal(wCancel.status, 200);
  assert.equal(wCancel.body.alerta_planner, "emitida");
  const alerts = await h.request("GET", `/v1/events/${eventIds[0].eventId}/alerts`, {
    headers: eventIds[0].headers,
  });
  assert.equal(alerts.body.items.length, 1);

  const sinCubrir = await h.request(
    "POST",
    `/v1/events/${eventIds[0].eventId}/worker-requests/${empReq1.body.id}/replacements`,
    { headers: eventIds[0].headers, body: {} }
  );
  assert.equal(sinCubrir.status, 200);
  assert.equal(sinCubrir.body.estado, "sin_cubrir");

  // AC-29: Cerrar evento ganador pasa TODAS sus reservas `aceptada` -> `completada`.
  // La ganadora del accept paralelo no es determinista en PostgreSQL: si gana el evento 1,
  // también tiene aceptada la reserva de la empresa (empReq2), así que se cuenta del estado real.
  const winnerReqs = await h.request("GET", `/v1/events/${winnerEvent.eventId}/worker-requests`, {
    headers: winnerEvent.headers,
  });
  const aceptadasAntesDeCerrar = winnerReqs.body.items.filter((r) => r.estado === "aceptada").length;
  assert.ok(aceptadasAntesDeCerrar >= 1);
  const closeWinner = await h.request("POST", `/v1/events/${winnerEvent.eventId}/close`, {
    headers: winnerEvent.headers,
  });
  assert.equal(closeWinner.status, 200);
  assert.equal(closeWinner.body.reservas_completadas, aceptadasAntesDeCerrar);
  const pubAfterClose = await h.request("GET", `/v1/workers/${pPers.body.worker_id}`, {
    headers: mainPlanner.headers,
  });
  assert.equal(pubAfterClose.body.perfil_publico.eventos_completados, 1);
});

// ============================================================================
// 6. Pagos Idempotentes, Contract Test PSP, Timeout + QueryByKey, Webhook y Ledger
//    (AC-08, AC-09, AC-26, TR-09, TR-14, RF-11)
// ============================================================================
test("Pagos: contract test PSP, 3 reintentos + 5 concurrentes, timeout/queryByKey, webhook 3x y ledger suma 0", async () => {
  const h = await createTestHarness({ nowDate: "2026-06-05T12:00:00Z" });
  assert.equal(await verifyPaymentProviderContract(() => h.ctx.paymentProvider), true);

  const planner = await h.registerAndLoginUser({ email: "pay-planner@orquesta.test" });
  const worker = await h.registerAndLoginUser({ email: "pay-worker@orquesta.test", role: "worker" });

  const wp = await h.request("POST", "/v1/worker/profile", {
    headers: worker.headers,
    body: {
      tipo: "persona",
      nombre_publico: "Foto Pro",
      categorias: ["fotografo"],
      tarifa: { monto: 1200, moneda: "MXN", unidad: "evento" },
      zonas: ["norte"],
      telefono_e164: "+525566667777",
    },
  });
  const ch = await h.request("POST", "/v1/worker/profile/verifications", {
    headers: worker.headers,
    body: { canal: "telefono" },
  });
  await h.drainAll();
  const otp = h.ctx.smsProvider.captured.find((s) => s.to === "+525566667777").metadata.codigo_otp;
  await h.request("POST", `/v1/worker/profile/verifications/${ch.body.desafio_id}/confirm`, {
    headers: worker.headers,
    body: { codigo_otp: otp },
  });
  await h.request("POST", "/v1/worker/profile/publish", { headers: worker.headers });
  await h.request("POST", "/v1/worker/availability", {
    headers: worker.headers,
    body: { inicio: "2026-06-15T10:00:00Z", fin: "2026-06-15T22:00:00Z", zona: "norte", rol: "fotografo" },
  });

  const venue = await h.request("POST", "/v1/venues", {
    headers: planner.headers,
    body: { nombre: "Jardín Norte", zona: "norte", direccion: "Norte 1" },
  });
  const evt = await h.request("POST", "/v1/events", {
    headers: planner.headers,
    body: {
      nombre: "Boda Pago",
      fecha: "2026-06-15",
      timezone: "America/Mexico_City",
      ventana: { inicio: "2026-06-15T12:00:00Z", fin: "2026-06-15T20:00:00Z" },
      venue_id: venue.body.id,
      aforo: 20,
    },
  });
  const req1 = await h.request("POST", `/v1/events/${evt.body.id}/worker-requests`, {
    headers: planner.headers,
    body: {
      worker_id: wp.body.worker_id,
      rol: "fotografo",
      plazas: 1,
      ventana: { inicio: "2026-06-15T13:00:00Z", fin: "2026-06-15T18:00:00Z" },
      hora_llegada: "2026-06-15T13:00:00Z",
    },
  });

  // Pago contra solicitada -> 409 RESERVATION_NOT_ACCEPTED
  const payPending = await h.request("POST", `/v1/reservations/${req1.body.id}/payments`, {
    headers: planner.headers,
    body: {},
  });
  assert.equal(payPending.status, 409);
  assert.equal(payPending.body.error.code, "RESERVATION_NOT_ACCEPTED");

  // Subir tarifa luego de solicitar -> cobro usa costo_congelado = 1200 (AC-26)
  await h.request("PATCH", "/v1/worker/profile", {
    headers: worker.headers,
    body: { tarifa: { monto: 2500, moneda: "MXN", unidad: "evento" } },
  });
  await h.request("POST", `/v1/worker/requests/${req1.body.id}/accept`, { headers: worker.headers, body: {} });

  // AC-09: Simular timeout del PSP tras ejecutar cobro, luego reintento consulta por clave y concilia sin doble cobro
  const pspKey = `pay:${req1.body.id}`;
  h.ctx.paymentProvider.simulateTimeoutAfterCharge(pspKey);
  const chargeExecsBefore = h.ctx.paymentProvider.chargeExecutions;

  const timedOutPay = await h.request("POST", `/v1/reservations/${req1.body.id}/payments`, {
    headers: planner.headers,
    body: {},
  });
  assert.equal(timedOutPay.status, 202);
  assert.equal(timedOutPay.body.estado, "desconocido");

  // AC-08: 3 reintentos + 5 solicitudes concurrentes -> 1 solo cobro en PSP y 1 tx de ledger suma 0
  const concurrentPays = await Promise.all([
    h.request("POST", `/v1/reservations/${req1.body.id}/payments`, { headers: planner.headers, body: {} }),
    h.request("POST", `/v1/reservations/${req1.body.id}/payments`, { headers: planner.headers, body: {} }),
    h.request("POST", `/v1/reservations/${req1.body.id}/payments`, { headers: planner.headers, body: {} }),
    h.request("POST", `/v1/reservations/${req1.body.id}/payments`, { headers: planner.headers, body: {} }),
    h.request("POST", `/v1/reservations/${req1.body.id}/payments`, { headers: planner.headers, body: {} }),
  ]);
  for (const r of concurrentPays) {
    assert.equal(r.status, 201);
    assert.equal(r.body.monto, 1200);
  }
  assert.equal(h.ctx.paymentProvider.chargeExecutions - chargeExecsBefore, 1);

  // AC-09: Webhook reenviado 3 veces y fuera de orden
  const webhookBody = {
    event_id: "wh_evt_1",
    idempotency_key: pspKey,
    status: "succeeded",
    amount: 1200,
    currency: "MXN",
  };
  const sig = signWebhookHmac(JSON.stringify(webhookBody), h.ctx.pspWebhookSecret);
  for (let i = 0; i < 3; i++) {
    const wh = await h.request("POST", "/v1/webhooks/psp", {
      headers: { "x-psp-signature": sig },
      body: webhookBody,
    });
    assert.equal(wh.status, 200);
    assert.equal(wh.body.estado, "confirmado");
  }

  // Cancelar después del cobro -> cancelada_pagada + asiento reverso balanceado (suma 0)
  const cancelPaid = await h.request(
    "POST",
    `/v1/events/${evt.body.id}/reservations/${req1.body.id}/cancel`,
    { headers: planner.headers, body: { motivo: "Cambio de planes" } }
  );
  assert.equal(cancelPaid.status, 200);
  assert.equal(cancelPaid.body.estado, "cancelada_pagada");

  const payInfo = await h.request("GET", `/v1/reservations/${req1.body.id}/payments`, {
    headers: planner.headers,
  });
  const entries = payInfo.body.items[0].ledger_entries;
  assert.equal(entries.length, 4); // 2 líneas cobro + 2 líneas reverso
  const sum = entries.reduce((s, e) => s + e.importe, 0);
  assert.equal(sum, 0);
});

// ============================================================================
// 7. Retención 12 y 24 meses y Alcance Partido (AC-18, AC-28, NFR-08)
// ============================================================================
test("Retención NFR-08: 13 meses borra PII de evento manteniendo worker activo; 25 meses borra device_id", async () => {
  const h = await createTestHarness({ nowDate: "2026-01-10T10:00:00Z" });
  const planner = await h.registerAndLoginUser({ email: "ret-planner@orquesta.test" });
  const worker = await h.registerAndLoginUser({ email: "ret-worker@orquesta.test", role: "worker" });

  const wp = await h.request("POST", "/v1/worker/profile", {
    headers: worker.headers,
    body: {
      tipo: "persona",
      nombre_publico: "Mesero Estable",
      categorias: ["mesero"],
      tarifa: { monto: 500, moneda: "MXN", unidad: "hora" },
      zonas: ["sur"],
      telefono_e164: "+525588889999",
    },
  });
  const ch = await h.request("POST", "/v1/worker/profile/verifications", {
    headers: worker.headers,
    body: { canal: "telefono" },
  });
  await h.drainAll();
  const otp = h.ctx.smsProvider.captured.find((s) => s.to === "+525588889999").metadata.codigo_otp;
  await h.request("POST", `/v1/worker/profile/verifications/${ch.body.desafio_id}/confirm`, {
    headers: worker.headers,
    body: { codigo_otp: otp },
  });
  await h.request("POST", "/v1/worker/profile/publish", { headers: worker.headers });
  await h.request("POST", "/v1/worker/availability", {
    headers: worker.headers,
    body: { inicio: "2026-01-10T16:00:00Z", fin: "2026-01-11T04:00:00Z", zona: "sur", rol: "mesero" },
  });

  const venue = await h.request("POST", "/v1/venues", {
    headers: planner.headers,
    body: { nombre: "Salón Sur", zona: "sur", direccion: "Sur 9" },
  });
  const evt = await h.request("POST", "/v1/events", {
    headers: planner.headers,
    body: {
      nombre: "Evento Antiguo",
      fecha: "2026-01-10",
      timezone: "America/Mexico_City",
      ventana: { inicio: "2026-01-10T18:00:00Z", fin: "2026-01-11T02:00:00Z" },
      venue_id: venue.body.id,
      aforo: 20,
    },
  });
  await h.request("POST", `/v1/events/${evt.body.id}/publish`, { headers: planner.headers });
  await h.request("POST", `/v1/events/${evt.body.id}/start`, { headers: planner.headers });

  const csv = buildMultipartCsv("nombre,email,telefono\nInvitado Viejo,viejo@x.com,+525510101010\n");
  await h.request("POST", `/v1/events/${evt.body.id}/guests/import`, {
    headers: { ...planner.headers, "content-type": csv.contentType },
    rawBody: csv.rawBody,
  });
  await h.drainAll();
  const guests = (await h.request("GET", `/v1/events/${evt.body.id}/guests`, { headers: planner.headers })).body.items;

  // Enviar invitación y registrar 1 check-in antes de cerrar
  await h.request("POST", `/v1/events/${evt.body.id}/invitations/send`, {
    headers: planner.headers,
    body: { alcance: "pendiente_envio", destinatarios_confirmados: 1 },
  });
  await h.drainAll();

  const acc = await h.request("POST", `/v1/events/${evt.body.id}/access-tokens`, {
    headers: planner.headers,
    body: { rol: "staff" },
  });
  const sess = await h.request("POST", "/v1/auth/event-session", {
    body: { access_token: acc.body.qr_token, device_id: "dev_ret" },
  });
  const scanEvs = [
    {
      sequence: 1,
      invitation_id: guests[0].invitation_id,
      scanned_at: "2026-01-10T19:00:00Z",
      verdict_local: "admitido",
      modo: "camara",
    },
  ];
  const batchRet = await h.request("POST", `/v1/scan-sessions/${sess.body.session_id}/batches`, {
    headers: { authorization: `Bearer ${sess.body.session_token}` },
    body: {
      batch_id: "b-ret",
      device_id: "dev_ret",
      event_id: evt.body.id,
      seq_desde: 1,
      seq_hasta: 1,
      checksum: { alg: "sha256", valor: computeBatchChecksum(scanEvs) },
      events: scanEvs,
    },
  });
  assert.equal(batchRet.status, 200);
  await h.drainAll();

  // Contratar trabajador y cerrar evento el 2026-01-11
  const wr = await h.request("POST", `/v1/events/${evt.body.id}/worker-requests`, {
    headers: planner.headers,
    body: {
      worker_id: wp.body.worker_id,
      rol: "mesero",
      plazas: 1,
      ventana: { inicio: "2026-01-10T18:00:00Z", fin: "2026-01-11T01:00:00Z" },
      hora_llegada: "2026-01-10T18:00:00Z",
    },
  });
  await h.request("POST", `/v1/worker/requests/${wr.body.id}/accept`, { headers: worker.headers, body: {} });
  h.setNow("2026-01-11T03:00:00Z");
  await h.request("POST", `/v1/events/${evt.body.id}/close`, { headers: planner.headers });

  // El trabajador actualiza su actividad 6 meses después (para AC-28)
  h.setNow("2026-07-15T12:00:00Z");
  const wLogin6m = await h.request("POST", "/v1/auth/login", {
    body: { email: "ret-worker@orquesta.test", password: "Password123!" },
  });
  const wHeaders6m = { authorization: `Bearer ${wLogin6m.body.access_token}` };
  await h.request("PATCH", "/v1/worker/profile", {
    headers: wHeaders6m,
    body: { nombre_publico: "Mesero Estable Actualizado" },
  });

  // A los 13 meses del cierre (2027-02-15): PII de evento borrada, agregado intacto, WorkerProfile intacto (AC-18, AC-28)
  h.setNow("2027-02-15T12:00:00Z");
  const r13 = await h.outboxPoller({ now: "2027-02-15T12:00:00Z" });
  assert.equal(r13.retention.anonymized_events, 1);
  assert.equal(r13.retention.anonymized_workers, 0);

  const rsvpMsg = h.ctx.emailProvider.captured.find((m) => m.to === "viejo@x.com");
  const rsvpTok = new URLSearchParams(rsvpMsg.metadata.rsvp_url.split("#")[1] || "").get("t");
  const pubAfter13 = await h.request("GET", `/v1/public/invitations/${rsvpTok}/rsvp`);
  assert.equal(pubAfter13.status, 404); // token borrado/anonimizado

  const pLogin13 = await h.request("POST", "/v1/auth/login", {
    body: { email: "ret-planner@orquesta.test", password: "Password123!" },
  });
  const pHeaders13 = { authorization: `Bearer ${pLogin13.body.access_token}` };
  const wLogin13 = await h.request("POST", "/v1/auth/login", {
    body: { email: "ret-worker@orquesta.test", password: "Password123!" },
  });
  const wHeaders13 = { authorization: `Bearer ${wLogin13.body.access_token}` };

  const dashAfter13 = await h.request("GET", "/v1/dashboard", { headers: pHeaders13 });
  assert.equal(dashAfter13.body.items[0].contadores.asistentes, 1); // agregado intacto
  const wpOwn = await h.request("GET", "/v1/worker/profile", { headers: wHeaders13 });
  assert.equal(wpOwn.body.perfil.telefono_e164, "+525588889999");

  // A los 25 meses del cierre (2028-02-20): CheckinEvent sin device_id, manteniendo (event_id, sequence, veredicto) (AC-18)
  h.setNow("2028-02-20T12:00:00Z");
  const r25 = await h.outboxPoller({ now: "2028-02-20T12:00:00Z" });
  assert.equal(r25.retention.anonymized_checkin_events, 1);
  const pLogin25 = await h.request("POST", "/v1/auth/login", {
    body: { email: "ret-planner@orquesta.test", password: "Password123!" },
  });
  const chks = await h.request("GET", `/v1/events/${evt.body.id}/checkins`, {
    headers: { authorization: `Bearer ${pLogin25.body.access_token}` },
  });
  assert.equal(chks.body.items[0].device_id, null);
  assert.equal(chks.body.items[0].verdict, "admitido");
});

// ============================================================================
// 8. Cobertura exhaustiva de bordes: reset/logout, 48h/15m expiración, indeterminado,
//    reemplazo emergencia con candidato, move concurrente, batch > 500, 24h corrección,
//    búsqueda RF-07 radio_km, y retención inactiva de worker (RF-03, RF-04, RF-07, RF-09, RF-14, RF-17)
// ============================================================================
test("Bordes normativos: password-reset, logout, indeterminado 15m, expiración 48h, emergencia, límites lote y RF-07", async () => {
  const h = await createTestHarness({ nowDate: "2026-08-01T10:00:00Z" });
  const planner = await h.registerAndLoginUser({ email: "edge-planner@orquesta.test" });

  // Password reset (202 sin enumeración) + confirmación + logout revoca JWT
  const unknownReset = await h.request("POST", "/v1/auth/password-reset", {
    body: { email: "noexiste@orquesta.test" },
  });
  assert.equal(unknownReset.status, 202);
  await h.request("POST", "/v1/auth/password-reset", {
    body: { email: "edge-planner@orquesta.test" },
  });
  await h.drainAll();
  const rstMsg = [...h.ctx.emailProvider.captured]
    .reverse()
    .find((m) => m.to === "edge-planner@orquesta.test" && m.metadata?.token);
  const rstConfirm = await h.request("POST", "/v1/auth/password-reset/confirm", {
    body: { token: rstMsg.metadata.token, password: "NewPassword123!" },
  });
  assert.equal(rstConfirm.status, 204);
  const logoutRes = await h.request("POST", "/v1/auth/logout", { headers: planner.headers });
  assert.equal(logoutRes.status, 204);
  const afterLogout = await h.request("GET", "/v1/events", { headers: planner.headers });
  assert.equal(afterLogout.status, 401);

  const loginNew = await h.request("POST", "/v1/auth/login", {
    body: { email: "edge-planner@orquesta.test", password: "NewPassword123!" },
  });
  assert.equal(loginNew.status, 200);
  const pHeaders = { authorization: `Bearer ${loginNew.body.access_token}` };

  // Crear venue y evento
  const venue = await h.request("POST", "/v1/venues", {
    headers: pHeaders,
    body: { nombre: "Terraza Centro", zona: "centro", direccion: "Centro 10" },
  });
  const evt = await h.request("POST", "/v1/events", {
    headers: pHeaders,
    body: {
      nombre: "Evento Bordes",
      fecha: "2026-08-15",
      timezone: "America/Mexico_City",
      ventana: { inicio: "2026-08-15T18:00:00Z", fin: "2026-08-16T02:00:00Z" },
      venue_id: venue.body.id,
      aforo: 25000,
    },
  });
  const eventId = evt.body.id;
  await h.request("POST", `/v1/events/${eventId}/publish`, { headers: pHeaders });

  // > 20,000 filas CSV -> 413 IMPORT_FILAS_EXCEDIDAS
  const bigLines = ["nombre,email,telefono"];
  for (let i = 1; i <= 20001; i++) bigLines.push(`G${i},g${i}@x.com,`);
  const bigCsv = buildMultipartCsv(bigLines.join("\n"));
  const bigImp = await h.request("POST", `/v1/events/${eventId}/guests/import`, {
    headers: { ...pHeaders, "content-type": bigCsv.contentType },
    rawBody: bigCsv.rawBody,
  });
  assert.equal(bigImp.status, 413);
  assert.equal(bigImp.body.error.code, "IMPORT_FILAS_EXCEDIDAS");

  // Importar 2 invitados, mover uno concurrentemente a 2 mesas (AC-14), regenerar tokens (RF-03), y probar indeterminado 15m (RF-04)
  const smallCsv = buildMultipartCsv(
    "nombre,email,telefono\nUno,uno@x.com,+525511110001\nDos,dos@x.com,+525511110002\n"
  );
  await h.request("POST", `/v1/events/${eventId}/guests/import`, {
    headers: { ...pHeaders, "content-type": smallCsv.contentType },
    rawBody: smallCsv.rawBody,
  });
  await h.drainAll();
  const guests = (await h.request("GET", `/v1/events/${eventId}/guests`, { headers: pHeaders })).body.items;

  const mesaA = await h.request("POST", `/v1/events/${eventId}/tables`, {
    headers: pHeaders,
    body: { nombre: "Mesa A", capacidad: 5 },
  });
  const mesaB = await h.request("POST", `/v1/events/${eventId}/tables`, {
    headers: pHeaders,
    body: { nombre: "Mesa B", capacidad: 5 },
  });
  await Promise.all([
    h.request("POST", `/v1/events/${eventId}/seat-assignments`, {
      headers: pHeaders,
      body: { guest_id: guests[0].id, table_id: mesaA.body.id },
    }),
    h.request("POST", `/v1/events/${eventId}/seat-assignments`, {
      headers: pHeaders,
      body: { guest_id: guests[0].id, table_id: mesaB.body.id },
    }),
  ]);
  const tablesAfterMove = (await h.request("GET", `/v1/events/${eventId}/tables`, { headers: pHeaders })).body.items;
  assert.equal(tablesAfterMove[0].ocupacion + tablesAfterMove[1].ocupacion, 1);

  // Enviar invitaciones SIN drenar workers de notificación para simular timeout a `indeterminado` a los 15 min
  await h.request("POST", `/v1/events/${eventId}/invitations/send`, {
    headers: pHeaders,
    body: { alcance: "pendiente_envio", destinatarios_confirmados: 2 },
  });
  h.advanceMs(16 * 60 * 1000);
  const pollIndet = await h.outboxPoller();
  assert.ok(pollIndet.indeterminado_deliveries >= 4);

  // TR-12: Reprogramar evento reescribe disparar_en del MISMO ReminderJob
  const reminderCountBefore = await h.introspect.reminderJobCount();
  await h.request("PATCH", `/v1/events/${eventId}`, {
    headers: pHeaders,
    body: { ventana: { inicio: "2026-08-20T18:00:00Z", fin: "2026-08-21T02:00:00Z" } },
  });
  assert.equal(await h.introspect.reminderJobCount(), reminderCountBefore);

  // RF-03: Regenerar tokens revoca el anterior
  const regen = await h.request(
    "POST",
    `/v1/events/${eventId}/invitations/${guests[0].invitation_id}/regenerate`,
    { headers: pHeaders }
  );
  assert.equal(regen.status, 200);
  assert.equal(regen.body.token_version, 2);

  // Trabajadores para RF-07 (zona exacta vs radio_km + cero resultados) y AC-22 / AC-27
  const wA = await h.registerAndLoginUser({ email: "wa-search@orquesta.test", role: "worker" });
  const wB = await h.registerAndLoginUser({ email: "wb-search@orquesta.test", role: "worker" });

  async function setupWorker(w, { nombre, categorias, zonas, radioKm, tarifa, phone }) {
    const p = await h.request("POST", "/v1/worker/profile", {
      headers: w.headers,
      body: {
        tipo: "persona",
        nombre_publico: nombre,
        categorias,
        zonas,
        radio_km: radioKm,
        tarifa: { monto: tarifa, moneda: "MXN", unidad: "hora" },
        telefono_e164: phone,
      },
    });
    const ch = await h.request("POST", "/v1/worker/profile/verifications", {
      headers: w.headers,
      body: { canal: "telefono" },
    });
    await h.drainAll();
    const otp = h.ctx.smsProvider.captured.find((s) => s.to === phone).metadata.codigo_otp;
    await h.request("POST", `/v1/worker/profile/verifications/${ch.body.desafio_id}/confirm`, {
      headers: w.headers,
      body: { codigo_otp: otp },
    });
    await h.request("POST", "/v1/worker/profile/publish", { headers: w.headers });
    await h.request("POST", "/v1/worker/availability", {
      headers: w.headers,
      body: { inicio: "2026-08-20T16:00:00Z", fin: "2026-08-21T04:00:00Z", zona: zonas[0], rol: categorias[0] },
    });
    return p.body.worker_id;
  }

  const wIdA = await setupWorker(wA, {
    nombre: "Exacto Centro",
    categorias: ["mesero", "bartender"],
    zonas: ["centro"],
    radioKm: 10,
    tarifa: 700,
    phone: "+525577770001",
  });
  const wIdB = await setupWorker(wB, {
    nombre: "Cercano Roma",
    categorias: ["mesero"],
    zonas: ["roma_condesa"],
    radioKm: 25,
    tarifa: 450,
    phone: "+525577770002",
  });

  // RF-07: zona exacta ("Exacto Centro") ordena ANTES que radio ("Cercano Roma")
  const searchRadio = await h.request("GET", "/v1/workers", {
    headers: pHeaders,
    query: { categorias: "mesero", zonas: "centro", radio_km: "20" },
  });
  assert.equal(searchRadio.body.items.length, 2);
  assert.equal(searchRadio.body.items[0].worker_id, wIdA);
  assert.equal(searchRadio.body.items[1].worker_id, wIdB);

  // NFR-09: búsqueda con 0 resultados emite métrica worker_search_zero_results
  const zeroRes = await h.request("GET", "/v1/workers", {
    headers: pHeaders,
    query: { categorias: "mesero,dj", zonas: "monterrey" },
  });
  assert.equal(zeroRes.body.items.length, 0);
  assert.ok(h.ctx.metrics.records.some((m) => m.metricName === "worker_search_zero_results"));

  // AC-22: Solicitud expira a las 48h vía outboxPoller
  const reqExp = await h.request("POST", `/v1/events/${eventId}/worker-requests`, {
    headers: pHeaders,
    body: {
      worker_id: wIdA,
      rol: "mesero",
      plazas: 1,
      ventana: { inicio: "2026-08-20T18:00:00Z", fin: "2026-08-21T01:00:00Z" },
      hora_llegada: "2026-08-20T18:00:00Z",
    },
  });
  h.advanceMs(49 * 60 * 60 * 1000);
  const pollExp = await h.outboxPoller();
  assert.equal(pollExp.expired_reservations, 1);

  const loginAfter49h = await h.request("POST", "/v1/auth/login", {
    body: { email: "wa-search@orquesta.test", password: "Password123!" },
  });
  const accExpired = await h.request("POST", `/v1/worker/requests/${reqExp.body.id}/accept`, {
    headers: { authorization: `Bearer ${loginAfter49h.body.access_token}` },
    body: {},
  });
  assert.equal(accExpired.status, 410);
  assert.equal(accExpired.body.error.code, "REQUEST_EXPIRED");

  // Reemplazo de emergencia exitoso con candidato libre (wIdB -> modo_emergencia: true, 15 min)
  const loginPLate = await h.request("POST", "/v1/auth/login", {
    body: { email: "edge-planner@orquesta.test", password: "NewPassword123!" },
  });
  const pLateHeaders = { authorization: `Bearer ${loginPLate.body.access_token}` };
  const replOk = await h.request(
    "POST",
    `/v1/events/${eventId}/worker-requests/${reqExp.body.id}/replacements`,
    { headers: pLateHeaders, body: { worker_id: wIdB } }
  );
  assert.equal(replOk.status, 201);
  assert.equal(replOk.body.modo_emergencia, true);
  assert.equal(replOk.body.sla_respuesta, "PT15M");

  // La solicitud de emergencia expira a los 15 min si no se responde (RF-17)
  h.advanceMs(16 * 60 * 1000);
  const pollEmergExp = await h.outboxPoller();
  assert.equal(pollEmergExp.expired_reservations, 1);

  // Batch > 500 (413 BATCH_TOO_LARGE), desordenado (400 BATCH_OUT_OF_ORDER), GET /batches/:batchId y >24h CORRECTION_WINDOW_CLOSED
  const accTok = await h.request("POST", `/v1/events/${eventId}/access-tokens`, {
    headers: pLateHeaders,
    body: { rol: "staff" },
  });
  const sess = await h.request("POST", "/v1/auth/event-session", {
    body: { access_token: accTok.body.qr_token, device_id: "dev_edge" },
  });
  const devHeaders = { authorization: `Bearer ${sess.body.session_token}` };

  const tooBigEvs = Array.from({ length: 501 }, (_, i) => ({
    sequence: i + 1,
    invitation_id: guests[0].invitation_id,
    scanned_at: "2026-08-20T19:00:00Z",
  }));
  const tooBigRes = await h.request("POST", `/v1/scan-sessions/${sess.body.session_id}/batches`, {
    headers: devHeaders,
    body: {
      batch_id: "b-501",
      device_id: "dev_edge",
      event_id: eventId,
      checksum: { alg: "sha256", valor: computeBatchChecksum(tooBigEvs) },
      events: tooBigEvs,
    },
  });
  assert.equal(tooBigRes.status, 413);
  assert.equal(tooBigRes.body.error.code, "BATCH_TOO_LARGE");

  const outOfOrderEvs = [
    { sequence: 2, invitation_id: guests[0].invitation_id, scanned_at: "2026-08-20T19:00:00Z" },
    { sequence: 1, invitation_id: guests[1].invitation_id, scanned_at: "2026-08-20T19:01:00Z" },
  ];
  const oooRes = await h.request("POST", `/v1/scan-sessions/${sess.body.session_id}/batches`, {
    headers: devHeaders,
    body: {
      batch_id: "b-ooo",
      device_id: "dev_edge",
      event_id: eventId,
      checksum: { alg: "sha256", valor: computeBatchChecksum(outOfOrderEvs) },
      events: outOfOrderEvs,
    },
  });
  assert.equal(oooRes.status, 400);
  assert.equal(oooRes.body.error.code, "BATCH_OUT_OF_ORDER");

  // Lote válido + consulta GET /batches/:batchId + cierre + >24h CORRECTION_WINDOW_CLOSED
  const okEvs = [{ sequence: 1, invitation_id: guests[0].invitation_id, scanned_at: "2026-08-20T19:00:00Z" }];
  const okBatch = await h.request("POST", `/v1/scan-sessions/${sess.body.session_id}/batches`, {
    headers: devHeaders,
    body: {
      batch_id: "b-ok",
      device_id: "dev_edge",
      event_id: eventId,
      seq_desde: 1,
      seq_hasta: 1,
      checksum: { alg: "sha256", valor: computeBatchChecksum(okEvs) },
      events: okEvs,
    },
  });
  assert.equal(okBatch.status, 200);
  const ackGet = await h.request("GET", `/v1/scan-sessions/${sess.body.session_id}/batches/b-ok`, {
    headers: devHeaders,
  });
  assert.equal(ackGet.status, 200);
  assert.equal(ackGet.body.batch_id, "b-ok");

  await h.request("POST", `/v1/events/${eventId}/close`, { headers: pLateHeaders });
  h.advanceMs(25 * 60 * 60 * 1000);
  const lateLoginP = await h.request("POST", "/v1/auth/login", {
    body: { email: "edge-planner@orquesta.test", password: "NewPassword123!" },
  });
  const lateAnnul = await h.request(
    "POST",
    `/v1/events/${eventId}/checkins/${okBatch.body.results[0].checkin_id}/annulments`,
    {
      headers: { authorization: `Bearer ${lateLoginP.body.access_token}` },
      body: { motivo: "Fuera de 24h" },
    }
  );
  assert.equal(lateAnnul.status, 409);
  assert.equal(lateAnnul.body.error.code, "CORRECTION_WINDOW_CLOSED");

  // NFR-08: Trabajador sin actividad > 12 meses queda anonimizado y sale de búsqueda
  h.advanceMs(370 * 24 * 60 * 60 * 1000);
  const retInactive = await h.outboxPoller();
  assert.ok(retInactive.retention.anonymized_workers >= 2);
  const loginFinal = await h.request("POST", "/v1/auth/login", {
    body: { email: "edge-planner@orquesta.test", password: "NewPassword123!" },
  });
  const searchEmpty = await h.request("GET", "/v1/workers", {
    headers: { authorization: `Bearer ${loginFinal.body.access_token}` },
    query: { categorias: "mesero", zonas: "centro" },
  });
  assert.equal(searchEmpty.body.items.length, 0);
});

// ============================================================================
// FR5 / RF-10: Recordatorio de hora de llegada al proveedor (T-24h y T-2h), SMS + email,
// a la hora programada y nunca dos veces aunque el barrido corra repetidamente.
// ============================================================================
test("Recordatorio de llegada al proveedor: T-24h y T-2h por SMS y email, exactamente una vez por ventana (RF-10)", async () => {
  const h = await createTestHarness({ nowDate: "2026-07-01T12:00:00Z" });
  const worker = await h.registerAndLoginUser({ email: "dj-llegada@orquesta.test", role: "worker" });
  const prof = await h.request("POST", "/v1/worker/profile", {
    headers: worker.headers,
    body: {
      tipo: "persona",
      nombre_publico: "DJ Puntual",
      categorias: ["dj"],
      tarifa: { monto: 900, moneda: "MXN", unidad: "evento" },
      zonas: ["centro"],
      telefono_e164: "+525577778888",
    },
  });
  assert.equal(prof.status, 201);
  const chal = await h.request("POST", "/v1/worker/profile/verifications", {
    headers: worker.headers,
    body: { canal: "telefono" },
  });
  await h.drainAll();
  const otp = h.ctx.smsProvider.captured.find((s) => s.to === "+525577778888").metadata.codigo_otp;
  await h.request("POST", `/v1/worker/profile/verifications/${chal.body.desafio_id}/confirm`, {
    headers: worker.headers,
    body: { codigo_otp: otp },
  });
  assert.equal((await h.request("POST", "/v1/worker/profile/publish", { headers: worker.headers })).status, 200);
  await h.request("POST", "/v1/worker/availability", {
    headers: worker.headers,
    body: { inicio: "2026-07-10T16:00:00Z", fin: "2026-07-11T04:00:00Z", zona: "centro", rol: "dj" },
  });

  const planner = await h.registerAndLoginUser({ email: "planner-llegada@orquesta.test" });
  const venue = await h.request("POST", "/v1/venues", {
    headers: planner.headers,
    body: { nombre: "Jardín", zona: "centro", direccion: "Calle 1" },
  });
  const ev = await h.request("POST", "/v1/events", {
    headers: planner.headers,
    body: {
      nombre: "Boda con DJ",
      fecha: "2026-07-10",
      timezone: "America/Mexico_City",
      ventana: { inicio: "2026-07-10T18:00:00Z", fin: "2026-07-11T02:00:00Z" },
      venue_id: venue.body.id,
      aforo: 100,
      requerimientos: [{ rol: "dj", cantidad: 1 }],
    },
  });
  assert.equal(ev.status, 201);
  const reqRes = await h.request("POST", `/v1/events/${ev.body.id}/worker-requests`, {
    headers: planner.headers,
    body: {
      worker_id: prof.body.worker_id,
      rol: "dj",
      plazas: 1,
      ventana: { inicio: "2026-07-10T18:00:00Z", fin: "2026-07-11T02:00:00Z" },
      hora_llegada: "2026-07-10T18:00:00Z",
    },
  });
  assert.equal(reqRes.status, 201);
  const acc = await h.request("POST", `/v1/worker/requests/${reqRes.body.id}/accept`, {
    headers: worker.headers,
    body: {},
  });
  assert.equal(acc.status, 200);

  const arrivalSms = () =>
    h.ctx.smsProvider.captured.filter((m) => m.metadata?.plantilla === "recordatorio_llegada");
  const arrivalEmails = () =>
    h.ctx.emailProvider.captured.filter((m) => m.metadata?.plantilla === "recordatorio_llegada");

  // Antes de T-24h no sale nada.
  await h.outboxPoller();
  await h.drainAll();
  assert.equal(arrivalSms().length, 0);
  assert.equal(arrivalEmails().length, 0);

  // T-24h (+5 s): un SMS y un email, ambos con ventana t_24h.
  h.setNow("2026-07-09T18:00:05Z");
  await h.outboxPoller();
  await h.drainAll();
  assert.equal(arrivalSms().length, 1);
  assert.equal(arrivalEmails().length, 1);
  assert.equal(arrivalSms()[0].to, "+525577778888");
  assert.equal(arrivalSms()[0].metadata.ventana, "t_24h");

  // Barrido repetido en la misma ventana: nunca dos veces (dedupe por destinatario/plantilla/ventana).
  await h.outboxPoller();
  await h.outboxPoller();
  await h.drainAll();
  assert.equal(arrivalSms().length, 1);
  assert.equal(arrivalEmails().length, 1);

  // T-2h (+5 s): segunda ventana, otra vez exactamente uno por canal.
  h.setNow("2026-07-10T16:00:05Z");
  await h.outboxPoller();
  await h.drainAll();
  await h.outboxPoller();
  await h.drainAll();
  assert.equal(arrivalSms().length, 2);
  assert.equal(arrivalEmails().length, 2);
  assert.deepEqual(arrivalSms().map((m) => m.metadata.ventana).sort(), ["t_24h", "t_2h"]);
});

// ============================================================================
// FR7: Control de versión optimista del plano de mesas. Dos editores con la misma
// versión leída: el primero gana, el segundo recibe 409 con aviso y no sobrescribe.
// ============================================================================
test("Seating: control de versión optimista (If-Match) rechaza la segunda edición concurrente sin sobrescribir (FR7)", async () => {
  const h = await createTestHarness();
  const owner = await h.registerAndLoginUser({ email: "seat-owner@orquesta.test" });
  const editor = await h.registerAndLoginUser({ email: "seat-editor@orquesta.test" });
  const venue = await h.request("POST", "/v1/venues", {
    headers: owner.headers,
    body: { nombre: "Salón Versión", zona: "centro", direccion: "Calle 9" },
  });
  const evt = await h.request("POST", "/v1/events", {
    headers: owner.headers,
    body: {
      nombre: "Cena versionada",
      fecha: "2026-07-01",
      timezone: "America/Mexico_City",
      ventana: { inicio: "2026-07-01T18:00:00-06:00", fin: "2026-07-02T01:00:00-06:00" },
      venue_id: venue.body.id,
      aforo: 10,
    },
  });
  const eventId = evt.body.id;
  const addEditor = await h.request("POST", `/v1/events/${eventId}/members`, {
    headers: owner.headers,
    body: { user_id: editor.userId, rol: "editor" },
  });
  assert.equal(addEditor.status, 201);

  const csv = buildMultipartCsv(["nombre,email,telefono", "Ana,ana@x.com,", "Beto,beto@x.com,"].join("\n"));
  await h.request("POST", `/v1/events/${eventId}/guests/import`, {
    headers: { ...owner.headers, "content-type": csv.contentType },
    rawBody: csv.rawBody,
  });
  await h.drainAll();
  const guests = (await h.request("GET", `/v1/events/${eventId}/guests`, { headers: owner.headers })).body.items;
  const ana = guests.find((g) => g.nombre === "Ana");

  // Plano vacío: versión 0, expuesta en el cuerpo y como ETag.
  const v0 = await h.request("GET", `/v1/events/${eventId}/tables`, { headers: owner.headers });
  assert.equal(v0.body.plan_version, 0);
  assert.equal(v0.headers.etag, '"0"');

  const mesaA = await h.request("POST", `/v1/events/${eventId}/tables`, {
    headers: { ...owner.headers, "if-match": '"0"' },
    body: { nombre: "A", capacidad: 5 },
  });
  assert.equal(mesaA.status, 201);
  assert.equal(mesaA.body.plan_version, 1);
  const mesaB = await h.request("POST", `/v1/events/${eventId}/tables`, {
    headers: { ...owner.headers, "if-match": '"1"' },
    body: { nombre: "B", capacidad: 5 },
  });
  assert.equal(mesaB.body.plan_version, 2);

  // Owner y editor leen la misma versión (2) y editan "a la vez" al mismo invitado.
  const leida = (await h.request("GET", `/v1/events/${eventId}/tables`, { headers: editor.headers })).body.plan_version;
  assert.equal(leida, 2);
  const primero = await h.request("POST", `/v1/events/${eventId}/seat-assignments`, {
    headers: { ...owner.headers, "if-match": `"${leida}"` },
    body: { guest_id: ana.id, table_id: mesaA.body.id },
  });
  assert.equal(primero.status, 201);
  assert.equal(primero.body.plan_version, 3);
  const segundo = await h.request("POST", `/v1/events/${eventId}/seat-assignments`, {
    headers: { ...editor.headers, "if-match": `W/"${leida}"` },
    body: { guest_id: ana.id, table_id: mesaB.body.id },
  });
  assert.equal(segundo.status, 409);
  assert.equal(segundo.body.error.code, "SEATING_VERSION_CONFLICT");
  assert.equal(segundo.body.error.details.version_actual, 3);

  // El primer cambio NO se sobrescribió: Ana sigue en la mesa A y la versión no avanzó.
  const tablas = await h.request("GET", `/v1/events/${eventId}/tables`, { headers: owner.headers });
  assert.equal(tablas.body.plan_version, 3);
  assert.equal(tablas.body.items.find((t) => t.id === mesaA.body.id).ocupacion, 1);
  assert.equal(tablas.body.items.find((t) => t.id === mesaB.body.id).ocupacion, 0);

  // Tras recargar (versión 3) el editor sí puede mover; liberar también versiona.
  const reintento = await h.request("POST", `/v1/events/${eventId}/seat-assignments`, {
    headers: { ...editor.headers, "if-match": '"3"' },
    body: { guest_id: ana.id, table_id: mesaB.body.id },
  });
  assert.equal(reintento.status, 200);
  assert.equal(reintento.body.plan_version, 4);
  const liberarViejo = await h.request("DELETE", `/v1/events/${eventId}/seat-assignments/${ana.id}`, {
    headers: { ...owner.headers, "if-match": '"3"' },
  });
  assert.equal(liberarViejo.status, 409);
  const liberar = await h.request("DELETE", `/v1/events/${eventId}/seat-assignments/${ana.id}`, {
    headers: { ...owner.headers, "if-match": '"4"' },
  });
  assert.equal(liberar.status, 204);
  assert.equal(liberar.headers.etag, '"5"');

  // Compatibilidad: sin If-Match la edición se acepta (el front actual no lo envía aún).
  const sinVersion = await h.request("POST", `/v1/events/${eventId}/seat-assignments`, {
    headers: owner.headers,
    body: { guest_id: ana.id, table_id: mesaA.body.id },
  });
  assert.equal(sinVersion.status, 201);
  assert.equal(sinVersion.body.plan_version, 6);
  const malFormado = await h.request("POST", `/v1/events/${eventId}/tables`, {
    headers: { ...owner.headers, "if-match": '"abc"' },
    body: { nombre: "C", capacidad: 2 },
  });
  assert.equal(malFormado.status, 422);
});

// ============================================================================
// FR6: un pago que queda `desconocido` por timeout del PSP se concilia solo (sin que el planner
// reintente), con UN solo cobro y UN solo asiento en el ledger; una caída del PSP durante el
// barrido no rompe el outbox-poller (aislamiento de fallas).
// ============================================================================
test("Pagos: conciliación automática de pagos desconocidos, sin doble cobro y aislada de caídas del PSP (FR6)", async () => {
  const h = await createTestHarness({ nowDate: "2026-06-05T12:00:00Z" });
  const planner = await h.registerAndLoginUser({ email: "rec-planner@orquesta.test" });
  const worker = await h.registerAndLoginUser({ email: "rec-worker@orquesta.test", role: "worker" });
  const wp = await h.request("POST", "/v1/worker/profile", {
    headers: worker.headers,
    body: {
      tipo: "persona",
      nombre_publico: "Florista",
      categorias: ["fotografo"],
      tarifa: { monto: 700, moneda: "MXN", unidad: "evento" },
      zonas: ["norte"],
      telefono_e164: "+525512121212",
    },
  });
  const ch = await h.request("POST", "/v1/worker/profile/verifications", {
    headers: worker.headers,
    body: { canal: "telefono" },
  });
  await h.drainAll();
  const otp = h.ctx.smsProvider.captured.find((s) => s.to === "+525512121212").metadata.codigo_otp;
  await h.request("POST", `/v1/worker/profile/verifications/${ch.body.desafio_id}/confirm`, {
    headers: worker.headers,
    body: { codigo_otp: otp },
  });
  await h.request("POST", "/v1/worker/profile/publish", { headers: worker.headers });
  await h.request("POST", "/v1/worker/availability", {
    headers: worker.headers,
    body: { inicio: "2026-06-15T10:00:00Z", fin: "2026-06-15T22:00:00Z", zona: "norte", rol: "fotografo" },
  });
  const venue = await h.request("POST", "/v1/venues", {
    headers: planner.headers,
    body: { nombre: "Hacienda", zona: "norte", direccion: "Norte 9" },
  });
  const evt = await h.request("POST", "/v1/events", {
    headers: planner.headers,
    body: {
      nombre: "Boda Conciliada",
      fecha: "2026-06-15",
      timezone: "America/Mexico_City",
      ventana: { inicio: "2026-06-15T12:00:00Z", fin: "2026-06-15T20:00:00Z" },
      venue_id: venue.body.id,
      aforo: 20,
    },
  });
  const req = await h.request("POST", `/v1/events/${evt.body.id}/worker-requests`, {
    headers: planner.headers,
    body: {
      worker_id: wp.body.worker_id,
      rol: "fotografo",
      plazas: 1,
      ventana: { inicio: "2026-06-15T13:00:00Z", fin: "2026-06-15T18:00:00Z" },
      hora_llegada: "2026-06-15T13:00:00Z",
    },
  });
  await h.request("POST", `/v1/worker/requests/${req.body.id}/accept`, { headers: worker.headers, body: {} });

  // El PSP cobra pero la respuesta se pierde: el pago queda `desconocido`.
  h.ctx.paymentProvider.simulateTimeoutAfterCharge(`pay:${req.body.id}`);
  const chargesBefore = h.ctx.paymentProvider.chargeExecutions;
  const pay = await h.request("POST", `/v1/reservations/${req.body.id}/payments`, {
    headers: planner.headers,
    body: {},
  });
  assert.equal(pay.status, 202);
  assert.equal(pay.body.estado, "desconocido");

  // Aislamiento: con el PSP caído el barrido NO lanza y el resto del poller sigue funcionando.
  h.advanceMs(2 * 60 * 1000);
  const psp = h.ctx.paymentProvider;
  const realQuery = psp.queryByKey.bind(psp);
  const realCharge = psp.charge.bind(psp);
  psp.queryByKey = async () => {
    throw new Error("PSP caído");
  };
  psp.charge = async () => {
    throw new Error("PSP caído");
  };
  const caido = await h.outboxPoller();
  assert.equal(caido.payments.revisados, 1);
  assert.equal(caido.payments.confirmados, 0);
  assert.ok(caido.retention, "los otros barridos siguen corriendo");
  const sigue = await h.request("GET", `/v1/reservations/${req.body.id}/payments`, { headers: planner.headers });
  assert.notEqual(sigue.body.items[0].estado, "confirmado");

  // El PSP vuelve: el siguiente barrido concilia por llave de idempotencia sin cobrar de nuevo.
  psp.queryByKey = realQuery;
  psp.charge = realCharge;
  h.advanceMs(60 * 1000);
  const ok = await h.outboxPoller();
  assert.equal(ok.payments.confirmados, 1);
  assert.equal(psp.chargeExecutions - chargesBefore, 1, "un solo cobro en el PSP");

  const info = await h.request("GET", `/v1/reservations/${req.body.id}/payments`, { headers: planner.headers });
  assert.equal(info.body.items[0].estado, "confirmado");
  const entries = info.body.items[0].ledger_entries;
  assert.equal(entries.length, 2);
  assert.equal(entries.reduce((acc, e) => acc + e.importe, 0), 0);

  // Barridos posteriores no tocan pagos ya confirmados.
  h.advanceMs(60 * 1000);
  const again = await h.outboxPoller();
  assert.equal(again.payments.revisados, 0);
  assert.equal(psp.chargeExecutions - chargesBefore, 1);
});

// ============================================================================
// RF-02 / AC-20 en el worker: si el aforo se agota entre la validación de la ruta y el
// procesamiento (dos imports compitiendo), el job queda `fallido` de forma PERSISTENTE con 0 creados.
// ============================================================================
test("Import: aforo excedido en el worker deja el job fallido (no colgado en en_proceso) y no crea invitados", async () => {
  const h = await createTestHarness();
  const planner = await h.registerAndLoginUser({ email: "aforo-worker@orquesta.test" });
  const venue = await h.request("POST", "/v1/venues", {
    headers: planner.headers,
    body: { nombre: "Salón chico", zona: "centro", direccion: "Calle 3" },
  });
  const evt = await h.request("POST", "/v1/events", {
    headers: planner.headers,
    body: {
      nombre: "Cena íntima",
      fecha: "2026-07-01",
      timezone: "America/Mexico_City",
      ventana: { inicio: "2026-07-01T18:00:00-06:00", fin: "2026-07-02T01:00:00-06:00" },
      venue_id: venue.body.id,
      aforo: 2,
    },
  });
  const eventId = evt.body.id;
  const csv = "nombre,email,telefono\nAna,ana@x.com,\nLuis,luis@x.com,\nEva,eva@x.com,\n";
  const job = await h.ctx.store.createImportJob({ eventId, s3Key: "imports/race.csv", fileHash: "f".repeat(64), totalFilas: 3 });
  const importId = job.import_id || job.id;
  await assert.rejects(
    h.ctx.store.executeImportBatch({
      importId,
      eventId,
      parsedRows: parseGuestsCsv(csv),
      qrSigner: h.ctx.qrSigner,
      objectStorage: h.ctx.objectStorage,
    }),
    (err) => err.code === "AFORO_EXCEDIDO"
  );
  const status = await h.request("GET", `/v1/events/${eventId}/guests/imports/${importId}`, { headers: planner.headers });
  assert.equal(status.status, 200);
  assert.equal(status.body.estado, "fallido");
  assert.equal(status.body.aceptadas, 0);
  const guests = await h.request("GET", `/v1/events/${eventId}/guests`, { headers: planner.headers });
  assert.equal(guests.body.items.length, 0);
});

// ============================================================================
// FR6: conciliación diaria ledger ↔ procesador. Día cuadrado = `conciliado`; un cobro del PSP sin
// asiento en el ledger = `con_diferencias` + métrica psp_error (alarma). Una sola vez por día.
// ============================================================================
async function setupAcceptedReservation(h, prefix, monto) {
  const planner = await h.registerAndLoginUser({ email: `${prefix}-planner@orquesta.test` });
  const worker = await h.registerAndLoginUser({ email: `${prefix}-worker@orquesta.test`, role: "worker" });
  const phone = `+52559${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
  const wp = await h.request("POST", "/v1/worker/profile", {
    headers: worker.headers,
    body: {
      tipo: "persona",
      nombre_publico: `Prov ${prefix}`,
      categorias: ["fotografo"],
      tarifa: { monto, moneda: "MXN", unidad: "evento" },
      zonas: ["norte"],
      telefono_e164: phone,
    },
  });
  const ch = await h.request("POST", "/v1/worker/profile/verifications", { headers: worker.headers, body: { canal: "telefono" } });
  await h.drainAll();
  const otp = h.ctx.smsProvider.captured.find((s) => s.to === phone).metadata.codigo_otp;
  await h.request("POST", `/v1/worker/profile/verifications/${ch.body.desafio_id}/confirm`, {
    headers: worker.headers,
    body: { codigo_otp: otp },
  });
  await h.request("POST", "/v1/worker/profile/publish", { headers: worker.headers });
  await h.request("POST", "/v1/worker/availability", {
    headers: worker.headers,
    body: { inicio: "2026-06-15T10:00:00Z", fin: "2026-06-15T22:00:00Z", zona: "norte", rol: "fotografo" },
  });
  const venue = await h.request("POST", "/v1/venues", {
    headers: planner.headers,
    body: { nombre: `Venue ${prefix}`, zona: "norte", direccion: "Norte 2" },
  });
  const evt = await h.request("POST", "/v1/events", {
    headers: planner.headers,
    body: {
      nombre: `Evento ${prefix}`,
      fecha: "2026-06-15",
      timezone: "America/Mexico_City",
      ventana: { inicio: "2026-06-15T12:00:00Z", fin: "2026-06-15T20:00:00Z" },
      venue_id: venue.body.id,
      aforo: 20,
    },
  });
  const req = await h.request("POST", `/v1/events/${evt.body.id}/worker-requests`, {
    headers: planner.headers,
    body: {
      worker_id: wp.body.worker_id,
      rol: "fotografo",
      plazas: 1,
      ventana: { inicio: "2026-06-15T13:00:00Z", fin: "2026-06-15T18:00:00Z" },
      hora_llegada: "2026-06-15T13:00:00Z",
    },
  });
  await h.request("POST", `/v1/worker/requests/${req.body.id}/accept`, { headers: worker.headers, body: {} });
  return { planner, reservationId: req.body.id };
}

test("Pagos: conciliación diaria ledger vs procesador detecta cobros sin asiento y corre una vez por día (FR6)", async () => {
  const h = await createTestHarness({ nowDate: "2026-06-05T12:00:00Z" });
  const { planner, reservationId } = await setupAcceptedReservation(h, "concilia", 800);
  const pay = await h.request("POST", `/v1/reservations/${reservationId}/payments`, { headers: planner.headers, body: {} });
  assert.equal(pay.status, 201);

  // Antes de las 02:00 UTC del día siguiente no se concilia (margen para resolver `desconocido`).
  h.setNow("2026-06-06T01:00:00Z");
  assert.equal((await h.outboxPoller()).daily_reconciliation.estado, "esperando_ventana");

  // Día 05 cuadrado: 1 cobro en el PSP y 1 en el ledger por el mismo monto.
  h.setNow("2026-06-06T03:00:00Z");
  const r1 = (await h.outboxPoller()).daily_reconciliation;
  assert.equal(r1.dia, "2026-06-05");
  assert.equal(r1.estado, "conciliado");
  assert.equal(r1.cobros_psp, 1);
  assert.equal(r1.cobros_ledger, 1);
  assert.equal(r1.monto_psp, 800);
  assert.equal(r1.monto_ledger, 800);
  assert.equal((await h.outboxPoller()).daily_reconciliation.estado, "ya_conciliado");

  // Día 06: el PSP registra un cobro que el ledger no tiene (p. ej. cobro hecho fuera del sistema).
  h.setNow("2026-06-06T15:00:00Z");
  await h.ctx.paymentProvider.charge({ idempotencyKey: "pay:fantasma-0000000000000001", amount: 999, currency: "MXN" });
  h.setNow("2026-06-07T02:30:00Z");
  const r2 = (await h.outboxPoller()).daily_reconciliation;
  assert.equal(r2.dia, "2026-06-06");
  assert.equal(r2.estado, "con_diferencias");
  assert.equal(r2.diferencias.length, 1);
  assert.equal(r2.diferencias[0].tipo, "cobro_sin_ledger");
  assert.equal(r2.diferencias[0].idempotency_key, "pay:fantasma-0000000000000001");
  const mismatchMetrics = h.ctx.metrics.records.filter(
    (m) => m.metricName === "psp_error" && m.dimensions.Reason === "reconciliation_mismatch"
  );
  assert.equal(mismatchMetrics.length, 1, "emite psp_error una vez para la alarma de CloudWatch");
  assert.equal((await h.outboxPoller()).daily_reconciliation.estado, "ya_conciliado");
});

// ============================================================================
// FR4 en producción: (a) el proveedor recibe la solicitud por SMS y email (en emergencia, como
// URGENTE) y la dirección viaja CIFRADA en el outbox (NFR-07); (b) nunca más proveedores que
// lugares: con 1 lugar y 2 DJs aceptando a la vez gana 1 y el otro recibe REQUERIMIENTO_CUBIERTO;
// con 3 lugares y una empresa que ofrece 6, se aceptan solo 3.
// ============================================================================
async function createVerifiedWorker(h, prefix, { categoria, tipo = "persona", plazas = 1, monto = 900 }) {
  const w = await h.registerAndLoginUser({ email: `${prefix}@orquesta.test`, role: "worker", tipo });
  const phone = `+52558${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
  const prof = await h.request("POST", "/v1/worker/profile", {
    headers: w.headers,
    body: {
      tipo,
      ...(tipo === "empresa" ? { plazas_ofrecidas: plazas } : {}),
      nombre_publico: `Prov ${prefix}`,
      categorias: [categoria],
      tarifa: { monto, moneda: "MXN", unidad: "evento" },
      zonas: ["centro"],
      telefono_e164: phone,
    },
  });
  assert.equal(prof.status, 201);
  const ch = await h.request("POST", "/v1/worker/profile/verifications", { headers: w.headers, body: { canal: "telefono" } });
  await h.drainAll();
  const otp = h.ctx.smsProvider.captured.find((m) => m.to === phone).metadata.codigo_otp;
  await h.request("POST", `/v1/worker/profile/verifications/${ch.body.desafio_id}/confirm`, { headers: w.headers, body: { codigo_otp: otp } });
  await h.request("POST", "/v1/worker/profile/publish", { headers: w.headers });
  await h.request("POST", "/v1/worker/availability", {
    headers: w.headers,
    body: { inicio: "2026-07-10T16:00:00Z", fin: "2026-07-11T04:00:00Z", zona: "centro", rol: categoria },
  });
  return { ...w, workerId: prof.body.worker_id, phone };
}

test("Proveedores: aviso de solicitud cifrado en outbox y nunca más proveedores que lugares (FR4)", async () => {
  const h = await createTestHarness({ nowDate: "2026-07-01T12:00:00Z" });
  const dj1 = await createVerifiedWorker(h, "dj-a", { categoria: "dj" });
  const dj2 = await createVerifiedWorker(h, "dj-b", { categoria: "dj" });
  const staffCo = await createVerifiedWorker(h, "meseros-co", { categoria: "mesero", tipo: "empresa", plazas: 6, monto: 400 });
  const planner = await h.registerAndLoginUser({ email: "lugares-planner@orquesta.test" });
  const venue = await h.request("POST", "/v1/venues", { headers: planner.headers, body: { nombre: "Salón L", zona: "centro", direccion: "L 1" } });
  const ev = await h.request("POST", "/v1/events", {
    headers: planner.headers,
    body: {
      nombre: "Boda con lugares",
      fecha: "2026-07-10",
      timezone: "America/Mexico_City",
      ventana: { inicio: "2026-07-10T18:00:00Z", fin: "2026-07-11T02:00:00Z" },
      venue_id: venue.body.id,
      aforo: 100,
      requerimientos: [{ rol: "dj", cantidad: 1 }, { rol: "mesero", cantidad: 3 }],
    },
  });
  const eventId = ev.body.id;
  const ventana = { inicio: "2026-07-10T18:00:00Z", fin: "2026-07-11T02:00:00Z" };
  const request = (workerId, rol, plazas = 1) =>
    h.request("POST", `/v1/events/${eventId}/worker-requests`, {
      headers: planner.headers,
      body: { worker_id: workerId, rol, plazas, ventana, hora_llegada: ventana.inicio },
    });

  const r1 = await request(dj1.workerId, "dj");
  const r2 = await request(dj2.workerId, "dj");
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 201);

  // (a) Aviso al proveedor por ambos canales; en el outbox la dirección va cifrada.
  await h.drainAll();
  const smsDj1 = h.ctx.smsProvider.captured.filter((m) => m.to === dj1.phone && m.metadata?.event_type === "worker_request_created");
  const emailDj1 = h.ctx.emailProvider.captured.filter((m) => m.to === "dj-a@orquesta.test" && m.metadata?.event_type === "worker_request_created");
  assert.equal(smsDj1.length, 1);
  assert.equal(emailDj1.length, 1);
  const payloads = await h.introspect.outboxPayloads("worker_request_created");
  assert.ok(payloads.length >= 4);
  for (const p of payloads) {
    assert.equal(p.to, undefined, "sin dirección en claro en el outbox");
    assert.ok(String(p.to_cifrado).startsWith("enc:v1:"));
  }

  // (b) 1 lugar de DJ, 2 DJs aceptan a la vez: exactamente 1 gana.
  const [a1, a2] = await Promise.all([
    h.request("POST", `/v1/worker/requests/${r1.body.id}/accept`, { headers: dj1.headers, body: {} }),
    h.request("POST", `/v1/worker/requests/${r2.body.id}/accept`, { headers: dj2.headers, body: {} }),
  ]);
  const statuses = [a1.status, a2.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const loser = a1.status === 409 ? a1 : a2;
  assert.equal(loser.body.error.code, "REQUERIMIENTO_CUBIERTO");

  // 3 lugares de mesero; la empresa ofrece 6 y se le piden 6: solo se aceptan 3.
  const rm = await request(staffCo.workerId, "mesero", 6);
  assert.equal(rm.status, 201);
  const am = await h.request("POST", `/v1/worker/requests/${rm.body.id}/accept`, { headers: staffCo.headers, body: {} });
  assert.equal(am.status, 200);
  assert.equal(am.body.plazas_aceptadas, 3);
  const reqs = await h.request("GET", `/v1/events/${eventId}/requirements`, { headers: planner.headers });
  assert.equal(reqs.status, 200);

  // Emergencia: el aviso dice URGENTE.
  await h.request("POST", `/v1/events/${eventId}/publish`, { headers: planner.headers });
  await h.request("POST", `/v1/events/${eventId}/start`, { headers: planner.headers });
  const winner = a1.status === 200 ? { r: r1, w: dj1 } : { r: r2, w: dj2 };
  const other = a1.status === 200 ? dj2 : dj1;
  await h.request("POST", `/v1/worker/reservations/${winner.r.body.id}/cancel`, { headers: winner.w.headers, body: { motivo: "Imprevisto" } });
  const repl = await h.request("POST", `/v1/events/${eventId}/worker-requests/${winner.r.body.id}/replacements`, {
    headers: planner.headers,
    body: { worker_id: other.workerId },
  });
  assert.ok([200, 201].includes(repl.status), JSON.stringify(repl.body));
  await h.drainAll();
  const urgent = h.ctx.smsProvider.captured.filter((m) => m.to === other.phone && /URGENTE/.test(m.message || ""));
  assert.equal(urgent.length, 1);
});

// ============================================================================
// FR8 + privacidad: el invitado se da de baja por canal con su token (sin cuenta) y deja de recibir
// por ese canal (reenvíos y recordatorios); los teléfonos de invitados se borran a los 90 días.
// ============================================================================
test("Invitados: baja por canal respetada en reenvíos y recordatorios; teléfonos borrados a los 90 días", async () => {
  const h = await createTestHarness({ nowDate: "2026-06-01T12:00:00Z" });
  const planner = await h.registerAndLoginUser({ email: "baja-planner@orquesta.test" });
  const venue = await h.request("POST", "/v1/venues", { headers: planner.headers, body: { nombre: "Salón B", zona: "centro", direccion: "B 1" } });
  const ev = await h.request("POST", "/v1/events", {
    headers: planner.headers,
    body: {
      nombre: "Cena baja",
      fecha: "2026-06-20",
      timezone: "America/Mexico_City",
      ventana: { inicio: "2026-06-20T18:00:00Z", fin: "2026-06-21T02:00:00Z" },
      venue_id: venue.body.id,
      aforo: 10,
    },
  });
  const eventId = ev.body.id;
  await h.request("POST", `/v1/events/${eventId}/publish`, { headers: planner.headers });
  const csv = buildMultipartCsv("nombre,email,telefono\nAna,ana-baja@x.com,+525510101010\nTel Solo,,+525520202020\n");
  await h.request("POST", `/v1/events/${eventId}/guests/import`, {
    headers: { ...planner.headers, "content-type": csv.contentType },
    rawBody: csv.rawBody,
  });
  await h.drainAll();
  const guests = (await h.request("GET", `/v1/events/${eventId}/guests`, { headers: planner.headers })).body.items;
  const ana = guests.find((g) => g.nombre === "Ana");
  const telSolo = guests.find((g) => g.nombre === "Tel Solo");
  const send = await h.request("POST", `/v1/events/${eventId}/invitations/send`, {
    headers: planner.headers,
    body: { alcance: "pendiente_envio", destinatarios_confirmados: 2 },
  });
  assert.equal(send.status, 202);
  await h.drainAll();
  const token = await h.introspect.rsvpTokenFor(ana.invitation_id);

  // Baja de SMS con el token de la invitación (sin cuenta); idempotente.
  const b1 = await h.request("POST", `/v1/public/invitations/${token}/unsubscribe`, { body: { canal: "sms" } });
  assert.equal(b1.status, 200);
  assert.deepEqual(b1.body.bajas, { sms: true, email: false });
  const b2 = await h.request("POST", `/v1/public/invitations/${token}/unsubscribe`, { body: { canal: "sms" } });
  assert.deepEqual(b2.body.bajas, { sms: true, email: false });
  const state = await h.request("GET", `/v1/public/invitations/${token}/rsvp`);
  assert.deepEqual(state.body.bajas, { sms: true, email: false });
  const bad = await h.request("POST", `/v1/public/invitations/${token}/unsubscribe`, { body: { canal: "fax" } });
  assert.equal(bad.status, 422);

  // Los recordatorios SMS pendientes de Ana quedan cancelados por la baja; los de email siguen.
  const jobs = await h.introspect.reminderJobsForGuest(ana.id);
  assert.ok(jobs.some((j) => j.canal === "sms"));
  for (const j of jobs.filter((x) => x.canal === "sms")) assert.equal(j.estado, "cancelado");
  assert.ok(jobs.filter((x) => x.canal === "email").every((j) => j.estado === "programado"));

  // Reenvío por ambos canales: solo sale el email.
  const smsBefore = h.ctx.smsProvider.captured.filter((m) => m.to === "+525510101010").length;
  const rs = await h.request("POST", `/v1/events/${eventId}/invitations/resend`, {
    headers: planner.headers,
    body: { guest_ids: [ana.id], canal: "ambos", ventana: "resend_1" },
  });
  assert.equal(rs.status, 202);
  assert.equal(rs.body.entregas_encoladas, 1);
  await h.drainAll();
  assert.equal(h.ctx.smsProvider.captured.filter((m) => m.to === "+525510101010").length, smsBefore);

  // 90 días después del fin del evento: se borran los teléfonos (quien solo tenía teléfono queda anonimizado).
  h.setNow("2026-09-20T03:00:00Z");
  const r = await h.outboxPoller();
  assert.equal(r.retention.telefonos_invitados_borrados, 2);
  const anaRow = await h.introspect.guestRow(ana.id);
  const telRow = await h.introspect.guestRow(telSolo.id);
  assert.equal(anaRow.telefono_cifrado ?? null, null);
  assert.ok(anaRow.email_cifrado, "el email de Ana se conserva hasta los 12 meses (NFR-08)");
  assert.equal(telRow.telefono_cifrado ?? null, null);
  assert.ok(telRow.pii_anonimizada_en, "sin teléfono ni email, el invitado queda anonimizado");
  const again = await h.outboxPoller();
  assert.equal(again.retention.telefonos_invitados_borrados, 0);
});

test("Pagos: Stripe Checkout sin doble sesión, confirma al volver o por webhook firmado y reintenta tras expirar (FR6)", async () => {
  const psp = new MockPspTestAdapter({ checkout: true });
  const h = await createTestHarness({ nowDate: "2026-06-05T12:00:00Z", paymentProvider: psp });
  h.ctx.stripeWebhookSecret = "whsec_prueba_orquesta";
  const planner = await h.registerAndLoginUser({ email: "co-planner@orquesta.test" });
  const worker = await h.registerAndLoginUser({ email: "co-worker@orquesta.test", role: "worker" });
  const wp = await h.request("POST", "/v1/worker/profile", {
    headers: worker.headers,
    body: {
      tipo: "persona",
      nombre_publico: "Foto Checkout",
      categorias: ["fotografo"],
      tarifa: { monto: 700, moneda: "MXN", unidad: "evento" },
      zonas: ["norte"],
      telefono_e164: "+525513131313",
    },
  });
  const ch = await h.request("POST", "/v1/worker/profile/verifications", { headers: worker.headers, body: { canal: "telefono" } });
  await h.drainAll();
  const otp = h.ctx.smsProvider.captured.find((s) => s.to === "+525513131313").metadata.codigo_otp;
  await h.request("POST", `/v1/worker/profile/verifications/${ch.body.desafio_id}/confirm`, {
    headers: worker.headers,
    body: { codigo_otp: otp },
  });
  await h.request("POST", "/v1/worker/profile/publish", { headers: worker.headers });
  await h.request("POST", "/v1/worker/availability", {
    headers: worker.headers,
    body: { inicio: "2026-06-15T10:00:00Z", fin: "2026-06-15T22:00:00Z", zona: "norte", rol: "fotografo" },
  });
  const venue = await h.request("POST", "/v1/venues", {
    headers: planner.headers,
    body: { nombre: "Jardín", zona: "norte", direccion: "Norte 10" },
  });
  const evt = await h.request("POST", "/v1/events", {
    headers: planner.headers,
    body: {
      nombre: "Boda Checkout",
      fecha: "2026-06-15",
      timezone: "America/Mexico_City",
      ventana: { inicio: "2026-06-15T12:00:00Z", fin: "2026-06-15T20:00:00Z" },
      venue_id: venue.body.id,
      aforo: 20,
    },
  });
  async function contratar(inicio, fin) {
    const r = await h.request("POST", `/v1/events/${evt.body.id}/worker-requests`, {
      headers: planner.headers,
      body: { worker_id: wp.body.worker_id, rol: "fotografo", plazas: 1, ventana: { inicio, fin }, hora_llegada: inicio },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const acc = await h.request("POST", `/v1/worker/requests/${r.body.id}/accept`, { headers: worker.headers, body: {} });
    assert.equal(acc.status, 200, JSON.stringify(acc.body));
    return r.body.id;
  }
  const ledgerOk = (item) => {
    assert.equal(item.ledger_entries.length, 2);
    assert.equal(item.ledger_entries.reduce((a, e) => a + Number(e.importe), 0), 0);
  };
  function stripeSign(raw) {
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", h.ctx.stripeWebhookSecret).update(`${t}.${raw}`).digest("hex");
    return `t=${t},v1=${v1}`;
  }

  // 1) La planner pulsa Pagar: se abre una sesión de checkout; la URL de regreso ajena se descarta.
  const resA = await contratar("2026-06-15T13:00:00Z", "2026-06-15T15:00:00Z");
  const pay1 = await h.request("POST", `/v1/reservations/${resA}/payments`, {
    headers: planner.headers,
    body: { success_url: "https://evil.example/robar", cancel_url: "http://localhost:4200/planner?pago=cancelado" },
  });
  assert.equal(pay1.status, 202);
  assert.equal(pay1.body.estado, "pendiente");
  assert.match(pay1.body.checkout_url, /^https:\/\/checkout\.mock\.test\//);
  const [sesion] = [...psp.sessions.values()];
  assert.ok(!sesion.success_url.includes("evil.example"), "no redirige a orígenes ajenos");
  assert.match(sesion.success_url, /\/planner\/events\/.+\/workers\?pago=exito$/);
  assert.equal(sesion.cancel_url, "http://localhost:4200/planner?pago=cancelado");

  // 2) Doble clic / regresar con "atrás": misma sesión, nunca una segunda abierta.
  const pay2 = await h.request("POST", `/v1/reservations/${resA}/payments`, { headers: planner.headers, body: {} });
  assert.equal(pay2.body.checkout_url, pay1.body.checkout_url);
  assert.equal(psp.sessions.size, 1);

  // 3) Mientras no paga, el GET sigue pendiente y sin asientos.
  const g1 = await h.request("GET", `/v1/reservations/${resA}/payments`, { headers: planner.headers });
  assert.equal(g1.body.items[0].estado, "pendiente");
  assert.equal(g1.body.items[0].ledger_entries.length, 0);

  // 4) Paga en Stripe y vuelve: el GET confirma consultando la sesión, sin esperar al webhook.
  psp.completeCheckout(sesion.reference);
  const g2 = await h.request("GET", `/v1/reservations/${resA}/payments`, { headers: planner.headers });
  assert.equal(g2.body.items[0].estado, "confirmado");
  ledgerOk(g2.body.items[0]);

  // 5) El webhook llega después (y repetido): firma verificada, sin asiento doble.
  const evento = {
    id: "evt_checkout_1",
    type: "checkout.session.completed",
    data: {
      object: {
        id: sesion.reference,
        payment_status: "paid",
        amount_total: 70000,
        currency: "mxn",
        payment_intent: "pi_123",
        metadata: { idempotency_key: `pay:${resA}` },
      },
    },
  };
  const raw = JSON.stringify(evento);
  for (let i = 0; i < 2; i++) {
    const wh = await h.request("POST", "/v1/webhooks/psp", { headers: { "stripe-signature": stripeSign(raw), "content-type": "application/json" }, rawBody: raw });
    assert.equal(wh.status, 200);
    assert.equal(wh.body.estado, "confirmado");
  }
  const falsa = await h.request("POST", "/v1/webhooks/psp", {
    headers: { "stripe-signature": `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}`, "content-type": "application/json" },
    rawBody: raw,
  });
  assert.equal(falsa.status, 401);
  const otro = JSON.stringify({ id: "evt_otro", type: "customer.created", data: { object: {} } });
  const ign = await h.request("POST", "/v1/webhooks/psp", { headers: { "stripe-signature": stripeSign(otro), "content-type": "application/json" }, rawBody: otro });
  assert.equal(ign.status, 200);
  assert.equal(ign.body.ignorado, "customer.created");
  const g3 = await h.request("GET", `/v1/reservations/${resA}/payments`, { headers: planner.headers });
  ledgerOk(g3.body.items[0]);
  assert.equal(g3.body.items[0].reembolsado, false);

  // 5b) El proveedor cancela la reserva ya pagada: se reembolsa a la planner en el PSP, una sola vez.
  for (let i = 0; i < 2; i++) {
    const cancel = await h.request("POST", `/v1/worker/reservations/${resA}/cancel`, {
      headers: worker.headers,
      body: { motivo: "Se enfermó" },
    });
    assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
    assert.equal(cancel.body.estado, "cancelada_pagada");
  }
  assert.equal(psp.refunds.size, 1, "un solo reembolso aunque cancele dos veces");
  const reembolso = psp.refunds.get(`refund:pay:${resA}`);
  assert.equal(reembolso.amount, 700);
  assert.match(reembolso.psp_charge_id, /^pi_mock_/, "reembolsa el cobro real del checkout");
  const g4 = await h.request("GET", `/v1/reservations/${resA}/payments`, { headers: planner.headers });
  assert.equal(g4.body.items[0].reembolsado, true);
  assert.equal(g4.body.items[0].ledger_entries.length, 4);
  assert.equal(g4.body.items[0].ledger_entries.reduce((a, e) => a + Number(e.importe), 0), 0);

  // 6) Sesión abandonada: caduca, el barrido libera el pago y el reintento abre una sesión NUEVA.
  const resB = await contratar("2026-06-15T16:00:00Z", "2026-06-15T18:00:00Z");
  const pB1 = await h.request("POST", `/v1/reservations/${resB}/payments`, { headers: planner.headers, body: {} });
  const refB1 = pB1.body.checkout_url.split("/").pop();
  psp.expireCheckout(refB1);
  h.advanceMs(2 * 60 * 1000);
  const sweep = await h.outboxPoller();
  assert.equal(sweep.payments.revisados, 1);
  const gB = await h.request("GET", `/v1/reservations/${resB}/payments`, { headers: planner.headers });
  assert.equal(gB.body.items[0].estado, "fallido");
  const pB2 = await h.request("POST", `/v1/reservations/${resB}/payments`, { headers: planner.headers, body: {} });
  assert.equal(pB2.status, 202);
  assert.notEqual(pB2.body.checkout_url, pB1.body.checkout_url);
  const refB2 = pB2.body.checkout_url.split("/").pop();

  // 7) Esta vez solo llega el webhook (la planner cerró la pestaña): confirma igual.
  psp.completeCheckout(refB2);
  const rawB = JSON.stringify({
    id: "evt_checkout_2",
    type: "checkout.session.completed",
    data: { object: { id: refB2, payment_status: "paid", amount_total: 70000, currency: "mxn", payment_intent: "pi_456", metadata: { idempotency_key: `pay:${resB}` } } },
  });
  const whB = await h.request("POST", "/v1/webhooks/psp", { headers: { "stripe-signature": stripeSign(rawB), "content-type": "application/json" }, rawBody: rawB });
  assert.equal(whB.body.estado, "confirmado");
  const gB2 = await h.request("GET", `/v1/reservations/${resB}/payments`, { headers: planner.headers });
  ledgerOk(gB2.body.items[0]);
});
