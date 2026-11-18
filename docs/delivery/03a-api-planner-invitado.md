# 04 — API: consola del planner + página pública de la invitación

Contrato HTTP de las dos superficies de este alcance. Fuente normativa: `docs/requerimientos.md` (v2.1). Cubre RF-01..RF-06, RF-07..RF-10, RF-12, RF-14..RF-16, RF-18..RF-20 y los NFR que las restringen (NFR-01b, 02, 03, 07, 08, 10, 11; TR-05, 07, 10, 11, 12, 13, 16, 17, 18, 20).
Fuera de este documento: ingesta de check-in desde el dispositivo, sincronización de lotes, consola del trabajador (aceptar/rechazar), pagos y ledger.

## 1. Convenciones

- **Base path** `/v1`. Cuerpos JSON `application/json; charset=utf-8`, salvo el import (`multipart/form-data`).
- **Auth planner**: cookie `httpOnly` (`SameSite=Lax; Secure`) como mecanismo primario en consola web (RF-19) y `Authorization: Bearer <jwt>` soportado para clientes API/tests; toda escritura y lectura se autoriza contra `EventMembership` (NFR-11). Un recurso de un evento sin relación previa responde **404 `NOT_FOUND`** para no filtrar existencia; solo cuando existía una relación ya revocada o vencida responde **403 `FORBIDDEN_EVENT_SCOPE`** (`03-api.md` §3.b).
- **Invitado**: nunca se autentica. En la página pública (`/invitacion/#t=<rsvp_token>`), el token viaja en el **fragment** para no entrar en la clave de caché del shell HTML/JS en CloudFront (NFR-02). En las llamadas al API (`/v1/public/invitations/{rsvp_token}/rsvp`), el token viaja en el segmento de ruta —jamás en query string— con `Cache-Control: no-store`. La página es pública y **sin cookies** (RF-18).
- **Envelope de error**: `{"error":{"code":"UPPER_SNAKE","message":"...","details":{}}}`.
- **Paginación**: `?limit=&cursor=` → `{"items":[],"next_cursor":null}`. `next_cursor` opaco; `null` = fin.
- **Idempotencia**: todo POST no idempotente acepta `Idempotency-Key` (UUID v4 del cliente). Misma clave + mismo cuerpo → misma respuesta y mismo recurso; misma clave + cuerpo distinto → `409 IDEMPOTENCY_CONFLICT`.
- **Caché**: el shell estático (`/invitacion/#t=<rsvp_token>`), los metadatos públicos del evento (`GET /v1/public/events/{event_id}/summary`) y el PNG del QR (`qr/{qr_token}.png`) son `public, s-maxage=300, stale-while-revalidate=86400`. Toda lectura de consola y `/v1/public/invitations/{rsvp_token}/rsvp` son `Cache-Control: no-store` (NFR-02).
- **Códigos de estado usados**: `200`, `201`, `202`, `204`, `400`, `401`, `403`, `404`, `409`, `410`, `413`, `422`. Cuando una tabla muestra solo el número: `401` = `AUTH_REQUIRED` (o `INVALID_CREDENTIALS` en login), `404` = `NOT_FOUND`; los nombres específicos figuran donde se apartan de esa regla.

### 1.1 Catálogo cerrado de errores (unificado con `03b`)

| code | HTTP | Regla |
| --- | --- | --- |
| `VALIDATION_ERROR` | 422 | RF-01, AC-20 (evento sin nombre, fecha, `timezone` o venue; `hora_llegada` fuera de ventana; entrada inválida) |
| `EVENT_STATE_INVALID` | 409 | RF-01 (solo `publicado` y `en_curso` aceptan envíos y check-in), RF-15 (`cerrado` = solo lectura) |
| `AUTH_REQUIRED` | 401 | RF-19 |
| `INVALID_CREDENTIALS` | 401 | RF-19 |
| `EMAIL_NOT_VERIFIED` | 403 | RF-19 (verificación obligatoria) |
| `FORBIDDEN_EVENT_SCOPE` | 403 | NFR-11 (solo cuando existía relación previa revocada o vencida; sin relación previa → `404 NOT_FOUND`) |
| `EMAIL_YA_REGISTRADA` | 409 | RF-19, §3 (`User{id,email,roles[]}`) |
| `NOT_FOUND` | 404 | NFR-11 (recurso inexistente o sin relación previa con el evento/planner) |
| `GUEST_SIN_CLAVE` | motivo de fila | RF-02 |
| `GUEST_CLAVE_INVALIDA` | motivo de fila | RF-02 |
| `GUEST_DUPLICADO` | motivo de fila | RF-02, TR-11 |
| `AFORO_EXCEDIDO` | 422 | RF-02, AC-20 (rechazo atómico del import con 0 invitados creados) |
| `IMPORT_FILAS_EXCEDIDAS` | 413 | RF-02, §11 (≤ 20 000 filas) |
| `CONFIRMACION_REQUERIDA` | 409 | RF-16 (confirmación previa del número de destinatarios) |
| `SIN_DESTINATARIOS_PENDIENTES` | 409 | RF-16 |
| `MESA_SIN_CAPACIDAD` | 409 | RF-12, TR-10, AC-14 |
| `WINDOW_NOT_AVAILABLE` | 422 | RF-22, TR-08, AC-22 (ventana no contenida en `AvailabilityWindow` vigente al crear o aceptar) |
| `RESERVATION_OVERLAP` | 409 | RF-08/RF-09, TR-08, AC-07 (`details.ganadora` con la reserva ganadora) |
| `TRABAJADOR_SIN_TARIFA` | 422 | TR-20 (emitir solicitud sin tarifa publicada es error) |
| `CORRECTION_WINDOW_CLOSED` | 409 | RF-14, §11 (24 h post-cierre) |
| `INVITACION_REVOCADA` | 410 | RF-20 (baja de invitado revoca el token) |
| `TOKEN_INVALIDO` | 404 | RF-03 (token firmado y revocable) |
| `TOKEN_TIPO_INCORRECTO` | 400 | TR-07, AC-06 (token de check-in donde va el de RSVP) |
| `IDEMPOTENCY_CONFLICT` | 409 | Contrato §1 + RF-02/RF-16 |

## 2. Consola del planner

### 2.1 Auth (RF-19)

| Método | Ruta | Auth | Request | Response 2xx | Errores | Idempotente | RF |
| --- | --- | --- | --- | --- | --- | --- | --- |
| POST | `/v1/auth/register` | público | `{email, password}` | `201 {user_id, email, email_verificado:false}` | 422, 409 | no | RF-19 |
| POST | `/v1/auth/verify-email` | público | `{token}` (uso único, 72 h) | `200 {email_verificado:true}` | 404, 410, 422 | sí (segundo uso = no-op) | RF-19 |
| POST | `/v1/auth/login` | público | `{email, password}` | `200 {access_token, token_type:"Bearer", expires_in}` + `Set-Cookie: session=…; HttpOnly` | 401, 403, 422 | no | RF-19 |
| POST | `/v1/auth/password-reset` | público | `{email}` | `202 {}` (siempre, sin enumeración) | 422 | no | RF-19 |
| POST | `/v1/auth/password-reset/confirm` | público | `{token, password}` | `204` | 404, 410, 422 | sí | RF-19 |
| POST | `/v1/auth/logout` | planner | — | `204` | 401 | sí | RF-19 |

### 2.2 Eventos y venue (RF-01, RF-15)

| Método | Ruta | Auth | Request | Response 2xx | Errores | Idempotente | RF |
| --- | --- | --- | --- | --- | --- | --- | --- |
| POST | `/v1/events` | planner | `{nombre, fecha, timezone, ventana{inicio,fin}, venue_id, aforo}` | `201 {id, estado:"borrador", …}` | 404, 422 | `Idempotency-Key` | RF-01 |
| GET | `/v1/events?limit&cursor` | planner | — | `200 {items[], next_cursor}` | 401 | — | RF-01, NFR-11 |
| GET | `/v1/events/{event_id}` | miembro | — | `200 Event` | 401, 404 | — | RF-01 |
| PATCH | `/v1/events/{event_id}` | miembro `owner`/`editor` | campos parciales | `200 Event` | 404, 409, 422 | no | RF-01 |
| POST | `/v1/events/{event_id}/publish` | `owner` | `{}` | `200 {estado:"publicado"}` | 404, 409 | sí (estado terminal por transición) | RF-01 |
| POST | `/v1/events/{event_id}/start` | `owner` | `{}` | `200 {estado:"en_curso"}` | 404, 409 | sí | RF-01 (transición no especificada, ver §6.5) |
| POST | `/v1/events/{event_id}/cancel` | `owner` | `{motivo}` | `200 {estado:"cancelado"}` | 404, 409 | sí | RF-01 |
| POST | `/v1/events/{event_id}/close` | `owner` | `{}` | `200 {estado:"cerrado", cerrado_en, corte{…}}` | 404, 409 | sí (repite el mismo corte) | RF-15, AC-29 |
| POST | `/v1/venues` | planner | `{nombre, zona, direccion}` | `201 {id, …}` | 422 | `Idempotency-Key` | RF-01 |
| GET | `/v1/venues?limit&cursor` | planner | — | `200 {items[], next_cursor}` | 401 | — | RF-01 |

### 2.2b Membresía y accesos de evento (RF-19, NFR-11, TR-19)

| Método | Ruta | Auth | Request | Response 2xx | Errores | Idempotente | RF |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/v1/events/{event_id}/members` | `miembro` | — | `200 {items[{user_id, email, rol, created_at}], next_cursor}` | 401, 403, 404 | — | NFR-11, P10 |
| POST | `/v1/events/{event_id}/members` | `owner` | `{email\|user_id, rol:"editor"}` + `Idempotency-Key` | `201 {membership_id, event_id, user_id, rol:"editor"}` | 403, 404, 409, 422 | sí | NFR-11, P10 |
| DELETE | `/v1/events/{event_id}/members/{user_id}` | `owner` | — | `204` (`deleted_at` revoca membresía de inmediato) | 403, 404, 409 | sí | NFR-11 |
| POST | `/v1/events/{event_id}/staff-assignments` | `owner`/`editor` | `{user_id, permisos:["roster","checkin","anulacion"]}` + `Idempotency-Key` | `201 {staff_assignment_id, event_id, user_id, permisos[], expira_en}` | 403, 404, 422 | sí | RF-13, RF-14, RF-19 |
| POST | `/v1/events/{event_id}/access-tokens` | `owner`/`editor` | `{rol}` + `Idempotency-Key` | `201 {access_token_id, event_id, rol, qr_token, expira_en}` | 403, 404, 422 | `Idempotency-Key` | RF-19, TR-19 |

### 2.3 Requerimientos y cobertura (RF-22)

| Método | Ruta | Auth | Request | Response 2xx | Errores | Idempotente | RF |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PUT | `/v1/events/{event_id}/requirements` | `owner`/`editor` | `{requerimientos[{rol,cantidad}]}` | `200 {requerimientos[], cobertura{cubiertos,pendientes,sin_cubrir}}` | 404, 409, 422 | sí (PUT total) | RF-22 |
| GET | `/v1/events/{event_id}/requirements` | miembro | — | `200 {items[], next_cursor:null}` | 401, 404 | — | RF-22 |

### 2.4 Invitados, import y baja (RF-02, RF-12, RF-20)

| Método | Ruta | Auth | Request | Response 2xx | Errores | Idempotente | RF |
| --- | --- | --- | --- | --- | --- | --- | --- |
| POST | `/v1/events/{event_id}/guests/import` | `owner`/`editor` | `multipart/form-data` CSV (≤ 20 000 filas) + `Idempotency-Key` | `202 {import_id, estado:"en_proceso", total_filas, aceptadas, rechazadas, duplicadas_en_archivo, errores[]}` | 404, 409, 413, 422 | sí (`Idempotency-Key` + clave de negocio) | RF-02, TR-11 |
| GET | `/v1/events/{event_id}/guests/imports/{import_id}` | miembro | — | `200 {estado, progreso, aceptadas, rechazadas, duplicadas_en_archivo, errores[{linea,motivo}]}` | 401, 404 | — | RF-02 |
| GET | `/v1/events/{event_id}/guests?limit&cursor&sin_mesa&deleted` | miembro | — | `200 {items[], next_cursor}` (`no-store`) | 401, 404 | — | RF-02, RF-12 |
| DELETE | `/v1/events/{event_id}/guests/{guest_id}` | `owner` | — | `200 {guest_id, deleted_at, token_revocado:true, jobs_cancelados:n, asientos_liberados:n}` | 404 | sí (repite `deleted_at`) | RF-20, NFR-08 |

### 2.5 Envío de invitaciones (RF-04, RF-10, RF-16)

| Método | Ruta | Auth | Request | Response 2xx | Errores | Idempotente | RF |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/v1/events/{event_id}/invitations/pending-summary` | miembro | — | `200 {destinatarios, por_canal{sms,email}, pendiente_envio}` (`no-store`) | 401, 404 | — | RF-16 |
| POST | `/v1/events/{event_id}/invitations/send` | `owner` | `{alcance:"pendiente_envio"\|"seleccion", guest_ids[], destinatarios_confirmados}` + `Idempotency-Key` | `202 {envio_id, destinatarios, entregas_encoladas, canales[]}` | 404, 409, 422 | sí (ver §5.2) | RF-16, RF-04 |
| POST | `/v1/events/{event_id}/invitations/resend` | `owner` | `{guest_ids[], canal:"sms"\|"email"\|"ambos", ventana:"resend_1"}` | `202 {envio_id, entregas_encoladas}` | 404, 409, 422 | `Idempotency-Key` (job nuevo por `ventana`) | RF-16, P04, TR-12 |
| GET | `/v1/events/{event_id}/invitations/deliveries?estado&canal&limit&cursor` | miembro | — | `200 {items[{guest_id,canal,estado,intentos}], next_cursor}` | 401, 404 | — | RF-04, RF-06 |

### 2.6 Tablero (RF-06, NFR-03, NFR-10, TR-18)

| Método | Ruta | Auth | Request | Response 2xx | Errores | Idempotente | RF |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/v1/dashboard?limit&cursor` | planner | `limit` default y máximo **25** (NFR-10) | `200 {items[{event_id, contadores, pendientes, frescura}], next_cursor, generado_en}` (`no-store`) | 401, 422 | — | RF-06, NFR-03, NFR-10, TR-13 |

Lectura del read model alimentado por `t_ingest` (TR-05). Cada ítem expone: `contadores{invitados, confirmados, asistentes, aun_no_llegaron, pendientes_sincronizar, entregas_parciales}`, `no_show` **solo** si el evento está `cerrado` (RF-06), `pendientes` derivado de `DeviceSyncState` por TR-18 (`desconocido` si no hay heartbeat en 5 min, nunca 0; `details.dispositivos[]` con `ultima_seq_ackeada`) y `frescura{t_ingest, t_visible, lag_ms, lag_p95_ms}` con reloj de servidor (NFR-03).

### 2.7 Mesas y seating (RF-12, TR-10)

| Método | Ruta | Auth | Request | Response 2xx | Errores | Idempotente | RF |
| --- | --- | --- | --- | --- | --- | --- | --- |
| POST | `/v1/events/{event_id}/tables` | `owner`/`editor` | `{nombre, capacidad}` + `If-Match: "<plan_version>"` | `201 {id, capacidad, ocupacion:0, plan_version}` + `ETag` | 404, 409 (`SEATING_VERSION_CONFLICT`), 422 | `Idempotency-Key` | RF-12, FR7 |
| GET | `/v1/events/{event_id}/tables?limit&cursor` | miembro | — | `200 {items[{id,nombre,capacidad,ocupacion}], next_cursor, plan_version}` + `ETag: "<plan_version>"` | 401, 404 | — | RF-12, FR7 |
| POST | `/v1/events/{event_id}/seat-assignments` | `owner`/`editor` | `{guest_id, table_id}` + `If-Match` | `200 {guest_id, table_id, estado:"asignado", plan_version}` (`201` si es nuevo) + `ETag` | 404, 409 (`MESA_SIN_CAPACIDAD`, `SEATING_VERSION_CONFLICT`), 422 | sí por `(evento, invitado, mesa)` | RF-12, TR-10, FR7 |
| DELETE | `/v1/events/{event_id}/seat-assignments/{guest_id}` | `owner`/`editor` | `If-Match` | `204` + `ETag` (asiento `liberado`, capacidad devuelta) | 404, 409 (`SEATING_VERSION_CONFLICT`) | sí | RF-12, FR7 |
| GET | `/v1/events/{event_id}/seat-assignments/unseated?limit&cursor` | miembro | — | `200 {items[{guest_id, estado_rsvp}], next_cursor}` | 401, 404 | — | RF-12 (lista accionable) |

**Control de versión optimista del plano (FR7, migración `005`).** Cada edición del planner incrementa `plan_version` en la misma transacción. El cliente envía la versión que leyó en `If-Match` (`"12"`, `W/"12"` o `12`; alternativamente `plan_version` en el cuerpo). Si otro editor cambió el plano entretanto: `409 SEATING_VERSION_CONFLICT` con `details.version_actual`, y nada se sobrescribe. Un no-op (mover a la mesa donde ya está, liberar a quien no tiene asiento) no consume versión. Sin `If-Match` la edición se acepta por compatibilidad; con `SEATING_REQUIRE_IF_MATCH=true` responde `428 PRECONDITION_REQUIRED`.

### 2.8 Trabajadores: búsqueda y solicitud (RF-07, RF-08, RF-09, RF-22, TR-08, TR-20)

| Método | Ruta | Auth | Request | Response 2xx | Errores | Idempotente | RF |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/v1/workers?categorias&zonas&radio_km&tarifa_min&tarifa_max&unidad&limit&cursor` | planner | filtros por las 3 dimensiones | `200 {items[{worker_id,nombre_publico,categorias,tarifa,zonas,idiomas,eventos_completados}], next_cursor}` | 401, 422 | — | RF-07, NFR-11 (exc. 2) |
| GET | `/v1/workers/{worker_id}/availability?desde&hasta` | planner | — | `200 {worker_id, ventana_ocupada[{inicio,fin}]}` | 401, 404 | — | NFR-11 (exc. 1), TR-08 |
| POST | `/v1/events/{event_id}/worker-requests` | `owner`/`editor` | `{worker_id, ventana{inicio,fin}, hora_llegada, rol, plazas}` + `Idempotency-Key` | `201 {id, estado:"solicitada", costo_congelado{modo,monto,moneda,unidad}, expira_en}` | 404, 422 (`TRABAJADOR_SIN_TARIFA`, `WINDOW_NOT_AVAILABLE`) | sí (`Idempotency-Key`) | RF-08, RF-22, TR-20 |
| GET | `/v1/events/{event_id}/worker-requests?limit&cursor` | miembro | — | `200 {items[{id,worker_id,rol,plazas,estado,costo_congelado,hora_llegada}], next_cursor, cobertura}` | 401, 404 | — | RF-17 (vista planner), RF-22 |
| POST | `/v1/events/{event_id}/worker-requests/{reservation_id}/cancel` | `owner`/`editor` | `{motivo}` | `200 {id, estado:"cancelada", plazas_liberadas}` | 404, 409 | sí | RF-08 (cancelar libera plazas) |
| POST | `/v1/events/{event_id}/worker-requests/{reservation_id}/replacements` | `owner`/`editor` | `{worker_id}` (copia automáticamente `[inicio, fin)`, `rol` y `plazas` de `reservation_id`, `modo_emergencia`) | `201 {id, estado:"solicitada", modo_emergencia:true, sla_respuesta:"PT15M", expira_en}` o `200 {estado:"sin_cubrir", alerta:true}` | 404, 409 (`RESERVATION_OVERLAP`), 422 (`WINDOW_NOT_AVAILABLE`) | `Idempotency-Key` | RF-09, AC-27 |

La contención en `AvailabilityWindow` se valida temprano al crear (`422 WINDOW_NOT_AVAILABLE`) y de forma autoritativa al aceptar (`03-api.md` §3.c). Crear una solicitud **nunca** responde conflicto de plazas (`409 RESERVATION_OVERLAP`): las `solicitada` no compiten entre sí (TR-08, AC-07). El conflicto de plazas es exclusivo de la aceptación, que vive en la consola del trabajador (`03b`).

### 2.9 Corrección de check-in y cierre (RF-14, RF-15)

| Método | Ruta | Auth | Request | Response 2xx | Errores | Idempotente | RF |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/v1/events/{event_id}/checkins?limit&cursor&verdict` | miembro / `StaffAssignment` | — | `200 {items[{checkin_id,invitation_id,kind,verdict,scanned_at,tardio,annuls_checkin_id}], next_cursor}` | 401, 403, 404 | — | RF-13, RF-15 |
| POST | `/v1/events/{event_id}/checkins/{checkin_id}/annulments` | `owner`/`editor` o staff autorizado | `{motivo}` | `201 {annulment_id, annuls_checkin_id, actor_id, kind:"anulacion", scanned_at, asistentes}` / replay del mismo actor → `200` mismo cuerpo | 403, 404, 409 (`CORRECTION_WINDOW_CLOSED`) | sí por `(checkin_id, actor_id)` | RF-14 |

`CheckinEvent` compensatorio `kind=anulacion`, append-only: nunca `UPDATE` ni `DELETE`. Ventana: evento `en_curso`/`publicado` o hasta 24 h post-cierre. Un `anulado` es distinto de `ya registrado`; tras anular, el invitado puede admitirse de nuevo (RF-14).

## 3. Página pública de la invitación (RF-03, RF-05, RF-18, NFR-02, TR-07)

| Método | Ruta | Auth | Request | Response 2xx | Errores | Idempotente | RF |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/invitacion/#t={rsvp_token}` (CloudFront + S3) | ninguno (público, sin cookie) | — | `200 shell HTML/JS estático` (`public, s-maxage=300, stale-while-revalidate=86400`) | — | — | RF-18, NFR-02 |
| GET | `/v1/public/events/{event_id}/summary` | ninguno (público, sin cookie) | — | `200 {nombre, fecha, inicio, fin, timezone, venue}` (`public, s-maxage=300`) | 404 | — | RF-18, NFR-02 |
| GET | `/v1/public/invitations/{rsvp_token}/rsvp` | ninguno | — | `200 {respuesta, respondido_en, qr{token,png_url}, evento}` (`Cache-Control: no-store`) | 400 (`TOKEN_TIPO_INCORRECTO`), 404 (`TOKEN_INVALIDO`), 410 (`INVITACION_REVOCADA`) | — | RF-05, RF-18 |
| POST | `/v1/public/invitations/{rsvp_token}/rsvp` | ninguno | `{respuesta:"confirma"\|"declina"}` + `Idempotency-Key` opcional | `201 {respuesta, respondido_en, superseded_at, qr{token,png_url}, recordatorios_cancelados:n}` (`Cache-Control: no-store`) · cambio de respuesta → `200` | 400, 404, 410, 422 | sí (última gana, §5.1) | RF-05, RF-18, RF-10 |

El shell HTML/JS en CloudFront + S3 recibe el token en el **fragment** (`/#t=<rsvp_token>`), que el navegador nunca envía al CDN, garantizando una única clave de caché y un *cache hit* ≥ 95 % (NFR-02); los metadatos públicos del evento y el PNG del QR (`qr/{qr_token}.png`) también son cacheables (`s-maxage=300`). El QR de check-in (`qr.token`, distinto al de RSVP) **sigue visible después de responder** (RF-18). Confirmar, declinar y cambiar la respuesta son la **misma** escritura: una sola respuesta vigente por invitación, la última gana, la anterior se marca `superseded_at` (RF-05). Confirmar cancela el recordatorio pendiente por clave TR-12 (RF-10, AC-12). El POST de RSVP sostiene 100 escrituras/s p95 y 400/s por 60 s tras un envío masivo, p99 ≤ 300 ms (NFR-01b).

## 4. Los seis endpoints críticos, con cuerpo completo

### 4.1 `POST /v1/events` — RF-01, AC-20

```http
POST /v1/events
Authorization: Bearer <jwt>
Idempotency-Key: 9f1c…4a
Content-Type: application/json

{"nombre":"Boda Robles","fecha":"2026-03-14","timezone":"America/Mexico_City",
 "ventana":{"inicio":"2026-03-14T18:00:00-06:00","fin":"2026-03-15T01:00:00-06:00"},
 "venue_id":"ven_01","aforo":200,
 "requerimientos":[{"rol":"mesero","cantidad":5},{"rol":"fotografo","cantidad":1}]}
```

`201 Created` → `{"id":"evt_01","estado":"borrador","aforo":200,"membership":{"user_id":"usr_01","rol":"owner"},"venue":{"id":"ven_01","nombre":"Hacienda","zona":"sur","direccion":"…"},"created_at":"…"}`
`422 Unprocessable Entity` → `{"error":{"code":"VALIDATION_ERROR","message":"timezone es obligatoria","details":{"campo":"timezone"}}}` (también sin nombre, fecha o venue: AC-20). El evento creado no aparece en el tablero de un no-miembro (NFR-11).

### 4.2 `POST /v1/events/{event_id}/guests/import` — RF-02, TR-11

```http
POST /v1/events/evt_01/guests/import
Authorization: Bearer <jwt>
Idempotency-Key: 1b7e…c2
Content-Type: multipart/form-data; boundary=--x

[nombre,email,telefono]
Ana Ruiz,ANA@Example.com ,+52 55 1234 5678
Luis Prado,,+52 55 0000 1111
Sofía Nava,,            
Ana Duplicada,ana@example.com,
```

`202 Accepted` → `{"import_id":"imp_01","estado":"en_proceso","progreso":0.0,"total_filas":4,"aceptadas":0,"rechazadas":0,"duplicadas_en_archivo":0,"errores":[]}`
Reporte final con `GET /v1/events/evt_01/guests/imports/imp_01` → `200 OK`:

```json
{"import_id":"imp_01","estado":"completado","progreso":1.0,"total_filas":4,
 "aceptadas":2,"rechazadas":1,"duplicadas_en_archivo":1,
 "errores":[{"linea":4,"motivo":"GUEST_SIN_CLAVE"},
            {"linea":5,"motivo":"GUEST_DUPLICADO"}],
 "aforo":{"limite":200,"ocupado":2}}
```

Normalización: email en minúsculas sin espacios, teléfono E.164. Los aceptados quedan en `pendiente_envio`: **el import no envía nada** (RF-02, P03). Con `AFORO_EXCEDIDO` el archivo se rechaza completo (`422`), `aceptadas=0` y cada fila excedida aparece en `errores[]` con ese motivo (AC-20).

### 4.3 `POST /v1/events/{event_id}/invitations/send` — RF-16, RF-04

```http
POST /v1/events/evt_01/invitations/send
Authorization: Bearer <jwt>
Idempotency-Key: 7d3a…90

{"alcance":"pendiente_envio","destinatarios_confirmados":200}
```

`202 Accepted` → `{"envio_id":"snd_01","destinatarios":200,"entregas_encoladas":400,"canales":["sms","email"]}`
`409 Conflict` → `{"error":{"code":"CONFIRMACION_REQUERIDA","message":"el número de destinatarios cambió","details":{"destinatarios_calculados":198,"confirmados":200}}}` (RF-16).
`409` `EVENT_STATE_INVALID` si el evento está `borrador`, `cerrado` o `cancelado` (RF-01). `409` `SIN_DESTINATARIOS_PENDIENTES` si no queda ninguno.

### 4.4 `GET /v1/dashboard` — RF-06, NFR-03, TR-18

```http
GET /v1/dashboard?limit=25
Authorization: Bearer <jwt>
```

`200 OK` (`Cache-Control: no-store`):

```json
{"generado_en":"2026-03-14T20:15:07.412Z","next_cursor":"c2V…",
 "items":[{"event_id":"evt_01","nombre":"Boda Robles","estado":"en_curso",
   "contadores":{"invitados":200,"confirmados":148,"asistentes":96,
                 "aun_no_llegaron":104,"pendientes_sincronizar":37,"entregas_parciales":4},
   "no_show":null,
   "pendientes":{"valor":37,"estado":"conocido","dispositivos":[{"device_id":"dev_1","cola_reportada":37,"ultima_seq_ackeada":1180,"seq_confirmada":1180,"heartbeat_en":"2026-03-14T20:15:02Z"}]},
   "frescura":{"t_ingest":"2026-03-14T20:15:05.900Z","t_visible":"2026-03-14T20:15:07.410Z","lag_ms":1510,"lag_p95_ms":2140}}]}
```

`pendientes` sin heartbeat en 5 min → `{"valor":null,"estado":"desconocido"}`, nunca 0 (TR-18). `no_show` es `null` en vivo: se calcula al cierre (RF-06). `limit>25` → `422 VALIDATION_ERROR` (NFR-10).

### 4.5 `POST /v1/events/{event_id}/worker-requests` — RF-08, TR-20

```http
POST /v1/events/evt_01/worker-requests
Authorization: Bearer <jwt>
Idempotency-Key: 5c8f…11

{"worker_id":"wrk_42","rol":"mesero","plazas":2,
 "ventana":{"inicio":"2026-03-14T18:00:00-06:00","fin":"2026-03-14T23:00:00-06:00"},
 "hora_llegada":"2026-03-14T17:30:00-06:00"}
```

`201 Created` → `{"id":"res_77","event_id":"evt_01","worker_id":"wrk_42","rol":"mesero","plazas":2,"estado":"solicitada","hora_llegada":"2026-03-14T17:30:00-06:00","costo_congelado":{"modo":"fijo","monto":850.00,"moneda":"MXN","unidad":"persona_hora"},"expira_en":"2026-03-16T16:00:00Z"}`
`422` `TRABAJADOR_SIN_TARIFA` si el perfil no publicó tarifa (TR-20). `422` `WINDOW_NOT_AVAILABLE` si la ventana solicitada no está contenida en ninguna `AvailabilityWindow` vigente del trabajador para ese rol (RF-22, `03-api.md` §3.c). `422 VALIDATION_ERROR` con `details.campo` si `hora_llegada` no cumple `inicio ≤ hora_llegada < fin`, si `plazas > plazas_ofrecidas` o si el perfil no está `publicado` y verificado (RF-07, RF-21). La creación no reserva capacidad: queda `solicitada` y no bloquea a otros planners ni genera `RESERVATION_OVERLAP` (TR-08, AC-07).

### 4.6 `POST /v1/public/invitations/{rsvp_token}/rsvp` — RF-05, RF-18, NFR-02

```http
POST /v1/public/invitations/rsvp_9Qm2…/rsvp
Content-Type: application/json

{"respuesta":"confirma"}
```

`201 Created` (primera respuesta) → `200 OK` (cambio: la última gana):

```json
{"respuesta":"confirma","respondido_en":"2026-03-10T18:04:11Z","superseded_at":"2026-03-09T12:00:00Z",
 "qr":{"token":"chk_7z…","png_url":"https://…/qr/chk_7z….png"},
 "recordatorios_cancelados":2,
 "evento":{"nombre":"Boda Robles","fecha":"2026-03-14","inicio":"18:00","lugar":"Hacienda"}}
```

`410 Gone` `INVITACION_REVOCADA` (invitado dado de baja, RF-20). `400` `TOKEN_TIPO_INCORRECTO` si llega el token de check-in (TR-07, AC-06). `404` `TOKEN_INVALIDO`. El estado viaja **solo** en esta respuesta y en `/rsvp` (`no-store`); el shell estático en CloudFront (`/invitacion/#t=<rsvp_token>`) y el PNG del QR son cacheables sin estado (NFR-02).

## 5. Las dos garantías de idempotencia exigidas

### 5.1 Re-ejecución del import (RF-02, TR-11, AC-11)

- **Misma `Idempotency-Key`, mismo archivo** → `202` con el **mismo** `import_id` y el mismo reporte; 0 invitados nuevos, 0 entregas encoladas.
- **Otra clave, mismo contenido** → la condición de rechazo es la clave de negocio **dentro del evento**: `(evento, email normalizado)` o `(evento, teléfono E.164)`. Las filas ya existentes se reportan como `duplicadas_en_archivo`/`GUEST_DUPLICADO` con su línea, 0 invitados nuevos, 0 notificaciones. El hash de archivo es caché de cortocircuito **dentro de ese evento**, nunca condición global.
- Las filas válidas se confirman en una transacción; nada se envía. Invariante verificable: `invitados` del tablero y `InvitationDelivery` no cambian tras el segundo import.

### 5.2 Re-ejecución del envío (RF-16, RF-04, TR-12, AC-13, AC-21)

- **Misma `Idempotency-Key`** → `202` con el mismo `envio_id`; `entregas_encoladas` no crece.
- **Sin clave, sobre los mismos destinatarios** → la deduplicación por `(destinatario, plantilla, ventana)` produce **exactamente un** `InvitationDelivery` por invitado y canal. Reenviar es una acción explícita y separada (`/invitations/resend`, `ventana=resend_n`), nunca automática.
- Un segundo disparo sobre `pendiente_envío` vacío → `409 SIN_DESTINATARIOS_PENDIENTES`, no un envío vacío.

## 6. Resoluciones firmes y banderas operativas

1. **Sesión web (`cookie httpOnly` + `Bearer`).** En consola web la autoridad primaria es la cookie `httpOnly` (`SameSite=Lax; Secure`, RF-19), y `Bearer` se soporta para la PWA de escaneo (`EventAccessToken`) y clientes API/tests. `login` emite ambas.
2. **Reconciliación `NFR-02` vs `RF-18` (shell cacheable + estado del RSVP).** El shell HTML/JS en `/invitacion/#t=<rsvp_token>`, el summary público del evento y el PNG del QR son cacheables en CloudFront (≥ 95 % *cache hit*, NFR-02); el estado vigente se consulta en `/v1/public/invitations/{rsvp_token}/rsvp` (`Cache-Control: no-store`) y viaja en la respuesta del `POST`.
3. **Regla firme de `AFORO_EXCEDIDO` (RF-02 + AC-20).** Si las filas válidas nuevas más los invitados existentes (incluyendo baja lógica) superan `event.aforo`, el import rechaza el archivo completo con `422 AFORO_EXCEDIDO` y `0 invitados creados` (`AC-20`), listando las filas que desbordan en `errores[]` con motivo `AFORO_EXCEDIDO`.
4. **Transición `publicado → en_curso`.** RF-01 define la máquina de estados pero no el disparador explícito; se expone `POST /start` para el `owner` (y transición automática opcional al inicio de `ventana_inicio`).
5. **Superficie de `EventMembership`, `StaffAssignment` y `EventAccessToken`.** Cubierta en §2.2b para administrar colegas `editor` y habilitar escáneres por evento (NFR-11, RF-19, TR-19).
6. **Cierre repetido (`POST /close`).** Operación idempotente que devuelve el mismo corte consolidado; `cerrado` es de solo lectura salvo el replay offline dentro de la ventana (`tardio`, RF-15) y la ventana de anulación de 24 h (RF-14).
7. **`pendientes` de TR-18 es por dispositivo y por evento.** El tablero publica `valor` agregado más `dispositivos[]`; la fórmula exacta (restando la cola ya ack'd) se aplica por dispositivo, no sobre la suma bruta.
8. **Reasignación de emergencia (RF-09).** Unificada en `POST /v1/events/{event_id}/worker-requests/{reservation_id}/replacements`, copiando automáticamente `[inicio, fin)`, `rol` y `plazas` de la reserva caída; el SLA de 15 min es el parámetro de §11.

## 7. Resumen de decisiones de API

- **Token de RSVP en fragmento del shell y en ruta de `/rsvp`**: el shell (`/invitacion/#t=<rsvp_token>`) es una única clave en CloudFront y el endpoint `/rsvp` nunca se cachea (`no-store`), protegiendo tanto el hit rate de NFR-02 como la privacidad (NFR-07).
- **El estado del RSVP solo sale en `no-store` y en el POST**: el shell cacheable y los PNG de QR no llevan estado mutable, garantizando ≥ 95 % de hit rate en CDN (NFR-02).
- **`404 NOT_FOUND` vs `403 FORBIDDEN_EVENT_SCOPE`**: `404` cuando no existe relación previa (no revela existencia) y `403` solo cuando una membresía o permiso previo fue revocado/vencido (`03-api.md` §3.b).
- **Import asíncrono en dos pasos** (`202` + recurso `guests/imports/{id}`) porque RF-02 exige progreso consultable y ≤ 20 000 filas; los cuatro contadores son finales solo en `estado=completado`.
- **Conflicto de reserva solo en la aceptación**: crear valida disponibilidad (`422 WINDOW_NOT_AVAILABLE`) y responde `201` sin competir por plazas porque las `solicitada` no bloquean (TR-08, AC-07); el conflicto (`409 RESERVATION_OVERLAP`) nombra la reserva ganadora y vive en la consola del trabajador.
- **Catálogo de errores unificado entre `03a` y `03b`**: sin códigos duplicados (`VALIDATION_ERROR`, `AUTH_REQUIRED`, `IDEMPOTENCY_CONFLICT`, `RESERVATION_OVERLAP`, `CORRECTION_WINDOW_CLOSED`, `WINDOW_NOT_AVAILABLE`).

