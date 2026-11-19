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

class KeyedMutex {
  constructor() {
    this.chains = new Map();
  }

  async run(key, fn) {
    const prev = this.chains.get(key) || Promise.resolve();
    let release;
    const next = new Promise((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => next);
    this.chains.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.chains.get(key) === tail) {
        this.chains.delete(key);
      }
    }
  }
}

function toIso(d) {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

function nowIsoOr(now) {
  return now ? toIso(now) : new Date().toISOString();
}

export class InMemoryStore {
  constructor({ piiKey = process.env.PII_ENCRYPTION_KEY || "orquesta-dev-pii-key-32bytes!", metrics = null } = {}) {
    this.piiKey = piiKey;
    this.metrics = metrics;

    // 22 entidades de dominio
    this.users = new Map();
    this.eventMemberships = new Map();
    this.venues = new Map();
    this.events = new Map();
    this.eventRequirements = new Map();
    this.guests = new Map();
    this.invitations = new Map();
    this.eventAccessTokens = new Map();
    this.staffAssignments = new Map();
    this.invitationDeliveries = new Map();
    this.rsvpResponses = new Map();
    this.checkinEvents = [];
    this.deviceSyncStates = new Map();
    this.eventTables = new Map();
    this.seatAssignments = new Map();
    this.reminderJobs = new Map();
    this.auditEntries = [];
    this.workerProfiles = new Map();
    this.availabilityWindows = new Map();
    this.workerReservations = new Map();
    this.payments = new Map();
    this.paymentEntries = [];

    // Tablas técnicas / soporte
    this.eventCounters = new Map();
    this.outboxEvents = [];
    this.projectorApplied = new Set();
    this.idempotencyRecords = new Map();
    this.verificationChallenges = new Map();
    this.importJobs = new Map();
    this.scanSessions = new Map();
    this.checkinBatchAcks = new Map();
    this.webhookEvents = new Map();
    this.plannerAlerts = [];
    this.seatingPlanVersions = new Map();
    this.paymentReconciliations = new Map();
    this.revokedSessionJtis = new Map();

    this.syntheticSeqCounter = 100000;
    this.mutexes = {
      worker: new KeyedMutex(),
      seating: new KeyedMutex(),
      import: new KeyedMutex(),
      payment: new KeyedMutex(),
      checkin: new KeyedMutex(),
      rsvp: new KeyedMutex(),
      send: new KeyedMutex(),
      otp: new KeyedMutex(),
    };
  }

  _enc(val) {
    return encryptPii(val, this.piiKey);
  }

  _dec(val) {
    return decryptPii(val, this.piiKey);
  }

  _hmac(val) {
    return hmacLookup(val, this.piiKey);
  }

  _pushOutbox({ eventId = null, topic, eventType, canal = null, payload, tIngest }) {
    const row = {
      id: ulid(),
      event_id: eventId,
      topic,
      event_type: eventType,
      canal,
      payload,
      t_ingest: tIngest || new Date().toISOString(),
      published_at: null,
      created_at: new Date().toISOString(),
    };
    this.outboxEvents.push(row);
    return row;
  }

  _pushAudit({ eventId = null, actorId, accion, entidad, entidadId, motivo, ts, detalle = {} }) {
    const entry = {
      id: ulid(),
      event_id: eventId,
      actor_id: actorId,
      accion,
      entidad,
      entidad_id: entidadId,
      motivo,
      ts: ts || new Date().toISOString(),
      detalle,
      created_at: new Date().toISOString(),
    };
    this.auditEntries.push(entry);
    return entry;
  }

  // ==========================================================================
  // Idempotencia HTTP
  // ==========================================================================
  async getIdempotency(scope, key) {
    const rec = this.idempotencyRecords.get(`${scope}::${key}`);
    return rec ? { ...rec } : null;
  }

  async saveIdempotency({ scope, key, requestHash, statusCode, headers = {}, body }) {
    const mapKey = `${scope}::${key}`;
    const existing = this.idempotencyRecords.get(mapKey);
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new AppError("IDEMPOTENCY_CONFLICT", "Idempotency-Key reutilizada con cuerpo distinto");
      }
      return existing;
    }
    const rec = {
      scope,
      idempotency_key: key,
      request_hash: requestHash,
      status_code: statusCode,
      response_headers: headers,
      response_body: body,
      created_at: new Date().toISOString(),
    };
    this.idempotencyRecords.set(mapKey, rec);
    return rec;
  }

  // ==========================================================================
  // Auth & Verificación (RF-19)
  // ==========================================================================
  async createUser({ email, roles = ["planner"], passwordHash }) {
    const normalized = normalizeEmail(email);
    if (!normalized) throw validationError("Email inválido", "email");
    const emailHmac = this._hmac(normalized);

    for (const u of this.users.values()) {
      if (u.email_hmac === emailHmac) {
        throw new AppError("EMAIL_YA_REGISTRADA", "El email ya está registrado");
      }
    }

    const now = new Date().toISOString();
    const user = {
      id: ulid(),
      email_cifrado: this._enc(normalized),
      email_hmac: emailHmac,
      roles: [...new Set(roles)],
      password_hash: passwordHash,
      email_verificado_en: null,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    this.users.set(user.id, user);
    return { ...user, email: normalized };
  }

  async findUserByEmail(email) {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    const emailHmac = this._hmac(normalized);
    for (const u of this.users.values()) {
      if (u.email_hmac === emailHmac) {
        return { ...u, email: this._dec(u.email_cifrado) };
      }
    }
    return null;
  }

  async findUserById(userId) {
    const u = this.users.get(userId);
    if (!u) return null;
    return { ...u, email: this._dec(u.email_cifrado) };
  }

  async updateUserPassword(userId, passwordHash) {
    const u = this.users.get(userId);
    if (!u) throw new AppError("NOT_FOUND", "Usuario no encontrado");
    u.password_hash = passwordHash;
    u.updated_at = new Date().toISOString();
  }

  async revokeSessionJti(jti, exp) {
    if (jti) this.revokedSessionJtis.set(jti, exp);
  }

  async isSessionRevoked(jti) {
    return jti ? this.revokedSessionJtis.has(jti) : false;
  }

  async createChallenge({ userId, proposito, canal, destino = null, codigoRaw, expiraEn }) {
    const now = new Date().toISOString();
    const ch = {
      id: ulid(),
      user_id: userId,
      proposito,
      canal,
      destino_hmac: destino ? this._hmac(destino) : null,
      destino_cifrado: destino ? this._enc(destino) : null,
      codigo_hash: sha256Hex(codigoRaw),
      intentos: 0,
      expira_en: toIso(expiraEn),
      verificado_en: null,
      created_at: now,
      updated_at: now,
    };
    this.verificationChallenges.set(ch.id, ch);
    return { ...ch };
  }

  async confirmEmailChallenge(rawToken, now = new Date()) {
    const hash = sha256Hex(rawToken);
    let found = null;
    for (const ch of this.verificationChallenges.values()) {
      if (ch.proposito === "verify_email" && ch.codigo_hash === hash) {
        found = ch;
        break;
      }
    }
    if (!found) throw new AppError("TOKEN_INVALIDO", "Token de verificación inválido");
    if (found.verificado_en) {
      return { email_verificado: true, user_id: found.user_id };
    }
    if (new Date(found.expira_en).getTime() <= new Date(now).getTime()) {
      throw new AppError("TOKEN_EXPIRADO", "Token de verificación expirado");
    }
    const nowIso = toIso(now);
    found.verificado_en = nowIso;
    found.updated_at = nowIso;

    const user = this.users.get(found.user_id);
    if (user && !user.email_verificado_en) {
      user.email_verificado_en = nowIso;
      user.updated_at = nowIso;
    }
    for (const wp of this.workerProfiles.values()) {
      if (wp.user_id === found.user_id && !wp.email_verificado_en) {
        wp.email_verificado_en = nowIso;
        wp.updated_at = nowIso;
      }
    }
    return { email_verificado: true, user_id: found.user_id };
  }

  async confirmPasswordReset(rawToken, newPasswordHash, now = new Date()) {
    const hash = sha256Hex(rawToken);
    let found = null;
    for (const ch of this.verificationChallenges.values()) {
      if (ch.proposito === "password_reset" && ch.codigo_hash === hash) {
        found = ch;
        break;
      }
    }
    if (!found) throw new AppError("TOKEN_INVALIDO", "Token de recuperación inválido");
    if (found.verificado_en) {
      return { reset: true };
    }
    if (new Date(found.expira_en).getTime() <= new Date(now).getTime()) {
      throw new AppError("TOKEN_EXPIRADO", "Token de recuperación expirado");
    }
    const nowIso = toIso(now);
    found.verificado_en = nowIso;
    found.updated_at = nowIso;
    await this.updateUserPassword(found.user_id, newPasswordHash);
    return { reset: true };
  }

  async assertPhoneAvailableForVerification(phoneE164, excludeWorkerId = null) {
    const phoneHmac = this._hmac(phoneE164);
    for (const wp of this.workerProfiles.values()) {
      if (
        wp.id !== excludeWorkerId &&
        !wp.deleted_at &&
        wp.telefono_verificado_en &&
        wp.telefono_hmac === phoneHmac
      ) {
        throw new AppError(
          "TELEFONO_YA_REGISTRADO",
          "El teléfono ya respalda otro perfil verificado"
        );
      }
    }
  }

  async confirmOtpChallenge({ userId, challengeId, codigoOtp, now = new Date() }) {
    return this.mutexes.otp.run("otp_phone_verify", async () => {
      const ch = this.verificationChallenges.get(challengeId);
      if (!ch || ch.user_id !== userId) {
        throw new AppError("NOT_FOUND", "Desafío de verificación no encontrado");
      }
      if (new Date(ch.expira_en).getTime() <= new Date(now).getTime()) {
        throw new AppError("TOKEN_EXPIRADO", "Código OTP expirado");
      }
      const wp = await this.getWorkerProfileByUserId(userId);
      if (!ch.verificado_en) {
        if (ch.codigo_hash !== sha256Hex(String(codigoOtp || "").trim())) {
          ch.intentos += 1;
          ch.updated_at = toIso(now);
          throw validationError("Código OTP incorrecto", "codigo_otp");
        }
        const nowIso = toIso(now);
        ch.verificado_en = nowIso;
        ch.updated_at = nowIso;

        if (ch.canal === "sms") {
          if (!wp) throw new AppError("NOT_FOUND", "Perfil de trabajador no encontrado");
          const plainPhone = this._dec(ch.destino_cifrado);
          await this.assertPhoneAvailableForVerification(plainPhone, wp.worker_id);
          const storedWp = this.workerProfiles.get(wp.worker_id);
          storedWp.telefono_cifrado = this._enc(plainPhone);
          storedWp.telefono_hmac = this._hmac(plainPhone);
          storedWp.telefono_verificado_en = nowIso;
          storedWp.updated_at = nowIso;
        } else if (ch.canal === "email") {
          const u = this.users.get(userId);
          if (u && !u.email_verificado_en) {
            u.email_verificado_en = nowIso;
            u.updated_at = nowIso;
          }
          if (wp) {
            const storedWp = this.workerProfiles.get(wp.worker_id);
            storedWp.email_verificado_en = nowIso;
            storedWp.updated_at = nowIso;
          }
        }
      }

      const updated = await this.getWorkerProfileByUserId(userId);
      const visible = Boolean(
        updated &&
          updated.estado === "publicado" &&
          updated.email_verificado_en &&
          updated.telefono_verificado_en &&
          !updated.deleted_at
      );
      return { verificado: true, visible_en_busqueda: visible };
    });
  }

  // ==========================================================================
  // Venues, Eventos, Membresías y Staff
  // ==========================================================================
  async createVenue({ nombre, zona, direccion }) {
    if (!nombre || String(nombre).trim().length === 0 || String(nombre).trim().length > 120) {
      throw validationError("nombre de venue inválido", "nombre");
    }
    if (!isValidZona(zona)) {
      throw validationError(`zona inválida: ${zona}`, "zona");
    }
    if (!direccion || String(direccion).trim().length === 0 || String(direccion).trim().length > 240) {
      throw validationError("dirección inválida", "direccion");
    }
    const now = new Date().toISOString();
    const venue = {
      id: ulid(),
      nombre: String(nombre).trim(),
      zona,
      direccion: String(direccion).trim(),
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    this.venues.set(venue.id, venue);
    return { ...venue };
  }

  async listVenues({ limit = 20, cursor = null } = {}) {
    const all = [...this.venues.values()]
      .filter((v) => !v.deleted_at)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return paginateArray(all, limit, cursor);
  }

  async getVenueById(venueId) {
    const v = this.venues.get(venueId);
    return v && !v.deleted_at ? { ...v } : null;
  }

  async createEvent({ userId, nombre, fecha, timezone, ventana, venueId, aforo, requerimientos = [] }) {
    if (!nombre || String(nombre).trim().length === 0 || String(nombre).trim().length > 160) {
      throw validationError("nombre es obligatorio", "nombre");
    }
    if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(String(fecha))) {
      throw validationError("fecha es obligatoria (YYYY-MM-DD)", "fecha");
    }
    if (!timezone || !isValidIanaTimezone(timezone)) {
      throw validationError("timezone IANA es obligatoria", "timezone");
    }
    if (!ventana || !ventana.inicio || !ventana.fin) {
      throw validationError("ventana {inicio, fin} es obligatoria", "ventana");
    }
    const vIni = new Date(ventana.inicio);
    const vFin = new Date(ventana.fin);
    if (Number.isNaN(vIni.getTime()) || Number.isNaN(vFin.getTime()) || vFin <= vIni) {
      throw validationError("ventana.fin debe ser posterior a ventana.inicio", "ventana");
    }
    if (!venueId) {
      throw validationError("venue_id es obligatorio", "venue_id");
    }
    const venue = this.venues.get(venueId);
    if (!venue || venue.deleted_at) {
      throw new AppError("NOT_FOUND", "Venue no encontrado");
    }
    const aforoNum = Number(aforo);
    if (!Number.isInteger(aforoNum) || aforoNum <= 0) {
      throw validationError("aforo debe ser entero positivo", "aforo");
    }

    const seenRoles = new Set();
    for (const req of requerimientos || []) {
      if (!isValidRol(req.rol)) throw validationError(`rol inválido: ${req.rol}`, "requerimientos");
      if (!Number.isInteger(Number(req.cantidad)) || Number(req.cantidad) <= 0) {
        throw validationError("cantidad debe ser > 0", "requerimientos");
      }
      if (seenRoles.has(req.rol)) {
        throw validationError(`rol duplicado en requerimientos: ${req.rol}`, "requerimientos");
      }
      seenRoles.add(req.rol);
    }

    const now = new Date().toISOString();
    const ev = {
      id: ulid(),
      venue_id: venueId,
      nombre: String(nombre).trim(),
      fecha: String(fecha),
      timezone,
      ventana_inicio: vIni.toISOString(),
      ventana_fin: vFin.toISOString(),
      aforo: aforoNum,
      estado: "borrador",
      cerrado_en: null,
      cancelado_motivo: null,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    this.events.set(ev.id, ev);

    const membership = {
      id: ulid(),
      event_id: ev.id,
      user_id: userId,
      rol: "owner",
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    this.eventMemberships.set(membership.id, membership);

    const reqRows = [];
    for (const req of requerimientos || []) {
      const r = {
        id: ulid(),
        event_id: ev.id,
        rol: req.rol,
        cantidad: Number(req.cantidad),
        created_at: now,
        updated_at: now,
        deleted_at: null,
      };
      this.eventRequirements.set(r.id, r);
      reqRows.push({ rol: r.rol, cantidad: r.cantidad });
    }

    this.eventCounters.set(ev.id, {
      event_id: ev.id,
      invitados: 0,
      confirmados: 0,
      asistentes: 0,
      aun_no_llegaron: 0,
      entregas_parciales: 0,
      ultimo_t_ingest: null,
      updated_at: now,
    });

    return {
      id: ev.id,
      estado: ev.estado,
      nombre: ev.nombre,
      fecha: ev.fecha,
      timezone: ev.timezone,
      ventana: { inicio: ev.ventana_inicio, fin: ev.ventana_fin },
      aforo: ev.aforo,
      membership: { user_id: userId, rol: "owner" },
      venue: { id: venue.id, nombre: venue.nombre, zona: venue.zona, direccion: venue.direccion },
      requerimientos: reqRows,
      created_at: ev.created_at,
    };
  }

  async listEventsForUser({ userId, limit = 20, cursor = null }) {
    const memberEventIds = new Set();
    for (const m of this.eventMemberships.values()) {
      if (m.user_id === userId && !m.deleted_at) {
        memberEventIds.add(m.event_id);
      }
    }
    const items = [];
    for (const ev of this.events.values()) {
      if (memberEventIds.has(ev.id) && !ev.deleted_at) {
        items.push(this._formatEvent(ev));
      }
    }
    items.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return paginateArray(items, limit, cursor);
  }

  _formatEvent(ev) {
    const venue = this.venues.get(ev.venue_id);
    return {
      id: ev.id,
      nombre: ev.nombre,
      fecha: ev.fecha,
      timezone: ev.timezone,
      ventana: { inicio: ev.ventana_inicio, fin: ev.ventana_fin },
      aforo: ev.aforo,
      estado: ev.estado,
      cerrado_en: ev.cerrado_en,
      venue: venue ? { id: venue.id, nombre: venue.nombre, zona: venue.zona, direccion: venue.direccion } : null,
      created_at: ev.created_at,
      updated_at: ev.updated_at,
    };
  }

  async authorizeEventAccess({
    userId = null,
    eventId,
    requiredMembershipRoles = null, // e.g. ['owner'] or ['owner','editor']
    allowStaffPermiso = null, // e.g. 'roster' | 'checkin' | 'anulacion'
    scanSessionAuth = null, // { session_id, event_id, rol, device_id, user_id?, access_token_id? }
    allowClosedReplay = false,
    now = new Date(),
  }) {
    const ev = this.events.get(eventId);

    // Sesión de escaneo emitida por QR (EventAccessToken) o usuario
    if (scanSessionAuth) {
      if (scanSessionAuth.event_id !== eventId) {
        throw new AppError("NOT_FOUND", "Evento no encontrado");
      }
      if (!ev || ev.deleted_at) throw new AppError("NOT_FOUND", "Evento no encontrado");
      if (ev.estado === "cancelado") {
        throw new AppError("FORBIDDEN_EVENT_SCOPE", "El evento fue cancelado");
      }
      const sess = this.scanSessions.get(scanSessionAuth.session_id);
      const closedReplayGrace =
        allowClosedReplay &&
        ev.estado === "cerrado" &&
        ev.cerrado_en &&
        new Date(now).getTime() <= new Date(ev.cerrado_en).getTime() + 24 * 60 * 60 * 1000;

      if (!sess || sess.deleted_at || (!closedReplayGrace && new Date(sess.expira_en).getTime() <= new Date(now).getTime())) {
        throw new AppError("FORBIDDEN_EVENT_SCOPE", "Sesión de escaneo expirada o revocada");
      }
      if (sess.access_token_id && !closedReplayGrace) {
        const tok = this.eventAccessTokens.get(sess.access_token_id);
        if (!tok || tok.deleted_at || new Date(tok.expira_en).getTime() <= new Date(now).getTime()) {
          throw new AppError("FORBIDDEN_EVENT_SCOPE", "Token de acceso al evento expirado o revocado");
        }
      }
      if (allowStaffPermiso && scanSessionAuth.user_id) {
        // Verifica StaffAssignment si el usuario ingresó por user_id
        const sa = this._findLatestStaffAssignment(eventId, scanSessionAuth.user_id);
        const mem = this._findLatestMembership(eventId, scanSessionAuth.user_id);
        if (mem && !mem.deleted_at) {
          return { event: ev, membership: mem, staffAssignment: null };
        }
        if (
          !sa ||
          sa.deleted_at ||
          new Date(sa.expira_en).getTime() <= new Date(now).getTime() ||
          !sa.permisos.includes(allowStaffPermiso)
        ) {
          throw new AppError("FORBIDDEN_EVENT_SCOPE", "Permiso de escaneo revocado o insuficiente");
        }
        return { event: ev, membership: null, staffAssignment: sa };
      }
      return { event: ev, membership: null, staffAssignment: null, scanSession: sess };
    }

    if (!userId) throw new AppError("AUTH_REQUIRED", "Autenticación requerida");

    const membership = this._findLatestMembership(eventId, userId);
    const staff = allowStaffPermiso ? this._findLatestStaffAssignment(eventId, userId) : null;

    if (!ev || ev.deleted_at) {
      throw new AppError("NOT_FOUND", "Evento no encontrado");
    }

    // Relación activa de EventMembership
    if (membership && !membership.deleted_at) {
      if (requiredMembershipRoles && !requiredMembershipRoles.includes(membership.rol)) {
        throw new AppError("FORBIDDEN_EVENT_SCOPE", "Se requiere rol owner para esta acción");
      }
      return { event: ev, membership, staffAssignment: null };
    }

    // Relación activa de StaffAssignment (si la ruta la permite)
    if (allowStaffPermiso && staff) {
      const expired = new Date(staff.expira_en).getTime() <= new Date(now).getTime();
      if (staff.deleted_at || expired || !staff.permisos.includes(allowStaffPermiso)) {
        throw new AppError("FORBIDDEN_EVENT_SCOPE", "Asignación de staff revocada, vencida o sin permiso");
      }
      return { event: ev, membership: null, staffAssignment: staff };
    }

    // Si existía relación previa (membresía o staff) que caducó o fue revocada -> 403 FORBIDDEN_EVENT_SCOPE
    const hadStaffEver = this._findLatestStaffAssignment(eventId, userId);
    if ((membership && membership.deleted_at) || hadStaffEver) {
      throw new AppError("FORBIDDEN_EVENT_SCOPE", "Acceso al evento revocado o expirado");
    }

    // Sin relación previa -> 404 NOT_FOUND (03-api.md §3.b)
    throw new AppError("NOT_FOUND", "Evento no encontrado");
  }

  _findLatestMembership(eventId, userId) {
    let latest = null;
    for (const m of this.eventMemberships.values()) {
      if (m.event_id === eventId && m.user_id === userId) {
        if (!m.deleted_at) return m;
        latest = m;
      }
    }
    return latest;
  }

  _findLatestStaffAssignment(eventId, userId) {
    let latest = null;
    for (const s of this.staffAssignments.values()) {
      if (s.event_id === eventId && s.user_id === userId) {
        if (!s.deleted_at) return s;
        latest = s;
      }
    }
    return latest;
  }

  async getEventDetail({ eventId }) {
    const ev = this.events.get(eventId);
    if (!ev || ev.deleted_at) throw new AppError("NOT_FOUND", "Evento no encontrado");
    const reqs = await this.getEventRequirements({ eventId });
    return {
      ...this._formatEvent(ev),
      requerimientos: reqs.items,
    };
  }

  async updateEvent({ eventId, patch }) {
    const ev = this.events.get(eventId);
    if (!ev || ev.deleted_at) throw new AppError("NOT_FOUND", "Evento no encontrado");
    if (ev.estado === "cerrado" || ev.estado === "cancelado") {
      throw new AppError("EVENT_STATE_INVALID", "Evento cerrado o cancelado es de solo lectura");
    }

    let windowChanged = false;
    if (patch.nombre !== undefined) {
      if (!String(patch.nombre).trim()) throw validationError("nombre inválido", "nombre");
      ev.nombre = String(patch.nombre).trim();
    }
    if (patch.fecha !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(patch.fecha))) {
        throw validationError("fecha inválida", "fecha");
      }
      ev.fecha = String(patch.fecha);
    }
    if (patch.timezone !== undefined) {
      if (!isValidIanaTimezone(patch.timezone)) throw validationError("timezone inválida", "timezone");
      ev.timezone = patch.timezone;
    }
    if (patch.ventana !== undefined) {
      const ini = new Date(patch.ventana.inicio);
      const fin = new Date(patch.ventana.fin);
      if (Number.isNaN(ini.getTime()) || Number.isNaN(fin.getTime()) || fin <= ini) {
        throw validationError("ventana inválida", "ventana");
      }
      ev.ventana_inicio = ini.toISOString();
      ev.ventana_fin = fin.toISOString();
      windowChanged = true;
    }
    if (patch.aforo !== undefined) {
      const num = Number(patch.aforo);
      if (!Number.isInteger(num) || num <= 0) throw validationError("aforo inválido", "aforo");
      const currentGuests = this._countAforoGuests(eventId);
      if (num < currentGuests) {
        throw new AppError("AFORO_EXCEDIDO", "No se puede reducir aforo por debajo de invitados existentes");
      }
      ev.aforo = num;
    }
    ev.updated_at = new Date().toISOString();

    // TR-12: reprogramar la fecha del evento reescribe disparar_en del MISMO ReminderJob
    if (windowChanged) {
      const times = computeReminderTimes(ev.ventana_inicio);
      for (const job of this.reminderJobs.values()) {
        if (job.event_id === eventId && job.estado === "programado" && job.plantilla === "recordatorio_rsvp") {
          job.disparar_en = times[job.ventana] || job.disparar_en;
          job.updated_at = ev.updated_at;
        }
      }
    }

    return this._formatEvent(ev);
  }

  async transitionEvent({ eventId, targetState, actorId, motivo = "cambio de estado", now = new Date() }) {
    const ev = this.events.get(eventId);
    if (!ev || ev.deleted_at) throw new AppError("NOT_FOUND", "Evento no encontrado");
    const nowIso = toIso(now);

    if (ev.estado === targetState) {
      if (targetState === "cerrado") {
        return {
          id: ev.id,
          estado: "cerrado",
          cerrado_en: ev.cerrado_en,
          corte: this._computeCorte(eventId),
        };
      }
      return { id: ev.id, estado: ev.estado };
    }

    const allowed = {
      borrador: ["publicado", "cancelado"],
      publicado: ["en_curso", "cerrado", "cancelado"],
      en_curso: ["cerrado", "cancelado"],
      cerrado: [],
      cancelado: [],
    };
    if (!allowed[ev.estado].includes(targetState)) {
      throw new AppError(
        "EVENT_STATE_INVALID",
        `Transición inválida de ${ev.estado} a ${targetState}`
      );
    }

    ev.estado = targetState;
    ev.updated_at = nowIso;

    if (targetState === "cancelado") {
      ev.cancelado_motivo = motivo;
      this._expireEventAccessResources(eventId, nowIso);
      for (const job of this.reminderJobs.values()) {
        if (job.event_id === eventId && job.estado === "programado") {
          job.estado = "cancelado";
          job.motivo_cancelacion = "reserva_cancelada";
          job.updated_at = nowIso;
        }
      }
      return { id: ev.id, estado: "cancelado" };
    }

    if (targetState === "cerrado") {
      ev.cerrado_en = nowIso;
      this._expireEventAccessResources(eventId, nowIso);

      // AC-29 / RF-08 / RF-15 / NFR-09: toda reserva `aceptada` pasa a `completada` en bloque al cierre
      let reservasCompletadas = 0;
      let noShows = 0;
      for (const res of this.workerReservations.values()) {
        if (res.event_id === eventId && res.estado === "aceptada" && !res.deleted_at) {
          if (!res.llegada_registrada_en) {
            noShows += 1;
          }
          res.estado = "completada";
          res.updated_at = nowIso;
          reservasCompletadas += 1;
        }
      }
      if (noShows > 0) {
        this.metrics.providerNoShow(eventId, noShows);
      }

      this._pushAudit({
        eventId,
        actorId,
        accion: "evento_cerrado",
        entidad: "event",
        entidadId: ev.id,
        motivo: motivo || "Cierre de evento",
        ts: nowIso,
        detalle: { reservas_completadas: reservasCompletadas },
      });

      return {
        id: ev.id,
        estado: "cerrado",
        cerrado_en: ev.cerrado_en,
        corte: this._computeCorte(eventId),
        reservas_completadas: reservasCompletadas,
      };
    }

    return { id: ev.id, estado: ev.estado };
  }

  _expireEventAccessResources(eventId, nowIso) {
    for (const tok of this.eventAccessTokens.values()) {
      if (tok.event_id === eventId && !tok.deleted_at) {
        tok.expira_en = nowIso;
        tok.updated_at = nowIso;
      }
    }
    for (const sa of this.staffAssignments.values()) {
      if (sa.event_id === eventId && !sa.deleted_at) {
        sa.expira_en = nowIso;
        sa.updated_at = nowIso;
      }
    }
    for (const sess of this.scanSessions.values()) {
      if (sess.event_id === eventId && !sess.deleted_at) {
        sess.expira_en = nowIso;
        sess.updated_at = nowIso;
      }
    }
  }

  _computeCorte(eventId) {
    let invitados = 0;
    for (const g of this.guests.values()) {
      if (g.event_id === eventId && !g.deleted_at) invitados += 1;
    }
    const admittedCycles = new Set();
    const annulledIds = new Set();
    let tardios = 0;
    for (const chk of this.checkinEvents) {
      if (chk.event_id !== eventId) continue;
      if (chk.kind === "anulacion" && chk.anula_a) annulledIds.add(chk.anula_a);
    }
    for (const chk of this.checkinEvents) {
      if (chk.event_id !== eventId) continue;
      if (chk.kind === "admitido" && !annulledIds.has(chk.id)) {
        admittedCycles.add(chk.invitation_id);
        if (chk.tardio) tardios += 1;
      }
    }
    const asistentes = admittedCycles.size;
    let confirmados = 0;
    for (const r of this.rsvpResponses.values()) {
      if (r.event_id === eventId && !r.superseded_at && r.respuesta === "confirma") {
        confirmados += 1;
      }
    }
    return {
      invitados,
      confirmados,
      asistentes,
      tardios,
      no_show: Math.max(invitados - asistentes, 0),
    };
  }

  async listEventMembers({ eventId, limit = 20, cursor = null }) {
    const items = [];
    for (const m of this.eventMemberships.values()) {
      if (m.event_id === eventId && !m.deleted_at) {
        const u = await this.findUserById(m.user_id);
        items.push({
          membership_id: m.id,
          user_id: m.user_id,
          email: u?.email || null,
          rol: m.rol,
          created_at: m.created_at,
        });
      }
    }
    return paginateArray(items, limit, cursor);
  }

  async addEventEditor({ eventId, targetUserId = null, targetEmail = null, rol = "editor" }) {
    if (rol !== "editor") {
      throw validationError("Solo se pueden agregar miembros con rol editor", "rol");
    }
    let user = null;
    if (targetUserId) {
      user = await this.findUserById(targetUserId);
    } else if (targetEmail) {
      user = await this.findUserByEmail(targetEmail);
    }
    if (!user || user.deleted_at) {
      throw new AppError("NOT_FOUND", "Usuario destino no encontrado");
    }

    const existing = this._findLatestMembership(eventId, user.id);
    const now = new Date().toISOString();
    if (existing) {
      if (!existing.deleted_at) {
        if (existing.rol === "owner") {
          throw new AppError("EVENT_STATE_INVALID", "El usuario ya es owner del evento");
        }
        return {
          membership_id: existing.id,
          event_id: eventId,
          user_id: user.id,
          rol: existing.rol,
        };
      }
      existing.deleted_at = null;
      existing.rol = "editor";
      existing.updated_at = now;
      return {
        membership_id: existing.id,
        event_id: eventId,
        user_id: user.id,
        rol: "editor",
      };
    }

    const m = {
      id: ulid(),
      event_id: eventId,
      user_id: user.id,
      rol: "editor",
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    this.eventMemberships.set(m.id, m);
    return { membership_id: m.id, event_id: eventId, user_id: user.id, rol: "editor" };
  }

  async removeEventEditor({ eventId, targetUserId }) {
    const existing = this._findLatestMembership(eventId, targetUserId);
    if (!existing) throw new AppError("NOT_FOUND", "Membresía no encontrada");
    if (existing.rol === "owner") {
      throw new AppError("EVENT_STATE_INVALID", "No se puede revocar al owner del evento");
    }
    if (!existing.deleted_at) {
      const now = new Date().toISOString();
      existing.deleted_at = now;
      existing.updated_at = now;
    }
  }

  async grantStaffAssignment({ eventId, userId, permisos = ["roster", "checkin"], grantedByUserId, now = new Date() }) {
    const validPermisos = ["roster", "checkin", "anulacion"];
    if (
      !Array.isArray(permisos) ||
      permisos.length === 0 ||
      !permisos.every((p) => validPermisos.includes(p))
    ) {
      throw validationError("permisos inválidos", "permisos");
    }
    const targetUser = this.users.get(userId);
    if (!targetUser || targetUser.deleted_at) {
      throw new AppError("NOT_FOUND", "Usuario destino no encontrado");
    }
    const ev = this.events.get(eventId);
    if (!ev || ev.deleted_at) throw new AppError("NOT_FOUND", "Evento no encontrado");
    if (ev.estado === "cerrado" || ev.estado === "cancelado") {
      throw new AppError("EVENT_STATE_INVALID", "No se puede otorgar acceso a evento cerrado o cancelado");
    }
    const nowIso = toIso(now);
    const expiraEn = ev.ventana_fin;
    if (new Date(expiraEn).getTime() <= new Date(now).getTime()) {
      throw validationError("La ventana del evento ya finalizó", "expira_en");
    }

    const existing = this._findLatestStaffAssignment(eventId, userId);
    if (existing && !existing.deleted_at) {
      existing.permisos = [...new Set(permisos)];
      existing.otorgado_por_user_id = grantedByUserId;
      existing.expira_en = expiraEn;
      existing.updated_at = nowIso;
      return {
        staff_assignment_id: existing.id,
        event_id: eventId,
        user_id: userId,
        permisos: existing.permisos,
        expira_en: existing.expira_en,
      };
    }

    const sa = {
      id: ulid(),
      event_id: eventId,
      user_id: userId,
      permisos: [...new Set(permisos)],
      otorgado_por_user_id: grantedByUserId,
      expira_en: expiraEn,
      created_at: nowIso,
      updated_at: nowIso,
      deleted_at: null,
    };
    this.staffAssignments.set(sa.id, sa);

    this._pushAudit({
      eventId,
      actorId: grantedByUserId,
      accion: "acceso_otorgado",
      entidad: "staff_assignment",
      entidadId: sa.id,
      motivo: "Habilitación de escaneo en evento",
      ts: nowIso,
      detalle: { target_user_id: userId, permisos: sa.permisos },
    });

    return {
      staff_assignment_id: sa.id,
      event_id: eventId,
      user_id: userId,
      permisos: sa.permisos,
      expira_en: sa.expira_en,
    };
  }

  async createEventAccessToken({ eventId, rol, emittedByUserId, now: nowParam = new Date() }) {
    if (!isValidRol(rol)) throw validationError(`rol inválido: ${rol}`, "rol");
    const ev = this.events.get(eventId);
    if (!ev || ev.deleted_at) throw new AppError("NOT_FOUND", "Evento no encontrado");
    if (ev.estado === "cerrado" || ev.estado === "cancelado") {
      throw new AppError("EVENT_STATE_INVALID", "Evento cerrado o cancelado");
    }
    if (new Date(ev.ventana_fin).getTime() <= new Date(nowParam).getTime()) {
      throw validationError("La ventana del evento ya finalizó", "expira_en");
    }
    const now = toIso(nowParam);
    const rawToken = generateOpaqueToken("evtqr_");
    const rec = {
      id: ulid(),
      event_id: eventId,
      rol,
      token_hash: sha256Hex(rawToken),
      emitido_por_user_id: emittedByUserId,
      expira_en: ev.ventana_fin,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    this.eventAccessTokens.set(rec.id, rec);
    return {
      access_token_id: rec.id,
      event_id: eventId,
      rol: rec.rol,
      qr_token: rawToken,
      expira_en: rec.expira_en,
    };
  }

  async exchangeEventAccessToken({ rawToken, deviceId, now = new Date() }) {
    if (!rawToken || !deviceId) {
      throw validationError("access_token y device_id son obligatorios");
    }
    const hash = sha256Hex(rawToken);
    let tok = null;
    for (const t of this.eventAccessTokens.values()) {
      if (t.token_hash === hash) {
        tok = t;
        break;
      }
    }
    if (!tok || tok.deleted_at || new Date(tok.expira_en).getTime() <= new Date(now).getTime()) {
      throw new AppError("AUTH_REQUIRED", "QR de acceso inválido o expirado");
    }
    const ev = this.events.get(tok.event_id);
    if (!ev || ev.deleted_at || ev.estado === "cerrado" || ev.estado === "cancelado") {
      throw new AppError("AUTH_REQUIRED", "El evento no admite nuevas sesiones de escaneo");
    }

    const sess = await this.createOrGetScanSession({
      eventId: tok.event_id,
      deviceId,
      userId: null,
      accessTokenId: tok.id,
      rol: tok.rol,
      expiraEn: tok.expira_en,
      now,
    });
    return {
      session_id: sess.session_id,
      event_id: tok.event_id,
      rol: tok.rol,
      expira_en: tok.expira_en,
      access_token_id: tok.id,
      actor_id: tok.emitido_por_user_id,
    };
  }

  // ==========================================================================
  // Requerimientos y Cobertura (RF-22)
  // ==========================================================================
  async replaceEventRequirements({ eventId, requerimientos }) {
    const ev = this.events.get(eventId);
    if (!ev || ev.deleted_at) throw new AppError("NOT_FOUND", "Evento no encontrado");
    if (ev.estado === "cerrado" || ev.estado === "cancelado") {
      throw new AppError("EVENT_STATE_INVALID", "Evento cerrado o cancelado");
    }
    if (!Array.isArray(requerimientos)) {
      throw validationError("requerimientos debe ser arreglo", "requerimientos");
    }
    const seen = new Set();
    for (const r of requerimientos) {
      if (!isValidRol(r.rol)) throw validationError(`rol inválido: ${r.rol}`, "requerimientos");
      if (!Number.isInteger(Number(r.cantidad)) || Number(r.cantidad) <= 0) {
        throw validationError("cantidad debe ser > 0", "requerimientos");
      }
      if (seen.has(r.rol)) throw validationError(`rol duplicado: ${r.rol}`, "requerimientos");
      seen.add(r.rol);
    }

    const now = new Date().toISOString();
    for (const existing of this.eventRequirements.values()) {
      if (existing.event_id === eventId && !existing.deleted_at && !seen.has(existing.rol)) {
        existing.deleted_at = now;
        existing.updated_at = now;
      }
    }

    for (const r of requerimientos) {
      let row = null;
      for (const existing of this.eventRequirements.values()) {
        if (existing.event_id === eventId && existing.rol === r.rol) {
          row = existing;
          break;
        }
      }
      if (row) {
        row.cantidad = Number(r.cantidad);
        row.deleted_at = null;
        row.updated_at = now;
      } else {
        const created = {
          id: ulid(),
          event_id: eventId,
          rol: r.rol,
          cantidad: Number(r.cantidad),
          created_at: now,
          updated_at: now,
          deleted_at: null,
        };
        this.eventRequirements.set(created.id, created);
      }
    }

    const { items, cobertura } = await this.getEventRequirements({ eventId });
    return { requerimientos: items, cobertura };
  }

  async getEventRequirements({ eventId }) {
    const items = [];
    for (const r of this.eventRequirements.values()) {
      if (r.event_id === eventId && !r.deleted_at) {
        items.push({ id: r.id, rol: r.rol, cantidad: r.cantidad });
      }
    }
    const cobertura = this._computeCoverageForEvent(eventId, items);
    return { items, next_cursor: null, cobertura };
  }

  _computeCoverageForEvent(eventId, reqItems = null) {
    const reqs =
      reqItems ||
      [...this.eventRequirements.values()].filter((r) => r.event_id === eventId && !r.deleted_at);

    let totalRequerido = 0;
    let totalCubiertos = 0;
    let totalSinCubrir = 0;
    const porRol = [];

    for (const req of reqs) {
      let cubiertosRol = 0;
      let hasSinCubrirFlag = false;
      for (const res of this.workerReservations.values()) {
        if (res.event_id !== eventId || res.rol !== req.rol || res.deleted_at) continue;
        if (res.estado === "aceptada" || res.estado === "completada") {
          cubiertosRol += Number(res.plazas);
        } else if (res.estado === "sin_cubrir") {
          hasSinCubrirFlag = true;
        }
      }
      const alertasSinCubrir = this.plannerAlerts.some(
        (a) =>
          a.event_id === eventId &&
          a.tipo === "requerimiento_sin_cubrir" &&
          a.detalle?.rol === req.rol
      );
      const pendientesRol = Math.max(req.cantidad - cubiertosRol, 0);
      const sinCubrirRol = (hasSinCubrirFlag || alertasSinCubrir) && pendientesRol > 0;
      if (sinCubrirRol) totalSinCubrir += pendientesRol;
      totalRequerido += req.cantidad;
      totalCubiertos += Math.min(cubiertosRol, req.cantidad);
      porRol.push({
        rol: req.rol,
        cantidad: req.cantidad,
        cubiertos: cubiertosRol,
        pendientes: pendientesRol,
        sin_cubrir: sinCubrirRol,
      });
    }

    return {
      cubiertos: totalCubiertos,
      pendientes: Math.max(totalRequerido - totalCubiertos, 0),
      sin_cubrir: totalSinCubrir,
      por_rol: porRol,
    };
  }

  // ==========================================================================
  // Invitados e Import Masivo (RF-02, TR-11, RF-20)
  // ==========================================================================
  _countAforoGuests(eventId) {
    // RF-20 / AC-24: incluye filas con deleted_at (baja lógica no libera aforo)
    let count = 0;
    for (const g of this.guests.values()) {
      if (g.event_id === eventId) count += 1;
    }
    return count;
  }

  async getGuestAforoStatus(eventId) {
    const ev = this.events.get(eventId);
    if (!ev) throw new AppError("NOT_FOUND", "Evento no encontrado");
    return { limite: ev.aforo, ocupado: this._countAforoGuests(eventId) };
  }

  async createImportJob({ eventId, s3Key, fileHash, totalFilas }) {
    const now = new Date().toISOString();
    const job = {
      id: ulid(),
      event_id: eventId,
      s3_key: s3Key,
      file_hash: fileHash,
      estado: "en_proceso",
      progreso: 0.0,
      total_filas: totalFilas,
      aceptadas: 0,
      rechazadas: 0,
      duplicadas_en_archivo: 0,
      errores: [],
      error_code: null,
      created_at: now,
      updated_at: now,
    };
    this.importJobs.set(job.id, job);
    return { ...job };
  }

  async getImportJob({ eventId, importId }) {
    const job = this.importJobs.get(importId);
    if (!job || job.event_id !== eventId) {
      throw new AppError("NOT_FOUND", "ImportJob no encontrado");
    }
    const aforo = await this.getGuestAforoStatus(eventId);
    return {
      import_id: job.id,
      estado: job.estado,
      progreso: job.progreso,
      total_filas: job.total_filas,
      aceptadas: job.aceptadas,
      rechazadas: job.rechazadas,
      duplicadas_en_archivo: job.duplicadas_en_archivo,
      errores: job.errores,
      error_code: job.error_code,
      aforo,
    };
  }

  async previewImportCapacity({ eventId, parsedRows }) {
    const ev = this.events.get(eventId);
    if (!ev || ev.deleted_at) throw new AppError("NOT_FOUND", "Evento no encontrado");
    const existingKeys = new Set();
    for (const g of this.guests.values()) {
      if (g.event_id !== eventId) continue;
      if (g.email_hmac) existingKeys.add(`e:${g.email_hmac}`);
      if (g.telefono_hmac) existingKeys.add(`p:${g.telefono_hmac}`);
    }
    const seenInFile = new Set();
    const newValidRows = [];
    for (const row of parsedRows) {
      const check = validateAndNormalizeCsvRow(row);
      if (!check.valid) continue;
      const eKey = check.email ? `e:${this._hmac(check.email)}` : null;
      const pKey = check.telefono ? `p:${this._hmac(check.telefono)}` : null;
      const isFileDup = (eKey && seenInFile.has(eKey)) || (pKey && seenInFile.has(pKey));
      const isExisting = (eKey && existingKeys.has(eKey)) || (pKey && existingKeys.has(pKey));
      if (isFileDup || isExisting) continue;
      if (eKey) seenInFile.add(eKey);
      if (pKey) seenInFile.add(pKey);
      newValidRows.push(row);
    }

    const ocupado = this._countAforoGuests(eventId);
    if (ocupado + newValidRows.length > ev.aforo) {
      const available = Math.max(ev.aforo - ocupado, 0);
      const overflowRows = newValidRows.slice(available).map((r) => ({
        linea: r.linea,
        motivo: IMPORT_ROW_ERRORS.AFORO_EXCEDIDO,
      }));
      throw new AppError("AFORO_EXCEDIDO", "El import excede el aforo del evento", {
        aforo: ev.aforo,
        ocupado,
        nuevas_validas: newValidRows.length,
        aceptadas: 0,
        errores: overflowRows,
      });
    }
  }

  async executeImportBatch({
    importId,
    eventId,
    parsedRows,
    qrSigner,
    objectStorage,
    assetsBucket = process.env.ASSETS_BUCKET || "orquesta-assets",
  }) {
    return this.mutexes.import.run(eventId, async () => {
      const job = this.importJobs.get(importId);
      const ev = this.events.get(eventId);
      if (!job || !ev) throw new AppError("NOT_FOUND", "Evento o ImportJob no encontrado");
      if (job.estado === "completado") return this.getImportJob({ eventId, importId });

      // Índice de claves existentes en el evento (incluyendo baja lógica para reactivar TR-11/RF-12)
      const byEmailHmac = new Map();
      const byPhoneHmac = new Map();
      const usedShortCodes = new Set();
      for (const g of this.guests.values()) {
        if (g.event_id !== eventId) continue;
        if (g.email_hmac) byEmailHmac.set(g.email_hmac, g);
        if (g.telefono_hmac) byPhoneHmac.set(g.telefono_hmac, g);
      }
      for (const inv of this.invitations.values()) {
        if (inv.event_id === eventId) usedShortCodes.add(inv.codigo_corto);
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

        const existingGuest = (eHmac && byEmailHmac.get(eHmac)) || (pHmac && byPhoneHmac.get(pHmac));
        if (existingGuest) {
          if (existingGuest.deleted_at) {
            toReactivate.push({ existingGuest, nombre: res.nombre, email: res.email, telefono: res.telefono });
          } else {
            duplicadas += 1;
            errores.push({ linea: row.linea, motivo: IMPORT_ROW_ERRORS.GUEST_DUPLICADO });
          }
          continue;
        }

        toCreate.push({ linea: row.linea, nombre: res.nombre, email: res.email, telefono: res.telefono });
      }

      const ocupado = this._countAforoGuests(eventId);
      if (ocupado + toCreate.length > ev.aforo) {
        const available = Math.max(ev.aforo - ocupado, 0);
        const overflow = toCreate.slice(available).map((r) => ({
          linea: r.linea,
          motivo: IMPORT_ROW_ERRORS.AFORO_EXCEDIDO,
        }));
        job.estado = "fallido";
        job.progreso = 1.0;
        job.aceptadas = 0;
        job.rechazadas = rechazadas + toCreate.length;
        job.duplicadas_en_archivo = duplicadas;
        job.errores = [...errores, ...overflow];
        job.error_code = "AFORO_EXCEDIDO";
        job.updated_at = new Date().toISOString();
        throw new AppError("AFORO_EXCEDIDO", "El import excede el aforo del evento", {
          aforo: ev.aforo,
          ocupado,
          aceptadas: 0,
          errores: job.errores,
        });
      }

      const now = new Date().toISOString();
      const { key_id: activeKeyId } = await qrSigner.getPublicKey();

      // Confirmación atómica de altas y reactivaciones en `pendiente_envio` (RF-02)
      for (const item of toReactivate) {
        const g = item.existingGuest;
        g.deleted_at = null;
        g.nombre = item.nombre;
        g.estado_envio = "pendiente_envio";
        g.updated_at = now;
        const inv = [...this.invitations.values()].find((i) => i.guest_id === g.id);
        if (inv) {
          inv.deleted_at = null;
          inv.rsvp_revocado_en = null;
          inv.checkin_revocado_en = null;
          inv.updated_at = now;
        }
      }

      for (const item of toCreate) {
        let code = generateShortCode();
        while (usedShortCodes.has(code)) code = generateShortCode();
        usedShortCodes.add(code);

        const guestId = ulid();
        const guest = {
          id: guestId,
          event_id: eventId,
          nombre: item.nombre,
          email_cifrado: item.email ? this._enc(item.email) : null,
          email_hmac: item.email ? this._hmac(item.email) : null,
          telefono_cifrado: item.telefono ? this._enc(item.telefono) : null,
          telefono_hmac: item.telefono ? this._hmac(item.telefono) : null,
          estado_envio: "pendiente_envio",
          pii_anonimizada_en: null,
          created_at: now,
          updated_at: now,
          deleted_at: null,
        };
        this.guests.set(guest.id, guest);

        const invitationId = ulid();
        const rsvpRaw = generateOpaqueToken("rsvp_", 24);
        const qrPayload = {
          typ: "checkin_qr",
          invitation_id: invitationId,
          event_id: eventId,
          token_version: 1,
          key_id: activeKeyId,
        };
        const qrToken = await qrSigner.signJws(qrPayload, activeKeyId);
        const qrPngBuffer = await renderQrPng(qrToken);
        const qrS3Key = `qr/${invitationId}_v1.png`;

        await objectStorage.putObject({
          bucket: assetsBucket,
          key: qrS3Key,
          body: qrPngBuffer,
          contentType: "image/png",
          cacheControl: "public, s-maxage=300, stale-while-revalidate=86400",
        });

        const invitation = {
          id: invitationId,
          event_id: eventId,
          guest_id: guestId,
          rsvp_token_hash: sha256Hex(rsvpRaw),
          rsvp_token_cifrado: this._enc(rsvpRaw),
          checkin_key_id: activeKeyId,
          token_version: 1,
          qr_token_cifrado: this._enc(qrToken),
          qr_s3_key: qrS3Key,
          qr_emitido_en: now,
          rsvp_revocado_en: null,
          checkin_revocado_en: null,
          codigo_corto: code,
          pii_anonimizada_en: null,
          created_at: now,
          updated_at: now,
          deleted_at: null,
        };
        this.invitations.set(invitation.id, invitation);
      }

      const deltaInvitados = toCreate.length + toReactivate.length;
      if (deltaInvitados > 0) {
        this._pushOutbox({
          eventId,
          topic: "projection",
          eventType: "guests_imported",
          payload: { invitados_delta: deltaInvitados },
          tIngest: now,
        });
      }

      job.estado = "completado";
      job.progreso = 1.0;
      job.aceptadas = deltaInvitados;
      job.rechazadas = rechazadas;
      job.duplicadas_en_archivo = duplicadas;
      job.errores = errores;
      job.updated_at = now;

      return this.getImportJob({ eventId, importId });
    });
  }

  async listGuests({ eventId, limit = 20, cursor = null, sinMesa = false, includeDeleted = false }) {
    const seatedGuestIds = new Set();
    for (const sa of this.seatAssignments.values()) {
      if (sa.event_id === eventId && (sa.estado === "confirmado" || sa.estado === "pendiente")) {
        seatedGuestIds.add(sa.guest_id);
      }
    }
    const items = [];
    for (const g of this.guests.values()) {
      if (g.event_id !== eventId) continue;
      if (!includeDeleted && g.deleted_at) continue;
      if (sinMesa && seatedGuestIds.has(g.id)) continue;

      const inv = [...this.invitations.values()].find((i) => i.guest_id === g.id);
      const rsvp = inv
        ? [...this.rsvpResponses.values()].find((r) => r.invitation_id === inv.id && !r.superseded_at)
        : null;
      const seat = [...this.seatAssignments.values()].find(
        (sa) => sa.guest_id === g.id && (sa.estado === "confirmado" || sa.estado === "pendiente")
      );
      items.push({
        id: g.id,
        nombre: g.nombre,
        email: g.email_cifrado ? this._dec(g.email_cifrado) : null,
        telefono: g.telefono_cifrado ? this._dec(g.telefono_cifrado) : null,
        estado_envio: g.estado_envio,
        estado_rsvp: rsvp?.respuesta || null,
        invitation_id: inv?.id || null,
        codigo_corto: inv?.codigo_corto || null,
        table_id: seat?.table_id || null,
        deleted_at: g.deleted_at,
      });
    }
    return paginateArray(items, limit, cursor);
  }

  async softDeleteGuest({ eventId, guestId, actorId, now = new Date() }) {
    return this.mutexes.seating.run(eventId, async () => {
      const g = this.guests.get(guestId);
      if (!g || g.event_id !== eventId) {
        throw new AppError("NOT_FOUND", "Invitado no encontrado");
      }
      const nowIso = toIso(now);
      if (g.deleted_at) {
        return {
          guest_id: g.id,
          deleted_at: g.deleted_at,
          token_revocado: true,
          jobs_cancelados: 0,
          asientos_liberados: 0,
        };
      }

      g.deleted_at = nowIso;
      g.updated_at = nowIso;

      const inv = [...this.invitations.values()].find((i) => i.guest_id === g.id);
      if (inv) {
        inv.rsvp_revocado_en = inv.rsvp_revocado_en || nowIso;
        inv.checkin_revocado_en = inv.checkin_revocado_en || nowIso;
        inv.updated_at = nowIso;
        for (const sess of this.scanSessions.values()) {
          if (sess.event_id === eventId && !sess.deleted_at) {
            sess.revocation_version += 1;
          }
        }
      }

      let jobsCancelados = 0;
      for (const job of this.reminderJobs.values()) {
        if (job.event_id === eventId && job.guest_id === g.id && job.estado === "programado") {
          job.estado = "cancelado";
          job.motivo_cancelacion = "invitado_de_baja";
          job.updated_at = nowIso;
          jobsCancelados += 1;
        }
      }

      let asientosLiberados = 0;
      for (const sa of this.seatAssignments.values()) {
        if (
          sa.event_id === eventId &&
          sa.guest_id === g.id &&
          (sa.estado === "confirmado" || sa.estado === "pendiente")
        ) {
          sa.estado = "liberado";
          sa.ocupa_capacidad = false;
          sa.liberado_en = nowIso;
          sa.motivo_liberacion = "baja_invitado";
          sa.updated_at = nowIso;
          asientosLiberados += 1;
        }
      }

      this._pushAudit({
        eventId,
        actorId,
        accion: "invitado_baja",
        entidad: "guest",
        entidadId: g.id,
        motivo: "Baja lógica de invitado",
        ts: nowIso,
        detalle: { jobs_cancelados: jobsCancelados, asientos_liberados: asientosLiberados },
      });

      let confirmadosDelta = 0;
      if (inv) {
        for (const r of this.rsvpResponses.values()) {
          if (r.invitation_id === inv.id && !r.superseded_at) {
            if (r.respuesta === "confirma") {
              confirmadosDelta = -1;
            }
            r.superseded_at = nowIso;
            r.updated_at = nowIso;
          }
        }
      }

      this._pushOutbox({
        eventId,
        topic: "projection",
        eventType: "guest_deleted",
        payload: {
          invitados_delta: -1,
          ...(confirmadosDelta !== 0 ? { confirmados_delta: confirmadosDelta } : {}),
        },
        tIngest: nowIso,
      });

      return {
        guest_id: g.id,
        deleted_at: g.deleted_at,
        token_revocado: true,
        jobs_cancelados: jobsCancelados,
        asientos_liberados: asientosLiberados,
      };
    });
  }

  // ==========================================================================
  // Invitaciones y Envíos (RF-03, RF-04, RF-10, RF-16, D11)
  // ==========================================================================
  async getPendingSendSummary({ eventId }) {
    let destinatarios = 0;
    let sms = 0;
    let email = 0;
    for (const g of this.guests.values()) {
      if (g.event_id === eventId && !g.deleted_at && g.estado_envio === "pendiente_envio") {
        destinatarios += 1;
        if (g.telefono_cifrado) sms += 1;
        if (g.email_cifrado) email += 1;
      }
    }
    return {
      destinatarios,
      por_canal: { sms, email },
      pendiente_envio: destinatarios,
    };
  }

  async dispatchInvitationSend({
    eventId,
    alcance = "pendiente_envio",
    guestIds = [],
    destinatariosConfirmados,
    canalesActivos = ["sms", "email"],
    actorId,
    now = new Date(),
  }) {
    return this.mutexes.send.run(eventId, async () => {
      const ev = this.events.get(eventId);
      if (!ev || ev.deleted_at) throw new AppError("NOT_FOUND", "Evento no encontrado");
      if (ev.estado !== "publicado" && ev.estado !== "en_curso") {
        throw new AppError(
          "EVENT_STATE_INVALID",
          "Solo eventos publicado o en_curso aceptan envíos"
        );
      }

      const targets = [];
      const guestIdSet = new Set(guestIds || []);
      for (const g of this.guests.values()) {
        if (g.event_id !== eventId || g.deleted_at) continue;
        if (alcance === "pendiente_envio" && g.estado_envio === "pendiente_envio") {
          targets.push(g);
        } else if (alcance === "seleccion" && guestIdSet.has(g.id) && g.estado_envio === "pendiente_envio") {
          targets.push(g);
        }
      }

      if (targets.length === 0) {
        throw new AppError("SIN_DESTINATARIOS_PENDIENTES", "No hay destinatarios pendientes de envío");
      }

      if (Number(destinatariosConfirmados) !== targets.length) {
        throw new AppError("CONFIRMACION_REQUERIDA", "El número de destinatarios no coincide", {
          destinatarios_calculados: targets.length,
          confirmados: destinatariosConfirmados ?? null,
        });
      }

      const nowIso = toIso(now);
      const envioId = ulid();
      let entregasEncoladas = 0;
      const reminderTimes = computeReminderTimes(ev.ventana_inicio);

      for (const g of targets) {
        const inv = [...this.invitations.values()].find((i) => i.guest_id === g.id);
        if (!inv) continue;
        g.estado_envio = "enviado";
        g.updated_at = nowIso;

        for (const canal of canalesActivos) {
          if (g[`baja_${canal}_en`]) continue; // baja del invitado (FR8)
          const addr =
            canal === "sms"
              ? g.telefono_cifrado
                ? this._dec(g.telefono_cifrado)
                : null
              : g.email_cifrado
                ? this._dec(g.email_cifrado)
                : null;
          if (!addr) continue;

          const delivery = this._insertDeliveryIdempotent({
            eventId,
            invitationId: inv.id,
            reminderJobId: null,
            subjectId: g.id,
            normalizedAddr: addr,
            canal,
            plantilla: "invitacion",
            ventana: "envio_inicial",
            now: nowIso,
          });
          if (delivery.created) {
            entregasEncoladas += 1;
            this._pushOutbox({
              eventId,
              topic: "notifications",
              eventType: "invitation_delivery",
              canal,
              payload: {
                delivery_id: delivery.row.id,
                event_id: eventId,
                invitation_id: inv.id,
                guest_id: g.id,
                canal,
                plantilla: "invitacion",
                ventana: "envio_inicial",
              },
              tIngest: nowIso,
            });
          }

          // Recordatorios RSVP T-7d y T-1d por canal (RF-10, D11)
          for (const ventana of ["t_7d", "t_1d"]) {
            this._insertReminderJobIdempotent({
              eventId,
              guestId: g.id,
              workerReservationId: null,
              subjectId: g.id,
              normalizedAddr: addr,
              canal,
              plantilla: "recordatorio_rsvp",
              ventana,
              dispararEn: reminderTimes[ventana],
              now: nowIso,
            });
          }
        }
      }

      this._pushAudit({
        eventId,
        actorId,
        accion: "envio_disparado",
        entidad: "event",
        entidadId: eventId,
        motivo: `Envío de invitaciones (${alcance})`,
        ts: nowIso,
        detalle: { envio_id: envioId, destinatarios: targets.length, entregas_encoladas: entregasEncoladas },
      });

      return {
        envio_id: envioId,
        destinatarios: targets.length,
        entregas_encoladas: entregasEncoladas,
        canales: [...canalesActivos],
      };
    });
  }

  async dispatchInvitationResend({
    eventId,
    guestIds = [],
    canal = "ambos",
    ventana = "resend_1",
    canalesActivos = ["sms", "email"],
    actorId,
    now = new Date(),
  }) {
    return this.mutexes.send.run(eventId, async () => {
      const ev = this.events.get(eventId);
      if (!ev || ev.deleted_at) throw new AppError("NOT_FOUND", "Evento no encontrado");
      if (ev.estado !== "publicado" && ev.estado !== "en_curso") {
        throw new AppError("EVENT_STATE_INVALID", "Evento no admite envíos");
      }
      if (!/^resend_[1-9][0-9]*$/.test(String(ventana))) {
        throw validationError("ventana debe seguir patrón resend_<n>", "ventana");
      }
      if (!["sms", "email", "ambos"].includes(canal)) {
        throw validationError("canal inválido", "canal");
      }
      const selectedChannels =
        canal === "ambos" ? canalesActivos : canalesActivos.filter((c) => c === canal);

      const nowIso = toIso(now);
      const envioId = ulid();
      let entregasEncoladas = 0;

      for (const guestId of guestIds) {
        const g = this.guests.get(guestId);
        if (!g || g.event_id !== eventId || g.deleted_at) continue;
        const inv = [...this.invitations.values()].find((i) => i.guest_id === g.id);
        if (!inv) continue;

        for (const ch of selectedChannels) {
          if (g[`baja_${ch}_en`]) continue; // baja del invitado (FR8)
          const addr =
            ch === "sms"
              ? g.telefono_cifrado
                ? this._dec(g.telefono_cifrado)
                : null
              : g.email_cifrado
                ? this._dec(g.email_cifrado)
                : null;
          if (!addr) continue;

          const delivery = this._insertDeliveryIdempotent({
            eventId,
            invitationId: inv.id,
            reminderJobId: null,
            subjectId: g.id,
            normalizedAddr: addr,
            canal: ch,
            plantilla: "invitacion",
            ventana,
            now: nowIso,
          });
          if (delivery.created) {
            entregasEncoladas += 1;
            this._pushOutbox({
              eventId,
              topic: "notifications",
              eventType: "invitation_delivery",
              canal: ch,
              payload: {
                delivery_id: delivery.row.id,
                event_id: eventId,
                invitation_id: inv.id,
                guest_id: g.id,
                canal: ch,
                plantilla: "invitacion",
                ventana,
              },
              tIngest: nowIso,
            });
          }
        }
      }

      this._pushAudit({
        eventId,
        actorId,
        accion: "envio_disparado",
        entidad: "event",
        entidadId: eventId,
        motivo: `Reenvío explícito ${ventana}`,
        ts: nowIso,
        detalle: { envio_id: envioId, ventana, entregas_encoladas: entregasEncoladas },
      });

      return { envio_id: envioId, entregas_encoladas: entregasEncoladas };
    });
  }

  _insertDeliveryIdempotent({
    eventId,
    invitationId,
    reminderJobId,
    subjectId,
    normalizedAddr,
    canal,
    plantilla,
    ventana,
    now,
  }) {
    const destinatario = buildTr12Destinatario(subjectId, normalizedAddr, canal);
    for (const d of this.invitationDeliveries.values()) {
      if (d.destinatario === destinatario && d.plantilla === plantilla && d.ventana === ventana) {
        return { created: false, row: d };
      }
    }
    const row = {
      id: ulid(),
      event_id: eventId,
      invitation_id: invitationId,
      reminder_job_id: reminderJobId,
      destinatario,
      direccion_cifrada: this._enc(normalizedAddr),
      canal,
      plantilla,
      ventana,
      estado: "encolado",
      intentos: 0,
      estado_en: now,
      pii_anonimizada_en: null,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    this.invitationDeliveries.set(row.id, row);
    return { created: true, row };
  }

  _insertReminderJobIdempotent({
    eventId,
    guestId,
    workerReservationId,
    subjectId,
    normalizedAddr,
    canal,
    plantilla,
    ventana,
    dispararEn,
    now,
  }) {
    const destinatario = buildTr12Destinatario(subjectId, normalizedAddr, canal);
    for (const j of this.reminderJobs.values()) {
      if (j.destinatario === destinatario && j.plantilla === plantilla && j.ventana === ventana) {
        return { created: false, row: j };
      }
    }
    const row = {
      id: ulid(),
      event_id: eventId,
      guest_id: guestId,
      worker_reservation_id: workerReservationId,
      destinatario,
      canal,
      direccion_cifrada: this._enc(normalizedAddr),
      plantilla,
      ventana,
      disparar_en: dispararEn,
      estado: "programado",
      motivo_cancelacion: null,
      pii_anonimizada_en: null,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    this.reminderJobs.set(row.id, row);
    return { created: true, row };
  }

  async listDeliveries({ eventId, estado = null, canal = null, limit = 20, cursor = null }) {
    const items = [];
    for (const d of this.invitationDeliveries.values()) {
      if (d.event_id !== eventId) continue;
      if (estado && d.estado !== estado) continue;
      if (canal && d.canal !== canal) continue;
      const inv = d.invitation_id ? this.invitations.get(d.invitation_id) : null;
      items.push({
        delivery_id: d.id,
        invitation_id: d.invitation_id,
        guest_id: inv?.guest_id || null,
        canal: d.canal,
        plantilla: d.plantilla,
        ventana: d.ventana,
        estado: d.estado,
        intentos: d.intentos,
        estado_en: d.estado_en,
      });
    }
    return paginateArray(items, limit, cursor);
  }

  async regenerateInvitationTokens({
    eventId,
    invitationId,
    qrSigner,
    objectStorage,
    assetsBucket = process.env.ASSETS_BUCKET || "orquesta-assets",
  }) {
    const inv = this.invitations.get(invitationId);
    if (!inv || inv.event_id !== eventId || inv.deleted_at) {
      throw new AppError("NOT_FOUND", "Invitación no encontrada");
    }
    const now = new Date().toISOString();
    const newVersion = inv.token_version + 1;
    const { key_id: keyId } = await qrSigner.getPublicKey();
    const rsvpRaw = generateOpaqueToken("rsvp_", 24);
    const qrToken = await qrSigner.signJws(
      {
        typ: "checkin_qr",
        invitation_id: inv.id,
        event_id: eventId,
        token_version: newVersion,
        key_id: keyId,
      },
      keyId
    );
    const qrS3Key = `qr/${inv.id}_v${newVersion}.png`;
    const pngBuf = await renderQrPng(qrToken);
    await objectStorage.putObject({
      bucket: assetsBucket,
      key: qrS3Key,
      body: pngBuf,
      contentType: "image/png",
      cacheControl: "public, s-maxage=300, stale-while-revalidate=86400",
    });

    inv.token_version = newVersion;
    inv.rsvp_token_hash = sha256Hex(rsvpRaw);
    inv.rsvp_token_cifrado = this._enc(rsvpRaw);
    inv.checkin_key_id = keyId;
    inv.qr_token_cifrado = this._enc(qrToken);
    inv.qr_s3_key = qrS3Key;
    inv.qr_emitido_en = now;
    inv.updated_at = now;

    for (const sess of this.scanSessions.values()) {
      if (sess.event_id === eventId && !sess.deleted_at) {
        sess.roster_version += 1;
      }
    }

    return {
      invitation_id: inv.id,
      token_version: inv.token_version,
      rsvp_token: rsvpRaw,
      qr_token: qrToken,
    };
  }

  async getDeliveryContext(deliveryId) {
    const d = this.invitationDeliveries.get(deliveryId);
    if (!d) return null;
    const inv = d.invitation_id ? this.invitations.get(d.invitation_id) : null;
    const guest = inv ? this.guests.get(inv.guest_id) : null;
    const event = this.events.get(d.event_id);
    const reminderJob = d.reminder_job_id ? this.reminderJobs.get(d.reminder_job_id) : null;
    return {
      delivery: {
        ...d,
        direccion_plana: d.direccion_cifrada ? this._dec(d.direccion_cifrada) : null,
      },
      invitation: inv
        ? {
            ...inv,
            rsvp_token_plano: inv.rsvp_token_cifrado ? this._dec(inv.rsvp_token_cifrado) : null,
            qr_token_plano: inv.qr_token_cifrado ? this._dec(inv.qr_token_cifrado) : null,
          }
        : null,
      guest: guest ? { ...guest } : null,
      event: event ? { ...event } : null,
      reminderJob: reminderJob ? { ...reminderJob } : null,
    };
  }

  async markDeliveryResult({ deliveryId, success, skipCancelled = false, now = new Date() }) {
    const d = this.invitationDeliveries.get(deliveryId);
    if (!d) return null;
    if (d.estado === "entregado" || d.estado === "rebotado") {
      return { delivery: { ...d }, terminal: true };
    }
    const nowIso = toIso(now);
    if (skipCancelled) {
      if (d.reminder_job_id) {
        const rj = this.reminderJobs.get(d.reminder_job_id);
        if (rj && rj.estado === "programado") {
          rj.estado = "cancelado";
          rj.motivo_cancelacion = "invitado_de_baja";
          rj.updated_at = nowIso;
        }
      }
      return { delivery: { ...d }, skipped: true };
    }

    if (success) {
      d.estado = "entregado";
      d.estado_en = nowIso;
      d.updated_at = nowIso;
    } else {
      d.intentos = Math.min(3, d.intentos + 1);
      d.estado_en = nowIso;
      d.updated_at = nowIso;
      if (d.intentos >= 3) {
        d.estado = "rebotado";
      }
    }

    const partialCount = this._countPartialDeliveries(d.event_id);
    this._pushOutbox({
      eventId: d.event_id,
      topic: "projection",
      eventType: "delivery_status_updated",
      payload: { entregas_parciales_set: partialCount },
      tIngest: nowIso,
    });

    return {
      delivery: { ...d },
      rebotado: d.estado === "rebotado",
      retryable: !success && d.estado !== "rebotado",
    };
  }

  _countPartialDeliveries(eventId) {
    // Agrupar entregas por (invitation_id, plantilla, ventana)
    const groups = new Map();
    for (const d of this.invitationDeliveries.values()) {
      if (d.event_id !== eventId || !d.invitation_id) continue;
      const key = `${d.invitation_id}:${d.plantilla}:${d.ventana}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(d);
    }
    let partial = 0;
    for (const list of groups.values()) {
      const hasDelivered = list.some((x) => x.estado === "entregado");
      const hasFailedOrUnknown = list.some((x) => x.estado === "rebotado" || x.estado === "indeterminado");
      if (hasDelivered && hasFailedOrUnknown) partial += 1;
    }
    return partial;
  }

  // ==========================================================================
  // Página pública de invitación y RSVP (RF-05, RF-18, TR-07, NFR-02)
  // ==========================================================================
  async getPublicEventSummary(eventId) {
    const ev = this.events.get(eventId);
    if (!ev || ev.deleted_at) throw new AppError("NOT_FOUND", "Evento no encontrado");
    const venue = this.venues.get(ev.venue_id);
    return {
      event_id: ev.id,
      nombre: ev.nombre,
      fecha: ev.fecha,
      inicio: ev.ventana_inicio,
      fin: ev.ventana_fin,
      timezone: ev.timezone,
      venue: venue ? { nombre: venue.nombre, zona: venue.zona, direccion: venue.direccion } : null,
    };
  }

  _resolveInvitationForRsvp(rawToken) {
    if (typeof rawToken !== "string" || !rawToken) {
      throw new AppError("TOKEN_INVALIDO", "Token inválido");
    }
    // Detectar token de check-in usado en ruta de RSVP (TR-07, AC-06)
    if (rawToken.split(".").length === 3 || rawToken.startsWith("chk_")) {
      throw new AppError(
        "TOKEN_TIPO_INCORRECTO",
        "El token de check-in no puede usarse para RSVP"
      );
    }
    const hash = sha256Hex(rawToken);
    let inv = null;
    for (const candidate of this.invitations.values()) {
      if (candidate.rsvp_token_hash === hash) {
        inv = candidate;
        break;
      }
    }
    if (!inv || inv.pii_anonimizada_en) {
      throw new AppError("TOKEN_INVALIDO", "Invitación no encontrada");
    }
    const guest = this.guests.get(inv.guest_id);
    if (inv.rsvp_revocado_en || inv.deleted_at || !guest || guest.deleted_at) {
      throw new AppError("INVITACION_REVOCADA", "La invitación fue revocada");
    }
    const ev = this.events.get(inv.event_id);
    const venue = ev ? this.venues.get(ev.venue_id) : null;
    return { inv, guest, ev, venue };
  }

  async getPublicInvitationByToken({ rawToken, objectStorage }) {
    const { inv, guest, ev, venue } = this._resolveInvitationForRsvp(rawToken);
    const activeRsvp = [...this.rsvpResponses.values()].find(
      (r) => r.invitation_id === inv.id && !r.superseded_at
    );
    const qrToken = inv.qr_token_cifrado ? this._dec(inv.qr_token_cifrado) : null;
    const pngUrl = inv.qr_s3_key ? objectStorage.getPublicUrl({ key: inv.qr_s3_key }) : null;
    const sa = [...this.seatAssignments.values()].find(
      (x) => x.event_id === inv.event_id && x.guest_id === guest.id && (x.estado === "confirmado" || x.estado === "pendiente")
    );
    const table = sa ? this.eventTables.get(sa.table_id) : null;

    return {
      // Solo el nombre y su mesa: el invitado ya tiene el enlace, no exponemos correo ni teléfono.
      invitado: {
        nombre: guest.nombre,
        mesa: table && !table.deleted_at ? { numero: table.numero, nombre: table.nombre || null } : null,
      },
      respuesta: activeRsvp ? activeRsvp.respuesta : null,
      respondido_en: activeRsvp ? activeRsvp.respondido_en : null,
      qr: { token: qrToken, png_url: pngUrl, codigo_corto: inv.codigo_corto },
      evento: {
        event_id: ev.id,
        nombre: ev.nombre,
        fecha: ev.fecha,
        inicio: ev.ventana_inicio,
        fin: ev.ventana_fin,
        timezone: ev.timezone,
        lugar: venue?.nombre || null,
        direccion: venue?.direccion || null,
      },
      bajas: { sms: Boolean(guest?.baja_sms_en), email: Boolean(guest?.baja_email_en) },
    };
  }

  /** Baja del invitado por canal (README FR8). Idempotente; cancela recordatorios pendientes del canal. */
  async unsubscribeGuest({ rawToken, canal, now = new Date() }) {
    if (!["sms", "email", "ambos"].includes(canal)) throw validationError("canal debe ser sms, email o ambos", "canal");
    if (typeof rawToken !== "string" || rawToken.split(".").length === 3) {
      throw new AppError("TOKEN_TIPO_INCORRECTO", "El token de check-in no puede usarse aquí");
    }
    const hash = sha256Hex(rawToken);
    const inv = [...this.invitations.values()].find((i) => i.rsvp_token_hash === hash && !i.pii_anonimizada_en);
    if (!inv) throw new AppError("TOKEN_INVALIDO", "Invitación no encontrada");
    const guest = this.guests.get(inv.guest_id);
    const canales = canal === "ambos" ? ["sms", "email"] : [canal];
    const nowIso = toIso(now);
    for (const c of canales) guest[`baja_${c}_en`] = guest[`baja_${c}_en`] || nowIso;
    for (const job of this.reminderJobs.values()) {
      if (job.guest_id === guest.id && job.estado === "programado" && canales.includes(job.canal)) {
        job.estado = "cancelado";
        job.motivo_cancelacion = "invitado_de_baja";
        job.updated_at = nowIso;
      }
    }
    return { bajas: { sms: Boolean(guest.baja_sms_en), email: Boolean(guest.baja_email_en) } };
  }

  async submitPublicRsvp({ rawToken, respuesta, objectStorage, now = new Date() }) {
    if (respuesta !== "confirma" && respuesta !== "declina") {
      throw validationError("respuesta debe ser 'confirma' o 'declina'", "respuesta");
    }
    const { inv, guest, ev, venue } = this._resolveInvitationForRsvp(rawToken);

    return this.mutexes.rsvp.run(inv.id, async () => {
      const nowMs = new Date(now).getTime();
      let prev = null;
      for (const r of this.rsvpResponses.values()) {
        if (r.invitation_id === inv.id && !r.superseded_at) {
          prev = r;
          break;
        }
      }

      let respondidoEnMs = nowMs;
      let supersededAtIso = null;
      if (prev) {
        const prevMs = new Date(prev.respondido_en).getTime();
        const supMs = Math.max(nowMs, prevMs + 1);
        supersededAtIso = new Date(supMs).toISOString();
        prev.superseded_at = supersededAtIso;
        prev.updated_at = supersededAtIso;
        respondidoEnMs = supMs;
      }
      const respondidoEnIso = new Date(respondidoEnMs).toISOString();

      const nextResp = {
        id: ulid(),
        event_id: ev.id,
        invitation_id: inv.id,
        respuesta,
        respondido_en: respondidoEnIso,
        superseded_at: null,
        created_at: respondidoEnIso,
        updated_at: respondidoEnIso,
        deleted_at: null,
      };
      this.rsvpResponses.set(nextResp.id, nextResp);

      // Cancelar recordatorios pendientes de RSVP (RF-10, AC-12); nunca reactivar cancelados/consumidos
      let recordatoriosCancelados = 0;
      for (const job of this.reminderJobs.values()) {
        if (
          job.event_id === ev.id &&
          job.guest_id === guest.id &&
          job.plantilla === "recordatorio_rsvp" &&
          job.estado === "programado"
        ) {
          job.estado = "cancelado";
          job.motivo_cancelacion = "rsvp_registrado";
          job.updated_at = respondidoEnIso;
          recordatoriosCancelados += 1;
        }
      }

      // Si declina, liberar asiento y devolver capacidad; si confirma, promover asiento pendiente a confirmado (RF-12, AC-14)
      await this.mutexes.seating.run(ev.id, async () => {
        for (const sa of this.seatAssignments.values()) {
          if (sa.event_id !== ev.id || sa.guest_id !== guest.id) continue;
          if (respuesta === "declina" && (sa.estado === "confirmado" || sa.estado === "pendiente")) {
            sa.estado = "liberado";
            sa.ocupa_capacidad = false;
            sa.liberado_en = respondidoEnIso;
            sa.motivo_liberacion = "rsvp_declina";
            sa.updated_at = respondidoEnIso;
          } else if (respuesta === "confirma" && sa.estado === "pendiente") {
            sa.estado = "confirmado";
            sa.updated_at = respondidoEnIso;
          }
        }
      });

      // Delta exacto para proyección (TR-05)
      let confirmadosDelta = 0;
      if (!prev && respuesta === "confirma") confirmadosDelta = 1;
      else if (prev && prev.respuesta !== "confirma" && respuesta === "confirma") confirmadosDelta = 1;
      else if (prev && prev.respuesta === "confirma" && respuesta === "declina") confirmadosDelta = -1;

      if (confirmadosDelta !== 0) {
        this._pushOutbox({
          eventId: ev.id,
          topic: "projection",
          eventType: "rsvp_delta",
          payload: { confirmados_delta: confirmadosDelta },
          tIngest: respondidoEnIso,
        });
      }

      const qrToken = inv.qr_token_cifrado ? this._dec(inv.qr_token_cifrado) : null;
      const pngUrl = inv.qr_s3_key ? objectStorage.getPublicUrl({ key: inv.qr_s3_key }) : null;

      return {
        isChange: Boolean(prev),
        body: {
          respuesta: nextResp.respuesta,
          respondido_en: nextResp.respondido_en,
          superseded_at: supersededAtIso,
          qr: { token: qrToken, png_url: pngUrl, codigo_corto: inv.codigo_corto },
          recordatorios_cancelados: recordatoriosCancelados,
          evento: {
            event_id: ev.id,
            nombre: ev.nombre,
            fecha: ev.fecha,
            inicio: ev.ventana_inicio,
            fin: ev.ventana_fin,
            timezone: ev.timezone,
            lugar: venue?.nombre || null,
            direccion: venue?.direccion || null,
          },
        },
      };
    });
  }

  // ==========================================================================
  // Tablero, Outbox y Projector (RF-06, NFR-03, NFR-10, TR-05, TR-13, TR-18)
  // ==========================================================================
  async getDashboard({ userId, limit = 25, cursor = null, now = new Date() }) {
    const limitNum = Number(limit);
    if (!Number.isInteger(limitNum) || limitNum < 1 || limitNum > 25) {
      throw validationError("limit en dashboard debe estar entre 1 y 25", "limit");
    }
    const nowMs = new Date(now).getTime();
    const nowIso = toIso(now);

    const memberEventIds = [];
    for (const m of this.eventMemberships.values()) {
      if (m.user_id === userId && !m.deleted_at) {
        memberEventIds.push(m.event_id);
      }
    }

    const activeEvents = memberEventIds
      .map((id) => this.events.get(id))
      .filter((ev) => ev && !ev.deleted_at)
      .sort((a, b) => (a.ventana_inicio < b.ventana_inicio ? -1 : 1));

    const paged = paginateArray(activeEvents, limitNum, cursor, 25);

    const items = paged.items.map((ev) => {
      const counters = this.eventCounters.get(ev.id) || {
        invitados: 0,
        confirmados: 0,
        asistentes: 0,
        aun_no_llegaron: 0,
        entregas_parciales: 0,
        ultimo_t_ingest: null,
        updated_at: nowIso,
      };
      const syncRows = [...this.deviceSyncStates.values()].filter((s) => s.event_id === ev.id);
      const pendientes = deriveSyncPendingState(syncRows, nowMs);
      const tIngest = counters.ultimo_t_ingest;
      const tVisible = counters.updated_at || nowIso;
      const lagMs = tIngest
        ? Math.max(0, new Date(tVisible).getTime() - new Date(tIngest).getTime())
        : 0;

      if (tIngest && this.metrics) {
        this.metrics.lagFrescura(ev.id, lagMs);
      }

      const noShow =
        ev.estado === "cerrado" ? Math.max(counters.invitados - counters.asistentes, 0) : null;

      return {
        event_id: ev.id,
        nombre: ev.nombre,
        estado: ev.estado,
        contadores: {
          invitados: counters.invitados,
          confirmados: counters.confirmados,
          asistentes: counters.asistentes,
          aun_no_llegaron: Math.max(counters.invitados - counters.asistentes, 0),
          pendientes_sincronizar: pendientes.valor,
          entregas_parciales: counters.entregas_parciales,
        },
        no_show: noShow,
        pendientes,
        frescura: {
          t_ingest: tIngest,
          t_visible: tVisible,
          lag_ms: lagMs,
          lag_p95_ms: lagMs,
        },
      };
    });

    return {
      generado_en: nowIso,
      next_cursor: paged.next_cursor,
      items,
    };
  }

  async fetchPendingOutbox(limit = 100) {
    return this.outboxEvents.filter((e) => !e.published_at).slice(0, limit);
  }

  async markOutboxPublished(ids, now = new Date()) {
    const idSet = new Set(ids);
    const nowIso = toIso(now);
    for (const e of this.outboxEvents) {
      if (idSet.has(e.id) && !e.published_at) {
        e.published_at = nowIso;
      }
    }
  }

  async applyProjectionBatch(messages, now = new Date()) {
    const nowIso = toIso(now);
    const grouped = new Map();

    for (const msg of messages) {
      const outboxId = msg.outbox_event_id || msg.id;
      if (outboxId && this.projectorApplied.has(outboxId)) continue;
      if (outboxId) this.projectorApplied.add(outboxId);

      const evId = msg.event_id;
      if (!evId) continue;

      if (!grouped.has(evId)) {
        grouped.set(evId, {
          invitados: 0,
          confirmados: 0,
          asistentes: 0,
          entregasParcialesDelta: 0,
          entregasParcialesSet: null,
          maxTIngest: null,
        });
      }
      const acc = grouped.get(evId);
      const p = msg.payload || {};
      acc.invitados += Number(p.invitados_delta || 0);
      acc.confirmados += Number(p.confirmados_delta || 0);
      acc.asistentes += Number(p.asistentes_delta || 0);
      acc.entregasParcialesDelta += Number(p.entregas_parciales_delta || 0);
      if (p.entregas_parciales_set !== undefined && p.entregas_parciales_set !== null) {
        acc.entregasParcialesSet = Number(p.entregas_parciales_set);
      }
      if (msg.t_ingest) {
        if (!acc.maxTIngest || new Date(msg.t_ingest) > new Date(acc.maxTIngest)) {
          acc.maxTIngest = msg.t_ingest;
        }
      }
    }

    for (const [eventId, delta] of grouped.entries()) {
      const c = this.eventCounters.get(eventId) || {
        event_id: eventId,
        invitados: 0,
        confirmados: 0,
        asistentes: 0,
        aun_no_llegaron: 0,
        entregas_parciales: 0,
        ultimo_t_ingest: null,
        updated_at: nowIso,
      };
      c.invitados = Math.max(0, c.invitados + delta.invitados);
      c.confirmados = Math.max(0, c.confirmados + delta.confirmados);
      c.asistentes = Math.max(0, c.asistentes + delta.asistentes);
      c.aun_no_llegaron = Math.max(0, c.invitados - c.asistentes);
      c.entregas_parciales =
        delta.entregasParcialesSet !== null
          ? Math.max(0, delta.entregasParcialesSet)
          : Math.max(0, c.entregas_parciales + delta.entregasParcialesDelta);
      if (delta.maxTIngest) {
        if (!c.ultimo_t_ingest || new Date(delta.maxTIngest) > new Date(c.ultimo_t_ingest)) {
          c.ultimo_t_ingest = delta.maxTIngest;
        }
      }
      c.updated_at = nowIso;
      this.eventCounters.set(eventId, c);

      if (c.ultimo_t_ingest && this.metrics) {
        const lag = Math.max(0, new Date(nowIso).getTime() - new Date(c.ultimo_t_ingest).getTime());
        this.metrics.lagFrescura(eventId, lag);
      }
    }

    return { eventsUpdated: grouped.size };
  }

  // ==========================================================================
  // Mesas y Seating (RF-12, TR-10, AC-14)
  // ==========================================================================
  async createTable({ eventId, numero = null, nombre = null, capacidad, expectedVersion = null }) {
    return this.mutexes.seating.run(eventId, async () => {
    this._checkSeatingVersion(eventId, expectedVersion);
    const ev = this.events.get(eventId);
    if (!ev || ev.deleted_at) throw new AppError("NOT_FOUND", "Evento no encontrado");
    const cap = Number(capacidad);
    if (!Number.isInteger(cap) || cap <= 0) {
      throw validationError("capacidad debe ser entero > 0", "capacidad");
    }

    let num = numero !== null && numero !== undefined ? Number(numero) : null;
    if (num === null) {
      let maxNum = 0;
      for (const t of this.eventTables.values()) {
        if (t.event_id === eventId && !t.deleted_at && t.numero > maxNum) maxNum = t.numero;
      }
      num = maxNum + 1;
    } else if (!Number.isInteger(num) || num <= 0) {
      throw validationError("numero debe ser entero > 0", "numero");
    }

    for (const t of this.eventTables.values()) {
      if (t.event_id === eventId && !t.deleted_at && t.numero === num) {
        throw new AppError("EVENT_STATE_INVALID", `Ya existe la mesa número ${num}`);
      }
    }

    const now = new Date().toISOString();
    const table = {
      id: ulid(),
      event_id: eventId,
      numero: num,
      nombre: nombre ? String(nombre).trim() : `Mesa ${num}`,
      capacidad: cap,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    this.eventTables.set(table.id, table);
    const planVersion = this._bumpSeatingVersion(eventId);
    return { id: table.id, event_id: eventId, numero: table.numero, nombre: table.nombre, capacidad: table.capacidad, ocupacion: 0, plan_version: planVersion };
    });
  }

  /** Versión del plano de mesas (control optimista FR7): sube 1 por cada edición del planner. */
  async getSeatingVersion(eventId) {
    return this.seatingPlanVersions.get(eventId) || 0;
  }

  _checkSeatingVersion(eventId, expectedVersion) {
    const current = this.seatingPlanVersions.get(eventId) || 0;
    if (expectedVersion !== null && expectedVersion !== undefined && Number(expectedVersion) !== current) {
      throw new AppError("SEATING_VERSION_CONFLICT", "El plano cambió desde tu última lectura; recarga y reintenta", {
        version_esperada: Number(expectedVersion),
        version_actual: current,
      });
    }
    return current;
  }

  _bumpSeatingVersion(eventId) {
    const next = (this.seatingPlanVersions.get(eventId) || 0) + 1;
    this.seatingPlanVersions.set(eventId, next);
    return next;
  }

  async listTables({ eventId, limit = 20, cursor = null }) {
    const tables = [...this.eventTables.values()]
      .filter((t) => t.event_id === eventId && !t.deleted_at)
      .sort((a, b) => a.numero - b.numero)
      .map((t) => ({
        id: t.id,
        numero: t.numero,
        nombre: t.nombre,
        capacidad: t.capacidad,
        ocupacion: this._countTableOccupancy(eventId, t.id),
      }));
    return { ...paginateArray(tables, limit, cursor), plan_version: await this.getSeatingVersion(eventId) };
  }

  _countTableOccupancy(eventId, tableId) {
    let count = 0;
    for (const sa of this.seatAssignments.values()) {
      if (sa.event_id === eventId && sa.table_id === tableId && sa.ocupa_capacidad) {
        count += 1;
      }
    }
    return count;
  }

  async assignSeat({ eventId, guestId, tableId, actorId, expectedVersion = null }) {
    return this.mutexes.seating.run(eventId, async () => {
      const guest = this.guests.get(guestId);
      if (!guest || guest.event_id !== eventId || guest.deleted_at) {
        throw new AppError("NOT_FOUND", "Invitado no encontrado en este evento");
      }
      const table = this.eventTables.get(tableId);
      if (!table || table.event_id !== eventId || table.deleted_at) {
        throw new AppError("NOT_FOUND", "Mesa no encontrada en este evento");
      }

      // Verificar si ya está asignado a esa misma mesa -> idempotente (TR-10, AC-14)
      let current = null;
      for (const sa of this.seatAssignments.values()) {
        if (
          sa.event_id === eventId &&
          sa.guest_id === guestId &&
          (sa.estado === "confirmado" || sa.estado === "pendiente")
        ) {
          current = sa;
          break;
        }
      }
      if (current && current.table_id === tableId) {
        return {
          created: false,
          body: {
            id: current.id,
            guest_id: guestId,
            table_id: tableId,
            estado: "asignado",
            estado_asiento: current.estado,
            plan_version: this.seatingPlanVersions.get(eventId) || 0,
          },
        };
      }
      // Control de versión optimista (FR7): se valida antes de cualquier escritura.
      this._checkSeatingVersion(eventId, expectedVersion);

      // Verificar si el invitado declinó RSVP
      const inv = [...this.invitations.values()].find((i) => i.guest_id === guestId);
      const activeRsvp = inv
        ? [...this.rsvpResponses.values()].find((r) => r.invitation_id === inv.id && !r.superseded_at)
        : null;
      if (activeRsvp?.respuesta === "declina") {
        throw new AppError("EVENT_STATE_INVALID", "El invitado declinó su asistencia");
      }

      // Verificar capacidad dentro de la transacción (TR-10, AC-14)
      const occ = this._countTableOccupancy(eventId, tableId);
      if (occ >= table.capacidad) {
        throw new AppError("MESA_SIN_CAPACIDAD", "La mesa alcanzó su capacidad máxima", {
          table_id: tableId,
          capacidad: table.capacidad,
          ocupacion: occ,
        });
      }

      const now = new Date().toISOString();
      if (current) {
        current.estado = "liberado";
        current.ocupa_capacidad = false;
        current.liberado_en = now;
        current.motivo_liberacion = "reasignado";
        current.updated_at = now;
      }

      const seatEstado = activeRsvp?.respuesta === "confirma" ? "confirmado" : "pendiente";
      const seat = {
        id: ulid(),
        event_id: eventId,
        guest_id: guestId,
        table_id: tableId,
        estado: seatEstado,
        ocupa_capacidad: true,
        asignado_en: now,
        liberado_en: null,
        motivo_liberacion: null,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      };
      this.seatAssignments.set(seat.id, seat);

      if (current) {
        this._pushAudit({
          eventId,
          actorId,
          accion: "asiento_movido",
          entidad: "seat_assignment",
          entidadId: seat.id,
          motivo: "Reasignación de mesa",
          ts: now,
          detalle: { from_table_id: current.table_id, to_table_id: tableId, guest_id: guestId },
        });
      }

      const planVersion = this._bumpSeatingVersion(eventId);
      return {
        created: !current,
        body: {
          id: seat.id,
          guest_id: guestId,
          table_id: tableId,
          estado: "asignado",
          estado_asiento: seat.estado,
          plan_version: planVersion,
        },
      };
    });
  }

  async releaseSeat({ eventId, guestId, expectedVersion = null }) {
    return this.mutexes.seating.run(eventId, async () => {
      const guest = this.guests.get(guestId);
      if (!guest || guest.event_id !== eventId) {
        throw new AppError("NOT_FOUND", "Invitado no encontrado");
      }
      const active = [...this.seatAssignments.values()].some(
        (sa) => sa.event_id === eventId && sa.guest_id === guestId && (sa.estado === "confirmado" || sa.estado === "pendiente")
      );
      // Un no-op (nada que liberar) no consume versión ni genera conflicto, igual que en PG.
      if (active) this._checkSeatingVersion(eventId, expectedVersion);
      const now = new Date().toISOString();
      let released = 0;
      for (const sa of this.seatAssignments.values()) {
        if (
          sa.event_id === eventId &&
          sa.guest_id === guestId &&
          (sa.estado === "confirmado" || sa.estado === "pendiente")
        ) {
          sa.estado = "liberado";
          sa.ocupa_capacidad = false;
          sa.liberado_en = now;
          sa.motivo_liberacion = "reasignado";
          sa.updated_at = now;
          released += 1;
        }
      }
      const planVersion = released > 0 ? this._bumpSeatingVersion(eventId) : this.seatingPlanVersions.get(eventId) || 0;
      return { liberados: released, plan_version: planVersion };
    });
  }

  async listUnseatedGuests({ eventId, limit = 20, cursor = null }) {
    const seated = new Set();
    for (const sa of this.seatAssignments.values()) {
      if (sa.event_id === eventId && (sa.estado === "confirmado" || sa.estado === "pendiente")) {
        seated.add(sa.guest_id);
      }
    }
    const items = [];
    for (const g of this.guests.values()) {
      if (g.event_id !== eventId || g.deleted_at || seated.has(g.id)) continue;
      const inv = [...this.invitations.values()].find((i) => i.guest_id === g.id);
      const rsvp = inv
        ? [...this.rsvpResponses.values()].find((r) => r.invitation_id === inv.id && !r.superseded_at)
        : null;
      items.push({
        guest_id: g.id,
        nombre: g.nombre,
        estado_rsvp: rsvp?.respuesta || null,
      });
    }
    return paginateArray(items, limit, cursor);
  }

  // ==========================================================================
  // Trabajadores, Disponibilidad y Contratación (RF-07,08,09,17,21,22, TR-08)
  // ==========================================================================
  async createWorkerProfile({ userId, data, now = new Date() }) {
    const existing = await this.getWorkerProfileByUserId(userId);
    if (existing) {
      throw new AppError("EMAIL_YA_REGISTRADA", "El usuario ya posee un perfil de trabajador");
    }
    const user = this.users.get(userId);
    if (!user || user.deleted_at) throw new AppError("NOT_FOUND", "Usuario no encontrado");
    if (!user.roles.includes("worker")) user.roles.push("worker");

    const validated = this._validateWorkerProfileInput(data, true);
    const nowIso = toIso(now);
    const wp = {
      id: ulid(),
      user_id: userId,
      tipo: validated.tipo,
      plazas_ofrecidas: validated.plazas_ofrecidas,
      nombre_publico: validated.nombre_publico,
      categorias: validated.categorias,
      servicios: validated.servicios,
      tarifa_modo: "fijo",
      tarifa_monto: validated.tarifa_monto,
      tarifa_moneda: validated.tarifa_moneda,
      tarifa_unidad: validated.tarifa_unidad,
      zonas: validated.zonas,
      radio_km: validated.radio_km,
      idiomas: validated.idiomas,
      anios_experiencia: validated.anios_experiencia,
      fotos: validated.fotos,
      referencias: validated.referencias,
      estado: "borrador",
      telefono_cifrado: validated.telefono_e164 ? this._enc(validated.telefono_e164) : null,
      telefono_hmac: validated.telefono_e164 ? this._hmac(validated.telefono_e164) : null,
      telefono_verificado_en: null,
      email_verificado_en: user.email_verificado_en,
      pii_anonimizada_en: null,
      created_at: nowIso,
      updated_at: nowIso,
      deleted_at: null,
    };
    this.workerProfiles.set(wp.id, wp);
    return this._formatOwnWorkerProfile(wp);
  }

  _validateWorkerProfileInput(data, isCreate = false) {
    const out = {};
    if (isCreate || data.tipo !== undefined) {
      if (!["persona", "empresa"].includes(data.tipo)) {
        throw validationError("tipo debe ser 'persona' o 'empresa'", "tipo");
      }
      out.tipo = data.tipo;
    }
    if (isCreate || data.plazas_ofrecidas !== undefined) {
      const plazas = data.plazas_ofrecidas === undefined ? 1 : Number(data.plazas_ofrecidas);
      if (!Number.isInteger(plazas) || plazas < 1 || plazas > 50) {
        throw validationError("plazas_ofrecidas debe estar entre 1 y 50", "plazas_ofrecidas");
      }
      if ((out.tipo || data.tipo) === "persona" && plazas !== 1) {
        throw validationError("Un perfil persona solo puede declarar 1 plaza", "plazas_ofrecidas");
      }
      out.plazas_ofrecidas = plazas;
    }
    if (isCreate || data.nombre_publico !== undefined) {
      const n = String(data.nombre_publico || "").trim();
      if (!n || n.length > 120) throw validationError("nombre_publico inválido", "nombre_publico");
      out.nombre_publico = n;
    }
    if (isCreate || data.categorias !== undefined) {
      if (
        !Array.isArray(data.categorias) ||
        data.categorias.length < 1 ||
        data.categorias.length > 3 ||
        !data.categorias.every(isValidCategoria)
      ) {
        throw validationError("categorias debe tener 1..3 categorías válidas", "categorias");
      }
      out.categorias = [...new Set(data.categorias)];
    }
    if (isCreate || data.servicios !== undefined) {
      const srv = data.servicios || [];
      const cats = out.categorias || data.categorias || [];
      if (!Array.isArray(srv) || (cats.length > 0 && !srv.every((s) => isServicioAllowedForCategorias(s, cats)))) {
        throw validationError("servicios debe ser subconjunto de categorias", "servicios");
      }
      out.servicios = [...new Set(srv)];
    }
    if (isCreate || data.zonas !== undefined) {
      if (
        !Array.isArray(data.zonas) ||
        data.zonas.length < 1 ||
        data.zonas.length > 5 ||
        !data.zonas.every(isValidZona)
      ) {
        throw validationError("zonas debe tener 1..5 zonas válidas", "zonas");
      }
      out.zonas = [...new Set(data.zonas)];
    }
    if (data.tarifa !== undefined) {
      if (data.tarifa === null) {
        out.tarifa_monto = null;
        out.tarifa_moneda = null;
        out.tarifa_unidad = null;
      } else {
        const monto = Number(data.tarifa.monto);
        const moneda = String(data.tarifa.moneda || "MXN").toUpperCase();
        const unidad = data.tarifa.unidad;
        if (!Number.isFinite(monto) || monto <= 0) throw validationError("tarifa.monto > 0 requerido", "tarifa");
        if (!/^[A-Z]{3}$/.test(moneda)) throw validationError("tarifa.moneda ISO 4217", "tarifa");
        if (!["hora", "persona_hora", "evento"].includes(unidad)) {
          throw validationError("tarifa.unidad inválida", "tarifa");
        }
        out.tarifa_monto = Number(monto.toFixed(2));
        out.tarifa_moneda = moneda;
        out.tarifa_unidad = unidad;
      }
    } else if (isCreate) {
      out.tarifa_monto = null;
      out.tarifa_moneda = null;
      out.tarifa_unidad = null;
    }
    if (data.radio_km !== undefined) {
      if (data.radio_km === null) out.radio_km = null;
      else {
        const r = Number(data.radio_km);
        if (!Number.isFinite(r) || r <= 0 || r > 150) {
          throw validationError("radio_km debe estar entre 0 y 150", "radio_km");
        }
        out.radio_km = Number(r.toFixed(2));
      }
    } else if (isCreate) {
      out.radio_km = null;
    }
    if (isCreate || data.idiomas !== undefined) {
      out.idiomas = Array.isArray(data.idiomas) ? [...data.idiomas] : [];
    }
    const exp = data.anios_experiencia ?? data["años_experiencia"];
    if (isCreate || exp !== undefined) {
      if (exp === undefined || exp === null) out.anios_experiencia = null;
      else {
        const e = Number(exp);
        if (!Number.isInteger(e) || e < 0 || e > 70) {
          throw validationError("anios_experiencia inválido", "anios_experiencia");
        }
        out.anios_experiencia = e;
      }
    }
    if (isCreate || data.fotos !== undefined) {
      const f = data.fotos || [];
      if (!Array.isArray(f) || f.length > 3) throw validationError("máximo 3 fotos", "fotos");
      out.fotos = [...f];
    }
    if (isCreate || data.referencias !== undefined) {
      const ref = data.referencias || [];
      if (!Array.isArray(ref) || ref.length > 3) {
        throw validationError("máximo 3 referencias", "referencias");
      }
      out.referencias = [...ref];
    }
    if (data.telefono_e164 !== undefined) {
      if (data.telefono_e164 === null) {
        out.telefono_e164 = null;
      } else {
        const p = normalizePhoneE164(data.telefono_e164);
        if (!p) throw validationError("telefono_e164 inválido", "telefono_e164");
        out.telefono_e164 = p;
      }
    }
    return out;
  }

  _formatOwnWorkerProfile(wp) {
    let completed = 0;
    for (const r of this.workerReservations.values()) {
      if (r.worker_id === wp.id && r.estado === "completada" && !r.deleted_at) completed += 1;
    }
    return {
      worker_id: wp.id,
      user_id: wp.user_id,
      tipo: wp.tipo,
      plazas_ofrecidas: wp.plazas_ofrecidas,
      nombre_publico: wp.nombre_publico,
      categorias: [...wp.categorias],
      servicios: [...wp.servicios],
      tarifa: wp.tarifa_monto
        ? {
            modo: wp.tarifa_modo,
            monto: Number(wp.tarifa_monto),
            moneda: wp.tarifa_moneda,
            unidad: wp.tarifa_unidad,
          }
        : null,
      zonas: [...wp.zonas],
      radio_km: wp.radio_km,
      idiomas: [...wp.idiomas],
      anios_experiencia: wp.anios_experiencia,
      fotos: [...wp.fotos],
      referencias: [...wp.referencias],
      estado: wp.estado,
      telefono_e164: wp.telefono_cifrado ? this._dec(wp.telefono_cifrado) : null,
      email_verificado_en: wp.email_verificado_en,
      telefono_verificado_en: wp.telefono_verificado_en,
      eventos_completados: completed,
    };
  }

  async getWorkerProfileByUserId(userId) {
    for (const wp of this.workerProfiles.values()) {
      if (wp.user_id === userId && !wp.deleted_at) return this._formatOwnWorkerProfile(wp);
    }
    return null;
  }

  async getWorkerProfileById(workerId) {
    const wp = this.workerProfiles.get(workerId);
    if (!wp || wp.deleted_at) return null;
    return this._formatOwnWorkerProfile(wp);
  }

  async updateWorkerProfile({ userId, patch, now = new Date() }) {
    let wp = null;
    for (const candidate of this.workerProfiles.values()) {
      if (candidate.user_id === userId && !candidate.deleted_at) {
        wp = candidate;
        break;
      }
    }
    if (!wp) throw new AppError("NOT_FOUND", "Perfil de trabajador no encontrado");

    const v = this._validateWorkerProfileInput(
      { ...patch, categorias: patch.categorias ?? wp.categorias, tipo: patch.tipo ?? wp.tipo },
      false
    );

    if (v.tipo !== undefined) wp.tipo = v.tipo;
    if (v.plazas_ofrecidas !== undefined) wp.plazas_ofrecidas = v.plazas_ofrecidas;
    if (wp.tipo === "persona" && wp.plazas_ofrecidas !== 1) {
      throw validationError("persona debe tener plazas_ofrecidas = 1", "plazas_ofrecidas");
    }
    if (v.nombre_publico !== undefined) wp.nombre_publico = v.nombre_publico;
    if (patch.categorias !== undefined) wp.categorias = v.categorias;
    if (patch.servicios !== undefined) wp.servicios = v.servicios;
    if (patch.zonas !== undefined) wp.zonas = v.zonas;
    if (patch.tarifa !== undefined) {
      wp.tarifa_monto = v.tarifa_monto;
      wp.tarifa_moneda = v.tarifa_moneda;
      wp.tarifa_unidad = v.tarifa_unidad;
    }
    if (patch.radio_km !== undefined) wp.radio_km = v.radio_km;
    if (patch.idiomas !== undefined) wp.idiomas = v.idiomas;
    if (v.anios_experiencia !== undefined) wp.anios_experiencia = v.anios_experiencia;
    if (patch.fotos !== undefined) wp.fotos = v.fotos;
    if (patch.referencias !== undefined) wp.referencias = v.referencias;
    if (patch.telefono_e164 !== undefined) {
      const nextHmac = v.telefono_e164 ? this._hmac(v.telefono_e164) : null;
      if (nextHmac !== wp.telefono_hmac) {
        wp.telefono_verificado_en = null;
      }
      wp.telefono_cifrado = v.telefono_e164 ? this._enc(v.telefono_e164) : null;
      wp.telefono_hmac = nextHmac;
    }
    if (patch.estado !== undefined) {
      if (!["borrador", "publicado", "suspendido"].includes(patch.estado)) {
        throw validationError("estado inválido", "estado");
      }
      if (patch.estado === "publicado") {
        if (!wp.tarifa_monto || !wp.tarifa_moneda || !wp.tarifa_unidad || !wp.telefono_cifrado) {
          throw validationError(
            "Para publicar se requiere tarifa y teléfono",
            "estado"
          );
        }
      }
      wp.estado = patch.estado;
    }

    wp.updated_at = toIso(now);
    return this._formatOwnWorkerProfile(wp);
  }

  async setWorkerProfileState({ userId, estado, now = new Date() }) {
    let wp = null;
    for (const candidate of this.workerProfiles.values()) {
      if (candidate.user_id === userId && !candidate.deleted_at) {
        wp = candidate;
        break;
      }
    }
    if (!wp) throw new AppError("NOT_FOUND", "Perfil no encontrado");
    if (estado === "publicado") {
      if (!wp.email_verificado_en || !wp.telefono_verificado_en) {
        throw new AppError(
          "PROFILE_NOT_VERIFIED",
          "El perfil debe verificar email y teléfono por OTP antes de publicarse"
        );
      }
      if (!wp.tarifa_monto || !wp.tarifa_moneda || !wp.tarifa_unidad) {
        throw new AppError("TRABAJADOR_SIN_TARIFA", "Debe configurar una tarifa publicada");
      }
    }
    wp.estado = estado;
    wp.updated_at = toIso(now);
    return { estado: wp.estado };
  }

  async searchWorkers(filters) {
    const completedCounts = new Map();
    const acceptedReservations = [];
    for (const r of this.workerReservations.values()) {
      if (r.deleted_at) continue;
      if (r.estado === "completada") {
        completedCounts.set(r.worker_id, (completedCounts.get(r.worker_id) || 0) + 1);
      } else if (r.estado === "aceptada") {
        acceptedReservations.push(r);
      }
    }
    const ranked = filterAndRankWorkers({
      profiles: [...this.workerProfiles.values()],
      completedCounts,
      acceptedReservations,
      filters,
    });
    if (ranked.length === 0 && this.metrics) {
      this.metrics.workerSearchZeroResults();
    }
    return paginateArray(ranked, filters.limit || 20, filters.cursor || null);
  }

  async getPublicWorkerProfile(workerId) {
    const wp = this.workerProfiles.get(workerId);
    if (
      !wp ||
      wp.deleted_at ||
      wp.estado !== "publicado" ||
      !wp.email_verificado_en ||
      !wp.telefono_verificado_en
    ) {
      throw new AppError("NOT_FOUND", "Trabajador no encontrado");
    }
    let completed = 0;
    for (const r of this.workerReservations.values()) {
      if (r.worker_id === wp.id && r.estado === "completada" && !r.deleted_at) completed += 1;
    }
    return {
      worker_id: wp.id,
      tipo: wp.tipo,
      plazas_ofrecidas: wp.plazas_ofrecidas,
      nombre_publico: wp.nombre_publico,
      categorias: [...wp.categorias],
      servicios: [...wp.servicios],
      tarifa: {
        modo: wp.tarifa_modo,
        monto: Number(wp.tarifa_monto),
        moneda: wp.tarifa_moneda,
        unidad: wp.tarifa_unidad,
      },
      zonas: [...wp.zonas],
      radio_km: wp.radio_km,
      idiomas: [...wp.idiomas],
      anios_experiencia: wp.anios_experiencia,
      eventos_completados: completed,
    };
  }

  async getWorkerBusyWindows({ workerId, desde = null, hasta = null }) {
    const wp = this.workerProfiles.get(workerId);
    if (!wp || wp.deleted_at) throw new AppError("NOT_FOUND", "Trabajador no encontrado");
    const ventanas = [];
    for (const r of this.workerReservations.values()) {
      if (r.worker_id !== workerId || r.estado !== "aceptada" || r.deleted_at) continue;
      if (desde && hasta && !windowsOverlap(r.inicio, r.fin, desde, hasta)) continue;
      // NFR-11 Excepción 1: SOLO { inicio, fin } — nunca event_id ni planner
      ventanas.push({ inicio: r.inicio, fin: r.fin });
    }
    ventanas.sort((a, b) => (a.inicio < b.inicio ? -1 : 1));
    return { worker_id: workerId, ventana_ocupada: ventanas };
  }

  async listOwnAvailability({ userId, desde = null, hasta = null }) {
    const wp = await this.getWorkerProfileByUserId(userId);
    if (!wp) throw new AppError("NOT_FOUND", "Perfil no encontrado");
    const items = [];
    for (const w of this.availabilityWindows.values()) {
      if (w.worker_id !== wp.worker_id || w.deleted_at) continue;
      if (desde && hasta && !windowsOverlap(w.inicio, w.fin, desde, hasta)) continue;
      items.push({ window_id: w.id, inicio: w.inicio, fin: w.fin, zona: w.zona, rol: w.rol });
    }
    items.sort((a, b) => (a.inicio < b.inicio ? -1 : 1));
    return { items };
  }

  async createAvailability({ userId, data }) {
    const wp = await this.getWorkerProfileByUserId(userId);
    if (!wp) throw new AppError("NOT_FOUND", "Perfil no encontrado");
    const ini = new Date(data.inicio);
    const fin = new Date(data.fin);
    if (Number.isNaN(ini.getTime()) || Number.isNaN(fin.getTime()) || fin <= ini) {
      throw validationError("fin debe ser posterior a inicio", "inicio");
    }
    if (!isValidZona(data.zona)) throw validationError("zona inválida", "zona");
    if (!isValidRol(data.rol)) throw validationError("rol inválido", "rol");
    const now = new Date().toISOString();
    const w = {
      id: ulid(),
      worker_id: wp.worker_id,
      inicio: ini.toISOString(),
      fin: fin.toISOString(),
      zona: data.zona,
      rol: data.rol,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    this.availabilityWindows.set(w.id, w);
    return { window_id: w.id, inicio: w.inicio, fin: w.fin, zona: w.zona, rol: w.rol };
  }

  async updateAvailability({ userId, windowId, patch }) {
    const wp = await this.getWorkerProfileByUserId(userId);
    if (!wp) throw new AppError("NOT_FOUND", "Perfil no encontrado");
    const w = this.availabilityWindows.get(windowId);
    if (!w || w.worker_id !== wp.worker_id || w.deleted_at) {
      throw new AppError("NOT_FOUND", "Ventana no encontrada");
    }
    const ini = patch.inicio ? new Date(patch.inicio) : new Date(w.inicio);
    const fin = patch.fin ? new Date(patch.fin) : new Date(w.fin);
    if (Number.isNaN(ini.getTime()) || Number.isNaN(fin.getTime()) || fin <= ini) {
      throw validationError("Ventana inválida", "fin");
    }
    if (patch.zona && !isValidZona(patch.zona)) throw validationError("zona inválida", "zona");
    if (patch.rol && !isValidRol(patch.rol)) throw validationError("rol inválido", "rol");

    w.inicio = ini.toISOString();
    w.fin = fin.toISOString();
    if (patch.zona) w.zona = patch.zona;
    if (patch.rol) w.rol = patch.rol;
    w.updated_at = new Date().toISOString();
    return { window_id: w.id, inicio: w.inicio, fin: w.fin, zona: w.zona, rol: w.rol };
  }

  async deleteAvailability({ userId, windowId }) {
    const wp = await this.getWorkerProfileByUserId(userId);
    if (!wp) throw new AppError("NOT_FOUND", "Perfil no encontrado");
    const w = this.availabilityWindows.get(windowId);
    if (!w || w.worker_id !== wp.worker_id || w.deleted_at) {
      throw new AppError("NOT_FOUND", "Ventana no encontrada");
    }
    const now = new Date().toISOString();
    w.deleted_at = now;
    w.updated_at = now;
  }

  /** Lugares sin cubrir del requerimiento (evento, rol); `null` si el evento no lo declara. */
  _remainingRequirementSlots(eventId, rol) {
    const req = [...this.eventRequirements.values()].find((r) => r.event_id === eventId && r.rol === rol && !r.deleted_at);
    if (!req) return null;
    let cubiertos = 0;
    for (const r of this.workerReservations.values()) {
      if (r.event_id === eventId && r.rol === rol && !r.deleted_at && (r.estado === "aceptada" || r.estado === "completada")) {
        cubiertos += Number(r.plazas);
      }
    }
    return req.cantidad - cubiertos;
  }

  async createWorkerRequest({
    eventId,
    workerId,
    rol,
    plazas = 1,
    ventana,
    horaLlegada,
    modoEmergencia = false,
    canalesActivos = ["sms", "email"],
    now = new Date(),
  }) {
    const ev = this.events.get(eventId);
    if (!ev || ev.deleted_at) throw new AppError("NOT_FOUND", "Evento no encontrado");
    if (ev.estado === "cerrado" || ev.estado === "cancelado") {
      throw new AppError("EVENT_STATE_INVALID", "Evento cerrado o cancelado");
    }
    const wp = this.workerProfiles.get(workerId);
    if (!wp || wp.deleted_at) throw new AppError("NOT_FOUND", "Trabajador no encontrado");
    if (!wp.tarifa_monto || !wp.tarifa_moneda || !wp.tarifa_unidad) {
      throw new AppError("TRABAJADOR_SIN_TARIFA", "Trabajador sin tarifa publicada");
    }
    if (wp.estado !== "publicado" || !wp.email_verificado_en || !wp.telefono_verificado_en) {
      throw validationError("El perfil del trabajador no está publicado y verificado", "worker_id");
    }
    if (!isValidRol(rol)) throw validationError("rol inválido", "rol");

    const ini = new Date(ventana?.inicio);
    const fin = new Date(ventana?.fin);
    const arrival = new Date(horaLlegada);
    if (Number.isNaN(ini.getTime()) || Number.isNaN(fin.getTime()) || fin <= ini) {
      throw validationError("ventana inválida", "ventana");
    }
    if (Number.isNaN(arrival.getTime()) || arrival < ini || arrival >= fin) {
      throw validationError("hora_llegada debe cumplir inicio <= hora_llegada < fin", "hora_llegada");
    }
    const plazasNum = Number(plazas);
    if (!Number.isInteger(plazasNum) || plazasNum < 1 || plazasNum > wp.plazas_ofrecidas) {
      throw validationError("plazas inválidas respecto a plazas_ofrecidas", "plazas");
    }

    // Validación temprana de contención en AvailabilityWindow (03-api.md §3.c)
    const hasWindow = [...this.availabilityWindows.values()].some(
      (w) =>
        w.worker_id === wp.id &&
        w.rol === rol &&
        !w.deleted_at &&
        windowContains(w.inicio, w.fin, ini, fin)
    );
    if (!hasWindow) {
      throw new AppError(
        "WINDOW_NOT_AVAILABLE",
        "La ventana no está contenida en disponibilidad declarada para ese rol"
      );
    }

    const nowMs = new Date(now).getTime();
    const ttlMs = modoEmergencia ? 15 * 60 * 1000 : 48 * 60 * 60 * 1000;
    const expiraMs = Math.min(nowMs + ttlMs, fin.getTime());
    if (expiraMs <= nowMs) {
      throw validationError("La ventana de solicitud ya expiró", "ventana");
    }
    const nowIso = toIso(now);

    // TR-08: NO se valida overlap contra `solicitada` ni `aceptada` al crear (solo al aceptar)
    // TR-20: Snapshot inmutable de tarifa en costo_congelado_*
    const reservation = {
      id: ulid(),
      worker_id: wp.id,
      event_id: eventId,
      rol,
      inicio: ini.toISOString(),
      fin: fin.toISOString(),
      hora_llegada: arrival.toISOString(),
      plazas: plazasNum,
      plazas_solicitadas: plazasNum,
      estado: "solicitada",
      costo_congelado_modo: wp.tarifa_modo || "fijo",
      costo_congelado_monto: Number(wp.tarifa_monto),
      costo_congelado_moneda: wp.tarifa_moneda,
      costo_congelado_unidad: wp.tarifa_unidad,
      modo_emergencia: Boolean(modoEmergencia),
      llegada_registrada_en: null,
      aceptada_en: null,
      rechazada_en: null,
      cancelada_en: null,
      motivo_rechazo: null,
      motivo_cancelacion: null,
      expira_en: new Date(expiraMs).toISOString(),
      created_at: nowIso,
      updated_at: nowIso,
      deleted_at: null,
    };
    this.workerReservations.set(reservation.id, reservation);

    // Notificar solicitud al trabajador en paralelo (D11, RF-17)
    const workerUser = this.users.get(wp.user_id);
    for (const canal of canalesActivos) {
      // Misma forma que PgStore: dirección cifrada en el outbox (NFR-07).
      const toCifrado = canal === "sms" ? wp.telefono_cifrado : workerUser?.email_cifrado;
      if (!toCifrado) continue;
      this._pushOutbox({
        eventId,
        topic: "notifications",
        eventType: "worker_request_created",
        canal,
        payload: {
          reservation_id: reservation.id,
          worker_id: wp.id,
          event_id: eventId,
          canal,
          to_cifrado: toCifrado,
          rol,
          inicio: reservation.inicio,
          fin: reservation.fin,
          modo_emergencia: reservation.modo_emergencia,
          expira_en: reservation.expira_en,
        },
        tIngest: nowIso,
      });
    }

    return this._formatReservationForPlanner(reservation);
  }

  _formatReservationForPlanner(res) {
    const wp = this.workerProfiles.get(res.worker_id);
    const out = {
      id: res.id,
      reservation_id: res.id,
      event_id: res.event_id,
      worker_id: res.worker_id,
      rol: res.rol,
      plazas: res.plazas,
      plazas_solicitadas: res.plazas_solicitadas,
      estado: res.estado,
      ventana: { inicio: res.inicio, fin: res.fin },
      hora_llegada: res.hora_llegada,
      costo_congelado: {
        modo: res.costo_congelado_modo,
        monto: Number(res.costo_congelado_monto),
        moneda: res.costo_congelado_moneda,
        unidad: res.costo_congelado_unidad,
      },
      modo_emergencia: res.modo_emergencia,
      expira_en: res.expira_en,
      aceptada_en: res.aceptada_en,
      llegada_registrada_en: res.llegada_registrada_en,
    };
    if (res.estado === "aceptada" && wp?.telefono_cifrado) {
      out.contacto_telefono = this._dec(wp.telefono_cifrado);
    }
    return out;
  }

  async listEventWorkerRequests({ eventId, limit = 20, cursor = null }) {
    const items = [];
    for (const r of this.workerReservations.values()) {
      if (r.event_id === eventId && !r.deleted_at) {
        items.push(this._formatReservationForPlanner(r));
      }
    }
    items.sort((a, b) => (a.id < b.id ? -1 : 1));
    const paged = paginateArray(items, limit, cursor);
    const cobertura = this._computeCoverageForEvent(eventId);
    return { ...paged, cobertura };
  }

  async cancelEventReservation({
    eventId,
    reservationId,
    actorId,
    motivo = "Cancelación de reserva",
    paymentProvider = null,
    now = new Date(),
  }) {
    const existing = this.workerReservations.get(reservationId);
    if (!existing || existing.event_id !== eventId || existing.deleted_at) {
      throw new AppError("NOT_FOUND", "Reserva no encontrada en este evento");
    }

    return this.mutexes.worker.run(existing.worker_id, async () => {
      const res = this.workerReservations.get(reservationId);
      const nowIso = toIso(now);

      if (res.estado === "cancelada" || res.estado === "cancelada_pagada") {
        return {
          id: res.id,
          estado: res.estado,
          plazas_liberadas: res.plazas,
          ledger_entry_id: null,
        };
      }
      if (res.estado === "completada") {
        throw new AppError("EVENT_STATE_INVALID", "Reserva completada no puede cancelarse");
      }

      let ledgerEntryId = null;
      const payment = this._findPaymentByReservation(res.id);
      if (payment && payment.cobrado_en) {
        if (paymentProvider && payment.psp_charge_id) {
          await paymentProvider.refund({
            idempotencyKey: payment.idempotency_key,
            pspChargeId: payment.psp_charge_id,
            amount: payment.monto,
            currency: payment.moneda,
          });
        }
        const txId = this._recordBalancedLedgerPair({
          pagoId: payment.id,
          movimiento: "reverso",
          monto: payment.monto,
          moneda: payment.moneda,
          nowIso,
        });
        ledgerEntryId = txId;
        res.estado = "cancelada_pagada";
      } else {
        res.estado = "cancelada";
      }

      res.cancelada_en = nowIso;
      res.motivo_cancelacion = motivo;
      res.updated_at = nowIso;

      for (const job of this.reminderJobs.values()) {
        if (job.worker_reservation_id === res.id && job.estado === "programado") {
          job.estado = "cancelado";
          job.motivo_cancelacion = "reserva_cancelada";
          job.updated_at = nowIso;
        }
      }

      this._pushAudit({
        eventId,
        actorId,
        accion: "reserva_cancelada",
        entidad: "worker_reservation",
        entidadId: res.id,
        motivo: motivo || "Cancelación por planner",
        ts: nowIso,
        detalle: { nuevo_estado: res.estado, plazas_liberadas: res.plazas },
      });

      return {
        id: res.id,
        estado: res.estado,
        plazas_liberadas: res.plazas,
        ledger_entry_id: ledgerEntryId,
      };
    });
  }

  async replaceEventReservation({
    eventId,
    reservationId,
    workerId = null,
    canalesActivos = ["sms", "email"],
    now = new Date(),
  }) {
    const fallen = this.workerReservations.get(reservationId);
    if (!fallen || fallen.event_id !== eventId || fallen.deleted_at) {
      throw new AppError("NOT_FOUND", "Reserva origen no encontrada en este evento");
    }
    const nowIso = toIso(now);

    if (!workerId) {
      fallen.estado = "sin_cubrir";
      fallen.updated_at = nowIso;
      const alert = {
        id: ulid(),
        event_id: eventId,
        reservation_id: fallen.id,
        tipo: "requerimiento_sin_cubrir",
        detalle: { rol: fallen.rol, plazas_faltantes: fallen.plazas },
        leida_en: null,
        created_at: nowIso,
      };
      this.plannerAlerts.push(alert);
      return {
        isSinCubrir: true,
        body: {
          estado: "sin_cubrir",
          alerta: true,
          planner_alert_id: alert.id,
          rol: fallen.rol,
          plazas_faltantes: fallen.plazas,
        },
      };
    }

    const wp = this.workerProfiles.get(workerId);
    if (!wp || wp.deleted_at) throw new AppError("NOT_FOUND", "Trabajador candidato no encontrado");

    return this.mutexes.worker.run(workerId, async () => {
      // RF-09: Si candidato elegido está reservado en ventana solapada -> 409 RESERVATION_OVERLAP
      const overlapping = [...this.workerReservations.values()].filter(
        (r) =>
          r.worker_id === workerId &&
          r.estado === "aceptada" &&
          !r.deleted_at &&
          windowsOverlap(r.inicio, r.fin, fallen.inicio, fallen.fin)
      );
      const occupied = overlapping.reduce((s, r) => s + Number(r.plazas), 0);
      if (wp.plazas_ofrecidas - occupied < 1) {
        const winner = overlapping[0];
        if (this.metrics) this.metrics.reservationConflicts(workerId);
        throw new AppError("RESERVATION_OVERLAP", "El trabajador candidato ya está ocupado en esa ventana", {
          ganadora: winner
            ? {
                reservation_id: winner.id,
                ventana: { inicio: winner.inicio, fin: winner.fin },
                plazas: winner.plazas,
                aceptada_en: winner.aceptada_en,
              }
            : null,
        });
      }

      const created = await this.createWorkerRequest({
        eventId,
        workerId,
        rol: fallen.rol,
        plazas: fallen.plazas,
        ventana: { inicio: fallen.inicio, fin: fallen.fin },
        horaLlegada: fallen.hora_llegada,
        modoEmergencia: true,
        canalesActivos,
        now,
      });

      return {
        isSinCubrir: false,
        body: {
          ...created,
          sla_respuesta: "PT15M",
        },
      };
    });
  }

  async listWorkerRequests({ userId, estado = null, desde = null, limit = 20, cursor = null }) {
    const wp = await this.getWorkerProfileByUserId(userId);
    if (!wp) throw new AppError("NOT_FOUND", "Perfil de trabajador no encontrado");

    const items = [];
    for (const res of this.workerReservations.values()) {
      if (res.worker_id !== wp.worker_id || res.deleted_at) continue;
      if (estado && res.estado !== estado) continue;
      if (desde && new Date(res.fin).getTime() <= new Date(desde).getTime()) continue;
      const ev = this.events.get(res.event_id);
      const venue = ev ? this.venues.get(ev.venue_id) : null;
      items.push({
        reservation_id: res.id,
        evento: ev ? { id: ev.id, nombre: ev.nombre, fecha: ev.fecha, timezone: ev.timezone } : null,
        zona: venue?.zona || null,
        ventana: { inicio: res.inicio, fin: res.fin },
        rol: res.rol,
        plazas: res.plazas,
        hora_llegada: res.hora_llegada,
        costo_congelado: {
          modo: res.costo_congelado_modo,
          monto: Number(res.costo_congelado_monto),
          moneda: res.costo_congelado_moneda,
          unidad: res.costo_congelado_unidad,
        },
        estado: res.estado,
        expira_en: res.expira_en,
        modo_emergencia: res.modo_emergencia,
      });
    }
    return paginateArray(items, limit, cursor);
  }

  async getWorkerRequestDetail({ userId, reservationId }) {
    const wp = await this.getWorkerProfileByUserId(userId);
    if (!wp) throw new AppError("NOT_FOUND", "Perfil no encontrado");
    const res = this.workerReservations.get(reservationId);
    if (!res || res.deleted_at) throw new AppError("NOT_FOUND", "Solicitud no encontrada");
    if (res.worker_id !== wp.worker_id) {
      throw new AppError("FORBIDDEN_EVENT_SCOPE", "La solicitud pertenece a otro trabajador");
    }
    const ev = this.events.get(res.event_id);
    const venue = ev ? this.venues.get(ev.venue_id) : null;
    const reqs = this._computeCoverageForEvent(res.event_id);
    const covRol = reqs.por_rol.find((r) => r.rol === res.rol) || null;
    return {
      solicitud: {
        reservation_id: res.id,
        rol: res.rol,
        plazas: res.plazas,
        estado: res.estado,
        ventana: { inicio: res.inicio, fin: res.fin },
        hora_llegada: res.hora_llegada,
        costo_congelado: {
          modo: res.costo_congelado_modo,
          monto: Number(res.costo_congelado_monto),
          moneda: res.costo_congelado_moneda,
          unidad: res.costo_congelado_unidad,
        },
        evento: ev ? { id: ev.id, nombre: ev.nombre, zona: venue?.zona || null, direccion: venue?.direccion || null } : null,
      },
      cobertura_requerimiento: covRol,
    };
  }

  async acceptWorkerReservation({
    userId,
    reservationId,
    plazas = null,
    canalesActivos = ["sms", "email"],
    now = new Date(),
  }) {
    const wp = await this.getWorkerProfileByUserId(userId);
    if (!wp) throw new AppError("NOT_FOUND", "Perfil de trabajador no encontrado");

    return this.mutexes.worker.run(wp.worker_id, async () => {
      const res = this.workerReservations.get(reservationId);
      if (!res || res.deleted_at) throw new AppError("NOT_FOUND", "Solicitud no encontrada");
      if (res.worker_id !== wp.worker_id) {
        throw new AppError("FORBIDDEN_EVENT_SCOPE", "La solicitud no pertenece a este trabajador");
      }

      const nowMs = new Date(now).getTime();
      const nowIso = toIso(now);

      // Replay idempotente (AC-07)
      if (res.estado === "aceptada") {
        const cov = this._computeCoverageForEvent(res.event_id).por_rol.find((r) => r.rol === res.rol) || null;
        return {
          reservation_id: res.id,
          estado: "aceptada",
          plazas_solicitadas: res.plazas_solicitadas,
          plazas_aceptadas: res.plazas,
          plazas_devueltas: res.plazas_solicitadas - res.plazas,
          costo_congelado: {
            modo: res.costo_congelado_modo,
            monto: Number(res.costo_congelado_monto),
            moneda: res.costo_congelado_moneda,
            unidad: res.costo_congelado_unidad,
          },
          ventana: { inicio: res.inicio, fin: res.fin },
          hora_llegada: res.hora_llegada,
          aceptada_en: res.aceptada_en,
          cobertura_requerimiento: cov,
        };
      }

      if (res.estado === "expirada") {
        throw new AppError("REQUEST_EXPIRED", "La solicitud expiró sin respuesta");
      }

      if (res.estado !== "solicitada") {
        throw new AppError("RESERVATION_NOT_PENDING", `La solicitud está en estado ${res.estado}`);
      }

      if (new Date(res.expira_en).getTime() <= nowMs) {
        res.estado = "expirada";
        res.updated_at = nowIso;
        throw new AppError("REQUEST_EXPIRED", "La solicitud expiró sin respuesta");
      }

      // Nunca más proveedores que lugares (README FR4): las plazas aceptadas del rol en el evento no
      // superan la `cantidad` del requerimiento. Sin `await` entre la lectura y la escritura, así
      // que es atómico frente a otros trabajadores que acepten a la vez.
      const lugaresRestantes = this._remainingRequirementSlots(res.event_id, res.rol);
      if (lugaresRestantes !== null && lugaresRestantes <= 0) {
        throw new AppError("REQUERIMIENTO_CUBIERTO", "El requerimiento de este rol ya está cubierto", {
          rol: res.rol,
          event_id: res.event_id,
        });
      }

      const requestedPlazas = plazas === null || plazas === undefined ? res.plazas : Number(plazas);
      if (
        !Number.isInteger(requestedPlazas) ||
        requestedPlazas < 1 ||
        requestedPlazas > res.plazas ||
        requestedPlazas > wp.plazas_ofrecidas
      ) {
        throw new AppError("PLAZAS_INVALIDAS", "Cantidad de plazas solicitadas para aceptar es inválida");
      }

      // Contención en AvailabilityWindow (RF-22, AC-22): error determinista sin mutar estado
      const contained = [...this.availabilityWindows.values()].some(
        (w) =>
          w.worker_id === wp.worker_id &&
          w.rol === res.rol &&
          !w.deleted_at &&
          windowContains(w.inicio, w.fin, res.inicio, res.fin)
      );
      if (!contained) {
        throw new AppError(
          "WINDOW_NOT_AVAILABLE",
          "La ventana no está contenida en ninguna disponibilidad vigente del rol"
        );
      }

      // Suma cross-evento sobre reservas `aceptada` solapadas (TR-08, AC-07)
      const overlappingAccepted = [...this.workerReservations.values()]
        .filter(
          (other) =>
            other.worker_id === wp.worker_id &&
            other.estado === "aceptada" &&
            !other.deleted_at &&
            windowsOverlap(other.inicio, other.fin, res.inicio, res.fin)
        )
        .sort((a, b) => (a.aceptada_en < b.aceptada_en ? -1 : a.aceptada_en > b.aceptada_en ? 1 : a.id < b.id ? -1 : 1));

      const ocupadas = overlappingAccepted.reduce((sum, r) => sum + Number(r.plazas), 0);
      const disponibles = wp.plazas_ofrecidas - ocupadas;
      const aceptables = Math.min(requestedPlazas, disponibles, lugaresRestantes ?? Infinity);

      if (aceptables <= 0) {
        const ganadora = overlappingAccepted[0];
        if (this.metrics) this.metrics.reservationConflicts(wp.worker_id);
        // La fila perdedora permanece `solicitada` (RF-17, AC-07)
        throw new AppError(
          "RESERVATION_OVERLAP",
          "La ventana se solapa con una reserva aceptada del mismo perfil",
          {
            solicitud: {
              reservation_id: res.id,
              estado_actual: res.estado,
              plazas: res.plazas,
            },
            ventana: { inicio: res.inicio, fin: res.fin },
            plazas_ofrecidas: wp.plazas_ofrecidas,
            plazas_aceptadas_en_ventana: ocupadas,
            plazas_disponibles: Math.max(0, disponibles),
            ganadora: ganadora
              ? {
                  reservation_id: ganadora.id,
                  event_id: ganadora.event_id,
                  ventana: { inicio: ganadora.inicio, fin: ganadora.fin },
                  plazas: ganadora.plazas,
                  aceptada_en: ganadora.aceptada_en,
                }
              : null,
          }
        );
      }

      res.estado = "aceptada";
      res.plazas = aceptables;
      res.aceptada_en = nowIso;
      res.updated_at = nowIso;

      // Recordatorios de hora de llegada T-24h y T-2h por SMS + Email (RF-10, D11)
      const arrivalTimes = computeReminderTimes(res.hora_llegada);
      const workerUser = this.users.get(wp.user_id);
      const rawProfile = this.workerProfiles.get(wp.worker_id);
      for (const canal of canalesActivos) {
        const addr =
          canal === "sms"
            ? rawProfile?.telefono_cifrado
              ? this._dec(rawProfile.telefono_cifrado)
              : null
            : workerUser?.email_cifrado
              ? this._dec(workerUser.email_cifrado)
              : null;
        if (!addr) continue;
        for (const ventana of ["t_24h", "t_2h"]) {
          this._insertReminderJobIdempotent({
            eventId: res.event_id,
            guestId: null,
            workerReservationId: res.id,
            subjectId: wp.worker_id,
            normalizedAddr: addr,
            canal,
            plantilla: "recordatorio_llegada",
            ventana,
            dispararEn: arrivalTimes[ventana],
            now: nowIso,
          });
        }
      }

      const cov = this._computeCoverageForEvent(res.event_id).por_rol.find((r) => r.rol === res.rol) || null;
      return {
        reservation_id: res.id,
        estado: "aceptada",
        plazas_solicitadas: res.plazas_solicitadas,
        plazas_aceptadas: res.plazas,
        plazas_devueltas: res.plazas_solicitadas - res.plazas,
        costo_congelado: {
          modo: res.costo_congelado_modo,
          monto: Number(res.costo_congelado_monto),
          moneda: res.costo_congelado_moneda,
          unidad: res.costo_congelado_unidad,
        },
        ventana: { inicio: res.inicio, fin: res.fin },
        hora_llegada: res.hora_llegada,
        aceptada_en: res.aceptada_en,
        cobertura_requerimiento: cov,
      };
    });
  }

  async rejectWorkerReservation({ userId, reservationId, motivo = null, now = new Date() }) {
    const wp = await this.getWorkerProfileByUserId(userId);
    if (!wp) throw new AppError("NOT_FOUND", "Perfil no encontrado");
    return this.mutexes.worker.run(wp.worker_id, async () => {
      const res = this.workerReservations.get(reservationId);
      if (!res || res.deleted_at) throw new AppError("NOT_FOUND", "Solicitud no encontrada");
      if (res.worker_id !== wp.worker_id) {
        throw new AppError("FORBIDDEN_EVENT_SCOPE", "La solicitud no pertenece a este trabajador");
      }
      if (res.estado === "rechazada") {
        return {
          reservation_id: res.id,
          estado: "rechazada",
          rechazada_en: res.rechazada_en,
          devuelve_a_busqueda: true,
        };
      }
      if (res.estado !== "solicitada") {
        throw new AppError("RESERVATION_NOT_PENDING", "Solo se pueden rechazar solicitudes pendientes");
      }
      const nowIso = toIso(now);
      res.estado = "rechazada";
      res.rechazada_en = nowIso;
      res.motivo_rechazo = motivo;
      res.updated_at = nowIso;
      return {
        reservation_id: res.id,
        estado: "rechazada",
        rechazada_en: res.rechazada_en,
        devuelve_a_busqueda: true,
      };
    });
  }

  async cancelWorkerReservationByWorker({
    userId,
    reservationId,
    motivo = "Cancelación del trabajador",
    paymentProvider = null,
    now = new Date(),
  }) {
    const wp = await this.getWorkerProfileByUserId(userId);
    if (!wp) throw new AppError("NOT_FOUND", "Perfil no encontrado");
    return this.mutexes.worker.run(wp.worker_id, async () => {
      const res = this.workerReservations.get(reservationId);
      if (!res || res.deleted_at) throw new AppError("NOT_FOUND", "Reserva no encontrada");
      if (res.worker_id !== wp.worker_id) {
        throw new AppError("FORBIDDEN_EVENT_SCOPE", "La reserva pertenece a otro trabajador");
      }
      if (res.estado === "cancelada" || res.estado === "cancelada_pagada") {
        return { reservation_id: res.id, estado: res.estado, alerta_planner: "emitida" };
      }
      if (res.estado !== "aceptada") {
        throw new AppError("RESERVATION_NOT_ACCEPTED", "Solo se puede cancelar una reserva aceptada");
      }
      const nowIso = toIso(now);
      const payment = this._findPaymentByReservation(res.id);
      if (payment && payment.cobrado_en) {
        if (paymentProvider && payment.psp_charge_id) {
          await paymentProvider.refund({
            idempotencyKey: payment.idempotency_key,
            pspChargeId: payment.psp_charge_id,
            amount: payment.monto,
            currency: payment.moneda,
          });
        }
        this._recordBalancedLedgerPair({
          pagoId: payment.id,
          movimiento: "reverso",
          monto: payment.monto,
          moneda: payment.moneda,
          nowIso,
        });
        res.estado = "cancelada_pagada";
      } else {
        res.estado = "cancelada";
      }
      res.cancelada_en = nowIso;
      res.motivo_cancelacion = motivo;
      res.updated_at = nowIso;

      for (const job of this.reminderJobs.values()) {
        if (job.worker_reservation_id === res.id && job.estado === "programado") {
          job.estado = "cancelado";
          job.motivo_cancelacion = "reserva_cancelada";
          job.updated_at = nowIso;
        }
      }

      this._pushAudit({
        eventId: res.event_id,
        actorId: userId,
        accion: "reserva_cancelada",
        entidad: "worker_reservation",
        entidadId: res.id,
        motivo: motivo || "Cancelación por trabajador",
        ts: nowIso,
      });

      const alert = {
        id: ulid(),
        event_id: res.event_id,
        reservation_id: res.id,
        tipo: "reserva_cancelada_en_vivo",
        detalle: { rol: res.rol, plazas: res.plazas, worker_id: wp.worker_id },
        leida_en: null,
        created_at: nowIso,
      };
      this.plannerAlerts.push(alert);

      return {
        reservation_id: res.id,
        estado: res.estado,
        alerta_planner: "emitida",
        planner_alert_id: alert.id,
      };
    });
  }

  async listEventAlerts({ eventId }) {
    return this.plannerAlerts
      .filter((a) => a.event_id === eventId)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  async recordWorkerArrival({ userId, reservationId, llegadaEn = null, now = new Date() }) {
    const wp = await this.getWorkerProfileByUserId(userId);
    if (!wp) throw new AppError("NOT_FOUND", "Perfil no encontrado");
    const res = this.workerReservations.get(reservationId);
    if (!res || res.deleted_at) throw new AppError("NOT_FOUND", "Reserva no encontrada");
    if (res.worker_id !== wp.worker_id) {
      throw new AppError("FORBIDDEN_EVENT_SCOPE", "La reserva pertenece a otro trabajador");
    }
    if (res.estado !== "aceptada" && res.estado !== "completada") {
      throw new AppError("RESERVATION_NOT_ACCEPTED", "La reserva no está aceptada");
    }
    if (!res.llegada_registrada_en) {
      res.llegada_registrada_en = llegadaEn ? toIso(llegadaEn) : toIso(now);
      res.updated_at = toIso(now);
    }
    return { reservation_id: res.id, llegada_registrada_en: res.llegada_registrada_en };
  }

  async getWorkerReservationPayment({ userId, reservationId }) {
    const wp = await this.getWorkerProfileByUserId(userId);
    if (!wp) throw new AppError("NOT_FOUND", "Perfil no encontrado");
    const res = this.workerReservations.get(reservationId);
    if (!res || res.deleted_at) throw new AppError("NOT_FOUND", "Reserva no encontrada");
    if (res.worker_id !== wp.worker_id) {
      throw new AppError("FORBIDDEN_EVENT_SCOPE", "La reserva pertenece a otro trabajador");
    }
    const payment = this._findPaymentByReservation(res.id);
    if (!payment) {
      return {
        estado: "pendiente",
        monto: Number(res.costo_congelado_monto),
        moneda: res.costo_congelado_moneda,
      };
    }
    const hasReverso = this.paymentEntries.some(
      (e) => e.pago_id === payment.id && e.movimiento === "reverso"
    );
    return {
      payment_id: payment.id,
      estado: hasReverso
        ? "reversado"
        : payment.cobrado_en
          ? "pagado"
          : payment.estado_psp === "desconocido"
            ? "desconocido"
            : "pendiente",
      monto: Number(payment.monto),
      moneda: payment.moneda,
      reverso_de: hasReverso ? payment.id : undefined,
    };
  }

  // ==========================================================================
  // Check-in Offline y Sesiones de Escaneo (RF-13, RF-14, RF-15, TR-01..06, 17..19)
  // ==========================================================================
  async createOrGetScanSession({
    eventId,
    deviceId,
    userId = null,
    accessTokenId = null,
    rol = "staff",
    expiraEn = null,
    now = new Date(),
  }) {
    if (!eventId || !deviceId) throw validationError("event_id y device_id son obligatorios");
    const ev = this.events.get(eventId);
    if (!ev || ev.deleted_at) throw new AppError("NOT_FOUND", "Evento no encontrado");
    if (ev.estado !== "publicado" && ev.estado !== "en_curso") {
      throw new AppError("EVENT_STATE_INVALID", "El evento no está habilitado para escaneo");
    }

    const nowMs = new Date(now).getTime();
    for (const s of this.scanSessions.values()) {
      if (s.event_id === eventId && s.device_id === deviceId && !s.deleted_at) {
        if (new Date(s.expira_en).getTime() > nowMs) {
          return {
            session_id: s.id,
            event_id: s.event_id,
            rol: s.rol,
            roster_version: s.roster_version,
            revocation_version: s.revocation_version,
            expira_en: s.expira_en,
          };
        }
      }
    }

    const nowIso = toIso(now);
    const sess = {
      id: ulid(),
      event_id: eventId,
      device_id: deviceId,
      user_id: userId,
      access_token_id: accessTokenId,
      rol,
      roster_version: 1,
      revocation_version: 1,
      expira_en: expiraEn || ev.ventana_fin,
      created_at: nowIso,
      updated_at: nowIso,
      deleted_at: null,
    };
    this.scanSessions.set(sess.id, sess);
    return {
      session_id: sess.id,
      event_id: sess.event_id,
      rol: sess.rol,
      roster_version: sess.roster_version,
      revocation_version: sess.revocation_version,
      expira_en: sess.expira_en,
    };
  }

  async getScanSessionById(sessionId) {
    return this.scanSessions.get(sessionId) || null;
  }

  async getScanSessionRoster({ sessionId, version = null, qrSigner, now = new Date() }) {
    const sess = this.scanSessions.get(sessionId);
    if (!sess || sess.deleted_at) throw new AppError("FORBIDDEN_EVENT_SCOPE", "Sesión inválida");
    const ev = this.events.get(sess.event_id);
    if (!ev || ev.deleted_at || ev.estado === "cancelado") {
      throw new AppError("FORBIDDEN_EVENT_SCOPE", "Evento cancelado");
    }

    if (version !== null && Number(version) === sess.roster_version) {
      return { notModified: true, etag: `"roster-${sess.roster_version}"` };
    }

    const nowMs = new Date(now).getTime();
    const nowIso = toIso(now);
    const revocVigenciaMs = 2 * 60 * 60 * 1000;

    const invitados = [];
    for (const inv of this.invitations.values()) {
      if (inv.event_id !== ev.id || inv.deleted_at) continue;
      const g = this.guests.get(inv.guest_id);
      if (!g || g.deleted_at) continue;
      const sa = [...this.seatAssignments.values()].find(
        (s) => s.event_id === ev.id && s.guest_id === g.id && (s.estado === "confirmado" || s.estado === "pendiente")
      );
      const table = sa ? this.eventTables.get(sa.table_id) : null;
      invitados.push({
        invitation_id: inv.id,
        nombre: g.nombre,
        codigo_corto: inv.codigo_corto,
        mesa: table?.numero || null,
        token_key_id: inv.checkin_key_id,
        token_version: inv.token_version,
      });
      if (invitados.length >= 2000) break; // NFR-04
    }

    const { key_id: keyId, public_key_pem: publicKeyPem } = await qrSigner.getPublicKey();
    const unsignedPayload = {
      event_id: ev.id,
      evento: {
        nombre: ev.nombre,
        inicio: ev.ventana_inicio,
        fin: ev.ventana_fin,
        estado: ev.estado,
        timezone: ev.timezone,
      },
      roster_version: sess.roster_version,
      invitados,
    };
    const canonicalString = JSON.stringify(unsignedPayload);
    const sigValor = await qrSigner.signBytes(Buffer.from(canonicalString, "utf8"), keyId);

    return {
      notModified: false,
      etag: `"roster-${sess.roster_version}"`,
      body: {
        ...unsignedPayload,
        generado_en: nowIso,
        expira_en: sess.expira_en,
        canonical_payload: canonicalString,
        firma: {
          alg: "ES256",
          key_id: keyId,
          valor: sigValor,
          sobre: "payload_canonico_sin_firma+roster_version",
        },
        key_publica_pem: publicKeyPem,
        limites: {
          max_invitados: 2000,
          autonomia_horas: 8,
          max_escaneos_dispositivo: 1000,
          max_eventos_por_sesion: 1,
        },
        revocaciones: {
          version: sess.revocation_version,
          emitida_en: nowIso,
          ttl_horas: 2,
          vigente_hasta: new Date(nowMs + revocVigenciaMs).toISOString(),
          refrescar_antes_de: new Date(nowMs + 110 * 60 * 1000).toISOString(),
        },
      },
    };
  }

  async getScanSessionRevocations({ sessionId, now = new Date() }) {
    const sess = this.scanSessions.get(sessionId);
    if (!sess || sess.deleted_at) throw new AppError("FORBIDDEN_EVENT_SCOPE", "Sesión inválida");
    const revocados = [];
    for (const inv of this.invitations.values()) {
      if (inv.event_id === sess.event_id && inv.checkin_revocado_en) {
        revocados.push(inv.id);
      }
    }
    const nowMs = new Date(now).getTime();
    return {
      version: sess.revocation_version,
      emitida_en: toIso(now),
      ttl_horas: 2,
      vigente_hasta: new Date(nowMs + 2 * 60 * 60 * 1000).toISOString(),
      revocados,
    };
  }

  async searchScanSessionRoster({ sessionId, nombre = null, codigoCorto = null }) {
    const sess = this.scanSessions.get(sessionId);
    if (!sess || sess.deleted_at) throw new AppError("FORBIDDEN_EVENT_SCOPE", "Sesión inválida");
    if (!nombre && !codigoCorto) {
      throw validationError("Se requiere nombre o codigo_corto", "nombre");
    }
    const qNombre = nombre ? String(nombre).trim().toLowerCase() : null;
    const qCodigo = codigoCorto ? String(codigoCorto).trim() : null;
    const items = [];
    for (const inv of this.invitations.values()) {
      if (inv.event_id !== sess.event_id || inv.deleted_at) continue;
      const g = this.guests.get(inv.guest_id);
      if (!g || g.deleted_at) continue;
      if (qCodigo && inv.codigo_corto !== qCodigo) continue;
      if (qNombre && !g.nombre.toLowerCase().includes(qNombre)) continue;
      const activeAdmitted = this._hasActiveAdmission(inv.id);
      items.push({
        invitation_id: inv.id,
        nombre: g.nombre,
        codigo_corto: inv.codigo_corto,
        estado: inv.checkin_revocado_en
          ? "invitacion_revocada"
          : activeAdmitted
            ? "ya_registrado"
            : "pendiente",
      });
    }
    return { items };
  }

  _getCurrentAdmissionCycle(invitationId) {
    let annuls = 0;
    for (const chk of this.checkinEvents) {
      if (chk.invitation_id === invitationId && chk.kind === "anulacion") annuls += 1;
    }
    return annuls + 1;
  }

  _hasActiveAdmission(invitationId) {
    const cycle = this._getCurrentAdmissionCycle(invitationId);
    return this.checkinEvents.some(
      (chk) =>
        chk.invitation_id === invitationId &&
        chk.kind === "admitido" &&
        chk.admision_ciclo === cycle
    );
  }

  async ingestCheckinBatch({ sessionId, batch, requestHash, now = new Date() }) {
    validateCheckinBatchPayload(batch);
    const sess = this.scanSessions.get(sessionId);
    if (!sess || sess.deleted_at) throw new AppError("FORBIDDEN_EVENT_SCOPE", "Sesión inválida");
    if (sess.event_id !== batch.event_id) {
      throw new AppError("FORBIDDEN_EVENT_SCOPE", "El lote pertenece a otro evento");
    }

    const ev = this.events.get(batch.event_id);
    if (!ev || ev.deleted_at) throw new AppError("NOT_FOUND", "Evento no encontrado");
    if (ev.estado === "cancelado") {
      throw new AppError("FORBIDDEN_EVENT_SCOPE", "El evento fue cancelado");
    }

    return this.mutexes.checkin.run(ev.id, async () => {
      // Replay exacto de lote por (session_id, batch_id) (AC-03)
      const ackKey = `${sessionId}::${batch.batch_id}`;
      const prevAck = this.checkinBatchAcks.get(ackKey);
      if (prevAck) {
        if (prevAck.request_hash !== requestHash) {
          throw new AppError("IDEMPOTENCY_CONFLICT", "batch_id reutilizado con cuerpo distinto");
        }
        return { replayed: true, body: prevAck.response_body };
      }

      const tIngestIso = toIso(now);
      const isClosed = ev.estado === "cerrado";
      const evStartMs = new Date(ev.ventana_inicio).getTime();
      const evEndMs = new Date(ev.ventana_fin).getTime();

      const results = [];
      let aceptados = 0;
      let tardios = 0;
      let duplicados = 0;
      let invalidadosAlSincronizar = 0;
      let rechazados = 0;
      let asistentesDelta = 0;
      let maxSeq = 0;

      for (const item of batch.events) {
        const seq = Number(item.sequence);
        if (seq > maxSeq) maxSeq = seq;
        const scannedMs = new Date(item.scanned_at).getTime();
        if (Number.isNaN(scannedMs)) {
          rechazados += 1;
          results.push({
            sequence: seq,
            invitation_id: item.invitation_id,
            status: 400,
            error: "SCANNED_AT_INVALIDO",
            tardio: false,
            duplicado: false,
          });
          continue;
        }

        // RF-15 / AC-17: si evento cerrado, acepta escaneado dentro de ventana como `tardio`;
        // rechaza individualmente si está fuera de la ventana del evento.
        if (isClosed && (scannedMs < evStartMs || scannedMs >= evEndMs)) {
          rechazados += 1;
          results.push({
            sequence: seq,
            invitation_id: item.invitation_id,
            status: 400,
            error: "FUERA_DE_VENTANA_EVENTO",
            verdict: "no_corresponde_al_evento",
            tardio: false,
            duplicado: false,
          });
          continue;
        }
        const tardio = isClosed;

        // Idempotencia TR-01 por (invitation_id, device_id, sequence)
        const existingSameKey = this.checkinEvents.find(
          (c) =>
            c.invitation_id === item.invitation_id &&
            c.device_id === batch.device_id &&
            c.sequence === seq
        );
        if (existingSameKey) {
          results.push({
            sequence: seq,
            invitation_id: item.invitation_id,
            checkin_id: existingSameKey.id,
            kind: existingSameKey.kind,
            verdict: existingSameKey.veredicto,
            tardio: existingSameKey.tardio,
            duplicado: existingSameKey.kind === "duplicado_tardio",
            ...(existingSameKey.vigente_checkin_id
              ? { vigente_checkin_id: existingSameKey.vigente_checkin_id }
              : {}),
            ...(existingSameKey.resolucion_al_sincronizar
              ? { resolucion_al_sincronizar: existingSameKey.resolucion_al_sincronizar }
              : {}),
          });
          continue;
        }

        const inv = this.invitations.get(item.invitation_id);
        if (!inv || inv.event_id !== ev.id || inv.deleted_at) {
          rechazados += 1;
          results.push({
            sequence: seq,
            invitation_id: item.invitation_id,
            verdict: "no_corresponde_al_evento",
            tardio: false,
            duplicado: false,
          });
          continue;
        }

        const guest = this.guests.get(inv.guest_id);
        if (inv.checkin_revocado_en || !guest || guest.deleted_at) {
          const resolucion =
            item.verdict_local === "no_verificable_offline" || item.verdict_local === "admitido"
              ? "invalidado_al_sincronizar"
              : null;
          if (resolucion) invalidadosAlSincronizar += 1;
          const chk = {
            id: ulid(),
            event_id: ev.id,
            invitation_id: inv.id,
            device_id: batch.device_id,
            sequence: seq,
            kind: "duplicado_tardio",
            veredicto: "invitacion_revocada",
            admision_ciclo: this._getCurrentAdmissionCycle(inv.id),
            escaneado_en: toIso(item.scanned_at),
            recibido_en: tIngestIso,
            tardio,
            anula_a: null,
            actor_id: null,
            motivo: null,
            modo: item.modo || "camara",
            verdict_local: item.verdict_local || null,
            resolucion_al_sincronizar: resolucion,
            vigente_checkin_id: null,
            created_at: tIngestIso,
          };
          this.checkinEvents.push(chk);
          results.push({
            sequence: seq,
            invitation_id: inv.id,
            checkin_id: chk.id,
            verdict: "invitacion_revocada",
            verdict_local: item.verdict_local || null,
            resolucion_al_sincronizar: resolucion,
            tardio,
            duplicado: false,
          });
          continue;
        }

        // Convergencia cross-dispositivo por recibido_en del servidor (TR-17, AC-05)
        const cycle = this._getCurrentAdmissionCycle(inv.id);
        const existingWinner = this.checkinEvents.find(
          (c) => c.invitation_id === inv.id && c.kind === "admitido" && c.admision_ciclo === cycle
        );

        if (existingWinner) {
          duplicados += 1;
          const chk = {
            id: ulid(),
            event_id: ev.id,
            invitation_id: inv.id,
            device_id: batch.device_id,
            sequence: seq,
            kind: "duplicado_tardio",
            veredicto: "ya_registrado",
            admision_ciclo: cycle,
            escaneado_en: toIso(item.scanned_at),
            recibido_en: tIngestIso,
            tardio,
            anula_a: null,
            actor_id: null,
            motivo: null,
            modo: item.modo || "camara",
            verdict_local: item.verdict_local || null,
            resolucion_al_sincronizar: null,
            vigente_checkin_id: existingWinner.id,
            created_at: tIngestIso,
          };
          this.checkinEvents.push(chk);
          results.push({
            sequence: seq,
            invitation_id: inv.id,
            checkin_id: chk.id,
            kind: "duplicado_tardio",
            verdict: "ya_registrado",
            vigente_checkin_id: existingWinner.id,
            tardio,
            duplicado: true,
          });
        } else {
          const finalVerdict =
            item.verdict_local === "no_en_roster"
              ? "no_en_roster"
              : item.verdict_local === "no_verificable_offline"
                ? "no_verificable_offline"
                : "admitido";
          const chk = {
            id: ulid(),
            event_id: ev.id,
            invitation_id: inv.id,
            device_id: batch.device_id,
            sequence: seq,
            kind: "admitido",
            veredicto: finalVerdict,
            admision_ciclo: cycle,
            escaneado_en: toIso(item.scanned_at),
            recibido_en: tIngestIso,
            tardio,
            anula_a: null,
            actor_id: null,
            motivo: null,
            modo: item.modo || "camara",
            verdict_local: item.verdict_local || null,
            resolucion_al_sincronizar: null,
            vigente_checkin_id: null,
            created_at: tIngestIso,
          };
          this.checkinEvents.push(chk);
          aceptados += 1;
          asistentesDelta += 1;
          if (tardio) tardios += 1;
          results.push({
            sequence: seq,
            invitation_id: inv.id,
            checkin_id: chk.id,
            verdict: finalVerdict,
            tardio,
            duplicado: false,
          });
        }
      }

      // Actualizar DeviceSyncState (TR-18)
      const syncKey = `${ev.id}::${batch.device_id}`;
      const existingSync = this.deviceSyncStates.get(syncKey);
      const prevAckSeq = existingSync ? existingSync.ultima_seq_ackeada : 0;
      const nextAckSeq = Math.max(prevAckSeq, maxSeq, Number(batch.seq_hasta || 0));
      const colaReportada = Number(batch.cola_reportada ?? 0);
      const syncRow = {
        id: existingSync?.id || ulid(),
        event_id: ev.id,
        device_id: batch.device_id,
        cola_reportada: colaReportada,
        ultima_seq_ackeada: nextAckSeq,
        seq_confirmada: nextAckSeq,
        heartbeat_en: tIngestIso,
        created_at: existingSync?.created_at || tIngestIso,
        updated_at: tIngestIso,
      };
      this.deviceSyncStates.set(syncKey, syncRow);

      // Outbox delta para proyección sin fan-out síncrono (TR-05)
      this._pushOutbox({
        eventId: ev.id,
        topic: "projection",
        eventType: "checkin_batch_ingested",
        payload: { asistentes_delta: asistentesDelta },
        tIngest: tIngestIso,
      });

      if (this.metrics) {
        if (batch.events.length > 0) this.metrics.checkinRate(ev.id, batch.events.length);
        this.metrics.offlineQueueDepth(ev.id, batch.device_id, colaReportada);
      }

      const responseBody = {
        batch_id: batch.batch_id,
        estado: "aplicado",
        recibido_en: tIngestIso,
        ack_hasta_sequence: nextAckSeq,
        contadores: {
          aceptados,
          tardios,
          duplicados,
          invalidados_al_sincronizar: invalidadosAlSincronizar,
          rechazados,
        },
        results,
        sync_state: {
          device_id: batch.device_id,
          pendientes: colaReportada,
          ultima_seq_ackeada: nextAckSeq,
          heartbeat_en: tIngestIso,
        },
      };

      this.checkinBatchAcks.set(ackKey, {
        id: ulid(),
        session_id: sessionId,
        event_id: ev.id,
        batch_id: batch.batch_id,
        request_hash: requestHash,
        response_body: responseBody,
        created_at: tIngestIso,
      });

      return { replayed: false, body: responseBody };
    });
  }

  async getCheckinBatchAck({ sessionId, batchId }) {
    const rec = this.checkinBatchAcks.get(`${sessionId}::${batchId}`);
    if (!rec) throw new AppError("NOT_FOUND", "Lote no encontrado");
    return rec.response_body;
  }

  async upsertDeviceSyncState({
    sessionId,
    colaReportada,
    ultimaSeqAckeada,
    seqConfirmada = null,
    heartbeatEn = null,
    now = new Date(),
  }) {
    const sess = this.scanSessions.get(sessionId);
    if (!sess || sess.deleted_at) throw new AppError("FORBIDDEN_EVENT_SCOPE", "Sesión inválida");
    const cola = Number(colaReportada);
    const ackSeq = Number(ultimaSeqAckeada);
    if (!Number.isInteger(cola) || cola < 0 || !Number.isInteger(ackSeq) || ackSeq < 0) {
      throw validationError("cola_reportada y ultima_seq_ackeada deben ser enteros >= 0");
    }
    const confSeq =
      seqConfirmada !== null && seqConfirmada !== undefined
        ? Math.min(Number(seqConfirmada), ackSeq)
        : ackSeq;
    const hb = heartbeatEn ? toIso(heartbeatEn) : toIso(now);
    const key = `${sess.event_id}::${sess.device_id}`;
    const existing = this.deviceSyncStates.get(key);
    const row = {
      id: existing?.id || ulid(),
      event_id: sess.event_id,
      device_id: sess.device_id,
      cola_reportada: cola,
      ultima_seq_ackeada: Math.max(existing?.ultima_seq_ackeada || 0, ackSeq),
      seq_confirmada: Math.max(existing?.seq_confirmada || 0, confSeq),
      heartbeat_en: hb,
      created_at: existing?.created_at || hb,
      updated_at: toIso(now),
    };
    this.deviceSyncStates.set(key, row);

    if (this.metrics) {
      this.metrics.offlineQueueDepth(sess.event_id, sess.device_id, cola);
    }

    const derived = deriveSyncPendingState([row], new Date(now).getTime());
    return {
      device_id: sess.device_id,
      pendientes: derived.valor,
      ultima_seq_ackeada: row.ultima_seq_ackeada,
      heartbeat_en: row.heartbeat_en,
    };
  }

  async annulCheckin({ eventId, checkinId, actorId, motivo, now = new Date() }) {
    if (!motivo || String(motivo).trim().length === 0 || String(motivo).trim().length > 280) {
      throw validationError("motivo es obligatorio (1..280 caracteres)", "motivo");
    }
    const ev = this.events.get(eventId);
    if (!ev || ev.deleted_at) throw new AppError("NOT_FOUND", "Evento no encontrado");

    const nowMs = new Date(now).getTime();
    const nowIso = toIso(now);

    // RF-14: Ventana de corrección (abierto o <= 24 h post-cierre)
    if (ev.estado === "cancelado" || ev.estado === "borrador") {
      throw new AppError("CORRECTION_WINDOW_CLOSED", "El evento no está en ventana de corrección");
    }
    if (ev.estado === "cerrado") {
      const closedMs = new Date(ev.cerrado_en).getTime();
      if (nowMs > closedMs + 24 * 60 * 60 * 1000) {
        throw new AppError("CORRECTION_WINDOW_CLOSED", "Expiró la ventana de corrección de 24 h");
      }
    }

    return this.mutexes.checkin.run(eventId, async () => {
      const target = this.checkinEvents.find(
        (c) => c.id === checkinId && c.event_id === eventId
      );
      if (!target || target.kind !== "admitido") {
        throw new AppError("CHECKIN_NOT_FOUND", "Check-in admitido no encontrado");
      }

      // Idempotente por (checkin_id, actor_id) (RF-14, AC-16)
      const existingByActor = this.checkinEvents.find(
        (c) => c.kind === "anulacion" && c.anula_a === checkinId && c.actor_id === actorId
      );
      if (existingByActor) {
        const currentAsistentes = this._computeCorte(eventId).asistentes;
        return {
          replayed: true,
          body: {
            annulment_id: existingByActor.id,
            checkin_id: existingByActor.id,
            annuls_checkin_id: checkinId,
            actor_id: actorId,
            kind: "anulacion",
            motivo: existingByActor.motivo,
            scanned_at: existingByActor.escaneado_en,
            asistentes: currentAsistentes,
          },
        };
      }

      const alreadyAnnulled = this.checkinEvents.some(
        (c) => c.kind === "anulacion" && c.anula_a === checkinId
      );

      this.syntheticSeqCounter += 1;
      const annulment = {
        id: ulid(),
        event_id: eventId,
        invitation_id: target.invitation_id,
        device_id: `console:${actorId}`,
        sequence: this.syntheticSeqCounter,
        kind: "anulacion",
        veredicto: target.veredicto,
        admision_ciclo: target.admision_ciclo,
        escaneado_en: nowIso,
        recibido_en: nowIso,
        tardio: ev.estado === "cerrado",
        anula_a: checkinId,
        actor_id: actorId,
        motivo: String(motivo).trim(),
        modo: "consola",
        verdict_local: null,
        resolucion_al_sincronizar: null,
        vigente_checkin_id: null,
        created_at: nowIso,
      };
      this.checkinEvents.push(annulment);

      this._pushAudit({
        eventId,
        actorId,
        accion: "checkin_anulado",
        entidad: "checkin_event",
        entidadId: checkinId,
        motivo: annulment.motivo,
        ts: nowIso,
        detalle: { annulment_id: annulment.id, invitation_id: target.invitation_id },
      });

      if (!alreadyAnnulled) {
        this._pushOutbox({
          eventId,
          topic: "projection",
          eventType: "checkin_annulled",
          payload: { asistentes_delta: -1 },
          tIngest: nowIso,
        });
      }

      const currentAsistentes = this._computeCorte(eventId).asistentes;
      return {
        replayed: false,
        body: {
          annulment_id: annulment.id,
          checkin_id: annulment.id,
          annuls_checkin_id: checkinId,
          actor_id: actorId,
          kind: "anulacion",
          motivo: annulment.motivo,
          scanned_at: annulment.escaneado_en,
          asistentes: currentAsistentes,
        },
      };
    });
  }

  async listCheckins({ eventId, invitationId = null, guestId = null, verdict = null, limit = 20, cursor = null }) {
    let filterInvId = invitationId;
    if (!filterInvId && guestId) {
      const inv = [...this.invitations.values()].find((i) => i.guest_id === guestId);
      filterInvId = inv?.id || "__none__";
    }
    const items = this.checkinEvents
      .filter((c) => {
        if (c.event_id !== eventId) return false;
        if (filterInvId && c.invitation_id !== filterInvId) return false;
        if (verdict && c.veredicto !== verdict) return false;
        return true;
      })
      .map((c) => ({
        checkin_id: c.id,
        invitation_id: c.invitation_id,
        kind: c.kind,
        verdict: c.veredicto,
        scanned_at: c.escaneado_en,
        tardio: c.tardio,
        device_id: c.device_id,
        annuls_checkin_id: c.anula_a,
      }));
    return paginateArray(items, limit, cursor);
  }

  // ==========================================================================
  // Pagos, Ledger de Doble Entrada y Webhook PSP (RF-11, TR-09, AC-08, AC-09, AC-26)
  // ==========================================================================
  _findPaymentByReservation(reservationId) {
    for (const p of this.payments.values()) {
      if (p.reservation_id === reservationId && !p.deleted_at) return p;
    }
    return null;
  }

  _findPaymentByIdempotencyKey(key) {
    for (const p of this.payments.values()) {
      if (p.idempotency_key === key && !p.deleted_at) return p;
    }
    return null;
  }

  _recordBalancedLedgerPair({ pagoId, movimiento, monto, moneda, nowIso }) {
    if (movimiento === "cobro") {
      const exists = this.paymentEntries.find((e) => e.pago_id === pagoId && e.movimiento === "cobro");
      if (exists) return exists.transaccion_id;
    }

    const txId = ulid();
    const absAmount = Number(Number(monto).toFixed(2));
    if (absAmount <= 0) throw new Error("Ledger amount must be > 0");

    // cobro: débito psp_clearing (+X), crédito worker_payable (-X)
    // reverso: crédito psp_clearing (-X), débito worker_payable (+X)
    const lines =
      movimiento === "cobro"
        ? [
            { cuenta: "psp_clearing", tipo: "debito", importe: absAmount },
            { cuenta: "worker_payable", tipo: "credito", importe: -absAmount },
          ]
        : [
            { cuenta: "worker_payable", tipo: "debito", importe: absAmount },
            { cuenta: "psp_clearing", tipo: "credito", importe: -absAmount },
          ];

    const sum = lines.reduce((acc, l) => acc + l.importe, 0);
    if (Math.abs(sum) > 1e-9 || lines.length !== 2) {
      throw new Error("LEDGER_TRANSACCION_DESBALANCEADA");
    }

    for (const l of lines) {
      this.paymentEntries.push({
        id: ulid(),
        pago_id: pagoId,
        transaccion_id: txId,
        movimiento,
        cuenta: l.cuenta,
        tipo: l.tipo,
        importe: l.importe,
        moneda,
        created_at: nowIso,
        updated_at: nowIso,
        deleted_at: null,
      });
    }
    return txId;
  }

  async processReservationPayment({ reservationId, eventId = null, paymentProvider, now = new Date() }) {
    const resCheck = this.workerReservations.get(reservationId);
    if (!resCheck || resCheck.deleted_at) {
      throw new AppError("NOT_FOUND", "Reserva no encontrada");
    }
    if (eventId && resCheck.event_id !== eventId) {
      throw new AppError("NOT_FOUND", "Reserva no pertenece al evento");
    }

    return this.mutexes.payment.run(reservationId, async () => {
      const res = this.workerReservations.get(reservationId);
      if (res.estado !== "aceptada" && res.estado !== "completada") {
        throw new AppError(
          "RESERVATION_NOT_ACCEPTED",
          `No se puede cobrar una reserva en estado ${res.estado}`
        );
      }

      const idempotencyKey = `pay:${res.id}`;
      const monto = Number(res.costo_congelado_monto);
      const moneda = res.costo_congelado_moneda;
      const nowIso = toIso(now);

      // Persistir la clave ANTES de llamar al PSP (TR-09)
      let payment = this._findPaymentByReservation(res.id);
      if (!payment) {
        payment = {
          id: ulid(),
          reservation_id: res.id,
          idempotency_key: idempotencyKey,
          monto,
          moneda,
          estado_psp: "pendiente",
          psp_charge_id: null,
          cobrado_en: null,
          created_at: nowIso,
          updated_at: nowIso,
          deleted_at: null,
        };
        this.payments.set(payment.id, payment);
      }

      // Ya confirmado -> devolver sin volver a llamar al PSP (AC-08)
      if (payment.cobrado_en) {
        const tx = this.paymentEntries.find((e) => e.pago_id === payment.id && e.movimiento === "cobro");
        return {
          statusCode: 201,
          body: {
            payment_id: payment.id,
            estado: "confirmado",
            monto: payment.monto,
            moneda: payment.moneda,
            idempotency_key: payment.idempotency_key,
            ledger_tx_id: tx?.transaccion_id || null,
          },
        };
      }

      // Si hubo resultado previo desconocido o pendiente, consultar primero al PSP por clave (TR-09, AC-09)
      if (payment.estado_psp === "desconocido") {
        const queried = await paymentProvider.queryByKey(payment.idempotency_key);
        if (queried?.found && queried.status === "succeeded") {
          payment.estado_psp = "confirmado";
          payment.psp_charge_id = queried.psp_charge_id;
          payment.cobrado_en = nowIso;
          payment.updated_at = nowIso;
          const txId = this._recordBalancedLedgerPair({
            pagoId: payment.id,
            movimiento: "cobro",
            monto: payment.monto,
            moneda: payment.moneda,
            nowIso,
          });
          return {
            statusCode: 201,
            body: {
              payment_id: payment.id,
              estado: "confirmado",
              monto: payment.monto,
              moneda: payment.moneda,
              idempotency_key: payment.idempotency_key,
              ledger_tx_id: txId,
            },
          };
        }
      }

      // Llamar al PSP reutilizando siempre la misma idempotencyKey
      let pspRes;
      try {
        pspRes = await paymentProvider.charge({
          idempotencyKey: payment.idempotency_key,
          amount: payment.monto,
          currency: payment.moneda,
          metadata: { reservation_id: res.id, event_id: res.event_id },
        });
      } catch (err) {
        payment.estado_psp = "desconocido";
        payment.updated_at = nowIso;
        if (this.metrics) this.metrics.pspError(err.isTimeout ? "timeout" : "charge_exception");
        return {
          statusCode: 202,
          body: {
            payment_id: payment.id,
            estado: "desconocido",
            monto: payment.monto,
            moneda: payment.moneda,
            idempotency_key: payment.idempotency_key,
          },
        };
      }

      if (!pspRes || pspRes.status === "unknown" || pspRes.status === "pending") {
        payment.estado_psp = "desconocido";
        payment.updated_at = nowIso;
        if (this.metrics) this.metrics.pspError("unknown_status");
        return {
          statusCode: 202,
          body: {
            payment_id: payment.id,
            estado: "desconocido",
            monto: payment.monto,
            moneda: payment.moneda,
            idempotency_key: payment.idempotency_key,
          },
        };
      }

      if (pspRes.status === "succeeded") {
        payment.estado_psp = "confirmado";
        payment.psp_charge_id = pspRes.psp_charge_id;
        payment.cobrado_en = nowIso;
        payment.updated_at = nowIso;
        const txId = this._recordBalancedLedgerPair({
          pagoId: payment.id,
          movimiento: "cobro",
          monto: payment.monto,
          moneda: payment.moneda,
          nowIso,
        });
        return {
          statusCode: 201,
          body: {
            payment_id: payment.id,
            estado: "confirmado",
            monto: payment.monto,
            moneda: payment.moneda,
            idempotency_key: payment.idempotency_key,
            ledger_tx_id: txId,
          },
        };
      }

      payment.estado_psp = "fallido";
      payment.updated_at = nowIso;
      if (this.metrics) this.metrics.pspError("failed");
      throw new AppError("PSP_ERROR", "El PSP rechazó el cobro");
    });
  }

  /** Cobros asentados en el ledger con `cobrado_en` en [from, to) (conciliación diaria). */
  async listLedgerCharges({ from, to }) {
    const f = new Date(from).getTime();
    const t = new Date(to).getTime();
    return [...this.payments.values()]
      .filter((p) => p.cobrado_en && !p.deleted_at)
      .filter((p) => {
        const c = new Date(p.cobrado_en).getTime();
        return c >= f && c < t;
      })
      .map((p) => ({ payment_id: p.id, idempotency_key: p.idempotency_key, monto: Number(p.monto), moneda: p.moneda, cobrado_en: toIso(p.cobrado_en) }));
  }

  async getPaymentByIdempotencyKey(key) {
    const p = [...this.payments.values()].find((x) => x.idempotency_key === key);
    return p ? { payment_id: p.id, monto: Number(p.monto), moneda: p.moneda, cobrado_en: p.cobrado_en ? toIso(p.cobrado_en) : null } : null;
  }

  async getPaymentReconciliation(dia) {
    return this.paymentReconciliations.get(dia) || null;
  }

  /** Inserta el resultado del día; si ya existía, conserva el primero (idempotente). */
  async savePaymentReconciliation(run) {
    if (!this.paymentReconciliations.has(run.dia)) this.paymentReconciliations.set(run.dia, { ...run });
    return this.paymentReconciliations.get(run.dia);
  }

  /** Pagos sin confirmar (`pendiente`/`desconocido`) más viejos que `olderThan` (conciliación, RF-11). */
  async listUnresolvedPayments({ olderThan, limit = 25 }) {
    const cutoff = new Date(olderThan).getTime();
    return [...this.payments.values()]
      .filter(
        (p) =>
          !p.cobrado_en &&
          !p.deleted_at &&
          (p.estado_psp === "pendiente" || p.estado_psp === "desconocido") &&
          new Date(p.created_at).getTime() <= cutoff
      )
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .slice(0, limit)
      .map((p) => ({ payment_id: p.id, reservation_id: p.reservation_id, estado_psp: p.estado_psp }));
  }

  async listReservationPayments({ reservationId }) {
    const res = this.workerReservations.get(reservationId);
    if (!res || res.deleted_at) throw new AppError("NOT_FOUND", "Reserva no encontrada");
    const payment = this._findPaymentByReservation(reservationId);
    if (!payment) return { items: [], reservation_event_id: res.event_id, worker_id: res.worker_id };
    const entries = this.paymentEntries.filter((e) => e.pago_id === payment.id);
    return {
      reservation_event_id: res.event_id,
      worker_id: res.worker_id,
      items: [
        {
          payment_id: payment.id,
          estado: payment.estado_psp,
          monto: payment.monto,
          moneda: payment.moneda,
          idempotency_key: payment.idempotency_key,
          cobrado_en: payment.cobrado_en,
          ledger_entries: entries.map((e) => ({
            id: e.id,
            transaccion_id: e.transaccion_id,
            movimiento: e.movimiento,
            cuenta: e.cuenta,
            tipo: e.tipo,
            importe: e.importe,
            moneda: e.moneda,
          })),
        },
      ],
    };
  }

  async reconcilePspWebhook({
    webhookEventId,
    paymentId = null,
    idempotencyKey = null,
    status,
    amount = null,
    currency = null,
    pspChargeId = null,
    now = new Date(),
  }) {
    if (!webhookEventId || (!idempotencyKey && !paymentId) || !status) {
      throw validationError("event_id, idempotency_key/payment_id y status son obligatorios");
    }

    const payment =
      (idempotencyKey ? this._findPaymentByIdempotencyKey(idempotencyKey) : null) ||
      (paymentId ? this.payments.get(paymentId) : null);
    if (!payment) throw new AppError("NOT_FOUND", "Cobro no encontrado");

    return this.mutexes.payment.run(payment.reservation_id, async () => {
      if (this.webhookEvents.has(webhookEventId)) {
        return { conciliado: true, estado: payment.estado_psp };
      }

      const nowIso = toIso(now);
      this.webhookEvents.set(webhookEventId, {
        webhook_event_id: webhookEventId,
        idempotency_key: payment.idempotency_key,
        processed_at: nowIso,
      });

      // Webhook fuera de orden nunca degrada un cobro ya confirmado (AC-09)
      if (payment.cobrado_en) {
        return { conciliado: true, estado: payment.estado_psp };
      }

      if (status === "succeeded") {
        if (
          (amount !== null && Number(amount) !== Number(payment.monto)) ||
          (currency && String(currency).toUpperCase() !== payment.moneda)
        ) {
          if (this.metrics) this.metrics.pspError("webhook_amount_mismatch");
          return { conciliado: false, estado: payment.estado_psp };
        }
        payment.estado_psp = "confirmado";
        payment.psp_charge_id = pspChargeId || payment.psp_charge_id;
        payment.cobrado_en = nowIso;
        payment.updated_at = nowIso;
        this._recordBalancedLedgerPair({
          pagoId: payment.id,
          movimiento: "cobro",
          monto: payment.monto,
          moneda: payment.moneda,
          nowIso,
        });
      }

      return { conciliado: true, estado: payment.estado_psp };
    });
  }

  // ==========================================================================
  // Barridos de OutboxPoller (RF-04, RF-10, RF-17, NFR-08)
  // ==========================================================================
  async sweepDueReminders({ canalesActivos = ["sms", "email"], now = new Date() }) {
    const nowMs = new Date(now).getTime();
    const nowIso = toIso(now);
    let dispatched = 0;
    let cancelled = 0;

    for (const job of this.reminderJobs.values()) {
      if (job.estado !== "programado") continue;
      if (new Date(job.disparar_en).getTime() > nowMs) continue;

      if (job.plantilla === "recordatorio_rsvp") {
        const guest = this.guests.get(job.guest_id);
        const inv = guest ? [...this.invitations.values()].find((i) => i.guest_id === guest.id) : null;
        const activeRsvp = inv
          ? [...this.rsvpResponses.values()].find((r) => r.invitation_id === inv.id && !r.superseded_at)
          : null;
        if (!guest || guest.deleted_at || !guest.email_cifrado && !guest.telefono_cifrado || job.pii_anonimizada_en) {
          job.estado = "cancelado";
          job.motivo_cancelacion = "destinatario_inexistente";
          job.updated_at = nowIso;
          cancelled += 1;
          continue;
        }
        if (activeRsvp) {
          job.estado = "cancelado";
          job.motivo_cancelacion = "rsvp_registrado";
          job.updated_at = nowIso;
          cancelled += 1;
          continue;
        }
        if (guest[`baja_${job.canal}_en`]) {
          job.estado = "cancelado";
          job.motivo_cancelacion = "invitado_de_baja";
          job.updated_at = nowIso;
          cancelled += 1;
          continue;
        }
        if (!canalesActivos.includes(job.canal)) continue;

        const addr = job.direccion_cifrada ? this._dec(job.direccion_cifrada) : null;
        if (!addr) {
          job.estado = "cancelado";
          job.motivo_cancelacion = "destinatario_inexistente";
          job.updated_at = nowIso;
          cancelled += 1;
          continue;
        }
        const del = this._insertDeliveryIdempotent({
          eventId: job.event_id,
          invitationId: inv.id,
          reminderJobId: job.id,
          subjectId: guest.id,
          normalizedAddr: addr,
          canal: job.canal,
          plantilla: job.plantilla,
          ventana: job.ventana,
          now: nowIso,
        });
        job.estado = "consumido";
        job.updated_at = nowIso;
        if (del.created) {
          dispatched += 1;
          this._pushOutbox({
            eventId: job.event_id,
            topic: "notifications",
            eventType: "reminder_delivery",
            canal: job.canal,
            payload: {
              delivery_id: del.row.id,
              event_id: job.event_id,
              invitation_id: inv.id,
              guest_id: guest.id,
              canal: job.canal,
              plantilla: job.plantilla,
              ventana: job.ventana,
            },
            tIngest: nowIso,
          });
        }
      } else if (job.plantilla === "recordatorio_llegada") {
        const res = this.workerReservations.get(job.worker_reservation_id);
        if (!res || res.deleted_at || res.estado !== "aceptada") {
          job.estado = "cancelado";
          job.motivo_cancelacion = "reserva_cancelada";
          job.updated_at = nowIso;
          cancelled += 1;
          continue;
        }
        const wp = this.workerProfiles.get(res.worker_id);
        const addr = job.direccion_cifrada ? this._dec(job.direccion_cifrada) : null;
        if (!wp || wp.deleted_at || !addr) {
          job.estado = "cancelado";
          job.motivo_cancelacion = "destinatario_inexistente";
          job.updated_at = nowIso;
          cancelled += 1;
          continue;
        }
        const del = this._insertDeliveryIdempotent({
          eventId: job.event_id,
          invitationId: null,
          reminderJobId: job.id,
          subjectId: wp.id,
          normalizedAddr: addr,
          canal: job.canal,
          plantilla: job.plantilla,
          ventana: job.ventana,
          now: nowIso,
        });
        job.estado = "consumido";
        job.updated_at = nowIso;
        if (del.created) {
          dispatched += 1;
          this._pushOutbox({
            eventId: job.event_id,
            topic: "notifications",
            eventType: "worker_arrival_reminder",
            canal: job.canal,
            payload: {
              delivery_id: del.row.id,
              event_id: job.event_id,
              worker_reservation_id: res.id,
              worker_id: wp.id,
              to: addr,
              canal: job.canal,
              plantilla: job.plantilla,
              ventana: job.ventana,
              hora_llegada: res.hora_llegada,
            },
            tIngest: nowIso,
          });
        }
      }
    }

    return { dispatched, cancelled };
  }

  async sweepExpiredReservations({ now = new Date() }) {
    const nowMs = new Date(now).getTime();
    const nowIso = toIso(now);
    let expired = 0;
    for (const res of this.workerReservations.values()) {
      if (res.estado === "solicitada" && !res.deleted_at && new Date(res.expira_en).getTime() <= nowMs) {
        res.estado = "expirada";
        res.updated_at = nowIso;
        expired += 1;
      }
    }
    return { expired };
  }

  async sweepIndeterminadoDeliveries({ now = new Date() }) {
    const cutoffMs = new Date(now).getTime() - 15 * 60 * 1000;
    const nowIso = toIso(now);
    let transitioned = 0;
    const affectedEvents = new Set();

    for (const d of this.invitationDeliveries.values()) {
      if (d.estado === "encolado" && new Date(d.estado_en).getTime() <= cutoffMs) {
        d.estado = "indeterminado";
        d.estado_en = nowIso;
        d.updated_at = nowIso;
        transitioned += 1;
        affectedEvents.add(d.event_id);
      }
    }

    for (const evId of affectedEvents) {
      this._pushOutbox({
        eventId: evId,
        topic: "projection",
        eventType: "delivery_indeterminado",
        payload: { entregas_parciales_set: this._countPartialDeliveries(evId) },
        tIngest: nowIso,
      });
    }

    return { transitioned };
  }

  /**
   * README (LFPDPPP): los teléfonos de los invitados se borran 90 días después del evento.
   * Se borra el teléfono del invitado y las direcciones SMS de sus entregas y recordatorios. Si el
   * teléfono era su única clave de contacto, el invitado queda anonimizado.
   */
  async sweepGuestPhones({ now = new Date() }) {
    const cutoff = new Date(now).getTime() - 90 * 86400_000;
    const nowIso = toIso(now);
    const expired = new Set(
      [...this.events.values()].filter((e) => new Date(e.ventana_fin).getTime() <= cutoff).map((e) => e.id)
    );
    let borrados = 0;
    for (const g of this.guests.values()) {
      if (!expired.has(g.event_id) || !g.telefono_cifrado) continue;
      g.telefono_cifrado = null;
      g.telefono_hmac = null;
      if (!g.email_cifrado && !g.pii_anonimizada_en) g.pii_anonimizada_en = nowIso;
      g.updated_at = nowIso;
      borrados += 1;
    }
    for (const d of this.invitationDeliveries.values()) {
      if (expired.has(d.event_id) && d.canal === "sms" && d.direccion_cifrada) {
        d.direccion_cifrada = null;
        d.pii_anonimizada_en = d.pii_anonimizada_en || nowIso;
      }
    }
    for (const j of this.reminderJobs.values()) {
      if (expired.has(j.event_id) && j.guest_id && j.canal === "sms" && j.direccion_cifrada) j.direccion_cifrada = null;
    }
    return { telefonos_borrados: borrados };
  }

  async sweepRetention({ now = new Date() }) {
    const nowDate = new Date(now);
    const nowIso = nowDate.toISOString();
    const cutoff12m = new Date(nowDate);
    cutoff12m.setUTCMonth(cutoff12m.getUTCMonth() - 12);
    const cutoff24m = new Date(nowDate);
    cutoff24m.setUTCMonth(cutoff24m.getUTCMonth() - 24);

    let anonymizedEvents = 0;
    let anonymizedCheckinEvents = 0;
    let anonymizedWorkers = 0;

    for (const ev of this.events.values()) {
      if (ev.estado !== "cerrado" || !ev.cerrado_en) continue;
      const closedDate = new Date(ev.cerrado_en);

      // 12 meses post-cierre: anonimizar PII de invitados, tokens, entregas y reminder jobs
      if (closedDate <= cutoff12m) {
        let touched = false;
        for (const g of this.guests.values()) {
          if (g.event_id === ev.id && !g.pii_anonimizada_en) {
            g.nombre = "Invitado anonimizado";
            g.email_cifrado = null;
            g.email_hmac = null;
            g.telefono_cifrado = null;
            g.telefono_hmac = null;
            g.pii_anonimizada_en = nowIso;
            g.updated_at = nowIso;
            touched = true;
          }
        }
        for (const inv of this.invitations.values()) {
          if (inv.event_id === ev.id && !inv.pii_anonimizada_en) {
            inv.rsvp_token_hash = null;
            inv.rsvp_token_cifrado = null;
            inv.qr_token_cifrado = null;
            inv.rsvp_revocado_en = inv.rsvp_revocado_en || nowIso;
            inv.checkin_revocado_en = inv.checkin_revocado_en || nowIso;
            inv.pii_anonimizada_en = nowIso;
            inv.updated_at = nowIso;
            touched = true;
          }
        }
        for (const d of this.invitationDeliveries.values()) {
          if (d.event_id === ev.id && !d.pii_anonimizada_en) {
            d.direccion_cifrada = null;
            d.pii_anonimizada_en = nowIso;
            d.updated_at = nowIso;
            touched = true;
          }
        }
        for (const j of this.reminderJobs.values()) {
          if (j.event_id === ev.id && !j.pii_anonimizada_en) {
            if (j.estado === "programado") {
              j.estado = "cancelado";
              j.motivo_cancelacion = "destinatario_inexistente";
            }
            j.direccion_cifrada = null;
            j.pii_anonimizada_en = nowIso;
            j.updated_at = nowIso;
            touched = true;
          }
        }
        if (touched) anonymizedEvents += 1;
      }

      // 24 meses post-cierre: anonimizar device_id en CheckinEvent, conservando (event_id, sequence, veredicto)
      if (closedDate <= cutoff24m) {
        for (const chk of this.checkinEvents) {
          if (chk.event_id === ev.id && chk.device_id !== null) {
            chk.device_id = null;
            anonymizedCheckinEvents += 1;
          }
        }
      }
    }

    // Alcance partido NFR-08 / AC-28: WorkerProfile solo tras 12 meses de SU última actividad
    for (const wp of this.workerProfiles.values()) {
      if (wp.pii_anonimizada_en) continue;
      let lastActivityMs = new Date(wp.updated_at).getTime();
      for (const r of this.workerReservations.values()) {
        if (r.worker_id === wp.id) {
          const rMs = new Date(r.updated_at).getTime();
          if (rMs > lastActivityMs) lastActivityMs = rMs;
        }
      }
      if (lastActivityMs <= cutoff12m.getTime()) {
        wp.telefono_cifrado = null;
        wp.telefono_hmac = null;
        wp.telefono_verificado_en = null;
        wp.fotos = [];
        wp.referencias = [];
        wp.pii_anonimizada_en = nowIso;
        wp.updated_at = nowIso;
        anonymizedWorkers += 1;
      }
    }

    // 24 meses para AuditEntry (AC-18)
    this.auditEntries = this.auditEntries.filter((a) => new Date(a.ts) > cutoff24m);

    return {
      anonymized_events: anonymizedEvents,
      anonymized_checkin_events: anonymizedCheckinEvents,
      anonymized_workers: anonymizedWorkers,
    };
  }
}

export function createStore(options = {}) {
  return new InMemoryStore(options);
}
