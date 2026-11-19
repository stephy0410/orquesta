import { createAppContext, flushOutboxNow } from "../../shared/context.js";
import { decryptPii } from "../../shared/crypto.js";

let defaultCtxPromise = null;
async function getDefaultContext() {
  if (!defaultCtxPromise) defaultCtxPromise = createAppContext();
  return defaultCtxPromise;
}

export function createNotifySmsHandler(ctx) {
  return async function notifySmsHandler(event) {
    const records = Array.isArray(event?.Records) ? event.Records : [];
    const batchItemFailures = [];

    for (const record of records) {
      const messageId = record.messageId || null;
      const msg = typeof record.body === "string" ? JSON.parse(record.body) : record.body;
      if (!msg) continue;

      if (msg.delivery_id) {
        const dCtx = await ctx.store.getDeliveryContext(msg.delivery_id);
        if (!dCtx || dCtx.delivery.canal !== "sms") continue;
        if (dCtx.delivery.estado === "entregado" || dCtx.delivery.estado === "rebotado") continue;

        const invalidRecipient =
          !dCtx.delivery.direccion_plana ||
          dCtx.delivery.pii_anonimizada_en ||
          (dCtx.guest && dCtx.guest.deleted_at) ||
          (dCtx.guest && dCtx.guest.baja_sms_en) ||
          (dCtx.invitation && dCtx.invitation.rsvp_revocado_en) ||
          (dCtx.reminderJob && (dCtx.reminderJob.estado === "cancelado" || dCtx.reminderJob.pii_anonimizada_en));

        if (invalidRecipient) {
          await ctx.store.markDeliveryResult({
            deliveryId: msg.delivery_id,
            skipCancelled: true,
            now: ctx.now(),
          });
          continue;
        }

        const eventName = dCtx.event?.nombre || "Evento Orquesta";
        const baseUrl = (process.env.PUBLIC_BASE_URL || "https://orquesta.app").replace(/\/+$/, "");
        let rsvpUrl = "";
        if (dCtx.invitation?.rsvp_token_plano) {
          const params = new URLSearchParams({ t: dCtx.invitation.rsvp_token_plano });
          if (dCtx.event?.id) params.set("e", dCtx.event.id);
          rsvpUrl = `${baseUrl}/invitacion/#${params.toString()}`;
        }
        const text =
          dCtx.delivery.plantilla === "recordatorio_llegada"
            ? `[Orquesta] Recordatorio de llegada para ${eventName} (${msg.hora_llegada || ""})`
            : dCtx.delivery.plantilla === "recordatorio_rsvp"
              ? `[Orquesta] Recordatorio RSVP para ${eventName}. Confirma aqui: ${rsvpUrl}`
              : `[Orquesta] Invitacion a ${eventName}. Responde aqui: ${rsvpUrl}`;

        try {
          await ctx.smsProvider.send({
            to: dCtx.delivery.direccion_plana,
            message: text,
            metadata: {
              delivery_id: dCtx.delivery.id,
              event_id: dCtx.delivery.event_id,
              plantilla: dCtx.delivery.plantilla,
              ventana: dCtx.delivery.ventana,
            },
          });
          await ctx.store.markDeliveryResult({
            deliveryId: msg.delivery_id,
            success: true,
            now: ctx.now(),
          });
        } catch {
          ctx.metrics.notifRetry("sms");
          const res = await ctx.store.markDeliveryResult({
            deliveryId: msg.delivery_id,
            success: false,
            now: ctx.now(),
          });
          if (res?.rebotado) {
            ctx.metrics.notifBounce("sms");
          } else if (res?.retryable && messageId) {
            batchItemFailures.push({ itemIdentifier: messageId });
          }
        }
        continue;
      }

      // Otros avisos SMS (OTP, solicitud de trabajo)
      // Direcciones que vienen del outbox llegan cifradas (NFR-07); las de avisos directos, en claro.
      if (msg.to_cifrado && !msg.to) {
        try {
          msg.to = decryptPii(msg.to_cifrado, ctx.piiKey);
        } catch {
          msg.to = null;
        }
        delete msg.to_cifrado;
      }
      if (msg.to) {
        try {
          const text =
            msg.event_type === "otp_verification"
              ? `[Orquesta] Tu codigo de verificacion es: ${msg.codigo_otp}`
              : msg.modo_emergencia
                ? `[Orquesta] URGENTE: solicitud de emergencia (${msg.rol || "staff"}). Responde en 15 min en tu consola de Orquesta.`
                : `[Orquesta] Nueva solicitud de trabajo (${msg.rol || "staff"}). Revisa tu consola de Orquesta.`;
          await ctx.smsProvider.send({ to: msg.to, message: text, metadata: msg });
        } catch {
          ctx.metrics.notifRetry("sms");
          if (messageId) batchItemFailures.push({ itemIdentifier: messageId });
        }
      }
    }

    if (ctx.autoFlushOutbox) {
      await flushOutboxNow(ctx);
    }

    return { batchItemFailures };
  };
}

export const handler = async (event) => {
  const ctx = await getDefaultContext();
  return createNotifySmsHandler(ctx)(event);
};
