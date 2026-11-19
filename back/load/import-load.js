#!/usr/bin/env node
/**
 * Prueba de carga del import de invitados (FR1, issue #7).
 *
 * NFR: importar 1 000 invitados en < 30 s. Además se mide 5 000 y 20 000 (límite de RF-02) y se
 * verifica la correctitud que pide la spec:
 *   - aceptadas = filas válidas únicas; duplicadas y rechazadas reportadas por línea (RF-02);
 *   - el import NO envía mensajes: todos quedan `pendiente_envío` (AC-21);
 *   - reimportar el mismo archivo no crea invitados nuevos (TR-11).
 *
 * Uso:
 *   npm run db:up && npm run load:import
 *   node load/import-load.js --sizes=1000,5000 --runs=5
 *   node load/import-load.js --target=http --base-url=... --planner-email=... --planner-password=...
 *
 * Tiempo medido: desde el POST /guests/import hasta `estado = completado` (incluye parseo,
 * validación, inserciones, firma de QR y PNG). En local el worker se ejecuta en proceso al drenar
 * la cola; en http se hace polling cada 500 ms (resolución ±0.5 s).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { createHttpClient, createLocalClient, loginPlanner, must, percentile, round } from "./lib.js";

const { values: opt } = parseArgs({
  options: {
    target: { type: "string", default: "local" },
    "base-url": { type: "string" },
    "planner-email": { type: "string" },
    "planner-password": { type: "string" },
    sizes: { type: "string", default: "1000,5000,20000" },
    runs: { type: "string", default: "3" },
    "dup-rate": { type: "string", default: "0.02" },
    "invalid-rate": { type: "string", default: "0.01" },
    "target-seconds-1000": { type: "string", default: "30" },
    // Solo local: latencia artificial para aproximar AWS (firma en KMS y PUT a S3 por invitado).
    "kms-ms": { type: "string", default: "0" },
    "s3-ms": { type: "string", default: "0" },
  },
});
const SIZES = opt.sizes.split(",").map(Number);
const RUNS = Number(opt.runs);
const DUP = Number(opt["dup-rate"]);
const INVALID = Number(opt["invalid-rate"]);
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

/** CSV de `rows` filas: válidas únicas, con DUP % repetidas y INVALID % sin clave válida. */
function buildCsv(rows, tag) {
  const lines = ["nombre,email,telefono"];
  const valid = [];
  let invalid = 0;
  let dups = 0;
  for (let i = 0; i < rows; i++) {
    const r = Math.random();
    if (r < INVALID) {
      lines.push(`Sin Clave ${tag}-${i},correo-invalido,`);
      invalid += 1;
    } else if (r < INVALID + DUP && valid.length > 0) {
      lines.push(valid[Math.floor(Math.random() * valid.length)]);
      dups += 1;
    } else {
      const line = `Invitado ${tag}-${i},inv-${tag}-${i}@load.test,`;
      valid.push(line);
      lines.push(line);
    }
  }
  return { csv: lines.join("\n"), validUnique: valid.length, invalid, dups };
}

function multipart(csv, boundary) {
  return (
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="guests.csv"\r\n` +
    `Content-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`
  );
}

async function importAndWait(client, headers, eventId, csv, tag) {
  const boundary = `----OrquestaImport${tag}`;
  const t0 = performance.now();
  const imp = must(
    await client.request("POST", `/v1/events/${eventId}/guests/import`, {
      headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` },
      rawBody: multipart(csv, boundary),
    }),
    202,
    "import"
  );
  for (let i = 0; i < 1200; i++) {
    if (client.kind === "local") await client.afterSetup(); // el import-worker corre al drenar la cola
    const st = await client.request("GET", `/v1/events/${eventId}/guests/imports/${imp.import_id}`, { headers });
    if (st.body?.estado === "completado") return { ms: performance.now() - t0, job: st.body };
    if (st.body?.estado === "fallido") throw new Error(`import fallido: ${JSON.stringify(st.body).slice(0, 300)}`);
    if (client.kind === "http") await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("import no terminó");
}

async function main() {
  const client =
    opt.target === "http" ? createHttpClient({ baseUrl: opt["base-url"] }) : await createLocalClient({ poolMax: 5 });
  const kmsMs = Number(opt["kms-ms"]);
  const s3Ms = Number(opt["s3-ms"]);
  if (client.kind === "local" && (kmsMs > 0 || s3Ms > 0)) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const signer = client.ctx.qrSigner;
    const storage = client.ctx.objectStorage;
    const sign = signer.signJws.bind(signer);
    const put = storage.putObject.bind(storage);
    signer.signJws = async (...a) => (await sleep(kmsMs), sign(...a));
    storage.putObject = async (...a) => (await sleep(s3Ms), put(...a));
  }
  const report = {
    target: client.kind,
    started_at: new Date().toISOString(),
    latencia_simulada_ms: { kms: kmsMs, s3: s3Ms },
    sizes: {},
    checks: {},
  };
  try {
    const headers = await loginPlanner(client, { email: opt["planner-email"], password: opt["planner-password"] });
    const venue = must(
      await client.request("POST", "/v1/venues", { headers, body: { nombre: "Venue import", zona: "centro", direccion: "Imp 1" } }),
      201,
      "venue"
    );

    for (const size of SIZES) {
      const times = [];
      let lastCheck = null;
      for (let run = 0; run < RUNS; run++) {
        const tag = `${size}-${run}-${Date.now().toString(36)}`;
        const { csv, validUnique, invalid, dups } = buildCsv(size, tag);
        const ev = must(
          await client.request("POST", "/v1/events", {
            headers,
            body: {
              nombre: `Import ${tag}`,
              fecha: new Date().toISOString().slice(0, 10),
              timezone: "America/Mexico_City",
              ventana: { inicio: new Date(Date.now() + 7 * 86400_000).toISOString(), fin: new Date(Date.now() + 7.3 * 86400_000).toISOString() },
              venue_id: venue.id,
              aforo: size,
            },
          }),
          201,
          "evento"
        );

        const { ms, job } = await importAndWait(client, headers, ev.id, csv, tag);
        times.push(ms);

        // Correctitud (solo en la primera corrida de cada tamaño, para no inflar el tiempo total).
        if (run === 0) {
          const pending = must(
            await client.request("GET", `/v1/events/${ev.id}/invitations/pending-summary`, { headers }),
            200,
            "pending-summary"
          );
          const reimport = await importAndWait(client, headers, ev.id, csv, `${tag}-re`);
          const pendingAfter = must(
            await client.request("GET", `/v1/events/${ev.id}/invitations/pending-summary`, { headers }),
            200,
            "pending-summary 2"
          );
          lastCheck = {
            filas: size,
            validas_unicas: validUnique,
            invalidas: invalid,
            duplicadas_en_archivo: dups,
            job: { aceptadas: job.aceptadas, rechazadas: job.rechazadas, duplicadas_en_archivo: job.duplicadas_en_archivo },
            pendiente_envio: pending.pendiente_envio,
            reimport: { aceptadas: reimport.job.aceptadas, pendiente_envio_despues: pendingAfter.pendiente_envio },
            ok:
              job.aceptadas === validUnique &&
              job.rechazadas === invalid &&
              pending.pendiente_envio === validUnique &&
              reimport.job.aceptadas === 0 &&
              pendingAfter.pendiente_envio === validUnique,
          };
        }
        log(`${size} filas · corrida ${run + 1}/${RUNS}: ${(ms / 1000).toFixed(2)} s`);
      }
      const sorted = [...times].sort((a, b) => a - b);
      report.sizes[size] = {
        corridas: RUNS,
        segundos: { p50: round(percentile(sorted, 50) / 1000), p95: round(percentile(sorted, 95) / 1000), max: round(sorted.at(-1) / 1000) },
        filas_por_s_p50: Math.round(size / (percentile(sorted, 50) / 1000)),
        correctitud: lastCheck,
      };
    }

    const t1000 = report.sizes[1000]?.segundos.p95;
    report.checks = {
      "NFR FR1: 1 000 invitados < 30 s (p95)": t1000 === undefined || t1000 < Number(opt["target-seconds-1000"]),
      "RF-02: aceptadas = válidas únicas; rechazadas reportadas": Object.values(report.sizes).every((r) => r.correctitud?.ok),
    };
    report.ok = Object.values(report.checks).every(Boolean);

    console.log("\n================ RESULTADO ================");
    console.log(JSON.stringify(report, null, 2));
    for (const [k, v] of Object.entries(report.checks)) console.log(`${v ? "✅" : "❌"} ${k}`);
    await mkdir(new URL("./results/", import.meta.url), { recursive: true });
    const out = `load/results/import-${client.kind}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
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
