-- Orquesta — Migración Inicial (PostgreSQL 16+)
-- Fuente normativa: docs/requerimientos.md v2.1 y docs/delivery/02a, 02b, 02c
-- Contiene: extensiones btree_gist y pgcrypto, catálogos cerrados, las 22 entidades de dominio,
-- vista worker_profile_publico, proyección event_counters, tablas de soporte
-- (outbox_event, idempotency_record, projector_applied, verification_challenge, import_job,
-- scan_session, checkin_batch_ack, webhook_event, planner_alert), triggers e invariantes.

BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- Función común de auditoría temporal
-- ============================================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Catálogos cerrados (02a, 02c, RF-07, RF-21, RF-22)
-- ============================================================================
CREATE TABLE catalogo_zona (
  zona   text PRIMARY KEY,
  nombre text NOT NULL,
  lat    numeric(9,6) NOT NULL,
  lng    numeric(9,6) NOT NULL
);

CREATE TABLE catalogo_categoria (
  categoria text PRIMARY KEY,
  nombre    text NOT NULL
);

CREATE TABLE catalogo_servicio (
  servicio  text NOT NULL,
  categoria text NOT NULL REFERENCES catalogo_categoria(categoria),
  PRIMARY KEY (servicio, categoria)
);

CREATE TABLE catalogo_rol (
  rol    text PRIMARY KEY,
  nombre text NOT NULL
);

INSERT INTO catalogo_zona (zona, nombre, lat, lng) VALUES
  ('norte',         'Zona Norte',        19.489000, -99.133000),
  ('sur',           'Zona Sur',          19.315000, -99.180000),
  ('centro',        'Zona Centro',       19.432608, -99.133209),
  ('oriente',       'Zona Oriente',      19.400000, -99.070000),
  ('poniente',      'Zona Poniente',     19.390000, -99.250000),
  ('cdmx_norte',    'CDMX Norte',        19.490000, -99.135000),
  ('cdmx_sur',      'CDMX Sur',          19.310000, -99.175000),
  ('cdmx_centro',   'CDMX Centro',       19.432608, -99.133209),
  ('cdmx_oriente',  'CDMX Oriente',      19.402000, -99.072000),
  ('cdmx_poniente', 'CDMX Poniente',     19.388000, -99.255000),
  ('polanco',       'Polanco',           19.433500, -99.195000),
  ('roma_condesa',  'Roma / Condesa',    19.414000, -99.168000),
  ('santa_fe',      'Santa Fe',          19.361000, -99.275000),
  ('coyoacan',      'Coyoacán',          19.346700, -99.161700),
  ('metropolitana', 'Área Metropolitana',19.420000, -99.150000),
  ('guadalajara',   'Guadalajara',       20.659699, -103.349609),
  ('monterrey',     'Monterrey',         25.686614, -100.316113)
ON CONFLICT DO NOTHING;

INSERT INTO catalogo_categoria (categoria, nombre) VALUES
  ('mesero',             'Mesero'),
  ('maquillista',        'Maquillista'),
  ('fotografo',          'Fotógrafo'),
  ('dj',                 'DJ'),
  ('catering',           'Catering'),
  ('bartender',          'Bartender'),
  ('seguridad',          'Seguridad'),
  ('coordinacion',       'Coordinación'),
  ('decoracion',         'Decoración'),
  ('animacion',          'Animación'),
  ('iluminacion_sonido', 'Iluminación y Sonido'),
  ('video',              'Video')
ON CONFLICT DO NOTHING;

INSERT INTO catalogo_servicio (servicio, categoria) VALUES
  ('mesero',             'mesero'),
  ('servicio_mesa',      'mesero'),
  ('capitan_meseros',    'mesero'),
  ('cocteleria',         'mesero'),
  ('maquillista',        'maquillista'),
  ('maquillaje_social',  'maquillista'),
  ('peinado',            'maquillista'),
  ('fotografo',          'fotografo'),
  ('fotografia_evento',  'fotografo'),
  ('cabina_fotos',       'fotografo'),
  ('dj',                 'dj'),
  ('mezcla_en_vivo',     'dj'),
  ('audio_iluminacion',  'dj'),
  ('catering',           'catering'),
  ('banquete',           'catering'),
  ('mesa_dulces',        'catering'),
  ('bartender',          'bartender'),
  ('barra_libre',        'bartender'),
  ('seguridad',          'seguridad'),
  ('control_acceso',     'seguridad'),
  ('coordinacion',       'coordinacion'),
  ('decoracion',         'decoracion'),
  ('animacion',          'animacion'),
  ('iluminacion_sonido', 'iluminacion_sonido'),
  ('video',              'video')
ON CONFLICT DO NOTHING;

INSERT INTO catalogo_rol (rol, nombre) VALUES
  ('mesero',             'Mesero'),
  ('maquillista',        'Maquillista'),
  ('fotografo',          'Fotógrafo'),
  ('dj',                 'DJ'),
  ('catering',           'Catering'),
  ('bartender',          'Bartender'),
  ('seguridad',          'Seguridad'),
  ('coordinacion',       'Coordinación'),
  ('decoracion',         'Decoración'),
  ('animacion',          'Animación'),
  ('iluminacion_sonido', 'Iluminación y Sonido'),
  ('video',              'Video'),
  ('staff',              'Staff de evento'),
  ('hostess',            'Hostess'),
  ('scanner',            'Escáner de acceso'),
  ('capitan_meseros',    'Capitán de meseros')
ON CONFLICT DO NOTHING;

-- ============================================================================
-- 1. User (02a §1)
-- ============================================================================
CREATE TABLE "user" (
  id                  char(26) PRIMARY KEY,
  email               text CHECK (email IS NULL OR email = lower(btrim(email))),
  email_cifrado       text NOT NULL,
  email_hmac          char(64) NOT NULL,
  roles               text[] NOT NULL CHECK (cardinality(roles) >= 1 AND roles <@ ARRAY['planner','worker']),
  password_hash       text NOT NULL CHECK (length(password_hash) >= 40),
  email_verificado_en timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);

CREATE UNIQUE INDEX uq_user_email_hmac ON "user"(email_hmac);
CREATE UNIQUE INDEX uq_user_email_plain ON "user"(email) WHERE email IS NOT NULL;
CREATE INDEX idx_user_roles_gin ON "user" USING gin(roles);

CREATE TRIGGER trg_user_updated_at
  BEFORE UPDATE ON "user"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 2. Venue (02a §3)
-- ============================================================================
CREATE TABLE venue (
  id         char(26) PRIMARY KEY,
  nombre     text NOT NULL CHECK (length(btrim(nombre)) BETWEEN 1 AND 120),
  zona       text NOT NULL,
  direccion  text NOT NULL CHECK (length(btrim(direccion)) BETWEEN 1 AND 240),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX idx_venue_zona ON venue(zona);

CREATE OR REPLACE FUNCTION validate_venue_zona()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM catalogo_zona z WHERE z.zona = NEW.zona) THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: zona inválida %', NEW.zona USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_venue_zona
  BEFORE INSERT OR UPDATE OF zona ON venue
  FOR EACH ROW EXECUTE FUNCTION validate_venue_zona();

CREATE TRIGGER trg_venue_updated_at
  BEFORE UPDATE ON venue
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 3. Event (02a §4)
-- ============================================================================
CREATE TABLE event (
  id               char(26) PRIMARY KEY,
  venue_id         char(26) NOT NULL REFERENCES venue(id),
  nombre           text NOT NULL CHECK (length(btrim(nombre)) BETWEEN 1 AND 160),
  fecha            date NOT NULL,
  timezone         text NOT NULL,
  ventana_inicio   timestamptz NOT NULL,
  ventana_fin      timestamptz NOT NULL,
  aforo            integer NOT NULL CHECK (aforo > 0),
  estado           text NOT NULL DEFAULT 'borrador'
                     CHECK (estado IN ('borrador','publicado','en_curso','cerrado','cancelado')),
  cerrado_en       timestamptz,
  cancelado_motivo text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  CHECK (ventana_fin > ventana_inicio),
  CHECK ((estado = 'cerrado') = (cerrado_en IS NOT NULL))
);

CREATE INDEX idx_event_estado_inicio ON event(estado, ventana_inicio);
CREATE INDEX idx_event_venue ON event(venue_id);
CREATE INDEX idx_event_fecha ON event(fecha);

CREATE OR REPLACE FUNCTION validate_event_invariants()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names tz WHERE tz.name = NEW.timezone) THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: timezone IANA inválida %', NEW.timezone USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.estado IS DISTINCT FROM OLD.estado THEN
    IF OLD.estado = 'borrador' AND NEW.estado NOT IN ('publicado','cancelado') THEN
      RAISE EXCEPTION 'EVENT_STATE_INVALID: % -> %', OLD.estado, NEW.estado USING ERRCODE = '23514';
    ELSIF OLD.estado = 'publicado' AND NEW.estado NOT IN ('en_curso','cerrado','cancelado') THEN
      RAISE EXCEPTION 'EVENT_STATE_INVALID: % -> %', OLD.estado, NEW.estado USING ERRCODE = '23514';
    ELSIF OLD.estado = 'en_curso' AND NEW.estado NOT IN ('cerrado','cancelado') THEN
      RAISE EXCEPTION 'EVENT_STATE_INVALID: % -> %', OLD.estado, NEW.estado USING ERRCODE = '23514';
    ELSIF OLD.estado IN ('cerrado','cancelado') THEN
      RAISE EXCEPTION 'EVENT_STATE_INVALID: % -> %', OLD.estado, NEW.estado USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_event_invariants
  BEFORE INSERT OR UPDATE ON event
  FOR EACH ROW EXECUTE FUNCTION validate_event_invariants();

CREATE TRIGGER trg_event_updated_at
  BEFORE UPDATE ON event
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 4. EventMembership (02a §2)
-- ============================================================================
CREATE TABLE event_membership (
  id         char(26) PRIMARY KEY,
  event_id   char(26) NOT NULL REFERENCES event(id),
  user_id    char(26) NOT NULL REFERENCES "user"(id),
  rol        text NOT NULL DEFAULT 'owner' CHECK (rol IN ('owner','editor')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX uq_event_membership_pair ON event_membership(event_id, user_id);
CREATE UNIQUE INDEX uq_event_membership_owner ON event_membership(event_id)
  WHERE rol = 'owner' AND deleted_at IS NULL;
CREATE INDEX idx_event_membership_user ON event_membership(user_id)
  WHERE deleted_at IS NULL;

CREATE TRIGGER trg_event_membership_updated_at
  BEFORE UPDATE ON event_membership
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 5. EventRequirement (02a §5)
-- ============================================================================
CREATE TABLE event_requirement (
  id         char(26) PRIMARY KEY,
  event_id   char(26) NOT NULL REFERENCES event(id),
  rol        text NOT NULL,
  cantidad   smallint NOT NULL CHECK (cantidad > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX uq_event_requirement_rol ON event_requirement(event_id, rol);

CREATE OR REPLACE FUNCTION validate_rol_catalogo()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM catalogo_rol r WHERE r.rol = NEW.rol) THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: rol inválido %', NEW.rol USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_event_requirement_rol
  BEFORE INSERT OR UPDATE OF rol ON event_requirement
  FOR EACH ROW EXECUTE FUNCTION validate_rol_catalogo();

CREATE TRIGGER trg_event_requirement_updated_at
  BEFORE UPDATE ON event_requirement
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 6. Guest (02a §6)
-- ============================================================================
CREATE TABLE guest (
  id                 char(26) PRIMARY KEY,
  event_id           char(26) NOT NULL REFERENCES event(id),
  nombre             text NOT NULL CHECK (length(btrim(nombre)) BETWEEN 1 AND 120),
  email_normalizado  text CHECK (email_normalizado IS NULL OR email_normalizado = lower(btrim(email_normalizado))),
  email_cifrado      text,
  email_hmac         char(64),
  telefono_e164      text CHECK (telefono_e164 IS NULL OR telefono_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  telefono_cifrado   text,
  telefono_hmac      char(64),
  estado_envio       text NOT NULL DEFAULT 'pendiente_envio'
                       CHECK (estado_envio IN ('pendiente_envio','enviado')),
  pii_anonimizada_en timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  CHECK (
    pii_anonimizada_en IS NOT NULL
    OR email_cifrado IS NOT NULL
    OR telefono_cifrado IS NOT NULL
    OR email_normalizado IS NOT NULL
    OR telefono_e164 IS NOT NULL
  )
);

CREATE UNIQUE INDEX uq_guest_event_email_hmac ON guest(event_id, email_hmac)
  WHERE email_hmac IS NOT NULL;
CREATE UNIQUE INDEX uq_guest_event_phone_hmac ON guest(event_id, telefono_hmac)
  WHERE telefono_hmac IS NOT NULL;
CREATE UNIQUE INDEX uq_guest_event_email ON guest(event_id, email_normalizado)
  WHERE email_normalizado IS NOT NULL;
CREATE UNIQUE INDEX uq_guest_event_phone ON guest(event_id, telefono_e164)
  WHERE telefono_e164 IS NOT NULL;
CREATE INDEX idx_guest_event_active ON guest(event_id)
  WHERE deleted_at IS NULL;

CREATE TRIGGER trg_guest_updated_at
  BEFORE UPDATE ON guest
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 7. Invitation (02a §7)
-- ============================================================================
CREATE TABLE invitation (
  id                  char(26) PRIMARY KEY,
  event_id            char(26) NOT NULL REFERENCES event(id),
  guest_id            char(26) NOT NULL REFERENCES guest(id),
  rsvp_token_hash     char(64),
  rsvp_token_cifrado  text,
  checkin_key_id      text NOT NULL,
  token_version       smallint NOT NULL DEFAULT 1 CHECK (token_version >= 1),
  qr_token_cifrado    text,
  qr_s3_key           text,
  qr_emitido_en       timestamptz NOT NULL DEFAULT now(),
  rsvp_revocado_en    timestamptz,
  checkin_revocado_en timestamptz,
  codigo_corto        char(6) NOT NULL CHECK (codigo_corto ~ '^[0-9]{6}$'),
  pii_anonimizada_en  timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CHECK (pii_anonimizada_en IS NOT NULL OR rsvp_token_hash IS NOT NULL)
);

CREATE UNIQUE INDEX uq_invitation_guest ON invitation(guest_id);
CREATE UNIQUE INDEX uq_invitation_rsvp_hash ON invitation(rsvp_token_hash)
  WHERE rsvp_token_hash IS NOT NULL;
CREATE UNIQUE INDEX uq_invitation_codigo_corto ON invitation(event_id, codigo_corto);
CREATE INDEX idx_invitation_event_active ON invitation(event_id)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_invitation_checkin_revoked ON invitation(event_id, checkin_revocado_en)
  WHERE checkin_revocado_en IS NOT NULL;

CREATE TRIGGER trg_invitation_updated_at
  BEFORE UPDATE ON invitation
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 8. EventAccessToken (02a §8)
-- ============================================================================
CREATE TABLE event_access_token (
  id                  char(26) PRIMARY KEY,
  event_id            char(26) NOT NULL REFERENCES event(id),
  rol                 text NOT NULL,
  token_hash          char(64) NOT NULL,
  emitido_por_user_id char(26) NOT NULL REFERENCES "user"(id),
  expira_en           timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CHECK (expira_en > created_at)
);

CREATE UNIQUE INDEX uq_event_access_token_hash ON event_access_token(token_hash);
CREATE INDEX idx_event_access_token_event_rol ON event_access_token(event_id, rol)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_event_access_token_expira ON event_access_token(expira_en)
  WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION validate_event_access_token()
RETURNS trigger AS $$
DECLARE
  v_ventana_fin timestamptz;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM catalogo_rol r WHERE r.rol = NEW.rol) THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: rol inválido %', NEW.rol USING ERRCODE = '23514';
  END IF;

  SELECT ventana_fin INTO v_ventana_fin FROM event WHERE id = NEW.event_id;
  IF TG_OP = 'INSERT' AND NEW.expira_en > v_ventana_fin THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: expira_en excede event.ventana_fin' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_event_access_token_validate
  BEFORE INSERT OR UPDATE OF rol, expira_en ON event_access_token
  FOR EACH ROW EXECUTE FUNCTION validate_event_access_token();

CREATE TRIGGER trg_event_access_token_updated_at
  BEFORE UPDATE ON event_access_token
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 9. StaffAssignment (02b §1)
-- ============================================================================
CREATE TABLE staff_assignment (
  id                   char(26) PRIMARY KEY,
  event_id             char(26) NOT NULL REFERENCES event(id),
  user_id              char(26) NOT NULL REFERENCES "user"(id),
  permisos             text[] NOT NULL DEFAULT ARRAY['roster','checkin']
                         CHECK (cardinality(permisos) >= 1 AND permisos <@ ARRAY['roster','checkin','anulacion']),
  otorgado_por_user_id char(26) NOT NULL REFERENCES "user"(id),
  expira_en            timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz,
  CHECK (expira_en > created_at)
);

CREATE UNIQUE INDEX uq_staff_assignment_active ON staff_assignment(event_id, user_id)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_staff_assignment_user ON staff_assignment(user_id)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_staff_assignment_expira ON staff_assignment(expira_en)
  WHERE deleted_at IS NULL;

CREATE TRIGGER trg_staff_assignment_updated_at
  BEFORE UPDATE ON staff_assignment
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 10. WorkerProfile (02c §1) - creado antes de WorkerReservation / ReminderJob
-- ============================================================================
CREATE TABLE worker_profile (
  id                     char(26) PRIMARY KEY,
  user_id                char(26) NOT NULL REFERENCES "user"(id),
  tipo                   text NOT NULL CHECK (tipo IN ('persona','empresa')),
  plazas_ofrecidas       smallint NOT NULL DEFAULT 1 CHECK (plazas_ofrecidas BETWEEN 1 AND 50),
  nombre_publico         text NOT NULL CHECK (length(btrim(nombre_publico)) BETWEEN 1 AND 120),
  categorias             text[] NOT NULL CHECK (cardinality(categorias) BETWEEN 1 AND 3),
  servicios              text[] NOT NULL DEFAULT '{}',
  tarifa_modo            text NOT NULL DEFAULT 'fijo' CHECK (tarifa_modo IN ('fijo')),
  tarifa_monto           numeric(12,2) CHECK (tarifa_monto IS NULL OR tarifa_monto > 0),
  tarifa_moneda          char(3),
  tarifa_unidad          text CHECK (tarifa_unidad IS NULL OR tarifa_unidad IN ('hora','persona_hora','evento')),
  zonas                  text[] NOT NULL CHECK (cardinality(zonas) BETWEEN 1 AND 5),
  radio_km               numeric(5,2) CHECK (radio_km IS NULL OR (radio_km > 0 AND radio_km <= 150)),
  idiomas                text[] NOT NULL DEFAULT '{}',
  anios_experiencia      smallint CHECK (anios_experiencia IS NULL OR anios_experiencia BETWEEN 0 AND 70),
  fotos                  text[] NOT NULL DEFAULT '{}' CHECK (cardinality(fotos) <= 3),
  referencias            text[] NOT NULL DEFAULT '{}' CHECK (cardinality(referencias) <= 3),
  estado                 text NOT NULL DEFAULT 'borrador'
                           CHECK (estado IN ('borrador','publicado','suspendido')),
  telefono_e164          text CHECK (telefono_e164 IS NULL OR telefono_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  telefono_cifrado       text,
  telefono_hmac          char(64),
  telefono_verificado_en timestamptz,
  email_verificado_en    timestamptz,
  pii_anonimizada_en     timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz,
  CHECK (tipo = 'empresa' OR plazas_ofrecidas = 1),
  CHECK (
    pii_anonimizada_en IS NOT NULL
    OR estado <> 'publicado'
    OR (
      tarifa_monto IS NOT NULL
      AND tarifa_moneda IS NOT NULL
      AND tarifa_unidad IS NOT NULL
      AND (telefono_cifrado IS NOT NULL OR telefono_e164 IS NOT NULL)
    )
  )
);

CREATE UNIQUE INDEX uq_worker_profile_user ON worker_profile(user_id);
CREATE UNIQUE INDEX uq_worker_profile_phone_hmac ON worker_profile(telefono_hmac)
  WHERE telefono_verificado_en IS NOT NULL AND deleted_at IS NULL AND telefono_hmac IS NOT NULL;
CREATE UNIQUE INDEX uq_worker_profile_phone_plain ON worker_profile(telefono_e164)
  WHERE telefono_verificado_en IS NOT NULL AND deleted_at IS NULL AND telefono_e164 IS NOT NULL;
CREATE INDEX idx_worker_profile_categorias_gin ON worker_profile USING gin(categorias);
CREATE INDEX idx_worker_profile_zonas_gin ON worker_profile USING gin(zonas);
CREATE INDEX idx_worker_profile_visibilidad ON worker_profile(tarifa_monto, id)
  WHERE estado = 'publicado'
    AND email_verificado_en IS NOT NULL
    AND telefono_verificado_en IS NOT NULL
    AND deleted_at IS NULL;

CREATE OR REPLACE FUNCTION validate_worker_profile_catalogs()
RETURNS trigger AS $$
DECLARE
  v_cat text;
  v_srv text;
  v_zon text;
BEGIN
  FOREACH v_cat IN ARRAY NEW.categorias LOOP
    IF NOT EXISTS (SELECT 1 FROM catalogo_categoria c WHERE c.categoria = v_cat) THEN
      RAISE EXCEPTION 'VALIDATION_ERROR: categoría inválida %', v_cat USING ERRCODE = '23514';
    END IF;
  END LOOP;

  FOREACH v_srv IN ARRAY NEW.servicios LOOP
    IF NOT EXISTS (
      SELECT 1 FROM catalogo_servicio s
       WHERE s.servicio = v_srv AND s.categoria = ANY(NEW.categorias)
    ) AND NOT (v_srv = ANY(NEW.categorias)) THEN
      RAISE EXCEPTION 'VALIDATION_ERROR: servicio % no pertenece a las categorías declaradas', v_srv USING ERRCODE = '23514';
    END IF;
  END LOOP;

  FOREACH v_zon IN ARRAY NEW.zonas LOOP
    IF NOT EXISTS (SELECT 1 FROM catalogo_zona z WHERE z.zona = v_zon) THEN
      RAISE EXCEPTION 'VALIDATION_ERROR: zona inválida %', v_zon USING ERRCODE = '23514';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_worker_profile_catalogs
  BEFORE INSERT OR UPDATE OF categorias, servicios, zonas ON worker_profile
  FOR EACH ROW EXECUTE FUNCTION validate_worker_profile_catalogs();

CREATE TRIGGER trg_worker_profile_updated_at
  BEFORE UPDATE ON worker_profile
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 11. AvailabilityWindow (02c §2)
-- ============================================================================
CREATE TABLE availability_window (
  id         char(26) PRIMARY KEY,
  worker_id  char(26) NOT NULL REFERENCES worker_profile(id),
  inicio     timestamptz NOT NULL,
  fin        timestamptz NOT NULL,
  zona       text NOT NULL,
  rol        text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (fin > inicio)
);

CREATE INDEX idx_availability_gist ON availability_window
  USING gist (worker_id, tstzrange(inicio, fin, '[)'))
  WHERE deleted_at IS NULL;
CREATE INDEX idx_availability_worker_range ON availability_window(worker_id, inicio, fin)
  WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION validate_availability_catalogs()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM catalogo_zona z WHERE z.zona = NEW.zona) THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: zona inválida %', NEW.zona USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM catalogo_rol r WHERE r.rol = NEW.rol) THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: rol inválido %', NEW.rol USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_availability_catalogs
  BEFORE INSERT OR UPDATE OF zona, rol ON availability_window
  FOR EACH ROW EXECUTE FUNCTION validate_availability_catalogs();

CREATE TRIGGER trg_availability_updated_at
  BEFORE UPDATE ON availability_window
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 12. WorkerReservation (02c §3)
-- ============================================================================
CREATE TABLE worker_reservation (
  id                     char(26) PRIMARY KEY,
  worker_id              char(26) NOT NULL REFERENCES worker_profile(id),
  event_id               char(26) NOT NULL REFERENCES event(id),
  rol                    text NOT NULL,
  inicio                 timestamptz NOT NULL,
  fin                    timestamptz NOT NULL,
  hora_llegada           timestamptz NOT NULL,
  plazas                 smallint NOT NULL DEFAULT 1 CHECK (plazas BETWEEN 1 AND 50),
  plazas_solicitadas     smallint NOT NULL DEFAULT 1 CHECK (plazas_solicitadas BETWEEN 1 AND 50),
  estado                 text NOT NULL DEFAULT 'solicitada'
                           CHECK (estado IN ('solicitada','aceptada','rechazada','expirada','cancelada','cancelada_pagada','sin_cubrir','completada')),
  costo_congelado_modo   text NOT NULL DEFAULT 'fijo' CHECK (costo_congelado_modo IN ('fijo')),
  costo_congelado_monto  numeric(12,2) NOT NULL CHECK (costo_congelado_monto > 0),
  costo_congelado_moneda char(3) NOT NULL,
  costo_congelado_unidad text NOT NULL CHECK (costo_congelado_unidad IN ('hora','persona_hora','evento')),
  modo_emergencia        boolean NOT NULL DEFAULT false,
  llegada_registrada_en  timestamptz,
  aceptada_en            timestamptz,
  rechazada_en           timestamptz,
  cancelada_en           timestamptz,
  motivo_rechazo         text,
  motivo_cancelacion     text,
  expira_en              timestamptz NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz,
  CHECK (fin > inicio),
  CHECK (hora_llegada >= inicio AND hora_llegada < fin),
  CHECK (expira_en > created_at)
);

CREATE INDEX idx_worker_reservation_gist ON worker_reservation
  USING gist (worker_id, tstzrange(inicio, fin, '[)'));
CREATE INDEX idx_worker_reservation_aceptada ON worker_reservation(worker_id)
  WHERE estado = 'aceptada' AND deleted_at IS NULL;
CREATE INDEX idx_worker_reservation_event_rol ON worker_reservation(event_id, rol, estado);
CREATE INDEX idx_worker_reservation_expira ON worker_reservation(expira_en)
  WHERE estado = 'solicitada';

CREATE TRIGGER trg_worker_reservation_rol
  BEFORE INSERT OR UPDATE OF rol ON worker_reservation
  FOR EACH ROW EXECUTE FUNCTION validate_rol_catalogo();

CREATE OR REPLACE FUNCTION guard_worker_reservation_immutability()
RETURNS trigger AS $$
BEGIN
  IF NEW.costo_congelado_monto  IS DISTINCT FROM OLD.costo_congelado_monto
  OR NEW.costo_congelado_moneda IS DISTINCT FROM OLD.costo_congelado_moneda
  OR NEW.costo_congelado_unidad IS DISTINCT FROM OLD.costo_congelado_unidad
  OR NEW.costo_congelado_modo   IS DISTINCT FROM OLD.costo_congelado_modo
  OR NEW.worker_id              IS DISTINCT FROM OLD.worker_id
  OR NEW.event_id               IS DISTINCT FROM OLD.event_id
  OR NEW.inicio                 IS DISTINCT FROM OLD.inicio
  OR NEW.fin                    IS DISTINCT FROM OLD.fin THEN
    RAISE EXCEPTION 'COSTO_CONGELADO_INMUTABLE: campos de snapshot y ventana son inmutables'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_worker_reservation_immutable
  BEFORE UPDATE ON worker_reservation
  FOR EACH ROW EXECUTE FUNCTION guard_worker_reservation_immutability();

CREATE TRIGGER trg_worker_reservation_updated_at
  BEFORE UPDATE ON worker_reservation
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Vista pública de trabajadores (02c §1 Invariante 4, RF-07, NFR-11 exc. 2)
-- NUNCA expone telefono_e164, telefono_cifrado ni reservas o eventos donde trabaja.
CREATE OR REPLACE VIEW worker_profile_publico AS
SELECT
  wp.id AS worker_id,
  wp.tipo,
  wp.plazas_ofrecidas,
  wp.nombre_publico,
  wp.categorias,
  wp.servicios,
  wp.tarifa_modo,
  wp.tarifa_monto,
  wp.tarifa_moneda,
  wp.tarifa_unidad,
  wp.zonas,
  wp.radio_km,
  wp.idiomas,
  wp.anios_experiencia,
  COALESCE((
    SELECT count(*)::integer
      FROM worker_reservation wr
     WHERE wr.worker_id = wp.id
       AND wr.estado = 'completada'
       AND wr.deleted_at IS NULL
  ), 0) AS eventos_completados
FROM worker_profile wp
WHERE wp.estado = 'publicado'
  AND wp.email_verificado_en IS NOT NULL
  AND wp.telefono_verificado_en IS NOT NULL
  AND wp.deleted_at IS NULL;

-- ============================================================================
-- 13. ReminderJob (02b §8)
-- ============================================================================
CREATE TABLE reminder_job (
  id                    char(26) PRIMARY KEY,
  event_id              char(26) NOT NULL REFERENCES event(id),
  guest_id              char(26) REFERENCES guest(id),
  worker_reservation_id char(26) REFERENCES worker_reservation(id),
  destinatario          text NOT NULL,
  canal                 text NOT NULL CHECK (canal IN ('sms','email')),
  direccion_cifrada     text,
  plantilla             text NOT NULL CHECK (plantilla IN ('recordatorio_rsvp','recordatorio_llegada')),
  ventana               text NOT NULL CHECK (ventana IN ('t_7d','t_1d','t_24h','t_2h')),
  disparar_en           timestamptz NOT NULL,
  estado                text NOT NULL DEFAULT 'programado'
                          CHECK (estado IN ('programado','cancelado','consumido')),
  motivo_cancelacion    text CHECK (
    motivo_cancelacion IS NULL
    OR motivo_cancelacion IN ('rsvp_registrado','reserva_cancelada','invitado_de_baja','destinatario_inexistente')
  ),
  pii_anonimizada_en    timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz,
  CHECK ((guest_id IS NOT NULL) <> (worker_reservation_id IS NOT NULL)),
  CHECK ((estado = 'cancelado') = (motivo_cancelacion IS NOT NULL))
);

CREATE UNIQUE INDEX uq_reminder_job_tr12 ON reminder_job(destinatario, plantilla, ventana);
CREATE INDEX idx_reminder_job_programado ON reminder_job(estado, disparar_en)
  WHERE estado = 'programado';
CREATE INDEX idx_reminder_job_event_guest ON reminder_job(event_id, guest_id);
CREATE INDEX idx_reminder_job_reservation ON reminder_job(worker_reservation_id)
  WHERE worker_reservation_id IS NOT NULL;

CREATE TRIGGER trg_reminder_job_updated_at
  BEFORE UPDATE ON reminder_job
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 14. InvitationDelivery (02b §2)
-- ============================================================================
CREATE TABLE invitation_delivery (
  id                 char(26) PRIMARY KEY,
  event_id           char(26) NOT NULL REFERENCES event(id),
  invitation_id      char(26) REFERENCES invitation(id),
  reminder_job_id    char(26) REFERENCES reminder_job(id),
  destinatario       text NOT NULL,
  direccion_cifrada  text,
  canal              text NOT NULL CHECK (canal IN ('sms','email')),
  plantilla          text NOT NULL CHECK (plantilla IN ('invitacion','recordatorio_rsvp','recordatorio_llegada')),
  ventana            text NOT NULL CHECK (ventana ~ '^(envio_inicial|resend_[1-9][0-9]*|t_7d|t_1d|t_24h|t_2h)$'),
  estado             text NOT NULL DEFAULT 'encolado'
                       CHECK (estado IN ('encolado','entregado','rebotado','indeterminado')),
  intentos           smallint NOT NULL DEFAULT 0 CHECK (intentos BETWEEN 0 AND 3),
  estado_en          timestamptz NOT NULL DEFAULT now(),
  pii_anonimizada_en timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  CHECK (pii_anonimizada_en IS NOT NULL OR direccion_cifrada IS NOT NULL)
);

CREATE UNIQUE INDEX uq_invitation_delivery_tr12 ON invitation_delivery(destinatario, plantilla, ventana);
CREATE INDEX idx_invitation_delivery_inv_canal ON invitation_delivery(invitation_id, canal);
CREATE INDEX idx_invitation_delivery_pending ON invitation_delivery(event_id, estado)
  WHERE estado IN ('encolado','indeterminado');
CREATE INDEX idx_invitation_delivery_reminder ON invitation_delivery(reminder_job_id)
  WHERE reminder_job_id IS NOT NULL;

CREATE TRIGGER trg_invitation_delivery_updated_at
  BEFORE UPDATE ON invitation_delivery
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 15. RsvpResponse (02b §3)
-- ============================================================================
CREATE TABLE rsvp_response (
  id            char(26) PRIMARY KEY,
  event_id      char(26) NOT NULL REFERENCES event(id),
  invitation_id char(26) NOT NULL REFERENCES invitation(id),
  respuesta     text NOT NULL CHECK (respuesta IN ('confirma','declina')),
  respondido_en timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  CHECK (superseded_at IS NULL OR superseded_at > respondido_en)
);

CREATE UNIQUE INDEX uq_rsvp_response_vigente ON rsvp_response(invitation_id)
  WHERE superseded_at IS NULL;
CREATE INDEX idx_rsvp_response_event_resp ON rsvp_response(event_id, respuesta, respondido_en)
  WHERE superseded_at IS NULL;
CREATE INDEX idx_rsvp_response_hist ON rsvp_response(invitation_id, respondido_en DESC);

CREATE OR REPLACE FUNCTION guard_rsvp_response_append_only()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'RSVP_RESPONSE_APPEND_ONLY: DELETE prohibido' USING ERRCODE = '23514';
  END IF;
  IF OLD.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'RSVP_RESPONSE_APPEND_ONLY: ya fue superseded' USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
  OR NEW.event_id IS DISTINCT FROM OLD.event_id
  OR NEW.invitation_id IS DISTINCT FROM OLD.invitation_id
  OR NEW.respuesta IS DISTINCT FROM OLD.respuesta
  OR NEW.respondido_en IS DISTINCT FROM OLD.respondido_en
  OR NEW.superseded_at IS NULL THEN
    RAISE EXCEPTION 'RSVP_RESPONSE_APPEND_ONLY: solo se permite fijar superseded_at una vez' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_rsvp_response_append_only
  BEFORE UPDATE OR DELETE ON rsvp_response
  FOR EACH ROW EXECUTE FUNCTION guard_rsvp_response_append_only();

CREATE TRIGGER trg_rsvp_response_updated_at
  BEFORE UPDATE ON rsvp_response
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 16. CheckinEvent (02b §4)
-- ============================================================================
CREATE TABLE checkin_event (
  id                       char(26) PRIMARY KEY,
  event_id                 char(26) NOT NULL REFERENCES event(id),
  invitation_id            char(26) NOT NULL REFERENCES invitation(id),
  device_id                text,
  sequence                 bigint NOT NULL CHECK (sequence > 0),
  kind                     text NOT NULL CHECK (kind IN ('admitido','anulacion','duplicado_tardio')),
  veredicto                text NOT NULL CHECK (
    veredicto IN ('admitido','ya_registrado','no_corresponde_al_evento','invitacion_revocada','no_verificable_offline','no_en_roster')
  ),
  admision_ciclo           smallint NOT NULL DEFAULT 1 CHECK (admision_ciclo > 0),
  escaneado_en             timestamptz NOT NULL,
  recibido_en              timestamptz NOT NULL DEFAULT now(),
  tardio                   boolean NOT NULL DEFAULT false,
  anula_a                  char(26) REFERENCES checkin_event(id),
  actor_id                 char(26) REFERENCES "user"(id),
  motivo                   text,
  modo                     text,
  verdict_local            text,
  resolucion_al_sincronizar text,
  vigente_checkin_id       char(26),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  deleted_at               timestamptz,
  CHECK ((kind = 'anulacion') = (anula_a IS NOT NULL)),
  CHECK (kind <> 'anulacion' OR actor_id IS NOT NULL),
  CHECK (kind <> 'anulacion' OR (motivo IS NOT NULL AND length(btrim(motivo)) BETWEEN 1 AND 280))
);

CREATE UNIQUE INDEX uq_checkin_idempotency ON checkin_event(invitation_id, device_id, sequence)
  WHERE device_id IS NOT NULL;
CREATE UNIQUE INDEX uq_checkin_admision_unica ON checkin_event(invitation_id, admision_ciclo)
  WHERE kind = 'admitido';
CREATE UNIQUE INDEX uq_checkin_anulacion_idempotente ON checkin_event(anula_a, actor_id)
  WHERE kind = 'anulacion';
CREATE INDEX idx_checkin_invitation_recibido ON checkin_event(invitation_id, recibido_en);
CREATE INDEX idx_checkin_event_recibido ON checkin_event(event_id, recibido_en);
CREATE INDEX idx_checkin_tardio ON checkin_event(event_id)
  WHERE tardio;

CREATE OR REPLACE FUNCTION guard_checkin_event_append_only()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CHECKIN_APPEND_ONLY: DELETE prohibido' USING ERRCODE = '23514';
  END IF;
  -- Única actualización permitida: anonimización NFR-08 a los 24 meses (device_id -> NULL)
  IF OLD.device_id IS NOT NULL
     AND NEW.device_id IS NULL
     AND NEW.event_id = OLD.event_id
     AND NEW.invitation_id = OLD.invitation_id
     AND NEW.sequence = OLD.sequence
     AND NEW.kind = OLD.kind
     AND NEW.veredicto = OLD.veredicto
     AND NEW.admision_ciclo = OLD.admision_ciclo THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'CHECKIN_APPEND_ONLY: la tabla checkin_event es inmutable' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_checkin_event_append_only
  BEFORE UPDATE OR DELETE ON checkin_event
  FOR EACH ROW EXECUTE FUNCTION guard_checkin_event_append_only();

-- ============================================================================
-- 17. DeviceSyncState (02b §5)
-- ============================================================================
CREATE TABLE device_sync_state (
  id                 char(26) PRIMARY KEY,
  event_id           char(26) NOT NULL REFERENCES event(id),
  device_id          text NOT NULL,
  cola_reportada     integer NOT NULL DEFAULT 0 CHECK (cola_reportada >= 0),
  ultima_seq_ackeada bigint NOT NULL DEFAULT 0 CHECK (ultima_seq_ackeada >= 0),
  seq_confirmada     bigint NOT NULL DEFAULT 0 CHECK (seq_confirmada >= 0 AND seq_confirmada <= ultima_seq_ackeada),
  heartbeat_en       timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);

CREATE UNIQUE INDEX uq_device_sync_state ON device_sync_state(event_id, device_id);
CREATE INDEX idx_device_sync_heartbeat ON device_sync_state(event_id, heartbeat_en);

CREATE TRIGGER trg_device_sync_state_updated_at
  BEFORE UPDATE ON device_sync_state
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 18. Table -> event_table (02b §6)
-- ============================================================================
CREATE TABLE event_table (
  id         char(26) PRIMARY KEY,
  event_id   char(26) NOT NULL REFERENCES event(id),
  numero     smallint NOT NULL CHECK (numero > 0),
  nombre     text,
  capacidad  smallint NOT NULL CHECK (capacidad > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX uq_event_table_numero ON event_table(event_id, numero)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_event_table_event ON event_table(event_id)
  WHERE deleted_at IS NULL;

CREATE TRIGGER trg_event_table_updated_at
  BEFORE UPDATE ON event_table
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 19. SeatAssignment (02b §7)
-- ============================================================================
CREATE TABLE seat_assignment (
  id                char(26) PRIMARY KEY,
  event_id          char(26) NOT NULL REFERENCES event(id),
  guest_id          char(26) NOT NULL REFERENCES guest(id),
  table_id          char(26) NOT NULL REFERENCES event_table(id),
  estado            text NOT NULL DEFAULT 'pendiente'
                      CHECK (estado IN ('confirmado','pendiente','liberado')),
  ocupa_capacidad   boolean NOT NULL DEFAULT false
                      CHECK (NOT ocupa_capacidad OR estado IN ('confirmado','pendiente')),
  asignado_en       timestamptz NOT NULL DEFAULT now(),
  liberado_en       timestamptz,
  motivo_liberacion text CHECK (
    motivo_liberacion IS NULL
    OR motivo_liberacion IN ('rsvp_declina','reasignado','baja_invitado','mesa_eliminada')
  ),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  CHECK ((estado = 'liberado') = (liberado_en IS NOT NULL)),
  CHECK ((estado = 'liberado') = (motivo_liberacion IS NOT NULL))
);

CREATE UNIQUE INDEX uq_seat_assignment_active ON seat_assignment(event_id, guest_id)
  WHERE estado IN ('confirmado','pendiente');
CREATE INDEX idx_seat_assignment_ocupacion ON seat_assignment(event_id, table_id)
  WHERE ocupa_capacidad;
CREATE INDEX idx_seat_assignment_liberado ON seat_assignment(event_id)
  WHERE estado = 'liberado';

CREATE TRIGGER trg_seat_assignment_updated_at
  BEFORE UPDATE ON seat_assignment
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 20. AuditEntry (02b §9)
-- ============================================================================
CREATE TABLE audit_entry (
  id         char(26) PRIMARY KEY,
  event_id   char(26) REFERENCES event(id),
  actor_id   char(26) NOT NULL REFERENCES "user"(id),
  accion     text NOT NULL CHECK (
    accion IN ('checkin_anulado','reserva_cancelada','invitado_baja','envio_disparado','asiento_movido','acceso_otorgado','evento_cerrado','worker_anonimizado')
  ),
  entidad    text NOT NULL CHECK (
    entidad IN ('checkin_event','invitation','guest','worker_reservation','event_table','seat_assignment','staff_assignment','event','event_access_token','worker_profile')
  ),
  entidad_id char(26) NOT NULL,
  motivo     text NOT NULL CHECK (length(btrim(motivo)) BETWEEN 1 AND 280),
  ts         timestamptz NOT NULL DEFAULT now(),
  detalle    jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(detalle) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX idx_audit_entry_event ON audit_entry(event_id, ts DESC);
CREATE INDEX idx_audit_entry_entidad ON audit_entry(entidad, entidad_id, ts DESC);
CREATE INDEX idx_audit_entry_actor ON audit_entry(actor_id, ts DESC);

CREATE OR REPLACE FUNCTION guard_audit_entry_immutable()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.ts <= now() - interval '24 months' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'AUDIT_INMUTABLE: audit_entry es append-only' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_entry_immutable
  BEFORE UPDATE OR DELETE ON audit_entry
  FOR EACH ROW EXECUTE FUNCTION guard_audit_entry_immutable();

-- ============================================================================
-- 21. Payment (02c §4)
-- ============================================================================
CREATE TABLE payment (
  id              char(26) PRIMARY KEY,
  reservation_id  char(26) NOT NULL REFERENCES worker_reservation(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  monto           numeric(12,2) NOT NULL CHECK (monto > 0),
  moneda          char(3) NOT NULL,
  estado_psp      text NOT NULL DEFAULT 'pendiente'
                    CHECK (estado_psp IN ('pendiente','confirmado','desconocido','fallido')),
  psp_charge_id   text,
  cobrado_en      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

CREATE UNIQUE INDEX uq_payment_reservation ON payment(reservation_id);
CREATE UNIQUE INDEX uq_payment_idempotency ON payment(idempotency_key);

CREATE OR REPLACE FUNCTION guard_payment_invariants()
RETURNS trigger AS $$
DECLARE
  v_res worker_reservation%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO v_res FROM worker_reservation WHERE id = NEW.reservation_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'NOT_FOUND: reserva % no existe', NEW.reservation_id USING ERRCODE = '23503';
    END IF;
    IF v_res.estado <> 'aceptada' THEN
      RAISE EXCEPTION 'RESERVATION_NOT_ACCEPTED: estado actual=%', v_res.estado USING ERRCODE = '23514';
    END IF;
    IF NEW.monto <> v_res.costo_congelado_monto OR NEW.moneda <> v_res.costo_congelado_moneda THEN
      RAISE EXCEPTION 'COSTO_CONGELADO_MISMATCH: monto=% moneda=%', NEW.monto, NEW.moneda USING ERRCODE = '23514';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.reservation_id IS DISTINCT FROM OLD.reservation_id
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.monto IS DISTINCT FROM OLD.monto
    OR NEW.moneda IS DISTINCT FROM OLD.moneda THEN
      RAISE EXCEPTION 'PAYMENT_INMUTABLE: no se puede alterar monto/moneda/clave de un cobro' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_payment_invariants
  BEFORE INSERT OR UPDATE ON payment
  FOR EACH ROW EXECUTE FUNCTION guard_payment_invariants();

CREATE TRIGGER trg_payment_updated_at
  BEFORE UPDATE ON payment
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 22. PaymentEntry (02c §5 - Ledger de doble entrada append-only)
-- ============================================================================
CREATE TABLE payment_entry (
  id             char(26) PRIMARY KEY,
  pago_id        char(26) NOT NULL REFERENCES payment(id),
  transaccion_id char(26) NOT NULL,
  movimiento     text NOT NULL CHECK (movimiento IN ('cobro','reverso')),
  cuenta         text NOT NULL CHECK (cuenta IN ('psp_clearing','worker_payable')),
  tipo           text NOT NULL CHECK (tipo IN ('debito','credito')),
  importe        numeric(12,2) NOT NULL CHECK ((tipo = 'debito' AND importe > 0) OR (tipo = 'credito' AND importe < 0)),
  moneda         char(3) NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  CHECK (updated_at = created_at),
  CHECK (deleted_at IS NULL)
);

CREATE INDEX idx_payment_entry_tx ON payment_entry(transaccion_id);
CREATE UNIQUE INDEX uq_payment_entry_cobro_unico ON payment_entry(pago_id)
  WHERE movimiento = 'cobro';
CREATE INDEX idx_payment_entry_pago_created ON payment_entry(pago_id, created_at);

CREATE OR REPLACE FUNCTION guard_payment_entry_immutable()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'LEDGER_INMUTABLE: payment_entry es append-only' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_payment_entry_immutable
  BEFORE UPDATE OR DELETE ON payment_entry
  FOR EACH ROW EXECUTE FUNCTION guard_payment_entry_immutable();

CREATE OR REPLACE FUNCTION assert_transaccion_balanceada()
RETURNS trigger AS $$
DECLARE
  v_count   integer;
  v_sum     numeric(14,2);
  v_cuentas integer;
  v_monedas integer;
BEGIN
  SELECT count(*), COALESCE(sum(importe), 0), count(DISTINCT cuenta), count(DISTINCT moneda)
    INTO v_count, v_sum, v_cuentas, v_monedas
    FROM payment_entry
   WHERE transaccion_id = NEW.transaccion_id;

  IF v_count <> 2 OR v_sum <> 0 OR v_cuentas <> 2 OR v_monedas <> 1 THEN
    RAISE EXCEPTION 'LEDGER_TRANSACCION_DESBALANCEADA: transaccion_id=% count=% sum=%',
      NEW.transaccion_id, v_count, v_sum
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER payment_entry_balanceado
  AFTER INSERT ON payment_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_transaccion_balanceada();

-- ============================================================================
-- Procedimiento transaccional cross-evento con pg_advisory_xact_lock (TR-08, RF-22)
-- ============================================================================
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

-- ============================================================================
-- Tablas técnicas y de soporte (02b §10, 07-system-design, RF-02, RF-19, TR-05)
-- ============================================================================

-- Read model del tablero (02b §10)
CREATE TABLE event_counters (
  event_id           char(26) PRIMARY KEY REFERENCES event(id),
  invitados          integer NOT NULL DEFAULT 0 CHECK (invitados >= 0),
  confirmados        integer NOT NULL DEFAULT 0 CHECK (confirmados >= 0),
  asistentes         integer NOT NULL DEFAULT 0 CHECK (asistentes >= 0),
  aun_no_llegaron    integer NOT NULL DEFAULT 0 CHECK (aun_no_llegaron >= 0),
  entregas_parciales integer NOT NULL DEFAULT 0 CHECK (entregas_parciales >= 0),
  ultimo_t_ingest    timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Outbox transaccional (TR-05, NFR-06)
CREATE TABLE outbox_event (
  id           char(26) PRIMARY KEY,
  event_id     char(26),
  topic        text NOT NULL CHECK (topic IN ('projection','notifications')),
  event_type   text NOT NULL,
  canal        text CHECK (canal IS NULL OR canal IN ('sms','email','ambos')),
  payload      jsonb NOT NULL DEFAULT '{}',
  t_ingest     timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_outbox_event_pending ON outbox_event(created_at)
  WHERE published_at IS NULL;

-- Deduplicación de proyecciones (TR-05)
CREATE TABLE projector_applied (
  outbox_event_id char(26) PRIMARY KEY,
  event_id        char(26) NOT NULL,
  applied_at      timestamptz NOT NULL DEFAULT now()
);

-- Registro de idempotencia HTTP (03-api.md §2)
CREATE TABLE idempotency_record (
  scope            text NOT NULL,
  idempotency_key  text NOT NULL,
  request_hash     char(64) NOT NULL,
  status_code      smallint NOT NULL,
  response_headers jsonb NOT NULL DEFAULT '{}',
  response_body    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  PRIMARY KEY (scope, idempotency_key)
);

-- Desafíos de verificación email / OTP SMS / password reset (RF-19)
CREATE TABLE verification_challenge (
  id              char(26) PRIMARY KEY,
  user_id         char(26) NOT NULL REFERENCES "user"(id),
  proposito       text NOT NULL CHECK (proposito IN ('verify_email','verify_phone_otp','verify_email_otp','password_reset')),
  canal           text NOT NULL CHECK (canal IN ('sms','email')),
  destino_hmac    char(64),
  destino_cifrado text,
  codigo_hash     char(64) NOT NULL,
  intentos      smallint NOT NULL DEFAULT 0 CHECK (intentos >= 0),
  expira_en     timestamptz NOT NULL,
  verificado_en timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_verification_challenge_hash ON verification_challenge(codigo_hash)
  WHERE proposito IN ('verify_email','password_reset');
CREATE INDEX idx_verification_challenge_user ON verification_challenge(user_id, proposito, created_at DESC);

CREATE TRIGGER trg_verification_challenge_updated_at
  BEFORE UPDATE ON verification_challenge
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Jobs de importación CSV (RF-02)
CREATE TABLE import_job (
  id                   char(26) PRIMARY KEY,
  event_id             char(26) NOT NULL REFERENCES event(id),
  s3_key               text NOT NULL,
  file_hash            char(64) NOT NULL,
  estado               text NOT NULL DEFAULT 'en_proceso'
                         CHECK (estado IN ('en_proceso','completado','fallido')),
  progreso             numeric(4,3) NOT NULL DEFAULT 0.0,
  total_filas          integer NOT NULL DEFAULT 0,
  aceptadas            integer NOT NULL DEFAULT 0,
  rechazadas           integer NOT NULL DEFAULT 0,
  duplicadas_en_archivo integer NOT NULL DEFAULT 0,
  errores              jsonb NOT NULL DEFAULT '[]',
  error_code           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_import_job_event ON import_job(event_id, created_at DESC);

CREATE TRIGGER trg_import_job_updated_at
  BEFORE UPDATE ON import_job
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Sesiones de escaneo offline (TR-19)
CREATE TABLE scan_session (
  id                 char(26) PRIMARY KEY,
  event_id           char(26) NOT NULL REFERENCES event(id),
  device_id          text NOT NULL,
  user_id            char(26) REFERENCES "user"(id),
  access_token_id    char(26) REFERENCES event_access_token(id),
  rol                text NOT NULL,
  roster_version     integer NOT NULL DEFAULT 1,
  revocation_version integer NOT NULL DEFAULT 1,
  expira_en          timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);

CREATE UNIQUE INDEX uq_scan_session_event_device ON scan_session(event_id, device_id)
  WHERE deleted_at IS NULL;

CREATE TRIGGER trg_scan_session_updated_at
  BEFORE UPDATE ON scan_session
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Ack durable de lotes de check-in (TR-01, TR-03, 03b)
CREATE TABLE checkin_batch_ack (
  id           char(26) PRIMARY KEY,
  session_id   char(26) NOT NULL REFERENCES scan_session(id),
  event_id     char(26) NOT NULL REFERENCES event(id),
  batch_id     text NOT NULL,
  request_hash char(64) NOT NULL,
  response_body jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_checkin_batch_ack ON checkin_batch_ack(session_id, batch_id);

-- Idempotencia de webhooks PSP (AC-09)
CREATE TABLE webhook_event (
  webhook_event_id text PRIMARY KEY,
  idempotency_key  text NOT NULL,
  payload          jsonb NOT NULL,
  processed_at     timestamptz NOT NULL DEFAULT now()
);

-- Alertas al planner en vivo (RF-09, AC-27)
CREATE TABLE planner_alert (
  id             char(26) PRIMARY KEY,
  event_id       char(26) NOT NULL REFERENCES event(id),
  reservation_id char(26) REFERENCES worker_reservation(id),
  tipo           text NOT NULL CHECK (tipo IN ('reserva_cancelada_en_vivo','requerimiento_sin_cubrir')),
  detalle        jsonb NOT NULL DEFAULT '{}',
  leida_en       timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_planner_alert_event ON planner_alert(event_id, created_at DESC);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version)
VALUES ('001_initial_schema.sql')
ON CONFLICT DO NOTHING;

COMMIT;
