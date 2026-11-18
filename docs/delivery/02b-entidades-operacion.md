# 02 — Entidades de operación: staff, entregas, RSVP, check-in, mesas, recordatorios y auditoría

Alcance: `StaffAssignment`, `InvitationDelivery`, `RsvpResponse`, `CheckinEvent`, `DeviceSyncState`, `Table`, `SeatAssignment`, `ReminderJob`, `AuditEntry`. Fuente normativa: `docs/requerimientos.md` v2.1 (§2, §3, §5). Este documento no agrega requisitos: traduce los existentes a esquema.

Contrato fijo aplicado a las nueve tablas:

- `id char(26)` ULID, PK. Enums en columnas `text` con `CHECK (col IN (...))`, valores `snake_case` listados literalmente.
- Toda tabla lleva `created_at` / `updated_at` `timestamptz` no nulos (`now()`, `updated_at` por trigger `set_updated_at`) y `deleted_at timestamptz` nulo. En las tablas append-only (`CheckinEvent`, `AuditEntry`) ninguna ruta de escritura fija `updated_at` ni `deleted_at`.
- Toda tabla de alcance de evento lleva `event_id` (TR-16): `staff_assignment`, `invitation_delivery`, `rsvp_response`, `checkin_event`, `device_sync_state`, `event_table`, `seat_assignment`, `reminder_job`.
- Timestamps en **UTC** (`timestamptz`): `escaneado_en` es reloj de dispositivo y solo traza; la convergencia y los cortes usan reloj de servidor (TR-17, NFR-03).

Referencias externas, fuera de este alcance: `User`, `Event`, `Guest`, `Invitation` (`01-entidades-core.md`); `WorkerReservation` (`03-entidades-contratacion.md`); superficies de scan y anulación (`05-api-trabajador-scan.md`).

## 1. `StaffAssignment`
| Campo | Tipo | Nulo | Default | Restricción / Índice | Descripción |
| --- | --- | --- | --- | --- | --- |
| `id` | `char(26)` | no | — | PK | ULID de la asignación |
| `event_id` | `char(26)` | no | — | FK `event(id)`; UNIQUE parcial | Evento habilitado y ningún otro (§1 D3.2) |
| `user_id` | `char(26)` | no | — | FK `user(id)`; BTREE parcial | Trabajador o staff habilitado (RF-19) |
| `permisos` | `text[]` | no | `ARRAY['roster','checkin']` | `CHECK (cardinality(permisos) >= 1 AND permisos <@ ARRAY['roster','checkin','anulacion'])` | Solo roster y check-ins de su evento (NFR-11); `anulacion` habilita RF-14 |
| `otorgado_por_user_id` | `char(26)` | no | — | FK `user(id)` | Miembro que lo otorga (autorizado contra `event_membership`) |
| `expira_en` | `timestamptz` | no | — | `CHECK (expira_en > created_at)`; BTREE parcial | Fijado a `event.ventana_fin` y forzado a `now()` al cerrar o cancelar (§1 D3.6, RF-15) |
| `created_at` / `updated_at` / `deleted_at` | `timestamptz` | no / no / sí | `now()` / `now()` / — | `deleted_at` revoca de inmediato | Auditoría estándar |

**Invariantes:** 1) Es la **única** fuente del permiso de escanear: un `worker` contratado sin fila aquí no puede abrir sesión de escaneo, aunque tenga `EventAccessToken` (§1 D3.2, D9). 2) Alcance mínimo: habilita roster y check-ins de **su** evento y nada más (NFR-11, AC-15). 3) `expira_en ≤ event.ventana_fin` al otorgar (no declarable con `CHECK`: se valida en la transacción) y el cierre o la cancelación del evento la expiran en bloque (RF-15). 4) `deleted_at` revoca sin borrar y se evalúa por request, así que la revocación no espera a que caduque la sesión. 5) No otorga edición del evento: eso es `event_membership` (§3, NFR-11).
**Índices:** `UNIQUE (event_id, user_id) WHERE deleted_at IS NULL` (una habilitación vigente y reotorgamiento idempotente) · `BTREE (user_id) WHERE deleted_at IS NULL` (resolución de "qué eventos puedo escanear" al abrir sesión, TR-19) · `BTREE (expira_en) WHERE deleted_at IS NULL` (job de expiración en bloque).
**Respaldo:** §1 D3.2, D7, D9 · §3 · RF-13, RF-14, RF-19 · TR-19 · NFR-11 · AC-15.

## 2. `InvitationDelivery`
| Campo | Tipo | Nulo | Default | Restricción / Índice | Descripción |
| --- | --- | --- | --- | --- | --- |
| `id` | `char(26)` | no | — | PK | ULID de la entrega |
| `event_id` | `char(26)` | no | — | FK `event(id)`; BTREE parcial | Aislamiento y partición (TR-16, NFR-11) |
| `invitation_id` | `char(26)` | no | — | FK `invitation(id)`; BTREE `(invitation_id, canal)` | Invitación entregada (RF-03, RF-16) |
| `reminder_job_id` | `char(26)` | sí | — | FK `reminder_job(id)`; BTREE parcial | Nulo en el envío de RF-16; con valor, es el recordatorio de RF-10 (§3) |
| `destinatario` | `text` | no | — | UNIQUE parcial con `(plantilla, ventana)` | Clave canónica por trigger: `<sujeto_id>:<sha256(dirección normalizada)>:<canal>`; sin PII en claro (TR-12, NFR-07) |
| `direccion_cifrada` | `text` | no | — | Cifrado en reposo | Dirección real a la que se envía; se borra a los 12 meses del cierre (NFR-08) |
| `canal` | `text` | no | — | `CHECK (canal IN ('sms','email'))` | Un estado por canal: si uno falla, el otro basta (RF-04) |
| `plantilla` | `text` | no | — | `CHECK (plantilla IN ('invitacion','recordatorio_rsvp','recordatorio_llegada'))` | Parte 2 de la clave de TR-12 |
| `ventana` | `text` | no | — | `CHECK (ventana IN ('envio_inicial','resend_1','resend_2','t_7d','t_1d','t_24h','t_2h'))` | Parte 3 de la clave: offset declarado, inmutable por job; el reenvío es `resend_n` explícito (RF-16, TR-12) |
| `estado` | `text` | no | `'encolado'` | `CHECK (estado IN ('encolado','entregado','rebotado','indeterminado'))` | `encolado → entregado \| rebotado \| indeterminado` (RF-04) |
| `intentos` | `smallint` | no | 0 | `CHECK (intentos BETWEEN 0 AND 3)` | Reintento = el **mismo** job; agotado pasa a `rebotado` sin recrearse (RF-04) |
| `estado_en` | `timestamptz` | no | `now()` | — | Instante del último estado; fija `indeterminado` a los 15 min sin respuesta (RF-04) |
| `created_at` / `updated_at` / `deleted_at` | `timestamptz` | no / no / sí | `now()` / `now()` / — | `deleted_at` = borrado de NFR-08 | Auditoría estándar |

**Invariantes:** 1) **Dedupe estricto**: `(destinatario, plantilla, ventana)` produce exactamente una entrega, aun con dos solicitudes concurrentes (TR-12, AC-13, AC-21). 2) Un estado por canal y destinatario: nunca un estado por invitación; el tablero expone `entregas_parciales` cuando un canal falla y el otro no (RF-04, RF-06). 3) `rebotado` es terminal para esa clave: no se recrea la entrega salvo reenvío explícito con `ventana = resend_n` (RF-04, RF-16). 4) Un job consumido no se reprograma y un cambio de RSVP no reactiva jobs cancelados (RF-10, AC-12). 5) La baja del invitado cancela los jobs pendientes y no marca como enviado lo que no salió (RF-20, NFR-08, AC-24). 6) La PII del destinatario se borra a los 12 meses del cierre; la fila y sus contadores sobreviven como agregado (NFR-08, AC-18).
**Índices:** `UNIQUE (destinatario, plantilla, ventana)` (dedupe de TR-12) · `BTREE (invitation_id, canal)` (estado por invitación en el tablero) · `BTREE (event_id, estado) WHERE estado IN ('encolado','indeterminado')` (entregas parciales y barrido de `indeterminado`) · `BTREE (reminder_job_id) WHERE reminder_job_id IS NOT NULL` (rebote medido por recordatorio, §3).
**Respaldo:** RF-04, RF-06, RF-10, RF-16, RF-20 · TR-12 · NFR-07, NFR-08 · AC-12, AC-13, AC-21, AC-24.

## 3. `RsvpResponse`
| Campo | Tipo | Nulo | Default | Restricción / Índice | Descripción |
| --- | --- | --- | --- | --- | --- |
| `id` | `char(26)` | no | — | PK | ULID de la respuesta |
| `event_id` | `char(26)` | no | — | FK `event(id)`; BTREE parcial | Aislamiento por evento (TR-16, NFR-11) |
| `invitation_id` | `char(26)` | no | — | FK `invitation(id)`; UNIQUE parcial | Invitación respondida; el token usado es el de RSVP, nunca el del QR (RF-05, TR-07) |
| `respuesta` | `text` | no | — | `CHECK (respuesta IN ('confirma','declina'))` | Única decisión posible (RF-18) |
| `respondido_en` | `timestamptz` | no | `now()` | — | Instante del POST; es lo que ordena "la última gana" (RF-05) |
| `superseded_at` | `timestamptz` | sí | — | `CHECK (superseded_at IS NULL OR superseded_at > respondido_en)`; índice parcial | Marca de la respuesta reemplazada; es la **única** mutación admitida (RF-05) |
| `created_at` / `updated_at` / `deleted_at` | `timestamptz` | no / no / sí | `now()` / `now()` / — | `updated_at` solo por el `superseded_at` | Auditoría estándar |

**Invariantes:** 1) Una sola respuesta vigente por invitación: el índice único parcial es el que la impone, así que dos POST concurrentes con tokens distintos dejan una vigente y una `superseded_at` (RF-05, AC-23). 2) Append-only: el hecho no se edita ni se borra; solo se fija `superseded_at` una vez (`NULL → valor`, por trigger, rechazando el segundo intento), y no hay requisito de historial consultable (RF-05). 3) `declina` vigente libera el `SeatAssignment` y devuelve capacidad a la mesa (RF-12, AC-14); volver a `confirma` no la devuelve automáticamente: el invitado queda `sin_mesa` accionable. 4) Confirmar cancela el recordatorio pendiente por la clave de TR-12 y un cambio posterior no lo reactiva (RF-10, AC-12). 5) El estado nunca se sirve por un GET cacheable (NFR-02, AC-23). 6) La respuesta sobrevive a la baja del invitado y a la retención, sin PII (RF-20, NFR-08).
**Índices:** `UNIQUE (invitation_id) WHERE superseded_at IS NULL` (una vigente) · `BTREE (event_id, respuesta, respondido_en) WHERE superseded_at IS NULL` (contadores `confirmados` del tablero) · `BTREE (invitation_id, respondido_en DESC)` (lectura del histórico de la invitación).
**Respaldo:** RF-05, RF-10, RF-12, RF-18, RF-20 · TR-07 · NFR-01b, NFR-02, NFR-08 · AC-12, AC-14, AC-23, AC-24.

## 4. `CheckinEvent`
| Campo | Tipo | Nulo | Default | Restricción / Índice | Descripción |
| --- | --- | --- | --- | --- | --- |
| `id` | `char(26)` | no | — | PK | ULID del hecho de check-in (`checkin_id`) |
| `event_id` | `char(26)` | no | — | FK `event(id)`; BTREE `(event_id, recibido_en)` | Primera clave de la partición de ingesta (TR-04, TR-16) |
| `invitation_id` | `char(26)` | no | — | FK `invitation(id)`; BTREE `(invitation_id, recibido_en)` | El check-in nunca crea invitado (§3, RF-13) |
| `device_id` | `text` | sí | — | Nulo solo por anonimización; índice parcial | Dispositivo/sesión que escaneó; obligatorio al escribir, eliminado a los 24 meses (TR-03, NFR-08) |
| `sequence` | `bigint` | no | — | `CHECK (sequence > 0)` | Secuencia monotónica por dispositivo (TR-03) |
| `kind` | `text` | no | — | `CHECK (kind IN ('admitido','anulacion','duplicado_tardio'))` | Los únicos tres tipos de fila del log (TR-01, RF-14) |
| `veredicto` | `text` | no | — | `CHECK (veredicto IN ('admitido','ya_registrado','no_corresponde_al_evento','invitacion_revocada','no_verificable_offline','no_en_roster'))` | Veredicto de RF-13; `duplicado_tardio` siempre `ya_registrado` (TR-17) |
| `admision_ciclo` | `smallint` | no | 1 | `CHECK (admision_ciclo > 0)`; UNIQUE parcial | Ciclo de admisión de la invitación: solo avanza al registrar una anulación (RF-14) |
| `escaneado_en` | `timestamptz` | no | — | — | Reloj del dispositivo: trazabilidad; **nunca** decide la convergencia |
| `recibido_en` | `timestamptz` | no | `now()` | — | Reloj del servidor: define la admisión ganadora (TR-17) |
| `tardio` | `boolean` | no | `false` | `BTREE (event_id) WHERE tardio` | Escaneado dentro de la ventana y sincronizado tras el cierre (RF-15, AC-17) |
| `anula_a` | `char(26)` | sí | — | FK `checkin_event(id)`; `CHECK ((kind = 'anulacion') = (anula_a IS NOT NULL))` | Check-in compensado (RF-14) |
| `actor_id` | `char(26)` | sí | — | FK `user(id)`; obligatorio si `kind = 'anulacion'` | Trabajador autorizado que anula (`permisos` con `anulacion`) |
| `motivo` | `text` | sí | — | `CHECK (kind <> 'anulacion' OR length(btrim(motivo)) BETWEEN 1 AND 280)` | Motivo obligatorio de la anulación (RF-14) |
| `created_at` / `updated_at` / `deleted_at` | `timestamptz` | no / no / sí | `now()` / `now()` / — | Ninguna ruta escribe `updated_at` ni `deleted_at` | Auditoría estándar; la tabla es append-only |

**Invariantes:** 1) Append-only: `INSERT` es la única escritura; anular es una fila compensatoria `kind = 'anulacion'` con `anula_a`, nunca `UPDATE` ni `DELETE` (TR-01, RF-14). 2) Idempotencia por `(invitation_id, device_id, sequence)`: el replay es un no-op que devuelve el mismo veredicto y no crea fila (TR-01, AC-03). 3) Convergencia cross-dispositivo por `recibido_en` **del servidor**: la primera fila durable gana y las demás se escriben `kind = 'duplicado_tardio'` con `ya_registrado`, contadas aparte (TR-17, AC-05). 4) **Una admisión vigente por invitación en todo el sistema**, no por dispositivo: `(invitation_id, admision_ciclo)` es único entre las filas `admitido`, y el ciclo solo avanza al anular; así anular habilita una nueva admisión y `anulado` nunca se confunde con `ya_registrado` (RF-13, RF-14, AC-16). 5) La anulación es idempotente por `(checkin_id, actor_id)` — en la fila, `(anula_a, actor_id)` — y solo se admite con evento abierto o dentro de la ventana de corrección (`CORRECTION_WINDOW_CLOSED`, §11). 6) Lo escaneado dentro de la ventana se acepta aunque llegue tras el cierre, marcado `tardio`; solo se rechaza lo escaneado fuera de la ventana (RF-15, AC-17). 7) NFR-08 conserva a los 24 meses solo `(event_id, sequence, veredicto)` y anonimiza `device_id` (AC-18); por eso la columna es nula y el índice de idempotencia es parcial.
**Índices:** `UNIQUE (invitation_id, device_id, sequence) WHERE device_id IS NOT NULL` (idempotencia de TR-01) · `UNIQUE (invitation_id, admision_ciclo) WHERE kind = 'admitido'` (**una admisión por invitación a nivel sistema**) · `UNIQUE (anula_a, actor_id) WHERE kind = 'anulacion'` (idempotencia de la anulación) · `BTREE (invitation_id, recibido_en)` (resolución de convergencia, TR-17) · `BTREE (event_id, recibido_en)` (consolidado, tablero y contadores) · `BTREE (event_id) WHERE tardio` (marcados tardios de AC-17).
**Respaldo:** §3 · RF-13, RF-14, RF-15 · TR-01, TR-03, TR-04, TR-16, TR-17 · NFR-06, NFR-08 · AC-01, AC-03, AC-05, AC-06, AC-16, AC-17, AC-18.

## 5. `DeviceSyncState`
| Campo | Tipo | Nulo | Default | Restricción / Índice | Descripción |
| --- | --- | --- | --- | --- | --- |
| `id` | `char(26)` | no | — | PK | ULID del estado |
| `event_id` | `char(26)` | no | — | FK `event(id)`; UNIQUE parcial | La sesión de escaneo es de un evento (TR-19, TR-16) |
| `device_id` | `text` | no | — | UNIQUE parcial con `event_id` | Dispositivo; se identifica con la sesión canjeada del QR de acceso (TR-19) |
| `cola_reportada` | `integer` | no | 0 | `CHECK (cola_reportada >= 0)` | Escaneos que el dispositivo declara en cola durable (TR-02) |
| `ultima_seq_ackeada` | `bigint` | no | 0 | `CHECK (ultima_seq_ackeada >= 0)` | Mayor secuencia confirmada por el servidor a ese dispositivo (TR-03) |
| `seq_confirmada` | `bigint` | no | 0 | `CHECK (seq_confirmada <= ultima_seq_ackeada)` | Secuencia que el dispositivo ya drenó; entra en la fórmula de TR-18 |
| `heartbeat_en` | `timestamptz` | no | `now()` | Índice parcial con `event_id` | Último latido; sin heartbeat en 5 min el valor es `desconocido` (TR-18) |
| `created_at` / `updated_at` / `deleted_at` | `timestamptz` | no / no / sí | `now()` / `now()` / — | `updated_at` por upsert | Auditoría estándar |

**Invariantes:** 1) Una fila por `(event_id, device_id)`: `PUT /sync-state` es upsert idempotente, nunca acumula filas (TR-18). 2) `pendientes` **no es columna**: el tablero lo deriva como `Σ cola_reportada − (Σ ultima_seq_ackeada − Σ seq_confirmada)` con piso 0, y lo expone como `pendientes_sincronizar` (RF-06, NFR-03). 3) Sin heartbeat en 5 min el valor se marca `desconocido`, **nunca 0** (TR-18, `04` §2.6). 4) `pendientes` alimenta además `offline_queue_depth` con alerta sobre 500 o sin drenar 30 min (NFR-09). 5) El dispositivo no es global: el mismo `device_id` en otro evento es otra fila y no mezcla secuencias (TR-19). 6) Solo lecturas de tablero y diagnóstico: no participa en la convergencia de `CheckinEvent` (TR-17).
**Índices:** `UNIQUE (event_id, device_id)` (upsert idempotente) · `BTREE (event_id, heartbeat_en)` (derivación de `pendientes` por evento y detección de dispositivos mudos).
**Respaldo:** TR-18, TR-19, TR-02, TR-03 · RF-06 · NFR-03, NFR-09 · AC-04.

## 6. `Table`
| Campo | Tipo | Nulo | Default | Restricción / Índice | Descripción |
| --- | --- | --- | --- | --- | --- |
| `id` | `char(26)` | no | — | PK | ULID de la mesa (tabla física `event_table`) |
| `event_id` | `char(26)` | no | — | FK `event(id)`; UNIQUE parcial con `numero` | La mesa pertenece a un solo evento (TR-16, NFR-11) |
| `numero` | `smallint` | no | — | `CHECK (numero > 0)` | Etiqueta visible del plano de mesas (RF-12) |
| `capacidad` | `smallint` | no | — | `CHECK (capacidad > 0)` | Techo de ocupación; la suma de asientos que ocupan nunca lo supera (RF-12, AC-14) |
| `created_at` / `updated_at` / `deleted_at` | `timestamptz` | no / no / sí | `now()` / `now()` / — | `deleted_at` solo con 0 asientos ocupando | Auditoría estándar |

**Invariantes:** 1) `Σ` de asientos con `ocupa_capacidad` de la mesa ≤ `capacidad`, verificado **dentro** de la transacción de asignación: 50 asignaciones concurrentes sobre capacidad 40 dejan 40 aceptadas y 10 con conflicto (TR-10, AC-14). 2) `capacidad` no se reduce por debajo de la ocupación vigente (validado en la misma transacción). 3) La mesa no cruza eventos: dos eventos pueden tener `numero = 1` y son mesas distintas (NFR-11). 4) Borrar exige 0 asientos que ocupen capacidad; nunca borra ni mueve invitados por sí solo (RF-12). 5) Un invitado sin fila en `seat_assignment` está `sin_mesa` y aparece en la lista accionable; el import no crea ni borra asientos (RF-12).
**Índices:** `UNIQUE (event_id, numero) WHERE deleted_at IS NULL` (numeración única y reutilización tras baja) · `BTREE (event_id) WHERE deleted_at IS NULL` (plano de mesas y conteo de ocupación).
**Respaldo:** RF-12 · TR-10, TR-16 · NFR-11 · AC-14.

## 7. `SeatAssignment`
| Campo | Tipo | Nulo | Default | Restricción / Índice | Descripción |
| --- | --- | --- | --- | --- | --- |
| `id` | `char(26)` | no | — | PK | ULID del asiento |
| `event_id` | `char(26)` | no | — | FK `event(id)`; BTREE parcial | Partición y aislamiento del seating (TR-16, NFR-11) |
| `guest_id` | `char(26)` | no | — | FK `guest(id)`; UNIQUE parcial con `event_id` | Invitado sentado; debe ser del mismo evento (validado en transacción) |
| `table_id` | `char(26)` | no | — | FK `event_table(id)`; BTREE parcial | Mesa asignada; se conserva aunque el asiento pase a `liberado`, para el historial |
| `estado` | `text` | no | `'pendiente'` | `CHECK (estado IN ('confirmado','pendiente','liberado'))` | Ciclo de vida del asiento: `pendiente → confirmado`, y `liberado` al declinar o reasignar (RF-12) |
| `ocupa_capacidad` | `boolean` | no | `false` | `CHECK (NOT ocupa_capacidad OR estado IN ('confirmado','pendiente'))`; BTREE parcial | Solo `confirmado` y `pendiente` pueden ocupar; el default de política cuenta solo `confirmado` (RF-12) |
| `asignado_en` | `timestamptz` | no | `now()` | — | Instante de la asignación vigente |
| `liberado_en` | `timestamptz` | sí | — | `CHECK ((estado = 'liberado') = (liberado_en IS NOT NULL))` | Instante en que devolvió la capacidad (RF-12, AC-14) |
| `motivo_liberacion` | `text` | sí | — | `CHECK (motivo_liberacion IN ('rsvp_declina','reasignado','baja_invitado','mesa_eliminada'))` | Causa de la liberación, obligatoria con `estado = 'liberado'` |
| `created_at` / `updated_at` / `deleted_at` | `timestamptz` | no / no / sí | `now()` / `now()` / — | Nunca se borra la fila | Auditoría estándar; el historial se conserva |

**Invariantes:** 1) Un solo asiento vigente por invitado: `UNIQUE (event_id, guest_id) WHERE estado IN ('confirmado','pendiente')`; mover a otra mesa es idempotente por `(evento, invitado, mesa)` y no duplica filas (TR-10, AC-14). 2) Ocupación: solo `confirmado` y `pendiente` pueden llevar `ocupa_capacidad = true`, y la suma por mesa nunca supera `event_table.capacidad` (RF-12, AC-14). 3) `liberado` devuelve capacidad y **conserva** la fila con `liberado_en` y `motivo_liberacion`; nunca se borra el historial (RF-12). 4) Si el RSVP vigente queda en `declina`, el asiento pasa a `liberado` con `motivo_liberacion = 'rsvp_declina'` y devuelve la capacidad (RF-05, RF-12, AC-14). 5) El import **nunca** crea ni borra asientos: un invitado creado o reactivado queda `sin_mesa` —ausencia de fila— y se expone como lista accionable (RF-12). 6) La baja del invitado libera su asiento sin borrarlo (RF-20, AC-24).
**Índices:** `UNIQUE (event_id, guest_id) WHERE estado IN ('confirmado','pendiente')` (un asiento vigente e idempotencia de TR-10) · `BTREE (event_id, table_id) WHERE ocupa_capacidad` (conteo de ocupación dentro de la transacción) · `BTREE (event_id) WHERE estado = 'liberado'` (historial por mesa/evento).
**Respaldo:** RF-05, RF-12, RF-20 · TR-10, TR-16 · NFR-11 · AC-14, AC-24.

## 8. `ReminderJob`
| Campo | Tipo | Nulo | Default | Restricción / Índice | Descripción |
| --- | --- | --- | --- | --- | --- |
| `id` | `char(26)` | no | — | PK | ULID del job |
| `event_id` | `char(26)` | no | — | FK `event(id)`; BTREE `(event_id, guest_id)` | Evento del recordatorio; reprogramar la fecha reescribe este job (TR-12) |
| `guest_id` | `char(26)` | sí | — | FK `guest(id)`; `CHECK` de sujeto exclusivo | Sujeto cuando el recordatorio es de RSVP al invitado (RF-10) |
| `worker_reservation_id` | `char(26)` | sí | — | FK `worker_reservation(id)`; `CHECK` de sujeto exclusivo | Sujeto cuando el recordatorio es de hora de llegada al trabajador (RF-08, RF-10) |
| `destinatario` | `text` | no | — | UNIQUE parcial con `(plantilla, ventana)` | Parte 1 de la clave TR-12: `<sujeto_id>:<sha256(dirección normalizada)>:<canal>`, sin PII en claro (NFR-07) |
| `plantilla` | `text` | no | — | `CHECK (plantilla IN ('recordatorio_rsvp','recordatorio_llegada'))` | Parte 2 de la clave: el envío de la invitación no es un recordatorio (RF-16) |
| `ventana` | `text` | no | — | `CHECK (ventana IN ('t_7d','t_1d','t_24h','t_2h'))` | Parte 3: offset declarado e **inmutable** por job; defaults T-7 d y T-1 d (RSVP) y T-24 h y T-2 h (llegada), configurables (§11) |
| `disparar_en` | `timestamptz` | no | — | `BTREE (estado, disparar_en)` parcial | Disparo calculado en la `timezone` del evento; mover la fecha lo **reescribe**, no crea job nuevo (TR-12, P09) |
| `estado` | `text` | no | `'programado'` | `CHECK (estado IN ('programado','cancelado','consumido'))` | `cancelado` y `consumido` son terminales (RF-10) |
| `motivo_cancelacion` | `text` | sí | — | `CHECK (motivo_cancelacion IN ('rsvp_registrado','reserva_cancelada','invitado_de_baja','destinatario_inexistente'))`; obligatorio si `estado = 'cancelado'` | Cancelación por clave de TR-12 (RF-10, RF-20, NFR-08) |
| `created_at` / `updated_at` / `deleted_at` | `timestamptz` | no / no / sí | `now()` / `now()` / — | `deleted_at` = borrado de NFR-08 | Auditoría estándar |

**Invariantes:** 1) Dedupe por `(destinatario, plantilla, ventana)`: un solo job por clave, con las mismas tres partes que `InvitationDelivery` (TR-12, AC-13). 2) La clave de sujeto es exclusiva: `CHECK ((guest_id IS NOT NULL) <> (worker_reservation_id IS NOT NULL))`. 3) `ventana` es inmutable: reprogramar la fecha del evento reescribe `disparar_en` del **mismo** job, nunca crea otro (TR-12). 4) Se cancela por clave si el RSVP vigente ya está registrado o si la reserva se canceló; `consumido` no se reprograma y un cambio de respuesta no reactiva un job cancelado (RF-10, AC-12). 5) Un job cuyo destinatario ya no existe se cancela con `destinatario_inexistente` y **no** se marca como enviado (NFR-08, RF-20, AC-24). 6) El rebote de un recordatorio se mide con el estado por canal de su `InvitationDelivery`, no con un estado propio (§3, RF-04).
**Índices:** `UNIQUE (destinatario, plantilla, ventana)` (dedupe de TR-12) · `BTREE (estado, disparar_en) WHERE estado = 'programado'` (disparo y barrido de cancelación) · `BTREE (event_id, guest_id)` (cancelación por RSVP y baja) · `BTREE (worker_reservation_id) WHERE worker_reservation_id IS NOT NULL` (cancelación por reserva cancelada).
**Respaldo:** RF-04, RF-08, RF-10, RF-16, RF-20 · TR-12 · NFR-07, NFR-08 · AC-12, AC-13, AC-24 · §3 · §11.

## 9. `AuditEntry`
| Campo | Tipo | Nulo | Default | Restricción / Índice | Descripción |
| --- | --- | --- | --- | --- | --- |
| `id` | `char(26)` | no | — | PK | ULID de la entrada |
| `event_id` | `char(26)` | sí | — | FK `event(id)`; BTREE `(event_id, ts)` | Nulo solo en acciones fuera de un evento; con valor, aísla por evento (NFR-11) |
| `actor_id` | `char(26)` | no | — | FK `user(id)`; BTREE `(actor_id, ts)` | Obligatorio: ninguna acción queda sin responsable (RF-14) |
| `accion` | `text` | no | — | `CHECK (accion IN ('checkin_anulado','reserva_cancelada','invitado_baja','envio_disparado','asiento_movido','acceso_otorgado','evento_cerrado'))` | Hecho auditado, en `snake_case` literal |
| `entidad` | `text` | no | — | `CHECK (entidad IN ('checkin_event','invitation','guest','worker_reservation','event_table','seat_assignment','staff_assignment','event','event_access_token'))` | Tabla afectada (nombre lógico) |
| `entidad_id` | `char(26)` | no | — | BTREE `(entidad, entidad_id, ts)` | ULID de la fila afectada |
| `motivo` | `text` | no | — | `CHECK (length(btrim(motivo)) BETWEEN 1 AND 280)` | Explicación legible obligatoria; es el `motivo` que RF-14 exige al anular |
| `ts` | `timestamptz` | no | `now()` | — | Reloj del **servidor** en UTC; nunca el del dispositivo (TR-17, NFR-03) |
| `detalle` | `jsonb` | no | `'{}'` | `CHECK (jsonb_typeof(detalle) = 'object')` | Contexto acotado (estado previo/nuevo, ids); **nunca** PII, tokens ni direcciones (NFR-07) |
| `created_at` / `updated_at` / `deleted_at` | `timestamptz` | no / no / sí | `now()` / `now()` / — | Ninguna ruta escribe `updated_at` ni `deleted_at` | Auditoría estándar; la tabla es append-only |

**Invariantes:** 1) Inmutable: sin `UPDATE` ni `DELETE`; una corrección es una fila nueva que referencia el mismo `entidad_id` (§3). 2) `actor_id`, `ts` y `motivo` son obligatorios en toda fila: una anulación de check-in sin responsable y razón no existe (RF-14, AC-16). 3) `ts` es del servidor: el orden de la auditoría no depende de relojes de dispositivo (TR-17). 4) `detalle` nunca contiene PII, tokens ni direcciones, y no se cifra como PII porque no la lleva (NFR-07). 5) Retención de 24 meses por NFR-08; el borrado no usa `deleted_at` en operación normal (AC-18). 6) Escribir auditoría no sustituye la escritura del hecho: la fila del hecho y su `AuditEntry` se confirman en la misma transacción.
**Índices:** `BTREE (event_id, ts DESC)` (línea de tiempo del evento) · `BTREE (entidad, entidad_id, ts DESC)` (historial de una fila concreta) · `BTREE (actor_id, ts DESC)` (auditoría por trabajador).
**Respaldo:** RF-14, RF-20 · NFR-07, NFR-08 · TR-17 · AC-16, AC-18, AC-24 · §3.

## 10. Proyección de lectura: `event_counters` (Read Model)

> **Nota de modelado:** `event_counters` **no es una 23ª entidad de dominio**, sino la tabla técnica de proyección (*read model*) dentro de Aurora/RDS PostgreSQL que materializa los contadores del tablero exigidos por `TR-05`, `TR-13`, `NFR-03` y `NFR-10`. Su presencia en PostgreSQL evita `COUNT(*)` en vivo sobre `checkin_event` y elimina la necesidad de mantener DynamoDB o Redis.

| Campo | Tipo | Nulo | Default | Restricción / Índice | Descripción |
| --- | --- | --- | --- | --- | --- |
| `event_id` | `char(26)` | no | — | PK, FK `event(id)` | Evento proyectado (TR-13, TR-16) |
| `invitados` | `integer` | no | 0 | `CHECK (invitados >= 0)` | Invitados activos del evento |
| `confirmados` | `integer` | no | 0 | `CHECK (confirmados >= 0)` | Respuestas RSVP vigentes en `confirma` (RF-05, RF-06) |
| `asistentes` | `integer` | no | 0 | `CHECK (asistentes >= 0)` | Admisiones vigentes (`admitido` menos `anulacion`, RF-06, RF-14) |
| `aun_no_llegaron` | `integer` | no | 0 | `CHECK (aun_no_llegaron >= 0)` | Derivado/proyectado como `GREATEST(invitados - asistentes, 0)` (RF-06) |
| `entregas_parciales` | `integer` | no | 0 | `CHECK (entregas_parciales >= 0)` | Invitaciones con entrega exitosa en un canal y fallo/indeterminado en el otro (RF-04, RF-06) |
| `ultimo_t_ingest` | `timestamptz` | sí | — | — | Último `t_ingest` confirmado de servidor que alimentó la fila (NFR-03) |
| `updated_at` | `timestamptz` | no | `now()` | — | Instante de actualización en el read model (`t_visible`) |

**Invariantes:** 1) Mantenida únicamente por la Lambda `projector` consumiendo la cola SQS `projection` con ventana de coalescing de 1 s (`TR-05`) y deduplicación por `outbox_event_id` / `checkin_id`. 2) Totalmente reconstruible a partir de `guest`, `rsvp_response`, `invitation_delivery` y `checkin_event` (`TR-05`, `NFR-06`). 3) El tablero (`GET /v1/dashboard?limit≤25`) consulta por PK `WHERE event_id = ANY($member_event_ids)` en `< 5 ms`, cumpliendo `NFR-03` (≤ 5 s p95) y `NFR-10` (≤ 2 s p95).
**Respaldo:** RF-06, RF-14 · TR-05, TR-13 · NFR-03, NFR-10 · AC-10, AC-16.

