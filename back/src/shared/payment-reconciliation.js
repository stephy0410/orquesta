/**
 * Conciliación de pagos sin confirmar (RF-11, TR-09; README FR6: "si el procesador falla, el
 * pago queda pendiente y se reintenta; nunca se pierde").
 *
 * Un pago queda `pendiente` (se creó la fila pero el proceso murió antes del cargo) o
 * `desconocido` (timeout / respuesta ambigua del PSP). Este barrido los retoma sin intervención
 * del planner reutilizando `processReservationPayment`, que:
 *   1. consulta al PSP por la MISMA llave de idempotencia (`queryByKey`);
 *   2. si el cargo existe, asienta el ledger exactamente una vez (FOR UPDATE + unicidad);
 *   3. si no existe, reintenta `charge` con la misma llave (el PSP deduplica: nunca doble cobro).
 *
 * Aislamiento de fallas: cualquier error del PSP se cuenta y se emite como métrica `psp_error`,
 * pero nunca se propaga, para que el outbox-poller siga con sus otros barridos.
 */
export async function reconcileUnresolvedPayments(ctx, { now = ctx.now(), minAgeMs = 60_000, limit = 25 } = {}) {
  const nowMs = new Date(now).getTime();
  const summary = { revisados: 0, confirmados: 0, sin_resolver: 0, errores: 0 };
  let pending;
  try {
    pending = await ctx.store.listUnresolvedPayments({ olderThan: new Date(nowMs - minAgeMs), limit });
  } catch (err) {
    summary.errores += 1;
    ctx.metrics?.pspError("reconcile_list_failed");
    return summary;
  }
  for (const p of pending) {
    summary.revisados += 1;
    try {
      const res = await ctx.store.processReservationPayment({
        reservationId: p.reservation_id,
        paymentProvider: ctx.paymentProvider,
        now: new Date(nowMs),
      });
      if (res?.body?.estado === "confirmado") summary.confirmados += 1;
      else summary.sin_resolver += 1;
    } catch {
      summary.errores += 1;
      ctx.metrics?.pspError("reconcile_failed");
    }
  }
  return summary;
}
