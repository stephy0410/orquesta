# Orquesta — Backend (`back/`)

Servicios serverless en Node.js 20 (ESM) sobre AWS Lambda y migraciones SQL de PostgreSQL (RDS / Aurora Serverless v2).

## Diseño Técnico

Consulta el diseño completo en [`docs/delivery/07-system-design-back-front.md`](../docs/delivery/07-system-design-back-front.md), los esquemas de base de datos en [`docs/delivery/02-entidades.md`](../docs/delivery/02-entidades.md) y los contratos HTTP en [`docs/delivery/03-api.md`](../docs/delivery/03-api.md).

## Estructura

- `migrations/`: DDL SQL para las 22 entidades de dominio, `event_counters` (read model), `outbox_event` e `idempotency_record`.
- `src/shared/`: Pool PostgreSQL, criptografía (AES-256-GCM, SHA-256, ES256 KMS), middleware HTTP (`Cookie httpOnly` / `Bearer`, `EventMembership`, `Idempotency-Key`), métricas CloudWatch EMF y puertos (`SmsProvider`, `EmailProvider`, `PaymentProvider`, `QrSigner`).
- `src/lambdas/`:
  - `api/`: Handler HTTP para API Gateway HTTP API v2 + *immediate outbox flush*.
  - `import-worker/`: Procesamiento streaming de CSVs (≤ 20 000 filas) desde S3 con validación atómica de aforo y generación de QR PNG.
  - `outbox-poller/`: Sweep cada 1 min vía EventBridge (outbox rezagado, `ReminderJob`, expiración `48 h`/`15 min`, `indeterminado` a 15 min y retención `NFR-08`).
  - `projector/`: Consumidor SQS con ventana de coalescing de 1 s (`TR-05`) sobre `event_counters`.
  - `notify-sms/` y `notify-email/`: Consumidores SQS paralelos alimentados por el tópico SNS `orquesta-notifications`.
