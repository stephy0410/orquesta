import { createAppContext, flushOutboxNow } from "../../shared/context.js";

let defaultCtxPromise = null;
async function getDefaultContext() {
  if (!defaultCtxPromise) defaultCtxPromise = createAppContext();
  return defaultCtxPromise;
}

export function createOutboxPollerHandler(ctx) {
  return async function outboxPollerHandler(event = {}) {
    const now = event?.now ? new Date(event.now) : ctx.now();

    // 1. Republicar filas de outbox rezagadas (NFR-06)
    const outboxBefore = await flushOutboxNow(ctx, 200);

    // 2. Disparar ReminderJob vencidos (RF-10)
    const reminders = await ctx.store.sweepDueReminders({
      canalesActivos: ctx.canalesActivos,
      now,
    });

    // 3. Expirar WorkerReservation en solicitada tras 48 h / 15 min (RF-17)
    const expiredReservations = await ctx.store.sweepExpiredReservations({ now });

    // 4. Transición indeterminado a los 15 min sin respuesta en InvitationDelivery (RF-04)
    const indeterminado = await ctx.store.sweepIndeterminadoDeliveries({ now });

    // 5. Barrido de retención y anonimización PII a 12 / 24 meses (NFR-08)
    const retention = await ctx.store.sweepRetention({ now });

    // Flush de cualquier evento nuevo en outbox generado por los barridos 2 o 4
    const outboxAfter = await flushOutboxNow(ctx, 200);

    return {
      outbox_flushed: outboxBefore.flushed + outboxAfter.flushed,
      reminders,
      expired_reservations: expiredReservations.expired,
      indeterminado_deliveries: indeterminado.transitioned,
      retention,
    };
  };
}

export const handler = async (event) => {
  const ctx = await getDefaultContext();
  return createOutboxPollerHandler(ctx)(event);
};
