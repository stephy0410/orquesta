# 03 — API or System Interface

Sección 3 del delivery framework de Hello Interview. Este documento **no define endpoints**: fija las convenciones comunes, resuelve los conflictos entre los dos contratos autoritativos y sirve de índice. Los contratos siguen siendo `docs/delivery/03a-api-planner-invitado.md` (consola del planner + página pública de la invitación) y `docs/delivery/03b-api-trabajador-scan.md` (consola del trabajador + check-in offline). Fuente de verdad funcional: `docs/requerimientos.md` (v2.1).

## 1. Protocolo y forma

- **REST sobre HTTPS**, cuerpos JSON `application/json; charset=utf-8`; el import es la única excepción (`multipart/form-data`).
- **Base path `/v1`** en toda ruta, incluida la consola del trabajador: `/v1/worker/...` no cuelga de otro prefijo.
- **Recursos en plural** (`/events`, `/guests`, `/worker-requests`, `/scan-sessions`). Una transición o un artefacto van como subrecurso en `POST` (`/publish`, `/accept`, `/annulments`), nunca como verbo en la ruta.
- **La identidad se deriva del token, nunca del body**: el `user_id` del llamador sale del `Bearer` (o de la sesión de evento) y el `event_id` del path, siempre autorizados contra `EventMembership`/`StaffAssignment` (NFR-11). Un `worker_id`, `guest_id` o `user_id` en el cuerpo solo **nombra** el objeto sobre el que se actúa y nunca autoriza. El invitado es la única excepción: se identifica con su `rsvp_token` de ruta y por eso su superficie no tiene sesión.

## 2. Convenciones transversales

- **Auth.** Cookie `httpOnly` (`SameSite=Lax; Secure`) como mecanismo primario en consola web (RF-19), más `Authorization: Bearer <jwt>` soportado para la PWA de escaneo (`EventAccessToken` canjeado por `session_token`), clientes API y tests. Lecturas y escrituras de evento se autorizan contra `EventMembership`; el escaneo, contra `StaffAssignment` o una sesión de evento emitida por el QR de acceso (`EventAccessToken`, alcance `(event_id, rol, device_id)`). El invitado nunca se autentica.
- **Envelope de error.** `{"error":{"code":"UPPER_SNAKE","message":"...","details":{}}}`. El status HTTP lleva la semántica de transporte; `code` lleva la regla de negocio; `details` nunca incluye PII ni trazas.
- **Paginación.** `?limit=&cursor=` → `{"items":[...],"next_cursor":null}`; `next_cursor` es opaco y `null` significa fin. Default 20, máximo 100; el tablero es la excepción declarada (default y máximo 25, NFR-10).
- **Idempotencia.** Todo `POST` no idempotente acepta `Idempotency-Key` (UUID v4 del cliente): misma clave + mismo cuerpo = replay con la misma respuesta y el mismo recurso; misma clave + cuerpo distinto = `409 IDEMPOTENCY_CONFLICT`. Las claves de negocio no se reemplazan por el header: check-in `(invitation_id, device_id, sequence)`, pago `pay:{reservation_id}`, import `(event_id, email|phone normalizado)` (TR-01, TR-09, TR-11).
- **Versionado.** `/v1` en el path es la versión del contrato. Un cambio aditivo (campo opcional, valor nuevo de enum) no la cambia; cualquier cambio incompatible exige `/v2`. Los literales de enum vigentes son de solo lectura dentro de `/v1`.
- **Regla de nombres.** Claves JSON en `snake_case` **en inglés**; los valores de enum conservan el literal que define `docs/requerimientos.md` §3, en español ASCII y sin tildes (`solicitada`, `aceptada`, `admitido`, `anulacion`, `duplicado_tardio`): se traduce el nombre de la clave, nunca el literal. Donde 03a o 03b muestran literales, la implementación aplica la clave inglesa resuelta en §3.

## 3. Tabla de resoluciones (03a × 03b)

| Conflicto | Qué decía 03a | Qué decía 03b | Resolución normativa | Motivo |
| --- | --- | --- | --- | --- |
| **(a) Código de validación** | `VALIDATION_ERROR` con HTTP 422 y `details.campo` | `VALIDATION_FAILED` en registro, perfil, disponibilidad, lote y anulación | Un solo código: **`VALIDATION_ERROR` con HTTP 422**. `VALIDATION_FAILED` queda **prohibido** en toda la API | Una misma condición con dos nombres es dos contratos y dos tests; el cliente necesita un código único para la entrada inválida |
| **(b) Aislamiento** | 404 para todo recurso de otro evento o planner, "nunca 403" | `403 FORBIDDEN_EVENT_SCOPE` para evento ajeno o lote de evento cancelado | **404 `NOT_FOUND` cuando el llamador no tiene relación alguna con el recurso** (no se filtra existencia) y **403 `FORBIDDEN_EVENT_SCOPE` solo cuando existía una relación ya revocada o vencida** (membresía retirada, `StaffAssignment` expirado). Regla: **relación previa → 403, sin relación → 404** | Ambas conductas conviven: el 404 protege la existencia y el 403 es la única respuesta honesta a un permiso que existió y caducó. Un cliente que recibe 403 sabe que debe renovar su habilitación; con 404 no puede distinguirlo |
| **(c) Ventana de reserva** | La contención en `AvailabilityWindow` **no** se valida al crear; se valida al aceptar | `422 WINDOW_NOT_AVAILABLE` al crear **y** al aceptar | La contención se valida en los **dos** momentos: al crear (`422 WINDOW_NOT_AVAILABLE`, rechazo temprano) y al aceptar (autoritativa, dentro de la transacción). El **conflicto de plazas** (`409 RESERVATION_OVERLAP`) se evalúa **solo** al aceptar | Ambas partes tenían razón a medias: el estado de disponibilidad puede cambiar entre crear y aceptar (RF-22), así que la aceptación es la única autoridad, pero crear sin validar produce solicitudes imposibles. Las `solicitada` no compiten entre sí (TR-08) |
| **(d) Campos del check-in** | `veredicto`, `ts`, `kind`, `anula_a` | `verdict`, `escaneado_en`, `kind`, `anula_a` | Claves inglesas: **`verdict`, `scanned_at`, `kind`, `annuls_checkin_id`**. Los valores de enum siguen el literal de la spec (`admitido`, `ya_registrado`, `invitacion_revocada`, `anulacion`, `duplicado_tardio`) | Aplicación directa de la regla de nombres. `kind` ya estaba en inglés y §3 lo fija como enum, no como clave: por eso la clave se traduce y el valor no |
| **(e) Requerimientos y solicitudes del evento** | `PUT`/`GET /v1/events/{event_id}/requirements` y `POST`/`GET /v1/events/{event_id}/worker-requests` | Duplicados bajo `POST/GET .../requirements` y `POST/GET .../reservations` | Se definen **una sola vez, en 03a**: `PUT`/`GET /v1/events/{event_id}/requirements` y `POST`/`GET /v1/events/{event_id}/worker-requests`. Las rutas duplicadas de 03b no existen | Un recurso tiene un único dueño de superficie; duplicar la escritura con otro método y otra respuesta crea dos contratos para el mismo recurso. El planner es el único consumidor |
| **(f) Reemplazo de emergencia** | `POST /v1/events/{event_id}/worker-requests/{reservation_id}/replacements` con `{worker_id}` | `POST /events/{event_id}/requirements/{rol}/emergency-replacement` con `{worker_id, inicio, fin, hora_llegada, plazas}` | Se unifica en **`POST /v1/events/{event_id}/worker-requests/{reservation_id}/replacements`** con `{worker_id}`. La ventana `[inicio, fin)`, `rol` y `plazas` se copian automáticamente de la reserva caída `reservation_id` (RF-09) | RF-09 congela la ventana en la de RF-08; copiarla del recurso `reservation_id` evita que el cliente envíe una ventana distinta y unifica 03a y 03b en una sola ruta |
| **(g) Catálogo de errores transversales** | `IDEMPOTENCY_KEY_CONFLICTO`, `RESERVA_CONFLICTO`, `CORRECCION_FUERA_DE_VENTANA` | `UNAUTHENTICATED`, `IDEMPOTENCY_CONFLICT`, `RESERVATION_OVERLAP`, `CORRECTION_WINDOW_CLOSED` | Códigos canónicos unificados en toda la API: **`AUTH_REQUIRED`**, **`VALIDATION_ERROR`**, **`IDEMPOTENCY_CONFLICT`**, **`RESERVATION_OVERLAP`**, **`CORRECTION_WINDOW_CLOSED`**, **`WINDOW_NOT_AVAILABLE`**, **`FORBIDDEN_EVENT_SCOPE`**, **`NOT_FOUND`** | Un único catálogo cerrado evita divergencias entre SDKs, pruebas de aceptación y handlers HTTP |

## 4. Índice de superficies

| Superficie | Archivo | Quién consume | Autenticación |
| --- | --- | --- | --- |
| Consola del planner: eventos, `EventMembership`, `StaffAssignment`, `EventAccessToken`, venue, invitados, import, envíos, tablero, mesas, trabajadores | `03a-api-planner-invitado.md` | planner, web desktop | Cookie `httpOnly` / `Bearer` + `EventMembership` (`owner`/`editor`) |
| Página pública de la invitación: shell estático (`#t=<rsvp_token>`) y RSVP (`no-store`) | `03a-api-planner-invitado.md` | invitado, web pública sin cuenta | ninguna: `rsvp_token` en fragmento del shell y en el path del API `/rsvp`, sin cookie |
| Requerimientos del evento, solicitudes y reemplazo de emergencia | `03a-api-planner-invitado.md` | planner | Cookie `httpOnly` / `Bearer` + `EventMembership` |
| Consola del trabajador: perfil, disponibilidad, solicitudes, llegada, estado de pago | `03b-api-trabajador-scan.md` | trabajador | Cookie `httpOnly` / `Bearer` (worker) |
| Vista de escaneo y check-in offline: roster, lotes, revocaciones, anulación | `03b-api-trabajador-scan.md` | trabajador habilitado, PWA en el navegador del teléfono | sesión de evento emitida por el QR de acceso (`EventAccessToken`), alcance `(event_id, rol, device_id)` |
| Pagos contra reserva aceptada y webhook de conciliación PSP | `03b-api-trabajador-scan.md` | planner / webhook PSP | Cookie `httpOnly` / `Bearer` + `EventMembership` (pagos); firma HMAC PSP (webhook) |

## 5. Estado de reconciliación y detalles operativos abiertos

Quedan **resueltos** en esta versión los conflictos de contrato entre `03a` y `03b`:
- Catálogo de errores unificado (`AUTH_REQUIRED`, `VALIDATION_ERROR`, `IDEMPOTENCY_CONFLICT`, `RESERVATION_OVERLAP`, `CORRECTION_WINDOW_CLOSED`, `WINDOW_NOT_AVAILABLE`).
- Regla de sesión fijada: cookie `httpOnly` (`SameSite=Lax; Secure`) como mecanismo primario en consola web (`RF-19`) y `Bearer` en PWA de escaneo / clientes API.
- Superficie de `EventMembership` (`GET`/`POST`/`DELETE /v1/events/{event_id}/members`), `StaffAssignment` (`POST .../staff-assignments`) y `EventAccessToken` (`POST .../access-tokens`) agregada en `03a`.
- Rutas duplicadas de `requirements` y `worker-requests` eliminadas de `03b`; reemplazo de emergencia unificado en `POST /v1/events/{event_id}/worker-requests/{reservation_id}/replacements`.
- Claves JSON de check-in unificadas (`verdict`, `scanned_at`, `kind`, `annuls_checkin_id`).
- Endpoint de conciliación por webhook del PSP (`POST /v1/webhooks/psp`) agregado en `03b`.

Detalles de implementación que se configuran en infraestructura (no rompen contrato):
- **Autenticación propia (sin Cognito)**: email + contraseña (argon2id), OTP por SMS y recuperación por email; la rotación de `session_secret` y el par asimétrico ES256 viven en **Secrets Manager / KMS** (ver `05-high-level-design.md`).
- **Cuotas de `RATE_LIMITED` (`429`) y métricas de observabilidad (`NFR-09`)**: los umbrales de *throttling* por ruta se configuran en **API Gateway HTTP API v2** y las métricas (`checkin_rate`, `lag_frescura`, `offline_queue_depth`, `psp_error`) se emiten a **CloudWatch Metrics**, no por endpoints públicos del API.

