# 03 — Entidades de contratación

Alcance: `WorkerProfile`, `AvailabilityWindow`, `WorkerReservation`, `Payment`, `PaymentEntry`. Fuente normativa: `docs/requerimientos.md` v2.1 (RF-07, RF-08, RF-09, RF-11, RF-17, RF-19, RF-21, RF-22, TR-08, TR-09, TR-20, NFR-07, NFR-08, NFR-11, AC-07, AC-22, AC-25 a AC-29, D9, D10). Este documento no agrega requisitos: traduce los existentes a esquema.

Contrato fijo aplicado a las cinco tablas:

- `id char(26)` ULID, PK.
- `created_at timestamptz` y `updated_at timestamptz` no nulos, `deleted_at timestamptz` nulo. Todo en UTC; la zona del evento solo se usa para presentación (P09).
- Dinero: `*_monto numeric(12,2)` + `*_moneda char(3)`. Nunca `float`, nunca `numeric` sin escala.
- Enums `snake_case` en columnas `text` con `CHECK (col IN (...))`: legibles en migraciones y verificables con SQL directo.
- Los identificadores y tipos de columna están en inglés; las descripciones, en español.

Referencias externas usadas y no definidas aquí: `user`, `event` (con `event.venue_id` → `venue.zona`), `event_requirement`. El catálogo cerrado de `categoria` y el de `zona` viven en tablas propias; aquí solo se referencian.

## 1. `WorkerProfile`

Perfil contratable del trabajador (RF-21, D9, D10). Es **oferta publicada**, no una vista del evento: no otorga lectura de invitados, mesas ni check-ins (§3).

| Campo | Tipo | Nulo | Default | Restricción / Índice | Descripción |
| --- | --- | --- | --- | --- | --- |
| `id` | `char(26)` | no | — | PK | ULID del perfil |
| `user_id` | `char(26)` | no | — | FK `user(id)`, UNIQUE | Cuenta que posee el perfil; una cuenta, un perfil (RF-19) |
| `tipo` | `text` | no | — | `CHECK (tipo IN ('persona','empresa'))` | D10.1 |
| `plazas_ofrecidas` | `smallint` | no | 1 | `CHECK (plazas_ofrecidas BETWEEN 1 AND 50)`; `CHECK (tipo = 'empresa' OR plazas_ofrecidas = 1)` | Capacidad del perfil; única fuente de verdad de la suma aceptada (§3, D10.1) |
| `nombre_publico` | `text` | no | — | `CHECK (length(nombre_publico) BETWEEN 1 AND 120)` | Único nombre expuesto por el directorio |
| `categorias` | `text[]` | no | — | `CHECK (cardinality(categorias) BETWEEN 1 AND 3)`; elementos contra el catálogo cerrado (trigger); índice GIN | RF-07 AND de categorías |
| `servicios` | `text[]` | no | `'{}'` | Subconjunto de `categorias` (trigger) | RF-21 |
| `tarifa_monto` | `numeric(12,2)` | sí | — | `CHECK (tarifa_monto > 0)` | Precio fijo publicado; no es presupuesto (§7) |
| `tarifa_moneda` | `char(3)` | sí | — | ISO 4217 | Moneda de la tarifa |
| `tarifa_unidad` | `text` | sí | — | `CHECK (tarifa_unidad IN ('hora','persona_hora','evento'))` | D10.2: unidad explícita |
| `zonas` | `text[]` | no | — | `CHECK (cardinality(zonas) BETWEEN 1 AND 5)`; lista cerrada; índice GIN | Cobertura declarada (RF-07, D10.3) |
| `radio_km` | `numeric(5,2)` | sí | — | `CHECK (radio_km > 0 AND radio_km <= 150)` | Opcional; solo ordena el subconjunto ya filtrado por zona |
| `idiomas` | `text[]` | no | `'{}'` | — | Lista blanca de NFR-11 |
| `anios_experiencia` | `smallint` | sí | — | `CHECK (anios_experiencia BETWEEN 0 AND 70)` | Lista blanca de NFR-11 |
| `fotos` | `text[]` | no | `'{}'` | `CHECK (cardinality(fotos) <= 3)` | Hasta 3, RF-21 |
| `referencias` | `text[]` | no | `'{}'` | `CHECK (cardinality(referencias) <= 3)` | Texto libre, RF-21 |
| `estado` | `text` | no | `'borrador'` | `CHECK (estado IN ('borrador','publicado','suspendido'))`; CHECK de publicabilidad en el invariante 3 | RF-21 |
| `telefono_e164` | `text` | sí | — | `CHECK (telefono_e164 ~ '^\+[1-9][0-9]{7,14}$')`; UNIQUE parcial (ver más abajo); cifrado en reposo | PII: nunca expuesta (NFR-07) |
| `telefono_verificado_en` | `timestamptz` | sí | — | Parte del predicado de visibilidad | OTP por SMS (RF-19) |
| `email_verificado_en` | `timestamptz` | sí | — | Parte del predicado de visibilidad | RF-19 |
| `created_at` / `updated_at` / `deleted_at` | `timestamptz` | no / no / sí | `now()` / `now()` / — | `updated_at` por trigger `set_updated_at`; `deleted_at` es predicado de visibilidad | Auditoría estándar; `updated_at` es insumo de la retención (§6) |

`eventos_completados` **no es una columna**: es derivado de reservas `completada` (RF-21) y se expone por vista. `email` no se duplica aquí: vive en `user`.

### Invariantes

1. **Tipo y plazas (D10.1).** `tipo='persona'` obliga `plazas_ofrecidas = 1`; solo `empresa` declara más de una, con techo 50 (§11). Es un `CHECK` de fila: no depende de otra tabla.
2. **Visibilidad en búsqueda (RF-07, AC-25).** Un perfil aparece en RF-07 solo si `estado = 'publicado' AND email_verificado_en IS NOT NULL AND telefono_verificado_en IS NOT NULL AND deleted_at IS NULL`. Verificar el teléfono después del alta es lo que lo hace aparecer.
3. **Publicabilidad (TR-20, RF-19).** `CHECK (estado <> 'publicado' OR (tarifa_monto IS NOT NULL AND tarifa_moneda IS NOT NULL AND tarifa_unidad IS NOT NULL AND telefono_e164 IS NOT NULL))`: no existe perfil publicado sin precio (por lo tanto no existe solicitud sin tarifa que copiar) ni publicado sin teléfono (sería inconsistente con el invariante 2).
4. **Contacto jamás expuesto (NFR-07, NFR-11).** `telefono_e164` queda fuera de toda proyección pública: la vista `worker_profile_publico` emite exactamente `worker_id, nombre_publico, categorias, tarifa_*, zonas, idiomas, anios_experiencia, eventos_completados` y es la única con `GRANT SELECT` al rol de aplicación del directorio. Contacto solo se desbloquea por reserva `aceptada`.
5. **Un teléfono verificado, un perfil (RF-19).** Índice único parcial sobre `telefono_e164` con `WHERE telefono_verificado_en IS NOT NULL AND deleted_at IS NULL`.
6. **No es actor de evento (§3).** Ninguna FK de este esquema apunta desde `event` a `worker_profile` para efectos de lectura: el perfil no habilita roster ni check-in; eso es `StaffAssignment`.

### Índices

| Índice | Justificación |
| --- | --- |
| `UNIQUE (user_id)` | Un perfil por cuenta; sostiene la consola del trabajador (RF-17) |
| `UNIQUE (telefono_e164) WHERE telefono_verificado_en IS NOT NULL AND deleted_at IS NULL` | RF-19: un teléfono verificado respalda un solo perfil |
| `GIN (categorias)` | RF-07 filtra por categorías con AND; sin GIN el catálogo cruzado es un seq scan |
| `GIN (zonas)` | RF-07 filtra por cobertura de zona; mismo motivo |
| `BTREE (tarifa_monto, id) WHERE estado = 'publicado' AND email_verificado_en IS NOT NULL AND telefono_verificado_en IS NOT NULL AND deleted_at IS NULL` | Índice parcial que sirve a la vez el filtro de visibilidad, el rango de costo y el desempate `worker_id ↑` de RF-07 |

El resto de RF-07 (excluir a quien tiene una reserva `aceptada` solapada) **no** es un índice de esta tabla: es un anti-join contra `worker_reservation`, resuelto por el índice GIST de §3.

**Respaldo:** RF-07, RF-19, RF-21, RF-22 · TR-20 · NFR-07, NFR-11 · AC-25, AC-26, AC-28 · D9, D10.

## 2. `AvailabilityWindow`

Disponibilidad **declarada** por el trabajador (RF-22). Es la oferta; `WorkerReservation` es la ocupación. Ninguna sustituye a la otra (§3). Sin ventana declarada el perfil **no es contratable**: no existe "disponible por defecto".

| Campo | Tipo | Nulo | Default | Restricción / Índice | Descripción |
| --- | --- | --- | --- | --- | --- |
| `id` | `char(26)` | no | — | PK | ULID de la ventana |
| `worker_id` | `char(26)` | no | — | FK `worker_profile(id)` | Dueño de la oferta |
| `inicio` | `timestamptz` | no | — | `CHECK (fin > inicio)` | Inicio del intervalo `[inicio, fin)` |
| `fin` | `timestamptz` | no | — | ver arriba | Fin exclusivo |
| `zona` | `text` | no | — | Lista cerrada de zonas | Zona ofrecida; insumo de RF-07, **no** condición de contención |
| `rol` | `text` | no | — | Catálogo cerrado de roles | Rol ofrecido; la contención de RF-22 exige el mismo rol |
| `created_at` / `updated_at` / `deleted_at` | `timestamptz` | no / no / sí | `now()` / `now()` / — | `updated_at` por trigger `set_updated_at`; `deleted_at` excluye la ventana de toda contención | Auditoría estándar; `deleted_at` retira la oferta |

### Invariantes

1. **Intervalos semiabiertos.** Toda ventana se interpreta como `[inicio, fin)`, igual que la reserva; así una reserva que termina a las 18:00 y otra que empieza a las 18:00 no se solapan. Se materializa como `tstzrange(inicio, fin, '[)')`.
2. **Contención como precondición de aceptación (RF-22, AC-22).** PostgreSQL **no puede** declarar un `CHECK`/FK de contención contra otra tabla ni contra otra fila, así que se verifica dentro de la transacción de aceptación, antes de cambiar estado:

```sql
IF NOT EXISTS (
  SELECT 1 FROM availability_window w
   WHERE w.worker_id = $worker_id
     AND w.rol      = $rol
     AND w.deleted_at IS NULL
     AND tstzrange(w.inicio, w.fin, '[)') @> tstzrange($inicio, $fin, '[)')
) THEN
  RAISE EXCEPTION 'RESERVA_FUERA_DE_DISPONIBILIDAD' USING ERRCODE = '23514';
END IF;
```

   El error es determinista y **no cambia el estado** de la reserva (AC-22). La zona de la ventana no participa: RF-22 exige contención temporal y mismo rol; la zona solo alimenta el filtro de lugares de RF-07.
3. **Oferta, no ocupación.** Una ventana declarada no bloquea nada por sí misma; dos ventanas solapadas del mismo perfil son legales (ampliar cobertura es idempotente por naturaleza, no un conflicto).

### Índices

| Índice | Justificación |
| --- | --- |
| `GIST (worker_id, tstzrange(inicio, fin, '[)'))` con `btree_gist` | Responde la contención de RF-22 en una sola búsqueda acotada al trabajador; sin él la aceptación recorre todas sus ventanas |
| `BTREE (worker_id, inicio, fin) WHERE deleted_at IS NULL` | Listado de la consola del trabajador y orden cronológico |

**Respaldo:** RF-07, RF-22 · NFR-11 (excepción 1, solo `{worker_id, ventana_ocupada}`) · AC-22, AC-27 · D9.

## 3. `WorkerReservation`

Única fuente de verdad de la ocupación de un trabajador (§3). Cross-evento por construcción: la clave del invariante es `(worker_id, ventana)`, nunca `event_id` (TR-08).

| Campo | Tipo | Nulo | Default | Restricción / Índice | Descripción |
| --- | --- | --- | --- | --- | --- |
| `id` | `char(26)` | no | — | PK | ULID de la reserva; se nombra en el conflicto de RF-17 |
| `worker_id` | `char(26)` | no | — | FK `worker_profile(id)` | Agregado de concurrencia |
| `event_id` | `char(26)` | no | — | FK `event(id)` | Ownership y aislamiento (NFR-11) |
| `rol` | `text` | no | — | Catálogo cerrado de roles | Rol solicitado (RF-08) |
| `inicio` | `timestamptz` | no | — | `CHECK (fin > inicio)` | Inicio de la ventana `[inicio, fin)` |
| `fin` | `timestamptz` | no | — | ver arriba | Fin exclusivo |
| `hora_llegada` | `timestamptz` | no | — | `CHECK (hora_llegada >= inicio AND hora_llegada < fin)` | Obligatoria (RF-08); alimenta el recordatorio de llegada (RF-10) |
| `plazas` | `smallint` | no | 1 | `CHECK (plazas BETWEEN 1 AND 50)` | Plazas pedidas; se reduce si la aceptación es parcial (RF-08, D10.1) |
| `estado` | `text` | no | `'solicitada'` | `CHECK (estado IN ('solicitada','aceptada','rechazada','expirada','cancelada','cancelada_pagada','sin_cubrir','completada'))` | Máquina de estados de RF-08 |
| `costo_congelado_monto` | `numeric(12,2)` | no | — | `CHECK (costo_congelado_monto > 0)`; inmutable (trigger) | Snapshot de `tarifa_monto` al solicitar (TR-20) |
| `costo_congelado_moneda` | `char(3)` | no | — | inmutable (trigger) | Snapshot de `tarifa_moneda` |
| `costo_congelado_unidad` | `text` | no | — | `CHECK (costo_congelado_unidad IN ('hora','persona_hora','evento'))`; inmutable | Snapshot de `tarifa_unidad`: sin la unidad el monto no es interpretable |
| `expira_en` | `timestamptz` | no | — | `CHECK (expira_en > created_at)`; índice parcial | Plazo de RF-17: `min(48 h, fin − ahora)`, o 15 min en `modo_emergencia` (§11) |
| `created_at` / `updated_at` / `deleted_at` | `timestamptz` | no / no / sí | `now()` / `now()` / — | `updated_at` cambia en cada transición; `deleted_at` excluye la fila de la suma de plazas | Auditoría estándar; `deleted_at` es baja lógica y **no** cancela |

Las tres columnas `costo_congelado_*` son el campo único `costo_congelado` del contrato, desdoblado en monto + moneda + unidad porque el contrato de dinero lo exige.

### Invariantes

1. **Snapshot inmutable (TR-20, AC-26).** Un trigger `BEFORE UPDATE` rechaza cualquier cambio en `costo_congelado_monto`, `costo_congelado_moneda`, `costo_congelado_unidad`, `worker_id`, `event_id`, `inicio` y `fin`. Cambiar la tarifa del perfil no reescribe ninguna reserva; el pago solo lee este snapshot.
2. **Solo `aceptada` ocupa (RF-08, TR-08).** `solicitada` no bloquea: N solicitudes pueden solaparse y la aceptación es la que serializa. `rechazada`, `expirada`, `cancelada` y `sin_cubrir` liberan de inmediato; cancelar no espera a que pase `fin`.
3. **`fin` pasado no bloquea (RF-08).** El predicado de solapamiento es `tstzrange(inicio, fin, '[)') && tstzrange($inicio, $fin, '[)')`: una reserva cuyo `fin` precede al `inicio` solicitado no solapa por definición, así que no hace falta ninguna condición temporal extra en la suma.
4. **`completada` la fija el cierre del evento (RF-15, AC-29).** La transacción de cierre actualiza en bloque `estado = 'completada'` para toda reserva `aceptada` de ese evento. Nadie la marca a mano; `eventos_completados` (§1) sale de contar estas filas.
5. **Aceptación parcial (RF-08, AC-07).** El trabajador `empresa` puede aceptar menos plazas de las pedidas: la misma transacción reduce `plazas` y libera la diferencia. Esa reducción es parte del agregado y toma el mismo lock (invariante 6).
6. **Suma cross-evento acotada (RF-08, TR-08, AC-07).** La suma de `plazas` de reservas `aceptada` solapadas de un mismo perfil, **en cualquier evento**, nunca excede `plazas_ofrecidas`. **PostgreSQL no puede expresarlo de forma declarativa**: una restricción de exclusión evalúa fila a fila rangos de una misma tabla y no sabe sumar columnas de filas solapadas, y `plazas_ofrecidas` vive en `worker_profile`.

   - *(A) Forma declarativa: expansión por plaza.* Una fila por plaza reservada hace el invariante expresable sin lógica de aplicación:

```sql
ALTER TABLE worker_reservation_slot
  ADD CONSTRAINT slot_unico_aceptado
  EXCLUDE USING gist (worker_id WITH =, plaza_idx WITH =, tstzrange(inicio, fin, '[)') WITH &&)
  WHERE (estado = 'aceptada');
```

   Cuesta una tabla fuera del modelo de §3 y una máquina de estados repartida en N filas (cancelar una plaza escribe N filas, y `completada` de RF-15 se propaga fila a fila). Se documenta porque es la única variante declarativa; **no** es la adoptada.
   - *(B) Forma adoptada: compare-and-set serializado sobre el agregado `(worker_id, ventana)`*, sin `read-then-write` (TR-08):

```sql
-- El lock es por trabajador, nunca por evento: la clave es cross-evento.
SELECT pg_advisory_xact_lock(hashtextextended($worker_id::text, 0));
SELECT plazas_ofrecidas INTO l_cap FROM worker_profile WHERE id = $worker_id;
SELECT COALESCE(sum(plazas), 0) INTO l_ocupadas
  FROM worker_reservation
 WHERE worker_id = $worker_id AND estado = 'aceptada'   -- 'solicitada' no participa
   AND deleted_at IS NULL
   AND tstzrange(inicio, fin, '[)') && tstzrange($inicio, $fin, '[)');
l_aceptables := least($plazas_pedidas, l_cap - l_ocupadas);
IF l_aceptables > 0 THEN
  UPDATE worker_reservation             -- aceptación total o parcial (D10.1)
     SET estado = 'aceptada', plazas = l_aceptables
   WHERE id = $reserva_id AND estado = 'solicitada';
ELSE
  RAISE EXCEPTION 'RESERVA_CONFLICTO ganadora=%', l_ganadora_id  -- RF-17, AC-07
    USING ERRCODE = '23505';
END IF;
```

   Reglas de la estrategia: (i) todo camino que **agrega** plazas aceptadas (aceptar, reabrir tras cancelación) y toda **reducción** por aceptación parcial toman el mismo `pg_advisory_xact_lock` —`SELECT ... FROM worker_profile WHERE id = $worker_id FOR UPDATE` es equivalente—; (ii) cancelar y rechazar solo liberan, por lo que pueden ejecutarse sin el lock pero lo toman igual para no leer un agregado en movimiento; (iii) el conflicto nombra la reserva ganadora y deja la perdedora en `solicitada`, sin borrarla (RF-17); (iv) el replay de una aceptación es idempotente por la guarda `estado = 'solicitada'` del `UPDATE`: no crea una segunda reserva (AC-07); (v) no se serializa por evento y no hace falta columna de versión: el CAS es sobre la suma, la forma más fuerte que TR-08 admite para N > 1.

### Índices

| Índice | Justificación |
| --- | --- |
| `GIST (worker_id, tstzrange(inicio, fin, '[)'))` con `btree_gist` | Sirve la suma de plazas solapadas del invariante 6, el anti-join de exclusión de RF-07 y el conflicto de RF-09/AC-27 con la misma estructura |
| `BTREE (worker_id) WHERE estado = 'aceptada'` | Reduce el agregado a las filas que realmente ocupan; con `plazas_ofrecidas = 1` es casi siempre 0–2 filas |
| `BTREE (event_id, rol, estado)` | Cobertura de requerimientos (RF-22), tablero de solicitudes del planner (RF-17) y cierre en bloque (AC-29) |
| `BTREE (expira_en) WHERE estado = 'solicitada'` | Job de expiración a 48 h / 15 min (RF-17, §11); índice parcial porque solo las `solicitada` expiran |

**Respaldo:** RF-07, RF-08, RF-09, RF-15, RF-17, RF-22 · TR-08, TR-20 · NFR-11 · AC-07, AC-22, AC-26, AC-27, AC-29 · D2, D7, D9, D10.

## 4. `Payment`

Cobro contra una reserva `aceptada` (RF-11, D1, D5). El esquema se construye ahora aunque la integración sea *nice-to-have*: lo que D5 difiere es el adaptador, no el ledger.

| Campo | Tipo | Nulo | Default | Restricción / Índice | Descripción |
| --- | --- | --- | --- | --- | --- |
| `id` | `char(26)` | no | — | PK | ULID del cobro |
| `reservation_id` | `char(26)` | no | — | FK `worker_reservation(id)`, **UNIQUE** | Cardinalidad 1:1 con la reserva (RF-11, §3) |
| `idempotency_key` | `text` | no | — | **UNIQUE**; `CHECK (length BETWEEN 16 AND 128)` | Acuñada una sola vez y persistida **antes** de llamar al PSP; reintentar la reusa, nunca la incrementa (TR-09) |
| `monto` | `numeric(12,2)` | no | — | `CHECK (monto > 0)`; igualdad con `costo_congelado_monto` (trigger) | AC-26: el cobro es exactamente el precio congelado |
| `moneda` | `char(3)` | no | — | Igualdad con `costo_congelado_moneda` (trigger) | Moneda del cobro |
| `cobrado_en` | `timestamptz` | sí | — | — | Instante del cobro confirmado por el PSP; nulo mientras no haya resultado |
| `created_at` / `updated_at` / `deleted_at` | `timestamptz` | no / no / sí | `now()` / `now()` / — | — | Auditoría estándar |

### Invariantes

1. **1:1 con reserva `aceptada` (RF-11).** `UNIQUE (reservation_id)`; la creación verifica dentro de la transacción que la reserva esté en `aceptada` y no en `cancelada_pagada`. Un cobro por reserva es además el motivo de que `cancelada_pagada` sea estado de la reserva y no del pago.
2. **Idempotencia compartida (TR-09).** `UNIQUE (idempotency_key)`: 3 reintentos más 5 solicitudes concurrentes del mismo cobro producen un solo `Payment` (AC-08). La clave es el `id` de la reserva o un `payment_attempt_id` inmutable; reenviar el webhook reusa la misma clave (AC-09).
3. **Monto no negociable (TR-20, AC-26).** Un trigger de inserción copia y contrasta `monto`/`moneda` contra `costo_congelado_*` de la reserva; un cambio posterior de tarifa no afecta el cobro.

### Índices

| Índice | Justificación |
| --- | --- |
| `UNIQUE (reservation_id)` | 1:1 de RF-11 y base de la idempotencia por reserva |
| `UNIQUE (idempotency_key)` | Conciliación y consulta al PSP "por clave" antes de reintentar (TR-09, AC-09) |

**Respaldo:** RF-11 · TR-09, TR-14 · AC-08, AC-09, AC-26 · §3, §7.2, D1, D5.

## 5. `PaymentEntry`

Ledger de doble entrada, **append-only e inmutable** (§3, RF-11, TR-09). Un cobro genera **exactamente una transacción con dos líneas balanceadas** (suma 0). Un reverso es una transacción **nueva**, nunca una edición.

| Campo | Tipo | Nulo | Default | Restricción / Índice | Descripción |
| --- | --- | --- | --- | --- | --- |
| `id` | `char(26)` | no | — | PK | ULID de la línea |
| `pago_id` | `char(26)` | no | — | FK `payment(id)` | Cobro al que pertenece |
| `transaccion_id` | `char(26)` | no | — | Índice `(transaccion_id)`; agrupa el asiento | Agrupa las dos líneas de un mismo asiento |
| `movimiento` | `text` | no | — | `CHECK (movimiento IN ('cobro','reverso'))` | `reverso` = transacción compensatoria (RF-11) |
| `cuenta` | `text` | no | — | `CHECK (cuenta IN ('psp_clearing','worker_payable'))` | Cuenta contable; las dos están definidas abajo |
| `tipo` | `text` | no | — | `CHECK (tipo IN ('debito','credito'))` | Signo contable |
| `importe` | `numeric(12,2)` | no | — | `CHECK ((tipo = 'debito' AND importe > 0) OR (tipo = 'credito' AND importe < 0))` | Importe **con signo**: el balance por transacción es `sum(importe) = 0` |
| `moneda` | `char(3)` | no | — | Una sola moneda por `transaccion_id` (trigger diferido) | Moneda del asiento |
| `created_at` | `timestamptz` | no | `now()` | — | Inserción; no existe otra escritura |
| `updated_at` | `timestamptz` | no | `now()` | `CHECK (updated_at = created_at)` | Nunca se actualiza |
| `deleted_at` | `timestamptz` | sí | — | `CHECK (deleted_at IS NULL)` | El ledger no se borra lógicamente |

**Cuentas.** `psp_clearing` — **activo**: el efectivo cobrado que vive en el PSP en modo test y que la plataforma aún no dispersa (D1: sin dispersión real). `worker_payable` — **pasivo**: lo que la plataforma le debe al trabajador por la reserva cobrada. Un `cobro` de X se registra como **débito `psp_clearing` +X** y **crédito `worker_payable` −X**: suma 0, y el pasivo con el trabajador queda visible por agregación. Un `reverso` invierte los signos en una `transaccion_id` nueva.

### Invariantes

1. **Dos líneas balanceadas (RF-11, AC-08).** No es expresable con `CHECK` de fila: el balance es una propiedad del conjunto de líneas de una transacción. Se impone con un constraint trigger diferido:

```sql
CREATE CONSTRAINT TRIGGER payment_entry_balanceado
  AFTER INSERT ON payment_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_transaccion_balanceada();
-- assert_transaccion_balanceada() sobre NEW.transaccion_id:
--   count(*) = 2 AND sum(importe) = 0
--   AND count(DISTINCT cuenta) = 2 AND count(DISTINCT moneda) = 1
```
   Al ser diferido, las dos líneas se pueden insertar en cualquier orden dentro de la misma transacción y el invariante se verifica en el commit; una transacción a medias aborta completa.
2. **Un cobro, una transacción.** Índice único parcial `UNIQUE (pago_id) WHERE movimiento = 'cobro'`: reintentos y webhooks reenviados no crean una segunda transacción de cobro (AC-08, AC-09).
3. **Append-only (TR-09, §3).** `REVOKE UPDATE, DELETE` para el rol de aplicación más un trigger `BEFORE UPDATE OR DELETE` que lanza `EXCEPTION 'LEDGER_INMUTABLE'`. No hay estado que corregir por edición: el reverso es una fila nueva.
4. **Sin PII.** El ledger no almacena nombre, teléfono ni email del trabajador; conserva solo el `worker_id` vía `pago_id → reservation_id`, lo que permite la retención de 24 meses de NFR-08 sin conflicto con el borrado de PII.

### Índices

| Índice | Justificación |
| --- | --- |
| `(transaccion_id)` | Verificación diferida de balance y lectura del asiento completo en conciliación |
| `UNIQUE (pago_id) WHERE movimiento = 'cobro'` | "Exactamente una" transacción de cobro por cobro (AC-08) |
| `(pago_id, created_at)` | Historial de cobro + reverso de un mismo pago (RF-11, AC-09) |

**Respaldo:** RF-11 · TR-09, TR-14 · NFR-08 · AC-08, AC-09 · D1, D5.

## 6. Retención y borrado (NFR-08, AC-18, AC-28)

1. **`WorkerProfile`: PII fuera del ciclo del evento, 12 meses tras la última actividad.** El perfil **no** se borra al cerrar el evento (alcance partido de NFR-08, AC-28). Última actividad = `GREATEST(worker_profile.updated_at, max(worker_reservation.updated_at))`, calculada por el job, sin columna nueva. Al vencer: anonimización en sitio —`telefono_e164 = NULL`, `telefono_verificado_en = NULL`, `fotos = '{}'`, `referencias = '{}'`—; el perfil, sus agregados y sus reservas sobreviven. Efecto lateral obligado: el perfil deja de cumplir el invariante 2 de §1 y sale silenciosamente de la búsqueda de RF-07.
2. **`Payment` y `PaymentEntry`: 24 meses.** El ledger se conserva 24 meses (§11) y se purga por `created_at` de la transacción; no contiene PII, así que la purga no colisiona con ningún derecho de borrado. Reverso y cobro caen por la misma ventana.
3. **`WorkerReservation` y `AvailabilityWindow`:** no guardan PII del invitado ni del trabajador (solo `worker_id` y `event_id`). Las reservas se retienen mientras exista la cuenta, porque `eventos_completados` (§1) es derivado de ellas y AC-29 lo exige exacto. Las ventanas caducadas (`fin < now()`) son prescindibles y no participan en ninguna contención.

## Resumen de riesgos

- El invariante central (suma de plazas cross-evento) **no es declarativo**: su corrección depende de que todo camino de escritura tome el `pg_advisory_xact_lock` del agregado. Un camino nuevo que lo omita rompe AC-07 sin que la base lo detecte; el lock además serializa por trabajador y es el punto caliente de RF-09 en vivo.
- La exclusión de RF-07 ("excluye a quien tiene una `aceptada` solapada") es un anti-join con predicado vivo, no un índice: no puede precalcularse ni cachearse agresivamente, y explica el riesgo de `worker_search_zero_results` (NFR-09) cuando el catálogo está muy ocupado.
- La anonimización por retención (§6.1) saca al trabajador de la búsqueda sin cambiar `estado`; sin señal visible para el trabajador, el efecto se confunde con una suspensión. Requiere evento de auditoría o notificación fuera de este esquema.
- `Payment` no tiene estado enumerado: el spec no define la máquina de estados del PSP (AC-09 habla de "estado final" y TR-09 de "resultado desconocido"), así que solo se modela `cobrado_en`. Formalizarla después obliga a migrar filas ya existentes.
- La contención de RF-22 se valida contra `availability_window` en la aceptación, pero **nada impide retirar después** la ventana que autorizó la reserva: una reserva `aceptada` puede quedar huérfana de disponibilidad declarada. RF-22 no define ese caso.
