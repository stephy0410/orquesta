# 05 — High Level Design

Sección **5. High Level Design** del *delivery framework* de Hello Interview: **cajas y flechas**, un diseño simple, escalable y trazable que satisface la API de `03a`/`03b` y los NFRs de `docs/requerimientos.md`. La complejidad algorítmica —particionado del log, coalescing del read model, exclusión de reservas, ledger— se detalla en `06-deep-dives.md`. Fuente normativa: `docs/requerimientos.md` v2.1. Prosa en español, identificadores en inglés.

## Restricciones de plataforma y parametrización (`Learner Lab` ↔ `Producción`)

- **Cuenta AWS Learner Lab (`647018795197`)**, región **`us-east-1`**, sesiones de **4 h**, crédito de **USD 100**, **`LabRole` compartido**: los despliegues en el laboratorio reutilizan `LabRole` sin crear roles ni políticas IAM propias.
- **Verificación en vivo de la cuenta (`us-east-1`):**
  - **Servicios operativos y permitidos:** `apigatewayv2`, `lambda` (con `LabRole`), `rds` (`postgres` y `aurora-postgresql`), `s3`, `sns`, `sqs`, `kms`, `secretsmanager` y `ec2` (`vpc-0d444a684030d7067` con 6 subredes).
  - **Servicios bloqueados por la política `Pvoclabs` (`AccessDenied`):** `cloudfront:*`, `ses:*` e `iam:CreateRole`/`GetPolicyVersion`. Por ello Terraform expone `enable_cloudfront = false` (sirviendo los estáticos y QR PNG desde S3 Website / S3 en el Lab) y `email_provider_mode = "capture"` por defecto en `lab`, ambos activables en `prod`.
- **Cognito no está disponible y ya se descartó.** La autenticación es propia: email + contraseña con hash `argon2id` en PostgreSQL, sesión en cookie `httpOnly` (`Bearer` en PWA de escaneo), verificación de email y **OTP por SMS** reusando la cola `notify_sms`. Los tokens de invitación no pasan por el sistema de sesiones (RF-18, RF-19).
- **Base de datos unificada en PostgreSQL (parametrizable vía `db_mode` en Terraform):**
  - **Producción escalable (`db_mode = "aurora"`):** **Aurora PostgreSQL Serverless v2** (auto-escalado en ACUs, Multi-AZ y PITR) aloja las 22 entidades de dominio —incluido el log append-only `checkin_event` particionado por `event_id` y el `outbox` transaccional— más la tabla de proyección `event_counters` (`read_model`).
  - **Learner Lab (`db_mode = "rds_lab"`):** **RDS PostgreSQL `db.t4g.micro` single-AZ** (mismo esquema, índices y código SQL; reduce costo dentro del crédito de USD 100). **No se usa DynamoDB** ni Redis.
- **Ingress HTTP:** **API Gateway HTTP API v2** (`/v1/*`, con throttling por ruta y CORS) delante de la Lambda `api`. **Lambda Function URL** queda documentada únicamente como fallback.
- **Bus y colas asíncronas:** Sin Kinesis ni MSK; se usa **SNS** (`orquesta-notifications`) para *fan-out* hacia **SQS Standard** (`notify_sms`, `notify_email`), más `import_jobs` y `projection` (con `maximum_batching_window_in_seconds = 1`), todas respaldadas por **DLQ**.
- La región es **`us-east-1`** en todo el documento; no se asume ninguna otra.

## 1. Diagrama

```text
[0] Cliente (navegador): consola del planner · PWA de escaneo · página del invitado (`/invitacion/#t=...`)
        │ HTTPS
        ▼
[1] EDGE ── CloudFront ──(hit)──► shell estático, consolas SPA/PWA, QR PNG, roster cacheable
        │ miss                                                                ▲
        ├──────────────► S3  (shell estático, assets, QR PNG, CSV de import) ─┘
        │
        │ /v1/* dinámico (Cache-Control: no-store)
        ▼
[2] API ── API Gateway HTTP API v2 (fallback: Lambda Function URL) ──► Lambda `api`
        │                            auth propia: password + cookie httpOnly / Bearer + OTP SMS
        │                            autorización por EventMembership / StaffAssignment
        │
        ├──(SQL, transacción)──► PostgreSQL (Aurora Serverless v2 en Prod │ RDS db.t4g.micro en Lab)
        │                           ├── Core relacional (22 entidades de dominio)
        │                           ├── `checkin_event` (append-only, particionado por `event_id`, INSERT batch)
        │                           ├── `event_counters` (read model del tablero por PK)
        │                           └── `outbox` transaccional (deltas y avisos)
        ├──(SendMessage)────────► SQS `import_jobs`
        └──(Sign ES256)─────────► KMS CMK asimétrica ECDSA P-256 (`key_id`) [fallback: Secrets Manager/SSM]
        │
        ▼
[3] PROCESAMIENTO ASÍNCRONO (SQS + SNS + DLQs)
        ├── SQS `import_jobs` (+ DLQ) ──► Lambda `import_worker` ──► PostgreSQL (`Guest`, `Invitation`) + S3 QR
        ├── Lambda `outbox_poller` lee `outbox` de PostgreSQL y publica:
        │     ├── SQS `projection` (batch window 1 s, + DLQ) ──► Lambda `projector` ──► PostgreSQL `event_counters`
        │     └── Tópico SNS `orquesta-notifications` (fan-out D11):
        │           ├── SQS `notify_sms` (+ DLQ)   ──► Lambda `notify_sms`   ──► SNS Transactional SMS ──► estado RDS
        │           └── SQS `notify_email` (+ DLQ) ──► Lambda `notify_email` ──► SES / adaptador SMTP-captura ──► estado RDS

[4] SECRETOS ── Secrets Manager / SSM Parameter Store: credenciales de PostgreSQL, PSP test, `session_secret`.
                Se leen en el cold start de cada Lambda y se cachean en memoria; nunca en el bundle.

[5] FIRMA ── KMS ECDSA P-256 firma el roster versionado y el token del QR (compact JWS ES256).
                La clave **pública** viaja en el roster: el escáner verifica **offline** (TR-06).
                El token de RSVP es aleatorio de 128 bits guardado como hash: no se firma (TR-07).
```

## 2. Tabla de componentes

| Componente | Servicio AWS | Responsabilidad | Qué estado guarda | Por qué ese y no otro |
| --- | --- | --- | --- | --- |
| `edge` | CloudFront + S3 | Sirve el shell estático (`/invitacion/#t=<rsvp_token>`), las consolas web, el PNG del QR y recibe CSV de import; absorbe ≥ 95 % de las 40 M lecturas/mes (NFR-02) | Solo objetos versionados: nada mutable por request | El hit de CDN es lo que evita escalar el origen (§6.4); el token en fragmento mantiene una sola clave de caché |
| `api_gw` | API Gateway HTTP API v2 | Enrutamiento `/v1/*`, CORS y *throttling* por ruta delante de `api` (fallback: Lambda Function URL) | Ninguno | Menor latencia y costo que REST API v1; protege al backend ante ráfagas sin requerir etapa compleja |
| `api` | Lambda | Lógica HTTP: auth propia, autorización por `EventMembership`, validación, transacciones SQL, ingesta de lotes de check-in y firma QR | Nada entre invocaciones (sin estado en memoria) | Escala horizontalmente con la ráfaga sin servidores ociosos fuera del sábado por la noche |
| `db` | Aurora PostgreSQL Serverless v2 (Prod) / RDS PostgreSQL `db.t4g.micro` (Lab) | Verdad transaccional de las 22 entidades, log append-only `checkin_event` particionado por `event_id`, `outbox` y read model `event_counters` | Toda la fila, invariantes (`CHECK`, `UNIQUE`, `GIST`, `pg_advisory_xact_lock`) y proyección del tablero | Unifica los invariantes relacionales (aforo, mesas, plazas, ledger) con el log append-only; 500 w/s en lotes de ≤ 500 eventos equivalen a **1–15 `INSERT` multi-fila/s** sin `UPDATE` en fila caliente |
| `sns_notifications` | SNS Topic (`orquesta-notifications`) | *Fan-out* único por aviso hacia los dos canales en paralelo (RF-04, D11) | Ninguno (bus de publicación) | Desacopla al `outbox_poller` de las colas por canal; permite agregar suscriptores sin tocar la ingesta |
| `queue_import` | SQS Standard (+ DLQ) | Desacopla el import de 20 000 filas del request HTTP `202` (RF-02) | Mensaje con `import_id` y puntero a S3 | Un request HTTP no puede pagar 20 000 filas; SQS cuesta $0 en reposo y soporta DLQ |
| `queue_projection` | SQS Standard (+ DLQ) | Lleva los deltas del `outbox` al `projector` con `maximum_batching_window_in_seconds = 1` (TR-05) | Deltas agrupados por `event_id` | El ingest **no** hace fan-out síncrono; la ventana de 1 s coalesce ráfagas antes de tocar `event_counters` |
| `queue_sms` / `queue_email` | 2 colas SQS Standard (+ DLQs) | Suscritas al tópico SNS: garantizan envío paralelo e independiente por canal (RF-04, D11) | Un mensaje por `(destinatario, plantilla, ventana, canal)` | Aíslan reintentos y fallos entre SMS y email; si un canal se degrada, el otro sigue entregando |
| `notify_sms` | Lambda + SNS Transactional SMS | Envía invitación, recordatorio y OTP por SMS; actualiza `InvitationDelivery` con ≤ 3 reintentos | Estado en PostgreSQL (`InvitationDelivery`) | Único canal SMS del sistema (incluyendo OTP, NFR-09) |
| `notify_email` | Lambda + SES (adaptador SMTP/captura en Lab) | Envía correos personalizados 1-a-1 con enlace + QR; actualiza `InvitationDelivery` | Estado en PostgreSQL (`InvitationDelivery`) | Permite adjuntar/referenciar QR y token únicos por invitado (imposible con SNS Email broadcast) |
| `import_worker` | Lambda | Normaliza, deduplica por clave de negocio, valida aforo (rechazo atómico `422 AFORO_EXCEDIDO`) y crea `Guest` + `Invitation` + QR PNG en S3 | Progreso en `ImportJob` (PostgreSQL) | Consume de SQS en páginas de 500 filas y es reintentable |
| `outbox_poller` | Lambda | Lee el `outbox` transaccional de PostgreSQL y publica en `projection` o en `orquesta-notifications` | Cursor/estado de publicación en `outbox` | Evita *dual write* entre PostgreSQL y SNS/SQS (NFR-06) |
| `projector` | Lambda | Aplica deltas coalesced (1 s) sobre `event_counters` con dedupe por `outbox_event_id`/`checkin_id` | Tabla `event_counters` en PostgreSQL | Única escritora de agregados del tablero; mantiene NFR-03 (≤ 5 s p95) sin `COUNT(*)` en vivo |
| `signer` | KMS CMK (`ECC_NIST_P256`) [fallback: Secrets Manager/SSM] | Firma ES256 del roster versionado y tokens QR; clave pública embebida en el roster | Versión de clave y `key_id` | Permite verificación criptográfica offline en la PWA (TR-06) |
| `secrets` | Secrets Manager / SSM Parameter Store | Credenciales de PostgreSQL, secreto de PSP test y `session_secret` | Secretos versionados | Cumple NFR-07 sin exponer secretos en código ni bundles |

### Servicios evaluados y descartados en el diseño

1. **¿Por qué NO ElastiCache Redis en el MVP?**
   - **Lecturas de invitaciones (`NFR-02`):** CloudFront absorbe ≥ 95 % de las lecturas con el shell estático (`#t=<rsvp_token>`) y los QR PNG en S3, sin golpear el backend.
   - **Check-in offline (`NFR-04`):** El roster precargado vive en IndexedDB dentro del teléfono.
   - **Tablero (`NFR-03`, `NFR-10`):** La tabla `event_counters` en Aurora/RDS responde por clave primaria para 25 eventos en `< 5 ms`.
   - **Costo e infraestructura en Learner Lab:** ElastiCache obliga a encerrar todas las Lambdas en una VPC privada con **NAT Gateway** (~USD 32/mes fijos solo del NAT + costo horario del nodo Redis), agotando el crédito de USD 100 sin resolver ningún cuello de botella real.
2. **¿Por qué SQS + SNS en vez de Kinesis Data Streams?**
   - **Costo continuo vs. pago por uso:** Kinesis cobra por *shard-hour* encendido las 24 h (aun cuando no hay eventos entre semana), mientras que SQS y SNS cuestan USD 0 en reposo.
   - **Semántica de notificaciones (`RF-04`):** Kinesis no ofrece reintentos independientes por mensaje (hasta 3 intentos antes de `rebotado`) ni DLQ nativa por canal como SQS.
   - **Coalescing del tablero (`TR-05`):** SQS Standard soporta `maximum_batching_window_in_seconds = 1` de forma nativa con AWS Lambda, agrupando los deltas de un evento antes de actualizar `event_counters`.
3. **¿Por qué SNS Email directo NO sirve para invitaciones?**
   - El protocolo `email` de SNS exige que cada destinatario confirme primero una suscripción al tópico y envía el **mismo** mensaje *broadcast* a todos los suscriptores. Para mandar un token de RSVP y un QR único por invitado (`RF-03`), SNS solo actúa como bus de *fan-out* hacia SQS `notify_email`, y la entrega personalizada 1-a-1 recae en **SES** (o un adaptador SMTP/captura en el sandbox de Learner Lab).

## 3. Recorrido endpoint por endpoint

Seis caminos principales, con el estado que cambia. Los nombres de ruta son los de `03a`/`03b` reconciliados.

**3.1 Crear evento — `POST /v1/events`** (RF-01, AC-20)

1. Cliente → API Gateway HTTP API v2 (`/v1/*` `no-store`) → Lambda `api`.
2. `api` valida sesión (cookie `httpOnly` o Bearer), `VALIDATION_ERROR` si falta nombre, fecha, `timezone` o venue, y lee el `Idempotency-Key`.
3. Una transacción en PostgreSQL: `Venue`, `Event` (`estado=borrador`), `EventMembership(owner)`, `EventRequirement[]`, fila inicial en `event_counters` y registro de idempotencia.
4. Responde `201`; un replay con la misma clave devuelve el mismo `event_id`. **No encola nada.**
5. Estado: filas nuevas en PostgreSQL. El evento aparece en el tablero de inmediato con contadores en 0.

**3.2 Importar invitados — `POST /v1/events/{event_id}/guests/import`** (RF-02, TR-11, AC-11)

1. `api` autoriza contra `EventMembership`, valida `≤ 20 000` filas y el `Content-Type` multipart.
2. Guarda el CSV en **S3** (`imports/<import_id>.csv`), inserta `ImportJob{estado=en_proceso}` en PostgreSQL y publica `{import_id}` en **`import_jobs`**. Responde `202` con el recurso de progreso.
3. Lambda `import_worker` lee el CSV **por páginas de 500 filas** desde S3: normaliza email (minúsculas) y teléfono (E.164), deduplica por `(event, email_normalizado)` / `(event, telefono_e164)` **dentro del evento**. Si el total excede `event.aforo`, aborta de forma atómica con `422 AFORO_EXCEDIDO` y `0 invitados creados` (`AC-20`).
4. Si el aforo alcanza, confirma en transacción `Guest` + `Invitation` (dos tokens, `codigo_corto`, `checkin_key_id`) en `pendiente_envio`, genera el PNG del QR (firma ES256 vía `signer`), lo sube a S3 con URL estable y actualiza `ImportJob` + delta para `event_counters.invitados`.
5. **No se publica ningún mensaje de notificación**: el envío lo dispara el planner con `POST /v1/events/{event_id}/invitations/send` (RF-16).

**3.3 Abrir invitación — `GET /invitacion/#t={rsvp_token}` + `GET`/`POST /v1/public/invitations/{rsvp_token}/rsvp`** (RF-18, RF-05, NFR-02)

1. CloudFront sirve el shell estático (`/invitacion/#t=<rsvp_token>`), los metadatos públicos (`GET /v1/public/events/{event_id}/summary`) y el PNG del QR desde S3 (`s-maxage=300`). Como el token va en el fragmento, CloudFront tiene una única clave de caché y un hit ≥ 95 %.
2. El shell llama a `GET …/rsvp` (`Cache-Control: no-store`) para mostrar el estado vigente al reabrir, o envía `POST …/rsvp`: `api` resuelve `Invitation` por hash del token, rechaza un token de check-in con `TOKEN_TIPO_INCORRECTO` (TR-07) y una invitación revocada con `410 INVITACION_REVOCADA`.
3. Una transacción en PostgreSQL: inserta `RsvpResponse` (append-only), marca la anterior `superseded_at` (la última gana), cancela los `ReminderJob` pendientes por clave TR-12, libera el `SeatAssignment` si es `declina`, y escribe el delta en `outbox`.
4. `outbox_poller` publica el delta en SQS `projection` (coalescing 1 s); `projector` actualiza `confirmados` en `event_counters`.

**3.4 Subir lote de check-in — `POST /v1/scan-sessions/{id}/batches`** (RF-13, TR-01/03/17, NFR-01/06)

1. **Offline (en el teléfono):** la PWA verifica la firma ES256 del QR con `key_publica_pem` del roster firmado y emite el veredicto en ≤ 100 ms contra su copia local en IndexedDB, tras persistir el escaneo (RPO 0 en el dispositivo). Si la lista de revocación tiene > 2 h, degrada a `no_verificable_offline`.
2. Al recuperar red, envía el lote (≤ 500 eventos, `checksum` sha256 del JSON canónico, `sequence` monotónica por dispositivo) a API Gateway → `api`.
3. `api` valida tamaño, checksum, orden y alcance de sesión `(event_id, rol)`.
4. **Escritura durable antes del ack**, en una sola transacción en PostgreSQL sobre `checkin_event` (append-only particionado por `event_id`): `INSERT ... ON CONFLICT` por `(invitation_id, device_id, sequence)` (idempotencia por dispositivo) y convergencia por índice único parcial `(invitation_id, admision_ciclo) WHERE kind = 'admitido'` según `recibido_en` **del servidor**; los segundos quedan guardados como `duplicado_tardio` (`verdict = ya_registrado`). Un lote que llega tras el cierre con `scanned_at` dentro de la ventana se acepta marcado `tardio` (RF-15).
5. En la misma transacción escribe los deltas en `outbox` y actualiza `DeviceSyncState`. Responde `200` (el ack) con veredicto por evento, contadores y `sync_state`.
6. `outbox_poller` → SQS `projection` (coalescing 1 s) → `projector` actualiza `event_counters.asistentes` y `ultimo_t_ingest`.

**3.5 Tablero — `GET /v1/dashboard?limit≤25`** (RF-06, NFR-03, NFR-10, TR-13)

1. `api` autoriza la sesión y resuelve **solo los eventos donde el usuario es miembro** (`EventMembership`, NFR-11).
2. Lee por PK los contadores ya materializados en `event_counters` (`WHERE event_id = ANY($ids)`); nunca ejecuta `COUNT(*)` sobre `checkin_event` ni `rsvp_response` en vivo.
3. `pendientes_sincronizar` se deriva de `DeviceSyncState` (TR-18), con `desconocido` si no hay heartbeat en 5 min —nunca 0—; `no_show` es `null` hasta el cierre (RF-06).
4. `frescura` se toma con reloj de servidor: `t_ingest` (`ultimo_t_ingest`) → `t_visible` (lectura actual), cumpliendo NFR-03 (≤ 5 s p95).
5. Respuesta `Cache-Control: no-store`. Estado: **ninguno** — es una lectura pura.

**3.6 Aceptar solicitud — `POST /v1/worker/requests/{reservation_id}/accept`** (RF-08, RF-17, TR-08, AC-07/AC-22)

1. `api` valida sesión del trabajador y que la reserva sea suya; verifica que no esté `expirada` (48 h, o 15 min en `modo_emergencia`).
2. Una transacción en PostgreSQL verifica la **contención**: la ventana debe caber en una `AvailabilityWindow` vigente del mismo `rol`; si no, `422 WINDOW_NOT_AVAILABLE` sin cambio de estado (RF-22).
3. Serializa sobre el agregado `(worker_id, ventana)` con `pg_advisory_xact_lock`: `Σ plazas aceptadas solapadas + plazas_nuevas ≤ plazas_ofrecidas`. Nunca *read-then-write*.
4. El perdedor recibe `409 RESERVATION_OVERLAP` **nombrando la reserva ganadora** y su fila **queda `solicitada`** (nunca se borra). El ganador pasa a `aceptada`, con plazas parciales devueltas si aplica; `costo_congelado` no se toca (TR-20).
5. En la misma transacción: inserta los `ReminderJob` de llegada (T-24 h y T-2 h, **una entrega por canal**) y escribe en `outbox`.
6. `outbox_poller` → SNS `orquesta-notifications` → SQS `notify_sms` / `notify_email` (avisos/recordatorios). La cobertura del `EventRequirement` es **derivada** de las reservas, no una columna editable.

## 4. Dónde NO se puede escalar el diseño del lab

Cinco diferencias concretas entre lo **diseñado para producción** y lo **demostrable en Learner Lab**:

- **Motor y disponibilidad de base de datos**: *diseñado* con **Aurora PostgreSQL Serverless v2 Multi-AZ**, PITR y RTO ≤ 1 h (NFR-06), más 99,9 % mensual (NFR-05). *Demostrable* en el Lab con **RDS PostgreSQL `db.t4g.micro` single-AZ** (`db_mode = "rds_lab"` en Terraform) dentro de una sesión de 4 h: el *failover* Multi-AZ y el auto-escalado de ACUs no se prueban en vivo, pero el esquema SQL, particiones e índices son idénticos.
- **Ráfaga de ingesta de 500 w/s sostenida 60 s** (NFR-01, AC-01/AC-02): *diseñado* con `checkin_event` particionado por `event_id` sobre Aurora Serverless v2 escalando ACUs dinámicamente. *Demostrable* sobre `db.t4g.micro` con un generador de carga acotado a la sesión de 4 h y lotes de hasta 500 eventos; el límite de IOPS/CPU de `db.t4g.micro` acota las pruebas de estrés máximo.
- **Firma ECDSA P-256 en KMS con verificación offline** (TR-06): *diseñado* con una CMK asimétrica en KMS y la clave pública embebida en el roster firmado. *Demostrable* solo si `LabRole` permite `kms:CreateKey`/`Sign` en `us-east-1`; si `LabRole` lo restringe, la clave privada ECDSA P-256 se guarda cifrada en Secrets Manager / SSM Parameter Store para demostrar la firma ES256 offline sin cambiar el algoritmo ni el formato del QR.
- **Entrega real por SMS, email y CDN (CloudFront / SES)** (RF-04, D11, NFR-02): *diseñado* con **CloudFront** en el borde y **SNS `orquesta-notifications` → SQS `notify_sms` / `notify_email`** hacia SNS Transactional SMS y SES en producción. *Demostrable* en el Lab con S3 Website (`enable_cloudfront = false`, porque `cloudfront:*` está bloqueado por `Pvoclabs`), adaptador de captura en email (`email_provider_mode = "capture"`, porque `ses:*` está bloqueado por `Pvoclabs`) y un volumen de SMS acotado por el crédito de USD 100.
- **Sesiones de 4 h contra ciclos de vida de horas o días**: *diseñado* para 24×7, con lista de revocación de 2 h (TR-06), autonomía offline de 8 h (TR-02) y recordatorios T-7 d / T-24 h (RF-10). *Demostrable* el flujo funcional completo ajustando ventanas temporales dentro de la sesión de 4 h.

## 5. Costos

Estimaciones con precios públicos de `us-east-1` y los supuestos de `docs/requerimientos.md` §11 (~40 h de sesión al mes en el lab, 1 KB por invitado, tarifa SMS de USD 0,006–0,10; D11). Son órdenes de magnitud, no una cotización.

| Rubro | Demo en Learner Lab (USD/mes) | Producción a escala `README.md:15` (USD/mes) |
| --- | --- | --- |
| Edge: CloudFront + S3 | ~0,15 | ~550 |
| Ingress + Cómputo: API Gateway HTTP API v2 + Lambdas (`api`, workers, `outbox_poller`, `projector`) | ~0,00 (free tier) | ~250 |
| `db`: RDS PostgreSQL `db.t4g.micro` (Lab) / Aurora PostgreSQL Serverless v2 Multi-AZ (Prod) | ~3,00 (40 h/mes + 20 GB) | ~450–900 (auto-escalado ACU según carga de fin de semana) |
| Mensajería: SNS (`orquesta-notifications`) + SQS (4 colas + DLQs) | ~0,05 | ~15 |
| KMS ECDSA P-256 (1 CMK + firmas; o SSM/Secrets fallback) | ~1,15 (o ~0,00 con SSM) | ~15 |
| Secrets Manager (2–4 secretos) | ~0,80 | ~2 |
| Email: SES (sandbox / adaptador captura en Lab) | ~0,20 (≈2 000 emails) | ~400 (4 M) |
| **SMS: SNS Transactional SMS** | **~25 (≈500 SMS reales de prueba)** | **~24 000–400 000 (4 M)** |
| Observabilidad: CloudWatch Logs & Metrics | ~0,20 | ~200 |
| **Total** | **~30 (o ~5,50 sin SMS real)** | **~26 000–402 000** |
| **Rubro dominante** | **SMS** si hay envío real; si no, RDS | **SMS, ≈85–99 % del total** |

**Conclusión financiera y técnica:** El resto de la arquitectura —CloudFront, S3, API Gateway v2, Lambdas, Aurora PostgreSQL Serverless v2, SNS y SQS— suma **~USD 1 900–2 300/mes** a escala total de 4 M invitados/mes (sin costos fijos de VPC/NAT/Redis ni DynamoDB), mientras que el SMS sigue siendo el **85–99 % del gasto** por decisión de producto (`D11`), mitigado mediante el parámetro configurable `canales_activos` (§11). En el Learner Lab, operar en modo `rds_lab` sin SMS reales mantiene el gasto en **< USD 6/mes** dentro del presupuesto de USD 100.
