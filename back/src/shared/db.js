import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { attachPgStoreMethods } from "./pg-store-methods.js";
import {
  isValidCategoria,
  isValidIanaTimezone,
  isValidRol,
  isValidZona,
  isServicioAllowedForCategorias,
} from "./catalogs.js";
import {
  decryptPii,
  encryptPii,
  generateOpaqueToken,
  generateShortCode,
  hmacLookup,
  sha256Hex,
} from "./crypto.js";
import {
  buildTr12Destinatario,
  computeReminderTimes,
  deriveSyncPendingState,
  filterAndRankWorkers,
  normalizeEmail,
  normalizePhoneE164,
  paginateArray,
  validateAndNormalizeCsvRow,
  validateCheckinBatchPayload,
  windowContains,
  windowsOverlap,
} from "./domain-helpers.js";
import { AppError, IMPORT_ROW_ERRORS, validationError } from "./errors.js";
import { renderQrPng } from "./qr-png.js";
import { ulid } from "./ulid.js";

const { Pool } = pg;

let cachedSecrets = null;
let cachedPool = null;
let migrationPromise = null;

export async function loadAppSecrets() {
  if (cachedSecrets) return cachedSecrets;
  const secretsArn = process.env.SECRETS_ARN;
  if (secretsArn && process.env.SECRETS_MODE !== "env") {
    try {
      const { SecretsManagerClient, GetSecretValueCommand } = await import(
        "@aws-sdk/client-secrets-manager"
      );
      const client = new SecretsManagerClient({ region: process.env.AWS_REGION || "us-east-1" });
      const res = await client.send(new GetSecretValueCommand({ SecretId: secretsArn }));
      cachedSecrets = JSON.parse(res.SecretString || "{}");
      return cachedSecrets;
    } catch {
      // Fallback a variables de entorno si Secrets Manager no está disponible en local
    }
  }
  cachedSecrets = {
    db_host: process.env.DB_HOST,
    db_port: Number(process.env.DB_PORT || 5432),
    db_name: process.env.DB_NAME || "orquesta",
    db_username: process.env.DB_USERNAME || "orquesta_admin",
    db_password: process.env.DB_PASSWORD || "",
    session_secret: process.env.SESSION_SECRET || "orquesta-dev-session-secret",
    psp_webhook_secret: process.env.PSP_WEBHOOK_SECRET || "orquesta-dev-psp-secret",
    pii_encryption_key: process.env.PII_ENCRYPTION_KEY || "orquesta-dev-pii-key-32bytes!",
  };
  return cachedSecrets;
}

export async function getPool(config = {}) {
  if (cachedPool && !config.forceNew) return cachedPool;
  const secrets = await loadAppSecrets();
  const useTls =
    config.ssl !== undefined
      ? config.ssl
      : process.env.DB_SSL !== "false" && Boolean(process.env.DB_HOST || secrets.db_host);

  const pool = new Pool({
    host: config.host || secrets.db_host || process.env.DB_HOST || "127.0.0.1",
    port: Number(config.port || secrets.db_port || process.env.DB_PORT || 5432),
    database: config.database || secrets.db_name || process.env.DB_NAME || "orquesta",
    user: config.user || secrets.db_username || process.env.DB_USERNAME || "orquesta_admin",
    password: config.password ?? secrets.db_password ?? process.env.DB_PASSWORD ?? "",
    max: Number(config.max || process.env.DB_POOL_MAX || 5),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    ssl: useTls ? { rejectUnauthorized: false } : false,
  });

  if (!config.forceNew) cachedPool = pool;
  if (config.autoMigrate !== false && process.env.AUTO_MIGRATE !== "false") {
    if (!migrationPromise) {
      migrationPromise = runMigrations(pool).catch((err) => {
        migrationPromise = null;
        throw err;
      });
    }
    await migrationPromise;
  }
  return pool;
}

export async function withTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback failure
    }
    throw err;
  } finally {
    client.release();
  }
}

const DEFAULT_MIGRATIONS_DIR = new URL("../../migrations/", import.meta.url);

/**
 * Runner de migraciones versionadas: aplica en orden lexicográfico cada `NNN_*.sql`
 * de `back/migrations/` que no esté en `schema_migrations`, todo en UNA transacción
 * serializada por advisory lock (varias Lambdas en cold start no compiten).
 * Las migraciones publicadas son inmutables: un cambio de esquema es un archivo nuevo.
 */
export async function runMigrations(pool, migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  const files = (await readdir(migrationsDir)).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  return withTx(pool, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(794821001)`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const appliedRes = await client.query(`SELECT version FROM schema_migrations`);
    const applied = new Set(appliedRes.rows.map((r) => r.version));
    const migrated = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const rawSql = await readFile(new URL(file, migrationsDir), "utf8");
      // Cada archivo trae su propio BEGIN/COMMIT para poder correrse con psql;
      // aquí se quitan porque el runner ya abrió la transacción.
      const strippedSql = rawSql
        .replace(/^\s*(--[^\n]*\n|\s)*BEGIN;\s*/i, "")
        .replace(/\s*COMMIT;\s*$/i, "");
      await client.query(strippedSql);
      // ON CONFLICT: algunos archivos se registran a sí mismos para poder aplicarse con psql.
      await client.query(`INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING`, [file]);
      migrated.push(file);
    }
    return { migrated: migrated.length > 0, applied: migrated };
  });
}

/** Ejecuta `fn` sobre `items` con a lo más `limit` promesas simultáneas, preservando el orden. */
export async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function toIso(d) {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

function mapPgError(err) {
  if (!err || !err.code) return err;
  const msg = String(err.message || "");
  if (msg.includes("EMAIL_YA_REGISTRADA")) {
    return new AppError("EMAIL_YA_REGISTRADA", "El email ya está registrado");
  }
  if (msg.includes("TELEFONO_YA_REGISTRADO") || err.constraint === "uq_worker_profile_phone_hmac") {
    return new AppError("TELEFONO_YA_REGISTRADO", "El teléfono ya respalda otro perfil verificado");
  }
  if (msg.includes("WINDOW_NOT_AVAILABLE")) {
    return new AppError("WINDOW_NOT_AVAILABLE", "Ventana fuera de disponibilidad declarada");
  }
  if (msg.includes("RESERVATION_OVERLAP")) {
    const match = msg.match(/ganadora=([0-9A-Z]{26})/);
    return new AppError("RESERVATION_OVERLAP", "La ventana se solapa con otra reserva aceptada", {
      ganadora: match ? { reservation_id: match[1] } : null,
    });
  }
  if (msg.includes("RESERVATION_NOT_PENDING")) {
    return new AppError("RESERVATION_NOT_PENDING", "La solicitud no está pendiente");
  }
  if (msg.includes("REQUEST_EXPIRED")) {
    return new AppError("REQUEST_EXPIRED", "La solicitud expiró");
  }
  if (msg.includes("PLAZAS_INVALIDAS")) {
    return new AppError("PLAZAS_INVALIDAS", "Plazas inválidas");
  }
  if (msg.includes("VALIDATION_ERROR")) {
    return validationError(msg);
  }
  return err;
}

/**
 * Repositorio PostgreSQL completo respaldado por el esquema de 001_initial_schema.sql.
 */
export class PgStore {
  constructor({ pool, piiKey = process.env.PII_ENCRYPTION_KEY || "orquesta-dev-pii-key-32bytes!", metrics = null }) {
    this.pool = pool;
    this.piiKey = piiKey;
    this.metrics = metrics;
    this.revokedSessionJtis = new Map();
  }

  _enc(v) {
    return encryptPii(v, this.piiKey);
  }

  _dec(v) {
    return decryptPii(v, this.piiKey);
  }

  _hmac(v) {
    return hmacLookup(v, this.piiKey);
  }

  async _insertOutbox(client, { eventId = null, topic, eventType, canal = null, payload, tIngest = new Date() }) {
    await client.query(
      `INSERT INTO outbox_event (id, event_id, topic, event_type, canal, payload, t_ingest)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [ulid(), eventId, topic, eventType, canal, JSON.stringify(payload || {}), toIso(tIngest)]
    );
  }

  async _insertAudit(client, { eventId = null, actorId, accion, entidad, entidadId, motivo, ts = new Date(), detalle = {} }) {
    await client.query(
      `INSERT INTO audit_entry (id, event_id, actor_id, accion, entidad, entidad_id, motivo, ts, detalle)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [ulid(), eventId, actorId, accion, entidad, entidadId, motivo, toIso(ts), JSON.stringify(detalle)]
    );
  }

  // ==========================================================================
  // Idempotencia HTTP
  // ==========================================================================
  async getIdempotency(scope, key) {
    const res = await this.pool.query(
      `SELECT scope, idempotency_key, request_hash, status_code, response_headers, response_body
         FROM idempotency_record
        WHERE scope = $1 AND idempotency_key = $2`,
      [scope, key]
    );
    return res.rows[0] || null;
  }

  async saveIdempotency({ scope, key, requestHash, statusCode, headers = {}, body }) {
    const res = await this.pool.query(
      `INSERT INTO idempotency_record (scope, idempotency_key, request_hash, status_code, response_headers, response_body)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
       ON CONFLICT (scope, idempotency_key) DO NOTHING
       RETURNING *`,
      [scope, key, requestHash, statusCode, JSON.stringify(headers), JSON.stringify(body)]
    );
    if (res.rowCount === 0) {
      const existing = await this.getIdempotency(scope, key);
      if (existing && existing.request_hash !== requestHash) {
        throw new AppError("IDEMPOTENCY_CONFLICT", "Idempotency-Key reutilizada con cuerpo distinto");
      }
      return existing;
    }
    return res.rows[0];
  }

  // ==========================================================================
  // Auth & Verificación
  // ==========================================================================
  async createUser({ email, roles = ["planner"], passwordHash }) {
    const normalized = normalizeEmail(email);
    if (!normalized) throw validationError("Email inválido", "email");
    const emailHmac = this._hmac(normalized);
    const id = ulid();
    try {
      const res = await this.pool.query(
        `INSERT INTO "user" (id, email, email_cifrado, email_hmac, roles, password_hash)
         VALUES ($1, NULL, $2, $3, $4, $5)
         RETURNING *`,
        [id, this._enc(normalized), emailHmac, [...new Set(roles)], passwordHash]
      );
      return { ...res.rows[0], email: normalized };
    } catch (err) {
      if (err.code === "23505") {
        throw new AppError("EMAIL_YA_REGISTRADA", "El email ya está registrado");
      }
      throw mapPgError(err);
    }
  }

  async findUserByEmail(email) {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    const res = await this.pool.query(`SELECT * FROM "user" WHERE email_hmac = $1`, [this._hmac(normalized)]);
    if (res.rowCount === 0) return null;
    const u = res.rows[0];
    return { ...u, email: this._dec(u.email_cifrado) };
  }

  async findUserById(userId) {
    const res = await this.pool.query(`SELECT * FROM "user" WHERE id = $1`, [userId]);
    if (res.rowCount === 0) return null;
    const u = res.rows[0];
    return { ...u, email: this._dec(u.email_cifrado) };
  }

  async updateUserPassword(userId, passwordHash) {
    await this.pool.query(`UPDATE "user" SET password_hash = $2 WHERE id = $1`, [userId, passwordHash]);
  }

  async revokeSessionJti(jti, exp) {
    if (jti) this.revokedSessionJtis.set(jti, exp);
  }

  async isSessionRevoked(jti) {
    return jti ? this.revokedSessionJtis.has(jti) : false;
  }

  async createChallenge({ userId, proposito, canal, destino = null, codigoRaw, expiraEn }) {
    const id = ulid();
    const res = await this.pool.query(
      `INSERT INTO verification_challenge (id, user_id, proposito, canal, destino_hmac, destino_cifrado, codigo_hash, expira_en)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        id,
        userId,
        proposito,
        canal,
        destino ? this._hmac(destino) : null,
        destino ? this._enc(destino) : null,
        sha256Hex(codigoRaw),
        toIso(expiraEn),
      ]
    );
    return { ...res.rows[0], _destino_plain: destino };
  }

  async confirmEmailChallenge(rawToken, now = new Date()) {
    const hash = sha256Hex(rawToken);
    return withTx(this.pool, async (client) => {
      const chRes = await client.query(
        `SELECT * FROM verification_challenge WHERE proposito = 'verify_email' AND codigo_hash = $1 FOR UPDATE`,
        [hash]
      );
      if (chRes.rowCount === 0) throw new AppError("TOKEN_INVALIDO", "Token inválido");
      const ch = chRes.rows[0];
      if (ch.verificado_en) return { email_verificado: true, user_id: ch.user_id };
      if (new Date(ch.expira_en) <= new Date(now)) {
        throw new AppError("TOKEN_EXPIRADO", "Token de verificación expirado");
      }
      const nowIso = toIso(now);
      await client.query(`UPDATE verification_challenge SET verificado_en = $2 WHERE id = $1`, [ch.id, nowIso]);
      await client.query(
        `UPDATE "user" SET email_verificado_en = COALESCE(email_verificado_en, $2) WHERE id = $1`,
        [ch.user_id, nowIso]
      );
      await client.query(
        `UPDATE worker_profile SET email_verificado_en = COALESCE(email_verificado_en, $2) WHERE user_id = $1`,
        [ch.user_id, nowIso]
      );
      return { email_verificado: true, user_id: ch.user_id };
    });
  }

  async confirmPasswordReset(rawToken, newPasswordHash, now = new Date()) {
    const hash = sha256Hex(rawToken);
    return withTx(this.pool, async (client) => {
      const chRes = await client.query(
        `SELECT * FROM verification_challenge WHERE proposito = 'password_reset' AND codigo_hash = $1 FOR UPDATE`,
        [hash]
      );
      if (chRes.rowCount === 0) throw new AppError("TOKEN_INVALIDO", "Token inválido");
      const ch = chRes.rows[0];
      if (ch.verificado_en) return { reset: true };
      if (new Date(ch.expira_en) <= new Date(now)) {
        throw new AppError("TOKEN_EXPIRADO", "Token expirado");
      }
      await client.query(`UPDATE verification_challenge SET verificado_en = $2 WHERE id = $1`, [ch.id, toIso(now)]);
      await client.query(`UPDATE "user" SET password_hash = $2 WHERE id = $1`, [ch.user_id, newPasswordHash]);
      return { reset: true };
    });
  }

  async assertPhoneAvailableForVerification(phoneE164, excludeWorkerId = null) {
    const res = await this.pool.query(
      `SELECT id FROM worker_profile
        WHERE telefono_hmac = $1
          AND telefono_verificado_en IS NOT NULL
          AND deleted_at IS NULL
          AND ($2::char(26) IS NULL OR id <> $2)`,
      [this._hmac(phoneE164), excludeWorkerId]
    );
    if (res.rowCount > 0) {
      throw new AppError("TELEFONO_YA_REGISTRADO", "El teléfono ya respalda otro perfil verificado");
    }
  }

  async confirmOtpChallenge({ userId, challengeId, codigoOtp, now = new Date() }) {
    return withTx(this.pool, async (client) => {
      const chRes = await client.query(
        `SELECT * FROM verification_challenge WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [challengeId, userId]
      );
      if (chRes.rowCount === 0) throw new AppError("NOT_FOUND", "Desafío no encontrado");
      const ch = chRes.rows[0];
      if (new Date(ch.expira_en) <= new Date(now)) {
        throw new AppError("TOKEN_EXPIRADO", "Código OTP expirado");
      }
      if (!ch.verificado_en) {
        if (ch.codigo_hash !== sha256Hex(String(codigoOtp || "").trim())) {
          await client.query(`UPDATE verification_challenge SET intentos = intentos + 1 WHERE id = $1`, [ch.id]);
          throw validationError("Código OTP incorrecto", "codigo_otp");
        }
        const nowIso = toIso(now);
        await client.query(`UPDATE verification_challenge SET verificado_en = $2 WHERE id = $1`, [ch.id, nowIso]);
        if (ch.canal === "sms") {
          const dup = await client.query(
            `SELECT id FROM worker_profile
              WHERE telefono_hmac = $1 AND telefono_verificado_en IS NOT NULL AND deleted_at IS NULL AND user_id <> $2`,
            [ch.destino_hmac, userId]
          );
          if (dup.rowCount > 0) {
            throw new AppError("TELEFONO_YA_REGISTRADO", "El teléfono ya respalda otro perfil verificado");
          }
          await client.query(
            `UPDATE worker_profile
                SET telefono_verificado_en = $2,
                    telefono_hmac = COALESCE($3, telefono_hmac),
                    telefono_cifrado = COALESCE($4, telefono_cifrado)
              WHERE user_id = $1`,
            [userId, nowIso, ch.destino_hmac, ch.destino_cifrado]
          );
        } else {
          await client.query(`UPDATE "user" SET email_verificado_en = COALESCE(email_verificado_en, $2) WHERE id = $1`, [
            userId,
            nowIso,
          ]);
          await client.query(
            `UPDATE worker_profile SET email_verificado_en = COALESCE(email_verificado_en, $2) WHERE user_id = $1`,
            [userId, nowIso]
          );
        }
      }
      const wpRes = await client.query(
        `SELECT estado, email_verificado_en, telefono_verificado_en, deleted_at FROM worker_profile WHERE user_id = $1`,
        [userId]
      );
      const wp = wpRes.rows[0];
      const visible = Boolean(
        wp && wp.estado === "publicado" && wp.email_verificado_en && wp.telefono_verificado_en && !wp.deleted_at
      );
      return { verificado: true, visible_en_busqueda: visible };
    });
  }

  // ==========================================================================
  // Venues, Eventos, Membresías y Staff
  // ==========================================================================
  async createVenue({ nombre, zona, direccion }) {
    if (!nombre || String(nombre).trim().length === 0 || String(nombre).trim().length > 120) {
      throw validationError("nombre inválido", "nombre");
    }
    if (!isValidZona(zona)) throw validationError(`zona inválida: ${zona}`, "zona");
    if (!direccion || String(direccion).trim().length === 0 || String(direccion).trim().length > 240) {
      throw validationError("dirección inválida", "direccion");
    }
    const res = await this.pool.query(
      `INSERT INTO venue (id, nombre, zona, direccion) VALUES ($1, $2, $3, $4) RETURNING *`,
      [ulid(), String(nombre).trim(), zona, String(direccion).trim()]
    );
    return res.rows[0];
  }

  async listVenues({ limit = 20, cursor = null } = {}) {
    const res = await this.pool.query(`SELECT * FROM venue WHERE deleted_at IS NULL ORDER BY created_at DESC`);
    return paginateArray(res.rows, limit, cursor);
  }

  async createEvent({ userId, nombre, fecha, timezone, ventana, venueId, aforo, requerimientos = [] }) {
    if (!nombre || !String(nombre).trim()) throw validationError("nombre es obligatorio", "nombre");
    if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(String(fecha))) {
      throw validationError("fecha es obligatoria", "fecha");
    }
    if (!timezone || !isValidIanaTimezone(timezone)) {
      throw validationError("timezone IANA es obligatoria", "timezone");
    }
    if (!ventana?.inicio || !ventana?.fin) throw validationError("ventana es obligatoria", "ventana");
    if (!venueId) throw validationError("venue_id es obligatorio", "venue_id");
    const aforoNum = Number(aforo);
    if (!Number.isInteger(aforoNum) || aforoNum <= 0) throw validationError("aforo inválido", "aforo");

    return withTx(this.pool, async (client) => {
      const vRes = await client.query(`SELECT * FROM venue WHERE id = $1 AND deleted_at IS NULL`, [venueId]);
      if (vRes.rowCount === 0) throw new AppError("NOT_FOUND", "Venue no encontrado");
      const venue = vRes.rows[0];

      const eventId = ulid();
      const evRes = await client.query(
        `INSERT INTO event (id, venue_id, nombre, fecha, timezone, ventana_inicio, ventana_fin, aforo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [eventId, venueId, String(nombre).trim(), fecha, timezone, ventana.inicio, ventana.fin, aforoNum]
      );
      const ev = evRes.rows[0];

      await client.query(
        `INSERT INTO event_membership (id, event_id, user_id, rol) VALUES ($1, $2, $3, 'owner')`,
        [ulid(), eventId, userId]
      );

      for (const req of requerimientos || []) {
        await client.query(
          `INSERT INTO event_requirement (id, event_id, rol, cantidad) VALUES ($1, $2, $3, $4)`,
          [ulid(), eventId, req.rol, Number(req.cantidad)]
        );
      }

      await client.query(`INSERT INTO event_counters (event_id) VALUES ($1)`, [eventId]);

      return {
        id: ev.id,
        estado: ev.estado,
        nombre: ev.nombre,
        fecha: toIso(ev.fecha).slice(0, 10),
        timezone: ev.timezone,
        ventana: { inicio: toIso(ev.ventana_inicio), fin: toIso(ev.ventana_fin) },
        aforo: ev.aforo,
        membership: { user_id: userId, rol: "owner" },
        venue: { id: venue.id, nombre: venue.nombre, zona: venue.zona, direccion: venue.direccion },
        requerimientos: requerimientos || [],
        created_at: toIso(ev.created_at),
      };
    });
  }

  async listEventsForUser({ userId, limit = 20, cursor = null }) {
    const res = await this.pool.query(
      `SELECT e.*, v.nombre AS venue_nombre, v.zona AS venue_zona, v.direccion AS venue_direccion
         FROM event e
         JOIN event_membership em ON em.event_id = e.id AND em.user_id = $1 AND em.deleted_at IS NULL
         JOIN venue v ON v.id = e.venue_id
        WHERE e.deleted_at IS NULL
        ORDER BY e.created_at DESC`,
      [userId]
    );
    const items = res.rows.map((r) => ({
      id: r.id,
      nombre: r.nombre,
      fecha: toIso(r.fecha).slice(0, 10),
      timezone: r.timezone,
      ventana: { inicio: toIso(r.ventana_inicio), fin: toIso(r.ventana_fin) },
      aforo: r.aforo,
      estado: r.estado,
      cerrado_en: toIso(r.cerrado_en),
      venue: { id: r.venue_id, nombre: r.venue_nombre, zona: r.venue_zona, direccion: r.venue_direccion },
      created_at: toIso(r.created_at),
    }));
    return paginateArray(items, limit, cursor);
  }

  async authorizeEventAccess({
    userId = null,
    eventId,
    requiredMembershipRoles = null,
    allowStaffPermiso = null,
    scanSessionAuth = null,
    allowClosedReplay = false,
    now = new Date(),
  }) {
    const evRes = await this.pool.query(`SELECT * FROM event WHERE id = $1 AND deleted_at IS NULL`, [eventId]);
    const ev = evRes.rows[0];

    if (scanSessionAuth) {
      if (scanSessionAuth.event_id !== eventId || !ev) {
        throw new AppError("NOT_FOUND", "Evento no encontrado");
      }
      if (ev.estado === "cancelado") {
        throw new AppError("FORBIDDEN_EVENT_SCOPE", "El evento fue cancelado");
      }
      const sRes = await this.pool.query(`SELECT * FROM scan_session WHERE id = $1`, [scanSessionAuth.session_id]);
      const sess = sRes.rows[0];
      const closedReplayGrace =
        allowClosedReplay &&
        ev.estado === "cerrado" &&
        ev.cerrado_en &&
        new Date(now).getTime() <= new Date(ev.cerrado_en).getTime() + 24 * 60 * 60 * 1000;
      if (!sess || sess.deleted_at || (!closedReplayGrace && new Date(sess.expira_en) <= new Date(now))) {
        throw new AppError("FORBIDDEN_EVENT_SCOPE", "Sesión de escaneo expirada o revocada");
      }
      return { event: ev, scanSession: sess };
    }

    if (!userId) throw new AppError("AUTH_REQUIRED", "Autenticación requerida");
    if (!ev) throw new AppError("NOT_FOUND", "Evento no encontrado");

    const memRes = await this.pool.query(
      `SELECT * FROM event_membership WHERE event_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [eventId, userId]
    );
    const mem = memRes.rows[0];
    if (mem && !mem.deleted_at) {
      if (requiredMembershipRoles && !requiredMembershipRoles.includes(mem.rol)) {
        throw new AppError("FORBIDDEN_EVENT_SCOPE", "Se requiere rol owner");
      }
      return { event: ev, membership: mem };
    }

    const saRes = await this.pool.query(
      `SELECT * FROM staff_assignment WHERE event_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [eventId, userId]
    );
    const sa = saRes.rows[0];
    if (allowStaffPermiso && sa) {
      if (sa.deleted_at || new Date(sa.expira_en) <= new Date(now) || !sa.permisos.includes(allowStaffPermiso)) {
        throw new AppError("FORBIDDEN_EVENT_SCOPE", "Permiso de escaneo revocado o expirado");
      }
      return { event: ev, staffAssignment: sa };
    }

    if ((mem && mem.deleted_at) || sa) {
      throw new AppError("FORBIDDEN_EVENT_SCOPE", "Acceso al evento revocado o expirado");
    }
    throw new AppError("NOT_FOUND", "Evento no encontrado");
  }

  async getEventDetail({ eventId }) {
    const res = await this.pool.query(
      `SELECT e.*, v.nombre AS venue_nombre, v.zona AS venue_zona, v.direccion AS venue_direccion
         FROM event e JOIN venue v ON v.id = e.venue_id
        WHERE e.id = $1 AND e.deleted_at IS NULL`,
      [eventId]
    );
    if (res.rowCount === 0) throw new AppError("NOT_FOUND", "Evento no encontrado");
    const r = res.rows[0];
    const reqs = await this.getEventRequirements({ eventId });
    return {
      id: r.id,
      nombre: r.nombre,
      fecha: toIso(r.fecha).slice(0, 10),
      timezone: r.timezone,
      ventana: { inicio: toIso(r.ventana_inicio), fin: toIso(r.ventana_fin) },
      aforo: r.aforo,
      estado: r.estado,
      cerrado_en: toIso(r.cerrado_en),
      venue: { id: r.venue_id, nombre: r.venue_nombre, zona: r.venue_zona, direccion: r.venue_direccion },
      requerimientos: reqs.items,
      created_at: toIso(r.created_at),
    };
  }

  async _computeCorte(client, eventId) {
    const invRes = await client.query(
      `SELECT count(*)::integer AS c FROM guest WHERE event_id = $1 AND deleted_at IS NULL`,
      [eventId]
    );
    const confRes = await client.query(
      `SELECT count(*)::integer AS c
         FROM rsvp_response
        WHERE event_id = $1 AND superseded_at IS NULL AND respuesta = 'confirma'`,
      [eventId]
    );
    const chkRes = await client.query(
      `SELECT count(DISTINCT invitation_id)::integer AS asistentes,
              count(DISTINCT invitation_id) FILTER (WHERE tardio = true)::integer AS tardios
         FROM checkin_event c
        WHERE c.event_id = $1
          AND c.kind = 'admitido'
          AND NOT EXISTS (
            SELECT 1 FROM checkin_event a
             WHERE a.event_id = $1 AND a.kind = 'anulacion' AND a.anula_a = c.id
          )`,
      [eventId]
    );
    const invitados = invRes.rows[0]?.c || 0;
    const confirmados = confRes.rows[0]?.c || 0;
    const asistentes = chkRes.rows[0]?.asistentes || 0;
    const tardios = chkRes.rows[0]?.tardios || 0;
    return {
      invitados,
      confirmados,
      asistentes,
      tardios,
      no_show: Math.max(invitados - asistentes, 0),
    };
  }

  async transitionEvent({ eventId, targetState, actorId, motivo = "cambio de estado", now = new Date() }) {
    return withTx(this.pool, async (client) => {
      const evRes = await client.query(`SELECT * FROM event WHERE id = $1 FOR UPDATE`, [eventId]);
      if (evRes.rowCount === 0) throw new AppError("NOT_FOUND", "Evento no encontrado");
      const ev = evRes.rows[0];
      const nowIso = toIso(now);

      if (ev.estado === targetState) {
        if (targetState === "cerrado") {
          const corte = await this._computeCorte(client, eventId);
          return { id: ev.id, estado: ev.estado, cerrado_en: toIso(ev.cerrado_en), corte };
        }
        return { id: ev.id, estado: ev.estado };
      }

      if (targetState === "cerrado") {
        await client.query(`UPDATE event SET estado = 'cerrado', cerrado_en = $2 WHERE id = $1`, [eventId, nowIso]);
        await client.query(
          `UPDATE event_access_token SET expira_en = $2 WHERE event_id = $1 AND deleted_at IS NULL`,
          [eventId, nowIso]
        );
        await client.query(
          `UPDATE staff_assignment SET expira_en = $2 WHERE event_id = $1 AND deleted_at IS NULL`,
          [eventId, nowIso]
        );
        await client.query(
          `UPDATE scan_session SET expira_en = $2 WHERE event_id = $1 AND deleted_at IS NULL`,
          [eventId, nowIso]
        );
        const noShowRes = await client.query(
          `SELECT count(*)::integer AS c
             FROM worker_reservation
            WHERE event_id = $1 AND estado = 'aceptada' AND llegada_registrada_en IS NULL AND deleted_at IS NULL`,
          [eventId]
        );
        const noShows = noShowRes.rows[0]?.c || 0;
        if (noShows > 0 && this.metrics) {
          this.metrics.providerNoShow(eventId, noShows);
        }
        const updRes = await client.query(
          `UPDATE worker_reservation SET estado = 'completada'
            WHERE event_id = $1 AND estado = 'aceptada' AND deleted_at IS NULL`,
          [eventId]
        );
        const corte = await this._computeCorte(client, eventId);
        await this._insertAudit(client, {
          eventId,
          actorId,
          accion: "evento_cerrado",
          entidad: "event",
          entidadId: eventId,
          motivo,
          ts: nowIso,
          detalle: { reservas_completadas: updRes.rowCount },
        });
        return {
          id: eventId,
          estado: "cerrado",
          cerrado_en: nowIso,
          corte,
          reservas_completadas: updRes.rowCount,
        };
      }

      try {
        await client.query(`UPDATE event SET estado = $2 WHERE id = $1`, [eventId, targetState]);
      } catch (err) {
        throw new AppError("EVENT_STATE_INVALID", err.message);
      }
      if (targetState === "cancelado") {
        await client.query(`UPDATE event SET cancelado_motivo = $2 WHERE id = $1`, [eventId, motivo || null]);
        await client.query(
          `UPDATE event_access_token SET expira_en = $2 WHERE event_id = $1 AND deleted_at IS NULL`,
          [eventId, nowIso]
        );
        await client.query(
          `UPDATE staff_assignment SET expira_en = $2 WHERE event_id = $1 AND deleted_at IS NULL`,
          [eventId, nowIso]
        );
        await client.query(
          `UPDATE scan_session SET expira_en = $2 WHERE event_id = $1 AND deleted_at IS NULL`,
          [eventId, nowIso]
        );
        await client.query(
          `UPDATE reminder_job
              SET estado = 'cancelado', motivo_cancelacion = 'reserva_cancelada'
            WHERE event_id = $1 AND estado = 'programado'`,
          [eventId]
        );
      }
      return { id: eventId, estado: targetState };
    });
  }

  async addEventEditor({ eventId, targetUserId = null, targetEmail = null, rol = "editor" }) {
    if (rol !== "editor") throw validationError("rol debe ser editor", "rol");
    const u = targetUserId ? await this.findUserById(targetUserId) : await this.findUserByEmail(targetEmail);
    if (!u || u.deleted_at) throw new AppError("NOT_FOUND", "Usuario no encontrado");

    const res = await this.pool.query(
      `INSERT INTO event_membership (id, event_id, user_id, rol)
       VALUES ($1, $2, $3, 'editor')
       ON CONFLICT (event_id, user_id) DO UPDATE
         SET deleted_at = NULL, rol = CASE WHEN event_membership.rol = 'owner' THEN 'owner' ELSE 'editor' END
       RETURNING *`,
      [ulid(), eventId, u.id]
    );
    return { membership_id: res.rows[0].id, event_id: eventId, user_id: u.id, rol: res.rows[0].rol };
  }

  async removeEventEditor({ eventId, targetUserId }) {
    const res = await this.pool.query(
      `UPDATE event_membership SET deleted_at = now()
        WHERE event_id = $1 AND user_id = $2 AND rol <> 'owner' AND deleted_at IS NULL`,
      [eventId, targetUserId]
    );
    if (res.rowCount === 0) throw new AppError("NOT_FOUND", "Membresía editor no encontrada");
  }

  async listEventMembers({ eventId, limit = 20, cursor = null }) {
    const res = await this.pool.query(
      `SELECT em.id AS membership_id, em.user_id, em.rol, em.created_at, u.email_cifrado
         FROM event_membership em JOIN "user" u ON u.id = em.user_id
        WHERE em.event_id = $1 AND em.deleted_at IS NULL`,
      [eventId]
    );
    const items = res.rows.map((r) => ({
      membership_id: r.membership_id,
      user_id: r.user_id,
      email: this._dec(r.email_cifrado),
      rol: r.rol,
      created_at: toIso(r.created_at),
    }));
    return paginateArray(items, limit, cursor);
  }

  async grantStaffAssignment({ eventId, userId, permisos = ["roster", "checkin"], grantedByUserId, now = new Date() }) {
    const validPermisos = ["roster", "checkin", "anulacion"];
    if (!Array.isArray(permisos) || permisos.length === 0 || !permisos.every((p) => validPermisos.includes(p))) {
      throw validationError("permisos inválidos", "permisos");
    }
    const userRes = await this.pool.query(`SELECT id FROM "user" WHERE id = $1 AND deleted_at IS NULL`, [userId]);
    if (userRes.rowCount === 0) throw new AppError("NOT_FOUND", "Usuario destino no encontrado");
    const ev = await this._assertEventOpenForAccess(eventId, now);
    const nowIso = toIso(now);
    const uniquePermisos = [...new Set(permisos)];
    return withTx(this.pool, async (client) => {
      const res = await client.query(
        `INSERT INTO staff_assignment (id, event_id, user_id, permisos, otorgado_por_user_id, expira_en, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
         ON CONFLICT (event_id, user_id) WHERE deleted_at IS NULL DO UPDATE
           SET permisos = EXCLUDED.permisos, otorgado_por_user_id = EXCLUDED.otorgado_por_user_id,
               expira_en = EXCLUDED.expira_en
         RETURNING *, (xmax = 0) AS inserted`,
        [ulid(), eventId, userId, uniquePermisos, grantedByUserId, toIso(ev.ventana_fin), nowIso]
      );
      const row = res.rows[0];
      if (row.inserted) {
        await this._insertAudit(client, {
          eventId,
          actorId: grantedByUserId,
          accion: "acceso_otorgado",
          entidad: "staff_assignment",
          entidadId: row.id,
          motivo: "Habilitación de escaneo en evento",
          ts: nowIso,
          detalle: { target_user_id: userId, permisos: row.permisos },
        });
      }
      return {
        staff_assignment_id: row.id,
        event_id: eventId,
        user_id: userId,
        permisos: row.permisos,
        expira_en: toIso(row.expira_en),
      };
    });
  }

  async createEventAccessToken({ eventId, rol, emittedByUserId, now = new Date() }) {
    if (!isValidRol(rol)) throw validationError(`rol inválido: ${rol}`, "rol");
    const ev = await this._assertEventOpenForAccess(eventId, now);
    const rawToken = generateOpaqueToken("evtqr_");
    const nowIso = toIso(now);
    const res = await this.pool.query(
      `INSERT INTO event_access_token (id, event_id, rol, token_hash, emitido_por_user_id, expira_en, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING *`,
      [ulid(), eventId, rol, sha256Hex(rawToken), emittedByUserId, toIso(ev.ventana_fin), nowIso]
    );
    return {
      access_token_id: res.rows[0].id,
      event_id: eventId,
      rol,
      qr_token: rawToken,
      expira_en: toIso(res.rows[0].expira_en),
    };
  }

  /** Accesos de staff/QR solo para eventos vivos cuya ventana no ha terminado (RF-19). */
  async _assertEventOpenForAccess(eventId, now) {
    const evRes = await this.pool.query(
      `SELECT ventana_fin, estado FROM event WHERE id = $1 AND deleted_at IS NULL`,
      [eventId]
    );
    if (evRes.rowCount === 0) throw new AppError("NOT_FOUND", "Evento no encontrado");
    const ev = evRes.rows[0];
    if (ev.estado === "cerrado" || ev.estado === "cancelado") {
      throw new AppError("EVENT_STATE_INVALID", "Evento cerrado o cancelado");
    }
    if (new Date(ev.ventana_fin).getTime() <= new Date(now).getTime()) {
      throw validationError("La ventana del evento ya finalizó", "expira_en");
    }
    return ev;
  }

  async exchangeEventAccessToken({ rawToken, deviceId, now = new Date() }) {
    const res = await this.pool.query(
      `SELECT eat.*, e.estado FROM event_access_token eat JOIN event e ON e.id = eat.event_id
        WHERE eat.token_hash = $1 AND eat.deleted_at IS NULL`,
      [sha256Hex(rawToken)]
    );
    if (res.rowCount === 0) throw new AppError("AUTH_REQUIRED", "Token inválido");
    const tok = res.rows[0];
    if (new Date(tok.expira_en) <= new Date(now) || tok.estado === "cerrado" || tok.estado === "cancelado") {
      throw new AppError("AUTH_REQUIRED", "Token expirado o evento cerrado");
    }
    const sess = await this.createOrGetScanSession({
      eventId: tok.event_id,
      deviceId,
      accessTokenId: tok.id,
      rol: tok.rol,
      expiraEn: toIso(tok.expira_en),
    });
    return {
      session_id: sess.session_id,
      event_id: tok.event_id,
      rol: tok.rol,
      expira_en: toIso(tok.expira_en),
      access_token_id: tok.id,
      actor_id: tok.emitido_por_user_id,
    };
  }

  async replaceEventRequirements({ eventId, requerimientos }) {
    await withTx(this.pool, async (client) => {
      const roles = requerimientos.map((r) => r.rol);
      await client.query(
        `UPDATE event_requirement SET deleted_at = now()
          WHERE event_id = $1 AND deleted_at IS NULL AND NOT (rol = ANY($2::text[]))`,
        [eventId, roles]
      );
      for (const r of requerimientos) {
        await client.query(
          `INSERT INTO event_requirement (id, event_id, rol, cantidad)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (event_id, rol) DO UPDATE SET cantidad = EXCLUDED.cantidad, deleted_at = NULL`,
          [ulid(), eventId, r.rol, Number(r.cantidad)]
        );
      }
    });
    // Lectura después del COMMIT (otra conexión del pool no ve la tx abierta).
    const { items, cobertura } = await this.getEventRequirements({ eventId });
    return { requerimientos: items, cobertura };
  }

  async getEventRequirements({ eventId }) {
    const res = await this.pool.query(
      `SELECT id, rol, cantidad FROM event_requirement WHERE event_id = $1 AND deleted_at IS NULL`,
      [eventId]
    );
    const covRes = await this.pool.query(
      `SELECT rol,
              COALESCE(sum(plazas) FILTER (WHERE estado IN ('aceptada','completada')), 0)::integer AS cubiertos,
              COALESCE(sum(plazas) FILTER (WHERE estado = 'sin_cubrir'), 0)::integer AS sin_cubrir
         FROM worker_reservation
        WHERE event_id = $1 AND deleted_at IS NULL
        GROUP BY rol`,
      [eventId]
    );
    const covMap = new Map(covRes.rows.map((r) => [r.rol, r]));
    let totalReq = 0;
    let totalCov = 0;
    let totalSinCubrir = 0;
    const porRol = res.rows.map((r) => {
      const cov = covMap.get(r.rol);
      const cub = cov?.cubiertos || 0;
      const sinCubrirCount = cov?.sin_cubrir || 0;
      totalReq += r.cantidad;
      totalCov += Math.min(cub, r.cantidad);
      totalSinCubrir += sinCubrirCount;
      return {
        rol: r.rol,
        cantidad: r.cantidad,
        cubiertos: cub,
        pendientes: Math.max(r.cantidad - cub, 0),
        sin_cubrir: sinCubrirCount > 0,
      };
    });
    return {
      items: res.rows,
      next_cursor: null,
      cobertura: {
        cubiertos: totalCov,
        pendientes: Math.max(totalReq - totalCov, 0),
        sin_cubrir: totalSinCubrir,
        por_rol: porRol,
      },
    };
  }

  // ==========================================================================
  // Invitados e Import Masivo
  // ==========================================================================
  async getGuestAforoStatus(eventId) {
    const res = await this.pool.query(
      `SELECT e.aforo, (SELECT count(*)::integer FROM guest g WHERE g.event_id = e.id) AS ocupado
         FROM event e WHERE e.id = $1`,
      [eventId]
    );
    if (res.rowCount === 0) throw new AppError("NOT_FOUND", "Evento no encontrado");
    return { limite: res.rows[0].aforo, ocupado: res.rows[0].ocupado };
  }

  async createImportJob({ eventId, s3Key, fileHash, totalFilas }) {
    const res = await this.pool.query(
      `INSERT INTO import_job (id, event_id, s3_key, file_hash, total_filas)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [ulid(), eventId, s3Key, fileHash, totalFilas]
    );
    return res.rows[0];
  }

  async getImportJob({ eventId, importId }) {
    const res = await this.pool.query(
      `SELECT * FROM import_job WHERE id = $1 AND event_id = $2`,
      [importId, eventId]
    );
    if (res.rowCount === 0) throw new AppError("NOT_FOUND", "ImportJob no encontrado");
    const j = res.rows[0];
    const aforo = await this.getGuestAforoStatus(eventId);
    return {
      import_id: j.id,
      estado: j.estado,
      progreso: Number(j.progreso),
      total_filas: j.total_filas,
      aceptadas: j.aceptadas,
      rechazadas: j.rechazadas,
      duplicadas_en_archivo: j.duplicadas_en_archivo,
      errores: j.errores,
      error_code: j.error_code,
      aforo,
    };
  }

  /**
   * Import de invitados (RF-02, NFR FR1: 1 000 en < 30 s; hasta 20 000 filas).
   *
   * Diseño para que escale en AWS, donde firmar un QR es una llamada a KMS y subir el PNG un PUT a S3:
   *   1. Dentro de la tx (bajo lock por evento): clasificar filas, validar aforo, firmar los QR con
   *      concurrencia acotada e insertar invitados e invitaciones EN LOTE (`unnest`, 2 consultas por
   *      cada 1 000 filas en lugar de 2 por fila).
   *   2. Después del COMMIT: generar y subir los PNG en paralelo con reintentos. El PNG es un
   *      derivado cacheable del token (la invitación también puede dibujar el QR desde el token), así
   *      que no retiene locks ni bloquea el import.
   */
  async executeImportBatch({
    importId,
    eventId,
    parsedRows,
    qrSigner,
    objectStorage,
    assetsBucket = process.env.ASSETS_BUCKET || "orquesta-assets",
  }) {
    const concurrency = Number(process.env.IMPORT_SIGN_CONCURRENCY || 16);
    const createdQrs = [];
    const outcome = await withTx(this.pool, async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 1))`, [eventId]);
      const evRes = await client.query(`SELECT * FROM event WHERE id = $1 FOR UPDATE`, [eventId]);
      if (evRes.rowCount === 0) throw new AppError("NOT_FOUND", "Evento no encontrado");
      const ev = evRes.rows[0];

      const existingRes = await client.query(
        `SELECT id, email_hmac, telefono_hmac, deleted_at FROM guest WHERE event_id = $1`,
        [eventId]
      );
      const codeRes = await client.query(
        `SELECT codigo_corto FROM invitation WHERE event_id = $1`,
        [eventId]
      );
      const usedShortCodes = new Set(codeRes.rows.map((r) => r.codigo_corto));
      const byEmail = new Map();
      const byPhone = new Map();
      for (const g of existingRes.rows) {
        if (g.email_hmac) byEmail.set(g.email_hmac, g);
        if (g.telefono_hmac) byPhone.set(g.telefono_hmac, g);
      }

      const seenInFile = new Set();
      const errores = [];
      const toCreate = [];
      const toReactivate = [];
      let rechazadas = 0;
      let duplicadas = 0;

      for (const row of parsedRows) {
        const res = validateAndNormalizeCsvRow(row);
        if (!res.valid) {
          rechazadas += 1;
          errores.push({ linea: row.linea, motivo: res.motivo });
          continue;
        }
        const eHmac = res.email ? this._hmac(res.email) : null;
        const pHmac = res.telefono ? this._hmac(res.telefono) : null;
        if ((eHmac && seenInFile.has(`e:${eHmac}`)) || (pHmac && seenInFile.has(`p:${pHmac}`))) {
          duplicadas += 1;
          errores.push({ linea: row.linea, motivo: IMPORT_ROW_ERRORS.GUEST_DUPLICADO });
          continue;
        }
        if (eHmac) seenInFile.add(`e:${eHmac}`);
        if (pHmac) seenInFile.add(`p:${pHmac}`);

        const existingGuest = (eHmac && byEmail.get(eHmac)) || (pHmac && byPhone.get(pHmac));
        if (existingGuest) {
          if (existingGuest.deleted_at) {
            toReactivate.push({ existingGuest, nombre: res.nombre });
          } else {
            duplicadas += 1;
            errores.push({ linea: row.linea, motivo: IMPORT_ROW_ERRORS.GUEST_DUPLICADO });
          }
          continue;
        }
        toCreate.push({ linea: row.linea, nombre: res.nombre, email: res.email, telefono: res.telefono });
      }

      const ocupado = existingRes.rowCount;
      if (ocupado + toCreate.length > ev.aforo) {
        const available = Math.max(ev.aforo - ocupado, 0);
        const overflow = toCreate.slice(available).map((r) => ({
          linea: r.linea,
          motivo: IMPORT_ROW_ERRORS.AFORO_EXCEDIDO,
        }));
        // Se CONFIRMA el estado `fallido` (0 invitados creados) y se lanza después del COMMIT;
        // lanzar aquí haría ROLLBACK del UPDATE y el job quedaría `en_proceso` para siempre.
        await client.query(
          `UPDATE import_job
              SET estado = 'fallido', progreso = 1.0, aceptadas = 0, rechazadas = $2,
                  duplicadas_en_archivo = $3, errores = $4::jsonb, error_code = 'AFORO_EXCEDIDO'
            WHERE id = $1`,
          [importId, rechazadas + toCreate.length, duplicadas, JSON.stringify([...errores, ...overflow])]
        );
        return { aforoExcedido: true };
      }

      if (toReactivate.length > 0) {
        const ids = toReactivate.map((r) => r.existingGuest.id);
        await client.query(
          `UPDATE guest g SET deleted_at = NULL, nombre = v.nombre, estado_envio = 'pendiente_envio'
             FROM unnest($1::char(26)[], $2::text[]) AS v(id, nombre)
            WHERE g.id = v.id`,
          [ids, toReactivate.map((r) => r.nombre)]
        );
        await client.query(
          `UPDATE invitation SET deleted_at = NULL, rsvp_revocado_en = NULL, checkin_revocado_en = NULL
            WHERE guest_id = ANY($1::char(26)[])`,
          [ids]
        );
      }

      const { key_id: activeKeyId } = await qrSigner.getPublicKey();
      const rows = toCreate.map((item) => {
        let code = generateShortCode();
        while (usedShortCodes.has(code)) code = generateShortCode();
        usedShortCodes.add(code);
        const invId = ulid();
        return {
          guestId: ulid(),
          invId,
          code,
          rsvpRaw: generateOpaqueToken("rsvp_", 24),
          qrS3Key: `qr/${invId}_v1.png`,
          ...item,
        };
      });
      // Firma con concurrencia acotada: en AWS cada firma es una llamada a KMS (cuota por segundo).
      const qrTokens = await mapWithConcurrency(rows, concurrency, (r) =>
        qrSigner.signJws(
          { typ: "checkin_qr", invitation_id: r.invId, event_id: eventId, token_version: 1, key_id: activeKeyId },
          activeKeyId
        )
      );

      for (let i = 0; i < rows.length; i += 1000) {
        const chunk = rows.slice(i, i + 1000);
        const tokens = qrTokens.slice(i, i + 1000);
        await client.query(
          `INSERT INTO guest (id, event_id, nombre, email_cifrado, email_hmac, telefono_cifrado, telefono_hmac, estado_envio)
           SELECT u.id, $1, u.nombre, u.email_cifrado, u.email_hmac, u.telefono_cifrado, u.telefono_hmac, 'pendiente_envio'
             FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
                  AS u(id, nombre, email_cifrado, email_hmac, telefono_cifrado, telefono_hmac)`,
          [
            eventId,
            chunk.map((r) => r.guestId),
            chunk.map((r) => r.nombre),
            chunk.map((r) => (r.email ? this._enc(r.email) : null)),
            chunk.map((r) => (r.email ? this._hmac(r.email) : null)),
            chunk.map((r) => (r.telefono ? this._enc(r.telefono) : null)),
            chunk.map((r) => (r.telefono ? this._hmac(r.telefono) : null)),
          ]
        );
        await client.query(
          `INSERT INTO invitation (id, event_id, guest_id, rsvp_token_hash, rsvp_token_cifrado, checkin_key_id,
                                   token_version, qr_token_cifrado, qr_s3_key, codigo_corto)
           SELECT u.id, $1, u.guest_id, u.rsvp_hash, u.rsvp_cifrado, $2, 1, u.qr_cifrado, u.qr_key, u.codigo
             FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[])
                  AS u(id, guest_id, rsvp_hash, rsvp_cifrado, qr_cifrado, qr_key, codigo)`,
          [
            eventId,
            activeKeyId,
            chunk.map((r) => r.invId),
            chunk.map((r) => r.guestId),
            chunk.map((r) => sha256Hex(r.rsvpRaw)),
            chunk.map((r) => this._enc(r.rsvpRaw)),
            tokens.map((t) => this._enc(t)),
            chunk.map((r) => r.qrS3Key),
            chunk.map((r) => r.code),
          ]
        );
      }
      rows.forEach((r, i) => createdQrs.push({ key: r.qrS3Key, token: qrTokens[i] }));

      const deltaInvitados = toCreate.length + toReactivate.length;
      if (deltaInvitados > 0) {
        await this._insertOutbox(client, {
          eventId,
          topic: "projection",
          eventType: "guests_imported",
          payload: { invitados_delta: deltaInvitados },
        });
      }

      await client.query(
        `UPDATE import_job
            SET estado = 'completado', progreso = 1.0, aceptadas = $2, rechazadas = $3,
                duplicadas_en_archivo = $4, errores = $5::jsonb
          WHERE id = $1`,
        [importId, deltaInvitados, rechazadas, duplicadas, JSON.stringify(errores)]
      );
      return { aforoExcedido: false };
    });

    if (outcome.aforoExcedido) {
      throw new AppError("AFORO_EXCEDIDO", "El import excede el aforo del evento");
    }

    // PNG del QR fuera de la transacción, en paralelo y con reintentos (best effort).
    let pngFallidos = 0;
    await mapWithConcurrency(createdQrs, concurrency, async ({ key, token }) => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const png = await renderQrPng(token);
          await objectStorage.putObject({
            bucket: assetsBucket,
            key,
            body: png,
            contentType: "image/png",
            cacheControl: "public, s-maxage=300, stale-while-revalidate=86400",
          });
          return;
        } catch (err) {
          if (attempt === 3) {
            pngFallidos += 1;
            console.error(JSON.stringify({ level: "error", msg: "qr_png_upload_failed", key, error: err?.message }));
          }
        }
      }
    });
    if (pngFallidos > 0 && this.metrics) {
      this.metrics.emit("qr_png_upload_failed", pngFallidos, "Count", { EventId: eventId });
    }

    // Lectura después del COMMIT (otra conexión del pool no ve la tx abierta).
    return this.getImportJob({ eventId, importId });
  }

  // ==========================================================================
  // Tablero, Outbox, Projector, Reservas y Pagos (PG)
  // ==========================================================================
  async fetchPendingOutbox(limit = 100) {
    const res = await this.pool.query(
      `SELECT * FROM outbox_event WHERE published_at IS NULL ORDER BY created_at ASC LIMIT $1`,
      [limit]
    );
    return res.rows;
  }

  async markOutboxPublished(ids, now = new Date()) {
    if (!ids || ids.length === 0) return;
    await this.pool.query(
      `UPDATE outbox_event SET published_at = $2 WHERE id = ANY($1::char(26)[]) AND published_at IS NULL`,
      [ids, toIso(now)]
    );
  }

  async applyProjectionBatch(messages, now = new Date()) {
    const nowIso = toIso(now);
    return withTx(this.pool, async (client) => {
      const grouped = new Map();
      for (const msg of messages) {
        const outboxId = msg.outbox_event_id || msg.id;
        if (outboxId) {
          const ins = await client.query(
            `INSERT INTO projector_applied (outbox_event_id, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [outboxId, msg.event_id]
          );
          if (ins.rowCount === 0) continue;
        }
        const evId = msg.event_id;
        if (!evId) continue;
        if (!grouped.has(evId)) {
          grouped.set(evId, { invitados: 0, confirmados: 0, asistentes: 0, entregasParcialesSet: null, maxT: null });
        }
        const acc = grouped.get(evId);
        const p = msg.payload || {};
        acc.invitados += Number(p.invitados_delta || 0);
        acc.confirmados += Number(p.confirmados_delta || 0);
        acc.asistentes += Number(p.asistentes_delta || 0);
        if (p.entregas_parciales_set !== undefined && p.entregas_parciales_set !== null) {
          acc.entregasParcialesSet = Number(p.entregas_parciales_set);
        }
        if (msg.t_ingest && (!acc.maxT || new Date(msg.t_ingest) > new Date(acc.maxT))) {
          acc.maxT = msg.t_ingest;
        }
      }

      for (const [eventId, d] of grouped.entries()) {
        await client.query(
          `INSERT INTO event_counters (event_id, invitados, confirmados, asistentes, aun_no_llegaron, entregas_parciales, ultimo_t_ingest, updated_at)
           VALUES ($1, GREATEST($2, 0), GREATEST($3, 0), GREATEST($4, 0), GREATEST($2 - $4, 0), COALESCE($5, 0), $6, $7)
           ON CONFLICT (event_id) DO UPDATE SET
             invitados = GREATEST(event_counters.invitados + $2, 0),
             confirmados = GREATEST(event_counters.confirmados + $3, 0),
             asistentes = GREATEST(event_counters.asistentes + $4, 0),
             aun_no_llegaron = GREATEST(GREATEST(event_counters.invitados + $2, 0) - GREATEST(event_counters.asistentes + $4, 0), 0),
             entregas_parciales = COALESCE($5, event_counters.entregas_parciales),
             ultimo_t_ingest = GREATEST(event_counters.ultimo_t_ingest, $6),
             updated_at = $7`,
          [eventId, d.invitados, d.confirmados, d.asistentes, d.entregasParcialesSet, d.maxT, nowIso]
        );
      }
      return { eventsUpdated: grouped.size };
    });
  }

  async getDashboard({ userId, limit = 25, cursor = null, now = new Date() }) {
    const limitNum = Number(limit);
    if (!Number.isInteger(limitNum) || limitNum < 1 || limitNum > 25) {
      throw validationError("limit en dashboard debe estar entre 1 y 25", "limit");
    }
    const res = await this.pool.query(
      `SELECT e.id AS event_id, e.nombre, e.estado, ec.*
         FROM event_membership em
         JOIN event e ON e.id = em.event_id
         LEFT JOIN event_counters ec ON ec.event_id = e.id
        WHERE em.user_id = $1 AND em.deleted_at IS NULL AND e.deleted_at IS NULL
        ORDER BY e.ventana_inicio ASC`,
      [userId]
    );
    const nowIso = toIso(now);
    const nowMs = new Date(now).getTime();
    const items = [];
    for (const row of res.rows) {
      const syncRes = await this.pool.query(
        `SELECT * FROM device_sync_state WHERE event_id = $1`,
        [row.event_id]
      );
      const pendientes = deriveSyncPendingState(syncRes.rows, nowMs);
      const tIngest = toIso(row.ultimo_t_ingest);
      const tVisible = toIso(row.updated_at) || nowIso;
      const lagMs = tIngest ? Math.max(0, new Date(tVisible).getTime() - new Date(tIngest).getTime()) : 0;
      const inv = Number(row.invitados || 0);
      const asi = Number(row.asistentes || 0);
      items.push({
        event_id: row.event_id,
        nombre: row.nombre,
        estado: row.estado,
        contadores: {
          invitados: inv,
          confirmados: Number(row.confirmados || 0),
          asistentes: asi,
          aun_no_llegaron: Math.max(inv - asi, 0),
          pendientes_sincronizar: pendientes.valor,
          entregas_parciales: Number(row.entregas_parciales || 0),
        },
        no_show: row.estado === "cerrado" ? Math.max(inv - asi, 0) : null,
        pendientes,
        frescura: { t_ingest: tIngest, t_visible: tVisible, lag_ms: lagMs, lag_p95_ms: lagMs },
      });
    }
    const paged = paginateArray(items, limitNum, cursor, 25);
    return { generado_en: nowIso, next_cursor: paged.next_cursor, items: paged.items };
  }

  async acceptWorkerReservation({ userId, reservationId, plazas = null, now = new Date() }) {
    const accepted = await withTx(this.pool, async (client) => {
      const wpRes = await client.query(
        `SELECT wp.id, wp.telefono_cifrado, u.email_cifrado
           FROM worker_profile wp
           JOIN "user" u ON u.id = wp.user_id
          WHERE wp.user_id = $1 AND wp.deleted_at IS NULL`,
        [userId]
      );
      if (wpRes.rowCount === 0) throw new AppError("NOT_FOUND", "Perfil no encontrado");
      const wpRow = wpRes.rows[0];
      const workerId = wpRow.id;
      try {
        const res = await client.query(
          `SELECT * FROM aceptar_worker_reservation($1, $2, $3, $4)`,
          [reservationId, workerId, plazas, toIso(now)]
        );
        const row = res.rows[0];

        const wrRes = await client.query(`SELECT event_id, hora_llegada FROM worker_reservation WHERE id = $1`, [
          reservationId,
        ]);
        const wr = wrRes.rows[0];
        if (wr && wr.hora_llegada) {
          const arrivalTimes = computeReminderTimes(wr.hora_llegada);
          const phone = wpRow.telefono_cifrado ? this._dec(wpRow.telefono_cifrado) : null;
          const email = wpRow.email_cifrado ? this._dec(wpRow.email_cifrado) : null;
          const channels = [
            { canal: "sms", addr: phone },
            { canal: "email", addr: email },
          ];
          for (const ch of channels) {
            if (!ch.addr) continue;
            for (const ventana of ["t_24h", "t_2h"]) {
              const dest = buildTr12Destinatario(workerId, ch.addr, ch.canal);
              await client.query(
                `INSERT INTO reminder_job
                   (id, event_id, worker_reservation_id, destinatario, direccion_cifrada, canal, plantilla, ventana, disparar_en, estado)
                 VALUES ($1, $2, $3, $4, $5, $6, 'recordatorio_llegada', $7, $8, 'programado')
                 ON CONFLICT (destinatario, plantilla, ventana) DO NOTHING`,
                [ulid(), wr.event_id, reservationId, dest, this._enc(ch.addr), ch.canal, ventana, arrivalTimes[ventana]]
              );
            }
          }
        }

        return row;
      } catch (err) {
        const mapped = mapPgError(err);
        if (mapped?.code === "RESERVATION_OVERLAP" && this.metrics) {
          this.metrics.reservationConflicts(workerId);
        }
        throw mapped;
      }
    });

    // Respuesta completa del contrato (03b §accept) leída después del COMMIT.
    const wrRes = await this.pool.query(`SELECT * FROM worker_reservation WHERE id = $1`, [reservationId]);
    const wr = wrRes.rows[0];
    const { cobertura } = await this.getEventRequirements({ eventId: wr.event_id });
    return {
      reservation_id: accepted.reservation_id,
      estado: accepted.estado,
      plazas_solicitadas: wr.plazas_solicitadas,
      plazas_aceptadas: accepted.plazas_aceptadas,
      plazas_devueltas: accepted.plazas_devueltas,
      costo_congelado: {
        modo: wr.costo_congelado_modo,
        monto: Number(wr.costo_congelado_monto),
        moneda: wr.costo_congelado_moneda,
        unidad: wr.costo_congelado_unidad,
      },
      ventana: { inicio: toIso(wr.inicio), fin: toIso(wr.fin) },
      hora_llegada: toIso(wr.hora_llegada),
      aceptada_en: toIso(accepted.aceptada_en),
      cobertura_requerimiento: cobertura.por_rol.find((r) => r.rol === wr.rol) || null,
    };
  }

  async processReservationPayment({ reservationId, eventId = null, paymentProvider, now = new Date() }) {
    const pre = await withTx(this.pool, async (client) => {
      const rRes = await client.query(`SELECT * FROM worker_reservation WHERE id = $1 FOR UPDATE`, [reservationId]);
      if (rRes.rowCount === 0) throw new AppError("NOT_FOUND", "Reserva no encontrada");
      const res = rRes.rows[0];
      if (eventId && res.event_id !== eventId) {
        throw new AppError("NOT_FOUND", "Reserva no pertenece al evento");
      }
      if (res.estado !== "aceptada" && res.estado !== "completada") {
        throw new AppError("RESERVATION_NOT_ACCEPTED", "Reserva no aceptada");
      }

      const idempotencyKey = `pay:${res.id}`;
      let pRes = await client.query(`SELECT * FROM payment WHERE reservation_id = $1 FOR UPDATE`, [res.id]);
      if (pRes.rowCount === 0) {
        pRes = await client.query(
          `INSERT INTO payment (id, reservation_id, idempotency_key, monto, moneda, estado_psp, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'pendiente', $6, $6) RETURNING *`,
          [ulid(), res.id, idempotencyKey, res.costo_congelado_monto, res.costo_congelado_moneda, toIso(now)]
        );
      }
      const payment = pRes.rows[0];
      let existingTxId = null;
      if (payment.cobrado_en) {
        const tx = await client.query(
          `SELECT transaccion_id FROM payment_entry WHERE pago_id = $1 AND movimiento = 'cobro' LIMIT 1`,
          [payment.id]
        );
        existingTxId = tx.rows[0]?.transaccion_id || null;
      }
      return { res, payment, existingTxId };
    });

    const { res, payment, existingTxId } = pre;
    const nowIso = toIso(now);

    if (payment.cobrado_en) {
      return {
        statusCode: 201,
        body: {
          payment_id: payment.id,
          estado: "confirmado",
          monto: Number(payment.monto),
          moneda: payment.moneda,
          idempotency_key: payment.idempotency_key,
          ledger_tx_id: existingTxId,
        },
      };
    }

    if (payment.estado_psp === "desconocido") {
      try {
        const q = await paymentProvider.queryByKey(payment.idempotency_key);
        if (q?.found && q.status === "succeeded") {
          return this._confirmPaymentCharge({ paymentId: payment.id, pspChargeId: q.psp_charge_id, nowIso });
        }
      } catch {
        // continuar al flujo normal de charge/desconocido
      }
    }

    let pspRes;
    try {
      pspRes = await paymentProvider.charge({
        idempotencyKey: payment.idempotency_key,
        amount: Number(payment.monto),
        currency: payment.moneda,
        metadata: { reservation_id: res.id, event_id: res.event_id },
      });
    } catch (err) {
      await this.pool.query(`UPDATE payment SET estado_psp = 'desconocido' WHERE id = $1 AND cobrado_en IS NULL`, [payment.id]);
      if (this.metrics) this.metrics.pspError(err?.isTimeout ? "timeout" : "charge_exception");
      return {
        statusCode: 202,
        body: {
          payment_id: payment.id,
          estado: "desconocido",
          monto: Number(payment.monto),
          moneda: payment.moneda,
          idempotency_key: payment.idempotency_key,
        },
      };
    }

    if (!pspRes || pspRes.status === "unknown" || pspRes.status === "pending") {
      await this.pool.query(`UPDATE payment SET estado_psp = 'desconocido' WHERE id = $1 AND cobrado_en IS NULL`, [payment.id]);
      if (this.metrics) this.metrics.pspError("unknown_status");
      return {
        statusCode: 202,
        body: {
          payment_id: payment.id,
          estado: "desconocido",
          monto: Number(payment.monto),
          moneda: payment.moneda,
          idempotency_key: payment.idempotency_key,
        },
      };
    }

    if (pspRes.status === "succeeded") {
      return this._confirmPaymentCharge({ paymentId: payment.id, pspChargeId: pspRes.psp_charge_id, nowIso });
    }

    await this.pool.query(`UPDATE payment SET estado_psp = 'fallido' WHERE id = $1 AND cobrado_en IS NULL`, [payment.id]);
    if (this.metrics) this.metrics.pspError("charge_failed");
    throw new AppError("PSP_ERROR", pspRes.error || "El cobro fue rechazado por el proveedor de pagos");
  }

  /**
   * Confirma un cobro y asienta el ledger de doble entrada exactamente una vez (TR-09, AC-08).
   * Reintentos y peticiones concurrentes con la misma clave llegan aquí tras la respuesta
   * (deduplicada) del PSP: el `FOR UPDATE` sobre `payment` los serializa y solo el primero
   * escribe; los demás leen la transacción ya asentada y devuelven la misma respuesta.
   */
  async _confirmPaymentCharge({ paymentId, pspChargeId = null, nowIso }) {
    return withTx(this.pool, async (client) => {
      const pRes = await client.query(`SELECT * FROM payment WHERE id = $1 FOR UPDATE`, [paymentId]);
      const p = pRes.rows[0];
      const ledgerTxId = await this._postCobroLedger(client, p, pspChargeId, nowIso);
      return {
        statusCode: 201,
        body: {
          payment_id: p.id,
          estado: "confirmado",
          monto: Number(p.monto),
          moneda: p.moneda,
          idempotency_key: p.idempotency_key,
          ledger_tx_id: ledgerTxId,
        },
      };
    });
  }

  /**
   * Asiento de cobro idempotente. Precondición: la fila `payment` ya está bloqueada
   * (`FOR UPDATE`) en `client`. Devuelve el `transaccion_id` (nuevo o existente).
   */
  async _postCobroLedger(client, payment, pspChargeId, nowIso) {
    if (payment.cobrado_en) {
      const tx = await client.query(
        `SELECT transaccion_id FROM payment_entry WHERE pago_id = $1 AND movimiento = 'cobro' LIMIT 1`,
        [payment.id]
      );
      return tx.rows[0]?.transaccion_id || null;
    }
    const txId = ulid();
    await client.query(
      `UPDATE payment SET estado_psp = 'confirmado', psp_charge_id = COALESCE($2, psp_charge_id), cobrado_en = $3
        WHERE id = $1`,
      [payment.id, pspChargeId, nowIso]
    );
    await client.query(
      `INSERT INTO payment_entry (id, pago_id, transaccion_id, movimiento, cuenta, tipo, importe, moneda, created_at, updated_at)
       VALUES ($1, $2, $3, 'cobro', 'psp_clearing', 'debito', $4, $5, $8, $8),
              ($6, $2, $3, 'cobro', 'worker_payable', 'credito', $7, $5, $8, $8)`,
      [ulid(), payment.id, txId, payment.monto, payment.moneda, ulid(), -Number(payment.monto), nowIso]
    );
    return txId;
  }
}

attachPgStoreMethods(PgStore, withTx);
