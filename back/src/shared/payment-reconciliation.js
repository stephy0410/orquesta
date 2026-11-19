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

/**
 * Conciliación diaria ledger ↔ procesador (README FR6). Cuadra el día UTC anterior una sola vez:
 *
 *   - `cobro_sin_ledger`: el PSP cobró y el ledger no lo tiene → dinero cobrado sin registro.
 *   - `ledger_sin_cobro`: el ledger dice cobrado y el PSP no tiene el cargo → registro sin dinero.
 *   - `monto_distinto` / `moneda_distinta`: ambos lo tienen pero no coinciden.
 *
 * Los cobros cerca de medianoche pueden caer en días distintos en cada lado; antes de marcar una
 * diferencia se busca la contraparte por llave de idempotencia fuera de la ventana.
 * Se ejecuta a partir de `hora_minima_utc` (default 02:00) para dar tiempo a que el barrido de
 * pagos `desconocido` resuelva los cobros de último minuto.
 *
 * Idempotente (PK por día) y aislado: nunca lanza. Las diferencias se registran en
 * `payment_reconciliation`, en log estructurado y como métrica `psp_error` (dispara la alarma).
 */
export async function runDailyPaymentReconciliation(ctx, { now = ctx.now(), horaMinimaUtc = 2 } = {}) {
  try {
    const nowDate = new Date(now);
    if (nowDate.getUTCHours() < horaMinimaUtc) return { estado: "esperando_ventana" };
    const dayStart = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate() - 1));
    const dayEnd = new Date(dayStart.getTime() + 86400_000);
    const dia = dayStart.toISOString().slice(0, 10);

    const existing = await ctx.store.getPaymentReconciliation(dia);
    if (existing) return { estado: "ya_conciliado", dia };

    const [pspCharges, ledgerCharges] = await Promise.all([
      ctx.paymentProvider.listCharges({ from: dayStart, to: dayEnd }),
      ctx.store.listLedgerCharges({ from: dayStart, to: dayEnd }),
    ]);
    const pspByKey = new Map(pspCharges.map((c) => [c.idempotency_key, c]));
    const ledgerByKey = new Map(ledgerCharges.map((c) => [c.idempotency_key, c]));
    const diferencias = [];

    for (const [key, c] of pspByKey) {
      const l = ledgerByKey.get(key) || (await ctx.store.getPaymentByIdempotencyKey(key));
      if (!l || !l.cobrado_en) {
        diferencias.push({ tipo: "cobro_sin_ledger", idempotency_key: key, psp_charge_id: c.psp_charge_id, monto_psp: c.amount });
      } else if (Number(l.monto) !== Number(c.amount)) {
        diferencias.push({ tipo: "monto_distinto", idempotency_key: key, monto_psp: c.amount, monto_ledger: Number(l.monto) });
      } else if (String(l.moneda).toUpperCase() !== String(c.currency).toUpperCase()) {
        diferencias.push({ tipo: "moneda_distinta", idempotency_key: key, moneda_psp: c.currency, moneda_ledger: l.moneda });
      }
    }
    for (const [key, l] of ledgerByKey) {
      if (pspByKey.has(key)) continue;
      const q = await ctx.paymentProvider.queryByKey(key);
      if (!q?.found || q.status !== "succeeded") {
        diferencias.push({ tipo: "ledger_sin_cobro", idempotency_key: key, payment_id: l.payment_id, monto_ledger: l.monto });
      }
    }

    const sum = (arr, f) => Math.round(arr.reduce((a, x) => a + Number(f(x)), 0) * 100) / 100;
    const run = await ctx.store.savePaymentReconciliation({
      dia,
      estado: diferencias.length === 0 ? "conciliado" : "con_diferencias",
      cobros_psp: pspCharges.length,
      cobros_ledger: ledgerCharges.length,
      monto_psp: sum(pspCharges, (c) => c.amount),
      monto_ledger: sum(ledgerCharges, (c) => c.monto),
      diferencias,
      ejecutado_en: nowDate.toISOString(),
    });
    if (diferencias.length > 0) {
      ctx.metrics?.pspError("reconciliation_mismatch");
      console.error(JSON.stringify({ level: "error", msg: "payment_reconciliation_mismatch", dia, diferencias: diferencias.length }));
    }
    return run;
  } catch (err) {
    ctx.metrics?.pspError("reconciliation_failed");
    console.error(JSON.stringify({ level: "error", msg: "payment_reconciliation_failed", error: err?.message }));
    return { estado: "error" };
  }
}
