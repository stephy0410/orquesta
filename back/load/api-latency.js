#!/usr/bin/env node
/**
 * Latencias de los NFR que no cubren checkin-load ni import-load, con pocas peticiones (no es
 * prueba de estrés):
 *   - FR4 búsqueda de proveedores: p95 < 500 ms (GET /v1/workers, N lecturas con concurrencia 5).
 *   - FR7 guardar en el plano de mesas: < 1 s con 500 invitados y 50 mesas (cada asignación).
 *   - FR3 lectura del tablero (GET /v1/dashboard) mientras se edita.
 *
 * Uso:
 *   node load/api-latency.js --target=http --base-url=... --planner-email=... --planner-password=...
 *   node load/api-latency.js            # local contra PostgreSQL (docker compose)
 */
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import {
  createHttpClient,
  createLocalClient,
  loginPlanner,
  must,
  percentile,
  round,
  setupEvent,
  waitImport,
} from "./lib.js";

const { values: opt } = parseArgs({
  options: {
    target: { type: "string", default: "local" },
    "base-url": { type: "string" },
    "planner-email": { type: "string" },
    "planner-password": { type: "string" },
    searches: { type: "string", default: "200" },
    guests: { type: "string", default: "500" },
    tables: { type: "string", default: "50" },
  },
});
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

function summarize(ms) {
  const s = [...ms].sort((a, b) => a - b);
  return { n: s.length, p50: round(percentile(s, 50)), p95: round(percentile(s, 95)), p99: round(percentile(s, 99)), max: round(s.at(-1)) };
}

async function timed(fn) {
  const t0 = performance.now();
  const res = await fn();
  return { res, ms: performance.now() - t0 };
}

async function main() {
  const client = opt.target === "http" ? createHttpClient({ baseUrl: opt["base-url"] }) : await createLocalClient({ poolMax: 5 });
  const report = { target: client.kind, started_at: new Date().toISOString(), checks: {} };
  try {
    const headers = await loginPlanner(client, { email: opt["planner-email"], password: opt["planner-password"] });

    // ---------------- FR4: búsqueda de proveedores ----------------
    const N = Number(opt.searches);
    const searchMs = [];
    const queries = [
      "categorias=mesero&zonas=centro&radio_km=20",
      "categorias=fotografo&zonas=sur&radio_km=30",
      "categorias=dj",
      "zonas=centro&tarifa_max=2000",
    ];
    let next = 0;
    await Promise.all(
      Array.from({ length: 5 }, async () => {
        while (next < N) {
          const q = queries[next++ % queries.length];
          const { res, ms } = await timed(() => client.request("GET", `/v1/workers?${q}`, { headers }));
          must(res, 200, "búsqueda");
          searchMs.push(ms);
        }
      })
    );
    report.busqueda_proveedores_ms = summarize(searchMs);
    log("búsqueda", report.busqueda_proveedores_ms);

    // ---------------- FR7: plano de mesas con 500 invitados y 50 mesas ----------------
    const G = Number(opt.guests);
    const T = Number(opt.tables);
    const venue = must(
      await client.request("POST", "/v1/venues", { headers, body: { nombre: "Venue mesas", zona: "centro", direccion: "Mesas 1" } }),
      201,
      "venue"
    );
    const { eventId, importId } = await setupEvent(client, headers, venue.id, `mesas-${Date.now().toString(36)}`, G);
    await waitImport(client, headers, eventId, importId);

    const guestIds = [];
    let cursor = null;
    do {
      const page = must(
        await client.request("GET", `/v1/events/${eventId}/guests?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { headers }),
        200,
        "invitados"
      );
      for (const g of page.items) guestIds.push(g.id || g.guest_id);
      cursor = page.next_cursor;
    } while (cursor);

    // El plano exige If-Match con su versión (SEATING_REQUIRE_IF_MATCH en AWS), igual que el front.
    const parseVersion = (res) => String(res.headers.etag || "").replace(/^W\//, "").replace(/"/g, "");
    const plan = await client.request("GET", `/v1/events/${eventId}/tables?limit=1`, { headers });
    must(plan, 200, "versión del plano");
    let version = parseVersion(plan);
    const capacidad = Math.ceil(G / T);
    const tableIds = [];
    const tableMs = [];
    for (let t = 0; t < T; t++) {
      const { res, ms } = await timed(() =>
        client.request("POST", `/v1/events/${eventId}/tables`, {
          headers: { ...headers, "if-match": `"${version}"` },
          body: { numero: t + 1, nombre: `Mesa ${t + 1}`, capacidad },
        })
      );
      tableIds.push(must(res, 201, "mesa").id || res.body.table_id);
      version = parseVersion(res);
      tableMs.push(ms);
    }

    const seatMs = [];
    const dashMs = [];
    for (let i = 0; i < guestIds.length; i++) {
      const { res, ms } = await timed(() =>
        client.request("POST", `/v1/events/${eventId}/seat-assignments`, {
          headers: { ...headers, "if-match": `"${version}"` },
          body: { guest_id: guestIds[i], table_id: tableIds[i % T] },
        })
      );
      if (res.status !== 201 && res.status !== 200) throw new Error(`asignar: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
      version = parseVersion(res);
      seatMs.push(ms);
      if (i % 10 === 0) {
        const d = await timed(() => client.request("GET", "/v1/dashboard?limit=25", { headers }));
        must(d.res, 200, "tablero");
        dashMs.push(d.ms);
      }
    }
    const unseated = must(await client.request("GET", `/v1/events/${eventId}/seat-assignments/unseated?limit=5`, { headers }), 200, "sin mesa");
    const tables = must(await client.request("GET", `/v1/events/${eventId}/tables?limit=100`, { headers }), 200, "mesas");
    const over = (tables.items || []).filter((t) => (t.ocupacion ?? 0) > t.capacidad).length;

    report.mesas = {
      invitados: guestIds.length,
      mesas: T,
      capacidad_por_mesa: capacidad,
      crear_mesa_ms: summarize(tableMs),
      asignar_asiento_ms: summarize(seatMs),
      sin_mesa_al_final: (unseated.items || []).length,
      mesas_sobre_capacidad: over,
    };
    report.tablero_lectura_ms = summarize(dashMs);
    log("mesas", report.mesas.asignar_asiento_ms, "tablero", report.tablero_lectura_ms);

    report.checks = {
      "FR4 búsqueda p95 < 500 ms": report.busqueda_proveedores_ms.p95 < 500,
      "FR7 guardar asignación p99 < 1 s (500 invitados / 50 mesas)": report.mesas.asignar_asiento_ms.p99 < 1000,
      "FR7 todos sentados, ninguna mesa sobre capacidad": report.mesas.sin_mesa_al_final === 0 && over === 0,
    };
    report.ok = Object.values(report.checks).every(Boolean);
    console.log("\n================ RESULTADO ================");
    console.log(JSON.stringify(report, null, 2));
    for (const [k, v] of Object.entries(report.checks)) console.log(`${v ? "✅" : "❌"} ${k}`);
    await mkdir(new URL("./results/", import.meta.url), { recursive: true });
    const out = `load/results/latency-${client.kind}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    await writeFile(out, JSON.stringify(report, null, 2));
    log(`reporte: ${out}`);
    process.exitCode = report.ok ? 0 : 1;
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
