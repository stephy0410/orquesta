// Flush del outbox con varias Lambdas a la vez (NFR-03, TR-05). Medido en AWS: cuando cada
// petición leía los mismos pendientes sin bloquearlos, 30 Lambdas reenviaban los mismos mensajes y
// el p99 del check-in subía a 1.7 s. Cada flush debe reclamar sus filas: ninguna se publica dos
// veces y una falla al publicar no pierde nada. Corre contra memoria y, con TEST_DB=pg, contra
// PostgreSQL real (FOR UPDATE SKIP LOCKED).
import assert from "node:assert/strict";
import test from "node:test";

import { flushOutboxNow } from "../src/shared/context.js";
import { InMemoryStore } from "../src/shared/store.js";
import { ulid } from "../src/shared/ulid.js";

const USE_PG = process.env.TEST_DB === "pg";
const N = 120;

async function makeStore() {
  if (!USE_PG) {
    const store = new InMemoryStore();
    for (let i = 0; i < N; i++) {
      store.outboxEvents.push({
        id: ulid(),
        event_id: null,
        topic: i % 4 === 0 ? "notifications" : "projection",
        event_type: "prueba",
        canal: "email",
        payload: { i },
        t_ingest: new Date().toISOString(),
        published_at: null,
        created_at: new Date(Date.now() + i).toISOString(),
      });
    }
    return {
      store,
      pending: async () => store.outboxEvents.filter((e) => !e.published_at).length,
      close: async () => {},
    };
  }
  const pg = (await import("pg")).default;
  const { PgStore, runMigrations } = await import("../src/shared/db.js");
  const base = {
    host: process.env.PGHOST || "127.0.0.1",
    port: Number(process.env.PGPORT || 55432),
    user: process.env.PGUSER || "orquesta_admin",
    password: process.env.PGPASSWORD || "orquesta",
    database: process.env.PGDATABASE || "orquesta",
  };
  const schema = `t_outbox_${process.pid}_${Date.now().toString(36)}`;
  const admin = new pg.Pool({ ...base, max: 1 });
  await admin.query(`CREATE EXTENSION IF NOT EXISTS btree_gist SCHEMA public`);
  await admin.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA public`);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ ...base, max: 20, options: `-c search_path=${schema},public` });
  await runMigrations(pool);
  for (let i = 0; i < N; i++) {
    await pool.query(
      `INSERT INTO outbox_event (id, topic, event_type, canal, payload, created_at)
       VALUES ($1, $2, 'prueba', 'email', $3, now() + ($4 || ' milliseconds')::interval)`,
      [ulid(), i % 4 === 0 ? "notifications" : "projection", JSON.stringify({ i }), String(i)]
    );
  }
  const store = new PgStore({ pool, piiKey: "orquesta-dev-pii-key-32bytes!" });
  return {
    store,
    pending: async () => (await pool.query(`SELECT count(*)::int AS n FROM outbox_event WHERE published_at IS NULL`)).rows[0].n,
    close: async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

/** queueBus falso con latencia, como SNS/SQS reales; cuenta cuántas veces sale cada fila. */
function fakeBus({ failProjection = false } = {}) {
  const sent = new Map();
  const count = (id) => sent.set(id, (sent.get(id) || 0) + 1);
  const delay = () => new Promise((r) => setTimeout(r, 5 + Math.random() * 10));
  return {
    sent,
    async publishNotification(msg) {
      await delay();
      count(msg.outbox_event_id);
      return ["x"];
    },
    async sendToProjection(msgs) {
      await delay();
      if (failProjection) throw new Error("SQS caído");
      for (const m of msgs) count(m.outbox_event_id);
      return msgs.map(() => "x");
    },
  };
}

test("flushes concurrentes publican cada fila del outbox una sola vez", async () => {
  const { store, pending, close } = await makeStore();
  try {
    const queueBus = fakeBus();
    const ctx = { store, queueBus, now: () => new Date() };
    // 8 "Lambdas" vacían el outbox a la vez, en tandas de 25.
    let total = 0;
    for (let round = 0; round < 10 && (await pending()) > 0; round++) {
      const res = await Promise.all(Array.from({ length: 8 }, () => flushOutboxNow(ctx, 25)));
      total += res.reduce((a, r) => a + r.flushed, 0);
    }
    assert.equal(await pending(), 0);
    assert.equal(total, N);
    assert.equal(queueBus.sent.size, N);
    assert.deepEqual([...new Set(queueBus.sent.values())], [1], "ninguna fila se publicó dos veces");
  } finally {
    await close();
  }
});

test("si publicar falla, las filas quedan pendientes para el siguiente flush", async () => {
  const { store, pending, close } = await makeStore();
  try {
    const ctx = { store, queueBus: fakeBus({ failProjection: true }), now: () => new Date() };
    await assert.rejects(flushOutboxNow(ctx, 50), /SQS caído/);
    assert.equal(await pending(), N, "el ROLLBACK no marca nada como publicado");

    const ok = fakeBus();
    let flushed = 0;
    while ((await pending()) > 0) flushed += (await flushOutboxNow({ ...ctx, queueBus: ok }, 50)).flushed;
    assert.equal(flushed, N);
  } finally {
    await close();
  }
});
