# Orquesta — Requerimientos

**Fuente única de verdad de los requerimientos de este repositorio.** Este archivo es el documento normativo: si algo no está acá, no es un requisito. `README.md` es la spec original y se conserva como origen histórico; toda desviación, corrección o decisión está registrada en este archivo (§13 y §14). Ninguna otra herramienta, memoria externa o nota es autoridad sobre estos requerimientos.

Convención:

- **RF** funcional · **NFR** no funcional · **TR** técnico derivado · **AC** criterio de aceptación · **D** decisión.
- `[inferencia]` = deducción propia; no es texto de la spec.
- Los números de `README.md:15-20` se conservan **con correcciones documentadas** en §6.

Estado: **v2.1** — revisado por 15 revisores independientes (§14). 108 hallazgos consolidados, 14 bloqueantes corregidos. v2.1 agrega plataforma (§1.1) y doce preguntas abiertas que bloquean el inicio (§16).

---

## 1. Actores e identidad

| Actor | ¿Cuenta? | Puede | Origen |
| --- | --- | --- | --- |
| **Planner** | Sí | crear eventos, importar invitados, monitorear el tablero, buscar y **contratar trabajadores**, pagar, acomodar mesas | `README.md:3,5,6,8,9` |
| **Trabajador** (`worker`: mesero, maquillista, fotógrafo, DJ, catering) | **Sí** (autorregistro, RF-19) | crear su **perfil contratable** (capacidades, tarifa, zonas, disponibilidad), recibir solicitudes, **aceptar o rechazar**, ver su hora de llegada y cobrar; **escanear solo si el planner lo habilita por evento** | `README.md:4,6,7,8` + D7 + D9 |
| **Invitado** | **No** | recibir la invitación por SMS y email, abrirla, confirmar o declinar | `README.md:3,7,10` |

**D3 — Identidad** (ampliada por D7: el trabajador también tiene cuenta).

1. Un único modelo `User{id, email, roles[]}` con roles `planner` y `worker`. No hay cuentas de invitado. **Historia:** D3 limitaba las cuentas a planner y staff; D7 sumó al proveedor; D9 unificó *staff* y *proveedor* en un solo actor contratable (`worker`) y sacó el escaneo del tipo de actor.
2. `StaffAssignment{user_id, event_id, permisos[], expira_en}` es un **permiso de escaneo por evento**, no un tipo de actor: un trabajador contratado no puede escanear si el planner no se lo habilita. El perfil público del trabajador es legible por cualquier planner (NFR-11, segunda excepción); su permiso de evento nunca es global.
3. El invitado se identifica con el token de su invitación, nunca con una credencial de sesión.
4. `Event` se gobierna por `EventMembership`: toda lectura **y escritura** (import, seating, trabajadores, pagos) se autoriza contra la membresía del evento (NFR-11).
5. Ninguna superficie de invitado permite enumerar invitados ni consultar otro evento.
6. Staff y trabajador pueden abrir su sesión de trabajo con un **QR de acceso al evento** emitido por el planner, además del login normal (D7, RF-19). El QR es por evento y por rol, y expira con el evento.

### 1.1 Plataforma

**Aplicación web. No hay aplicación mobile ni apps nativas** (`README.md:12`). Tres superficies, un solo producto:

| Superficie | Quién | Forma |
| --- | --- | --- |
| **Consola del planner** | planner | web, desktop-first; concentra la gestión: eventos, invitados, envíos, tablero, mesas, trabajadores |
| **Vista de escaneo** | trabajador habilitado | web, **en el navegador del teléfono**, instalable como PWA (TR-15); requiere HTTPS y permiso de cámara |
| **Página de la invitación** | invitado | web pública, sin cuenta y sin login; renderiza el QR y el RSVP |
| **Consola del trabajador** | trabajador | web, mínima: perfil contratable, disponibilidad, solicitudes (aceptar/rechazar), hora de llegada y estado de pago (D7, D9) |

La consola del trabajador **no** es el "portal del anfitrión" que `README.md:12` excluye: el anfitrión es el cliente del planner y no es actor; el trabajador sí.

Consecuencias que no son negociables si se quiere el check-in de `README.md:4`:

1. "Sin app mobile" = sin instalación desde una tienda. **No** significa sin teléfono: el trabajador habilitado escanea con la cámara del teléfono vía API del navegador. Si se interpreta como "solo desktop", el escaneo offline exige hardware del venue y cambia el diseño de RF-13.
2. La cámara es un permiso del navegador, no del sistema: hace falta HTTPS, un fallback manual (P06 en §16) y una sesión que sobreviva a la pérdida de red.
3. El planner gestiona la mayor parte del producto: es el único actor con consola completa (evento, invitados, envíos, tablero, mesas, contrataciones). El trabajador tiene una consola mínima de oferta y trabajo; el invitado solo responde su invitación.
4. El perfil del trabajador es **oferta de trabajo publicada**, no una vista del evento: no reabre el "portal del anfitrión" de `README.md:12`, que sigue fuera de alcance.

---

## 2. Requerimientos funcionales

| ID | Requerimiento | Origen |
| --- | --- | --- |
| **RF-01** | El planner crea un evento con nombre, fecha, **zona horaria obligatoria**, ventana horaria, `Venue{id, nombre, zona, dirección}` y aforo. `aforo` es límite duro: el import rechaza invitados que lo excedan. Estados: `borrador → publicado → en_curso → cerrado`, más `cancelado`; solo `publicado` y `en_curso` aceptan envíos y check-in. La partición y el corte se especifican en TR-16 y RF-15. | `README.md:3` `[inferencia]` |
| **RF-02** | **Import masivo idempotente**: reimportar el mismo archivo no duplica invitados ni reenvía invitaciones. Clave de negocio `(evento, email normalizado)` o `(evento, teléfono E.164)`; normalización: email en minúsculas sin espacios, teléfono con prefijo país. Sin ninguna de las dos claves, la fila se rechaza. El import valida por fila y responde `{aceptadas, rechazadas, duplicadas_en_archivo, errores[{linea, motivo}]}` con códigos `GUEST_SIN_CLAVE` / `GUEST_CLAVE_INVALIDA` / `GUEST_DUPLICADO` / `AFORO_EXCEDIDO`; las filas válidas se confirman en una transacción. Acepta ≤ 20 000 filas por archivo, procesadas asíncronamente con progreso consultable. Cada invitado aceptado queda en **`pendiente_envío`**: el import **no envía nada**; el envío lo dispara el planner (RF-16). | `README.md:3` |
| **RF-03** | Cada invitado recibe **una invitación con dos tokens de propósito distinto**: token de RSVP (enlace del SMS/email) y token de check-in (contenido del QR). El QR es un **bearer de un solo uso**: puede reenviarse, pero nunca produce más de una admisión (RF-13). Es un token firmado, revocable; regenerar emite uno nuevo y revoca el anterior en la misma transacción. | `README.md:3` `[inferencia]` |
| **RF-04** | Entrega por **SMS y email en paralelo, ambos canales siempre (D11)**, con estado por canal y destinatario: `encolado → entregado \| rebotado \| indeterminado`. `indeterminado` se fija a los 15 min sin respuesta del trabajador; `rebotado` es terminal por canal+destinatario. Dedupe estricto por la clave de TR-12; un reintento es **el mismo job** con contador ≤ 3 y, agotado, el envío pasa a `rebotado` sin recrearse. Si un canal falla, el otro basta y la entrega parcial se expone en el tablero (RF-06). | `README.md:10` |
| **RF-05** | **RSVP sin cuenta**: el invitado confirma o declina con el **token de RSVP del enlace**, nunca con el QR de check-in. Existe una sola respuesta vigente por invitación (la última gana); la anterior se marca `superseded_at` en un log append-only, sin requisito de historial consultable. | `README.md:3` |
| **RF-06** | El planner monitorea **todos sus eventos en un solo tablero** con la frescura de NFR-03 y estos contadores: invitados, confirmados, asistentes, **aún-no-llegaron** (invitados − asistentes), pendientes de sincronizar y entregas parciales. `no-show` se calcula al cierre (RF-15), no en vivo. | `README.md:5` |
| **RF-07** | **Búsqueda de trabajadores** por las tres dimensiones del negocio: **capacidades** (`categorias[]`, AND), **lugares** (`zonas[]` que cubran la zona del `Venue`, o `radio_km` con distancia al venue) y **costos** (`tarifa` en un rango, con `unidad` explícita). Solo devuelve perfiles `publicado` y **verificados**, y excluye a quien tenga una reserva `aceptada` solapada con la ventana. Devuelve `{worker_id, nombre_publico, categorias, tarifa, zonas, idiomas, eventos_completados}`, **nunca datos de contacto**. Orden: coincidencias de categoría ↓, luego zona exacta antes que radio y distancia ↑, luego tarifa ↑, empate por `worker_id` ↑. Es consultiva: una solicitud creada entre la búsqueda y la escritura produce conflicto en TR-08, nunca doble reserva. | `README.md:6` + D9 |
| **RF-08** | **Solicitud de contratación** de un trabajador para una ventana `[inicio, fin)` dentro del evento, con `hora_llegada` obligatoria (`inicio ≤ hora_llegada < fin`), `rol` solicitado y **`costo_congelado`** copiado de la tarifa publicada **al momento de solicitar** (no se negocia después; TR-20). El planner **solicita**; el trabajador **acepta o rechaza** (D7, D9); aceptar es idempotente. Estados: `solicitada → aceptada → completada`, más `rechazada`, `cancelada`, `cancelada_pagada`, `expirada` (48 h sin respuesta) y `sin_cubrir` (RF-09). `completada` la fija el cierre del evento (RF-15) para toda reserva `aceptada`; nadie la marca a mano. Invariante: la suma de `plazas` de reservas `aceptada` solapadas de un mismo perfil, **en cualquier evento**, nunca excede su `plazas_ofrecidas`; las `solicitada` no bloquean porque la aceptación es la que decide. Una persona declara `plazas_ofrecidas = 1`; una empresa declara N y puede aceptar **total o parcialmente** (`aceptada` con menos plazas de las pedidas, devolviendo la diferencia). Cancelar libera plazas de inmediato; una reserva con `fin` pasado no bloquea. | `README.md:6,7,20` + D2 + D7 + D9 |
| **RF-09** | **Reasignación de emergencia** durante el evento, con la **misma** ventana exacta de RF-08 (sin granularidad distinta). Si el trabajador elegido está reservado en una ventana solapada, el sistema responde conflicto y el planner elige otro, cancela **una reserva de su propio evento** (las ajenas no son cancelables, NFR-11) o reprograma la hora. Si no hay trabajador libre, la reserva queda en `sin_cubrir` y el planner recibe alerta. | `README.md:6` |
| **RF-10** | **Recordatorios automáticos** parametrizables: RSVP al invitado (default T-7 d y T-1 d) y hora de llegada al trabajador (default T-24 h y T-2 h), **cada recordatorio duplicado por SMS y por email (D11)**. Se cancelan por clave de TR-12 si el RSVP vigente ya está registrado o si la reserva se canceló; el job consumido no se reprograma y un cambio de respuesta no reactiva jobs cancelados. | `README.md:7` |
| **RF-11** | **Pago a trabajadores** vía PSP en modo test, **solo contra una reserva `aceptada`**. Un cobro genera exactamente una transacción de ledger con dos líneas balanceadas (suma 0). Si la reserva se cancela después del cobro, se registra un `reverso` en el ledger (test, sin dispersión real) y la reserva pasa a `cancelada_pagada`. Sin CFDI y sin dispersión de dinero real (D1). | `README.md:8,12` + D1 |
| **RF-12** | **Acomodo de mesas**: `SeatAssignment{evento, invitado, mesa, estado}`. Solo `confirmado` y `pendiente` ocupan capacidad (default: solo `confirmado`). Si RF-05 deja la respuesta vigente en `declina`, el asiento pasa a `liberado` y devuelve la capacidad, conservando su historial. La suma nunca supera la capacidad de la mesa. Un invitado creado o reactivado por cualquier import queda `sin_mesa` y se expone como lista accionable; el import nunca crea ni borra asientos. | `README.md:9,20` |
| **RF-13** | **Check-in escaneando el QR en el venue, con o sin conectividad**. Veredictos: `admitido`, `ya registrado`, `no corresponde al evento`, `invitación revocada`, `no verificable offline` (lista de revocación vencida; admisión condicional, marcada) y **`no_en_roster`** (invitado creado después de precargar el roster; admisión manual condicional, marcada para revisión). **Fallback sin cámara**: búsqueda por nombre y código corto de 6 dígitos impreso en la invitación; mismo veredicto y misma cola durable. Un invitado se admite una sola vez **en el sistema**, no por dispositivo: al sincronizar converge a nivel backend (TR-17). | `README.md:4` |
| **RF-14** | **Anulación de check-in** por un trabajador autorizado, como `CheckinEvent` compensatorio (`kind=anulacion`, `anula_a`, `actor_id`, `motivo`, `ts`), append-only e idempotente por `(checkin_id, actor_id)`; nunca `UPDATE` ni `DELETE`. Ventana: evento abierto o `corrección` (default 24 h post-cierre). Tras una anulación el invitado puede admitirse de nuevo; `anulado` es distinto de `ya registrado`. | `README.md:4` `[inferencia]` |
| **RF-15** | **Cierre de evento**: fija el corte del consolidado (asistentes, no-shows) y pasa el evento a `cerrado` de **solo lectura**. No rechaza escrituras: los lotes con `escaneado_en` dentro de la ventana del evento se aceptan aunque lleguen después del cierre y se marcan `tardio`; solo se rechaza lo escaneado fuera de la ventana. | `README.md:5` `[inferencia]` |
| **RF-16** | **Envío de invitaciones disparado por el planner** (P03): puede enviar un lote seleccionado o a todos los `pendiente_envío`, con confirmación previa del número de destinatarios. El envío encola exactamente una entrega (RF-04) por invitado y **por cada canal activo (SMS y email en paralelo, D11)**; reenviar a alguien ya enviado es una acción explícita y separada (`ventana = resend_n`), nunca automática. Un invitado en `pendiente_envío` no recibe ningún mensaje. | `README.md:3,10` + D8 |
| **RF-17** | **Consola del trabajador y aceptación del trabajo** (D7, D9): el trabajador ve sus solicitudes con evento, zona, ventana, rol, hora de llegada y `costo_congelado`; acepta o rechaza de forma idempotente. Plazo de respuesta `min(48 h, fin_ventana − ahora)`; en `modo_emergencia` (RF-09) el default es 15 min. Aceptar una solicitud solapada con otra ya aceptada responde conflicto determinista que **nombra la reserva ganadora**; su propia fila queda `solicitada`, nunca se borra. El planner ve por evento el estado de cada solicitud y qué requerimientos de RF-22 quedan sin cubrir. Una reserva `rechazada`/`expirada`/`cancelada` devuelve al trabajador a la búsqueda. | `README.md:6` + D7 + D9 |
| **RF-18** | **Página pública de la invitación**: datos del evento (nombre, fecha, hora, lugar), el QR de check-in renderizado, botones confirmar/declinar, y el estado de la respuesta vigente. Se puede abrir sin cuenta, sin cookie y desde cualquier dispositivo; el invitado puede cambiar su respuesta. Después de responder, la página sigue mostrando el QR. El estado del RSVP nunca se sirve por un GET cacheable (NFR-02). | `README.md:3,10` `[inferencia]` |
| **RF-19** | **Alta y acceso de cuentas**. Registro por email con verificación, contraseña, recuperación por email y sesión en cookie `httpOnly`. **Se autorregistran dos actores: el planner y el trabajador.** El trabajador crea su perfil contratable (RF-21) y queda **invisible en la búsqueda** hasta verificar email y teléfono por OTP; un mismo teléfono verificado respalda un solo perfil. El invitado **no** se registra nunca: se identifica solo con el token de su invitación. **El permiso de escanear no se obtiene registrándose**: lo otorga el planner por evento (`StaffAssignment`) o se abre con el **QR de acceso al evento**, que crea una sesión de ese evento, con ese rol, y expira con el evento. Sin registro público de invitados ni de anfitriones. | D7 + D8 + D9 |
| **RF-21** | **Perfil contratable del trabajador**: `tipo ∈ persona \| empresa` (D10) y `plazas_ofrecidas` (default 1; solo una empresa puede declarar más de 1), `nombre_publico`, `categorias[]` de una **taxonomía cerrada** (≥1, ≤3), `servicios[]` (subconjunto de su categoría), `tarifa{modo, monto, moneda, unidad ∈ hora \| persona_hora \| evento}`, `zonas[]` de una lista cerrada (≥1, ≤5) más `radio_km` opcional, `idiomas[]`, `años_experiencia`, hasta 3 fotos y hasta 3 referencias en texto libre. `estado ∈ borrador \| publicado \| suspendido`; solo `publicado` **y verificado** aparece en RF-07. `eventos_completados` es derivado de reservas `completada`, no un campo editable. El perfil **nunca expone datos de contacto**: se desbloquean solo con una reserva `aceptada`. Una tarifa publicada **no es un presupuesto**: no hay líneas, aprobaciones ni totales (§7). | D9 |
| **RF-22** | **Disponibilidad declarada y requerimientos del evento**: el trabajador declara ventanas de disponibilidad (`{inicio, fin, zona, rol}`); **sin ventana declarada no es contratable**, nunca "disponible por defecto". El planner declara por evento `requerimientos[{rol, cantidad}]` y ve la cobertura: cubiertos, pendientes y `sin_cubrir`. Una reserva solo puede pasar a `aceptada` si su ventana está **contenida** en una ventana de disponibilidad declarada del mismo rol. Contratar 5 meseros son 5 reservas de 5 personas distintas **o** una sola reserva con `plazas = 5` de una empresa (D10); el requerimiento queda cubierto cuando la suma de `plazas` aceptadas alcanza su cantidad. | D9 |
| **RF-20** | **Baja lógica de invitado**: el planner puede dar de baja a un invitado. Se marca `deleted_at`, se revoca su token (el QR deja de admitir, RF-13), se cancelan sus jobs pendientes (TR-12) y se conserva el historial de su RSVP y sus check-ins. La baja no libera aforo automáticamente ni borra datos: eso lo hace NFR-08. | `README.md:3` `[inferencia]` |

---

## 3. Modelo de dominio mínimo

`User` · `EventMembership` (rol `owner`/`editor`) · `StaffAssignment` (permiso de escaneo) · `Venue` · `Event` · `EventRequirement{rol, cantidad}` · `Guest` · `Invitation` (dos tokens) · `InvitationDelivery` · `RsvpResponse` · `CheckinEvent` (kinds: `admitido`, `anulacion`, `duplicado_tardio`) · `DeviceSyncState` · `WorkerProfile` · `AvailabilityWindow` · `WorkerReservation` (estados `solicitada`/`aceptada`/`rechazada`/`expirada`/`cancelada`/`cancelada_pagada`/`sin_cubrir`/`completada`) · `Payment` · `PaymentEntry` (ledger) · `Table` · `SeatAssignment` · `ReminderJob` · `AuditEntry` · `EventAccessToken` (QR de acceso por rol).

Invariantes estructurales, no sugerencias:

- `Payment.n → 1 WorkerReservation`: la idempotencia del pago y la de la reserva comparten la clave (TR-09).
- `CheckinEvent.invitation_id → 1 Invitation`: el check-in nunca crea un invitado nuevo.
- `ReminderJob.n → 1 InvitationDelivery`: el rebote de un recordatorio se mide con el mismo estado por canal.
- `WorkerReservation` es la única fuente de verdad de ocupación de un trabajador.
- Solo una reserva `aceptada` ocupa la ventana; las `solicitada` no bloquean (RF-08, TR-08).
- `WorkerReservation.costo_congelado` es inmutable: un cambio de tarifa en el perfil nunca reescribe una reserva existente (TR-20).
- Un perfil **no** es un actor de evento: `WorkerProfile` no otorga lectura de invitados, mesas ni check-ins.
- `AvailabilityWindow` y `WorkerReservation` son complementarios: la primera declara la oferta, la segunda la ocupa. Ninguna sustituye a la otra (RF-22).
- `WorkerProfile.plazas_ofrecidas` es la capacidad del perfil y la única fuente de verdad para validar la suma de plazas aceptadas (D10).
- `EventMembership` es la fuente de verdad de quién edita un evento: ser `planner` del sistema no otorga acceso a un evento ajeno (NFR-11).
- `PaymentEntry` es append-only e inmutable: un reverso es una entrada nueva, nunca una edición.

---

## 4. Requerimientos no funcionales

| ID | Requerimiento | Origen |
| --- | --- | --- |
| **NFR-01** | **Ingesta de check-in**: 222 escrituras/s sostenidas por 30 min (media de la ventana; §6.1) y **500 escrituras/s en ráfagas de 60 s**. El drenaje del backlog es **diferible**: puede espaciarse hasta no competir con la ingesta viva (§6.6). | `README.md:16,17` |
| **NFR-01b** | **Escrituras de RSVP**: 100 escrituras/s p95 y 400/s por 60 s tras un envío masivo, p99 ≤ 300 ms. | `README.md:18` `[inferencia]` |
| **NFR-02** | **Lecturas de invitación**: ~40 M/mes (≈15 r/s), **75 r/s p95** y **200 r/s por 60 s**, con hit de CDN ≥ 95 % (≤ 2 M lecturas al origen/mes). El shell de la invitación es cacheable puro; **el estado del RSVP viaja en la respuesta del POST**, nunca en un GET, para no romper el hit rate. | `README.md:18` |
| **NFR-03** | **Frescura del tablero ≤ 5 s p95** (≤ 10 s p99) medida con **reloj de servidor**: `t_ingest` (commit de ingesta + ack al dispositivo) → `t_visible` (lectura del contador por la API del tablero). El tiempo sin red del dispositivo **queda excluido** y se reporta aparte como antigüedad del backlog (`DeviceSyncState`). | D4 |
| **NFR-04** | **Verificación del QR + append durable ≤ 100 ms p95 sin red**, con roster ≤ 2 000 invitados y ≤ 5 eventos por sesión de escaneo. | `README.md:4` |
| **NFR-05** | **El check-in no depende de la disponibilidad del backend**: el veredicto se resuelve contra la copia local. El resto del sistema, **99,9 % mensual** medido sobre lecturas de invitación y tablero (el veredicto offline no cuenta). | `README.md:4` `[inferencia]` |
| **NFR-06** | **Durabilidad**: check-in con **RPO 0 en el dispositivo** (persistido antes del veredicto) y **RPO 0 tras el ack de ingesta**; RSVP, reservas, seating y pagos con **RPO ≤ 5 min** sobre escrituras confirmadas; **RTO ≤ 1 h**. | `README.md:20` `[inferencia]` |
| **NFR-07** | **Seguridad**: token de RSVP ≥ 128 bits no adivinable; token de check-in inforjable por firma; PII (email, teléfono) de invitados **y de trabajadores** cifrada en reposo; un perfil público **nunca** expone contacto (se desbloquea solo con reserva `aceptada`); secretos fuera del bundle; sin rutas de invitado que enumeren invitados. | `README.md:3,4` + D9 |
| **NFR-08** | **Retención y borrado**: a los 12 meses del cierre, un job borra o anonimiza email, teléfono, tokens de invitación, entregas y `ReminderJob` del evento; a los 24 meses `CheckinEvent` conserva solo `(evento_id, secuencia, veredicto)` sin `device_id`. `AuditEntry` se conserva 24 meses. El borrado se propaga a réplicas y respaldos en ≤ 30 días. Sobreviven agregados por evento y el ledger sin PII. Un job cuyo destinatario ya no existe se cancela por clave y no se marca como enviado. **Alcance partido (D9):** las filas ligadas al evento siguen la regla de arriba; la PII del `WorkerProfile` **no** se borra al cerrar el evento: vive mientras la cuenta existe y 12 meses después de su última actividad, para no borrar el teléfono de todo trabajador que vuelve a trabajar el año siguiente. | `README.md:19` `[inferencia]` + D9 |
| **NFR-09** | **Observabilidad** con métrica, unidad, ventana y umbral: `checkin_rate` por evento/1 min; `lag_frescura` p95 (NFR-03); `reservation_conflicts`/1 min; `notif_retry` y `notif_bounce` por canal/1 h; `psp_error`/1 h; `offline_queue_depth` gauge enviado en cada lote de TR-03, alerta > 500 o sin drenar > 30 min; `worker_search_zero_results`/1 h; `provider_no_show`/mes. | `README.md:20` `[inferencia]` |
| **NFR-10** | El tablero carga en **≤ 2 s p95 con hasta 25 eventos activos por pantalla** y paginación obligatoria por encima de 25. | `README.md:5,15` |
| **NFR-11** | **Aislamiento por evento**: ninguna consulta devuelve datos de un evento del que el usuario no es miembro (`EventMembership`), en tablero, roster, autocompletado ni check-in. Un `StaffAssignment` habilita solo el roster y los check-ins de su evento. Un trabajador solo ve sus propias solicitudes, nunca las de otro trabajador ni el evento completo. **Excepción 1**: la consulta de disponibilidad devuelve solo `{worker_id, ventana_ocupada}`, sin evento, planner, cliente ni invitado asociado. **Excepción 2 (D9)**: el directorio devuelve el perfil **público** del trabajador con una lista blanca de campos — `worker_id`, `nombre_publico`, `categorias`, `tarifa`, `zonas`, `idiomas`, `años_experiencia`, `eventos_completados` — y **nunca** contacto, eventos en los que trabaja, invitados, ni qué planner lo contrató. | `README.md:5,6` + D9 |

---

## 5. Requerimientos técnicos derivados

| ID | Requerimiento | Derivado de |
| --- | --- | --- |
| **TR-01** | El check-in es un **log append-only**, no un `UPDATE`. Clave natural de idempotencia `(invitación_id, dispositivo_id, secuencia)`; un reintento con la misma clave es un no-op que devuelve el mismo veredicto. | `README.md:4,20` |
| **TR-02** | **Cola durable en el cliente** (IndexedDB o equivalente): ≥ 8 h y ≥ 1 000 escaneos por dispositivo sin red. El roster se precarga firmado y versionado al iniciar la sesión. | `README.md:4,17` `[inferencia]` |
| **TR-03** | **Secuencia monotónica por dispositivo** y lotes de ≤ 500 eventos con checksum: el replay respeta el orden original y un dispositivo no se pisa a sí mismo. | `README.md:17` `[inferencia]` |
| **TR-04** | La ingesta se particiona **por evento**; la deduplicación por clave de negocio es independiente de la partición. | `README.md:16` `[inferencia]` |
| **TR-05** | **El ingest nunca hace fan-out síncrono**: publica en un stream; el read model del tablero se alimenta aparte con contadores incrementales y coalescing de 1 s. Un cambio de RSVP emite un **delta**, no un incremento. | `README.md:5,20` |
| **TR-06** | El QR transporta un token firmado con `invitación_id` y `key_id`; el escáner verifica la firma **offline**. La lista de revocación se refresca al iniciar sesión y siempre que haya red; si tiene más de 2 h, el veredicto es `no verificable offline` y al sincronizar un token revocado se resuelve `invalidado_al_sincronizar`. | `README.md:3,4` |
| **TR-07** | El token de RSVP y el de check-in son **distintos y en ningún caso intercambiables**: reenviar el SMS habilita el RSVP, no una admisión extra. | `README.md:3,10` |
| **TR-08** | La reserva se crea con **escritura condicional sobre `(worker_id, ventana)`**: restricción de exclusión **parcial, solo sobre reservas en estado `aceptada`**, o compare-and-set de versión. Nunca *read-then-write*. Las solicitudes `solicitada` **no compiten entre sí**: varias pueden solaparse y la aceptación es la que serializa (RF-08, RF-17). El perdedor de una aceptación recibe un conflicto determinista que nombra la reserva ganadora. No se serializa por evento: la clave es cross-evento por construcción. Con `plazas_ofrecidas = 1` la exclusión es binaria; con `plazas_ofrecidas = N` (empresa, D10) es un **compare-and-set sobre el agregado** `(worker_id, ventana)` que verifica `Σ plazas aceptadas + plazas_nuevas ≤ plazas_ofrecidas` dentro de la transacción. En ningún caso se hace *read-then-write*. | `README.md:20` + D2 + D7 + D9 |
| **TR-20** | **Congelamiento de precio**: `WorkerReservation.costo_congelado` se copia de `WorkerProfile.tarifa` en la transacción de creación de la solicitud y es inmutable. Cambiar la tarifa del perfil no reescribe reservas; el pago (RF-11) solo lee `costo_congelado`. Emitir una solicitud sin tarifa publicada es un error, no un precio "a convenir". | D9 |
| **TR-09** | **Pago**: la idempotency key se acuña **una sola vez** y se persiste antes de llamar al PSP (el identificador de la reserva, o un `payment_attempt_id` inmutable); reintentar **reusa** esa clave, nunca la incrementa. Antes de reintentar un resultado desconocido se consulta por clave al PSP. Ledger append-only (`PaymentEntry`), una entrada por cobro, transacción de dos líneas balanceadas. Conciliación por webhook idempotente. | D1 |
| **TR-10** | **Seating con single-writer por evento**: el invariante de capacidad se verifica dentro de la transacción; mover un invitado es idempotente por `(evento, invitado, mesa)`. Esta mitad cae dentro de la partición del evento `[inferencia]`. | `README.md:9,20` |
| **TR-11** | Import idempotente: la condición de rechazo es la **clave de negocio dentro del evento**; el hash de archivo es solo una caché de cortocircuito **dentro de ese evento**, nunca una condición global. | `README.md:3` |
| **TR-12** | Los jobs de notificación usan la clave `(destinatario, plantilla, ventana, canal)`, sin forma reducida en ningún otro requisito. `ventana` = offset declarado (`T-7d`, `T-24h`), inmutable por job; reprogramar la fecha del evento reescribe el disparo del **mismo** job. `destinatario` = `guest_id`/`provider_id` + dirección normalizada + canal; dos direcciones del mismo sujeto no son dos destinatarios. Un reintento es el mismo job. | `README.md:7,10` |
| **TR-13** | Aislamiento por planner en el read model: el tablero consulta solo las particiones del planner dueño; ningún agregado global se expone. | `README.md:5` |
| **TR-14** | El PSP vive detrás de un puerto `PaymentProvider`. **El MVP implementa un solo adaptador en modo test**; un segundo adaptador es post-MVP y solo debe pasar el contract test del puerto. El flujo de la aplicación no cambia entre adaptadores. | D1 |
| **TR-15** | El cliente de escaneo es una **PWA instalable** (sin apps nativas), con service worker y almacenamiento durable. | `README.md:4,12` |
| **TR-16** | `Evento` es la unidad de partición de ingesta, de ownership y de corte: toda escritura de check-in y de seating lleva `evento_id` como primera clave. | `README.md:3` `[inferencia]` |
| **TR-17** | **Convergencia cross-dispositivo**: gana la primera fila durable para `invitación_id` según `recibido_en` **del servidor**, nunca según reloj de dispositivo; las demás se conservan como `duplicado_tardio` con veredicto `ya registrado`, contadas aparte. | `README.md:4,20` |
| **TR-18** | `DeviceSyncState{event_id, device_id, cola_reportada, ultima_seq_ackeada, heartbeat_en}`: `pendientes = Σ(cola_reportada) − (última_seq_ackeada − seq_confirmada)` por dispositivo. Sin heartbeat en 5 min el valor se marca `desconocido`, nunca 0. | `README.md:5,17` |
| **TR-19** | **Una sesión de escaneo = un evento**: el trabajador habilitado elige evento al abrir si tiene varios; roster, secuencia y cola durable son por sesión. El `EventAccessToken` del QR de acceso fija el evento y el rol en la sesión. | D7 + D8 |

---

## 6. Correcciones a la estimación de capacidad

La conclusión de `README.md:20` se sostiene. Los números originales tienen **siete** defectos.

**6.1 El 5× no se deriva de la ventana de 30 minutos.**
400 000 escaneos en 5 400 s = 74/s (el texto dice ~75: correcto). La "mayoría en los primeros 30 minutos" da 400 000 ÷ 1 800 s = **222/s**, que es **exactamente 3,0×** el promedio (90/30 = 3), no 5×. El 5× solo se sostiene **por minuto**: 500 w/s × 60 s = 30 000 llegadas = **7,5 % ≈ 8 %** del total del sábado ≈ **16 por evento** (1 840). Forma de llegada adoptada: **222/s sostenidos 30 min + 500/s durante 60 s**. Nota: 250/s × 1 800 s = 450 000 > 400 000 — ese número era imposible y quedó corregido en NFR-01.

**6.2 2 000 eventos es 1 840 redondeado.**
4 600 eventos/semana × 40 % = 1 840. Con 200 invitados: **368 000 check-ins** y **68/s** promedio en la ventana de 90 min. El objetivo de 500/s no cambia.

**6.3 Los eventos/mes nunca se escriben.**
5 000 planners × 4 eventos = **20 000 eventos/mes** = 4 615/semana (el texto dice 4 600: correcto).

**6.4 "10 lecturas por escritura" es inconsistente con "una o dos respuestas".**
10 aperturas ÷ 1,5 respuestas = **6,7:1**. La conclusión práctica no cambia: con hit ≥ 95 % el origen ve ≤ 2 M lecturas/mes, no 40 M.

**6.5 El pico de lectura no estaba cuantificado, ahora se deriva.**
Cohorte de envío = 100 planners × 200 invitados = **20 000 invitaciones**; ~3 aperturas en los primeros 15 min = 60 000 lecturas ÷ 900 s = **67/s**, redondeado a **75 r/s p95**; **200/s por 60 s** si coinciden tres cohortes.

**6.6 La ráfaga de replay estaba mal dimensionada.**
2 000 pendientes por venue es 10× el aforo de un evento de 200 invitados. Cifra correcta: **20 venues que reconectan × 2 eventos por venue × 200 invitados = 8 000 eventos a drenar en ≤ 120 s = 67/s**, que con la ingesta viva en 222/s da **289/s**, dentro de 500/s. Si el drenaje coincide con la ráfaga de 60 s, **el drenaje se espacia** (es diferible: el veredicto ya se emitió offline); la sincronización se atrasa, nunca se pierde.

**6.7 Unidades faltantes.**
`README.md:19` "50 al año": son **~48 GB/año** de invitados (4 GB/mes × 12), más check-ins, notificaciones y ledger.

---

## 7. Fuera de alcance

Verbatim de `README.md:12`: **facturación CFDI, presupuestos, asistente de IA, apps nativas y portal del anfitrión.**

Precisiones que evitan reabrir el debate:

1. **Sin CFDI** no significa sin registro de pago: el ledger existe para conciliar, no para facturar, y su retención no tiene base fiscal.
2. **Sin apps nativas** obliga a PWA (TR-15); no habilita un cliente que dependa de conectividad.
3. **Sin portal del anfitrión**: el anfitrión no es actor; no hay cuenta ni superficie para él. Un **perfil de trabajador** no reabre esto: es oferta de trabajo publicada, no una vista del evento ni del cliente del planner.
6. **Sin presupuestos**: una **tarifa publicada** en un perfil y un `costo_congelado` en una reserva no son un presupuesto. No hay líneas, partidas, aprobaciones, versiones ni totales por evento. Si aparece cualquiera de esas cosas, reabre `README.md:12`.
4. **Sin dispersión real de dinero** (D1): pagos en modo test, sin KYC, comisiones ni reversos productivos.
5. **Sin reserva de venue**: la spec nunca selecciona ni cataloga venues; `Venue` es solo un dato del evento (RF-01).

---

## 8. Criterios de aceptación

Cada uno es falsable y verifica un requerimiento observable por interfaz pública.

| ID | Criterio | Cubre |
| --- | --- | --- |
| **AC-01** | 500 escrituras/s durante 60 s sobre 50 eventos: 100 % de los check-ins confirmados aparecen **una sola vez**, 0 duplicados, p99 de ingesta ≤ 500 ms, 0 escrituras perdidas. | NFR-01, TR-01 |
| **AC-02** | 222 escrituras/s sostenidas 30 min: 0 pérdidas y lag de frescura dentro de NFR-03 durante toda la ventana. | NFR-01 |
| **AC-03** | Replay del mismo lote 3 veces: una fila por `(invitación, dispositivo, secuencia)`, mismo veredicto las 3 veces, contador del tablero sin cambios. | TR-01, TR-03 |
| **AC-04** | Dispositivo en modo avión 8 h con 1 000 escaneos: 1 000 veredictos emitidos, 0 pérdidas al reconectar, 0 duplicados. | TR-02, NFR-06 |
| **AC-05** | Dos dispositivos offline escanean el mismo QR; reconectan en cualquier orden: **1** check-in vigente, el otro `duplicado_tardio`/`ya registrado`, tablero = 1 asistente. | TR-17, RF-13 |
| **AC-06** | El token de RSVP usado como check-in se rechaza por tipo; el **mismo QR** escaneado dos veces produce **1** admisión y el resto `ya registrado`. | TR-07, RF-03 |
| **AC-07** | 100 solicitudes concurrentes desde **100 eventos distintos** sobre el mismo `(trabajador, ventana)`: las 100 quedan `solicitada` (ninguna se rechaza por concurrencia). Con `plazas_ofrecidas = 1`, al aceptarse 2 en paralelo: **1** `aceptada`, la otra con conflicto determinista que nombra la ganadora. Con `plazas_ofrecidas = 6`, aceptar 4 y luego 4 más: la segunda se acepta con **2** plazas y devuelve 2; ninguna reserva posterior puede aceptar plazas, y `Σ plazas aceptadas solapadas` nunca supera 6. En ambos casos: **0 filas huérfanas** de pago o recordatorio, y el replay de una aceptación no crea una segunda reserva. | TR-08, RF-08, RF-17 |
| **AC-08** | 3 reintentos **y** 5 solicitudes concurrentes del pago con la misma clave: un cobro en el PSP (test) y exactamente una transacción de ledger con dos líneas balanceadas (suma 0). | TR-09, RF-11 |
| **AC-09** | El mismo webhook reenviado 3 veces y fuera de orden no altera el estado final ni crea entradas nuevas; timeout del PSP seguido de consulta por clave deja exactamente un cobro. | TR-09 |
| **AC-10** | 200 check-ins, uno por cada uno de 200 eventos del mismo planner con 1 840 eventos activos en el sistema, cliente consultando cada 1 s: `t_visible − t_ingest` ≤ 5 s p95 y ≤ 10 s p99, ambos relojes de servidor. | NFR-03, TR-05 |
| **AC-11** | Importar el mismo CSV dos veces: 0 invitados nuevos, 0 notificaciones nuevas. Un CSV con 1 fila sin email/teléfono y 1 duplicada interna devuelve 2 errores con línea y motivo, y 0 invitados creados para esas filas. | RF-02, TR-11 |
| **AC-12** | Confirmar el RSVP cancela el recordatorio pendiente; reprocesar el job no lo reenvía; declinar y volver a confirmar no reactiva un job cancelado. | RF-10, TR-12 |
| **AC-13** | Dos solicitudes concurrentes de la misma clave `(destinatario, plantilla, ventana)` producen **un** `InvitationDelivery`. | RF-04, TR-12 |
| **AC-14** | 50 asignaciones concurrentes a una mesa de 40: 40 aceptadas, 10 con conflicto, 0 sobrecapacidad; reintentar 3× la ganadora con la misma clave deja un solo asiento; mover concurrentemente al mismo invitado a 2 mesas da 1 ganadora; un RSVP que declina libera el asiento y devuelve capacidad. | TR-10, RF-12 |
| **AC-15** | Planner A no obtiene datos del planner B en tablero, roster, autocompletado ni check-in; un trabajador habilitado en A no obtiene datos de B; la consulta de disponibilidad devuelve solo `{worker_id, ventana_ocupada}`. | NFR-11, TR-13 |
| **AC-16** | Anular un check-in conserva el original, baja asistentes de N a N−1 en ≤ 5 s p95 sin tocar el total de invitados, un segundo intento es no-op y el re-escaneo vuelve a admitir. | RF-14 |
| **AC-17** | Un dispositivo con escaneos hechos **antes** del cierre reconecta después: 0 pérdidas, registros marcados `tardio` y contados en el consolidado. | RF-15, NFR-06 |
| **AC-18** | Evento cerrado hace 13 meses: la invitación no devuelve PII, el agregado y el ledger siguen intactos; a los 25 meses `CheckinEvent` no contiene `device_id`. | NFR-08 |
| **AC-19** | Restaurar el respaldo más reciente y reabrir la ingesta en ≤ 1 h con 0 check-ins ya ack'd perdidos. | NFR-06 |
| **AC-20** | Crear un evento sin nombre, fecha, zona horaria o venue responde un error determinista; un import que excede el aforo devuelve `AFORO_EXCEDIDO` con 0 invitados creados; el evento nuevo no aparece en el tablero de un no-miembro. | RF-01, NFR-11 |
| **AC-21** | Importar 200 invitados y no disparar el envío: 0 mensajes salen y 200 quedan `pendiente_envío`; disparar el envío genera exactamente 1 `InvitationDelivery` por invitado y canal; un segundo disparo sobre los mismos destinatarios no genera envíos nuevos salvo que sea un reenvío explícito. | RF-16, RF-04 |
| **AC-22** | Un trabajador acepta una solicitud y, en paralelo, otro evento solicita la misma ventana: la segunda **solicitud** queda `solicitada`; al intentar aceptarla responde conflicto nombrando la reserva ganadora; una solicitud sin respuesta en 48 h pasa a `expirada` y el trabajador vuelve a aparecer en la búsqueda. Aceptar una solicitud cuya ventana **no** está contenida en una `AvailabilityWindow` declarada responde error determinista y no cambia el estado. | RF-17, RF-08, RF-22 |
| **AC-23** | La página de la invitación abre sin cookie, sin sesión y desde otro dispositivo; se puede confirmar, declinar y volver a cambiar la respuesta; el QR sigue visible después de responder; ninguna de esas aperturas genera lecturas al origen por encima del hit de CDN de NFR-02. | RF-18, NFR-02 |
| **AC-24** | Dar de baja a un invitado ya enviado: su QR deja de admitir, sus recordatorios pendientes se cancelan, su RSVP y sus check-ins previos se conservan, y el aforo no cambia. | RF-20, NFR-08 |
| **AC-25** | Un trabajador se autorregistra, completa su perfil con categorías, tarifa y zonas, pero no verifica su teléfono: no aparece en ninguna búsqueda. Al verificar, aparece en los resultados de su categoría y zona. Un mismo teléfono intentando un segundo perfil es rechazado. | RF-19, RF-21, RF-07 |
| **AC-26** | El planner solicita con `costo_congelado = X`; el trabajador sube su tarifa a Y antes de aceptar; el cobro posterior es exactamente X y la reserva conserva X. | TR-20, RF-08, RF-11 |
| **AC-27** | En `en_curso`, un trabajador `aceptada` cancela: la reserva pasa a `cancelada`, el planner recibe alerta en ≤ 5 s, la búsqueda de reemplazo devuelve solo la misma ventana y rol, y sin candidato el requerimiento queda `sin_cubrir` con la cantidad faltante visible. | RF-09, RF-17, RF-22 |
| **AC-28** | Un evento cerrado hace 13 meses no devuelve PII de invitados, pero el `WorkerProfile` de quien trabajó en ese evento sigue existiendo con su teléfono y su tarifa, porque su actividad es posterior. | NFR-08, RF-21 |
| **AC-29** | Al cerrar un evento, toda reserva `aceptada` pasa a `completada` y `eventos_completados` del trabajador sube en exactamente 1 por reserva, sin escritura manual. | RF-08, RF-15, RF-21 |

---

## 9. Huecos cerrados

| # | Hueco detectado en la spec | Cierre |
| --- | --- | --- |
| 1 | "Staff" nunca se define | §1 + D3 |
| 2 | Ciclo de vida de la invitación sin estados | RF-03, RF-04, RF-05 |
| 3 | QR sin modelo de seguridad, revocación ni alcance del reenvío | RF-03, TR-06, TR-07, AC-06 |
| 4 | Asignación de proveedor sin ciclo de vida ni estados | RF-07, RF-08, RF-09, TR-08 |
| 5 | Pago sin flujo, clave de idempotencia ni conciliación | RF-11, TR-09, TR-14, AC-08, AC-09 |
| 6 | Mesas sin capacidad, concurrencia ni ciclo de vida del asiento | RF-12, TR-10, AC-14 |
| 7 | "Reservas" sin requisito padre | RF-08 + D2 |
| 8 | "Casi en tiempo real" sin cota ni reloj | NFR-03, AC-10 |
| 9 | "Mala o nula conectividad" sin límite | TR-02, NFR-04, AC-04 |
| 10 | Recordatorios sin disparador, clave ni cancelación | RF-10, TR-12, AC-12, AC-13 |
| 11 | Tenancy implícito sin modelo de autorización, y staff fuera de él | §1 D3, NFR-11, TR-13, AC-15 |
| 12 | PII sin retención **ni mecanismo de borrado** | NFR-07, NFR-08, AC-18 |
| 13 | Convergencia entre dispositivos offline | TR-17, AC-05 |
| 14 | Backlog offline sincronizado después del cierre | RF-15, AC-17 |
| 15 | Contador "pendiente de sincronizar" sin derivación | TR-18, RF-06 |
| 16 | Aforo y venue sin entidad ni invariante | RF-01, AC-20 |
| 17 | La asignación de proveedor no tenía aceptación: el planner decidía solo | RF-17, RF-08, TR-08, AC-22 (D7) |
| 18 | No había alta ni acceso para staff ni proveedor, ni forma de abrir sesión en el venue | RF-19, TR-19 |
| 19 | La página de la invitación no estaba especificada, aunque es la única superficie del invitado | RF-18, AC-23 |
| 20 | No había baja de invitado ni semántica para un QR ya emitido | RF-20, AC-24 |
| 21 | El perfil contratable no existía: `Provider` no tenía ni un campo, y `RF-07` filtraba por categoría, zona y disponibilidad que no existían en el modelo | RF-21, RF-22, §3 |
| 22 | "Staff" y "Proveedor" se solapaban: un mesero contratado no tenía superficie ni forma de ser contratado | D9, §1, RF-19 |
| 23 | La ocupación se calculaba solo en negativo: todo perfil era "disponible para siempre" | RF-22, `AvailabilityWindow` |
| 24 | La retención de NFR-08 habría borrado el teléfono de todo trabajador que vuelve al año siguiente | NFR-08 (alcance partido), AC-28 |
| 25 | `completada` no tenía disparador: ningún actor la marcaba | RF-08, RF-15, AC-29 |

Nota: los huecos 6 y 7 se cierran en el plano de capacidad y concurrencia; el ciclo de vida del asiento (declina, import posterior) se cierra en RF-12, no en TR-10.

---

## 10. Contradicciones resueltas

| Contradicción | Resolución |
| --- | --- |
| El QR era credencial de RSVP **y** de check-in (`README.md:3`) | Dos tokens por propósito (TR-07); el QR es bearer de **un solo uso**, así que reenviar la invitación no otorga una admisión extra (RF-03, AC-06) |
| "Sin conectividad" (`README.md:4`) vs. tablero "casi en tiempo real" (`README.md:5`) | La frescura se mide **desde `t_ingest`**, no desde el escaneo: el tiempo sin red se excluye y se reporta como antigüedad del backlog (NFR-03, TR-18) |
| Dos dispositivos offline pueden admitir al mismo invitado | Convergencia server-side por `recibido_en`; el segundo queda `duplicado_tardio` (TR-17, AC-05) |
| `README.md:17` dice que el replay va **sobre** el pico, y NFR-01 lo mete en el mismo presupuesto | El drenaje del replay es **diferible**: se espacia hasta no competir con la ingesta viva; se atrasa la sincronización, nunca se pierde un veredicto (§6.6) |
| Cerrar el evento rechazando escrituras vs RPO 0 y "0 pérdidas" | `cerrado` es solo lectura y no rechaza replay escaneado dentro de la ventana (RF-15, AC-17) |
| CDN cacheado (`README.md:18`) vs mostrar el RSVP recién enviado | El estado del RSVP viaja en la respuesta del POST, nunca en un GET (NFR-02) |
| Búsqueda de proveedores por disponibilidad (cross-planner) vs aislamiento (NFR-11) | Excepción explícita y acotada: solo `{proveedor_id, ventana_ocupada}` (NFR-11, AC-15) |
| "Reservas" sin requisito padre (`README.md:20`) | RF-08: reserva de proveedor con invariante cross-evento (D2) |
| D3 decía "invitado y proveedor sin cuenta" vs D7: el proveedor sí tiene cuenta | D7 manda y D3 queda como historia (§13). El invitado sigue sin cuenta: eso no cambió |
| NFR-11 con un planner único vs colaboración (P10 → D8) | `EventMembership` con `owner`/`editor`: el aislamiento es por membresía, no por `planner_id` |
| Un proveedor debe aceptar (D7) vs el invariante de "sin reservas solapadas" | Solo la reserva `aceptada` ocupa la ventana; las solicitudes pueden solaparse (RF-08, TR-08) |
| RF-19 decía "el planner es el único que se autorregistra" vs el autorregistro de trabajadores | RF-19 reescrito: se autorregistran planner **y** trabajador; el invitado nunca (D9) |
| El perfil público es cross-planner vs NFR-11 | Segunda excepción explícita con lista blanca de campos y sin contacto (NFR-11) |
| Un trabajador contratado debería poder escanear vs el escaneo era un tipo de actor | El escaneo es un permiso por evento (`StaffAssignment`), nunca una propiedad del perfil (§1, D9) |
| Precio publicado "desde" vs monto a cobrar | `costo_congelado` inmutable al solicitar; el pago lee ese campo (TR-20, AC-26) |
| NFR-08 borraba la PII del trabajador con el evento | Alcance partido: filas de evento vs perfil (NFR-08, AC-28) |
| D9 fijó `plazas = 1` vs D10: empresa con N plazas | D10 manda: la reserva lleva `plazas` y la aceptación puede ser parcial; TR-08 pasa a CAS sobre la suma (RF-08, AC-07) |

---

## 11. Parámetros configurables y sus defaults

Todo número que la spec no fija es **configurable**; estos son los defaults de la primera versión.

| Parámetro | Default | Requerimiento |
| --- | --- | --- |
| Frescura objetivo del tablero | 5 s p95 / 10 s p99 | NFR-03 |
| Autonomía offline del escáner | 8 h / 1 000 escaneos | TR-02 |
| Roster por sesión de escaneo | 2 000 invitados, ≤ 5 eventos | NFR-04 |
| Tamaño de lote de replay | 500 eventos | TR-03 |
| Drenaje de backlog | 8 000 eventos en ≤ 120 s | §6.6 |
| Venues reconectando a la vez | 20 (× 2 eventos × 200 invitados) | §6.6 |
| Vigencia de la lista de revocación | 2 h | TR-06 |
| Filas por archivo de import | 20 000 | RF-02 |
| Reintentos de notificación | 3, luego `rebotado` | RF-04 |
| Timeout a `indeterminado` | 15 min | RF-04 |
| Recordatorio RSVP | T-7 d y T-1 d | RF-10 |
| Recordatorio de llegada | T-24 h y T-2 h | RF-10 |
| Corrección de check-in | 24 h post-cierre | RF-14 |
| Retención de PII | 12 meses post-evento | NFR-08 |
| Retención de check-in, auditoría y ledger | 24 meses | NFR-08 |
| Propagación del borrado a réplicas y respaldos | ≤ 30 días | NFR-08 |
| Eventos por pantalla del tablero | 25, paginado | NFR-10 |
| Expiración del token de invitación de staff/proveedor | 72 h | RF-19 |
| Expiración de una solicitud de proveedor sin respuesta | 48 h | RF-17 |
| Código corto de check-in | 6 dígitos | RF-13 |
| Máximo de invitados por disparo de envío | 20 000 (mismo límite del import) | RF-16 |
| Categorías por perfil | ≥1, ≤3 | RF-21 |
| Zonas por perfil | ≥1, ≤5 | RF-21 |
| Radio máximo de desplazamiento | 150 km | RF-21 |
| Verificación de trabajador | email + OTP por SMS | RF-19 |
| SLA de respuesta en emergencia | 15 min (o `fin_ventana − ahora`, el menor) | RF-17 |
| Expiración de solicitud sin respuesta | 48 h | RF-08 |
| Plazas por perfil `empresa` | 1–50 | RF-21 |
| Canales activos de notificación | SMS + email (los dos) | RF-04, D11 |
| Tarifa SMS asumida | ~$0.006–$0.10 por mensaje (MX) | D11 |

---

## 12. Alcance MVP

Gate explícito. **No había gate en v1** y era el hueco de alcance más grave: sin él, "mínimo viable" no significa nada.

| ID | Gate | Razón |
| --- | --- | --- |
| RF-01 | **must** | unidad de partición, aislamiento y corte |
| RF-02 | **must** | `README.md:3` literal |
| RF-03 | **must** | `README.md:3`: el QR es la credencial de admisión |
| RF-04 | **must** | `README.md:10`; sin entrega no hay RSVP |
| RF-05 | **must** | `README.md:3`: "confirma sin crear cuenta" |
| RF-06 | **must** | `README.md:5`; es el fan-out de `README.md:20` |
| RF-07 | **must** | es una de las tres dimensiones del negocio (capacidades, costos, lugares) y el planner no puede contratar sin buscar |
| RF-08 | **must** | sin solicitud y aceptación no hay contratación, que es el segundo pilar del producto (D9) |
| RF-09 | **should** | la emergencia en el evento es valiosa pero no bloquea el ciclo de contratación planificada |
| RF-10 | **should** (solo recordatorio de RSVP) / **post-MVP** (llegada de proveedor, depende de RF-08) | `README.md:7` es literal, pero la mitad de proveedor no existe sin reservas |
| RF-11 | **nice-to-have** | cobra contra una reserva `aceptada`, que es de RF-08; el flujo debe existir y funcionar, pero no ordena el MVP (D5) |
| RF-12 | **should** | `README.md:9`; es la mitad contenida del problema de concurrencia |
| RF-13 | **must** | `README.md:4`; es el problema #1 de `README.md:20` |
| RF-14 | **should** | `[inferencia]`, pero sin anulación un error de escaneo es irreversible |
| RF-15 | **post-MVP** | consolidado de solo lectura; barato, no bloquea nada |
| RF-16 | **must** | sin disparo de envío no hay invitación, y el import no envía nada (P03) |
| RF-17 | **must** | sin consola de aceptación, la solicitud nunca se resuelve y no hay contratación |
| RF-18 | **must** | es la única superficie del invitado |
| RF-19 | **must** | sin login ni autorregistro no hay producto ni catálogo |
| RF-20 | **should** | sin baja, un QR emitido por error no se puede revocar |
| RF-21 | **must** | el perfil es lo que hace contratable al trabajador (D9) |
| RF-22 | **must** | sin disponibilidad declarada, la búsqueda devuelve a todos y ninguna aceptación es válida |
| NFR-01, 01b, 02 | **must** | son el objetivo de diseño de `README.md:16,18` |
| NFR-03 | **must** (el reloj y el mecanismo); el valor 5 s es calibrable | sin read model desacoplado, NFR-01 no se sostiene |
| NFR-04, NFR-05, NFR-06 | **must** | el check-in offline es el núcleo del producto |
| NFR-07 | **must** | tokens y PII no son diferibles |
| NFR-08 | **should** | el borrado puede entrar con el primer evento real, no antes |
| NFR-09 | **should** (check-in, frescura, conflictos de reserva); el resto post-MVP | evita un tablero ciego |
| NFR-10, NFR-11 | **should** / **must** | rendimiento diferible; aislamiento no |
| TR-01 a TR-08, TR-11 a TR-13, TR-15 a TR-18 | **must** dentro de su RF | sin ellos el RF correspondiente no es correcto, solo aparente |
| TR-09, TR-14 | **nice-to-have**, detrás de RF-11 | el ledger y el adaptador PSP no existen sin pagos, pero el puerto y su contract test se definen ahora |
| TR-10 | **must** si RF-12 es should | invariante de capacidad |

**El MVP tiene dos pilares, no uno (D9).** Pilar A, el ciclo del invitado: crear → importar → enviar → RSVP → check-in → tablero en vivo. Pilar B, el ciclo de contratación: perfil → buscar → solicitar → aceptar → cubrir requerimientos. Los dos son `must` porque el usuario definió el producto como gestión del evento *y* contratación de trabajadores con perfil. Lo que sigue fuera del MVP es el dinero: pagos (D5), reputación con puntajes, cuadrillas o empresas con varias plazas, y automatización de reemplazo.
**Costo que hay que ver de frente:** dos pilares duplican la superficie del MVP (dos consolas, dos ciclos de estado, dos conjuntos de notificaciones). **Secuencia decidida (D10): los dos pilares avanzan en paralelo**, pero sobre una **base compartida que se termina antes de bifurcar** — autenticación (RF-19), modelo de evento (RF-01), membresía (NFR-11) y esquema de datos de ambos pilares. Sin esa base, en paralelo significa dos veces el retrabajo. Recortar RF-13 sigue sin ser opción: es el problema central de `README.md:20`.

---

## 13. Log de decisiones

**L1 — Pedido original (verbatim):**
> "quiero que lanses 3 agentes para explorar y entender los requerimeitnos principales y más importantes del proyuecto"

**L2 (verbatim):**
> "quiero que primero terminemos por definir estos requerimientos técnicos para que no exista ningún gap"

**L3 (verbatim):**
> "quiero que corras 15 subagentes que chequen los requerimeitnos funcionales y no funcionales y que busquen su consistencia para un producto mínimo biable siempre deja la info como un punto único de verdad y de modificación en este repositorio independientemente a que tu guardes información que te sirve en el engram"

**D1 — Pagos.** Decisión del usuario (verbatim):
> "por a hora los pagos queremos manejarlos con paipal o con stripe y solo integrarlo para que funcione en modo de pruevas pero que el flujo de la aplicación esté corriendo"

Fijado: PSP detrás de puerto, **un adaptador en el MVP** (la disyunción del usuario era "o", no "ambos"), flujo end-to-end real en modo test, ledger propio. El segundo adaptador es post-MVP.

**D2 — "Reservas".** Decisión del usuario (verbatim):
> "tu desidelo corriendo dos agsub agentes"

El usuario **delegó la decisión**, no la tomó: no hay decisión del usuario sobre el contenido. Resultado derivado por dos revisores independientes, que convergieron: `reservas` = reserva de proveedor para una ventana dentro del evento, con invariante cross-evento. Rechazadas por ambas lentes: RSVP (sin recurso escaso: el QR único ya lo resuelve y la idempotencia es el problema #2 de `README.md:20`) y reserva de venue (la spec nunca selecciona venues). Fijado en RF-08, RF-09, TR-08. **Es una inferencia arquitectónica, no un requisito literal de la spec.**

**D3 — Staff.** Decisión del usuario (verbatim):
> "tu desidelo lo importante es que los invitados no tienen que tener cuenta solo los de staf y el even planer"

Fijado: cuentas solo para planner y staff; invitado y proveedor sin cuenta; staff habilitado por evento, sin lectura global.

**D4 — Frescura (decisión de ingeniería, no del usuario):** ≤ 5 s p95, calibrable (§11). El usuario eligió el valor entre las opciones ofrecidas; el reloj de medición lo fija NFR-03, no D4.

**L4 — Pedido del usuario (verbatim):**
> "bien los pagos a probedores lo podemos dejar como un nice to have que si es conveniente que lo analices a hora dime si notas alguna otra inconsistencia o duda que impida o confunda el desarrollo del proyectoo o su inicio quiero que todas las funciones principales queden claras al final es el even planer el que gestionará la mayoría de la aplicación que en este caso será una aplicación web no abrá aplicación mobile"

**D5 — Pagos como nice-to-have.** Verbatim: *"los pagos a probedores lo podemos dejar como un nice to have"*. Se conserva la definición completa (RF-11, TR-09, TR-14, AC-08, AC-09) porque el flujo debe funcionar en modo test, pero **sale del orden de construcción**: lo que se construye ahora es el puerto `PaymentProvider`, su contract test y el esquema del ledger, no la integración.
Lo que **no** se construye ni decide ahora: KYC, split de comisiones, reversos productivos, moneda, y a quién se le cobra en el flujo real. Eso queda como `[inferencia]` pendiente hasta que el pago entre en alcance.

**D6 — Plataforma.** Verbatim: *"será una aplicación web no abrá aplicación mobile"* y *"es el even planer el que gestionará la mayoría de la aplicación"*. Fijado en §1.1. Desvía de `README.md:12` solo en apariencia: "apps nativas" excluidas ya estaba en la spec; acá se explicita que tampoco habrá app mobile de ningún tipo, y que el escaneo ocurre en el navegador del teléfono.

**L5 — Pedido del usuario (verbatim):**
> "el estaf y el proprobedor si tienen cuenta en la plataforma y ellos tienen que aseptar el trabajo por ejemplo de meseros en el evento acceden también atraves de un código qr así como los invitados"

**D7 — Proveedor con cuenta y aceptación del trabajo.** Verbatim en L5. **Deroga parcialmente D3**: el proveedor pasa a tener cuenta, recibe solicitudes y **acepta o rechaza**; staff y proveedor pueden entrar por QR de acceso al evento. Consecuencias que este documento absorbe: RF-08 cambia de "reserva unilateral" a `solicitada → aceptada`, TR-08 pasa a exigir exclusión solo sobre `aceptada`, se agrega RF-17 (consola del proveedor) y RF-19 (alta y acceso), y NFR-11 pasa de aislamiento por planner a aislamiento por membresía.
Esto **no** está en `README.md`: la spec dice "los planners pueden buscar proveedores y asignarlos al evento", que es asignación unilateral. La aceptación es una **decisión del usuario**, no una derivación. Su costo real es que el problema de concurrencia de `README.md:20` cambia de forma: ya no es solo "dos planners, un proveedor", sino "N solicitudes pendientes y una aceptación que serializa".

**L6 — Pedido del usuario (verbatim, respuestas del cuestionario):**
> "El planner dispara el envío"
> "Navegador del teléfono (PWA)"
> "Colegas con permiso de edición"

**D8 — Decisiones de ingeniería (no del usuario), tomadas para cerrar §16:**

| Pregunta | Resolución | Dónde vive |
| --- | --- | --- |
| P01 autenticación del planner | email + contraseña con verificación, sesión `httpOnly`, recuperación por email | RF-19 |
| P05 página de la invitación | contenido, QR, confirmar/declinar, cambio de respuesta | RF-18 |
| P06 fallback sin cámara | búsqueda por nombre + código corto de 6 dígitos | RF-13 |
| P07 invitado fuera del roster | veredicto `no_en_roster`, admisión manual marcada | RF-13 |
| P08 staff con dos eventos | una sesión de escaneo = un evento | TR-19 |
| P09 zona horaria | `Event.timezone` obligatoria; servidor en UTC | RF-01 |
| P11 estados del evento | `borrador → publicado → en_curso → cerrado` + `cancelado` | RF-01 |
| P12 baja de invitado | borrado lógico, revoca token, cancela jobs, conserva historial | RF-20 |
| P02 alta de staff (usuario) | invitación por email, token de un solo uso 72 h, o QR de acceso al evento | RF-19 |
| P03 envío de invitaciones | el planner dispara; el import no envía | RF-16 |
| P10 varios planners | `EventMembership` con `owner` y `editor` | NFR-11, §3 |

**L7 — Pedido del usuario (verbatim):**
> "quiero que también quede claro que la plataforma ayuda a la gestión del evento que el estaf de por ejemplo mesetros maquillistas etc. se puede registrar en la plataforma establesiendo un perfil que después los event planers pueden contratar para el evento considerando sus capasidades costos y lugares"

**D9 — Un solo actor contratable con perfil (deroga el resto de D3 y absorbe D7).** El usuario llama "staff" a meseros y maquillistas, y pide que **se registren solos** estableciendo un perfil que el planner contrata por capacidades, costos y lugares. Eso obliga a tres movimientos:

1. **Un solo actor**: `worker`. `Proveedor` deja de ser un actor y pasa a ser la etiqueta de la UI para quien vende trabajo. Un mesero y un fotógrafo son el mismo tipo de actor con distintas categorías. Costo de equivocarse: si el negocio resulta ser "empresas con cuadrilla", se paga un `WorkerOrganization` y la aceptación se vuelve multi-parte; si se modelan dos actores y no hacía falta, se paga una identidad partida para la misma persona, que no se puede reconstruir después.
2. **El escaneo no es un actor, es un permiso**: `StaffAssignment` por evento. Esto preserva RF-13 sin cambios, porque el escaneo ya estaba delegado y no era propiedad de nadie.
3. **El perfil es público, los datos de contacto no**: segunda excepción de NFR-11 con lista blanca de campos.

Lo que D9 **sí** agrega al alcance, y conviene tener presente: taxonomía cerrada de categorías, disponibilidad declarada, verificación por OTP, congelamiento de precio, y un catálogo cruzado entre planners. Lo que **no** decide: si el trabajo se paga de verdad (D5 lo deja en test) ni si hay reputación con puntajes (no, en el MVP). Las empresas quedan fuera de D9 y entran por D10.

**L8 — Pedido del usuario (verbatim, respuestas del cuestionario):**
> "Persona o empresa en el mismo perfil"
> "Precio fijo con unidad"
> "Zonas declaradas + radio"
> "Los dos en paralelo"

**D10 — Persona o empresa, y dos pilares en paralelo.**

1. **`WorkerProfile.tipo ∈ persona \| empresa`** en el mismo perfil, con `plazas_ofrecidas` (default 1; solo empresa declara más). Esto **reabre `plazas`**, que D9 había fijado en 1: la reserva vuelve a llevar cantidad, la aceptación admite ser **parcial**, y TR-08 pasa de exclusión binaria a *compare-and-set* sobre la suma de plazas del agregado `(worker_id, ventana)`. Costo concreto: el invariante de concurrencia deja de ser "uno gana" y pasa a ser "suma acotada", que es la versión difícil. AC-07 cubre las dos formas.
2. **Costo**: precio fijo con `unidad ∈ hora \| persona_hora \| evento`; una empresa suele publicar por `evento` o `persona_hora`, una persona por `hora`. Se mantiene el congelamiento en la solicitud (TR-20).
3. **Lugares**: zonas declaradas (lista cerrada, ≥1, ≤5) más `radio_km` opcional. La distancia solo **ordena** el subconjunto ya filtrado por zona; nunca se hace haversine sobre el catálogo completo.
4. **Secuencia**: los dos pilares en paralelo, sobre una base compartida que se termina primero (auth, evento, membresía, esquema). Riesgo declarado y aceptado: dos consolas y dos ciclos de estado a la vez; el control es que la base no se bifurca hasta estar completa.

**L9 — Pedido del usuario (verbatim):**
> "quiero que los sms seán para los invitados y para los recordatorios del evento tanto para invitados como para el staf de pleferencia si todo se puede duplicar por mensajes y correo estaria mucho mejor"

**D11 — SMS y email en paralelo, sin canal preferido.** Todo aviso sale **duplicado por SMS y por email**: invitación (RF-16), recordatorio de RSVP al invitado y de llegada al trabajador (RF-10), y OTP de verificación (RF-19). No hay canal preferido: los dos se encolan siempre y el estado se mide por canal; el fallo de uno no bloquea el otro.

**Costo que esta decisión acepta, sin adornos:** 4 M invitados/mes por dos canales. El SMS a esa escala es **el rubro dominante de la factura** — entre ~$25 000 y ~$400 000/mes según tarifa por mensaje, alrededor del **85 % del costo total estimado**. Es una decisión de producto y **manda sobre la optimización de costo**; queda registrada como riesgo aceptado, no como defecto de diseño. Si algún día hay que recortar, el parámetro `canales_activos` (§11) permite apagar SMS sin tocar el modelo.

**Consecuencia técnica:** `InvitationDelivery` y `ReminderJob` pasan a tener **una fila por aviso y por canal**, y la clave de deduplicación de TR-12 pasa a `(destinatario, plantilla, ventana, canal)`. Sin ese cuarto componente, el segundo canal sería rechazado como duplicado del primero.

---

## 14. Revisión de consistencia

Quince revisores independientes, slices disjuntos: cada RF y cada NFR quedó cubierto exactamente una vez. **108 hallazgos consolidados, 14 bloqueantes**, todos aplicados o rechazados con razón en este mismo archivo.

| # | Cluster | RF/NFR cubiertos | Hallazgos | Bloqueantes |
| --- | --- | --- | --- | --- |
| 1 | Evento e import | RF-01, RF-02, TR-11, TR-16 | 8 | 0 |
| 2 | Invitación y QR | RF-03, TR-06, TR-07, NFR-07 | 6 | 1 |
| 3 | Entrega y recordatorios | RF-04, RF-10, TR-12 | 10 | 1 |
| 4 | RSVP y lecturas | RF-05, NFR-02 | 7 | 0 |
| 5 | Tablero y frescura | RF-06, NFR-03, NFR-10, TR-05, TR-13 | 8 | 3 |
| 6 | Reserva de proveedor | RF-07, RF-08, RF-09, TR-08 | 9 | 2 |
| 7 | Pagos y PSP | RF-11, TR-09, TR-14, NFR-08 | 9 | 1 |
| 8 | Mesas y seating | RF-12, TR-10 | 6 | 2 |
| 9 | Check-in offline | RF-13, TR-01 a TR-04, NFR-04 a NFR-06 | 8 | 2 |
| 10 | Corrección y cierre | RF-14, RF-15 | 7 | 1 |
| 11 | Capacidad y presupuesto de escritura | NFR-01, §6 | 9 | 1 |
| 12 | Durabilidad, retención, PII | NFR-05, NFR-06, NFR-08 | 6 | 0 |
| 13 | Observabilidad y aislamiento | NFR-09, NFR-10, NFR-11 | 6 | 0 |
| 14 | Trazabilidad y alcance | §7, §9, §12, citas globales | 9 | 0 |
| 15 | Tablero (relanzado por falla de rate limit) | RF-06, NFR-03, NFR-10 | 8 | 3 |

### Bloqueantes corregidos

1. **NFR-01 era imposible**: 250/s × 30 min = 450 000 escrituras, más que las 368 000 llegadas del sábado. Corregido a 222/s (§6.1).
2. **Dos dispositivos admitían al mismo invitado**, y la clave de idempotencia por dispositivo no podía deduplicar entre dispositivos. Corregido con TR-17 y AC-05.
3. **El replay posterior al cierre se descartaba**, perdiendo admisiones reales contra NFR-06 y AC-04. Corregido en RF-15 y AC-17.
4. **La idempotency key del pago incluía el contador de intento**, así que cada reintento era un cobro nuevo. Corregido en TR-09.
5. **La restricción de exclusión de reservas impedía re-reservar tras cancelar** y no definía estados. Corregido en TR-08 y RF-08.
6. **RF-09 no era implementable**: "cancela la reserva existente" podía ser la de otro planner, prohibido por NFR-11. Corregido con `sin_cubrir` y cancelación acotada al propio evento.
7. **El contador "pendiente de sincronizar" no tenía derivación** y el backend no puede contar lo que no recibió. Corregido con TR-18.
8. **NFR-03 no tenía reloj**: con la durabilidad en el dispositivo, el p95 de 5 s era irrealizable por diseño. Corregido a `t_ingest → t_visible`.
9. **AC-07 pedía el tablero "de otro planner"**, violando NFR-11. Corregido al planner dueño.
10. **AC-10 era vacuo**: 50 asignaciones a una sola mesa no podían probar "ningún invitado en dos mesas". Corregido.
11. **RF-12 no definía el ciclo de vida del asiento** (declina, import posterior). Corregido.
12. **La revocación offline no estaba resuelta** y el QR podía admitirse 8 h después de revocado. Corregido con `no verificable offline` y `invalidado_al_sincronizar`.
13. **La clave de notificación tenía tres formas distintas** (2-tupla en RF-04, 3-tupla en TR-12, ninguna en RF-10), y la 2-tupla colapsaba T-7 y T-1. Corregido a una sola clave con `ventana` definida.
14. **NFR-01 y §6.1 se contradecían** sobre el multiplicador ("no 3× ni 5×" cuando 222/74 = 3,0 exacto). Corregido.

### Rechazados o reformulados

| Hallazgo | Origen | Razón |
| --- | --- | --- |
| "El QR no viaja en el mensaje; se emite desde la sesión de escaneo" | cluster 2 | **Rechazado**: el invitado necesita el QR para entrar, y `README.md:3` dice que la invitación lo contiene. Se conserva el problema real y se resuelve distinto: bearer de un solo uso + dos tokens por propósito (RF-03, AC-06) |
| "Eliminar RF-15 por completo" | cluster 10 | **Reformulado**: sin corte no hay consolidado ni no-show. Se conserva como post-MVP de solo lectura, sin rechazar escrituras |
| "El objetivo de la ráfaga sube a 700/s" | cluster 11 | **Rechazado**: el objetivo no sube; el drenaje del replay es diferible y se espacia (§6.6) |
| "NFR-10 con 10 eventos por pantalla" | clusters 5 y 14 | **Reformulado a 25**: `README.md:15` da 4 eventos/mes por planner; 25 cubre seis meses de actividad con paginación |
| "Eliminar el historial de respuestas RSVP" | cluster 4 | **Aceptado** como `superseded_at` en log, sin requisito de consulta |
| "Un incidente por mes" como límite de disponibilidad | cluster 12 | **Reformulado**: no se limita el número de incidentes, se acota el RTO y se define la superficie medida |

---

## 15. Cómo se modifica este documento

1. Este archivo es el único lugar donde se cambian los requerimientos. Una modificación incluye siempre: el `RF`/`NFR`/`TR` afectado, su fila de `AC` y el parámetro de §11 si cambia un número.
2. Los cambios se registran en §13 como `L#` con el pedido verbatim, no como resumen.
3. Una decisión de producto nueva entra como `D#` con la cita verbatim del usuario; si el usuario delegó la decisión, se registra como **delegada** y el resultado se marca `[inferencia]`, nunca como decisión suya.
4. `README.md` no se edita: es el origen histórico. Toda corrección vive acá y se referencia por línea.
5. Una revisión nueva agrega su fila en §14 y no reescribe las anteriores: el historial de hallazgos es parte del documento.
6. Ninguna memoria externa, nota o herramienta sustituye este archivo como fuente de verdad.

---

## 16. Preguntas abiertas

**Ninguna.** Las doce se resolvieron: P02, P03 y P10 por decisión del usuario (L5, L6, D7, D8); P01, P05, P06, P07, P08, P09, P11 y P12 por decisión de ingeniería registrada en D8, cada una promovida al requisito que le corresponde. La tabla de abajo se conserva como historial de qué se preguntó y cómo se cerró.

| # | Duda | Por qué bloquea | Propuesta |
| --- | --- | --- | --- |
| **P01** | Cómo se autentica el planner | Es la primera pantalla del producto y no existe en ningún RF | Email + contraseña con verificación por email, sesión en cookie `httpOnly`, recuperación por email. Sin OAuth en el MVP |
| **P02** | Cómo nace la cuenta del staff | D3 exige cuenta, pero nadie dice quién la crea; sin eso, RF-13 no arranca | **Resuelto (D7, D8):** el planner invita por email (token de un solo uso, 72 h) o por QR de acceso al evento. El proveedor, igual (RF-19) |
| **P03** | ¿El import envía las invitaciones? | RF-02 hoy encola la entrega al importar; el planner suele querer revisar antes. Cambia el flujo principal | **Resuelto (usuario):** el planner dispara el envío. El import deja `pendiente_envío` (RF-16) |
| **P04** | Reenviar una invitación choca con "nunca doble envío" | RF-04 deduplica por `(destinatario, plantilla, ventana)`; un reenvío manual tendría la misma clave y se bloquearía solo | El reenvío manual es un job nuevo con `ventana = resend_n` explícito; el dedupe sigue protegiendo el envío automático |
| **P05** | Qué muestra la página de la invitación | Es la única superficie del invitado y no está especificada más allá del QR | Datos del evento, QR renderizado, botones confirmar/declinar, estado de la respuesta y opción de cambiarla |
| **P06** | Qué hace el staff si la cámara falla o el QR está roto | RF-13 solo define el camino feliz; un permiso denegado deja el venue sin check-in | Fallback manual: búsqueda por nombre y código corto de 6 dígitos impreso en la invitación |
| **P07** | Invitado que no está en el roster offline | Un invitado importado después de precargar el roster no existe localmente; el veredicto actual sería `no corresponde al evento`, que es falso | Veredicto `no_en_roster` con admisión manual condicional, marcada para revisión al sincronizar |
| **P08** | Un staff asignado a dos eventos del mismo venue | La sesión de escaneo no dice a qué evento pertenece cada escaneo | Una sesión de escaneo = un evento. Si el staff tiene varios, elige al abrir; el roster y la secuencia son por sesión |
| **P09** | Zona horaria del evento | Sin `timezone`, la ventana, los recordatorios y la convergencia por `recibido_en` se calculan mal en cualquier producto multi-ciudad | `Event.timezone` obligatoria; el servidor guarda UTC y la UI muestra la zona del evento |
| **P10** | ¿Puede haber más de un planner por evento? | Hoy `Event.planner_id` es único; si hay equipos, el aislamiento de NFR-11 se rompe el día que se agregue | **Resuelto (usuario):** colegas con permiso de edición mediante `EventMembership` (NFR-11, §3) |
| **P11** | Estados del evento | Se usan `borrador`, `abierto` y `cerrado` sin definirlos; sin máquina de estados, RF-01 y RF-15 no son implementables | `borrador → publicado → en_curso → cerrado` más `cancelado`; solo `publicado` y `en_curso` aceptan envíos y check-in |
| **P12** | Borrado de un invitado por el planner | No hay semántica de baja: si se borra, ¿se revoca el QR? ¿se cancela el recordatorio? | Borrado lógico (`deleted_at`): revoca el token, cancela jobs pendientes, conserva los check-ins ya registrados y el QR deja de admitir |

**Estado:** cerradas las doce. P02, P03 y P10 por decisión del usuario; el resto por D8. No queda ninguna pregunta abierta que impida empezar a construir. Los detalles que todavía no están fijados son parámetros (§11), no decisiones de producto.