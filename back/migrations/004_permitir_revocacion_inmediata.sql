-- Orquesta — Migración 004
-- Permite revocar accesos de evento en el mismo instante en que se emitieron (RF-01, RF-15, RF-19).
--
-- Problema: al cerrar o cancelar un evento, `transitionEvent` expira todos sus accesos con
-- `expira_en = now()`. `event_access_token` y `staff_assignment` tenían `CHECK (expira_en > created_at)`;
-- un acceso emitido en el mismo instante del cierre hacía fallar el UPDATE y, con él, la
-- transacción completa del cierre (500 y evento sin cerrar).
--
-- Solución: `expira_en >= created_at`. El invariante que importa ("nunca nace ya vencido")
-- se sigue validando en la aplicación al emitir (`_assertEventOpenForAccess`); el CHECK
-- solo impide un vencimiento ANTERIOR a la emisión.

BEGIN;

ALTER TABLE event_access_token DROP CONSTRAINT IF EXISTS event_access_token_check;
ALTER TABLE event_access_token
  ADD CONSTRAINT event_access_token_expira_check CHECK (expira_en >= created_at);

ALTER TABLE staff_assignment DROP CONSTRAINT IF EXISTS staff_assignment_check;
ALTER TABLE staff_assignment
  ADD CONSTRAINT staff_assignment_expira_check CHECK (expira_en >= created_at);

COMMIT;
