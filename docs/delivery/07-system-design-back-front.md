# 07 — System Design: Backend (Lambdas) y Frontend (Angular PWA)

Diseño técnico detallado de las capas de aplicación **`back/`** (6 funciones AWS Lambda + migraciones PostgreSQL) y **`front/`** (workspace Angular con Standalone Components, Signals y PWA offline-first), alineado con [`docs/requerimientos.md`](../requerimientos.md) (v2.1), las entidades de [`02-entidades.md`](./02-entidades.md), los contratos unificados de [`03-api.md`](./03-api.md) y la infraestructura en [`terraform/`](../../terraform/README.md).

---

## 1. Estructura de 4 Carpetas del Repositorio

```text
orquesta/
├── docs/       # Requerimientos normativos (requerimientos.md) y Delivery Framework (01..07)
├── terraform/  # Infraestructura AWS parametrizable (db_mode: rds_lab | aurora)
├── back/       # Migraciones SQL, dominio compartido (puertos/adaptadores) y 6 Lambdas Node.js
└── front/      # Workspace Angular 18+ (Standalone + Signals + @angular/pwa + IndexedDB)
```

---

## 2. System Design del Backend (`back/` — Lambdas + PostgreSQL)

### 2.1 Arquitectura Hexagonal Ligera y Layout de Carpetas

El backend adopta una arquitectura de **puertos y adaptadores** sobre Node.js 20 (`ESM`), compartiendo código de dominio y acceso a datos para evitar duplicación entre la Lambda HTTP y los workers SQS/EventBridge:

```text
back/
├── migrations/                  # DDL SQL ordenado: 22 entidades + event_counters + outbox_event + idempotency_record
└── src/
    ├── shared/
    │   ├── config/              # Lectura cacheada de Secrets Manager (db, session_secret, psp_webhook_secret)
    │   ├── db/                  # Pool pg (TLS obligatorio), helper tx(), pg_advisory_xact_lock(), batch INSERT, outbox
    │   ├── crypto/              # Hash argon2id/scrypt, SHA-256 rsvp_token_hash, AES-256-GCM PII, ES256 (KMS / local)
    │   ├── http/                # Parser Cookie httpOnly + Bearer, AuthZ EventMembership/StaffAssignment, Idempotency-Key, envelope de errores
    │   ├── observability/       # Emisión EMF (Embedded Metric Format) a CloudWatch namespace "Orquesta" (NFR-09)
    │   └── ports/               # SmsProvider, EmailProvider, PaymentProvider, QrSigner (+ adaptadores Lab/Prod)
    └── lambdas/
        ├── api/                 # API Gateway HTTP API v2 router + immediate outbox flush
        ├── import-worker/       # SQS import_jobs: streaming CSV, normalización, aforo atómico, QR PNG → S3
        ├── outbox-poller/       # EventBridge rate(1 min): outbox rezagado, ReminderJob, expiración 48h/15m, indeterminado, NFR-08
        ├── projector/           # SQS projection (window 1 s): deltas coalesced → event_counters
        ├── notify-sms/          # SQS notify_sms: SMS via puerto SmsProvider + estado InvitationDelivery
        └── notify-email/        # SQS notify_email: Email 1-a-1 con QR via puerto EmailProvider + estado InvitationDelivery
```

### 2.2 Capa Compartida (`back/src/shared/`)

1. **Acceso a datos y control de concurrencia (`shared/db/`):**
   - **Pool PostgreSQL:** Cachea el pool entre invocaciones *warm* de Lambda usando credenciales obtenidas de Secrets Manager en *cold start*, con TLS activo y `max` de conexiones acotado para no saturar `db.t4g.micro` (`rds_lab`).
   - **Reservas cross-evento (`TR-08`, `D10`):** La aceptación ejecuta `SELECT pg_advisory_xact_lock(hashtextextended($worker_id::text, 0))` dentro de la transacción, verifica contención en `availability_window` (`422 WINDOW_NOT_AVAILABLE`) y suma `plazas` de reservas `aceptada` solapadas (`tstzrange(inicio, fin, '[)') && ...`) sin *read-then-write* (`409 RESERVATION_OVERLAP` con `details.ganadora`).
   - **Check-in en lote (`TR-01`, `TR-03`, `TR-17`):** Inserta los ≤ 500 eventos en una sola transacción multi-fila contra la tabla append-only `checkin_event` usando `ON CONFLICT`:
     - Replay mismo dispositivo `(invitation_id, device_id, sequence)` → no-op, conserva el veredicto original (`AC-03`).
     - Conflicto cross-dispositivo `(invitation_id, admision_ciclo) WHERE kind = 'admitido'` → inserta como `kind = 'duplicado_tardio'`, `veredicto = 'ya_registrado'` (`AC-05`).
   - **Outbox transaccional (`TR-05`, `NFR-06`):** Toda escritura que afecta contadores (`Guest`, `RsvpResponse`, `InvitationDelivery`, `CheckinEvent`) o dispara avisos inserta su evento en `outbox_event` dentro de la **misma transacción** SQL.

2. **Criptografía, tokens y PII (`shared/crypto/`, `NFR-07`, `TR-06`, `TR-07`):**
   - **Contraseñas:** Hash con sal por usuario (`argon2id` o `crypto.scrypt` paramétrico), nunca devuelto en proyecciones.
   - **PII en reposo (`NFR-07`):** `email_normalizado`, `telefono_e164` y `direccion_cifrada` se cifran con AES-256-GCM usando llave de datos protegida por Secrets Manager/KMS, conservando hashes deterministas HMAC-SHA-256 para búsquedas e índices `UNIQUE` de deduplicación (`TR-11`, `TR-12`).
   - **Tokens separados (`RF-03`, `TR-07`):**
     - `rsvp_token`: ≥ 128 bits aleatorios (`crypto.randomBytes(24)` base64url); se guarda su `SHA-256` en `invitation.rsvp_token_hash`.
     - `qr_token`: compact JWS firmado con **ES256** (`ECDSA P-256`) conteniendo `{invitation_id, event_id, token_version, key_id}`.
   - **Puerto `QrSigner`:** En producción firma vía AWS KMS (`ECC_NIST_P256`); la clave pública PEM se exporta una vez y viaja embebida en el roster firmado para verificación offline en el navegador (`TR-06`).

3. **Puertos y Adaptadores (`shared/ports/`):**
   - `SmsProvider`: `SnsSmsAdapter` (`SMS_PROVIDER_MODE=sns`) o `CaptureSmsAdapter` (`capture`, guarda el mensaje en log/tabla de captura para probar el Lab sin gastar el crédito de USD 100).
   - `EmailProvider`: `SesEmailAdapter` (`EMAIL_PROVIDER_MODE=ses`) o `CaptureEmailAdapter` (`capture`, usado por defecto en Learner Lab donde `ses:*` está bloqueado por `Pvoclabs`).
   - `PaymentProvider` (`TR-14`, `D1`, `D5`): Interfaz con `charge(idempotencyKey, amount, currency)`, `queryByKey(idempotencyKey)` y `refund(...)`, respaldada por `MockStripeTestAdapter` y un *contract test* verificable.

4. **Middleware HTTP (`shared/http/`, `03-api.md`):**
   - **Autenticación dual (`RF-19`, `03-api.md` §2):** Lee `Cookie: session=...` (`httpOnly; SameSite=Lax; Secure`) como mecanismo primario de navegador y `Authorization: Bearer <jwt>` para la PWA de escaneo (`EventAccessToken` canjeado por `session_token`) y tests.
   - **Autorización por membresía (`NFR-11`, `03-api.md` §3.b):** Evalúa `EventMembership` (`owner`/`editor`) o `StaffAssignment`. Si el usuario **nunca** tuvo relación con el evento responde `404 NOT_FOUND`; si tuvo relación y fue revocada o venció responde `403 FORBIDDEN_EVENT_SCOPE`.
   - **Idempotencia HTTP:** Valida `Idempotency-Key` contra la tabla `idempotency_record` dentro de la transacción de negocio (misma clave + mismo hash de cuerpo → repite respuesta original; misma clave + cuerpo distinto → `409 IDEMPOTENCY_CONFLICT`).
   - **Métricas CloudWatch (`NFR-09`):** Emite logs estructurados EMF (sin costo adicional de llamadas `PutMetricData`) hacia el namespace `Orquesta` para `lag_frescura`, `checkin_rate`, `offline_queue_depth`, `reservation_conflicts`, `notif_retry`, `notif_bounce`, `psp_error` y `worker_search_zero_results`.

### 2.3 Responsabilidad y Flujo de Cada Lambda

| Lambda | Disparador | Concurrencia / Límites | Responsabilidad y Flujo Crítico |
| --- | --- | --- | --- |
| **`api`** | API Gateway HTTP API v2 (`ANY /v1/{proxy+}`, `GET /health`) | Timeout `29 s`, `512 MB`, *throttling* `burst=500 / rate=250` | Router modular (`auth`, `events`, `members`, `guests`, `invitations`, `public-rsvp`, `dashboard`, `seating`, `workers`, `requests`, `scan-sessions`, `checkins`, `payments`, `webhooks/psp`). Tras `COMMIT` de escrituras que generan filas en `outbox_event`, ejecuta un ***immediate outbox flush*** hacia `PROJECTION_QUEUE_URL` / `NOTIFICATIONS_SNS_ARN` y marca `published_at` para cumplir `NFR-03` (≤ 5 s p95) sin esperar al cron de 1 minuto. |
| **`import-worker`** | SQS `import_jobs` (+ DLQ, `maxReceiveCount=3`) | `batch_size=1`, `maximum_concurrency=2`, timeout `300 s`, `/tmp` `1024 MB` | Descarga el CSV desde S3 `imports/`, procesa por streaming en páginas de 500 filas, normaliza email/E.164, deduplica dentro del evento (`TR-11`), valida `aforo` de forma atómica (`422 AFORO_EXCEDIDO` con `0` creados si excede, `AC-20`), inserta `Guest` + `Invitation` (`pendiente_envio`), genera PNGs de QR en S3 `assets` y actualiza `ImportJob` + delta en `outbox_event`. |
| **`outbox-poller`** | EventBridge `rate(1 minute)` (`scheduler.tf`) | Timeout `60 s`, `256 MB` | Ejecuta 5 barridos idempotentes cada minuto: **(1)** republica filas de `outbox_event` con `published_at IS NULL` que no salieron en el *flush* inmediato (`NFR-06`), **(2)** dispara `ReminderJob` con `disparar_en <= now()` (`RF-10`), **(3)** expira `WorkerReservation` en `solicitada` con `expira_en <= now()` (`48 h` / `15 min`, `RF-17`), **(4)** marca `InvitationDelivery` en `encolado` > 15 min como `indeterminado` (`RF-04`), **(5)** ejecuta la anonimización de PII a 12/24 meses (`NFR-08`). |
| **`projector`** | SQS `projection` (+ DLQ, `maxReceiveCount=5`) | `batch_size=100`, `maximum_batching_window_in_seconds=1`, `maximum_concurrency=5` | Agrupa los deltas de `outbox_event` por `event_id` en la ventana de coalescing de 1 s (`TR-05`), deduplica contra tabla/registro `projector_applied(outbox_event_id)` y ejecuta un solo `UPDATE event_counters` atómico por `event_id` registrando `ultimo_t_ingest` para medir `lag_frescura` (`NFR-03`). |
| **`notify-sms`** | SQS `notify_sms` (suscrita a SNS `orquesta-notifications`, + DLQ) | `batch_size=10`, `maximum_concurrency=5`, `maxReceiveCount=3` | Verifica que el `Guest` no esté dado de baja (`RF-20`) ni el `ReminderJob` cancelado (`RF-10`), descifra `direccion_cifrada`, invoca `SmsProvider` y actualiza `InvitationDelivery` (`entregado` o incrementa `intentos`; al 3er fallo fija `rebotado`). |
| **`notify-email`** | SQS `notify_email` (suscrita a SNS `orquesta-notifications`, + DLQ) | `batch_size=10`, `maximum_concurrency=5`, `maxReceiveCount=3` | Igual flujo que `notify-sms` sobre canal `email`: renderiza plantilla HTML con enlace `/invitacion/#t=<rsvp_token>` y referencia/adjunto de QR, invoca `EmailProvider` (`SES` o `CaptureEmailAdapter` en Lab) y actualiza `InvitationDelivery`. |

---

## 3. System Design del Frontend (`front/` — Angular + Offline Scan PWA)

### 3.1 Estrategia de Despliegue y Workspace Angular

Se diseña un **único workspace Angular (v18+, Standalone Components, Signals, `@angular/pwa`)** con *lazy loading* estricto por superficie para que la página pública del invitado (`/invitacion`) y la PWA de escaneo (`/scan`) carguen en milisegundos sin arrastrar el peso de la consola de administración del planner:

```text
front/
└── src/app/
    ├── core/
    │   ├── auth/                # AuthService (cookie httpOnly / session_token), guards (planner, worker, scanner)
    │   ├── http/                # apiInterceptor (withCredentials, BaseURL, Idempotency-Key UUID v4, mapeo errores)
    │   ├── connectivity/        # ConnectivityService (navigator.onLine + probe /health sin falsos positivos)
    │   ├── crypto/              # QrVerifierService (Web Crypto SubtleCrypto ECDSA P-256 / SHA-256 offline)
    │   └── storage/             # ScanStorageService (wrapper tipado sobre IndexedDB para RPO 0)
    └── features/
        ├── planner/             # Consola desktop-first del planner
        │   ├── dashboard/       # Tablero en vivo (polling 3s, paginación <= 25, DeviceSyncState, lag_ms)
        │   ├── events/          # Alta/edición/transiciones de evento, EventMembership, StaffAssignment, AccessTokens
        │   ├── guests-import/   # Subida CSV, polling ImportJob, pending-summary y disparo confirmado de envíos
        │   ├── seating/         # Plano de mesas, capacidad y lista accionable sin_mesa (RF-12)
        │   └── workers-hire/    # Requerimientos, búsqueda 3 dimensiones, solicitudes, reemplazo emergencia y pagos
        ├── worker/              # Consola mínima del trabajador (RF-17, RF-21, RF-22)
        │   ├── profile-otp/     # Perfil persona/empresa (1..50 plazas), categorías/zonas, verificación email + OTP SMS
        │   ├── availability/    # Gestión de ventanas declaradas [inicio, fin) por rol y zona
        │   └── requests/        # Bandeja aceptar (total/parcial) / rechazar, llegada y estado de pago
        ├── invitation/          # Página pública sin cuenta (/invitacion/#t=<rsvp_token>, NFR-02, RF-18)
        └── scanner/             # Vista PWA instalable para escaneo en venue (RF-13, TR-02, TR-15, NFR-04)
            ├── camera-scanner/  # BarcodeDetector nativo / fallback ZXing WASM en Web Worker
            ├── manual-lookup/   # Fallback sin cámara por nombre + codigo_corto de 6 dígitos en IndexedDB
            └── batch-sync/      # Cola durable, drenaje por lotes <= 500 con backoff/jitter y PUT sync-state
```

### 3.2 Diseño Detallado de las 4 Superficies en Angular

#### A. Consola del Planner (`/planner/*`)
- **Gestión de estado con Angular Signals:** Cada vista mantiene signals locales reactivos (`eventsSignal`, `dashboardSignal`, `importProgressSignal`) sin sobrecarga de boilerplate Redux.
- **Tablero en vivo (`/planner/dashboard`, `RF-06`, `NFR-03`, `NFR-10`):**
  - Paginación estricta `limit <= 25` con cursor opaco.
  - Polling automático cada 3 s (pausado en segundo plano con `document.visibilityState`) mostrando contadores y badge de frescura (`lag_ms`, `lag_p95_ms`).
  - Indicador explícito de dispositivos escáner: cuando un dispositivo supera 5 min sin heartbeat muestra `"desconocido"` en naranja, nunca `0` (`TR-18`).
- **Importación y disparo de envío (`/planner/events/:id/guests`):**
  - El *uploader* adjunta `Idempotency-Key` generado por archivo/sesión y hace polling a `GET .../imports/:importId` hasta `completado`, mostrando el reporte línea por línea (`GUEST_SIN_CLAVE`, `GUEST_DUPLICADO`, `AFORO_EXCEDIDO`).
  - El botón de envío exige paso previo obligatorio leyendo `GET .../invitations/pending-summary` y pidiendo confirmación explícita de `destinatarios_confirmados` (`RF-16`).

#### B. Consola del Trabajador (`/worker/*`)
- **Perfil y OTP (`RF-19`, `RF-21`, `AC-25`):** Formulario guiado que bloquea la publicación (`estado = publicado`) si `email_verificado` o `telefono_verificado` son falsos, con verificación OTP en 2 pasos.
- **Bandeja de solicitudes (`RF-17`, `AC-07`, `AC-22`):** Muestra cuenta regresiva en vivo de `expira_en` (destacando `modo_emergencia` de 15 min) y soporta aceptación parcial (`plazas`) cuando `tipo === 'empresa'`, mostrando el detalle determinista de `ganadora` ante un `409 RESERVATION_OVERLAP`.

#### C. Página Pública de la Invitación (`/invitacion/#t=<rsvp_token>`, `RF-18`, `NFR-02`)
- **Aislamiento de caché CDN:** La ruta Angular usa `HashLocationStrategy` o lee `window.location.hash` (`#t=<rsvp_token>`) al inicializar el componente raíz de `invitation`. Como el *fragment* `#t=...` jamás viaja en peticiones HTTP hacia S3/CloudFront, el shell HTML/JS/CSS es **un único objeto cacheable** con *hit rate* ≥ 95 % (`NFR-02`).
- **Ciclo de vida sin cookies:**
  1. Al montar, lee `rsvp_token` del fragmento y consulta `GET /v1/public/invitations/{rsvp_token}/rsvp` (`Cache-Control: no-store`) para hidratar el estado actual y la URL del QR PNG (`assets`).
  2. Renderiza el QR de check-in siempre visible antes y después de responder (`RF-18`).
  3. Al pulsar "Confirmar" o "Declinar", envía `POST /v1/public/invitations/{rsvp_token}/rsvp` con `Idempotency-Key` y actualiza inmediatamente la vista con la respuesta del `POST`.

#### D. Vista de Escaneo Offline-First (`/scan/*` — PWA, `TR-15`, `NFR-04`, `NFR-05`, `NFR-06`)
1. **Service Worker (`ngsw-config.json`):** Precarga el *app shell*, la ruta `/scan`, el Web Worker de lectura QR y las fuentes/iconos locales para garantizar arranque en modo avión (`AC-04`).
2. **Inicio de sesión de evento (`TR-19`):** Canjea el `EventAccessToken` (`POST /v1/auth/event-session`) por un `session_token` acotado a `(event_id, rol, device_id)` y precarga:
   - `GET /v1/scan-sessions/{id}/roster` (con `If-None-Match`, ≤ 2 000 invitados).
   - `GET /v1/scan-sessions/{id}/revocations` (refresco automático cada vez que haya red; `ttl_horas = 2`).
   - Verifica la firma ES256 del propio roster al recibirlo y guarda la `key_publica_pem` en Web Crypto.
3. **Almacenamiento Durable en `IndexedDB` (`ScanStorageService`, `TR-02`):**
   - `session_meta`: `session_id`, `event_id`, `device_id`, `roster_version`, `last_sequence`, `last_acked_sequence`, `key_publica_pem`.
   - `roster_guests`: clave primaria `invitation_id`, índices en memoria/IDB por `codigo_corto` y `nombre_normalizado`.
   - `revocations`: lista de `invitation_id` revocados + `vigente_hasta` (`emitida_en + 2 h`).
   - `local_admissions`: set de `invitation_id` ya admitidos en este dispositivo (para detectar `ya_registrado` en 1 ms).
   - `outbound_queue`: registros `{ sequence, invitation_id, scanned_at, token_sha256, verdict_local, modo, key_id, synced }` (soporta ≥ 1 000 escaneos y ≥ 8 h offline).
4. **Pipeline de Verificación y RPO 0 en ≤ 100 ms p95 (`QrVerifierService`, `NFR-04`, `NFR-06`):**
   - **Lectura:** `BarcodeDetector` nativo (acelerado por hardware en Android/Chrome) con fallback a librería WASM ejecutada en Web Worker para no congelar la UI.
   - **Verificación criptográfica offline (< 5 ms):** `window.crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, sigBytes, payloadBytes)`.
   - **Evaluación de veredicto (`RF-13`):**
     - Firma inválida → rechazo inmediato.
     - `payload.event_id !== session.event_id` → `no_corresponde_al_evento`.
     - Invitado en `revocations` o `payload.token_version < roster_guest.token_version` → `invitacion_revocada`.
     - Presente en `local_admissions` → `ya_registrado`.
     - Ausente en `roster_guests` → `no_en_roster` (habilita botón de admisión manual condicional marcada).
     - `Date.now() > revocations.vigente_hasta` → `no_verificable_offline` (admisión condicional marcada, TTL 2 h vencido).
     - Caso limpio → `admitido`.
   - **Garantía RPO 0 en dispositivo (`NFR-06`):** La escritura en `IndexedDB.outbound_queue` y `local_admissions` hace `tx.oncomplete` **antes** de renderizar el veredicto verde/amarillo en pantalla.
5. **Fallback Manual sin Cámara (`RF-13`, `P06`):** Búsqueda local sobre `roster_guests` por `codigo_corto` de 6 dígitos o `nombre` que pasa por el mismo pipeline y escribe en la misma `outbound_queue`.
6. **Sincronización Diferible y Heartbeat (`BatchSyncService`, `TR-03`, `TR-18`, `§6.6`):**
   - Al detectar conectividad (`ConnectivityService`), drena `outbound_queue` en lotes de ≤ 500 eventos ordenados por `sequence`, calcula el `sha256` del JSON canónico y envía `POST /v1/scan-sessions/{id}/batches` con *backoff* exponencial + *jitter* aleatorio (evita tormentas de reconexión al volver señal en el venue).
   - Envía `PUT /v1/scan-sessions/{id}/sync-state` cada 60 s y después de cada lote con `{cola_reportada, ultima_seq_ackeada, heartbeat_en}` para alimentar `TR-18` en el tablero del planner.
