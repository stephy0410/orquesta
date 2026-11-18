import { verifyWebhookHmac } from "../../../shared/crypto.js";
import { AppError } from "../../../shared/errors.js";
import { authenticateUser, jsonResponse } from "../../../shared/http.js";

export const paymentRoutes = [
  {
    method: "POST",
    pattern: "/v1/reservations/:reservationId/payments",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      const resInfo = await ctx.store.listReservationPayments({
        reservationId: req.params.reservationId,
      });
      await ctx.store.authorizeEventAccess({
        userId: auth.userId,
        eventId: resInfo.reservation_event_id,
        requiredMembershipRoles: ["owner", "editor"],
      });

      const res = await ctx.store.processReservationPayment({
        reservationId: req.params.reservationId,
        eventId: resInfo.reservation_event_id,
        paymentProvider: ctx.paymentProvider,
        now: ctx.now(),
      });
      return jsonResponse(res.statusCode, res.body);
    },
  },
  {
    method: "GET",
    pattern: "/v1/reservations/:reservationId/payments",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      const resInfo = await ctx.store.listReservationPayments({
        reservationId: req.params.reservationId,
      });
      const workerProfile = await ctx.store.getWorkerProfileByUserId(auth.userId);
      if (workerProfile && workerProfile.worker_id === resInfo.worker_id) {
        return jsonResponse(200, { items: resInfo.items });
      }
      await ctx.store.authorizeEventAccess({
        userId: auth.userId,
        eventId: resInfo.reservation_event_id,
      });
      return jsonResponse(200, { items: resInfo.items });
    },
  },
  {
    method: "POST",
    pattern: "/v1/webhooks/psp",
    async handler(req, ctx) {
      const sig = req.headers["x-psp-signature"] || req.headers["stripe-signature"];
      if (!verifyWebhookHmac(req.rawBuffer, sig, ctx.pspWebhookSecret)) {
        throw new AppError("AUTH_REQUIRED", "Firma HMAC del webhook PSP inválida");
      }
      const {
        event_id: webhookEventId,
        payment_id: paymentId,
        idempotency_key: idempotencyKey,
        status,
        amount = null,
        currency = null,
        psp_charge_id: pspChargeId = null,
      } = req.body || {};

      const res = await ctx.store.reconcilePspWebhook({
        webhookEventId,
        paymentId,
        idempotencyKey,
        status,
        amount,
        currency,
        pspChargeId,
        now: ctx.now(),
      });
      return jsonResponse(200, res);
    },
  },
];
