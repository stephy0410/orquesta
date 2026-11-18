# 01 — Entidades core: identidad, evento, invitado e invitación

Alcance: `User`, `EventMembership`, `Venue`, `Event`, `EventRequirement`, `Guest`, `Invitation`, `EventAccessToken`. Fuente normativa: `docs/requerimientos.md` v2.1 (§1, §2 RF-01/02/03/16/18/19/20, §3, §4, §13 D3/D7/D9/D10). Este documento no agrega requisitos: traduce los existentes a esquema.

Contrato fijo aplicado a las ocho tablas:

- `id char(26)` ULID, PK. Enums en columnas `text` con `CHECK (col IN (...))`, valores `snake_case` listados literalmente.
- Toda tabla lleva `created_at` / `updated_at` `timestamptz` no nulos (`now()`, `updated_at` por trigger `set_updated_at`) y `deleted_at timestamptz` nulo: baja lógica, nunca `DELETE` físico.
- Toda tabla de alcance de evento lleva `event_id` (TR-16): `event_membership`, `event_requirement`, `guest`, `invitation`, `event_access_token`.
- Timestamps en **UTC** (`timestamptz`); `event.timezone` es la zona de presentación y de cálculo de ventanas (P09), nunca la del servidor.
- PII (email, teléfono) cifrada en reposo (NFR-07); ninguna tabla de este documento la expone fuera de su evento (NFR-11).

Referencias externas, fuera de este alcance: `StaffAssignment` (permiso de escaneo, §3), `InvitationDelivery`, `RsvpResponse`, `CheckinEvent`, `DeviceSyncState` (`05-api-trabajador-scan.md`), `worker_profile` / `worker_reservation` (`03-entidades-contratacion.md`).

## 1. `User`

Cuenta de planner y de trabajador (D3 ampliada por D7/D9). **El invitado no tiene cuenta** (§1, RF-19): se identifica solo con el token de su invitación.

| Campo | Tipo | Nulo | Default | Restricción / Índice | Descripción |
| --- | --- | --- | --- | --- | --- |
| `id` | `char(26)` | no | — | PK | ULID del usuario |
| `email` | `text` | no | — | `CHECK (email = lower(btrim(email)))`; UNIQUE; cifrado en reposo | Login, verificación y recuperación (RF-19); PII (NFR-07) |
| `roles` | `text[]` | no | — | `CHECK (cardinality(roles) >= 1 AND roles <@ ARRAY['planner','worker'])`; GIN | `User{id, email, roles[]}` de §1; **no existe el rol `guest`** |
| `password_hash` | `text` | no | — | `CHECK (length(password_hash) >= 40)` | Hash con sal (argon2id); nunca se proyecta en una respuesta |
| `email_verificado_en` | `timestamptz` | sí | — | Predicado de sesión (RF-19) | Nulo ⇒ login responde `EMAIL_NOT_VERIFIED` |
| `created_at` / `updated_at` / `deleted_at` | `timestamptz` | no / no / sí | `now()` / `now()` / — | `updated_at` por trigger `set_updated_at` | Auditoría estándar; `deleted_at` impide autenticar |

**Invariantes:** 1) `roles ⊆ {planner, worker}`: un invitado no se registra nunca, ni público ni por invitación (§1 D3.3, RF-19). 2) Un email normalizado es una sola cuenta (RF-19); un teléfono verificado respalda un solo `worker_profile` (`03` §1). 3) Sin `email_verificado_en` no hay sesión (RF-19). 4) Ser `planner` no otorga acceso a ningún evento: eso es `EventMembership` (NFR-11).
**Índices:** `UNIQUE (email)` (login y `EMAIL_YA_REGISTRADA`) · `GIN (roles)` (derivación de actor en autorregistro y consolas).
**Respaldo:** §1 (D3, D7, D9) · RF-19 · NFR-07, NFR-11 · AC-25.

## 2. `EventMembership`

Única fuente de verdad de quién lee y edita un evento (§3, NFR-11). Ser `planner` del sistema **no** da acceso a un evento ajeno.

| Campo | Tipo | Nulo | Default | Restricción / Índice | Descripción |
| --- | --- | --- | --- | --- | --- |
| `id` | `char(26)` | no | — | PK | ULID de la membresía |
| `event_id` | `char(26)` | no | — | FK `event(id)`; UNIQUE `(event_id, user_id)` | Evento del que se es miembro (TR-16) |
| `user_id` | `char(26)` | no | — | FK `user(id)`; índice parcial | Miembro; `owner` o colega `editor` |
| `rol` | `text` | no | `'owner'` | `CHECK (rol IN ('owner','editor'))` | Rol de §3: `owner` / `editor` |
| `created_at` / `updated_at` / `deleted_at` | `timestamptz` | no / no / sí | `now()` / `now()` / — | `deleted_at` revoca sin borrar el evento | Auditoría estándar |

**Invariantes:** 1) Todo acceso —tablero, roster, seating, requerimientos, trabajadores— se autoriza por esta tabla, no por `event.planner_id` (§3, §10, TR-13): un no-miembro recibe `404` (`04` §1). 2) Un `owner` vigente por evento; crear el evento hace `owner` al creador y las transiciones reservadas al dueño (`publish`, `start`, `cancel`, `close`) se autorizan contra esa fila (L6/P10, `04` §2). 3) `editor` escribe evento, invitados, seating y requerimientos, pero no cambia ownership ni las transiciones de dueño (L6, P10). 4) `deleted_at` revoca la membresía y conserva el evento y su historial (NFR-08).
**Índices:** `UNIQUE (event_id, user_id)` (dedupe de membresías y autorización por evento) · `UNIQUE (event_id) WHERE rol = 'owner' AND deleted_at IS NULL` (un dueño) · `BTREE (user_id) WHERE deleted_at IS NULL` (tablero del planner, RF-06/NFR-10).
**Respaldo:** §3, §1 D3.4 · NFR-11, TR-13 · RF-01 (creación del evento) · AC-15, AC-20 · L6/D8-P10.

## 3. `Venue`

Dato del evento, no un catálogo (RF-01, §7.5). `Venue{id, nombre, zona, direccion}`: sin aforo, sin disponibilidad y sin reserva.

| Campo | Tipo | Nulo | Default | Restricción / Índice | Descripción |
| --- | --- | --- | --- | --- | --- |
| `id` | `char(26)` | no | — | PK | ULID del venue |
| `nombre` | `text` | no | — | `CHECK (length(btrim(nombre)) BETWEEN 1 AND 120)` | Nombre del lugar (RF-01) |
| `zona` | `text` | no | — | Elemento de la lista cerrada de zonas (trigger); BTREE | La zona se cruza contra las `zonas[]` del perfil en RF-07 |
| `direccion` | `text` | no | — | `CHECK (length(btrim(direccion)) BETWEEN 1 AND 240)` | Se muestra al trabajador contratado y en la página pública (RF-18) |
| `created_at` / `updated_at` / `deleted_at` | `timestamptz` | no / no / sí | `now()` / `now()` / — | `deleted_at` impide referenciarlo desde un evento nuevo | Auditoría estándar |

**Invariantes:** 1) `Venue` no tiene estado, aforo ni calendario: el aforo vive en `event.aforo` y no hay reserva de venue en el MVP (§7.5, RF-01). 2) `zona` pertenece a la misma lista cerrada que usan RF-07 y RF-21; es la única columna del venue que participa en una búsqueda de trabajadores. 3) Un venue se reutiliza entre eventos del mismo planner y no otorga lectura de otros eventos (NFR-11).
**Índices:** `BTREE (zona)` (cruce venue → zonas declaradas de RF-07) · PK `(id)` para las lecturas del evento y de la página pública.
**Respaldo:** RF-01, RF-07, RF-18 · §7.5 · NFR-11 · AC-20.

## 4. `Event`

Unidad de partición, de ownership y de corte (TR-16, RF-01). **No tiene `planner_id`**: el dueño se deriva de `EventMembership` con `rol = 'owner'`.

| Campo | Tipo | Nulo | Default | Restricción / Índice | Descripción |
| --- | --- | --- | --- | --- | --- |
| `id` | `char(26)` | no | — | PK | ULID del evento; prefijo de partición de ingesta (TR-04, TR-16) |
| `venue_id` | `char(26)` | no | — | FK `venue(id)`; BTREE | Lugar del evento (RF-01) |
| `nombre` | `text` | no | — | `CHECK (length(btrim(nombre)) BETWEEN 1 AND 160)` | Obligatorio (RF-01, AC-20) |
| `fecha` | `date` | no | — | — | Fecha local del evento, interpretada en `timezone` (P09) |
| `timezone` | `text` | no | — | IANA obligatoria; validada por trigger contra `pg_timezone_names` (un `CHECK` no admite subconsulta) | RF-01, P09: sin zona las ventanas y recordatorios se calculan mal |
| `ventana_inicio` | `timestamptz` | no | — | `CHECK (ventana_fin > ventana_inicio)` | Inicio de `[ventana_inicio, ventana_fin)`: ingesta, corte y expiración de accesos |
| `ventana_fin` | `timestamptz` | no | — | ver arriba | Fin exclusivo; cota de `event_access_token.expira_en` |
| `aforo` | `integer` | no | — | `CHECK (aforo > 0)` | Límite **duro**: el import rechaza con `AFORO_EXCEDIDO` (RF-01, RF-02) |
| `estado` | `text` | no | `'borrador'` | `CHECK (estado IN ('borrador','publicado','en_curso','cerrado','cancelado'))`; transiciones por trigger | P11: `borrador → publicado → en_curso → cerrado`, más `cancelado` |
| `cerrado_en` | `timestamptz` | sí | — | `CHECK ((estado = 'cerrado') = (cerrado_en IS NOT NULL))` | Instante del corte del consolidado (RF-15) |
| `created_at` / `updated_at` / `deleted_at` | `timestamptz` | no / no / sí | `now()` / `now()` / — | `updated_at` por trigger | `deleted_at` no sustituye a `cancelado` |

**Invariantes:** 1) Ownership solo por `EventMembership`: `planner_id` de §1 D3.4 quedó derogado por §10 y L6/P10, y no existe como columna. 2) Solo `publicado` y `en_curso` aceptan envíos y check-in; `cerrado` es de solo lectura pero **no rechaza** lotes con `escaneado_en` dentro de la ventana, marcados `tardio` (RF-01, RF-15, AC-17). 3) `count(guest)` del evento ≤ `aforo`, verificado dentro de la transacción del import (RF-02, AC-20); la baja lógica **no** libera aforo (RF-20, AC-24). 4) Fecha, ventana y recordatorios se calculan en `timezone`; el servidor guarda UTC (P09). 5) Cancelar conserva el evento y su consolidado; el borrado físico/anonimizado es de NFR-08, no de `deleted_at`.
**Índices:** `BTREE (estado, ventana_inicio)` (eventos activos del tablero, RF-06/NFR-10) · `BTREE (venue_id)` (FK y lectura del lugar) · `BTREE (fecha)` (orden cronológico por planner).
**Respaldo:** RF-01, RF-02, RF-15, RF-16, RF-20 · TR-04, TR-16 · NFR-10, NFR-11 · AC-17, AC-20, AC-21, AC-24 · P09, P11, L6/P10.

## 5. `EventRequirement`

Requerimiento de personal declarado por el planner (RF-22): `{rol, cantidad}` por evento. Es la demanda que la cobertura contrasta contra reservas.

| Campo | Tipo | Nulo | Default | Restricción / Índice | Descripción |
| --- | --- | --- | --- | --- | --- |
| `id` | `char(26)` | no | — | PK | ULID del requerimiento |
| `event_id` | `char(26)` | no | — | FK `event(id)`; UNIQUE `(event_id, rol)` | Evento que demanda (TR-16, NFR-11) |
| `rol` | `text` | no | — | Elemento del catálogo cerrado de roles (trigger) | Rol demandado; el mismo catálogo de `worker_reservation.rol` |
| `cantidad` | `smallint` | no | — | `CHECK (cantidad > 0)` | Personas requeridas para el rol (RF-22) |
| `created_at` / `updated_at` / `deleted_at` | `timestamptz` | no / no / sí | `now()` / `now()` / — | — | Auditoría estándar |

**Invariantes:** 1) Un requerimiento por `(evento, rol)`: el `PUT` de RF-22 reemplaza el set, no acumula duplicados (`05` §1). 2) Cobertura = `Σ worker_reservation.plazas` con `estado = 'aceptada'`, `event_id` y `rol` iguales; el requerimiento está cubierto si esa suma ≥ `cantidad` (RF-22, AC-27). 3) `cubiertos` / `pendientes` / `sin_cubrir` son derivados: **no** son columnas, y `sin_cubrir` exige además ausencia de candidato (RF-09, AC-27). 4) El requerimiento no bloquea la aceptación: la contención de `AvailabilityWindow` es por `(worker, ventana, rol)` (RF-22).
**Índices:** `UNIQUE (event_id, rol)` (reemplazo idempotente del set y lectura de cobertura por rol).
**Respaldo:** RF-22, RF-09 · NFR-11 · AC-22, AC-27 · §3.

## 6. `Guest`

Invitado de un evento, sin cuenta (RF-02, RF-19). Clave de negocio dentro del evento: email normalizado **o** teléfono E.164.

| Campo | Tipo | Nulo | Default | Restricción / Índice | Descripción |
| --- | --- | --- | --- | --- | --- |
| `id` | `char(26)` | no | — | PK | ULID del invitado |
| `event_id` | `char(26)` | no | — | FK `event(id)`; BTREE parcial | Aislamiento y partición (TR-16, NFR-11) |
| `nombre` | `text` | no | — | `CHECK (length(btrim(nombre)) BETWEEN 1 AND 120)` | Único campo que imprime el fallback de RF-13 |
| `email_normalizado` | `text` | sí | — | `CHECK (email_normalizado = lower(btrim(email_normalizado)))`; UNIQUE parcial; cifrado en reposo | Clave de negocio (RF-02, NFR-07) |
| `telefono_e164` | `text` | sí | — | `CHECK (telefono_e164 ~ '^\+[1-9][0-9]{7,14}$')`; UNIQUE parcial; cifrado en reposo | Clave de negocio (RF-02, NFR-07) |
| `estado_envio` | `text` | no | `'pendiente_envio'` | `CHECK (estado_envio IN ('pendiente_envio','enviado'))` | El import deja `pendiente_envio` y **no envía** (RF-02, RF-16); los estados por canal de RF-04 viven en `InvitationDelivery` |
| `created_at` / `updated_at` / `deleted_at` | `timestamptz` | no / no / sí | `now()` / `now()` / — | `deleted_at` = baja lógica de RF-20 | Baja: revoca tokens, cancela jobs, conserva historial y **no** libera aforo |

**Invariantes:** 1) `CHECK (email_normalizado IS NOT NULL OR telefono_e164 IS NOT NULL)`: sin clave la fila se rechaza con `GUEST_SIN_CLAVE` (RF-02). 2) Los índices únicos `(event_id, email_normalizado)` y `(event_id, telefono_e164)` son parciales solo por `IS NOT NULL` e **incluyen las filas con `deleted_at`**: reimportar reactiva la misma fila en vez de duplicarla (RF-02, TR-11, RF-12 "reactivado"). 3) `deleted_at` revoca los dos tokens de su `Invitation`, cancela los jobs de TR-12 y conserva RSVP y check-ins previos (RF-20, AC-24). 4) Cero credenciales de sesión: el invitado se identifica solo por el token de su invitación (§1 D3.3, RF-19). 5) PII cifrada en reposo y borrada/anonimizada 12 meses después del cierre (NFR-07, NFR-08, AC-18).
**Índices:** `UNIQUE (event_id, email_normalizado) WHERE email_normalizado IS NOT NULL` · `UNIQUE (event_id, telefono_e164) WHERE telefono_e164 IS NOT NULL` · `BTREE (event_id) WHERE deleted_at IS NULL` (roster, conteo de aforo, lista sin mesa de RF-12).
**Respaldo:** RF-02, RF-12, RF-13, RF-19, RF-20 · TR-11, TR-16 · NFR-07, NFR-08, NFR-11 · AC-11, AC-18, AC-20, AC-24.

## 7. `Invitation`

Cada invitado recibe **una** invitación con **dos tokens de propósito distinto**: RSVP (enlace) y check-in (contenido del QR), ambos revocables y nunca intercambiables (RF-03, TR-07).

| Campo | Tipo | Nulo | Default | Restricción / Índice | Descripción |
| --- | --- | --- | --- | --- | --- |
| `id` | `char(26)` | no | — | PK | ULID de la invitación; es el `invitación_id` que firma el QR (TR-06) |
| `event_id` | `char(26)` | no | — | FK `event(id)`; BTREE parcial | Roster y estación de escaneo son por evento (TR-16, TR-19) |
| `guest_id` | `char(26)` | no | — | FK `guest(id)`; UNIQUE | Una invitación vigente por invitado (RF-03) |
| `rsvp_token_hash` | `char(64)` | no | — | UNIQUE | Token de RSVP ≥ 128 bits, guardado como hash: nunca en claro (RF-03, NFR-07) |
| `checkin_key_id` | `text` | no | — | — | `key_id` de la clave que firma el QR; la firma se verifica offline (TR-06) |
| `token_version` | `smallint` | no | 1 | `CHECK (token_version >= 1)`; viaja en el roster firmado | Regenerar incrementa la versión y revoca el QR anterior en la misma transacción (RF-03) |
| `qr_emitido_en` | `timestamptz` | no | `now()` | — | Emisión del QR vigente; alimenta el envío de RF-16 |
| `rsvp_revocado_en` | `timestamptz` | sí | — | Independiente de `checkin_revocado_en` | Revocación del token de RSVP (`INVITACION_REVOCADA`) |
| `checkin_revocado_en` | `timestamptz` | sí | — | Índice parcial | Revocación del QR: deja de admitir aunque la firma sea válida (RF-13, RF-20) |
| `codigo_corto` | `char(6)` | no | — | `CHECK (codigo_corto ~ '^[0-9]{6}$')`; UNIQUE `(event_id, codigo_corto)` | Fallback sin cámara impreso en la invitación (RF-13, §11) |
| `created_at` / `updated_at` / `deleted_at` | `timestamptz` | no / no / sí | `now()` / `now()` / — | `deleted_at` corta la página pública | Auditoría estándar |

**Invariantes:** 1) Los dos tokens no son intercambiables en ningún caso (TR-07, AC-06): el de RSVP se contrasta por hash, el de check-in por firma con `checkin_key_id`; usar uno por el otro responde `TOKEN_TIPO_INCORRECTO`. 2) Se revocan por separado: `rsvp_revocado_en` no invalida el QR ni al revés (RF-03). 3) **La admisión de un solo uso no se impone aquí**: es convergencia de `CheckinEvent` por `invitación_id` según `recibido_en` del servidor (TR-17, AC-05, AC-06), por lo que esta tabla no lleva contador de admisiones. 4) Regenerar no crea fila: rota `rsvp_token_hash`/`checkin_key_id` e incrementa `token_version`, y el roster firmado con la versión nueva hace que el token anterior no verifique ni offline (RF-03, TR-06). 5) La baja del invitado revoca ambos tokens y conserva el historial (RF-20, AC-24). 6) La respuesta RSVP vigente **no es columna**: vive en el log append-only `RsvpResponse` con `superseded_at` (RF-05), y el QR se sigue sirviendo después de responder (RF-18).
**Índices:** `UNIQUE (guest_id)` · `UNIQUE (rsvp_token_hash)` (resolución del enlace público) · `UNIQUE (event_id, codigo_corto)` (fallback de RF-13) · `BTREE (event_id) WHERE deleted_at IS NULL` (roster precargado, NFR-04).
**Respaldo:** RF-03, RF-05, RF-13, RF-16, RF-18, RF-20 · TR-06, TR-07, TR-17 · NFR-04, NFR-07, NFR-08 · AC-05, AC-06, AC-23, AC-24 · P06, P12.

## 8. `EventAccessToken`

QR de acceso **por evento y por rol** para trabajadores y staff (§1 D3.6, RF-19): se canjea por una sesión acotada al evento, y expira con el evento (TR-19).

| Campo | Tipo | Nulo | Default | Restricción / Índice | Descripción |
| --- | --- | --- | --- | --- | --- |
| `id` | `char(26)` | no | — | PK | ULID del token de acceso |
| `event_id` | `char(26)` | no | — | FK `event(id)`; BTREE `(event_id, rol)` | Evento al que da acceso, y a ningún otro (TR-16, TR-19) |
| `rol` | `text` | no | — | Elemento del catálogo cerrado de roles (trigger) | El QR es por evento **y** por rol (§1 D3.6) |
| `token_hash` | `char(64)` | no | — | UNIQUE | Token no adivinable, guardado como hash (NFR-07) |
| `emitido_por_user_id` | `char(26)` | no | — | FK `user(id)` | Planner que lo emite (§1 D3.6, RF-19) |
| `expira_en` | `timestamptz` | no | — | `CHECK (expira_en > created_at)`; BTREE parcial | Fijado a `event.ventana_fin` al emitir y forzado a `now()` al cerrar o cancelar el evento (RF-15) |
| `created_at` / `updated_at` / `deleted_at` | `timestamptz` | no / no / sí | `now()` / `now()` / — | `deleted_at` anula el canje | Auditoría estándar |

**Invariantes:** 1) Alcance mínimo: abre una sesión `(event_id, rol, device_id)` que solo ve el roster y los check-ins de ese evento y muere con él (RF-19, TR-19). 2) `expira_en ≤ event.ventana_fin` al emitir (no declarable con `CHECK`: se valida en la transacción) y el cierre o la cancelación del evento la expiran en bloque (§1 D3.6). 3) No es `StaffAssignment` ni lo sustituye: `StaffAssignment` es el permiso explícito de escaneo por evento (§1 D3.2, §3); este token solo abre la sesión de su propio evento. 4) No otorga identidad ni rol global: el `rol` del token no modifica `user.roles` (§1 D3.6). 5) No es de un solo uso: la sesión que abre dura hasta el fin del evento (TR-19); el bearer de un solo uso es el QR de check-in del invitado (RF-03).
**Índices:** `UNIQUE (token_hash)` (canje `POST /auth/event-session`) · `BTREE (event_id, rol) WHERE deleted_at IS NULL` (emisión y expiración en bloque por evento) · `BTREE (expira_en) WHERE deleted_at IS NULL` (job de expiración).
**Respaldo:** §1 D3.6 · RF-19 · TR-19 · NFR-07, NFR-11 · AC-15 · D7, D9.

## Resumen de riesgos

- **`planner_id` (contradicción de la spec).** §1 D3.4 lo declara en `Event`, pero §10 y L6/P10 lo reemplazan por `EventMembership`; aquí manda la membresía. El ejemplo de `04` §4.1 todavía devuelve `planner_id`: o se cambia, o se sirve desde una vista derivada del `owner`.
- **Unicidad frente a baja lógica en `Guest`.** Se incluyen las filas con `deleted_at` en la clave, para que reimportar reactive (TR-11, RF-12); si el negocio prefiere re-invitar como invitado nuevo, hay que quitar `deleted_at` de la fila y el índice deja de reutilizar la clave.
- **`aforo` no se libera (RF-20).** Contar también invitados dados de baja impide reemplazarlos si el aforo está lleno, y la spec no define ninguna vía de liberación: el planner queda bloqueado sin recurso explícito.
- **`EventAccessToken` sin revocación definida.** Solo expira con el evento, así que un QR filtrado no se puede anular antes del cierre; la spec tampoco fija su superficie de emisión (el token de un solo uso de 72 h de RF-19/§11 es la invitación de staff, no este QR).
