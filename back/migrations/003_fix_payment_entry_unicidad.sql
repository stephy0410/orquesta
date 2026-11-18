-- Orquesta — Migración 003
-- Corrige la unicidad del libro contable `payment_entry` (TR-09, RF-11, AC-08).
--
-- Problema: `uq_payment_entry_cobro_unico ON payment_entry(pago_id) WHERE movimiento = 'cobro'`
-- permitía UNA sola fila de cobro por pago. Pero un cobro es un asiento de doble entrada:
-- dos filas (débito en `psp_clearing`, crédito en `worker_payable`) con el mismo `pago_id`.
-- La segunda línea chocaba con el índice, el trigger diferido `payment_entry_balanceado`
-- veía count=1 y abortaba: en PostgreSQL ningún pago podía asentarse.
--
-- Solución: la unicidad correcta es por (pago_id, movimiento, cuenta):
--   * a lo más un asiento de cobro y uno de reverso por pago (nunca se cobra/reversa dos veces);
--   * cada asiento tiene exactamente sus dos cuentas (lo sigue validando el trigger de balance).

BEGIN;

DROP INDEX IF EXISTS uq_payment_entry_cobro_unico;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_entry_movimiento_cuenta
  ON payment_entry(pago_id, movimiento, cuenta);

COMMIT;
