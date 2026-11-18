import { canonicalJson, sha256Hex } from "../../../shared/crypto.js";
import { AppError, validationError } from "../../../shared/errors.js";
import { authenticateScanSession, jsonResponse, withIdempotency } from "../../../shared/http.js";

async function assertScanSessionAccess(req, ctx, sessionId, { allowClosedReplay = false } = {}) {
  const auth = await authenticateScanSession(req, ctx);
  const sess = await ctx.store.getScanSessionById(sessionId);
  if (!sess) throw new AppError("NOT_FOUND", "Sesión de escaneo no encontrada");

  if (auth.type === "event_session") {
    if (auth.sessionId !== sessionId || auth.eventId !== sess.event_id) {
      throw new AppError("FORBIDDEN_EVENT_SCOPE", "Token de sesión no corresponde a esta sesión");
    }
    await ctx.store.authorizeEventAccess({
      eventId: sess.event_id,
      scanSessionAuth: {
        session_id: auth.sessionId,
        event_id: auth.eventId,
        rol: auth.rol,
        device_id: auth.deviceId,
      },
      allowClosedReplay,
      now: ctx.now(),
    });
    return { auth, sess };
  }

  await ctx.store.authorizeEventAccess({
    userId: auth.userId,
    eventId: sess.event_id,
    allowStaffPermiso: "checkin",
    allowClosedReplay,
    now: ctx.now(),
  });
  return { auth, sess };
}

export const scanRoutes = [
  {
    method: "POST",
    pattern: "/v1/scan-sessions",
    async handler(req, ctx) {
      const auth = await authenticateScanSession(req, ctx);
      const { event_id: eventId, device_id: deviceId } = req.body || {};
      if (!eventId || !deviceId) {
        throw validationError("event_id y device_id son obligatorios", "event_id");
      }

      if (auth.type === "event_session") {
        if (auth.eventId !== eventId) {
          throw new AppError("NOT_FOUND", "Evento no encontrado");
        }
        await ctx.store.authorizeEventAccess({
          eventId,
          scanSessionAuth: {
            session_id: auth.sessionId,
            event_id: auth.eventId,
            rol: auth.rol,
            device_id: auth.deviceId,
          },
          now: ctx.now(),
        });
        const res = await ctx.store.createOrGetScanSession({
          eventId,
          deviceId,
          accessTokenId: auth.accessTokenId,
          rol: auth.rol,
          now: ctx.now(),
        });
        return jsonResponse(201, res);
      }

      const access = await ctx.store.authorizeEventAccess({
        userId: auth.userId,
        eventId,
        allowStaffPermiso: "checkin",
        now: ctx.now(),
      });
      const rol = access.membership ? access.membership.rol : "staff";
      const res = await ctx.store.createOrGetScanSession({
        eventId,
        deviceId,
        userId: auth.userId,
        rol,
        now: ctx.now(),
      });
      return jsonResponse(201, res);
    },
  },
  {
    method: "GET",
    pattern: "/v1/scan-sessions/:sessionId/roster",
    async handler(req, ctx) {
      await assertScanSessionAccess(req, ctx, req.params.sessionId);
      let version = req.query.version !== undefined ? Number(req.query.version) : null;
      if (version === null && req.ifNoneMatch) {
        const match = String(req.ifNoneMatch).match(/roster-(\d+)/);
        if (match) version = Number(match[1]);
      }
      const res = await ctx.store.getScanSessionRoster({
        sessionId: req.params.sessionId,
        version,
        qrSigner: ctx.qrSigner,
        now: ctx.now(),
      });
      if (res.notModified) {
        return jsonResponse(304, null, { headers: { etag: res.etag } });
      }
      return jsonResponse(200, res.body, {
        headers: { etag: res.etag, "cache-control": "private, max-age=60" },
      });
    },
  },
  {
    method: "GET",
    pattern: "/v1/scan-sessions/:sessionId/revocations",
    async handler(req, ctx) {
      await assertScanSessionAccess(req, ctx, req.params.sessionId);
      const res = await ctx.store.getScanSessionRevocations({
        sessionId: req.params.sessionId,
        now: ctx.now(),
      });
      return jsonResponse(200, res);
    },
  },
  {
    method: "GET",
    pattern: "/v1/scan-sessions/:sessionId/roster/search",
    async handler(req, ctx) {
      await assertScanSessionAccess(req, ctx, req.params.sessionId);
      const res = await ctx.store.searchScanSessionRoster({
        sessionId: req.params.sessionId,
        nombre: req.query.nombre || null,
        codigoCorto: req.query.codigo_corto || null,
      });
      return jsonResponse(200, res);
    },
  },
  {
    method: "POST",
    pattern: "/v1/scan-sessions/:sessionId/batches",
    async handler(req, ctx) {
      const { auth } = await assertScanSessionAccess(req, ctx, req.params.sessionId, {
        allowClosedReplay: true,
      });
      const scopeActor = auth.type === "event_session" ? auth.sessionId : auth.userId;
      return withIdempotency(
        req,
        ctx,
        `POST:/v1/scan-sessions/${req.params.sessionId}/batches:${scopeActor}`,
        async () => {
          const batch = req.body || {};
          const requestHash = sha256Hex(canonicalJson(batch));
          const res = await ctx.store.ingestCheckinBatch({
            sessionId: req.params.sessionId,
            batch,
            requestHash,
            now: ctx.now(),
          });
          return jsonResponse(200, res.body);
        }
      );
    },
  },
  {
    method: "GET",
    pattern: "/v1/scan-sessions/:sessionId/batches/:batchId",
    async handler(req, ctx) {
      await assertScanSessionAccess(req, ctx, req.params.sessionId, { allowClosedReplay: true });
      const res = await ctx.store.getCheckinBatchAck({
        sessionId: req.params.sessionId,
        batchId: req.params.batchId,
      });
      return jsonResponse(200, res);
    },
  },
  {
    method: "PUT",
    pattern: "/v1/scan-sessions/:sessionId/sync-state",
    async handler(req, ctx) {
      await assertScanSessionAccess(req, ctx, req.params.sessionId, { allowClosedReplay: true });
      const {
        cola_reportada: colaReportada,
        ultima_seq_ackeada: ultimaSeqAckeada,
        seq_confirmada: seqConfirmada,
        heartbeat_en: heartbeatEn,
      } = req.body || {};
      const res = await ctx.store.upsertDeviceSyncState({
        sessionId: req.params.sessionId,
        colaReportada,
        ultimaSeqAckeada,
        seqConfirmada,
        heartbeatEn,
        now: ctx.now(),
      });
      return jsonResponse(200, res);
    },
  },
  {
    method: "POST",
    pattern: "/v1/events/:eventId/checkins/:checkinId/annulments",
    async handler(req, ctx) {
      const auth = await authenticateScanSession(req, ctx);
      let actorId = null;
      if (auth.type === "event_session") {
        await ctx.store.authorizeEventAccess({
          eventId: req.params.eventId,
          scanSessionAuth: {
            session_id: auth.sessionId,
            event_id: auth.eventId,
            rol: auth.rol,
            device_id: auth.deviceId,
          },
          now: ctx.now(),
        });
        actorId = auth.actorId || auth.sessionId;
      } else {
        await ctx.store.authorizeEventAccess({
          userId: auth.userId,
          eventId: req.params.eventId,
          allowStaffPermiso: "anulacion",
          now: ctx.now(),
        });
        actorId = auth.userId;
      }

      const res = await ctx.store.annulCheckin({
        eventId: req.params.eventId,
        checkinId: req.params.checkinId,
        actorId,
        motivo: req.body?.motivo,
        now: ctx.now(),
      });
      return jsonResponse(res.replayed ? 200 : 201, res.body);
    },
  },
  {
    method: "GET",
    pattern: "/v1/events/:eventId/checkins",
    async handler(req, ctx) {
      const auth = await authenticateScanSession(req, ctx);
      if (auth.type === "event_session") {
        await ctx.store.authorizeEventAccess({
          eventId: req.params.eventId,
          scanSessionAuth: {
            session_id: auth.sessionId,
            event_id: auth.eventId,
            rol: auth.rol,
            device_id: auth.deviceId,
          },
          now: ctx.now(),
        });
      } else {
        await ctx.store.authorizeEventAccess({
          userId: auth.userId,
          eventId: req.params.eventId,
          allowStaffPermiso: "roster",
          now: ctx.now(),
        });
      }
      const res = await ctx.store.listCheckins({
        eventId: req.params.eventId,
        invitationId: req.query.invitation_id || null,
        guestId: req.query.guest_id || null,
        verdict: req.query.verdict || null,
        limit: req.query.limit,
        cursor: req.query.cursor,
      });
      return jsonResponse(200, res);
    },
  },
];
