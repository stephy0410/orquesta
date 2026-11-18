-- Orquesta — Migración 005
-- Control de versión optimista del plano de mesas (README FR7 / NFR "Acomodo de mesas").
--
-- Requisito: "Si dos personas editan el mismo plano a la vez, el segundo cambio se rechaza con
-- aviso en lugar de sobrescribir el primero". Las invariantes de capacidad (TR-10, AC-14) ya
-- impedían sobrecupo, pero dos planners con vistas viejas podían mover al mismo invitado sin
-- enterarse del cambio del otro.
--
-- Diseño: una fila por evento con un contador monotónico. Cada edición del planner (crear mesa,
-- asignar/mover, liberar) hace, en la MISMA transacción de la mutación:
--   UPDATE seating_plan SET version = version + 1 WHERE event_id = $1 AND version = $esperada
-- 0 filas ⇒ 409 SEATING_VERSION_CONFLICT con la versión actual. El cliente la obtiene de
-- GET /v1/events/{id}/tables (`plan_version` + `ETag`) y la envía en `If-Match`.

BEGIN;

CREATE TABLE IF NOT EXISTS seating_plan (
  event_id   char(26) PRIMARY KEY REFERENCES event(id),
  version    bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
