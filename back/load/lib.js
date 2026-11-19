/**
 * Infraestructura compartida de las pruebas de carga (check-in, import): cliente local
 * (handler en proceso + PgStore) o HTTP (API desplegada), y helpers de setup del dominio.
 */
import { createHash } from "node:crypto";

// ----------------------------------------------------------------------------
// Cliente: mismo contrato para local (handler en proceso) y http (fetch)
// ----------------------------------------------------------------------------
export async function createLocalClient({ poolMax = 20 } = {}) {
  const pg = (await import("pg")).default;
  const { PgStore, runMigrations } = await import("../src/shared/db.js");
  const { createAppContext } = await import("../src/shared/context.js");
  const { createApiHandler } = await import("../src/lambdas/api/index.js");
  const { createImportWorkerHandler } = await import("../src/lambdas/import-worker/index.js");
  const { createProjectorHandler } = await import("../src/lambdas/projector/index.js");
  const { createNotifyEmailHandler } = await import("../src/lambdas/notify-email/index.js");
  const { createNotifySmsHandler } = await import("../src/lambdas/notify-sms/index.js");

  const base = {
    host: process.env.PGHOST || "127.0.0.1",
    port: Number(process.env.PGPORT || 55432),
    user: process.env.PGUSER || "orquesta_admin",
    password: process.env.PGPASSWORD || "orquesta",
    database: process.env.PGDATABASE || "orquesta",
  };
  const schema = `load_${Date.now().toString(36)}`;
  const admin = new pg.Pool({ ...base, max: 1 });
  await admin.query(`CREATE EXTENSION IF NOT EXISTS btree_gist SCHEMA public`);
  await admin.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA public`);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ ...base, max: poolMax, options: `-c search_path=${schema},public` });
  await runMigrations(pool);

  const store = new PgStore({ pool, piiKey: "orquesta-dev-pii-key-32bytes!" });
  const ctx = await createAppContext({ dbMode: "aurora", store, silentMetrics: true });
  ctx.queueBus.registerConsumer("import_jobs", createImportWorkerHandler(ctx));
  ctx.queueBus.registerConsumer("projection", createProjectorHandler(ctx));
  ctx.queueBus.registerConsumer("notify_email", createNotifyEmailHandler(ctx));
  ctx.queueBus.registerConsumer("notify_sms", createNotifySmsHandler(ctx));
  const api = createApiHandler(ctx);

  // Simula el trigger SQS del proyector (ventana de 1 s, TR-05).
  const projectorTimer = setInterval(() => ctx.queueBus.drainQueue("projection").catch(() => {}), 1000);

  return {
    kind: "local",
    ctx,
    schema,
    pool,
    async request(method, path, { body = null, headers = {}, rawBody = null } = {}) {
      const [rawPath, qs = ""] = path.split("?");
      const event = {
        version: "2.0",
        requestContext: { http: { method, path: rawPath } },
        rawPath,
        rawQueryString: qs,
        headers: { ...(body !== null ? { "content-type": "application/json" } : {}), ...headers },
        body: rawBody ?? (body !== null ? JSON.stringify(body) : undefined),
        isBase64Encoded: false,
      };
      const res = await api(event);
      return { status: res.statusCode, headers: res.headers || {}, body: res.body ? JSON.parse(res.body) : null };
    },
    async afterSetup() {
      await ctx.queueBus.drainAll();
    },
    async verifyInDb() {
      const dup = await pool.query(
        `SELECT count(*)::int AS n FROM (
           SELECT invitation_id FROM checkin_event WHERE kind = 'admitido'
           GROUP BY invitation_id, admision_ciclo HAVING count(*) > 1) t`
      );
      const adm = await pool.query(`SELECT count(*)::int AS n FROM checkin_event WHERE kind = 'admitido'`);
      return { admitidos_en_bd: adm.rows[0].n, invitaciones_admitidas_2_veces: dup.rows[0].n };
    },
    async close() {
      clearInterval(projectorTimer);
      await pool.end();
      if (process.env.KEEP_LOAD_SCHEMA !== "1") await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

export function createHttpClient({ baseUrl: rawBaseUrl } = {}) {
  if (!rawBaseUrl) throw new Error("--base-url es obligatorio con --target=http");
  const baseUrl = rawBaseUrl.replace(/\/+$/, "");
  return {
    kind: "http",
    async request(method, path, { body = null, headers = {}, rawBody = null } = {}) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { ...(body !== null ? { "content-type": "application/json" } : {}), ...headers },
        body: rawBody ?? (body !== null ? JSON.stringify(body) : undefined),
      });
      const text = await res.text();
      return { status: res.status, headers: Object.fromEntries(res.headers), body: text ? JSON.parse(text) : null };
    },
    async afterSetup() {},
    async verifyInDb() {
      return null; // en AWS se verifica por API (tablero)
    },
    async close() {},
  };
}

// ----------------------------------------------------------------------------
// Helpers de dominio
// ----------------------------------------------------------------------------
export function sha256Hex(s) {
  return createHash("sha256").update(s).digest("hex");
}
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}
export function batchChecksum(events) {
  return sha256Hex(canonicalJson([...events].sort((a, b) => a.sequence - b.sequence)));
}
export function must(res, expected, what) {
  if (res.status !== expected) {
    throw new Error(`${what}: esperaba ${expected}, recibió ${res.status} ${JSON.stringify(res.body)?.slice(0, 300)}`);
  }
  return res.body;
}
export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}
export const round = (n) => (n === null ? null : Math.round(n * 10) / 10);

// ----------------------------------------------------------------------------
// Setup: planner, venue, eventos en curso, invitados, sesiones de escaneo
// ----------------------------------------------------------------------------
export async function loginPlanner(client, { email: plannerEmail, password: plannerPassword } = {}) {
  if (client.kind === "http") {
    const login = must(
      await client.request("POST", "/v1/auth/login", {
        body: { email: plannerEmail, password: plannerPassword },
      }),
      200,
      "login planner"
    );
    return { authorization: `Bearer ${login.access_token}` };
  }
  // Local: alta + verificación de email leyendo el token capturado por el adaptador de email.
  const email = `load-planner-${Date.now()}@orquesta.test`;
  const password = "LoadTest123!";
  must(await client.request("POST", "/v1/auth/register", { body: { email, password } }), 201, "registro");
  await client.afterSetup();
  const captured = [...client.ctx.emailProvider.captured].reverse().find((m) => m.to === email.toLowerCase());
  if (!captured?.metadata?.token) throw new Error("no se capturó el email de verificación");
  const token = captured.metadata.token;
  must(await client.request("POST", "/v1/auth/verify-email", { body: { token } }), 200, "verificar email");
  const login = must(await client.request("POST", "/v1/auth/login", { body: { email, password } }), 200, "login");
  return { authorization: `Bearer ${login.access_token}` };
}

export async function setupEvent(client, plannerHeaders, venueId, idx, guestCount) {
  const now = Date.now();
  const ev = must(
    await client.request("POST", "/v1/events", {
      headers: plannerHeaders,
      body: {
        nombre: `Carga ${idx}`,
        fecha: new Date(now).toISOString().slice(0, 10),
        timezone: "America/Mexico_City",
        ventana: { inicio: new Date(now - 30 * 60_000).toISOString(), fin: new Date(now + 6 * 3600_000).toISOString() },
        venue_id: venueId,
        aforo: guestCount,
      },
    }),
    201,
    `crear evento ${idx}`
  );
  must(await client.request("POST", `/v1/events/${ev.id}/publish`, { headers: plannerHeaders }), 200, "publicar");
  must(await client.request("POST", `/v1/events/${ev.id}/start`, { headers: plannerHeaders }), 200, "iniciar");

  const boundary = `----OrquestaLoad${idx}`;
  const rows = ["nombre,email,telefono"];
  for (let g = 0; g < guestCount; g++) rows.push(`Invitado ${idx}-${g},inv-${idx}-${g}@load.test,`);
  const rawBody =
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="guests.csv"\r\n` +
    `Content-Type: text/csv\r\n\r\n${rows.join("\n")}\r\n--${boundary}--\r\n`;
  const imp = must(
    await client.request("POST", `/v1/events/${ev.id}/guests/import`, {
      headers: { ...plannerHeaders, "content-type": `multipart/form-data; boundary=${boundary}` },
      rawBody,
    }),
    202,
    "import"
  );
  return { eventId: ev.id, importId: imp.import_id };
}

export async function waitImport(client, plannerHeaders, eventId, importId) {
  for (let i = 0; i < 300; i++) {
    const st = await client.request("GET", `/v1/events/${eventId}/guests/imports/${importId}`, { headers: plannerHeaders });
    if (st.body?.estado === "completado") return st.body;
    if (st.body?.estado === "fallido") throw new Error(`import fallido: ${JSON.stringify(st.body)}`);
    await client.afterSetup();
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("import no terminó en 300 s");
}

