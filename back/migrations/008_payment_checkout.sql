-- 008: pago con Stripe Checkout (FR6).
--
-- Con Checkout la planner paga en la página de Stripe: el cobro ya no es síncrono. El backend crea
-- una sesión y guarda su id para poder consultarla al volver, en el barrido de conciliación o
-- cuando llega el webhook. Si la sesión expira sin pago, el siguiente intento crea una nueva usando
-- este id como parte de la llave de idempotencia (nunca dos sesiones abiertas para el mismo pago).
BEGIN;

ALTER TABLE payment ADD COLUMN IF NOT EXISTS psp_checkout_id text;

COMMIT;
