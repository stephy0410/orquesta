# 02 — Core Entities

Sección 2 del delivery framework de Hello Interview: una lista corta de entidades centrales con **solo los campos que importan al diseño**, no el esquema completo. El framework es explícito en eso: no se documenta cada columna. El esquema completo vive en los anexos, que son la referencia autoritativa de tipos, `CHECK`, índices e invariantes por tabla. Fuente normativa: `docs/requerimientos.md` v2.1 §3 (§1, §2 y §5 dan el respaldo).

| Anexo | Alcance |
| --- | --- |
| [`02a`](./02a-entidades-core.md) | identidad, evento, invitado e invitación |
| [`02b`](./02b-entidades-operacion.md) | permiso de escaneo, entregas, RSVP, check-in, mesas, recordatorios, auditoría |
| [`02c`](./02c-entidades-contratacion.md) | perfil, disponibilidad, reserva, pago y ledger |

## 1. Mapa de entidades

Las 22 entidades del modelo de dominio mínimo (§3), agrupadas por dominio. Además de estas 22 entidades normativas, el esquema operacional en Aurora/RDS PostgreSQL incluye la tabla técnica de proyección [`event_counters`](./02b-entidades-operacion.md#10-proyección-de-lectura-event_counters-read-model) (materialización del *read model* del tablero exigido por `TR-05` y `TR-13`, lo que evita `COUNT(*)` en vivo y elimina la necesidad de DynamoDB o Redis).

| Entidad | Qué representa | Por qué es central | Anexo |
| --- | --- | --- | --- |
| **Identidad y evento** | | | |
| `User` | Cuenta con `roles[]`: `planner` y/o `worker` | Única identidad con sesión; **no existe cuenta de invitado** (§1 D3/D7/D9) | `02a` |
| `EventMembership` | Quién es `owner`/`editor` de un evento | La autorización real es la membresía, no el rol global (NFR-11, TR-13) | `02a` |
| `Venue` | Lugar del evento, sin catálogo ni reserva | Su `zona` es la que se cruza con las zonas del perfil en RF-07 | `02a` |
| `Event` | Unidad de partición, ownership y corte | Toda escritura de check-in y seating lleva su `event_id` como primera clave (TR-16) | `02a` |
| `EventRequirement` | Demanda de personal `{rol, cantidad}` del evento | Es la vara contra la que se mide la cobertura de reservas (RF-22) | `02a` |
| `EventAccessToken` | QR de acceso por evento **y** rol | Abre una sesión de escaneo acotada al evento y muere con él (TR-19) | `02a` |
| **Invitado e invitación** | | | |
| `Guest` | Invitado de un evento, sin credencial | Su clave de negocio es la idempotencia del import y el control de aforo (RF-02) | `02a` |
| `Invitation` | Invitación con dos tokens de propósito distinto | Separa RSVP de check-in: reenviar el SMS no da una admisión extra (RF-03, TR-07) | `02a` |
| `InvitationDelivery` | Entrega por canal y destinatario | Estado por canal y dedupe estricto: un canal caído no invalida el otro (RF-04, TR-12) | `02b` |
| `RsvpResponse` | Log append-only de confirmaciones y declinaciones | Una sola respuesta vigente por invitación; la anterior queda `superseded_at` (RF-05) | `02b` |
| `ReminderJob` | Recordatorio programado por ventana | Su rebote se mide con el mismo estado por canal de la entrega (RF-10) | `02b` |
| **Operación de check-in y seating** | | | |
| `StaffAssignment` | Permiso de escanear, por evento y usuario | Escanear es un permiso otorgado, nunca una propiedad del actor (§1 D3.2, D9) | `02b` |
| `CheckinEvent` | Log append-only de escaneos y anulaciones | Es donde converge la admisión única a nivel sistema (TR-01, TR-17) | `02b` |
| `DeviceSyncState` | Backlog declarado por dispositivo y evento | Única fuente de "pendientes de sincronizar"; sin heartbeat es `desconocido` (TR-18) | `02b` |
| `Table` | Mesa del evento con `capacidad` | Techo duro de la ocupación del plano de mesas (RF-12) | `02b` |
| `SeatAssignment` | Asiento de un invitado en una mesa | La capacidad se verifica dentro de la transacción, no en lectura previa (TR-10) | `02b` |
| `AuditEntry` | Traza inmutable de acciones sensibles | Ninguna anulación de check-in existe sin actor, motivo y reloj de servidor (RF-14) | `02b` |
| **Contratación y dinero** | | | |
| `WorkerProfile` | Oferta publicada del trabajador | Es lo que la búsqueda devuelve y de donde sale el precio que se congela (RF-21, D9) | `02c` |
| `AvailabilityWindow` | Disponibilidad declarada `[inicio, fin)` por rol | Precondición de la aceptación: sin ventana declarada no hay contratación (RF-22) | `02c` |
| `WorkerReservation` | Solicitud/ocupación de una ventana de un perfil | Única fuente de verdad de ocupación y clave **cross-evento** (RF-08, TR-08) | `02c` |
| `Payment` | Cobro contra una reserva `aceptada` | Cardinalidad 1:1 con la reserva y una `idempotency_key` acuñada una sola vez (TR-09) | `02c` |
| `PaymentEntry` | Línea del ledger de doble entrada | Un cobro es exactamente una transacción de dos líneas que suma 0 (RF-11) | `02c` |

## 2. Campos que importan

Solo las columnas que cambian una decisión de diseño. Tipos exactos en el anexo de cada tabla.

### `Event` — `02a`

| Campo | Por qué importa |
| --- | --- |
| `id` | Es el prefijo de partición de la ingesta y del seating (TR-04, TR-16) |
| `timezone` | Obligatoria: ventanas, recordatorios y corte se calculan en la zona del evento, no la del servidor (RF-01) |
| `ventana_inicio` / `ventana_fin` | `[inicio, fin)` acota la ingesta, expira los accesos y define qué escaneo es `tardio` (RF-15) |
| `aforo` | Límite **duro** del import; la baja lógica no lo libera (RF-01, RF-20) |
| `estado` | Solo `publicado` y `en_curso` aceptan envíos y check-in (RF-01) |
| `cerrado_en` | Instante del corte del consolidado y del paso de reservas a `completada` (RF-15) |

### `Guest` — `02a`

| Campo | Por qué importa |
| --- | --- |
| `id` | Se referencia desde `Invitation`; no se reutiliza al reactivar: se reactiva la misma fila (TR-11) |
| `event_id` | Toda lectura de roster y check-in se filtra por evento (NFR-11, TR-16) |
| `nombre` | Único dato que resuelve el fallback sin cámara de RF-13 |
| `email_normalizado` | Clave de negocio del dedupe, normalizada en minúsculas y cifrada en reposo (RF-02, NFR-07) |
| `telefono_e164` | Segunda clave de negocio; sin email ni teléfono la fila se rechaza (RF-02) |
| `estado_envio` | `pendiente_envío` es lo que impide que el import envíe nada (RF-02, RF-16) |
| `deleted_at` | Baja lógica: revoca tokens y cancela jobs, pero conserva historial y aforo (RF-20) |

### `Invitation` — `02a`

| Campo | Por qué importa |
| --- | --- |
| `guest_id` | Una invitación vigente por invitado; el QR nunca crea un invitado (RF-03) |
| `rsvp_token_hash` | Token de RSVP ≥ 128 bits guardado como hash, nunca en claro (NFR-07) |
| `checkin_key_id` | `key_id` de la clave que firma el QR: permite verificar la firma **offline** (TR-06) |
| `token_version` | Regenerar rota tokens e incrementa la versión, invalidando el QR anterior en la misma transacción (RF-03) |
| `checkin_revocado_en` | Revocación independiente del RSVP: un QR revocado deja de admitir (RF-13, RF-20) |
| `codigo_corto` | Fallback de 6 dígitos impreso, único por evento (RF-13) |

### `CheckinEvent` — `02b`

| Campo | Por qué importa |
| --- | --- |
| `invitation_id` | El check-in se resuelve contra la invitación, jamás contra el invitado suelto (RF-13) |
| `device_id` + `sequence` | Clave natural de idempotencia: el replay es un no-op con el mismo veredicto (TR-01, TR-03) |
| `kind` | Solo tres tipos de fila: `admitido`, `anulacion`, `duplicado_tardio`; no hay `UPDATE` (RF-14) |
| `veredicto` | Un único veredicto por fila, incluido `no_en_roster` y `no verificable offline` (RF-13) |
| `admision_ciclo` | Hace única la admisión vigente por invitación y solo avanza al anular (RF-14, AC-16) |
| `recibido_en` | Reloj **de servidor**: decide qué dispositivo gana la admisión (TR-17) |
| `tardio` | Escaneo dentro de la ventana sincronizado tras el cierre: se acepta, marcado (RF-15) |

### `WorkerProfile` — `02c`

| Campo | Por qué importa |
| --- | --- |
| `tipo` + `plazas_ofrecidas` | `persona` obliga 1 plaza; solo `empresa` declara N (D10) |
| `categorias` | Filtro principal de RF-07, con semántica AND (RF-21) |
| `zonas` / `radio_km` | Filtro de lugares; el radio solo ordena el subconjunto ya filtrado por zona (RF-07) |
| `tarifa_monto` / `tarifa_moneda` / `tarifa_unidad` | Fuente del `costo_congelado`; sin unidad el monto no es interpretable (TR-20) |
| `estado` | Solo `publicado` y verificado aparece en la búsqueda (RF-21, AC-25) |
| `telefono_verificado_en` | Predicado de visibilidad: sin OTP verificado no aparece en ninguna búsqueda (AC-25) |
| `telefono_e164` | PII fuera de toda proyección pública; se desbloquea solo con reserva `aceptada` (NFR-07, NFR-11) |

### `WorkerReservation` — `02c`

| Campo | Por qué importa |
| --- | --- |
| `worker_id` + `inicio`/`fin` | Agregado de concurrencia cross-evento; el solapamiento es de intervalos semiabiertos (TR-08) |
| `rol` | Debe coincidir con el rol de la `AvailabilityWindow` que contiene la ventana (RF-22) |
| `hora_llegada` | Obligatoria y dentro de la ventana; dispara el recordatorio de llegada (RF-08) |
| `plazas` | Se reduce si la aceptación es parcial y entra en la suma aceptada (D10, AC-07) |
| `estado` | Solo `aceptada` ocupa: las `solicitada` no bloquean (RF-08, RF-17) |
| `costo_congelado_*` | Snapshot inmutable de la tarifa al solicitar; el pago solo lee esto (TR-20, AC-26) |
| `expira_en` | `min(48 h, fin − ahora)`; en emergencia 15 min (RF-17) |

### `InvitationDelivery` — `02b`

| Campo | Por qué importa |
| --- | --- |
| `destinatario` | Parte 1 de la clave TR-12, derivada por trigger; sin PII en claro (NFR-07) |
| `plantilla` | Parte 2: envío inicial y recordatorios son claves distintas (RF-16) |
| `ventana` | Parte 3: `envio_inicial` o `resend_n` explícito; inmutable por job (RF-16, TR-12) |
| `canal` | SMS y email van en paralelo: el estado es por canal, no por invitación (RF-04) |
| `estado` | `encolado → entregado \| rebotado \| indeterminado`, con `indeterminado` a los 15 min (RF-04) |
| `intentos` | Un reintento es el **mismo** job, hasta 3; agotado pasa a `rebotado` (RF-04) |
| `reminder_job_id` | Conecta el recordatorio con su entrega para medir el rebote (RF-10) |

### `AvailabilityWindow` — `02c`

| Campo | Por qué importa |
| --- | --- |
| `worker_id` | La oferta es por perfil; el índice GIST acota la contención a un trabajador (RF-22) |
| `inicio` / `fin` | Intervalo `[inicio, fin)` que debe **contener** la ventana de la reserva (RF-22) |
| `rol` | La contención exige el mismo rol; una ventana de mesero no habilita un DJ (RF-22) |
| `zona` | Alimenta el filtro de lugares de RF-07, no la contención de RF-22 |
| `deleted_at` | Retirar la ventana excluye la oferta de toda contención futura |

## 3. Relaciones e invariantes clave

1. **Una admisión por invitación, a nivel sistema.** No es un contador por dispositivo: `(invitation_id, admision_ciclo)` es único entre filas `admitido` y la convergencia usa `recibido_en` del servidor (RF-13, TR-17, AC-05/AC-06).
2. **La suma de plazas aceptadas manda.** `Σ plazas` de reservas `aceptada` solapadas de un perfil, en cualquier evento, nunca supera `plazas_ofrecidas`; las `solicitada` pueden solaparse (RF-08, TR-08, AC-07).
3. **El precio se congela al solicitar.** `costo_congelado` se copia de la tarifa publicada en la transacción de la solicitud y es inmutable: subir la tarifa después no reescribe la reserva ni el cobro (TR-20, RF-11, AC-26).
4. **La disponibilidad contiene la reserva.** Una reserva solo pasa a `aceptada` si su ventana está contenida en una `AvailabilityWindow` vigente del mismo rol; si no, error determinista y sin cambio de estado (RF-22, AC-22).
5. **Dedupe de notificaciones por `(destinatario, plantilla, ventana, canal)`.** Produce una sola entrega aun con solicitudes concurrentes; el canal viaja dentro del `destinatario` y un reintento nunca crea otra fila (RF-04, TR-12, AC-13).
6. **Aislamiento por `EventMembership`.** Toda lectura y escritura de evento se autoriza contra la membresía, no contra `planner_id`: ser planner no da acceso a un evento ajeno (NFR-11, TR-13, AC-15).
7. **Dos tokens, dos propósitos.** RSVP por hash y check-in por firma; usar uno por el otro se rechaza por tipo y reenviar la invitación no otorga una admisión extra (RF-03, TR-07).
8. **Pago y ledger.** `Payment` es 1:1 con la reserva con `idempotency_key` única, y `PaymentEntry` es append-only: un reverso es una transacción nueva, nunca una edición (RF-11, TR-09, AC-08).

## 4. Qué NO está en el modelo y por qué

1. **Nada de presupuestos**: no hay líneas, partidas, aprobaciones ni totales por evento. Una tarifa publicada y un `costo_congelado` no son un presupuesto (§7.4).
2. **Sin CFDI ni dispersión real**: el ledger existe para conciliar, no para facturar; no hay datos fiscales, KYC, comisiones ni reversos productivos (§7.1, §7.5).
3. **Sin cuenta ni entidad de invitado con credenciales**: el invitado se identifica solo con el token de su invitación; un `User` de invitado reabriría un actor que RF-19 excluye.
4. **Sin reserva ni calendario de `Venue`**: el venue es un dato del evento, sin aforo ni disponibilidad propias; el aforo vive en `event.aforo` (§7.5).
5. **Sin actor "anfitrión" ni entidad de cliente**: no hay portal, cuenta ni superficie para el anfitrión, y un `WorkerProfile` es oferta publicada, no una vista del evento (§1.1, §7.3).

