-- Orquesta — Migración 007
-- Baja del invitado por canal (README FR8: "se respeta la baja del invitado").
--
-- El invitado, sin cuenta y con el token de su invitación, puede dejar de recibir mensajes por SMS,
-- por email o por ambos. La baja es por canal y por invitado (no borra la invitación ni su QR: sigue
-- pudiendo confirmar y entrar al evento). Envíos, reenvíos y recordatorios no crean entregas para un
-- canal dado de baja, y los workers lo revalidan antes de enviar.

BEGIN;

ALTER TABLE guest ADD COLUMN IF NOT EXISTS baja_sms_en   timestamptz;
ALTER TABLE guest ADD COLUMN IF NOT EXISTS baja_email_en timestamptz;

COMMIT;
