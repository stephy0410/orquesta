import { verifyStripeSignature, verifyWebhookHmac } from "../../../shared/crypto.js";
import { AppError } from "../../../shared/errors.js";
import { authenticateUser, jsonResponse } from "../../../shared/http.js";

/**
 * URL de regreso del checkout. Solo se acepta el origen del front (PUBLIC_BASE_URL, más los de
 * ALLOWED_RETURN_ORIGINS) para que el pago no pueda usarse como redirección abierta; fuera de prod
 * también localhost. Cualquier otra cosa cae a la pantalla de pagos del evento.
 */
export function safeReturnUrl(raw, fallback, env = process.env) {
  try {
    const u = new URL(String(raw));
    const allowed = new Set();
    for (const o of [env.PUBLIC_BASE_URL, ...String(env.ALLOWED_RETURN_ORIGINS || "").split(",")]) {
      try {
        if (o && o.trim()) allowed.add(new URL(o.trim()).origin);
      } catch {
        // origen mal escrito en la config: se ignora
      }
    }
    const local = env.ENVIRONMENT !== "prod" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
    if (local && (u.protocol === "http:" || u.protocol === "https:")) return u.toString();
    if (u.protocol === "https:" && allowed.has(u.origin)) return u.toString();
  } catch {
    // no es URL
  }
  return fallback;
}

async function syncPendingCheckout(ctx, reservationId, resInfo) {
  const latest = resInfo.items?.[0];
  if (!latest || !ctx.paymentProvider?.requiresCustomerAction) return resInfo;
  if (latest.estado !== "pendiente" && latest.estado !== "desconocido") return resInfo;
  try {
    await ctx.store.processReservationPayment({ reservationId, paymentProvider: ctx.paymentProvider, now: ctx.now() });
    return await ctx.store.listReservationPayments({ reservationId });
  } catch {
    // El PSP no responde: se muestra el último estado conocido; la conciliación lo retoma.
    return resInfo;
  }
}

const STRIPE_PAID_EVENTS = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded"]);

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

      const eventId = resInfo.reservation_event_id;
      const base = (process.env.PUBLIC_BASE_URL || "https://orquesta.app").replace(/\/+$/, "");
      const back = `${base}/planner/events/${encodeURIComponent(eventId)}/workers`;
      const res = await ctx.store.processReservationPayment({
        reservationId: req.params.reservationId,
        eventId,
        paymentProvider: ctx.paymentProvider,
        now: ctx.now(),
        checkout: {
          successUrl: safeReturnUrl(req.body?.success_url, `${back}?pago=exito`),
          cancelUrl: safeReturnUrl(req.body?.cancel_url, `${back}?pago=cancelado`),
        },
      });
      return jsonResponse(res.statusCode, res.body);
    },
  },
  {
    method: "GET",
    pattern: "/v1/reservations/:reservationId/payments",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      const reservationId = req.params.reservationId;
      const resInfo = await ctx.store.listReservationPayments({ reservationId });
      const workerProfile = await ctx.store.getWorkerProfileByUserId(auth.userId);
      if (!(workerProfile && workerProfile.worker_id === resInfo.worker_id)) {
        await ctx.store.authorizeEventAccess({
          userId: auth.userId,
          eventId: resInfo.reservation_event_id,
        });
      }
      // Al volver de Stripe Checkout la planner ve "Pagado" sin esperar al webhook.
      const fresh = await syncPendingCheckout(ctx, reservationId, resInfo);
      return jsonResponse(200, { items: fresh.items });
    },
  },
  {
    method: "POST",
    pattern: "/v1/webhooks/psp",
    async handler(req, ctx) {
      const stripeSig = req.headers["stripe-signature"];
      if (stripeSig && ctx.stripeWebhookSecret) {
        if (!verifyStripeSignature(req.rawBuffer, stripeSig, ctx.stripeWebhookSecret)) {
          throw new AppError("AUTH_REQUIRED", "Firma de Stripe inválida");
        }
        const evt = req.body || {};
        const obj = evt.data?.object || {};
        const key = obj.metadata?.idempotency_key || obj.client_reference_id || null;
        // Responder 200 a lo que no nos toca para que Stripe no lo reintente.
        if (!STRIPE_PAID_EVENTS.has(evt.type) || obj.payment_status !== "paid" || !key) {
          return jsonResponse(200, { recibido: true, ignorado: evt.type || null });
        }
        try {
          const res = await ctx.store.reconcilePspWebhook({
            webhookEventId: evt.id,
            idempotencyKey: key,
            status: "succeeded",
            amount: Number(obj.amount_total) / 100,
            currency: obj.currency,
            pspChargeId: typeof obj.payment_intent === "string" ? obj.payment_intent : obj.payment_intent?.id || null,
            now: ctx.now(),
          });
          return jsonResponse(200, res);
        } catch (err) {
          if (err?.code === "NOT_FOUND") return jsonResponse(200, { recibido: true, ignorado: "cobro_ajeno" });
          throw err;
        }
      }

      const sig = req.headers["x-psp-signature"] || stripeSig;
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
