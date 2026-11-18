# Orquesta — Documentación de entrega

Documentado con el **delivery framework** de Hello Interview (Requirements → Core Entities → API → Data Flow → High Level Design → Deep Dives).

## Cómo leer esto

Hay dos capas, y la diferencia importa:

| Capa | Qué es | Autoridad |
| --- | --- | --- |
| **`docs/requerimientos.md`** | La spec normativa: 22 RF, 12 NFR, 20 TR, 29 AC, decisiones `D1`–`D11`, correcciones de capacidad y log de cambios | **Fuente única de verdad** |
| **`docs/delivery/`** (esta carpeta) | La narrativa de diseño en el orden del framework, más los anexos de esquema y contratos | Derivada: no introduce requisitos nuevos |

Si esta carpeta contradice `docs/requerimientos.md`, gana `docs/requerimientos.md`.

## Secciones del framework

| § | Sección | Archivo | Qué contiene |
| --- | --- | --- | --- |
| 1 | Requirements | [`01-requisitos.md`](01-requisitos.md) | 12 funcionales priorizados, 6 no funcionales cuantificados, capacidad que sí influye en el diseño, gate del MVP |
| 2 | Core Entities | [`02-entidades.md`](02-entidades.md) | Mapa de las 22 entidades, campos que importan, invariantes clave |
| 3 | API / System Interface | [`03-api.md`](03-api.md) | Protocolo, convenciones transversales y **resolución de contradicciones** entre los dos contratos |
| 4 | Data Flow | [`04-data-flow.md`](04-data-flow.md) | Cinco flujos de punta a punta y dónde vive cada decisión |
| 5 | High Level Design | [`05-high-level-design.md`](05-high-level-design.md) | Arquitectura AWS, componentes, recorrido por endpoint, costos |
| 6 | Deep Dives | [`06-deep-dives.md`](06-deep-dives.md) | Los siete problemas difíciles y qué se rompe si falta cada mecanismo |
| 7 | System Design (`back/` y `front/`) | [`07-system-design-back-front.md`](07-system-design-back-front.md) | Arquitectura interna de las 6 Lambdas, migraciones PostgreSQL y workspace Angular + PWA offline-first |

## Anexos (detalle que excede el framework)

| Archivo | Contenido |
| --- | --- |
| [`02a-entidades-core.md`](02a-entidades-core.md) | Esquema completo: `User`, `EventMembership`, `Venue`, `Event`, `EventRequirement`, `Guest`, `Invitation`, `EventAccessToken` |
| [`02b-entidades-operacion.md`](02b-entidades-operacion.md) | Esquema completo de operación y check-in: `StaffAssignment`, `InvitationDelivery`, `RsvpResponse`, `CheckinEvent`, `DeviceSyncState`, `Table`, `SeatAssignment`, `ReminderJob`, `AuditEntry` |
| [`02c-entidades-contratacion.md`](02c-entidades-contratacion.md) | Esquema completo de contratación y dinero: `WorkerProfile`, `AvailabilityWindow`, `WorkerReservation`, `Payment`, `PaymentEntry` |
| [`03a-api-planner-invitado.md`](03a-api-planner-invitado.md) | Contrato HTTP de la consola del planner y la página pública de la invitación |
| [`03b-api-trabajador-scan.md`](03b-api-trabajador-scan.md) | Contrato HTTP de la consola del trabajador, el check-in offline y la aceptación de trabajo |

## Aclaración que evita una lectura equivocada

El token del invitado aparece en dos lugares distintos y **no es una contradicción**:

- **Shell cacheable**: `https://<dominio>/invitacion/#t=<rsvp_token>`. El token va en el *fragment*, que el navegador no envía al servidor: la URL del shell HTML/JS en CloudFront + S3 es un único objeto cacheable y el hit de CDN supera el 95 % (`NFR-02`), al igual que el PNG del QR (`qr/{qr_token}.png`) y los metadatos públicos del evento.
- **Llamada al API**: `GET`/`POST /v1/public/invitations/{rsvp_token}/rsvp`, con `Cache-Control: no-store`. El token sí viaja en la ruta del API, que no se cachea nunca.

Regla: **el shell y el QR PNG se cachean, el estado del RSVP nunca.**

## Restricciones de plataforma

La arquitectura utiliza **API Gateway HTTP API v2 + Lambda**, **S3 + CloudFront**, **Aurora PostgreSQL Serverless v2** en producción (parametrizable en Terraform como **RDS PostgreSQL `db.t4g.micro`** en AWS Learner Lab mediante `db_mode`), y **SNS (`orquesta-notifications`) + SQS (+ DLQs)** para fan-out paralelo de SMS/email, imports y proyección de contadores del tablero (`event_counters`), sin DynamoDB, Redis ni Kinesis.

Verificación en vivo sobre la cuenta **AWS Learner Lab** (`647018795197`, `us-east-1`, sesiones de 4 h, crédito de USD 100, `LabRole` compartido):
- **Operativos y verificados:** `apigatewayv2`, `lambda` (con `LabRole`), `rds` (`postgres` y `aurora-postgresql`), `s3`, `sns`, `sqs`, `kms`, `secretsmanager` y `ec2` (`vpc-0d444a684030d7067` con 6 subredes).
- **Bloqueados por la política `Pvoclabs` (`AccessDenied`):** `cloudfront:*`, `ses:*` e `iam:CreateRole`/`GetPolicyVersion`. Por ello, Terraform parametriza `enable_cloudfront = false` (sirviendo los estáticos y QR PNG desde S3 Website / S3 en el Lab) y `email_provider_mode = "capture"` por defecto en `lab`, activables en `prod` (ver "Qué no se puede demostrar en Learner Lab" en `06-deep-dives.md`).