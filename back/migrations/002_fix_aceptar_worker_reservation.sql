-- Orquesta — Migración 002
-- Corrige `aceptar_worker_reservation` (TR-08, RF-17, AC-07, AC-22).
--
-- Problema: la función declara `RETURNS TABLE (..., estado, ..., aceptada_en)`. En PL/pgSQL
-- esas columnas OUT son variables visibles en todo el cuerpo, de modo que el
-- `UPDATE worker_reservation SET estado = ..., aceptada_en = ... WHERE ... estado = 'solicitada'`
-- falla con `column reference "estado" is ambiguous` (42702) en PostgreSQL real.
-- El modo en memoria no ejecuta SQL y no lo detectaba; la suite con TEST_DB=pg sí.
--
-- Solución: `#variable_conflict use_column` hace que, ante ambigüedad, gane la columna
-- de la tabla. La lógica (lock por trabajador, contención en AvailabilityWindow,
-- suma de plazas solapadas y ganadora determinista) no cambia.

BEGIN;

CREATE OR REPLACE FUNCTION aceptar_worker_reservation(
  p_reservation_id char(26),
  p_worker_id      char(26),
  p_plazas         smallint DEFAULT NULL,
  p_now            timestamptz DEFAULT now()
)
RETURNS TABLE (
  reservation_id  char(26),
  estado          text,
  plazas_aceptadas smallint,
  plazas_devueltas smallint,
  ganadora_id     char(26),
  aceptada_en     timestamptz
) AS $$
#variable_conflict use_column
DECLARE
  v_res         worker_reservation%ROWTYPE;
  v_cap         smallint;
  v_ocupadas    integer;
  v_solicitadas smallint;
  v_aceptables  integer;
  v_ganadora    char(26);
BEGIN
  -- Serialización cross-evento por trabajador (TR-08)
  PERFORM pg_advisory_xact_lock(hashtextextended(p_worker_id::text, 0));

  SELECT * INTO v_res
    FROM worker_reservation
   WHERE id = p_reservation_id AND worker_id = p_worker_id AND deleted_at IS NULL
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: reserva %', p_reservation_id USING ERRCODE = 'P0004';
  END IF;

  IF v_res.estado = 'aceptada' THEN
    RETURN QUERY SELECT
      v_res.id,
      v_res.estado,
      v_res.plazas,
      (v_res.plazas_solicitadas - v_res.plazas)::smallint,
      NULL::char(26),
      v_res.aceptada_en;
    RETURN;
  END IF;

  IF v_res.estado = 'expirada' THEN
    RAISE EXCEPTION 'REQUEST_EXPIRED' USING ERRCODE = 'P0002';
  END IF;

  IF v_res.estado <> 'solicitada' THEN
    RAISE EXCEPTION 'RESERVATION_NOT_PENDING: estado=%', v_res.estado USING ERRCODE = 'P0001';
  END IF;

  IF v_res.expira_en <= p_now THEN
    RAISE EXCEPTION 'REQUEST_EXPIRED' USING ERRCODE = 'P0002';
  END IF;

  SELECT plazas_ofrecidas INTO v_cap
    FROM worker_profile
   WHERE id = p_worker_id AND deleted_at IS NULL;

  v_solicitadas := COALESCE(p_plazas, v_res.plazas);
  IF v_solicitadas < 1 OR v_solicitadas > v_res.plazas OR v_solicitadas > v_cap THEN
    RAISE EXCEPTION 'PLAZAS_INVALIDAS' USING ERRCODE = 'P0003';
  END IF;

  -- Contención autoritativa en AvailabilityWindow (RF-22, 02c §2)
  IF NOT EXISTS (
    SELECT 1 FROM availability_window w
     WHERE w.worker_id = p_worker_id
       AND w.rol = v_res.rol
       AND w.deleted_at IS NULL
       AND tstzrange(w.inicio, w.fin, '[)') @> tstzrange(v_res.inicio, v_res.fin, '[)')
  ) THEN
    RAISE EXCEPTION 'WINDOW_NOT_AVAILABLE' USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(sum(r.plazas), 0),
         (SELECT r2.id FROM worker_reservation r2
           WHERE r2.worker_id = p_worker_id
             AND r2.estado = 'aceptada'
             AND r2.deleted_at IS NULL
             AND tstzrange(r2.inicio, r2.fin, '[)') && tstzrange(v_res.inicio, v_res.fin, '[)')
           ORDER BY r2.aceptada_en ASC NULLS LAST, r2.id ASC
           LIMIT 1)
    INTO v_ocupadas, v_ganadora
    FROM worker_reservation r
   WHERE r.worker_id = p_worker_id
     AND r.estado = 'aceptada'
     AND r.deleted_at IS NULL
     AND tstzrange(r.inicio, r.fin, '[)') && tstzrange(v_res.inicio, v_res.fin, '[)');

  v_aceptables := least(v_solicitadas::integer, v_cap::integer - v_ocupadas);

  IF v_aceptables > 0 THEN
    UPDATE worker_reservation
       SET estado = 'aceptada',
           plazas = v_aceptables::smallint,
           aceptada_en = p_now
     WHERE id = p_reservation_id
       AND estado = 'solicitada';

    RETURN QUERY SELECT
      v_res.id,
      'aceptada'::text,
      v_aceptables::smallint,
      (v_res.plazas_solicitadas - v_aceptables)::smallint,
      NULL::char(26),
      p_now;
    RETURN;
  END IF;

  RAISE EXCEPTION 'RESERVATION_OVERLAP ganadora=%', v_ganadora USING ERRCODE = '23505';
END;
$$ LANGUAGE plpgsql;

COMMIT;
