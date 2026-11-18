# 05 — API de consola del trabajador y check-in offline

Superficies de este documento (y solo estas): **consola del trabajador**, **check-in offline** (roster precargado, lotes de escaneo, lista de revocación), **reemplazo de emergencia** y **anulación de check-in**. Fuente: `docs/requerimientos.md` (§1, §2 RF-07/08/09/11/13/14/17/21/22, §5 TR-01..06/08/09/17..20, §11).

## Convenciones transversales

- **Base path** `/v1`. **Auth**: cookie `httpOnly` (`SameSite=Lax; Secure`) como mecanismo primario en consola web (RF-19) y `Authorization: Bearer <jwt>` soportado para la PWA de escaneo y clientes API/tests; el **QR de acceso al evento** (RF-19, TR-19) se canjea por un **token de sesión con alcance** `(event_id, rol, device_id)` que expira con el evento.
- **Envelope de error**: `{"error":{"code":"UPPER_SNAKE","message":"...","details":{}}}`. Códigos canónicos unificados con `03a`: `AUTH_REQUIRED` (`401`), `NOT_FOUND` (`404`, sin relación previa con el recurso), `FORBIDDEN_EVENT_SCOPE` (`403`, relación previa revocada/expirada), `VALIDATION_ERROR` (`422`), `PROFILE_NOT_VERIFIED`, `WINDOW_NOT_AVAILABLE` (`422`), `RESERVATION_OVERLAP` (`409`), `RESERVATION_NOT_PENDING` (`409`), `RESERVATION_NOT_ACCEPTED` (`409`), `PLAZAS_INVALIDAS` (`409`), `REQUEST_EXPIRED` (`410`), `CHECKIN_NOT_FOUND` (`404`), `CORRECTION_WINDOW_CLOSED` (`409`), `BATCH_TOO_LARGE` (`413`), `BATCH_CHECKSUM_MISMATCH` (`400`), `BATCH_OUT_OF_ORDER` (`400`), `IDEMPOTENCY_CONFLICT` (`409`), `RATE_LIMITED` (`429`).
- **Paginación** `?limit=&cursor=` (`limit` ≤ 100, default 20); respuesta `{"items":[...],"next_cursor":null}`.
- **Idempotencia**: todo `POST` no idempotente acepta `Idempotency-Key`. Misma clave + mismo cuerpo = replay (misma respuesta, mismo `2xx`); misma clave + cuerpo distinto = `409 IDEMPOTENCY_CONFLICT`. Toda colección devuelve `event_id` y respeta NFR-11 (aislamiento por `EventMembership`/`StaffAssignment`).

## 1. Consola del trabajador (y lecturas del planner que la sostienen)

> Nota de superficie (`03-api.md` §3.e): la gestión de requerimientos del evento (`PUT`/`GET /v1/events/{event_id}/requirements`) y la creación/consulta de solicitudes de contratación (`POST`/`GET /v1/events/{event_id}/worker-requests`) viven exclusivamente en [`03a-api-planner-invitado.md`](./03a-api-planner-invitado.md).

| Método | Ruta | Auth | Request | Response 2xx | Errores | Idempotente | RF |
| --- | --- | --- | --- | --- | --- | --- | --- |
| POST | `/v1/auth/worker/register` | público | `{email, password, tipo}` | `201 {user_id, estado_email:"pendiente"}` | `VALIDATION_ERROR` | No (`Idempotency-Key`) | RF-19 |
| POST | `/v1/auth/event-session` | público (QR de acceso) | `{access_token, device_id}` | `200 {session_token, event_id, rol, expira_en}` | `AUTH_REQUIRED` | Sí (mismo QR ⇒ misma sesión vigente) | RF-19, TR-19 |
| POST | `/v1/worker/profile` | worker | `{tipo, nombre_publico, plazas_ofrecidas, categorias[], servicios[], tarifa, zonas[], radio_km, idiomas[], años_experiencia}` | `201 {worker_id, estado:"borrador"}` | `VALIDATION_ERROR`, `FORBIDDEN_EVENT_SCOPE` | No (`Idempotency-Key`) | RF-21 |
| GET | `/v1/worker/profile` | worker | — | `200 {perfil, verificado:{email,telefono}}` | `AUTH_REQUIRED` | Sí (lectura) | RF-21 |
| PATCH | `/v1/worker/profile` | worker | subconjunto de campos editables | `200 {perfil}` | `VALIDATION_ERROR` | Sí (idempotente por cuerpo) | RF-21 |
| POST | `/v1/worker/profile/verifications` | worker | `{canal:"email"\|"telefono"}` | `202 {desafio_id, expira_en}` | `VALIDATION_ERROR` | No (`Idempotency-Key`) | RF-19, RF-21 |
| POST | `/v1/worker/profile/verifications/{desafio_id}/confirm` | worker | `{codigo_otp}` | `200 {verificado:true, visible_en_busqueda:true}` | `VALIDATION_ERROR` | Sí | RF-19, AC-25 |
| POST | `/v1/worker/profile/publish` \| `/suspend` | worker | — | `200 {estado:"publicado"\|"suspendido"}` | `PROFILE_NOT_VERIFIED` | Sí | RF-21 |
| GET | `/v1/workers` | planner | query `categorias[]` (AND), `zonas[]`/`radio_km`, `tarifa_min`/`tarifa_max`/`unidad`, `desde`/`hasta` | `200 {items:[{worker_id, nombre_publico, categorias, tarifa, zonas, idiomas, eventos_completados}]}` | `VALIDATION_ERROR` | Sí (lectura) | RF-07 |
| GET | `/v1/workers/{worker_id}` | planner | — | `200 {perfil_publico}` (lista blanca, sin contacto) | `NOT_FOUND` | Sí | RF-07, NFR-11 |
| GET | `/v1/workers/{worker_id}/availability` | planner / worker | `?desde=&hasta=` | `200 {worker_id, ventana_ocupada:[{inicio,fin}]}` | `VALIDATION_ERROR` | Sí | RF-07, NFR-11 (exc. 1) |
| GET | `/v1/worker/availability` | worker | `?desde=&hasta=` | `200 {items:[{window_id, inicio, fin, zona, rol}]}` | `AUTH_REQUIRED` | Sí | RF-22 |
| POST | `/v1/worker/availability` | worker | `{inicio, fin, zona, rol}` | `201 {window_id}` | `VALIDATION_ERROR` | No (`Idempotency-Key`) | RF-22 |
| PATCH/DELETE | `/v1/worker/availability/{window_id}` | worker | `{inicio,fin,zona,rol}` / — | `200 {window_id}` / `204` | `VALIDATION_ERROR` | Sí | RF-22 |
| GET | `/v1/worker/requests` | worker | `?estado=&desde=&limit=&cursor=` | `200 {items:[{reservation_id, evento, zona, ventana, rol, hora_llegada, costo_congelado, estado, expira_en, modo_emergencia}]}` | `AUTH_REQUIRED` | Sí | RF-17 |
| GET | `/v1/worker/requests/{reservation_id}` | worker | — | `200 {solicitud, cobertura_requerimiento}` | `NOT_FOUND`, `FORBIDDEN_EVENT_SCOPE` | Sí | RF-17 |
| POST | `/v1/worker/requests/{reservation_id}/accept` | worker | `{plazas?}` (default = pedidas) | `200 {estado:"aceptada", plazas_aceptadas, plazas_devueltas, costo_congelado}` | `409 RESERVATION_OVERLAP`, `409 PLAZAS_INVALIDAS`, `422 WINDOW_NOT_AVAILABLE`, `410 REQUEST_EXPIRED`, `409 RESERVATION_NOT_PENDING` | Sí (replay misma reserva) | RF-08, RF-17, TR-08 |
| POST | `/v1/worker/requests/{reservation_id}/reject` | worker | `{motivo?}` | `200 {estado:"rechazada"}` | `409 RESERVATION_NOT_PENDING` | Sí | RF-17 |
| POST | `/v1/worker/reservations/{reservation_id}/cancel` | worker | `{motivo}` | `200 {estado:"cancelada"\|"cancelada_pagada", alerta_planner:"emitida"}` | `409 RESERVATION_NOT_ACCEPTED` | Sí | RF-09, AC-27 |
| POST | `/v1/worker/reservations/{reservation_id}/arrival` | worker | `{llegada_en}` | `200 {reservation_id, llegada_registrada_en}` | `409 RESERVATION_NOT_ACCEPTED` | Sí (una por reserva) | RF-08, RF-17 |
| GET | `/v1/worker/reservations/{reservation_id}/payment` | worker | — | `200 {estado:"pendiente"\|"pagado"\|"desconocido"\|"reversado", monto, moneda, reverso_de?}` | `NOT_FOUND`, `FORBIDDEN_EVENT_SCOPE` | Sí | RF-11 |

## 2. Check-in offline

| Método | Ruta | Auth | Request | Response 2xx | Errores | Idempotente | RF |
| --- | --- | --- | --- | --- | --- | --- | --- |
| POST | `/v1/scan-sessions` | token de sesión de evento | `{event_id, device_id}` | `201 {session_id, event_id, rol, roster_version, revocation_version, expira_en}` | `NOT_FOUND`, `FORBIDDEN_EVENT_SCOPE`, `AUTH_REQUIRED` | Sí (una sesión vigente por `(event,device)`) | TR-19, TR-02 |
| GET | `/v1/scan-sessions/{session_id}/roster` | token de sesión | `?version=` (`If-None-Match`) | `200 {roster firmado y versionado}` / `304` | `FORBIDDEN_EVENT_SCOPE` | Sí (lectura cacheable con ETag) | TR-02, TR-06, NFR-04 |
| GET | `/v1/scan-sessions/{session_id}/revocations` | token de sesión | `?version=` | `200 {version, ttl_horas:2, vigente_hasta, revocados:[invitation_id]}` | `FORBIDDEN_EVENT_SCOPE` | Sí | TR-06 |
| GET | `/v1/scan-sessions/{session_id}/roster/search` | token de sesión | `?nombre=&codigo_corto=` | `200 {items:[{invitation_id, nombre, codigo_corto, estado}]}` | `VALIDATION_ERROR` | Sí | RF-13 (fallback sin cámara) |
| POST | `/v1/scan-sessions/{session_id}/batches` | token de sesión | lote ≤ 500 eventos (ver §4a) | `200 {results[] por evento, tardios, duplicados, sync_state}` | `BATCH_TOO_LARGE`, `BATCH_CHECKSUM_MISMATCH`, `BATCH_OUT_OF_ORDER`, `IDEMPOTENCY_CONFLICT` | Sí, por `(invitation_id, device_id, sequence)` | RF-13, RF-15, TR-01, TR-03 |
| GET | `/v1/scan-sessions/{session_id}/batches/{batch_id}` | token de sesión | — | `200 {mismo cuerpo del ack}` | `AUTH_REQUIRED` | Sí | TR-01, TR-09-analogía |
| PUT | `/v1/scan-sessions/{session_id}/sync-state` | token de sesión | `{cola_reportada, ultima_seq_ackeada, heartbeat_en}` | `200 {pendientes, ultima_seq_ackeada, heartbeat_en}` | `VALIDATION_ERROR` | Sí (upsert por `(event,device)`) | TR-18, RF-06 |
| POST | `/v1/events/{event_id}/checkins/{checkin_id}/annulments` | token de sesión (`StaffAssignment`) / `owner`/`editor` | `{motivo, annuls_checkin_id:"checkin_id"}` | `201 {checkin_id:"chk_anul", kind:"anulacion", annuls_checkin_id, actor_id, scanned_at}` | `CHECKIN_NOT_FOUND`, `CORRECTION_WINDOW_CLOSED`, `FORBIDDEN_EVENT_SCOPE` | Sí, por `(checkin_id, actor_id)` | RF-14 |
| GET | `/v1/events/{event_id}/checkins` | planner / sesión de escaneo | `?invitation_id=&guest_id=&verdict=&limit=&cursor=` | `200 {items:[{checkin_id, kind, verdict, scanned_at, tardio, device_id, annuls_checkin_id}], next_cursor}` | `NOT_FOUND`, `FORBIDDEN_EVENT_SCOPE` | Sí | RF-13, RF-14 |

## 3. Reemplazo de emergencia, pagos y webhook PSP

| Método | Ruta | Auth | Request | Response 2xx | Errores | Idempotente | RF |
| --- | --- | --- | --- | --- | --- | --- | --- |
| POST | `/v1/events/{event_id}/worker-requests/{reservation_id}/replacements` | planner | `{worker_id}` (copia `[inicio, fin)`, `rol` y `plazas` exactos de la reserva caída) | `201 {reservation_id, estado:"solicitada", modo_emergencia:true, sla_respuesta:"PT15M", expira_en}` o `200 {estado:"sin_cubrir", alerta:true}` | `404 NOT_FOUND`, `409 RESERVATION_OVERLAP`, `422 WINDOW_NOT_AVAILABLE`, `422 VALIDATION_ERROR` | No (`Idempotency-Key`) | RF-09, AC-27 |
| POST | `/v1/events/{event_id}/reservations/{reservation_id}/cancel` | planner (solo eventos propios) | `{motivo}` | `200 {estado:"cancelada"\|"cancelada_pagada", plazas_liberadas, ledger_entry_id?}` | `NOT_FOUND`, `FORBIDDEN_EVENT_SCOPE` | Sí | RF-09, RF-11 |
| POST | `/v1/reservations/{reservation_id}/payments` | planner | `{}` (monto = `costo_congelado`) | `201 {payment_id, estado:"confirmado", monto, idempotency_key, ledger_tx_id}` / `202 {estado:"desconocido"}` | `409 RESERVATION_NOT_ACCEPTED`, `IDEMPOTENCY_CONFLICT` | Sí (TR-09, ver reglas) | RF-11, TR-09, TR-20 |
| GET | `/v1/reservations/{reservation_id}/payments` | planner / worker | — | `200 {items:[{payment_id, estado, monto, moneda, intentos}]}` | `NOT_FOUND`, `FORBIDDEN_EVENT_SCOPE` | Sí | RF-11 |
| POST | `/v1/webhooks/psp` | firma HMAC del PSP | `{event_id, payment_id, idempotency_key, status, amount, currency}` | `200 {conciliado:true, estado}` | `AUTH_REQUIRED`, `VALIDATION_ERROR` | Sí (idempotente por `payment_id` / `idempotency_key`, nunca duplica asiento) | RF-11, TR-09, AC-09 |

## 4. Ejemplos

### (a) Upload de lote de escaneo

```http
POST /v1/scan-sessions/ses_9f2/batches
Authorization: Bearer <session_token>
Idempotency-Key: ses_9f2:dev_7:0004
Content-Type: application/json
```
```json
{
  "batch_id": "ses_9f2:dev_7:0004",
  "device_id": "dev_7",
  "event_id": "evt_1",
  "key_id": "k-2026-03",
  "roster_version": 42,
  "revocation_version": 17,
  "seq_desde": 501,
  "seq_hasta": 503,
  "checksum": {"alg": "sha256", "valor": "9b1d…", "sobre": "events_json_canonico_ordenado_por_sequence"},
  "cola_reportada": 0,
  "heartbeat_en": "2026-06-15T19:10:01Z",
  "events": [
    {"sequence": 501, "invitation_id": "inv_1", "scanned_at": "2026-06-15T19:02:11Z", "token_sha256": "ab31…", "verdict_local": "admitido", "modo": "camara", "key_id": "k-2026-03"},
    {"sequence": 502, "invitation_id": "inv_7", "scanned_at": "2026-06-15T19:02:19Z", "token_sha256": "7f02…", "verdict_local": "ya_registrado", "modo": "camara"},
    {"sequence": 503, "invitation_id": "inv_9", "scanned_at": "2026-06-15T19:02:41Z", "token_sha256": "c0d4…", "verdict_local": "no_verificable_offline", "modo": "codigo_corto"}
  ]
}
```
```json
{
  "batch_id": "ses_9f2:dev_7:0004",
  "estado": "aplicado",
  "recibido_en": "2026-06-15T19:10:02.312Z",
  "ack_hasta_sequence": 503,
  "contadores": {"aceptados": 2, "tardios": 0, "duplicados": 1, "invalidados_al_sincronizar": 1, "rechazados": 0},
  "results": [
    {"sequence": 501, "invitation_id": "inv_1", "checkin_id": "chk_1001", "verdict": "admitido", "tardio": false, "duplicado": false},
    {"sequence": 502, "invitation_id": "inv_7", "checkin_id": "chk_0912", "kind": "duplicado_tardio", "verdict": "ya_registrado", "vigente_checkin_id": "chk_0900", "tardio": false, "duplicado": true},
    {"sequence": 503, "invitation_id": "inv_9", "checkin_id": "chk_1002", "verdict": "invitacion_revocada", "verdict_local": "no_verificable_offline", "resolucion_al_sincronizar": "invalidado_al_sincronizar", "tardio": false, "duplicado": false}
  ],
  "sync_state": {"device_id": "dev_7", "pendientes": 0, "ultima_seq_ackeada": 503, "heartbeat_en": "2026-06-15T19:10:02Z"}
}
```

**Reglas del lote (explícitas).** Clave natural `(invitation_id, device_id, sequence)` (TR-01): reintento con la misma clave = no-op que devuelve **el mismo veredicto**. `sequence` es monotónica por dispositivo y el replay **respeta el orden original**: un lote con `seq_desde` menor a `ack_hasta_sequence + 1` se aplica igual pero se valida por evento, y un hueco o desorden dentro del lote responde `400 BATCH_OUT_OF_ORDER`. Máximo **500 eventos** por lote (`BATCH_TOO_LARGE` por encima); `checksum` obligatorio (sha256 del JSON canónico ordenado por `sequence`) y su ausencia o desajuste responde `400 BATCH_CHECKSUM_MISMATCH` sin aplicar nada. La respuesta trae **veredicto por evento** (`admitido`, `ya_registrado`, `no_corresponde_al_evento`, `invitacion_revocada`, `no_verificable_offline`, `no_en_roster`) más las marcas `tardio`, `duplicado` y los contadores. La fila durable se escribe **antes** del `ack` (NFR-06); el `ack` es el `200`. La ingesta se particiona **por `event_id`** y la deduplicación por la clave de negocio `(invitation_id, device_id, sequence)` es **independiente de la partición** (TR-04, TR-16), así que el mismo lote nunca se aplica dos veces por caer en otra partición o réplica. El ingest no hace fan-out síncrono: publica en el stream y el tablero converge aparte (TR-05). Dedupe cross-dispositivo por `recibido_en` del **servidor**, nunca por reloj del dispositivo: el segundo dispositivo recibe `ya_registrado` con `kind=duplicado_tardio` (TR-17, AC-05).

**Evento ya cerrado.** `cerrado` es solo lectura pero **no rechaza** el lote: cada evento con `scanned_at` dentro de la ventana del evento se acepta y se marca `"tardio": true` (RF-15, AC-17); solo se rechaza, individualmente y sin abortar el lote, lo escaneado fuera de la ventana del evento (`400` por evento dentro de `results`, contador `rechazados`). Un evento `cancelado` responde `403 FORBIDDEN_EVENT_SCOPE` en el lote completo.

**Replay / resultado desconocido.** Reenviar el mismo `batch_id` con el mismo cuerpo devuelve el `200` original íntegro (AC-03), sin nuevas filas y sin mover contadores del tablero; `GET /scan-sessions/{id}/batches/{batch_id}` sirve para recuperar el ack perdido sin reenviar. Reeditar el cuerpo con el mismo `Idempotency-Key` responde `409 IDEMPOTENCY_CONFLICT`.

### (b) Prefetch de roster (firmado y versionado)

```http
GET /v1/scan-sessions/ses_9f2/roster
Authorization: Bearer <session_token>
If-None-Match: "roster-42"
```
```json
{
  "event_id": "evt_1",
  "evento": {"nombre": "Boda Rojas", "inicio": "2026-06-15T18:00:00-06:00", "fin": "2026-06-16T01:00:00-06:00", "estado": "en_curso", "timezone": "America/Mexico_City"},
  "roster_version": 42,
  "generado_en": "2026-06-15T17:55:00Z",
  "expira_en": "2026-06-16T02:00:00Z",
  "firma": {"alg": "ES256", "key_id": "k-2026-03", "valor": "MEUCIQ…", "sobre": "payload_canonico_sin_firma+roster_version"},
  "key_publica_pem": "-----BEGIN PUBLIC KEY-----…",
  "limites": {"max_invitados": 2000, "autonomia_horas": 8, "max_escaneos_dispositivo": 1000, "max_eventos_por_sesion": 1},
  "revocaciones": {"version": 17, "emitida_en": "2026-06-15T17:58:00Z", "ttl_horas": 2, "vigente_hasta": "2026-06-15T19:58:00Z", "refrescar_antes_de": "2026-06-15T19:48:00Z"},
  "invitados": [
    {"invitation_id": "inv_1", "nombre": "Ana Rojas", "codigo_corto": "483920", "zona": "A", "mesa": 7, "token_key_id": "k-2026-03"},
    {"invitation_id": "inv_7", "nombre": "Luis Peña", "codigo_corto": "114503", "zona": "B", "mesa": 3, "token_key_id": "k-2026-03"}
  ]
}
```

**Reglas del roster (explícitas).** La respuesta va **firmada** (sobre el payload canónico + `roster_version`) y **versionada**; el cliente verifica la firma sin red y guarda `roster_version` para el `If-None-Match`/`?version=` (misma versión ⇒ `304`, sin re-descarga). El QR transporta un token con `invitation_id` + `key_id` firmado, y la verificación de firma es **offline** (TR-06). El roster solo cubre **este** evento: una sesión de escaneo = un evento (TR-19), tope 2 000 invitados y ≤ 5 eventos por sesión (NFR-04), autonomía 8 h / 1 000 escaneos en cola durable (TR-02).

**Lista de revocación — regla de TTL.** Se refresca al iniciar la sesión y siempre que haya red; **si tiene más de 2 h, el veredicto es `no_verificable_offline`**: admisión **condicional y marcada**, nunca `admitido` limpio. Al sincronizar, un token que estaba revocado sin saberse se resuelve con `resolucion_al_sincronizar: "invalidado_al_sincronizar"` y veredicto `invitacion_revocada` (el veredicto se mantiene dentro del set de RF-13). Un invitado creado después del prefetch no está en el roster: veredicto `no_en_roster` (admisión manual condicional, marcada para revisión), nunca `no_corresponde_al_evento` (RF-13, P07).

### (c) Aceptar / rechazar solicitud

```http
POST /v1/worker/requests/res_441/accept
Authorization: Bearer <worker_jwt>
Idempotency-Key: accept:res_441
Content-Type: application/json
{"plazas": 4}
```
`200 OK` (aceptación total o **parcial**) — `plazas_ofrecidas = 6`, se pidieron 6, se aceptan 4:

```json
{
  "reservation_id": "res_441",
  "estado": "aceptada",
  "plazas_solicitadas": 6,
  "plazas_aceptadas": 4,
  "plazas_devueltas": 2,
  "costo_congelado": {"modo": "fijo", "monto": 1800.00, "moneda": "MXN", "unidad": "evento"},
  "ventana": {"inicio": "2026-06-15T17:00:00-06:00", "fin": "2026-06-16T01:00:00-06:00"},
  "hora_llegada": "2026-06-15T16:30:00-06:00",
  "aceptada_en": "2026-06-10T15:04:11Z",
  "cobertura_requerimiento": {"rol": "mesero", "cantidad": 6, "cubiertos": 4, "pendientes": 2, "sin_cubrir": false}
}
```

`409 Conflict` — plazas agotadas: conflicto **determinista** que **nombra la reserva ganadora** (TR-08, AC-07/AC-22):

```json
{
  "error": {
    "code": "RESERVATION_OVERLAP",
    "message": "La ventana se solapa con una reserva aceptada del mismo perfil",
    "details": {
      "solicitud": {"reservation_id": "res_441", "estado_actual": "solicitada", "plazas": 4},
      "ventana": {"inicio": "2026-06-15T17:00:00-06:00", "fin": "2026-06-16T01:00:00-06:00"},
      "plazas_ofrecidas": 6,
      "plazas_aceptadas_en_ventana": 6,
      "plazas_disponibles": 0,
      "ganadora": {"reservation_id": "res_388", "event_id": "evt_9", "ventana": {"inicio": "2026-06-15T18:00:00-06:00", "fin": "2026-06-16T00:00:00-06:00"}, "plazas": 6, "aceptada_en": "2026-06-09T11:20:03Z"}
    }
  }
}
```

La reserva perdedora **queda `solicitada`**, nunca se borra ni se marca rechazada; el replay del `accept` devuelve el mismo `409` (o el mismo `200` si ganó). Otras causas deterministas: `422 WINDOW_NOT_AVAILABLE` si la ventana no está **contenida** en una `AvailabilityWindow` declarada del mismo rol (RF-22, AC-22, sin cambiar el estado), `410 REQUEST_EXPIRED` fuera de `min(48 h, fin_ventana − ahora)` o de los 15 min en `modo_emergencia`, `409 PLAZAS_INVALIDAS` si `plazas > plazas_ofrecidas` o `plazas < 1`.

```http
POST /v1/worker/requests/res_500/reject
Idempotency-Key: reject:res_500
{"motivo": "ya tengo otro evento"}
```
```json
{"reservation_id": "res_500", "estado": "rechazada", "rechazada_en": "2026-06-10T15:12:40Z", "devuelve_a_busqueda": true}
```
Rechazar es idempotente (replay mismo `200`); sobre una reserva `aceptada` responde `409 RESERVATION_NOT_PENDING` y el camino correcto es `POST /worker/reservations/{id}/cancel` (que emite alerta al planner en ≤ 5 s, AC-27).

## 5. Reglas de pago (TR-09) y de anulación

- **Solo contra reserva `aceptada`**: cualquier pago sobre `solicitada`, `rechazada`, `expirada`, `cancelada` o `sin_cubrir` responde `409 RESERVATION_NOT_ACCEPTED` sin llamar al PSP. El monto se lee de `costo_congelado`, nunca de la tarifa viva (TR-20, AC-26).
- **Idempotency key acuñada una sola vez** (`pay:{reservation_id}`) y **persistida antes** de llamar al PSP; el reintento **reusa** esa clave y jamás la incrementa. Ante resultado desconocido (`202` con `estado:"desconocido"`) se **consulta por clave** al PSP antes de reintentar; webhooks son idempotentes por `payment_id`. Un cobro = una transacción de ledger de dos líneas balanceadas (`suma 0`), append-only.
- Si la reserva se cancela después del cobro, se registra un `reverso` (entrada nueva, nunca edición) y la reserva pasa a `cancelada_pagada` (RF-11).
- **Anulación de check-in** (`POST /v1/events/{id}/checkins/{chk}/annulments`): inserta `CheckinEvent{kind:"anulacion", annuls_checkin_id, actor_id, motivo, scanned_at}`, append-only, idempotente por `(checkin_id, actor_id)`; nunca `UPDATE`/`DELETE`. Ventana: evento abierto o `corrección` (24 h post-cierre); fuera de eso, `409 CORRECTION_WINDOW_CLOSED`. Tras la anulación el invitado puede admitirse de nuevo y `anulado` ≠ `ya_registrado` (RF-14, AC-16).

## Resumen de decisiones de API

1. **Una sola clave de idempotencia por capa**: `(invitation_id, device_id, sequence)` para el log de check-in, `Idempotency-Key` para POSTs mutantes, `pay:{reservation_id}` para pagos; nunca se re-acuña en el reintento.
2. **El lote es veredicto, no comando**: el servidor no re-ejecuta la decisión offline; la converge (primera fila durable por `recibido_en` del servidor) y devuelve veredicto por evento con marcas `tardio`/`duplicado`.
3. **`cerrado` no rechaza, marca**: se acepta lo escaneado dentro de la ventana del evento como `tardio`; solo se rechaza lo escaneado fuera.
4. **La aceptación se serializa en el servidor, no en el cliente**: `409` determinista con la reserva ganadora y `plazas_disponibles`; la fila perdedora permanece `solicitada`.
5. **El roster es un artefacto firmado y versionado**, y su lista de revocación caduca a las 2 h degradando a `no_verificable_offline` (admisión condicional marcada), que se resuelve al sincronizar.
6. **Reemplazo de emergencia unificado**: usa `POST /v1/events/{event_id}/worker-requests/{reservation_id}/replacements` con `{worker_id}`, copiando `[inicio, fin)`, `rol` y `plazas` de la reserva caída con `modo_emergencia` (SLA 15 min), sin ruta paralela ni granularidad distinta.

## Ambigüedades detectadas

- **Veredicto nº 7.** TR-06 nombra `invalidado_al_sincronizar`, que no está en el set de RF-13. Se resuelve exponiéndolo como `resolucion_al_sincronizar` junto a `invitacion_revocada`, no como veredicto adicional.
- **Actor del pago.** RF-11 dice que el planner "paga", pero RNF/RF no dicen si el trabajador puede iniciar el cobro; aquí solo se le expone el **estado** de pago.
- **Llegada del trabajador.** `hora_llegada` es obligatoria en RF-08, pero ningún RF define el evento de llegada real; `POST /worker/reservations/{id}/arrival` es `[inferencia]`.
- **Corrección vs solo lectura.** RF-14 permite anular dentro de `corrección` (24 h post-cierre) mientras RF-15 declara `cerrado` de solo lectura; se interpreta que la anulación es la excepción explícita, pero el requisito no lo dice.
- **Checksum de TR-03.** No fija algoritmo ni cobertura del checksum; se decide sha256 sobre el JSON canónico ordenado por `sequence`.
- **Colisión de código corto.** RF-13 exige 6 dígitos por invitado pero no define unicidad ni resolución de colisiones dentro del evento; `roster/search` devuelve lista y no un único invitado.
- **`plazas` devueltas.** RF-08 fija que la aceptación parcial devuelve la diferencia, pero no dónde se registra; se expone en `plazas_devueltas` y en `cobertura_requerimiento`, sin entidad propia.
