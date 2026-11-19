import { createAppContext, flushOutboxNow } from "../../shared/context.js";
import { decryptPii } from "../../shared/crypto.js";

/** Escapa texto controlado por usuarios (nombres de invitado/evento del CSV) antes de meterlo en HTML. */
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

let defaultCtxPromise = null;
async function getDefaultContext() {
  if (!defaultCtxPromise) defaultCtxPromise = createAppContext();
  return defaultCtxPromise;
}

export function createNotifyEmailHandler(ctx) {
  return async function notifyEmailHandler(event) {
    const records = Array.isArray(event?.Records) ? event.Records : [];
    const batchItemFailures = [];

    for (const record of records) {
      const messageId = record.messageId || null;
      const msg = typeof record.body === "string" ? JSON.parse(record.body) : record.body;
      if (!msg) continue;

      if (msg.delivery_id) {
        const dCtx = await ctx.store.getDeliveryContext(msg.delivery_id);
        if (!dCtx || dCtx.delivery.canal !== "email") continue;
        if (dCtx.delivery.estado === "entregado" || dCtx.delivery.estado === "rebotado") continue;

        const invalidRecipient =
          !dCtx.delivery.direccion_plana ||
          dCtx.delivery.pii_anonimizada_en ||
          (dCtx.guest && dCtx.guest.deleted_at) ||
          (dCtx.guest && dCtx.guest.baja_email_en) ||
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
        const qrUrl = dCtx.invitation?.qr_s3_key
          ? ctx.objectStorage.getPublicUrl({ key: dCtx.invitation.qr_s3_key })
          : "";
        const subject =
          dCtx.delivery.plantilla === "recordatorio_llegada"
            ? `Recordatorio de llegada — ${eventName}`
            : dCtx.delivery.plantilla === "recordatorio_rsvp"
              ? `Recordatorio RSVP — ${eventName}`
              : `Invitación a ${eventName}`;
        const safeEvent = escapeHtml(eventName);
        const footer = rsvpUrl
          ? `<hr /><p style="font-size:12px;color:#666">¿No quieres recibir más mensajes de este evento? Abre
               <a href="${rsvpUrl}">tu invitación</a> y elige «Dejar de recibir correos». Consulta el
               <a href="${baseUrl}/privacidad">Aviso de privacidad</a>.</p>`
          : "";
        const html =
          dCtx.delivery.plantilla === "recordatorio_llegada"
            ? `<p>Recordatorio de hora de llegada (${escapeHtml(msg.hora_llegada || "")}) para <strong>${safeEvent}</strong>.</p>`
            : `<p>Hola ${escapeHtml(dCtx.guest?.nombre || "")}, estás invitado a <strong>${safeEvent}</strong>.</p>
               <p><a href="${rsvpUrl}">Confirmar o declinar asistencia</a></p>
               <p>Código corto: ${escapeHtml(dCtx.invitation?.codigo_corto || "")}</p>
               ${qrUrl ? `<p><img src="${qrUrl}" alt="QR Check-in" /></p>` : ""}
               ${footer}`;

        try {
          await ctx.emailProvider.send({
            to: dCtx.delivery.direccion_plana,
            subject,
            html,
            text: `${subject} - ${rsvpUrl}`,
            attachments: qrUrl ? [{ filename: "qr.png", url: qrUrl }] : [],
            metadata: {
              delivery_id: dCtx.delivery.id,
              event_id: dCtx.delivery.event_id,
              plantilla: dCtx.delivery.plantilla,
              ventana: dCtx.delivery.ventana,
              rsvp_url: rsvpUrl,
              qr_url: qrUrl,
            },
          });
          await ctx.store.markDeliveryResult({
            deliveryId: msg.delivery_id,
            success: true,
            now: ctx.now(),
          });
        } catch {
          ctx.metrics.notifRetry("email");
          const res = await ctx.store.markDeliveryResult({
            deliveryId: msg.delivery_id,
            success: false,
            now: ctx.now(),
          });
          if (res?.rebotado) {
            ctx.metrics.notifBounce("email");
          } else if (res?.retryable && messageId) {
            batchItemFailures.push({ itemIdentifier: messageId });
          }
        }
        continue;
      }

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
          let subject = "Notificación Orquesta";
          let html = "<p>Aviso de Orquesta</p>";
          if (msg.event_type === "verify_email") {
            // Enlace de un clic (el front verifica con el código del query) y el código por si se copia a mano.
            const base = (process.env.PUBLIC_BASE_URL || "https://orquesta.app").replace(/\/+$/, "");
            const area = msg.cuenta === "worker" ? "worker" : "planner";
            const link = `${base}/${area}/register?codigo=${encodeURIComponent(msg.token)}`;
            subject = "Verifica tu correo en Orquesta";
            html =
              `<p>Hola, gracias por registrarte en Orquesta.</p>` +
              `<p><a href="${link}">Verificar mi correo</a></p>` +
              `<p>O pega este código en la pantalla de registro: <strong>${escapeHtml(msg.token)}</strong></p>` +
              `<p style="font-size:12px;color:#666">Vence en 72 horas. Si no creaste una cuenta, ignora este correo.</p>`;
          } else if (msg.event_type === "password_reset") {
            subject = "Recuperación de contraseña en Orquesta";
            html = `<p>Token de recuperación: ${msg.token}</p>`;
          } else if (msg.event_type === "otp_verification") {
            subject = "Código OTP de Orquesta";
            html = `<p>Tu código OTP es: <strong>${msg.codigo_otp}</strong></p>`;
          } else if (msg.event_type === "worker_request_created") {
            const base = (process.env.PUBLIC_BASE_URL || "https://orquesta.app").replace(/\/+$/, "");
            subject = msg.modo_emergencia
              ? `URGENTE: solicitud de emergencia (${msg.rol || "staff"})`
              : `Nueva solicitud de trabajo (${msg.rol || "staff"})`;
            html =
              `<p>Tienes una nueva solicitud de contratación como <strong>${msg.rol || "staff"}</strong>.</p>` +
              (msg.modo_emergencia ? "<p><strong>Es una emergencia: tienes 15 minutos para responder.</strong></p>" : "") +
              `<p><a href="${base}/worker/requests">Ver y responder la solicitud</a></p>`;
          }
          await ctx.emailProvider.send({
            to: msg.to,
            subject,
            html,
            text: html.replace(/<[^>]+>/g, ""),
            metadata: msg,
          });
        } catch {
          ctx.metrics.notifRetry("email");
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
  return createNotifyEmailHandler(ctx)(event);
};
