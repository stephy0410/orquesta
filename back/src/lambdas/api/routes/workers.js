import { generateOtpCode } from "../../../shared/crypto.js";
import { normalizePhoneE164 } from "../../../shared/domain-helpers.js";
import { AppError, validationError } from "../../../shared/errors.js";
import { authenticateUser, jsonResponse, withIdempotency } from "../../../shared/http.js";

function parseListQueryParam(req, key) {
  const arr = req.queryMulti?.[key] || req.queryMulti?.[`${key}[]`] || [];
  const out = [];
  for (const val of arr) {
    for (const part of String(val).split(",")) {
      const t = part.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

export const workerRoutes = [
  {
    method: "POST",
    pattern: "/v1/worker/profile",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      return withIdempotency(req, ctx, `POST:/v1/worker/profile:${auth.userId}`, async () => {
        const perfil = await ctx.store.createWorkerProfile({
          userId: auth.userId,
          data: req.body || {},
          now: ctx.now(),
        });
        return jsonResponse(201, {
          worker_id: perfil.worker_id,
          estado: perfil.estado,
          perfil,
        });
      });
    },
  },
  {
    method: "GET",
    pattern: "/v1/worker/profile",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      const perfil = await ctx.store.getWorkerProfileByUserId(auth.userId);
      if (!perfil) throw new AppError("NOT_FOUND", "Perfil de trabajador no encontrado");
      return jsonResponse(200, {
        perfil,
        verificado: {
          email: Boolean(perfil.email_verificado_en),
          telefono: Boolean(perfil.telefono_verificado_en),
        },
      });
    },
  },
  {
    method: "PATCH",
    pattern: "/v1/worker/profile",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      const perfil = await ctx.store.updateWorkerProfile({
        userId: auth.userId,
        patch: req.body || {},
        now: ctx.now(),
      });
      return jsonResponse(200, { perfil });
    },
  },
  {
    method: "POST",
    pattern: "/v1/worker/profile/verifications",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      return withIdempotency(
        req,
        ctx,
        `POST:/v1/worker/profile/verifications:${auth.userId}`,
        async () => {
          const { canal, telefono_e164: phoneInput } = req.body || {};
          if (!["email", "telefono"].includes(canal)) {
            throw validationError("canal debe ser 'email' o 'telefono'", "canal");
          }
          const wp = await ctx.store.getWorkerProfileByUserId(auth.userId);
          if (!wp) throw new AppError("NOT_FOUND", "Perfil de trabajador no encontrado");
          const user = await ctx.store.findUserById(auth.userId);

          const otp = generateOtpCode();
          const expiraEn = new Date(ctx.now().getTime() + 15 * 60 * 1000);

          if (canal === "telefono") {
            const rawPhone = phoneInput || wp.telefono_e164;
            const phone = normalizePhoneE164(rawPhone);
            if (!phone) throw validationError("telefono_e164 E.164 obligatorio", "telefono_e164");
            await ctx.store.assertPhoneAvailableForVerification(phone, wp.worker_id);

            const ch = await ctx.store.createChallenge({
              userId: auth.userId,
              proposito: "verify_phone_otp",
              canal: "sms",
              destino: phone,
              codigoRaw: otp,
              expiraEn,
            });
            await ctx.queueBus.publishNotification(
              {
                event_type: "otp_verification",
                challenge_id: ch.id,
                to: phone,
                codigo_otp: otp,
              },
              "sms"
            );
            // D11: duplicar aviso OTP por email si está activo
            if (ctx.canalesActivos.includes("email") && user?.email) {
              await ctx.queueBus.publishNotification(
                {
                  event_type: "otp_verification",
                  challenge_id: ch.id,
                  to: user.email,
                  codigo_otp: otp,
                },
                "email"
              );
            }
            return jsonResponse(202, { desafio_id: ch.id, expira_en: ch.expira_en });
          }

          const ch = await ctx.store.createChallenge({
            userId: auth.userId,
            proposito: "verify_email_otp",
            canal: "email",
            destino: user.email,
            codigoRaw: otp,
            expiraEn,
          });
          await ctx.queueBus.publishNotification(
            {
              event_type: "otp_verification",
              challenge_id: ch.id,
              to: user.email,
              codigo_otp: otp,
            },
            "email"
          );
          return jsonResponse(202, { desafio_id: ch.id, expira_en: ch.expira_en });
        }
      );
    },
  },
  {
    method: "POST",
    pattern: "/v1/worker/profile/verifications/:desafioId/confirm",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      const { codigo_otp: codigoOtp } = req.body || {};
      if (!codigoOtp) throw validationError("codigo_otp es obligatorio", "codigo_otp");
      const res = await ctx.store.confirmOtpChallenge({
        userId: auth.userId,
        challengeId: req.params.desafioId,
        codigoOtp,
        now: ctx.now(),
      });
      return jsonResponse(200, res);
    },
  },
  {
    method: "POST",
    pattern: "/v1/worker/profile/publish",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      const res = await ctx.store.setWorkerProfileState({
        userId: auth.userId,
        estado: "publicado",
        now: ctx.now(),
      });
      return jsonResponse(200, res);
    },
  },
  {
    method: "POST",
    pattern: "/v1/worker/profile/suspend",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      const res = await ctx.store.setWorkerProfileState({
        userId: auth.userId,
        estado: "suspendido",
        now: ctx.now(),
      });
      return jsonResponse(200, res);
    },
  },
  {
    method: "GET",
    pattern: "/v1/workers",
    async handler(req, ctx) {
      await authenticateUser(req, ctx);
      const categorias = parseListQueryParam(req, "categorias");
      const zonas = parseListQueryParam(req, "zonas");
      const radioKm = req.query.radio_km !== undefined ? Number(req.query.radio_km) : null;
      const tarifaMin = req.query.tarifa_min !== undefined ? Number(req.query.tarifa_min) : null;
      const tarifaMax = req.query.tarifa_max !== undefined ? Number(req.query.tarifa_max) : null;

      if (radioKm !== null && (Number.isNaN(radioKm) || radioKm <= 0 || radioKm > 150)) {
        throw validationError("radio_km inválido", "radio_km");
      }

      const res = await ctx.store.searchWorkers({
        categorias,
        zonas,
        radioKm,
        tarifaMin,
        tarifaMax,
        unidad: req.query.unidad || null,
        desde: req.query.desde || null,
        hasta: req.query.hasta || null,
        limit: req.query.limit || 20,
        cursor: req.query.cursor || null,
      });
      return jsonResponse(200, res);
    },
  },
  {
    method: "GET",
    pattern: "/v1/workers/:workerId",
    async handler(req, ctx) {
      await authenticateUser(req, ctx);
      const perfilPublico = await ctx.store.getPublicWorkerProfile(req.params.workerId);
      return jsonResponse(200, { perfil_publico: perfilPublico });
    },
  },
  {
    method: "GET",
    pattern: "/v1/workers/:workerId/availability",
    async handler(req, ctx) {
      await authenticateUser(req, ctx);
      const res = await ctx.store.getWorkerBusyWindows({
        workerId: req.params.workerId,
        desde: req.query.desde || null,
        hasta: req.query.hasta || null,
      });
      return jsonResponse(200, res);
    },
  },
  {
    method: "GET",
    pattern: "/v1/worker/availability",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      const res = await ctx.store.listOwnAvailability({
        userId: auth.userId,
        desde: req.query.desde || null,
        hasta: req.query.hasta || null,
      });
      return jsonResponse(200, res);
    },
  },
  {
    method: "POST",
    pattern: "/v1/worker/availability",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      return withIdempotency(
        req,
        ctx,
        `POST:/v1/worker/availability:${auth.userId}`,
        async () => {
          const res = await ctx.store.createAvailability({
            userId: auth.userId,
            data: req.body || {},
          });
          return jsonResponse(201, res);
        }
      );
    },
  },
  {
    method: "PATCH",
    pattern: "/v1/worker/availability/:windowId",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      const res = await ctx.store.updateAvailability({
        userId: auth.userId,
        windowId: req.params.windowId,
        patch: req.body || {},
      });
      return jsonResponse(200, res);
    },
  },
  {
    method: "DELETE",
    pattern: "/v1/worker/availability/:windowId",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      await ctx.store.deleteAvailability({
        userId: auth.userId,
        windowId: req.params.windowId,
      });
      return jsonResponse(204, null);
    },
  },
  {
    method: "POST",
    pattern: "/v1/events/:eventId/worker-requests",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      await ctx.store.authorizeEventAccess({
        userId: auth.userId,
        eventId: req.params.eventId,
        requiredMembershipRoles: ["owner", "editor"],
      });
      return withIdempotency(
        req,
        ctx,
        `POST:/v1/events/${req.params.eventId}/worker-requests:${auth.userId}`,
        async () => {
          const {
            worker_id: workerId,
            rol,
            plazas = 1,
            ventana,
            hora_llegada: horaLlegada,
          } = req.body || {};
          if (!workerId || !rol || !ventana || !horaLlegada) {
            throw validationError("worker_id, rol, ventana y hora_llegada son obligatorios");
          }
          const created = await ctx.store.createWorkerRequest({
            eventId: req.params.eventId,
            workerId,
            rol,
            plazas,
            ventana,
            horaLlegada,
            canalesActivos: ctx.canalesActivos,
            now: ctx.now(),
          });
          return jsonResponse(201, created);
        }
      );
    },
  },
  {
    method: "GET",
    pattern: "/v1/events/:eventId/worker-requests",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      await ctx.store.authorizeEventAccess({
        userId: auth.userId,
        eventId: req.params.eventId,
      });
      const res = await ctx.store.listEventWorkerRequests({
        eventId: req.params.eventId,
        limit: req.query.limit,
        cursor: req.query.cursor,
      });
      return jsonResponse(200, res);
    },
  },
  {
    method: "POST",
    pattern: "/v1/events/:eventId/worker-requests/:reservationId/cancel",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      await ctx.store.authorizeEventAccess({
        userId: auth.userId,
        eventId: req.params.eventId,
        requiredMembershipRoles: ["owner", "editor"],
      });
      const res = await ctx.store.cancelEventReservation({
        eventId: req.params.eventId,
        reservationId: req.params.reservationId,
        actorId: auth.userId,
        motivo: req.body?.motivo || "Cancelación por planner",
        paymentProvider: ctx.paymentProvider,
        now: ctx.now(),
      });
      return jsonResponse(200, res);
    },
  },
  {
    method: "POST",
    pattern: "/v1/events/:eventId/reservations/:reservationId/cancel",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      await ctx.store.authorizeEventAccess({
        userId: auth.userId,
        eventId: req.params.eventId,
        requiredMembershipRoles: ["owner", "editor"],
      });
      const res = await ctx.store.cancelEventReservation({
        eventId: req.params.eventId,
        reservationId: req.params.reservationId,
        actorId: auth.userId,
        motivo: req.body?.motivo || "Cancelación por planner",
        paymentProvider: ctx.paymentProvider,
        now: ctx.now(),
      });
      return jsonResponse(200, res);
    },
  },
  {
    method: "POST",
    pattern: "/v1/events/:eventId/worker-requests/:reservationId/replacements",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      await ctx.store.authorizeEventAccess({
        userId: auth.userId,
        eventId: req.params.eventId,
        requiredMembershipRoles: ["owner", "editor"],
      });
      return withIdempotency(
        req,
        ctx,
        `POST:/v1/events/${req.params.eventId}/worker-requests/${req.params.reservationId}/replacements:${auth.userId}`,
        async () => {
          const res = await ctx.store.replaceEventReservation({
            eventId: req.params.eventId,
            reservationId: req.params.reservationId,
            workerId: req.body?.worker_id || null,
            canalesActivos: ctx.canalesActivos,
            now: ctx.now(),
          });
          return jsonResponse(res.isSinCubrir ? 200 : 201, res.body);
        }
      );
    },
  },
  {
    method: "GET",
    pattern: "/v1/worker/requests",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      const res = await ctx.store.listWorkerRequests({
        userId: auth.userId,
        estado: req.query.estado || null,
        desde: req.query.desde || null,
        limit: req.query.limit,
        cursor: req.query.cursor,
      });
      return jsonResponse(200, res);
    },
  },
  {
    method: "GET",
    pattern: "/v1/worker/requests/:reservationId",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      const res = await ctx.store.getWorkerRequestDetail({
        userId: auth.userId,
        reservationId: req.params.reservationId,
      });
      return jsonResponse(200, res);
    },
  },
  {
    method: "POST",
    pattern: "/v1/worker/requests/:reservationId/accept",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      return withIdempotency(
        req,
        ctx,
        `POST:/v1/worker/requests/${req.params.reservationId}/accept:${auth.userId}`,
        async () => {
          const res = await ctx.store.acceptWorkerReservation({
            userId: auth.userId,
            reservationId: req.params.reservationId,
            plazas: req.body?.plazas ?? null,
            canalesActivos: ctx.canalesActivos,
            now: ctx.now(),
          });
          return jsonResponse(200, res);
        }
      );
    },
  },
  {
    method: "POST",
    pattern: "/v1/worker/requests/:reservationId/reject",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      const res = await ctx.store.rejectWorkerReservation({
        userId: auth.userId,
        reservationId: req.params.reservationId,
        motivo: req.body?.motivo || null,
        now: ctx.now(),
      });
      return jsonResponse(200, res);
    },
  },
  {
    method: "POST",
    pattern: "/v1/worker/reservations/:reservationId/cancel",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      const res = await ctx.store.cancelWorkerReservationByWorker({
        userId: auth.userId,
        reservationId: req.params.reservationId,
        motivo: req.body?.motivo || "Cancelación por trabajador",
        paymentProvider: ctx.paymentProvider,
        now: ctx.now(),
      });
      return jsonResponse(200, res);
    },
  },
  {
    method: "POST",
    pattern: "/v1/worker/reservations/:reservationId/arrival",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      const res = await ctx.store.recordWorkerArrival({
        userId: auth.userId,
        reservationId: req.params.reservationId,
        llegadaEn: req.body?.llegada_en || null,
        now: ctx.now(),
      });
      return jsonResponse(200, res);
    },
  },
  {
    method: "GET",
    pattern: "/v1/worker/reservations/:reservationId/payment",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      const res = await ctx.store.getWorkerReservationPayment({
        userId: auth.userId,
        reservationId: req.params.reservationId,
      });
      return jsonResponse(200, res);
    },
  },
];
