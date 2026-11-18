#!/usr/bin/env node
/**
 * Prueba de carga del check-in (FR2): AC-01 (500 escrituras/s sin pérdidas ni duplicados)
 * y AC-04 / NFR "500 pendientes se sincronizan en < 30 s" (ráfaga de reconexión offline).
 *
 * Dos destinos con el MISMO perfil de carga y las MISMAS verificaciones:
 *   --target=local  Handler HTTP real + PgStore en proceso contra PostgreSQL (docker compose).
 *                   Mide la capa de datos y la lógica de ingesta sin AWS.
 *   --target=http   API desplegada (API Gateway → Lambda → RDS). Requiere --base-url y un
 *                   planner ya verificado (--planner-email / --planner-password).
 *
 * Uso típico:
 *   npm run db:up
 *   npm run load:checkin                       # 50 eventos, 500/s, 60 s
 *   node load/checkin-load.js --rate=1000 --duration=30   # buscar el punto de saturación
 *   node load/checkin-load.js --target=http --base-url=https://xxx.execute-api.us-east-1.amazonaws.com \
 *        --planner-email=... --planner-password=...
 *
 * Perfil (open loop, como un venue real): cada evento tiene D dispositivos; cada segundo cada
 * dispositivo envía un lote con su parte de la tasa objetivo. Un % configurable de escaneos se
 * repite en OTRO dispositivo del mismo evento (duplicados cross-dispositivo, AC-05). A la mitad
 * de la corrida, un dispositivo que estuvo offline vacía su cola de N escaneos en lotes de 500.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

// ----------------------------------------------------------------------------
// Configuración
// ----------------------------------------------------------------------------
const { values: opt } = parseArgs({
  options: {
    target: { type: "string", default: "local" },
    "base-url": { type: "string" },
    "planner-email": { type: "string" },
    "planner-password": { type: "string" },
    events: { type: "string", default: "50" },
    "devices-per-event": { type: "string", default: "2" },
    rate: { type: "string", default: "500" },
    duration: { type: "string", default: "60" },
    "dup-rate": { type: "string", default: "0.02" },
    "offline-backlog": { type: "string", default: "1000" },
    "pool-max": { type: "string", default: "20" },
    out: { type: "string" },
  },
});

const CFG = {
  target: opt.target,
  baseUrl: opt["base-url"],
  events: Number(opt.events),
  devicesPerEvent: Number(opt["devices-per-event"]),
  rate: Number(opt.rate),
  duration: Number(opt.duration),
  dupRate: Number(opt["dup-rate"]),
  offlineBacklog: Number(opt["offline-backlog"]),
  poolMax: Number(opt["pool-max"]),
};
// Invitados únicos necesarios por evento para que cada escaneo "nuevo" sea de alguien distinto.
CFG.guestsPerEvent = Math.ceil((CFG.rate * CFG.duration) / CFG.events) + 10;

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

// ----------------------------------------------------------------------------
// Cliente: mismo contrato para local (handler en proceso) y http (fetch)
// ----------------------------------------------------------------------------
async function createLocalClient() {
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
  const pool = new pg.Pool({ ...base, max: CFG.poolMax, options: `-c search_path=${schema},public` });
  await runMigrations(pool);

  const store = new PgStore({ pool, piiKey: "orquesta-load-pii-key-32bytes!!" });
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

function createHttpClient() {
  if (!CFG.baseUrl) throw new Error("--base-url es obligatorio con --target=http");
  const baseUrl = CFG.baseUrl.replace(/\/+$/, "");
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
function sha256Hex(s) {
  return createHash("sha256").update(s).digest("hex");
}
function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}
function batchChecksum(events) {
  return sha256Hex(canonicalJson([...events].sort((a, b) => a.sequence - b.sequence)));
}
function must(res, expected, what) {
  if (res.status !== expected) {
    throw new Error(`${what}: esperaba ${expected}, recibió ${res.status} ${JSON.stringify(res.body)?.slice(0, 300)}`);
  }
  return res.body;
}
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}
const round = (n) => (n === null ? null : Math.round(n * 10) / 10);

// ----------------------------------------------------------------------------
// Setup: planner, venue, eventos en curso, invitados, sesiones de escaneo
// ----------------------------------------------------------------------------
async function loginPlanner(client) {
  if (client.kind === "http") {
    const login = must(
      await client.request("POST", "/v1/auth/login", {
        body: { email: opt["planner-email"], password: opt["planner-password"] },
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

async function setupEvent(client, plannerHeaders, venueId, idx, guestCount) {
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

async function waitImport(client, plannerHeaders, eventId, importId) {
  for (let i = 0; i < 300; i++) {
    const st = await client.request("GET", `/v1/events/${eventId}/guests/imports/${importId}`, { headers: plannerHeaders });
    if (st.body?.estado === "completado") return st.body;
    if (st.body?.estado === "fallido") throw new Error(`import fallido: ${JSON.stringify(st.body)}`);
    await client.afterSetup();
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("import no terminó en 300 s");
}

async function openDevice(client, plannerHeaders, eventId, accessToken, deviceId) {
  const sess = must(
    await client.request("POST", "/v1/auth/event-session", { body: { access_token: accessToken, device_id: deviceId } }),
    200,
    "event-session"
  );
  const headers = { authorization: `Bearer ${sess.session_token}` };
  const roster = must(
    await client.request("GET", `/v1/scan-sessions/${sess.session_id}/roster`, { headers }),
    200,
    "roster"
  );
  return { eventId, deviceId, sessionId: sess.session_id, headers, seq: 0, roster: roster.invitados };
}

// ----------------------------------------------------------------------------
// Envío de lotes y métricas
// ----------------------------------------------------------------------------
const stats = {
  batches: 0,
  batchErrors: [],
  latenciesMs: [],
  itemsSent: 0,
  itemsWithoutCheckinId: 0,
  verdicts: {},
  admittedInvitations: new Map(), // invitation_id -> nº de veredictos `admitido`
  scannedInvitations: new Set(),
};

async function sendBatch(client, device, invitationIds) {
  const events = invitationIds.map((invitationId) => ({
    sequence: ++device.seq,
    invitation_id: invitationId,
    scanned_at: new Date().toISOString(),
    verdict_local: "admitido",
    modo: "camara",
  }));
  const body = {
    batch_id: randomUUID(),
    device_id: device.deviceId,
    event_id: device.eventId,
    seq_desde: events[0].sequence,
    seq_hasta: events[events.length - 1].sequence,
    checksum: { alg: "sha256", valor: batchChecksum(events) },
    cola_reportada: 0,
    events,
  };
  for (const e of events) stats.scannedInvitations.add(e.invitation_id);
  stats.itemsSent += events.length;
  const t0 = performance.now();
  let res;
  try {
    res = await client.request("POST", `/v1/scan-sessions/${device.sessionId}/batches`, {
      headers: { ...device.headers, "idempotency-key": body.batch_id },
      body,
    });
  } catch (err) {
    stats.batchErrors.push({ error: String(err?.message || err) });
    return null;
  }
  const ms = performance.now() - t0;
  stats.batches += 1;
  stats.latenciesMs.push(ms);
  if (res.status !== 200) {
    stats.batchErrors.push({ status: res.status, code: res.body?.error?.code });
    return { ms, ok: false };
  }
  for (const r of res.body.results || []) {
    if (!r.checkin_id) stats.itemsWithoutCheckinId += 1;
    stats.verdicts[r.verdict] = (stats.verdicts[r.verdict] || 0) + 1;
    if (r.verdict === "admitido") {
      stats.admittedInvitations.set(r.invitation_id, (stats.admittedInvitations.get(r.invitation_id) || 0) + 1);
    }
  }
  return { ms, ok: true };
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
async function main() {
  log("config", CFG);
  const client = CFG.target === "http" ? createHttpClient() : await createLocalClient();
  const report = { config: CFG, target: client.kind, started_at: new Date().toISOString() };
  try {
    // ---------------- Setup ----------------
    const tSetup = performance.now();
    const plannerHeaders = await loginPlanner(client);
    const venue = must(
      await client.request("POST", "/v1/venues", {
        headers: plannerHeaders,
        body: { nombre: "Venue de carga", zona: "centro", direccion: "Load 1" },
      }),
      201,
      "venue"
    );

    log(`creando ${CFG.events} eventos × ${CFG.guestsPerEvent} invitados + 1 evento offline × ${CFG.offlineBacklog}`);
    const importStarts = [];
    for (let i = 0; i < CFG.events; i++) {
      importStarts.push(await setupEvent(client, plannerHeaders, venue.id, i, CFG.guestsPerEvent));
    }
    const offlineSetup = await setupEvent(client, plannerHeaders, venue.id, "offline", CFG.offlineBacklog);

    // El tiempo de import NO se reporta aquí: en local los imports se procesan en serie al drenar la
    // cola y el número no sería representativo (la prueba de import es aparte, issue #7).
    for (const s of [...importStarts, offlineSetup]) {
      await waitImport(client, plannerHeaders, s.eventId, s.importId);
    }

    const devices = [];
    for (const s of importStarts) {
      const tok = must(
        await client.request("POST", `/v1/events/${s.eventId}/access-tokens`, { headers: plannerHeaders, body: { rol: "staff" } }),
        201,
        "access token"
      );
      for (let d = 0; d < CFG.devicesPerEvent; d++) {
        devices.push(await openDevice(client, plannerHeaders, s.eventId, tok.qr_token, `load-dev-${d}`));
      }
    }
    const offTok = must(
      await client.request("POST", `/v1/events/${offlineSetup.eventId}/access-tokens`, {
        headers: plannerHeaders,
        body: { rol: "staff" },
      }),
      201,
      "access token offline"
    );
    const offlineDevice = await openDevice(client, plannerHeaders, offlineSetup.eventId, offTok.qr_token, "load-dev-offline");
    report.setup_s = round((performance.now() - tSetup) / 1000);
    log(`setup listo en ${report.setup_s}s; ${devices.length} dispositivos en línea`);

    // Reparto de invitados: cada dispositivo escanea su porción; los duplicados toman de un vecino.
    const byEvent = new Map();
    for (const dev of devices) {
      if (!byEvent.has(dev.eventId)) byEvent.set(dev.eventId, []);
      byEvent.get(dev.eventId).push(dev);
    }
    for (const devs of byEvent.values()) {
      const roster = devs[0].roster.map((r) => r.invitation_id);
      devs.forEach((dev, i) => {
        dev.queue = roster.filter((_, k) => k % devs.length === i);
        dev.peers = devs.filter((p) => p !== dev);
        dev.scanned = [];
      });
    }

    // ---------------- Carga sostenida + ráfaga offline ----------------
    const perDevicePerTick = CFG.rate / devices.length;
    let carry = 0;
    const inflight = new Set();
    let offlineResult = null;
    const tLoad = performance.now();
    log(`carga: ${CFG.rate} check-ins/s durante ${CFG.duration}s (${perDevicePerTick.toFixed(2)} por dispositivo por segundo)`);

    for (let tick = 0; tick < CFG.duration; tick++) {
      const tickStart = performance.now();
      for (const dev of devices) {
        carry += perDevicePerTick;
        const n = Math.floor(carry);
        carry -= n;
        if (n === 0) continue;
        const ids = [];
        for (let k = 0; k < n; k++) {
          const peer = dev.peers.length ? dev.peers[Math.floor(Math.random() * dev.peers.length)] : null;
          if (peer && peer.scanned.length && Math.random() < CFG.dupRate) {
            ids.push(peer.scanned[Math.floor(Math.random() * peer.scanned.length)]); // mismo QR en otra puerta
          } else if (dev.queue.length) {
            const id = dev.queue.shift();
            dev.scanned.push(id);
            ids.push(id);
          }
        }
        if (!ids.length) continue;
        const p = sendBatch(client, dev, ids).finally(() => inflight.delete(p));
        inflight.add(p);
      }

      if (tick === Math.floor(CFG.duration / 2) && CFG.offlineBacklog > 0) {
        // Un dispositivo vuelve a tener señal con N escaneos acumulados: los drena en lotes de 500,
        // en serie (como BatchSyncService), en medio del pico.
        const ids = offlineDevice.roster.map((r) => r.invitation_id).slice(0, CFG.offlineBacklog);
        const p = (async () => {
          const t0 = performance.now();
          const lat = [];
          for (let i = 0; i < ids.length; i += 500) {
            const r = await sendBatch(client, offlineDevice, ids.slice(i, i + 500));
            if (r) lat.push(round(r.ms));
          }
          offlineResult = { escaneos: ids.length, lotes: lat.length, latencias_lote_ms: lat, total_s: round((performance.now() - t0) / 1000) };
          log(`ráfaga offline: ${ids.length} escaneos sincronizados en ${offlineResult.total_s}s`);
        })().finally(() => inflight.delete(p));
        inflight.add(p);
      }

      const elapsed = performance.now() - tickStart;
      if (elapsed < 1000) await new Promise((r) => setTimeout(r, 1000 - elapsed));
      if (tick % 10 === 9) {
        log(`t=${tick + 1}s enviados=${stats.itemsSent} lotes=${stats.batches} en_vuelo=${inflight.size} errores=${stats.batchErrors.length}`);
      }
    }
    await Promise.all([...inflight]);
    const loadSeconds = (performance.now() - tLoad) / 1000;

    // ---------------- Verificación ----------------
    // Convergencia del tablero (FR3): asistentes por evento = invitaciones únicas escaneadas.
    const expectedByEvent = new Map();
    for (const dev of [...devices, offlineDevice]) {
      const set = expectedByEvent.get(dev.eventId) || new Set();
      for (const r of dev.roster) {
        if (stats.scannedInvitations.has(r.invitation_id)) set.add(r.invitation_id);
      }
      expectedByEvent.set(dev.eventId, set);
    }
    const tDash = performance.now();
    let dashboardOk = false;
    let mismatches = [];
    for (let attempt = 0; attempt < 30 && !dashboardOk; attempt++) {
      const seen = new Map();
      let cursor = null;
      do {
        const page = must(
          await client.request("GET", `/v1/dashboard?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, {
            headers: plannerHeaders,
          }),
          200,
          "dashboard"
        );
        for (const it of page.items) seen.set(it.event_id, it.contadores.asistentes);
        cursor = page.next_cursor;
      } while (cursor);
      mismatches = [...expectedByEvent].filter(([id, set]) => seen.get(id) !== set.size).map(([id, set]) => ({ event_id: id, esperado: set.size, tablero: seen.get(id) }));
      dashboardOk = mismatches.length === 0;
      if (!dashboardOk) await new Promise((r) => setTimeout(r, 1000));
    }

    const sorted = [...stats.latenciesMs].sort((a, b) => a - b);
    const doubleAdmitted = [...stats.admittedInvitations.values()].filter((n) => n > 1).length;
    const uniqueScanned = stats.scannedInvitations.size;
    const admittedUnique = stats.admittedInvitations.size;
    const db = await client.verifyInDb();

    Object.assign(report, {
      carga: {
        objetivo_checkins_por_s: CFG.rate,
        logrado_checkins_por_s: round(stats.itemsSent / loadSeconds),
        duracion_s: round(loadSeconds),
        escaneos_enviados: stats.itemsSent,
        invitaciones_unicas: uniqueScanned,
        lotes: stats.batches,
        lotes_con_error: stats.batchErrors.length,
        errores: stats.batchErrors.slice(0, 10),
      },
      latencia_lote_ms: {
        p50: round(percentile(sorted, 50)),
        p95: round(percentile(sorted, 95)),
        p99: round(percentile(sorted, 99)),
        max: round(sorted[sorted.length - 1] ?? null),
      },
      ac01: {
        perdidos_sin_checkin_id: stats.itemsWithoutCheckinId,
        invitaciones_admitidas_2_veces: doubleAdmitted,
        admitidas_unicas: admittedUnique,
        esperadas: uniqueScanned,
        veredictos: stats.verdicts,
        ...(db ? { bd: db } : {}),
      },
      ac04_rafaga_offline: offlineResult,
      tablero: {
        converge: dashboardOk,
        segundos_hasta_converger: round((performance.now() - tDash) / 1000),
        diferencias: mismatches.slice(0, 5),
      },
      invitados_por_evento: CFG.guestsPerEvent,
    });

    const checks = {
      "AC-01 sin pérdidas": stats.itemsWithoutCheckinId === 0 && stats.batchErrors.length === 0,
      "AC-01 sin dobles admisiones": doubleAdmitted === 0 && (!db || db.invitaciones_admitidas_2_veces === 0),
      "AC-01 cada invitación única admitida 1 vez": admittedUnique === uniqueScanned,
      "AC-01 tasa sostenida ≥ 95 % del objetivo": stats.itemsSent / loadSeconds >= CFG.rate * 0.95,
      "AC-04 ráfaga offline < 30 s": !offlineResult || offlineResult.total_s < 30,
      "FR3 tablero converge": dashboardOk,
    };
    report.checks = checks;
    report.ok = Object.values(checks).every(Boolean);

    console.log("\n================ RESULTADO ================");
    console.log(JSON.stringify({ ...report, config: undefined }, null, 2));
    for (const [k, v] of Object.entries(checks)) console.log(`${v ? "✅" : "❌"} ${k}`);

    const outPath = opt.out || `load/results/checkin-${client.kind}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    await mkdir(new URL("./results/", import.meta.url), { recursive: true }).catch(() => {});
    await writeFile(outPath, JSON.stringify(report, null, 2));
    log(`reporte: ${outPath}`);
    process.exitCode = report.ok ? 0 : 1;
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
