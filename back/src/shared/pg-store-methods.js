import QRCode from "qrcode";
import {
  isValidCategoria,
  isValidIanaTimezone,
  isValidRol,
  isValidZona,
  isServicioAllowedForCategorias,
} from "./catalogs.js";
import {
  generateOpaqueToken,
  generateShortCode,
  sha256Hex,
} from "./crypto.js";
import {
  buildTr12Destinatario,
  computeReminderTimes,
  deriveSyncPendingState,
  filterAndRankWorkers,
  normalizePhoneE164,
  paginateArray,
  validateAndNormalizeCsvRow,
  validateCheckinBatchPayload,
  windowContains,
  windowsOverlap,
} from "./domain-helpers.js";
import { AppError, IMPORT_ROW_ERRORS, validationError } from "./errors.js";
import { ulid } from "./ulid.js";

function toIso(d) {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

export function attachPgStoreMethods(PgStoreClass, withTx) {
  const proto = PgStoreClass.prototype;

  proto.updateEvent = async function ({ eventId, patch }) {
    return withTx(this.pool, async (client) => {
      const evRes = await client.query(`SELECT * FROM event WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [
        eventId,
      ]);
      if (evRes.rowCount === 0) throw new AppError("NOT_FOUND", "Evento no encontrado");
      const ev = evRes.rows[0];
      if (ev.estado === "cerrado" || ev.estado === "cancelado") {
        throw new AppError("EVENT_STATE_INVALID", "Evento cerrado o cancelado es de solo lectura");
      }

      const nombre = patch.nombre !== undefined ? String(patch.nombre).trim() : ev.nombre;
      const fecha = patch.fecha !== undefined ? String(patch.fecha) : toIso(ev.fecha).slice(0, 10);
      const timezone = patch.timezone !== undefined ? patch.timezone : ev.timezone;
      if (!isValidIanaTimezone(timezone)) throw validationError("timezone inválida", "timezone");
      const vIni = patch.ventana?.inicio ? new Date(patch.ventana.inicio).toISOString() : toIso(ev.ventana_inicio);
      const vFin = patch.ventana?.fin ? new Date(patch.ventana.fin).toISOString() : toIso(ev.ventana_fin);
      const aforo = patch.aforo !== undefined ? Number(patch.aforo) : ev.aforo;

      if (patch.aforo !== undefined) {
        const gRes = await client.query(`SELECT count(*)::integer AS cnt FROM guest WHERE event_id = $1`, [eventId]);
        if (aforo < gRes.rows[0].cnt) {
          throw new AppError("AFORO_EXCEDIDO", "No se puede reducir aforo por debajo de invitados existentes");
        }
      }

      await client.query(
        `UPDATE event SET nombre = $2, fecha = $3, timezone = $4, ventana_inicio = $5, ventana_fin = $6, aforo = $7
          WHERE id = $1`,
        [eventId, nombre, fecha, timezone, vIni, vFin, aforo]
      );

      if (patch.ventana !== undefined) {
        const times = computeReminderTimes(vIni);
        await client.query(
          `UPDATE reminder_job
              SET disparar_en = CASE ventana WHEN 't_7d' THEN $2::timestamptz WHEN 't_1d' THEN $3::timestamptz ELSE disparar_en END
            WHERE event_id = $1 AND estado = 'programado' AND plantilla = 'recordatorio_rsvp'`,
          [eventId, times.t_7d, times.t_1d]
        );
      }
    });
    return this.getEventDetail({ eventId });
  };

  proto.listGuests = async function ({ eventId, limit = 20, cursor = null, sinMesa = false, includeDeleted = false }) {
    const res = await this.pool.query(
      `SELECT g.*, i.id AS invitation_id, i.codigo_corto,
              r.respuesta AS estado_rsvp,
              sa.table_id
         FROM guest g
         LEFT JOIN invitation i ON i.guest_id = g.id
         LEFT JOIN rsvp_response r ON r.invitation_id = i.id AND r.superseded_at IS NULL
         LEFT JOIN seat_assignment sa ON sa.guest_id = g.id AND sa.estado IN ('confirmado','pendiente')
        WHERE g.event_id = $1
          AND ($2::boolean OR g.deleted_at IS NULL)
          AND (NOT $3::boolean OR sa.id IS NULL)
        ORDER BY g.created_at ASC`,
      [eventId, includeDeleted, sinMesa]
    );
    const items = res.rows.map((r) => ({
      id: r.id,
      nombre: r.nombre,
      email: r.email_cifrado ? this._dec(r.email_cifrado) : null,
      telefono: r.telefono_cifrado ? this._dec(r.telefono_cifrado) : null,
      estado_envio: r.estado_envio,
      estado_rsvp: r.estado_rsvp || null,
      invitation_id: r.invitation_id || null,
      codigo_corto: r.codigo_corto || null,
      table_id: r.table_id || null,
      deleted_at: toIso(r.deleted_at),
    }));
    return paginateArray(items, limit, cursor);
  };

  proto.softDeleteGuest = async function ({ eventId, guestId, actorId, now = new Date() }) {
    return withTx(this.pool, async (client) => {
      const gRes = await client.query(`SELECT * FROM guest WHERE id = $1 AND event_id = $2 FOR UPDATE`, [
        guestId,
        eventId,
      ]);
      if (gRes.rowCount === 0) throw new AppError("NOT_FOUND", "Invitado no encontrado");
      const g = gRes.rows[0];
      if (g.deleted_at) {
        return {
          guest_id: g.id,
          deleted_at: toIso(g.deleted_at),
          token_revocado: true,
          jobs_cancelados: 0,
          asientos_liberados: 0,
        };
      }
      const nowIso = toIso(now);
      await client.query(`UPDATE guest SET deleted_at = $2 WHERE id = $1`, [guestId, nowIso]);
      const invUpd = await client.query(
        `UPDATE invitation SET rsvp_revocado_en = COALESCE(rsvp_revocado_en, $2),
                              checkin_revocado_en = COALESCE(checkin_revocado_en, $2)
          WHERE guest_id = $1
          RETURNING id`,
        [guestId, nowIso]
      );
      if (invUpd.rowCount > 0) {
        await client.query(
          `UPDATE scan_session SET revocation_version = revocation_version + 1
            WHERE event_id = $1 AND deleted_at IS NULL`,
          [eventId]
        );
      }
      let confirmadosDelta = 0;
      if (invUpd.rowCount > 0) {
        const rsvpUpd = await client.query(
          `UPDATE rsvp_response SET superseded_at = $2
            WHERE invitation_id = $1 AND superseded_at IS NULL
            RETURNING respuesta`,
          [invUpd.rows[0].id, nowIso]
        );
        if (rsvpUpd.rowCount > 0 && rsvpUpd.rows[0].respuesta === "confirma") {
          confirmadosDelta = -1;
        }
      }
      const jobsRes = await client.query(
        `UPDATE reminder_job SET estado = 'cancelado', motivo_cancelacion = 'invitado_de_baja'
          WHERE event_id = $1 AND guest_id = $2 AND estado = 'programado'`,
        [eventId, guestId]
      );
      const seatRes = await client.query(
        `UPDATE seat_assignment SET estado = 'liberado', ocupa_capacidad = false, liberado_en = $3, motivo_liberacion = 'baja_invitado'
          WHERE event_id = $1 AND guest_id = $2 AND estado IN ('confirmado','pendiente')`,
        [eventId, guestId, nowIso]
      );
      await this._insertAudit(client, {
        eventId,
        actorId,
        accion: "invitado_baja",
        entidad: "guest",
        entidadId: guestId,
        motivo: "Baja lógica de invitado",
        ts: nowIso,
      });
      await this._insertOutbox(client, {
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
        guest_id: guestId,
        deleted_at: nowIso,
        token_revocado: true,
        jobs_cancelados: jobsRes.rowCount,
        asientos_liberados: seatRes.rowCount,
      };
    });
  };

  proto.previewImportCapacity = async function ({ eventId, parsedRows }) {
    const evRes = await this.pool.query(`SELECT id, aforo FROM event WHERE id = $1 AND deleted_at IS NULL`, [eventId]);
    if (evRes.rowCount === 0) throw new AppError("NOT_FOUND", "Evento no encontrado");
    const ev = evRes.rows[0];
    const existingRes = await this.pool.query(
      `SELECT email_hmac, telefono_hmac FROM guest WHERE event_id = $1`,
      [eventId]
    );
    const existingKeys = new Set();
    for (const g of existingRes.rows) {
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
    const ocupado = existingRes.rowCount;
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
  };

  proto.regenerateInvitationTokens = async function ({
    eventId,
    invitationId,
    qrSigner,
    objectStorage,
    assetsBucket = process.env.ASSETS_BUCKET || "orquesta-assets",
  }) {
    return withTx(this.pool, async (client) => {
      const invRes = await client.query(
        `SELECT * FROM invitation WHERE id = $1 AND event_id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [invitationId, eventId]
      );
      if (invRes.rowCount === 0) throw new AppError("NOT_FOUND", "Invitación no encontrada");
      const inv = invRes.rows[0];
      const nowIso = new Date().toISOString();
      const newVersion = Number(inv.token_version) + 1;
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
      const pngBuf = await QRCode.toBuffer(qrToken, { type: "png", errorCorrectionLevel: "M" });
      await objectStorage.putObject({
        bucket: assetsBucket,
        key: qrS3Key,
        body: pngBuf,
        contentType: "image/png",
        cacheControl: "public, s-maxage=300, stale-while-revalidate=86400",
      });

      await client.query(
        `UPDATE invitation
            SET token_version = $2,
                rsvp_token_hash = $3,
                rsvp_token_cifrado = $4,
                checkin_key_id = $5,
                qr_token_cifrado = $6,
                qr_s3_key = $7,
                qr_emitido_en = $8
          WHERE id = $1`,
        [inv.id, newVersion, sha256Hex(rsvpRaw), this._enc(rsvpRaw), keyId, this._enc(qrToken), qrS3Key, nowIso]
      );
      await client.query(
        `UPDATE scan_session SET roster_version = roster_version + 1 WHERE event_id = $1 AND deleted_at IS NULL`,
        [eventId]
      );
      return {
        invitation_id: inv.id,
        token_version: newVersion,
        rsvp_token: rsvpRaw,
        qr_token: qrToken,
      };
    });
  };

  proto.getPendingSendSummary = async function ({ eventId }) {
    const res = await this.pool.query(
      `SELECT count(*)::integer AS total,
              count(*) FILTER (WHERE telefono_cifrado IS NOT NULL)::integer AS sms,
              count(*) FILTER (WHERE email_cifrado IS NOT NULL)::integer AS email
         FROM guest
        WHERE event_id = $1 AND deleted_at IS NULL AND estado_envio = 'pendiente_envio'`,
      [eventId]
    );
    const r = res.rows[0];
    return {
      destinatarios: r.total,
      por_canal: { sms: r.sms, email: r.email },
      pendiente_envio: r.total,
    };
  };

  proto.dispatchInvitationSend = async function ({
    eventId,
    alcance = "pendiente_envio",
    guestIds = [],
    destinatariosConfirmados,
    canalesActivos = ["sms", "email"],
    actorId,
  }) {
    return withTx(this.pool, async (client) => {
      const evRes = await client.query(`SELECT * FROM event WHERE id = $1 FOR UPDATE`, [eventId]);
      if (evRes.rowCount === 0) throw new AppError("NOT_FOUND", "Evento no encontrado");
      const ev = evRes.rows[0];
      if (ev.estado !== "publicado" && ev.estado !== "en_curso") {
        throw new AppError("EVENT_STATE_INVALID", "Solo eventos publicado o en_curso aceptan envíos");
      }

      const gRes = await client.query(
        `SELECT g.*, i.id AS invitation_id
           FROM guest g JOIN invitation i ON i.guest_id = g.id
          WHERE g.event_id = $1 AND g.deleted_at IS NULL AND g.estado_envio = 'pendiente_envio'
            AND ($2::text = 'pendiente_envio' OR g.id = ANY($3::char(26)[]))`,
        [eventId, alcance, guestIds || []]
      );
      if (gRes.rowCount === 0) {
        throw new AppError("SIN_DESTINATARIOS_PENDIENTES", "No hay destinatarios pendientes");
      }
      if (Number(destinatariosConfirmados) !== gRes.rowCount) {
        throw new AppError("CONFIRMACION_REQUERIDA", "El número de destinatarios no coincide", {
          destinatarios_calculados: gRes.rowCount,
          confirmados: destinatariosConfirmados ?? null,
        });
      }

      const envioId = ulid();
      const nowIso = new Date().toISOString();
      const reminderTimes = computeReminderTimes(toIso(ev.ventana_inicio));
      let entregasEncoladas = 0;

      for (const g of gRes.rows) {
        await client.query(`UPDATE guest SET estado_envio = 'enviado' WHERE id = $1`, [g.id]);
        for (const canal of canalesActivos) {
          const addr =
            canal === "sms"
              ? g.telefono_cifrado
                ? this._dec(g.telefono_cifrado)
                : null
              : g.email_cifrado
                ? this._dec(g.email_cifrado)
                : null;
          if (!addr) continue;

          const dest = buildTr12Destinatario(g.id, addr, canal);
          const delId = ulid();
          const insDel = await client.query(
            `INSERT INTO invitation_delivery (id, event_id, invitation_id, destinatario, direccion_cifrada, canal, plantilla, ventana)
             VALUES ($1, $2, $3, $4, $5, $6, 'invitacion', 'envio_inicial')
             ON CONFLICT (destinatario, plantilla, ventana) DO NOTHING
             RETURNING id`,
            [delId, eventId, g.invitation_id, dest, this._enc(addr), canal]
          );
          if (insDel.rowCount > 0) {
            entregasEncoladas += 1;
            await this._insertOutbox(client, {
              eventId,
              topic: "notifications",
              eventType: "invitation_delivery",
              canal,
              payload: { delivery_id: delId, event_id: eventId, invitation_id: g.invitation_id, guest_id: g.id, canal },
              tIngest: nowIso,
            });
          }

          for (const ventana of ["t_7d", "t_1d"]) {
            await client.query(
              `INSERT INTO reminder_job (id, event_id, guest_id, destinatario, canal, direccion_cifrada, plantilla, ventana, disparar_en)
               VALUES ($1, $2, $3, $4, $5, $6, 'recordatorio_rsvp', $7, $8)
               ON CONFLICT (destinatario, plantilla, ventana) DO NOTHING`,
              [ulid(), eventId, g.id, dest, canal, this._enc(addr), ventana, reminderTimes[ventana]]
            );
          }
        }
      }

      await this._insertAudit(client, {
        eventId,
        actorId,
        accion: "envio_disparado",
        entidad: "event",
        entidadId: eventId,
        motivo: `Envío de invitaciones (${alcance})`,
        ts: nowIso,
      });

      return {
        envio_id: envioId,
        destinatarios: gRes.rowCount,
        entregas_encoladas: entregasEncoladas,
        canales: [...canalesActivos],
      };
    });
  };

  proto.dispatchInvitationResend = async function ({
    eventId,
    guestIds = [],
    canal = "ambos",
    ventana = "resend_1",
    canalesActivos = ["sms", "email"],
    actorId,
  }) {
    if (!/^resend_[1-9][0-9]*$/.test(String(ventana))) {
      throw validationError("ventana debe seguir patrón resend_<n>", "ventana");
    }
    const selectedChannels = canal === "ambos" ? canalesActivos : canalesActivos.filter((c) => c === canal);
    return withTx(this.pool, async (client) => {
      const evRes = await client.query(`SELECT estado FROM event WHERE id = $1`, [eventId]);
      if (evRes.rowCount === 0) throw new AppError("NOT_FOUND", "Evento no encontrado");
      if (!["publicado", "en_curso"].includes(evRes.rows[0].estado)) {
        throw new AppError("EVENT_STATE_INVALID", "Evento no admite envíos");
      }
      const gRes = await client.query(
        `SELECT g.*, i.id AS invitation_id FROM guest g JOIN invitation i ON i.guest_id = g.id
          WHERE g.event_id = $1 AND g.deleted_at IS NULL AND g.id = ANY($2::char(26)[])`,
        [eventId, guestIds]
      );
      const envioId = ulid();
      let entregasEncoladas = 0;
      for (const g of gRes.rows) {
        for (const ch of selectedChannels) {
          const addr =
            ch === "sms"
              ? g.telefono_cifrado
                ? this._dec(g.telefono_cifrado)
                : null
              : g.email_cifrado
                ? this._dec(g.email_cifrado)
                : null;
          if (!addr) continue;
          const delId = ulid();
          const ins = await client.query(
            `INSERT INTO invitation_delivery (id, event_id, invitation_id, destinatario, direccion_cifrada, canal, plantilla, ventana)
             VALUES ($1, $2, $3, $4, $5, $6, 'invitacion', $7)
             ON CONFLICT (destinatario, plantilla, ventana) DO NOTHING`,
            [delId, eventId, g.invitation_id, buildTr12Destinatario(g.id, addr, ch), this._enc(addr), ch, ventana]
          );
          if (ins.rowCount > 0) {
            entregasEncoladas += 1;
            await this._insertOutbox(client, {
              eventId,
              topic: "notifications",
              eventType: "invitation_delivery",
              canal: ch,
              payload: { delivery_id: delId, event_id: eventId, invitation_id: g.invitation_id, guest_id: g.id, canal: ch },
            });
          }
        }
      }
      await this._insertAudit(client, {
        eventId,
        actorId,
        accion: "envio_disparado",
        entidad: "event",
        entidadId: eventId,
        motivo: `Reenvío ${ventana}`,
      });
      return { envio_id: envioId, entregas_encoladas: entregasEncoladas };
    });
  };

  proto.listDeliveries = async function ({ eventId, estado = null, canal = null, limit = 20, cursor = null }) {
    const res = await this.pool.query(
      `SELECT d.*, i.guest_id FROM invitation_delivery d
         LEFT JOIN invitation i ON i.id = d.invitation_id
        WHERE d.event_id = $1
          AND ($2::text IS NULL OR d.estado = $2)
          AND ($3::text IS NULL OR d.canal = $3)
        ORDER BY d.created_at DESC`,
      [eventId, estado, canal]
    );
    const items = res.rows.map((d) => ({
      delivery_id: d.id,
      invitation_id: d.invitation_id,
      guest_id: d.guest_id,
      canal: d.canal,
      plantilla: d.plantilla,
      ventana: d.ventana,
      estado: d.estado,
      intentos: d.intentos,
      estado_en: toIso(d.estado_en),
    }));
    return paginateArray(items, limit, cursor);
  };

  proto.getDeliveryContext = async function (deliveryId) {
    const res = await this.pool.query(
      `SELECT d.*, i.guest_id, i.rsvp_revocado_en, i.rsvp_token_cifrado, i.qr_token_cifrado, i.qr_s3_key, i.codigo_corto,
              g.nombre AS guest_nombre, g.deleted_at AS guest_deleted_at,
              e.nombre AS event_nombre,
              rj.estado AS reminder_estado, rj.pii_anonimizada_en AS reminder_anon
         FROM invitation_delivery d
         LEFT JOIN invitation i ON i.id = d.invitation_id
         LEFT JOIN guest g ON g.id = i.guest_id
         LEFT JOIN event e ON e.id = d.event_id
         LEFT JOIN reminder_job rj ON rj.id = d.reminder_job_id
        WHERE d.id = $1`,
      [deliveryId]
    );
    if (res.rowCount === 0) return null;
    const r = res.rows[0];
    return {
      delivery: {
        ...r,
        direccion_plana: r.direccion_cifrada ? this._dec(r.direccion_cifrada) : null,
      },
      invitation: r.invitation_id
        ? {
            id: r.invitation_id,
            rsvp_revocado_en: r.rsvp_revocado_en,
            qr_s3_key: r.qr_s3_key,
            codigo_corto: r.codigo_corto,
            rsvp_token_plano: r.rsvp_token_cifrado ? this._dec(r.rsvp_token_cifrado) : null,
            qr_token_plano: r.qr_token_cifrado ? this._dec(r.qr_token_cifrado) : null,
          }
        : null,
      guest: r.guest_id ? { id: r.guest_id, nombre: r.guest_nombre, deleted_at: r.guest_deleted_at } : null,
      event: { id: r.event_id, nombre: r.event_nombre },
      reminderJob: r.reminder_job_id ? { id: r.reminder_job_id, estado: r.reminder_estado, pii_anonimizada_en: r.reminder_anon } : null,
    };
  };

  proto.markDeliveryResult = async function ({ deliveryId, success, skipCancelled = false, now = new Date() }) {
    return withTx(this.pool, async (client) => {
      const res = await client.query(`SELECT * FROM invitation_delivery WHERE id = $1 FOR UPDATE`, [deliveryId]);
      if (res.rowCount === 0) return null;
      const d = res.rows[0];
      if (d.estado === "entregado" || d.estado === "rebotado") return { delivery: d, terminal: true };
      const nowIso = toIso(now);
      if (skipCancelled) {
        if (d.reminder_job_id) {
          await client.query(
            `UPDATE reminder_job SET estado = 'cancelado', motivo_cancelacion = 'invitado_de_baja'
              WHERE id = $1 AND estado = 'programado'`,
            [d.reminder_job_id]
          );
        }
        return { delivery: d, skipped: true };
      }

      let nextEstado = d.estado;
      let nextIntentos = d.intentos;
      if (success) {
        nextEstado = "entregado";
      } else {
        nextIntentos = Math.min(3, d.intentos + 1);
        if (nextIntentos >= 3) nextEstado = "rebotado";
      }
      await client.query(
        `UPDATE invitation_delivery SET estado = $2, intentos = $3, estado_en = $4 WHERE id = $1`,
        [deliveryId, nextEstado, nextIntentos, nowIso]
      );
      const cntRes = await client.query(
        `SELECT count(*)::integer AS cnt FROM (
           SELECT invitation_id, plantilla, ventana
             FROM invitation_delivery
            WHERE event_id = $1 AND invitation_id IS NOT NULL
            GROUP BY invitation_id, plantilla, ventana
           HAVING bool_or(estado = 'entregado') AND bool_or(estado IN ('rebotado','indeterminado'))
         ) t`,
        [d.event_id]
      );
      await this._insertOutbox(client, {
        eventId: d.event_id,
        topic: "projection",
        eventType: "delivery_status_updated",
        payload: { entregas_parciales_set: cntRes.rows[0].cnt },
        tIngest: nowIso,
      });
      return { delivery: { ...d, estado: nextEstado, intentos: nextIntentos }, rebotado: nextEstado === "rebotado", retryable: !success && nextEstado !== "rebotado" };
    });
  };

  proto.getPublicEventSummary = async function (eventId) {
    const res = await this.pool.query(
      `SELECT e.*, v.nombre AS venue_nombre, v.zona AS venue_zona, v.direccion AS venue_direccion
         FROM event e JOIN venue v ON v.id = e.venue_id
        WHERE e.id = $1 AND e.deleted_at IS NULL`,
      [eventId]
    );
    if (res.rowCount === 0) throw new AppError("NOT_FOUND", "Evento no encontrado");
    const r = res.rows[0];
    return {
      event_id: r.id,
      nombre: r.nombre,
      fecha: toIso(r.fecha).slice(0, 10),
      inicio: toIso(r.ventana_inicio),
      fin: toIso(r.ventana_fin),
      timezone: r.timezone,
      venue: { nombre: r.venue_nombre, zona: r.venue_zona, direccion: r.venue_direccion },
    };
  };

  proto.getPublicInvitationByToken = async function ({ rawToken, objectStorage }) {
    if (typeof rawToken !== "string" || rawToken.split(".").length === 3 || rawToken.startsWith("chk_")) {
      throw new AppError("TOKEN_TIPO_INCORRECTO", "El token de check-in no puede usarse para RSVP");
    }
    const res = await this.pool.query(
      `SELECT i.*, g.deleted_at AS guest_deleted_at,
              e.nombre AS event_nombre, e.fecha, e.ventana_inicio, e.ventana_fin, e.timezone,
              v.nombre AS venue_nombre, v.direccion AS venue_direccion,
              r.respuesta, r.respondido_en
         FROM invitation i
         JOIN guest g ON g.id = i.guest_id
         JOIN event e ON e.id = i.event_id
         JOIN venue v ON v.id = e.venue_id
         LEFT JOIN rsvp_response r ON r.invitation_id = i.id AND r.superseded_at IS NULL
        WHERE i.rsvp_token_hash = $1`,
      [sha256Hex(rawToken)]
    );
    if (res.rowCount === 0 || res.rows[0].pii_anonimizada_en) {
      throw new AppError("TOKEN_INVALIDO", "Invitación no encontrada");
    }
    const row = res.rows[0];
    if (row.rsvp_revocado_en || row.deleted_at || row.guest_deleted_at) {
      throw new AppError("INVITACION_REVOCADA", "La invitación fue revocada");
    }
    return {
      respuesta: row.respuesta || null,
      respondido_en: toIso(row.respondido_en),
      qr: {
        token: row.qr_token_cifrado ? this._dec(row.qr_token_cifrado) : null,
        png_url: row.qr_s3_key ? objectStorage.getPublicUrl({ key: row.qr_s3_key }) : null,
        codigo_corto: row.codigo_corto,
      },
      evento: {
        event_id: row.event_id,
        nombre: row.event_nombre,
        fecha: toIso(row.fecha).slice(0, 10),
        inicio: toIso(row.ventana_inicio),
        fin: toIso(row.ventana_fin),
        timezone: row.timezone,
        lugar: row.venue_nombre,
        direccion: row.venue_direccion,
      },
    };
  };

  proto.submitPublicRsvp = async function ({ rawToken, respuesta, objectStorage, now = new Date() }) {
    if (respuesta !== "confirma" && respuesta !== "declina") {
      throw validationError("respuesta inválida", "respuesta");
    }
    if (typeof rawToken !== "string" || rawToken.split(".").length === 3 || rawToken.startsWith("chk_")) {
      throw new AppError("TOKEN_TIPO_INCORRECTO", "Token incorrecto");
    }
    return withTx(this.pool, async (client) => {
      const invRes = await client.query(
        `SELECT i.*, g.deleted_at AS guest_deleted_at,
                e.nombre AS event_nombre, e.fecha, e.ventana_inicio, e.ventana_fin, e.timezone,
                v.nombre AS venue_nombre, v.direccion AS venue_direccion
           FROM invitation i
           JOIN guest g ON g.id = i.guest_id
           JOIN event e ON e.id = i.event_id
           JOIN venue v ON v.id = e.venue_id
          WHERE i.rsvp_token_hash = $1 FOR UPDATE OF i`,
        [sha256Hex(rawToken)]
      );
      if (invRes.rowCount === 0 || invRes.rows[0].pii_anonimizada_en) {
        throw new AppError("TOKEN_INVALIDO", "Invitación no encontrada");
      }
      const inv = invRes.rows[0];
      if (inv.rsvp_revocado_en || inv.deleted_at || inv.guest_deleted_at) {
        throw new AppError("INVITACION_REVOCADA", "Invitación revocada");
      }

      const prevRes = await client.query(
        `SELECT * FROM rsvp_response WHERE invitation_id = $1 AND superseded_at IS NULL FOR UPDATE`,
        [inv.id]
      );
      const prev = prevRes.rows[0] || null;
      const nowMs = new Date(now).getTime();
      let respondidoMs = nowMs;
      let supersededAt = null;
      if (prev) {
        const supMs = Math.max(nowMs, new Date(prev.respondido_en).getTime() + 1);
        supersededAt = new Date(supMs).toISOString();
        respondidoMs = supMs;
        await client.query(`UPDATE rsvp_response SET superseded_at = $2 WHERE id = $1`, [prev.id, supersededAt]);
      }
      const respondidoIso = new Date(respondidoMs).toISOString();
      await client.query(
        `INSERT INTO rsvp_response (id, event_id, invitation_id, respuesta, respondido_en)
         VALUES ($1, $2, $3, $4, $5)`,
        [ulid(), inv.event_id, inv.id, respuesta, respondidoIso]
      );

      const remRes = await client.query(
        `UPDATE reminder_job SET estado = 'cancelado', motivo_cancelacion = 'rsvp_registrado'
          WHERE event_id = $1 AND guest_id = $2 AND plantilla = 'recordatorio_rsvp' AND estado = 'programado'`,
        [inv.event_id, inv.guest_id]
      );

      if (respuesta === "declina") {
        await client.query(
          `UPDATE seat_assignment SET estado = 'liberado', ocupa_capacidad = false, liberado_en = $3, motivo_liberacion = 'rsvp_declina'
            WHERE event_id = $1 AND guest_id = $2 AND estado IN ('confirmado','pendiente')`,
          [inv.event_id, inv.guest_id, respondidoIso]
        );
      } else if (respuesta === "confirma") {
        await client.query(
          `UPDATE seat_assignment SET estado = 'confirmado'
            WHERE event_id = $1 AND guest_id = $2 AND estado = 'pendiente'`,
          [inv.event_id, inv.guest_id]
        );
      }

      let confirmadosDelta = 0;
      if (!prev && respuesta === "confirma") confirmadosDelta = 1;
      else if (prev && prev.respuesta !== "confirma" && respuesta === "confirma") confirmadosDelta = 1;
      else if (prev && prev.respuesta === "confirma" && respuesta === "declina") confirmadosDelta = -1;
      if (confirmadosDelta !== 0) {
        await this._insertOutbox(client, {
          eventId: inv.event_id,
          topic: "projection",
          eventType: "rsvp_delta",
          payload: { confirmados_delta: confirmadosDelta },
          tIngest: respondidoIso,
        });
      }

      return {
        isChange: Boolean(prev),
        body: {
          respuesta,
          respondido_en: respondidoIso,
          superseded_at: supersededAt,
          qr: {
            token: inv.qr_token_cifrado ? this._dec(inv.qr_token_cifrado) : null,
            png_url: inv.qr_s3_key ? objectStorage.getPublicUrl({ key: inv.qr_s3_key }) : null,
            codigo_corto: inv.codigo_corto,
          },
          recordatorios_cancelados: remRes.rowCount,
          evento: {
            event_id: inv.event_id,
            nombre: inv.event_nombre,
            fecha: toIso(inv.fecha).slice(0, 10),
            inicio: toIso(inv.ventana_inicio),
            fin: toIso(inv.ventana_fin),
            timezone: inv.timezone,
            lugar: inv.venue_nombre,
            direccion: inv.venue_direccion,
          },
        },
      };
    });
  };

  proto.createTable = async function ({ eventId, numero = null, nombre = null, capacidad }) {
    const cap = Number(capacidad);
    if (!Number.isInteger(cap) || cap <= 0) throw validationError("capacidad inválida", "capacidad");
    return withTx(this.pool, async (client) => {
      let num = numero !== null && numero !== undefined ? Number(numero) : null;
      if (num === null) {
        const mRes = await client.query(
          `SELECT COALESCE(max(numero), 0)::integer + 1 AS next_num FROM event_table WHERE event_id = $1 AND deleted_at IS NULL`,
          [eventId]
        );
        num = mRes.rows[0].next_num;
      }
      const res = await client.query(
        `INSERT INTO event_table (id, event_id, numero, nombre, capacidad) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [ulid(), eventId, num, nombre || `Mesa ${num}`, cap]
      );
      return { ...res.rows[0], ocupacion: 0 };
    });
  };

  proto.listTables = async function ({ eventId, limit = 20, cursor = null }) {
    const res = await this.pool.query(
      `SELECT t.id, t.numero, t.nombre, t.capacidad,
              count(sa.id) FILTER (WHERE sa.ocupa_capacidad)::integer AS ocupacion
         FROM event_table t
         LEFT JOIN seat_assignment sa ON sa.table_id = t.id AND sa.ocupa_capacidad
        WHERE t.event_id = $1 AND t.deleted_at IS NULL
        GROUP BY t.id
        ORDER BY t.numero ASC`,
      [eventId]
    );
    return paginateArray(res.rows, limit, cursor);
  };

  proto.assignSeat = async function ({ eventId, guestId, tableId, actorId }) {
    return withTx(this.pool, async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 2))`, [eventId]);
      const gRes = await client.query(
        `SELECT g.id, i.id AS invitation_id
           FROM guest g LEFT JOIN invitation i ON i.guest_id = g.id
          WHERE g.id = $1 AND g.event_id = $2 AND g.deleted_at IS NULL`,
        [guestId, eventId]
      );
      if (gRes.rowCount === 0) throw new AppError("NOT_FOUND", "Invitado no encontrado en este evento");

      const tRes = await client.query(`SELECT * FROM event_table WHERE id = $1 AND event_id = $2 AND deleted_at IS NULL FOR UPDATE`, [
        tableId,
        eventId,
      ]);
      if (tRes.rowCount === 0) throw new AppError("NOT_FOUND", "Mesa no encontrada");
      const table = tRes.rows[0];

      const curRes = await client.query(
        `SELECT * FROM seat_assignment WHERE event_id = $1 AND guest_id = $2 AND estado IN ('confirmado','pendiente') FOR UPDATE`,
        [eventId, guestId]
      );
      const current = curRes.rows[0];
      if (current && current.table_id === tableId) {
        return { created: false, body: { id: current.id, guest_id: guestId, table_id: tableId, estado: "asignado", estado_asiento: current.estado } };
      }

      const rsvpRes = gRes.rows[0].invitation_id
        ? await client.query(
            `SELECT respuesta FROM rsvp_response WHERE invitation_id = $1 AND superseded_at IS NULL`,
            [gRes.rows[0].invitation_id]
          )
        : { rowCount: 0, rows: [] };
      const activeRespuesta = rsvpRes.rows[0]?.respuesta || null;
      if (activeRespuesta === "declina") {
        throw new AppError("EVENT_STATE_INVALID", "El invitado declinó su asistencia");
      }

      const occRes = await client.query(
        `SELECT count(*)::integer AS occ FROM seat_assignment WHERE event_id = $1 AND table_id = $2 AND ocupa_capacidad`,
        [eventId, tableId]
      );
      if (occRes.rows[0].occ >= table.capacidad) {
        throw new AppError("MESA_SIN_CAPACIDAD", "La mesa alcanzó su capacidad máxima");
      }

      const nowIso = new Date().toISOString();
      if (current) {
        await client.query(
          `UPDATE seat_assignment SET estado = 'liberado', ocupa_capacidad = false, liberado_en = $2, motivo_liberacion = 'reasignado' WHERE id = $1`,
          [current.id, nowIso]
        );
      }
      const seatEstado = activeRespuesta === "confirma" ? "confirmado" : "pendiente";
      const seatId = ulid();
      await client.query(
        `INSERT INTO seat_assignment (id, event_id, guest_id, table_id, estado, ocupa_capacidad, asignado_en)
         VALUES ($1, $2, $3, $4, $5, true, $6)`,
        [seatId, eventId, guestId, tableId, seatEstado, nowIso]
      );
      if (current) {
        await this._insertAudit(client, {
          eventId,
          actorId,
          accion: "asiento_movido",
          entidad: "seat_assignment",
          entidadId: seatId,
          motivo: "Reasignación de mesa",
          ts: nowIso,
        });
      }
      return { created: !current, body: { id: seatId, guest_id: guestId, table_id: tableId, estado: "asignado", estado_asiento: seatEstado } };
    });
  };

  proto.releaseSeat = async function ({ eventId, guestId }) {
    await this.pool.query(
      `UPDATE seat_assignment SET estado = 'liberado', ocupa_capacidad = false, liberado_en = now(), motivo_liberacion = 'reasignado'
        WHERE event_id = $1 AND guest_id = $2 AND estado IN ('confirmado','pendiente')`,
      [eventId, guestId]
    );
  };

  proto.listUnseatedGuests = async function ({ eventId, limit = 20, cursor = null }) {
    const res = await this.pool.query(
      `SELECT g.id AS guest_id, g.nombre, r.respuesta AS estado_rsvp
         FROM guest g
         LEFT JOIN invitation i ON i.guest_id = g.id
         LEFT JOIN rsvp_response r ON r.invitation_id = i.id AND r.superseded_at IS NULL
        WHERE g.event_id = $1 AND g.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM seat_assignment sa WHERE sa.guest_id = g.id AND sa.estado IN ('confirmado','pendiente'))`,
      [eventId]
    );
    return paginateArray(res.rows, limit, cursor);
  };

  proto.getWorkerProfileByUserId = async function (userId) {
    const res = await this.pool.query(
      `SELECT wp.*,
              (SELECT count(*)::integer FROM worker_reservation wr
                WHERE wr.worker_id = wp.id AND wr.estado = 'completada' AND wr.deleted_at IS NULL) AS eventos_completados
         FROM worker_profile wp
        WHERE wp.user_id = $1 AND wp.deleted_at IS NULL`,
      [userId]
    );
    if (res.rowCount === 0) return null;
    const wp = res.rows[0];
    return {
      worker_id: wp.id,
      user_id: wp.user_id,
      tipo: wp.tipo,
      plazas_ofrecidas: wp.plazas_ofrecidas,
      nombre_publico: wp.nombre_publico,
      categorias: wp.categorias || [],
      servicios: wp.servicios || [],
      tarifa: wp.tarifa_monto ? { modo: wp.tarifa_modo, monto: Number(wp.tarifa_monto), moneda: wp.tarifa_moneda, unidad: wp.tarifa_unidad } : null,
      zonas: wp.zonas || [],
      radio_km: wp.radio_km !== null ? Number(wp.radio_km) : null,
      idiomas: wp.idiomas || [],
      anios_experiencia: wp.anios_experiencia,
      fotos: wp.fotos || [],
      referencias: wp.referencias || [],
      estado: wp.estado,
      telefono_e164: wp.telefono_cifrado ? this._dec(wp.telefono_cifrado) : null,
      email_verificado_en: toIso(wp.email_verificado_en),
      telefono_verificado_en: toIso(wp.telefono_verificado_en),
      eventos_completados: Number(wp.eventos_completados || 0),
    };
  };

  proto.createWorkerProfile = async function ({ userId, data }) {
    return withTx(this.pool, async (client) => {
      const exRes = await client.query(
        `SELECT id FROM worker_profile WHERE user_id = $1 AND deleted_at IS NULL`,
        [userId]
      );
      if (exRes.rowCount > 0) {
        throw new AppError("EMAIL_YA_REGISTRADA", "El usuario ya posee un perfil de trabajador");
      }
      if (!["persona", "empresa"].includes(data.tipo)) {
        throw validationError("tipo debe ser 'persona' o 'empresa'", "tipo");
      }
      const plazas = data.plazas_ofrecidas === undefined ? 1 : Number(data.plazas_ofrecidas);
      if (!Number.isInteger(plazas) || plazas < 1 || plazas > 50) {
        throw validationError("plazas_ofrecidas debe estar entre 1 y 50", "plazas_ofrecidas");
      }
      if (data.tipo === "persona" && plazas !== 1) {
        throw validationError("Un perfil persona solo puede declarar 1 plaza", "plazas_ofrecidas");
      }
      if (!Array.isArray(data.categorias) || data.categorias.length < 1 || data.categorias.length > 3 || !data.categorias.every(isValidCategoria)) {
        throw validationError("categorias debe tener 1..3 categorías válidas", "categorias");
      }
      const srv = data.servicios || [];
      if (!Array.isArray(srv) || !srv.every((s) => isServicioAllowedForCategorias(s, data.categorias))) {
        throw validationError("servicios debe ser subconjunto de categorias", "servicios");
      }
      if (!Array.isArray(data.zonas) || data.zonas.length < 1 || data.zonas.length > 5 || !data.zonas.every(isValidZona)) {
        throw validationError("zonas debe tener 1..5 zonas válidas", "zonas");
      }
      const fotos = data.fotos || [];
      const referencias = data.referencias || [];
      if (!Array.isArray(fotos) || fotos.length > 3) throw validationError("máximo 3 fotos", "fotos");
      if (!Array.isArray(referencias) || referencias.length > 3) throw validationError("máximo 3 referencias", "referencias");

      const phone = data.telefono_e164 ? normalizePhoneE164(data.telefono_e164) : null;
      if (data.telefono_e164 && !phone) throw validationError("telefono_e164 inválido", "telefono_e164");

      await client.query(
        `UPDATE "user" SET roles = CASE WHEN 'worker' = ANY(roles) THEN roles ELSE array_append(roles, 'worker') END WHERE id = $1`,
        [userId]
      );

      const id = ulid();
      await client.query(
        `INSERT INTO worker_profile (
           id, user_id, tipo, plazas_ofrecidas, nombre_publico, categorias, servicios,
           tarifa_monto, tarifa_moneda, tarifa_unidad, zonas, radio_km, idiomas, anios_experiencia,
           fotos, referencias, telefono_cifrado, telefono_hmac, email_verificado_en
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
           (SELECT email_verificado_en FROM "user" WHERE id = $2))`,
        [
          id,
          userId,
          data.tipo,
          plazas,
          String(data.nombre_publico || "").trim(),
          [...new Set(data.categorias)],
          [...new Set(srv)],
          data.tarifa?.monto ?? null,
          data.tarifa?.moneda ?? null,
          data.tarifa?.unidad ?? null,
          [...new Set(data.zonas)],
          data.radio_km ?? null,
          data.idiomas || [],
          data.anios_experiencia ?? data["años_experiencia"] ?? null,
          fotos,
          referencias,
          phone ? this._enc(phone) : null,
          phone ? this._hmac(phone) : null,
        ]
      );
      return this.getWorkerProfileByUserId(userId);
    });
  };

  proto.searchWorkers = async function (filters) {
    const wpRes = await this.pool.query(`SELECT * FROM worker_profile WHERE deleted_at IS NULL`);
    const resRes = await this.pool.query(`SELECT * FROM worker_reservation WHERE deleted_at IS NULL AND estado IN ('aceptada','completada')`);
    const completedCounts = new Map();
    const accepted = [];
    for (const r of resRes.rows) {
      if (r.estado === "completada") completedCounts.set(r.worker_id, (completedCounts.get(r.worker_id) || 0) + 1);
      else accepted.push(r);
    }
    const ranked = filterAndRankWorkers({ profiles: wpRes.rows, completedCounts, acceptedReservations: accepted, filters });
    if (ranked.length === 0 && this.metrics) {
      this.metrics.workerSearchZeroResults(filters);
    }
    return paginateArray(ranked, filters.limit || 20, filters.cursor || null);
  };

  proto.getPublicWorkerProfile = async function (workerId) {
    const res = await this.pool.query(`SELECT * FROM worker_profile_publico WHERE worker_id = $1`, [workerId]);
    if (res.rowCount === 0) throw new AppError("NOT_FOUND", "Trabajador no encontrado");
    const r = res.rows[0];
    return {
      worker_id: r.worker_id,
      tipo: r.tipo,
      plazas_ofrecidas: r.plazas_ofrecidas,
      nombre_publico: r.nombre_publico,
      categorias: r.categorias,
      servicios: r.servicios,
      tarifa: { modo: r.tarifa_modo, monto: Number(r.tarifa_monto), moneda: r.tarifa_moneda, unidad: r.tarifa_unidad },
      zonas: r.zonas,
      radio_km: r.radio_km !== null ? Number(r.radio_km) : null,
      idiomas: r.idiomas,
      anios_experiencia: r.anios_experiencia,
      eventos_completados: r.eventos_completados,
    };
  };

  proto.getWorkerBusyWindows = async function ({ workerId, desde = null, hasta = null }) {
    const res = await this.pool.query(
      `SELECT inicio, fin FROM worker_reservation
        WHERE worker_id = $1 AND estado = 'aceptada' AND deleted_at IS NULL
          AND ($2::timestamptz IS NULL OR tstzrange(inicio, fin, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)'))
        ORDER BY inicio ASC`,
      [workerId, desde, hasta]
    );
    return {
      worker_id: workerId,
      ventana_ocupada: res.rows.map((r) => ({ inicio: toIso(r.inicio), fin: toIso(r.fin) })),
    };
  };

  proto.createAvailability = async function ({ userId, data }) {
    const wp = await this.getWorkerProfileByUserId(userId);
    if (!wp) throw new AppError("NOT_FOUND", "Perfil no encontrado");
    const id = ulid();
    const res = await this.pool.query(
      `INSERT INTO availability_window (id, worker_id, inicio, fin, zona, rol) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [id, wp.worker_id, data.inicio, data.fin, data.zona, data.rol]
    );
    const w = res.rows[0];
    return { window_id: w.id, inicio: toIso(w.inicio), fin: toIso(w.fin), zona: w.zona, rol: w.rol };
  };

  proto.createOrGetScanSession = async function ({ eventId, deviceId, userId = null, accessTokenId = null, rol = "staff", expiraEn = null }) {
    const evRes = await this.pool.query(`SELECT ventana_fin, estado FROM event WHERE id = $1`, [eventId]);
    if (evRes.rowCount === 0) throw new AppError("NOT_FOUND", "Evento no encontrado");
    const ev = evRes.rows[0];
    const res = await this.pool.query(
      `INSERT INTO scan_session (id, event_id, device_id, user_id, access_token_id, rol, expira_en)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (event_id, device_id) WHERE deleted_at IS NULL DO UPDATE SET updated_at = now()
       RETURNING *`,
      [ulid(), eventId, deviceId, userId, accessTokenId, rol, expiraEn || toIso(ev.ventana_fin)]
    );
    const s = res.rows[0];
    return {
      session_id: s.id,
      event_id: s.event_id,
      rol: s.rol,
      roster_version: s.roster_version,
      revocation_version: s.revocation_version,
      expira_en: toIso(s.expira_en),
    };
  };

  proto.sweepDueReminders = async function ({ canalesActivos = ["sms", "email"], now = new Date() } = {}) {
    const nowIso = toIso(now);
    return withTx(this.pool, async (client) => {
      const jobsRes = await client.query(
        `SELECT * FROM reminder_job
          WHERE estado = 'programado' AND disparar_en <= $1
          ORDER BY disparar_en ASC
          FOR UPDATE SKIP LOCKED`,
        [nowIso]
      );
      let dispatched = 0;
      let cancelled = 0;

      for (const job of jobsRes.rows) {
        if (job.plantilla === "recordatorio_rsvp") {
          const gRes = await client.query(
            `SELECT g.id, g.deleted_at, g.email_cifrado, g.telefono_cifrado,
                    i.id AS invitation_id, i.deleted_at AS inv_deleted_at, i.rsvp_revocado_en
               FROM guest g
               LEFT JOIN invitation i ON i.guest_id = g.id
              WHERE g.id = $1`,
            [job.guest_id]
          );
          const g = gRes.rows[0];
          if (
            !g ||
            g.deleted_at ||
            g.inv_deleted_at ||
            g.rsvp_revocado_en ||
            job.pii_anonimizada_en ||
            (!g.email_cifrado && !g.telefono_cifrado)
          ) {
            await client.query(
              `UPDATE reminder_job SET estado = 'cancelado', motivo_cancelacion = 'destinatario_inexistente' WHERE id = $1`,
              [job.id]
            );
            cancelled += 1;
            continue;
          }
          const rsvpRes = await client.query(
            `SELECT 1 FROM rsvp_response WHERE invitation_id = $1 AND superseded_at IS NULL`,
            [g.invitation_id]
          );
          if (rsvpRes.rowCount > 0) {
            await client.query(
              `UPDATE reminder_job SET estado = 'cancelado', motivo_cancelacion = 'rsvp_registrado' WHERE id = $1`,
              [job.id]
            );
            cancelled += 1;
            continue;
          }
          if (!canalesActivos.includes(job.canal)) continue;
          const addr = job.direccion_cifrada ? this._dec(job.direccion_cifrada) : null;
          if (!addr) {
            await client.query(
              `UPDATE reminder_job SET estado = 'cancelado', motivo_cancelacion = 'destinatario_inexistente' WHERE id = $1`,
              [job.id]
            );
            cancelled += 1;
            continue;
          }
          const delId = ulid();
          const insDel = await client.query(
            `INSERT INTO invitation_delivery
               (id, event_id, invitation_id, reminder_job_id, destinatario, direccion_cifrada, canal, plantilla, ventana, estado_en)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (destinatario, plantilla, ventana) DO NOTHING
             RETURNING id`,
            [
              delId,
              job.event_id,
              g.invitation_id,
              job.id,
              buildTr12Destinatario(g.id, addr, job.canal),
              this._enc(addr),
              job.canal,
              job.plantilla,
              job.ventana,
              nowIso,
            ]
          );
          await client.query(`UPDATE reminder_job SET estado = 'consumido' WHERE id = $1`, [job.id]);
          if (insDel.rowCount > 0) {
            dispatched += 1;
            await this._insertOutbox(client, {
              eventId: job.event_id,
              topic: "notifications",
              eventType: "reminder_delivery",
              canal: job.canal,
              payload: {
                delivery_id: delId,
                event_id: job.event_id,
                invitation_id: g.invitation_id,
                guest_id: g.id,
                canal: job.canal,
                plantilla: job.plantilla,
                ventana: job.ventana,
              },
              tIngest: nowIso,
            });
          }
        } else if (job.plantilla === "recordatorio_llegada") {
          const rRes = await client.query(
            `SELECT wr.id, wr.estado, wr.deleted_at, wr.worker_id, wr.hora_llegada, wp.deleted_at AS wp_deleted_at
               FROM worker_reservation wr
               JOIN worker_profile wp ON wp.id = wr.worker_id
              WHERE wr.id = $1`,
            [job.worker_reservation_id]
          );
          const r = rRes.rows[0];
          if (!r || r.deleted_at || r.estado !== "aceptada") {
            await client.query(
              `UPDATE reminder_job SET estado = 'cancelado', motivo_cancelacion = 'reserva_cancelada' WHERE id = $1`,
              [job.id]
            );
            cancelled += 1;
            continue;
          }
          const addr = job.direccion_cifrada ? this._dec(job.direccion_cifrada) : null;
          if (r.wp_deleted_at || !addr) {
            await client.query(
              `UPDATE reminder_job SET estado = 'cancelado', motivo_cancelacion = 'destinatario_inexistente' WHERE id = $1`,
              [job.id]
            );
            cancelled += 1;
            continue;
          }
          if (!canalesActivos.includes(job.canal)) continue;
          const delId = ulid();
          const insDel = await client.query(
            `INSERT INTO invitation_delivery
               (id, event_id, invitation_id, reminder_job_id, destinatario, direccion_cifrada, canal, plantilla, ventana, estado_en)
             VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (destinatario, plantilla, ventana) DO NOTHING
             RETURNING id`,
            [
              delId,
              job.event_id,
              job.id,
              buildTr12Destinatario(r.worker_id, addr, job.canal),
              this._enc(addr),
              job.canal,
              job.plantilla,
              job.ventana,
              nowIso,
            ]
          );
          await client.query(`UPDATE reminder_job SET estado = 'consumido' WHERE id = $1`, [job.id]);
          if (insDel.rowCount > 0) {
            dispatched += 1;
            await this._insertOutbox(client, {
              eventId: job.event_id,
              topic: "notifications",
              eventType: "worker_arrival_reminder",
              canal: job.canal,
              payload: {
                delivery_id: delId,
                event_id: job.event_id,
                worker_reservation_id: r.id,
                canal: job.canal,
                plantilla: job.plantilla,
                ventana: job.ventana,
                hora_llegada: toIso(r.hora_llegada),
              },
              tIngest: nowIso,
            });
          }
        }
      }
      return { dispatched, cancelled };
    });
  };
  proto.sweepExpiredReservations = async function ({ now = new Date() }) {
    const res = await this.pool.query(
      `UPDATE worker_reservation SET estado = 'expirada' WHERE estado = 'solicitada' AND expira_en <= $1`,
      [toIso(now)]
    );
    return { expired: res.rowCount };
  };
  proto.sweepIndeterminadoDeliveries = async function ({ now = new Date() }) {
    const nowIso = toIso(now);
    const cutoff = new Date(new Date(now).getTime() - 15 * 60 * 1000).toISOString();
    return withTx(this.pool, async (client) => {
      const res = await client.query(
        `UPDATE invitation_delivery SET estado = 'indeterminado', estado_en = $2
          WHERE estado = 'encolado' AND estado_en <= $1
          RETURNING DISTINCT event_id`,
        [cutoff, nowIso]
      );
      for (const row of res.rows) {
        const cntRes = await client.query(
          `SELECT count(*)::integer AS cnt FROM (
             SELECT invitation_id, plantilla, ventana
               FROM invitation_delivery
              WHERE event_id = $1 AND invitation_id IS NOT NULL
              GROUP BY invitation_id, plantilla, ventana
             HAVING bool_or(estado = 'entregado') AND bool_or(estado IN ('rebotado','indeterminado'))
           ) t`,
          [row.event_id]
        );
        await this._insertOutbox(client, {
          eventId: row.event_id,
          topic: "projection",
          eventType: "delivery_indeterminado",
          payload: { entregas_parciales_set: cntRes.rows[0].cnt },
          tIngest: nowIso,
        });
      }
      return { transitioned: res.rowCount };
    });
  };
  proto.sweepRetention = async function ({ now = new Date() }) {
    const nowDate = new Date(now);
    const c12 = new Date(nowDate);
    c12.setUTCMonth(c12.getUTCMonth() - 12);
    const c24 = new Date(nowDate);
    c24.setUTCMonth(c24.getUTCMonth() - 24);
    const nowIso = nowDate.toISOString();

    return withTx(this.pool, async (client) => {
      const ev12 = await client.query(`SELECT id FROM event WHERE estado = 'cerrado' AND cerrado_en <= $1`, [c12.toISOString()]);
      const ids12 = ev12.rows.map((r) => r.id);
      if (ids12.length > 0) {
        await client.query(
          `UPDATE guest SET nombre = 'Invitado anonimizado', email_normalizado = NULL, email_cifrado = NULL, email_hmac = NULL,
                            telefono_e164 = NULL, telefono_cifrado = NULL, telefono_hmac = NULL, pii_anonimizada_en = $2
            WHERE event_id = ANY($1::char(26)[]) AND pii_anonimizada_en IS NULL`,
          [ids12, nowIso]
        );
        await client.query(
          `UPDATE invitation SET rsvp_token_hash = NULL, rsvp_token_cifrado = NULL, qr_token_cifrado = NULL,
                                 rsvp_revocado_en = COALESCE(rsvp_revocado_en, $2),
                                 checkin_revocado_en = COALESCE(checkin_revocado_en, $2), pii_anonimizada_en = $2
            WHERE event_id = ANY($1::char(26)[]) AND pii_anonimizada_en IS NULL`,
          [ids12, nowIso]
        );
        await client.query(
          `UPDATE invitation_delivery SET direccion_cifrada = NULL, pii_anonimizada_en = $2
            WHERE event_id = ANY($1::char(26)[]) AND pii_anonimizada_en IS NULL`,
          [ids12, nowIso]
        );
        await client.query(
          `UPDATE reminder_job
              SET motivo_cancelacion = CASE WHEN estado = 'programado' THEN 'destinatario_inexistente' ELSE motivo_cancelacion END,
                  estado = CASE WHEN estado = 'programado' THEN 'cancelado' ELSE estado END,
                  direccion_cifrada = NULL,
                  pii_anonimizada_en = $2
            WHERE event_id = ANY($1::char(26)[]) AND pii_anonimizada_en IS NULL`,
          [ids12, nowIso]
        );
      }

      const ev24 = await client.query(`SELECT id FROM event WHERE estado = 'cerrado' AND cerrado_en <= $1`, [c24.toISOString()]);
      const ids24 = ev24.rows.map((r) => r.id);
      let chkCount = 0;
      if (ids24.length > 0) {
        const chkRes = await client.query(
          `UPDATE checkin_event SET device_id = NULL WHERE event_id = ANY($1::char(26)[]) AND device_id IS NOT NULL`,
          [ids24]
        );
        chkCount = chkRes.rowCount;
      }
      await client.query(`DELETE FROM audit_entry WHERE ts <= $1`, [c24.toISOString()]);

      const wpRes = await client.query(
        `UPDATE worker_profile wp
            SET telefono_e164 = NULL, telefono_cifrado = NULL, telefono_hmac = NULL,
                telefono_verificado_en = NULL, fotos = '{}', referencias = '{}', pii_anonimizada_en = $2
          WHERE wp.pii_anonimizada_en IS NULL
            AND GREATEST(wp.updated_at, COALESCE((SELECT max(wr.updated_at) FROM worker_reservation wr WHERE wr.worker_id = wp.id), wp.updated_at)) <= $1`,
        [c12.toISOString(), nowIso]
      );

      return {
        anonymized_events: ids12.length,
        anonymized_checkin_events: chkCount,
        anonymized_workers: wpRes.rowCount,
      };
    });
  };

  proto.updateWorkerProfile = async function ({ userId, patch }) {
    const wpRes = await this.pool.query(
      `SELECT * FROM worker_profile WHERE user_id = $1 AND deleted_at IS NULL`,
      [userId]
    );
    if (wpRes.rowCount === 0) throw new AppError("NOT_FOUND", "Perfil no encontrado");
    const cur = wpRes.rows[0];
    const nextTipo = patch.tipo !== undefined ? patch.tipo : cur.tipo;
    const nextPlazas = patch.plazas_ofrecidas !== undefined ? Number(patch.plazas_ofrecidas) : cur.plazas_ofrecidas;
    const nextCats = patch.categorias !== undefined ? patch.categorias : cur.categorias;

    if (!["persona", "empresa"].includes(nextTipo)) throw validationError("tipo inválido", "tipo");
    if (!Number.isInteger(nextPlazas) || nextPlazas < 1 || nextPlazas > 50) {
      throw validationError("plazas_ofrecidas inválido", "plazas_ofrecidas");
    }
    if (nextTipo === "persona" && nextPlazas !== 1) {
      throw validationError("Un perfil persona solo puede declarar 1 plaza", "plazas_ofrecidas");
    }
    if (patch.categorias !== undefined) {
      if (!Array.isArray(nextCats) || nextCats.length < 1 || nextCats.length > 3 || !nextCats.every(isValidCategoria)) {
        throw validationError("categorias inválidas", "categorias");
      }
    }
    if (patch.servicios !== undefined) {
      if (!Array.isArray(patch.servicios) || !patch.servicios.every((s) => isServicioAllowedForCategorias(s, nextCats))) {
        throw validationError("servicios inválidos", "servicios");
      }
    }
    if (patch.zonas !== undefined) {
      if (!Array.isArray(patch.zonas) || patch.zonas.length < 1 || patch.zonas.length > 5 || !patch.zonas.every(isValidZona)) {
        throw validationError("zonas inválidas", "zonas");
      }
    }
    if (patch.fotos !== undefined && (!Array.isArray(patch.fotos) || patch.fotos.length > 3)) {
      throw validationError("máximo 3 fotos", "fotos");
    }
    if (patch.referencias !== undefined && (!Array.isArray(patch.referencias) || patch.referencias.length > 3)) {
      throw validationError("máximo 3 referencias", "referencias");
    }

    const fields = [];
    const params = [cur.id];
    let idx = 2;
    if (patch.tipo !== undefined) {
      fields.push(`tipo = $${idx++}`);
      params.push(nextTipo);
    }
    if (patch.plazas_ofrecidas !== undefined) {
      fields.push(`plazas_ofrecidas = $${idx++}`);
      params.push(nextPlazas);
    }
    if (patch.nombre_publico !== undefined) {
      fields.push(`nombre_publico = $${idx++}`);
      params.push(String(patch.nombre_publico).trim());
    }
    if (patch.tarifa !== undefined) {
      fields.push(`tarifa_monto = $${idx++}`, `tarifa_moneda = $${idx++}`, `tarifa_unidad = $${idx++}`);
      params.push(patch.tarifa?.monto ?? null, patch.tarifa?.moneda ?? null, patch.tarifa?.unidad ?? null);
    }
    if (patch.categorias !== undefined) {
      fields.push(`categorias = $${idx++}`);
      params.push([...new Set(nextCats)]);
    }
    if (patch.servicios !== undefined) {
      fields.push(`servicios = $${idx++}`);
      params.push([...new Set(patch.servicios)]);
    }
    if (patch.zonas !== undefined) {
      fields.push(`zonas = $${idx++}`);
      params.push([...new Set(patch.zonas)]);
    }
    if (patch.radio_km !== undefined) {
      fields.push(`radio_km = $${idx++}`);
      params.push(patch.radio_km);
    }
    if (patch.idiomas !== undefined) {
      fields.push(`idiomas = $${idx++}`);
      params.push(patch.idiomas);
    }
    const exp = patch.anios_experiencia ?? patch["años_experiencia"];
    if (exp !== undefined) {
      fields.push(`anios_experiencia = $${idx++}`);
      params.push(exp);
    }
    if (patch.fotos !== undefined) {
      fields.push(`fotos = $${idx++}`);
      params.push(patch.fotos);
    }
    if (patch.referencias !== undefined) {
      fields.push(`referencias = $${idx++}`);
      params.push(patch.referencias);
    }
    if (patch.telefono_e164 !== undefined) {
      const normalized = patch.telefono_e164 ? normalizePhoneE164(patch.telefono_e164) : null;
      if (patch.telefono_e164 && !normalized) throw validationError("telefono_e164 inválido", "telefono_e164");
      const nextHmac = normalized ? this._hmac(normalized) : null;
      fields.push(`telefono_cifrado = $${idx++}`, `telefono_hmac = $${idx++}`);
      params.push(normalized ? this._enc(normalized) : null, nextHmac);
      if (nextHmac !== cur.telefono_hmac) {
        fields.push(`telefono_verificado_en = NULL`);
      }
    }
    if (patch.estado !== undefined) {
      if (!["borrador", "publicado", "suspendido"].includes(patch.estado)) {
        throw validationError("estado inválido", "estado");
      }
      if (patch.estado === "publicado") {
        if (!cur.email_verificado_en || !cur.telefono_verificado_en) {
          throw new AppError("PROFILE_NOT_VERIFIED", "El perfil debe verificar email y teléfono por OTP");
        }
        const nextTarifa = patch.tarifa !== undefined ? patch.tarifa?.monto : cur.tarifa_monto;
        if (!nextTarifa) throw new AppError("TRABAJADOR_SIN_TARIFA", "Sin tarifa publicada");
      }
      fields.push(`estado = $${idx++}`);
      params.push(patch.estado);
    }
    if (fields.length > 0) {
      await this.pool.query(`UPDATE worker_profile SET ${fields.join(", ")} WHERE id = $1`, params);
    }
    return this.getWorkerProfileByUserId(userId);
  };

  proto.setWorkerProfileState = async function ({ userId, estado }) {
    const wp = await this.getWorkerProfileByUserId(userId);
    if (!wp) throw new AppError("NOT_FOUND", "Perfil no encontrado");
    if (estado === "publicado") {
      if (!wp.email_verificado_en || !wp.telefono_verificado_en) {
        throw new AppError("PROFILE_NOT_VERIFIED", "El perfil debe verificar email y teléfono por OTP");
      }
      if (!wp.tarifa) throw new AppError("TRABAJADOR_SIN_TARIFA", "Sin tarifa publicada");
    }
    await this.pool.query(`UPDATE worker_profile SET estado = $2 WHERE id = $1`, [wp.worker_id, estado]);
    return { estado };
  };

  proto.listOwnAvailability = async function ({ userId }) {
    const wp = await this.getWorkerProfileByUserId(userId);
    if (!wp) throw new AppError("NOT_FOUND", "Perfil no encontrado");
    const res = await this.pool.query(
      `SELECT id AS window_id, inicio, fin, zona, rol FROM availability_window WHERE worker_id = $1 AND deleted_at IS NULL ORDER BY inicio ASC`,
      [wp.worker_id]
    );
    return { items: res.rows };
  };

  proto.updateAvailability = async function ({ userId, windowId, patch }) {
    const wp = await this.getWorkerProfileByUserId(userId);
    if (!wp) throw new AppError("NOT_FOUND", "Perfil no encontrado");
    const res = await this.pool.query(
      `UPDATE availability_window
          SET inicio = COALESCE($3, inicio), fin = COALESCE($4, fin), zona = COALESCE($5, zona), rol = COALESCE($6, rol)
        WHERE id = $1 AND worker_id = $2 AND deleted_at IS NULL RETURNING id AS window_id, inicio, fin, zona, rol`,
      [windowId, wp.worker_id, patch.inicio || null, patch.fin || null, patch.zona || null, patch.rol || null]
    );
    if (res.rowCount === 0) throw new AppError("NOT_FOUND", "Ventana no encontrada");
    return res.rows[0];
  };

  proto.deleteAvailability = async function ({ userId, windowId }) {
    const wp = await this.getWorkerProfileByUserId(userId);
    if (!wp) throw new AppError("NOT_FOUND", "Perfil no encontrado");
    const res = await this.pool.query(
      `UPDATE availability_window SET deleted_at = now() WHERE id = $1 AND worker_id = $2 AND deleted_at IS NULL`,
      [windowId, wp.worker_id]
    );
    if (res.rowCount === 0) throw new AppError("NOT_FOUND", "Ventana no encontrada");
  };

  proto.createWorkerRequest = async function ({
    eventId,
    workerId,
    rol,
    plazas = 1,
    ventana,
    horaLlegada,
    modoEmergencia = false,
    now = new Date(),
  }) {
    return withTx(this.pool, async (client) => {
      const wpRes = await client.query(`SELECT * FROM worker_profile WHERE id = $1 AND deleted_at IS NULL`, [workerId]);
      if (wpRes.rowCount === 0) throw new AppError("NOT_FOUND", "Trabajador no encontrado");
      const wp = wpRes.rows[0];
      if (!wp.tarifa_monto) throw new AppError("TRABAJADOR_SIN_TARIFA", "Sin tarifa");
      if (wp.estado !== "publicado" || !wp.email_verificado_en || !wp.telefono_verificado_en) {
        throw validationError("Trabajador no publicado o verificado", "worker_id");
      }
      const awRes = await client.query(
        `SELECT 1 FROM availability_window
          WHERE worker_id = $1 AND rol = $2 AND deleted_at IS NULL
            AND tstzrange(inicio, fin, '[)') @> tstzrange($3::timestamptz, $4::timestamptz, '[)')`,
        [workerId, rol, ventana.inicio, ventana.fin]
      );
      if (awRes.rowCount === 0) {
        throw new AppError("WINDOW_NOT_AVAILABLE", "Ventana no contenida en disponibilidad declarada");
      }
      const nowMs = new Date(now).getTime();
      const ttlMs = modoEmergencia ? 15 * 60 * 1000 : 48 * 60 * 60 * 1000;
      const expiraEn = new Date(Math.min(nowMs + ttlMs, new Date(ventana.fin).getTime())).toISOString();
      const id = ulid();
      await client.query(
        `INSERT INTO worker_reservation (
           id, worker_id, event_id, rol, inicio, fin, hora_llegada, plazas, plazas_solicitadas,
           costo_congelado_modo, costo_congelado_monto, costo_congelado_moneda, costo_congelado_unidad,
           modo_emergencia, expira_en
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,$12,$13,$14)`,
        [
          id,
          workerId,
          eventId,
          rol,
          ventana.inicio,
          ventana.fin,
          horaLlegada,
          plazas,
          wp.tarifa_modo,
          wp.tarifa_monto,
          wp.tarifa_moneda,
          wp.tarifa_unidad,
          modoEmergencia,
          expiraEn,
        ]
      );
      return {
        id,
        reservation_id: id,
        event_id: eventId,
        worker_id: workerId,
        rol,
        plazas,
        estado: "solicitada",
        ventana,
        hora_llegada: horaLlegada,
        costo_congelado: { modo: wp.tarifa_modo, monto: Number(wp.tarifa_monto), moneda: wp.tarifa_moneda, unidad: wp.tarifa_unidad },
        modo_emergencia: modoEmergencia,
        expira_en: expiraEn,
      };
    });
  };

  proto.listEventWorkerRequests = async function ({ eventId, limit = 20, cursor = null }) {
    const res = await this.pool.query(
      `SELECT wr.*, wp.telefono_cifrado AS wp_telefono_cifrado
         FROM worker_reservation wr
         LEFT JOIN worker_profile wp ON wp.id = wr.worker_id
        WHERE wr.event_id = $1 AND wr.deleted_at IS NULL
        ORDER BY wr.created_at ASC`,
      [eventId]
    );
    const items = res.rows.map((r) => {
      const out = {
        id: r.id,
        reservation_id: r.id,
        event_id: r.event_id,
        worker_id: r.worker_id,
        rol: r.rol,
        plazas: r.plazas,
        plazas_solicitadas: r.plazas_solicitadas,
        estado: r.estado,
        ventana: { inicio: toIso(r.inicio), fin: toIso(r.fin) },
        hora_llegada: toIso(r.hora_llegada),
        costo_congelado: {
          modo: r.costo_congelado_modo,
          monto: Number(r.costo_congelado_monto),
          moneda: r.costo_congelado_moneda,
          unidad: r.costo_congelado_unidad,
        },
        modo_emergencia: r.modo_emergencia,
        expira_en: toIso(r.expira_en),
        aceptada_en: toIso(r.aceptada_en),
        llegada_registrada_en: toIso(r.llegada_registrada_en),
      };
      if (r.estado === "aceptada" && r.wp_telefono_cifrado) {
        out.contacto_telefono = this._dec(r.wp_telefono_cifrado);
      }
      return out;
    });
    const paged = paginateArray(items, limit, cursor);
    const { cobertura } = await this.getEventRequirements({ eventId });
    return { ...paged, cobertura };
  };

  proto.cancelEventReservation = async function ({
    eventId,
    reservationId,
    actorId,
    motivo = "Cancelación",
    paymentProvider = null,
    now = new Date(),
  }) {
    const pre = await withTx(this.pool, async (client) => {
      const rRes = await client.query(
        `SELECT * FROM worker_reservation WHERE id = $1 AND event_id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [reservationId, eventId]
      );
      if (rRes.rowCount === 0) throw new AppError("NOT_FOUND", "Reserva no encontrada");
      const r = rRes.rows[0];
      if (r.estado === "cancelada" || r.estado === "cancelada_pagada") {
        return {
          alreadyCancelled: true,
          out: { id: r.id, estado: r.estado, plazas_liberadas: r.plazas, ledger_entry_id: null },
        };
      }
      if (r.estado === "completada") {
        throw new AppError("EVENT_STATE_INVALID", "Reserva completada no puede cancelarse");
      }
      const pRes = await client.query(
        `SELECT * FROM payment WHERE reservation_id = $1 AND cobrado_en IS NOT NULL`,
        [r.id]
      );
      return { alreadyCancelled: false, reservation: r, paidPayment: pRes.rows[0] || null };
    });

    if (pre.alreadyCancelled) return pre.out;
    if (pre.paidPayment && paymentProvider && pre.paidPayment.psp_charge_id) {
      await paymentProvider.refund({
        idempotencyKey: pre.paidPayment.idempotency_key,
        pspChargeId: pre.paidPayment.psp_charge_id,
        amount: Number(pre.paidPayment.monto),
        currency: pre.paidPayment.moneda,
      });
    }

    const nowIso = toIso(now);
    return withTx(this.pool, async (client) => {
      const rRes = await client.query(
        `SELECT * FROM worker_reservation WHERE id = $1 AND event_id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [reservationId, eventId]
      );
      const r = rRes.rows[0];
      if (r.estado === "cancelada" || r.estado === "cancelada_pagada") {
        return { id: r.id, estado: r.estado, plazas_liberadas: r.plazas, ledger_entry_id: null };
      }
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [r.worker_id]);
      const pRes = await client.query(`SELECT * FROM payment WHERE reservation_id = $1 AND cobrado_en IS NOT NULL FOR UPDATE`, [r.id]);
      let nextEstado = "cancelada";
      let ledgerTxId = null;
      if (pRes.rowCount > 0) {
        const pay = pRes.rows[0];
        const revCheck = await client.query(
          `SELECT transaccion_id FROM payment_entry WHERE pago_id = $1 AND movimiento = 'reverso' LIMIT 1`,
          [pay.id]
        );
        if (revCheck.rowCount === 0) {
          ledgerTxId = ulid();
          await client.query(
            `INSERT INTO payment_entry (id, pago_id, transaccion_id, movimiento, cuenta, tipo, importe, moneda)
             VALUES ($1, $2, $3, 'reverso', 'worker_payable', 'debito', $4, $5),
                    ($6, $2, $3, 'reverso', 'psp_clearing', 'credito', $7, $5)`,
            [ulid(), pay.id, ledgerTxId, pay.monto, pay.moneda, ulid(), -Number(pay.monto)]
          );
        } else {
          ledgerTxId = revCheck.rows[0].transaccion_id;
        }
        nextEstado = "cancelada_pagada";
      }
      await client.query(
        `UPDATE worker_reservation SET estado = $2, cancelada_en = $4, motivo_cancelacion = $3 WHERE id = $1`,
        [r.id, nextEstado, motivo, nowIso]
      );
      await client.query(
        `UPDATE reminder_job SET estado = 'cancelado', motivo_cancelacion = 'reserva_cancelada'
          WHERE worker_reservation_id = $1 AND estado = 'programado'`,
        [r.id]
      );
      await this._insertAudit(client, {
        eventId,
        actorId,
        accion: "reserva_cancelada",
        entidad: "worker_reservation",
        entidadId: r.id,
        motivo,
        ts: nowIso,
      });
      return { id: r.id, estado: nextEstado, plazas_liberadas: r.plazas, ledger_entry_id: ledgerTxId };
    });
  };

  proto.replaceEventReservation = async function ({ eventId, reservationId, workerId = null, now = new Date() }) {
    const fRes = await this.pool.query(
      `SELECT * FROM worker_reservation WHERE id = $1 AND event_id = $2 AND deleted_at IS NULL`,
      [reservationId, eventId]
    );
    if (fRes.rowCount === 0) throw new AppError("NOT_FOUND", "Reserva no encontrada");
    const fallen = fRes.rows[0];
    if (!workerId) {
      await this.pool.query(`UPDATE worker_reservation SET estado = 'sin_cubrir' WHERE id = $1`, [fallen.id]);
      const aId = ulid();
      await this.pool.query(
        `INSERT INTO planner_alert (id, event_id, reservation_id, tipo, detalle) VALUES ($1,$2,$3,'requerimiento_sin_cubrir',$4::jsonb)`,
        [aId, eventId, fallen.id, JSON.stringify({ rol: fallen.rol, plazas_faltantes: fallen.plazas })]
      );
      return {
        isSinCubrir: true,
        body: { estado: "sin_cubrir", alerta: true, planner_alert_id: aId, rol: fallen.rol, plazas_faltantes: fallen.plazas },
      };
    }

    const wpRes = await this.pool.query(`SELECT plazas_ofrecidas FROM worker_profile WHERE id = $1 AND deleted_at IS NULL`, [workerId]);
    if (wpRes.rowCount === 0) throw new AppError("NOT_FOUND", "Trabajador candidato no encontrado");
    const offered = Number(wpRes.rows[0].plazas_ofrecidas || 1);

    const ovRes = await this.pool.query(
      `SELECT id, inicio, fin, plazas, aceptada_en FROM worker_reservation
        WHERE worker_id = $1 AND estado = 'aceptada' AND deleted_at IS NULL
          AND tstzrange(inicio, fin, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')
        ORDER BY aceptada_en ASC, id ASC`,
      [workerId, fallen.inicio, fallen.fin]
    );
    const occupied = ovRes.rows.reduce((sum, r) => sum + Number(r.plazas), 0);
    if (offered - occupied < 1) {
      const winner = ovRes.rows[0];
      if (this.metrics) this.metrics.reservationConflicts(workerId);
      throw new AppError("RESERVATION_OVERLAP", "El trabajador candidato ya está ocupado en esa ventana", {
        ganadora: winner
          ? {
              reservation_id: winner.id,
              ventana: { inicio: toIso(winner.inicio), fin: toIso(winner.fin) },
              plazas: winner.plazas,
              aceptada_en: toIso(winner.aceptada_en),
            }
          : null,
      });
    }

    const created = await this.createWorkerRequest({
      eventId,
      workerId,
      rol: fallen.rol,
      plazas: fallen.plazas,
      ventana: { inicio: toIso(fallen.inicio), fin: toIso(fallen.fin) },
      horaLlegada: toIso(fallen.hora_llegada),
      modoEmergencia: true,
      now,
    });
    return { isSinCubrir: false, body: { ...created, sla_respuesta: "PT15M" } };
  };

  proto.listWorkerRequests = async function ({ userId, estado = null, desde = null, limit = 20, cursor = null }) {
    const wp = await this.getWorkerProfileByUserId(userId);
    if (!wp) throw new AppError("NOT_FOUND", "Perfil no encontrado");
    const res = await this.pool.query(
      `SELECT wr.*, e.nombre AS ev_nombre, e.fecha AS ev_fecha, e.timezone AS ev_timezone, v.zona AS venue_zona
         FROM worker_reservation wr
         JOIN event e ON e.id = wr.event_id
         LEFT JOIN venue v ON v.id = e.venue_id
        WHERE wr.worker_id = $1 AND wr.deleted_at IS NULL
          AND ($2::text IS NULL OR wr.estado = $2)
          AND ($3::timestamptz IS NULL OR wr.fin > $3::timestamptz)
        ORDER BY wr.created_at DESC`,
      [wp.worker_id, estado, desde]
    );
    const items = res.rows.map((r) => ({
      reservation_id: r.id,
      evento: {
        id: r.event_id,
        nombre: r.ev_nombre,
        fecha: toIso(r.ev_fecha).slice(0, 10),
        timezone: r.ev_timezone,
      },
      zona: r.venue_zona || null,
      ventana: { inicio: toIso(r.inicio), fin: toIso(r.fin) },
      rol: r.rol,
      plazas: r.plazas,
      hora_llegada: toIso(r.hora_llegada),
      costo_congelado: {
        modo: r.costo_congelado_modo,
        monto: Number(r.costo_congelado_monto),
        moneda: r.costo_congelado_moneda,
        unidad: r.costo_congelado_unidad,
      },
      estado: r.estado,
      expira_en: toIso(r.expira_en),
      modo_emergencia: r.modo_emergencia,
    }));
    return paginateArray(items, limit, cursor);
  };

  proto.getWorkerRequestDetail = async function ({ userId, reservationId }) {
    const wp = await this.getWorkerProfileByUserId(userId);
    if (!wp) throw new AppError("NOT_FOUND", "Perfil no encontrado");
    const res = await this.pool.query(
      `SELECT wr.*, e.nombre AS ev_nombre, e.fecha AS ev_fecha, e.timezone AS ev_timezone, v.zona AS venue_zona
         FROM worker_reservation wr
         JOIN event e ON e.id = wr.event_id
         LEFT JOIN venue v ON v.id = e.venue_id
        WHERE wr.id = $1 AND wr.deleted_at IS NULL`,
      [reservationId]
    );
    if (res.rowCount === 0) throw new AppError("NOT_FOUND", "Solicitud no encontrada");
    const r = res.rows[0];
    if (r.worker_id !== wp.worker_id) {
      throw new AppError("FORBIDDEN_EVENT_SCOPE", "Pertenece a otro trabajador");
    }
    const { cobertura } = await this.getEventRequirements({ eventId: r.event_id });
    const covRol = cobertura.por_rol.find((x) => x.rol === r.rol) || null;
    return {
      solicitud: {
        reservation_id: r.id,
        rol: r.rol,
        plazas: r.plazas,
        estado: r.estado,
        ventana: { inicio: toIso(r.inicio), fin: toIso(r.fin) },
        hora_llegada: toIso(r.hora_llegada),
        costo_congelado: {
          modo: r.costo_congelado_modo,
          monto: Number(r.costo_congelado_monto),
          moneda: r.costo_congelado_moneda,
          unidad: r.costo_congelado_unidad,
        },
        zona: r.venue_zona || null,
        evento: {
          id: r.event_id,
          nombre: r.ev_nombre,
          fecha: toIso(r.ev_fecha).slice(0, 10),
          timezone: r.ev_timezone,
        },
      },
      cobertura_requerimiento: covRol,
    };
  };

  proto.rejectWorkerReservation = async function ({ userId, reservationId, motivo = null }) {
    const wp = await this.getWorkerProfileByUserId(userId);
    if (!wp) throw new AppError("NOT_FOUND", "Perfil no encontrado");
    const res = await this.pool.query(
      `UPDATE worker_reservation SET estado = 'rechazada', rechazada_en = now(), motivo_rechazo = $3
        WHERE id = $1 AND worker_id = $2 AND estado = 'solicitada' RETURNING *`,
      [reservationId, wp.worker_id, motivo]
    );
    if (res.rowCount === 0) throw new AppError("RESERVATION_NOT_PENDING", "No se pudo rechazar");
    return { reservation_id: reservationId, estado: "rechazada", devuelve_a_busqueda: true };
  };

  proto.cancelWorkerReservationByWorker = async function ({ userId, reservationId, motivo = "Cancelación" }) {
    const wp = await this.getWorkerProfileByUserId(userId);
    if (!wp) throw new AppError("NOT_FOUND", "Perfil no encontrado");
    const rRes = await this.pool.query(`SELECT event_id FROM worker_reservation WHERE id = $1 AND worker_id = $2`, [
      reservationId,
      wp.worker_id,
    ]);
    if (rRes.rowCount === 0) throw new AppError("NOT_FOUND", "Reserva no encontrada");
    const out = await this.cancelEventReservation({
      eventId: rRes.rows[0].event_id,
      reservationId,
      actorId: userId,
      motivo,
    });
    await this.pool.query(
      `INSERT INTO planner_alert (id, event_id, reservation_id, tipo, detalle) VALUES ($1,$2,$3,'reserva_cancelada_en_vivo',$4::jsonb)`,
      [ulid(), rRes.rows[0].event_id, reservationId, JSON.stringify({ worker_id: wp.worker_id })]
    );
    return { reservation_id: reservationId, estado: out.estado, alerta_planner: "emitida" };
  };

  proto.listEventAlerts = async function ({ eventId }) {
    const res = await this.pool.query(`SELECT * FROM planner_alert WHERE event_id = $1 ORDER BY created_at DESC`, [
      eventId,
    ]);
    return res.rows;
  };

  proto.recordWorkerArrival = async function ({ userId, reservationId, llegadaEn = null }) {
    const wp = await this.getWorkerProfileByUserId(userId);
    if (!wp) throw new AppError("NOT_FOUND", "Perfil no encontrado");
    const res = await this.pool.query(
      `UPDATE worker_reservation SET llegada_registrada_en = COALESCE(llegada_registrada_en, $3::timestamptz)
        WHERE id = $1 AND worker_id = $2 AND estado IN ('aceptada','completada') RETURNING llegada_registrada_en`,
      [reservationId, wp.worker_id, llegadaEn || new Date().toISOString()]
    );
    if (res.rowCount === 0) throw new AppError("RESERVATION_NOT_ACCEPTED", "Reserva no aceptada");
    return { reservation_id: reservationId, llegada_registrada_en: toIso(res.rows[0].llegada_registrada_en) };
  };

  proto.getWorkerReservationPayment = async function ({ userId, reservationId }) {
    const wp = await this.getWorkerProfileByUserId(userId);
    if (!wp) throw new AppError("NOT_FOUND", "Perfil no encontrado");
    const res = await this.pool.query(
      `SELECT r.costo_congelado_monto, r.costo_congelado_moneda, p.*,
              EXISTS (SELECT 1 FROM payment_entry pe WHERE pe.pago_id = p.id AND pe.movimiento = 'reverso') AS has_reverso
         FROM worker_reservation r LEFT JOIN payment p ON p.reservation_id = r.id
        WHERE r.id = $1 AND r.worker_id = $2`,
      [reservationId, wp.worker_id]
    );
    if (res.rowCount === 0) throw new AppError("NOT_FOUND", "Reserva no encontrada");
    const row = res.rows[0];
    if (!row.id) {
      return {
        estado: "pendiente",
        monto: Number(row.costo_congelado_monto),
        moneda: row.costo_congelado_moneda,
      };
    }
    return {
      payment_id: row.id,
      estado: row.has_reverso
        ? "reversado"
        : row.cobrado_en
          ? "pagado"
          : row.estado_psp === "desconocido"
            ? "desconocido"
            : "pendiente",
      monto: Number(row.monto),
      moneda: row.moneda,
      reverso_de: row.has_reverso ? row.id : undefined,
    };
  };

  proto.getScanSessionById = async function (sessionId) {
    const res = await this.pool.query(`SELECT * FROM scan_session WHERE id = $1`, [sessionId]);
    return res.rows[0] || null;
  };

  proto.getScanSessionRoster = async function ({ sessionId, version = null, qrSigner, now = new Date() }) {
    const sess = await this.getScanSessionById(sessionId);
    if (!sess || sess.deleted_at) throw new AppError("FORBIDDEN_EVENT_SCOPE", "Sesión inválida");
    if (version !== null && Number(version) === sess.roster_version) {
      return { notModified: true, etag: `"roster-${sess.roster_version}"` };
    }
    const evRes = await this.pool.query(`SELECT * FROM event WHERE id = $1`, [sess.event_id]);
    const ev = evRes.rows[0];
    const invRes = await this.pool.query(
      `SELECT i.id AS invitation_id, g.nombre, i.codigo_corto, t.numero AS mesa, i.checkin_key_id AS token_key_id, i.token_version
         FROM invitation i
         JOIN guest g ON g.id = i.guest_id
         LEFT JOIN seat_assignment sa ON sa.guest_id = g.id AND sa.estado IN ('confirmado','pendiente')
         LEFT JOIN event_table t ON t.id = sa.table_id
        WHERE i.event_id = $1 AND i.deleted_at IS NULL AND g.deleted_at IS NULL
        LIMIT 2000`,
      [ev.id]
    );
    const { key_id: keyId, public_key_pem: publicKeyPem } = await qrSigner.getPublicKey();
    const unsignedPayload = {
      event_id: ev.id,
      evento: { nombre: ev.nombre, inicio: toIso(ev.ventana_inicio), fin: toIso(ev.ventana_fin), estado: ev.estado, timezone: ev.timezone },
      roster_version: sess.roster_version,
      invitados: invRes.rows,
    };
    const canonical = JSON.stringify(unsignedPayload);
    const sigValor = await qrSigner.signBytes(Buffer.from(canonical, "utf8"), keyId);
    const nowIso = toIso(now);
    const nowMs = new Date(now).getTime();
    return {
      notModified: false,
      etag: `"roster-${sess.roster_version}"`,
      body: {
        ...unsignedPayload,
        generado_en: nowIso,
        expira_en: toIso(sess.expira_en),
        canonical_payload: canonical,
        firma: { alg: "ES256", key_id: keyId, valor: sigValor },
        key_publica_pem: publicKeyPem,
        revocaciones: { version: sess.revocation_version, emitida_en: nowIso, ttl_horas: 2, vigente_hasta: new Date(nowMs + 7200000).toISOString() },
      },
    };
  };

  proto.getScanSessionRevocations = async function ({ sessionId, now = new Date() }) {
    const sess = await this.getScanSessionById(sessionId);
    if (!sess) throw new AppError("FORBIDDEN_EVENT_SCOPE", "Sesión inválida");
    const res = await this.pool.query(
      `SELECT id FROM invitation WHERE event_id = $1 AND checkin_revocado_en IS NOT NULL`,
      [sess.event_id]
    );
    return {
      version: sess.revocation_version,
      emitida_en: toIso(now),
      ttl_horas: 2,
      vigente_hasta: new Date(new Date(now).getTime() + 7200000).toISOString(),
      revocados: res.rows.map((r) => r.id),
    };
  };

  proto.searchScanSessionRoster = async function ({ sessionId, nombre = null, codigoCorto = null }) {
    const sess = await this.getScanSessionById(sessionId);
    if (!sess) throw new AppError("FORBIDDEN_EVENT_SCOPE", "Sesión inválida");
    const res = await this.pool.query(
      `SELECT i.id AS invitation_id, g.nombre, i.codigo_corto,
              CASE WHEN i.checkin_revocado_en IS NOT NULL THEN 'invitacion_revocada' ELSE 'pendiente' END AS estado
         FROM invitation i JOIN guest g ON g.id = i.guest_id
        WHERE i.event_id = $1 AND i.deleted_at IS NULL AND g.deleted_at IS NULL
          AND ($2::text IS NULL OR i.codigo_corto = $2)
          AND ($3::text IS NULL OR lower(g.nombre) LIKE '%' || lower($3) || '%')`,
      [sess.event_id, codigoCorto, nombre]
    );
    return { items: res.rows };
  };

  proto.ingestCheckinBatch = async function ({ sessionId, batch, requestHash, now = new Date() }) {
    validateCheckinBatchPayload(batch);
    return withTx(this.pool, async (client) => {
      const ackRes = await client.query(
        `SELECT * FROM checkin_batch_ack WHERE session_id = $1 AND batch_id = $2`,
        [sessionId, batch.batch_id]
      );
      if (ackRes.rowCount > 0) {
        if (ackRes.rows[0].request_hash !== requestHash) {
          throw new AppError("IDEMPOTENCY_CONFLICT", "batch_id reutilizado con cuerpo distinto");
        }
        return { replayed: true, body: ackRes.rows[0].response_body };
      }
      const evRes = await client.query(`SELECT * FROM event WHERE id = $1`, [batch.event_id]);
      const ev = evRes.rows[0];
      if (!ev) throw new AppError("NOT_FOUND", "Evento no encontrado");
      if (ev.estado === "cancelado") throw new AppError("FORBIDDEN_EVENT_SCOPE", "Evento cancelado");

      const tIngest = toIso(now);
      const isClosed = ev.estado === "cerrado";
      const results = [];
      let aceptados = 0;
      let tardios = 0;
      let duplicados = 0;
      let rechazados = 0;
      let asistentesDelta = 0;
      let maxSeq = 0;

      for (const item of batch.events) {
        const seq = Number(item.sequence);
        if (seq > maxSeq) maxSeq = seq;
        const scannedMs = new Date(item.scanned_at).getTime();
        if (isClosed && (scannedMs < new Date(ev.ventana_inicio).getTime() || scannedMs >= new Date(ev.ventana_fin).getTime())) {
          rechazados += 1;
          results.push({ sequence: seq, invitation_id: item.invitation_id, status: 400, error: "FUERA_DE_VENTANA_EVENTO" });
          continue;
        }
        const tardio = isClosed;
        const existingSeq = await client.query(
          `SELECT * FROM checkin_event WHERE invitation_id = $1 AND device_id = $2 AND sequence = $3`,
          [item.invitation_id, batch.device_id, seq]
        );
        if (existingSeq.rowCount > 0) {
          const e = existingSeq.rows[0];
          results.push({ sequence: seq, invitation_id: item.invitation_id, checkin_id: e.id, verdict: e.veredicto, tardio: e.tardio, duplicado: e.kind === "duplicado_tardio" });
          continue;
        }
        const invRes = await client.query(
          `SELECT i.id, i.event_id, i.checkin_revocado_en, i.deleted_at, g.deleted_at AS guest_deleted_at
             FROM invitation i JOIN guest g ON g.id = i.guest_id
            WHERE i.id = $1`,
          [item.invitation_id]
        );
        if (invRes.rowCount === 0 || invRes.rows[0].event_id !== ev.id || invRes.rows[0].deleted_at) {
          rechazados += 1;
          results.push({ sequence: seq, invitation_id: item.invitation_id, verdict: "no_corresponde_al_evento", tardio: false, duplicado: false });
          continue;
        }
        const invRow = invRes.rows[0];
        if (invRow.checkin_revocado_en || invRow.guest_deleted_at) {
          const cycRev = await client.query(
            `SELECT count(*)::integer + 1 AS cycle FROM checkin_event WHERE invitation_id = $1 AND kind = 'anulacion'`,
            [item.invitation_id]
          );
          const revId = ulid();
          const resolucion =
            item.verdict_local === "no_verificable_offline" || item.verdict_local === "admitido"
              ? "invalidado_al_sincronizar"
              : null;
          await client.query(
            `INSERT INTO checkin_event (id, event_id, invitation_id, device_id, sequence, kind, veredicto, admision_ciclo, escaneado_en, recibido_en, tardio, verdict_local, resolucion_al_sincronizar)
             VALUES ($1,$2,$3,$4,$5,'duplicado_tardio','invitacion_revocada',$6,$7,$8,$9,$10,$11)`,
            [revId, ev.id, item.invitation_id, batch.device_id, seq, cycRev.rows[0].cycle, toIso(item.scanned_at), tIngest, tardio, item.verdict_local || null, resolucion]
          );
          results.push({ sequence: seq, invitation_id: item.invitation_id, checkin_id: revId, verdict: "invitacion_revocada", resolucion_al_sincronizar: resolucion, tardio, duplicado: false });
          continue;
        }
        const cycRes = await client.query(
          `SELECT count(*)::integer + 1 AS cycle FROM checkin_event WHERE invitation_id = $1 AND kind = 'anulacion'`,
          [item.invitation_id]
        );
        const cycle = cycRes.rows[0].cycle;
        const chkId = ulid();
        const insAdm = await client.query(
          `INSERT INTO checkin_event (id, event_id, invitation_id, device_id, sequence, kind, veredicto, admision_ciclo, escaneado_en, recibido_en, tardio, modo, verdict_local)
           VALUES ($1,$2,$3,$4,$5,'admitido',$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (invitation_id, admision_ciclo) WHERE kind = 'admitido' DO NOTHING
           RETURNING *`,
          [chkId, ev.id, item.invitation_id, batch.device_id, seq, item.verdict_local || "admitido", cycle, toIso(item.scanned_at), tIngest, tardio, item.modo || "camara", item.verdict_local || null]
        );
        if (insAdm.rowCount > 0) {
          aceptados += 1;
          asistentesDelta += 1;
          if (tardio) tardios += 1;
          results.push({ sequence: seq, invitation_id: item.invitation_id, checkin_id: chkId, verdict: insAdm.rows[0].veredicto, tardio, duplicado: false });
        } else {
          const winRes = await client.query(
            `SELECT id FROM checkin_event WHERE invitation_id = $1 AND kind = 'admitido' AND admision_ciclo = $2`,
            [item.invitation_id, cycle]
          );
          const dupId = ulid();
          await client.query(
            `INSERT INTO checkin_event (id, event_id, invitation_id, device_id, sequence, kind, veredicto, admision_ciclo, escaneado_en, recibido_en, tardio, vigente_checkin_id)
             VALUES ($1,$2,$3,$4,$5,'duplicado_tardio','ya_registrado',$6,$7,$8,$9,$10)`,
            [dupId, ev.id, item.invitation_id, batch.device_id, seq, cycle, toIso(item.scanned_at), tIngest, tardio, winRes.rows[0]?.id || null]
          );
          duplicados += 1;
          results.push({ sequence: seq, invitation_id: item.invitation_id, checkin_id: dupId, kind: "duplicado_tardio", verdict: "ya_registrado", tardio, duplicado: true });
        }
      }

      await client.query(
        `INSERT INTO device_sync_state (id, event_id, device_id, cola_reportada, ultima_seq_ackeada, seq_confirmada, heartbeat_en)
         VALUES ($1,$2,$3,$4,$5,$5,$6)
         ON CONFLICT (event_id, device_id) DO UPDATE SET
           cola_reportada = EXCLUDED.cola_reportada,
           ultima_seq_ackeada = GREATEST(device_sync_state.ultima_seq_ackeada, EXCLUDED.ultima_seq_ackeada),
           seq_confirmada = GREATEST(device_sync_state.seq_confirmada, EXCLUDED.seq_confirmada),
           heartbeat_en = EXCLUDED.heartbeat_en`,
        [ulid(), ev.id, batch.device_id, Number(batch.cola_reportada ?? 0), maxSeq, tIngest]
      );
      await this._insertOutbox(client, {
        eventId: ev.id,
        topic: "projection",
        eventType: "checkin_batch_ingested",
        payload: { asistentes_delta: asistentesDelta },
        tIngest,
      });

      const body = {
        batch_id: batch.batch_id,
        estado: "aplicado",
        recibido_en: tIngest,
        ack_hasta_sequence: maxSeq,
        contadores: { aceptados, tardios, duplicados, invalidados_al_sincronizar: 0, rechazados },
        results,
        sync_state: { device_id: batch.device_id, pendientes: Number(batch.cola_reportada ?? 0), ultima_seq_ackeada: maxSeq, heartbeat_en: tIngest },
      };
      await client.query(
        `INSERT INTO checkin_batch_ack (id, session_id, event_id, batch_id, request_hash, response_body)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [ulid(), sessionId, ev.id, batch.batch_id, requestHash, JSON.stringify(body)]
      );
      return { replayed: false, body };
    });
  };

  proto.getCheckinBatchAck = async function ({ sessionId, batchId }) {
    const res = await this.pool.query(
      `SELECT response_body FROM checkin_batch_ack WHERE session_id = $1 AND batch_id = $2`,
      [sessionId, batchId]
    );
    if (res.rowCount === 0) throw new AppError("NOT_FOUND", "Lote no encontrado");
    return res.rows[0].response_body;
  };

  proto.upsertDeviceSyncState = async function ({ sessionId, colaReportada, ultimaSeqAckeada, seqConfirmada = null, heartbeatEn = null, now = new Date() }) {
    const sess = await this.getScanSessionById(sessionId);
    if (!sess) throw new AppError("FORBIDDEN_EVENT_SCOPE", "Sesión inválida");
    const conf = Math.min(Number(seqConfirmada ?? ultimaSeqAckeada), Number(ultimaSeqAckeada));
    const hb = heartbeatEn ? toIso(heartbeatEn) : toIso(now);
    const res = await this.pool.query(
      `INSERT INTO device_sync_state (id, event_id, device_id, cola_reportada, ultima_seq_ackeada, seq_confirmada, heartbeat_en)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (event_id, device_id) DO UPDATE SET
         cola_reportada = EXCLUDED.cola_reportada,
         ultima_seq_ackeada = GREATEST(device_sync_state.ultima_seq_ackeada, EXCLUDED.ultima_seq_ackeada),
         seq_confirmada = GREATEST(device_sync_state.seq_confirmada, EXCLUDED.seq_confirmada),
         heartbeat_en = EXCLUDED.heartbeat_en
       RETURNING *`,
      [ulid(), sess.event_id, sess.device_id, Number(colaReportada), Number(ultimaSeqAckeada), conf, hb]
    );
    const derived = deriveSyncPendingState([res.rows[0]], new Date(now).getTime());
    return { device_id: sess.device_id, pendientes: derived.valor, ultima_seq_ackeada: res.rows[0].ultima_seq_ackeada, heartbeat_en: hb };
  };

  proto.annulCheckin = async function ({ eventId, checkinId, actorId, motivo, now = new Date() }) {
    if (!motivo || String(motivo).trim().length === 0) {
      throw validationError("motivo es obligatorio", "motivo");
    }
    return withTx(this.pool, async (client) => {
      const evRes = await client.query(`SELECT * FROM event WHERE id = $1 AND deleted_at IS NULL`, [eventId]);
      if (evRes.rowCount === 0) throw new AppError("NOT_FOUND", "Evento no encontrado");
      const ev = evRes.rows[0];
      const nowMs = new Date(now).getTime();
      if (ev.estado === "cancelado" || ev.estado === "borrador") {
        throw new AppError("CORRECTION_WINDOW_CLOSED", "El evento no está en ventana de corrección");
      }
      if (ev.estado === "cerrado" && nowMs > new Date(ev.cerrado_en).getTime() + 24 * 60 * 60 * 1000) {
        throw new AppError("CORRECTION_WINDOW_CLOSED", "Expiró la ventana de corrección de 24 h");
      }

      const targetRes = await client.query(
        `SELECT * FROM checkin_event WHERE id = $1 AND event_id = $2 AND kind = 'admitido'`,
        [checkinId, eventId]
      );
      if (targetRes.rowCount === 0) throw new AppError("CHECKIN_NOT_FOUND", "Check-in no encontrado");
      const target = targetRes.rows[0];
      const existing = await client.query(
        `SELECT * FROM checkin_event WHERE anula_a = $1 AND actor_id = $2 AND kind = 'anulacion'`,
        [checkinId, actorId]
      );
      if (existing.rowCount > 0) {
        return { replayed: true, body: { annulment_id: existing.rows[0].id, annuls_checkin_id: checkinId, actor_id: actorId, kind: "anulacion" } };
      }
      const alreadyAnnulledRes = await client.query(
        `SELECT 1 FROM checkin_event WHERE anula_a = $1 AND kind = 'anulacion' LIMIT 1`,
        [checkinId]
      );
      const alreadyAnnulled = alreadyAnnulledRes.rowCount > 0;
      const seqRes = await client.query(
        `SELECT COALESCE(max(sequence), 0)::bigint + 1 AS next_seq FROM checkin_event WHERE invitation_id = $1 AND device_id = $2`,
        [target.invitation_id, `console:${actorId}`]
      );
      const annId = ulid();
      const nowIso = toIso(now);
      await client.query(
        `INSERT INTO checkin_event (id, event_id, invitation_id, device_id, sequence, kind, veredicto, admision_ciclo, escaneado_en, recibido_en, anula_a, actor_id, motivo)
         VALUES ($1,$2,$3,$4,$5,'anulacion',$6,$7,$8,$8,$9,$10,$11)`,
        [annId, eventId, target.invitation_id, `console:${actorId}`, seqRes.rows[0].next_seq, target.veredicto, target.admision_ciclo, nowIso, checkinId, actorId, motivo]
      );
      if (!alreadyAnnulled) {
        await this._insertOutbox(client, { eventId, topic: "projection", eventType: "checkin_annulled", payload: { asistentes_delta: -1 }, tIngest: nowIso });
      }
      return { replayed: false, body: { annulment_id: annId, annuls_checkin_id: checkinId, actor_id: actorId, kind: "anulacion", scanned_at: nowIso } };
    });
  };

  proto.listCheckins = async function ({
    eventId,
    invitationId = null,
    guestId = null,
    verdict = null,
    limit = 20,
    cursor = null,
  }) {
    const res = await this.pool.query(
      `SELECT c.id AS checkin_id, c.invitation_id, c.kind, c.veredicto AS verdict,
              c.escaneado_en AS scanned_at, c.tardio, c.device_id, c.anula_a AS annuls_checkin_id
         FROM checkin_event c
         LEFT JOIN invitation i ON i.id = c.invitation_id
        WHERE c.event_id = $1
          AND ($2::char(26) IS NULL OR c.invitation_id = $2)
          AND ($3::char(26) IS NULL OR i.guest_id = $3)
          AND ($4::text IS NULL OR c.veredicto = $4)
        ORDER BY c.recibido_en ASC`,
      [eventId, invitationId, guestId, verdict]
    );
    return paginateArray(res.rows, limit, cursor);
  };

  proto.listReservationPayments = async function ({ reservationId }) {
    const rRes = await this.pool.query(`SELECT event_id, worker_id FROM worker_reservation WHERE id = $1`, [reservationId]);
    if (rRes.rowCount === 0) throw new AppError("NOT_FOUND", "Reserva no encontrada");
    const pRes = await this.pool.query(`SELECT * FROM payment WHERE reservation_id = $1`, [reservationId]);
    if (pRes.rowCount === 0) return { reservation_event_id: rRes.rows[0].event_id, worker_id: rRes.rows[0].worker_id, items: [] };
    const p = pRes.rows[0];
    const eRes = await this.pool.query(`SELECT * FROM payment_entry WHERE pago_id = $1 ORDER BY created_at ASC`, [p.id]);
    return {
      reservation_event_id: rRes.rows[0].event_id,
      worker_id: rRes.rows[0].worker_id,
      items: [{ payment_id: p.id, estado: p.estado_psp, monto: Number(p.monto), moneda: p.moneda, idempotency_key: p.idempotency_key, cobrado_en: toIso(p.cobrado_en), ledger_entries: eRes.rows }],
    };
  };

  proto.reconcilePspWebhook = async function ({
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
    return withTx(this.pool, async (client) => {
      const ins = await client.query(
        `INSERT INTO webhook_event (webhook_event_id, idempotency_key, payload) VALUES ($1,$2,$3::jsonb) ON CONFLICT DO NOTHING`,
        [webhookEventId, idempotencyKey || paymentId, JSON.stringify({ status, amount, currency })]
      );
      const pRes = await client.query(
        `SELECT * FROM payment WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR ($2::char(26) IS NOT NULL AND id = $2) FOR UPDATE`,
        [idempotencyKey, paymentId]
      );
      if (pRes.rowCount === 0) throw new AppError("NOT_FOUND", "Cobro no encontrado");
      const p = pRes.rows[0];
      if (ins.rowCount === 0 || p.cobrado_en) {
        return { conciliado: true, estado: p.estado_psp };
      }
      if (status === "succeeded") {
        if (
          (amount !== null && Number(amount) !== Number(p.monto)) ||
          (currency && String(currency).toUpperCase() !== p.moneda)
        ) {
          if (this.metrics) this.metrics.pspError("webhook_amount_mismatch");
          return { conciliado: false, estado: p.estado_psp };
        }
        const nowIso = toIso(now);
        const txId = ulid();
        await client.query(`UPDATE payment SET estado_psp = 'confirmado', psp_charge_id = COALESCE($2, psp_charge_id), cobrado_en = $3 WHERE id = $1`, [
          p.id,
          pspChargeId,
          nowIso,
        ]);
        await client.query(
          `INSERT INTO payment_entry (id, pago_id, transaccion_id, movimiento, cuenta, tipo, importe, moneda)
           VALUES ($1,$2,$3,'cobro','psp_clearing','debito',$4,$5),
                  ($6,$2,$3,'cobro','worker_payable','credito',$7,$5)
           ON CONFLICT (pago_id) WHERE movimiento = 'cobro' DO NOTHING`,
          [ulid(), p.id, txId, p.monto, p.moneda, ulid(), -Number(p.monto)]
        );
        return { conciliado: true, estado: "confirmado" };
      }
      return { conciliado: true, estado: p.estado_psp };
    });
  };
}
