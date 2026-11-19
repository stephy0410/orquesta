-- Orquesta — Migración 006
-- Conciliación diaria del ledger contra el procesador de pagos (README FR6: "cada movimiento queda
-- en un libro contable de solo agregar, con conciliación diaria contra el procesador").
--
-- Una fila por día UTC conciliado. La PK hace idempotente el job: el outbox-poller lo intenta cada
-- minuto y solo la primera ejecución del día escribe. Las diferencias se guardan para auditoría y
-- además disparan la alarma `psp_error` en CloudWatch.

BEGIN;

CREATE TABLE IF NOT EXISTS payment_reconciliation (
  dia             date PRIMARY KEY,
  estado          text NOT NULL CHECK (estado IN ('conciliado','con_diferencias')),
  cobros_psp      integer NOT NULL CHECK (cobros_psp >= 0),
  cobros_ledger   integer NOT NULL CHECK (cobros_ledger >= 0),
  monto_psp       numeric(14,2) NOT NULL,
  monto_ledger    numeric(14,2) NOT NULL,
  diferencias     jsonb NOT NULL DEFAULT '[]',
  ejecutado_en    timestamptz NOT NULL
);

COMMIT;
