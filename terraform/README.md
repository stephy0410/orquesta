# Infraestructura de Orquesta en AWS (Terraform)

Infraestructura como código alineada con [`docs/delivery/05-high-level-design.md`](../docs/delivery/05-high-level-design.md) y verificada contra la cuenta de AWS Learner Lab (`647018795197`, `us-east-1`).

## Módulos y archivos principales

- `versions.tf` / `variables.tf` / `main.tf`: Providers (`aws`, `archive`, `random`), variables parametrizables y lookup de `LabRole`, VPC por defecto y versión PostgreSQL `16.11`.
- `storage.tf`: Buckets S3 `assets` (shell estático `/invitacion/#t=...`, QR PNGs, Website + CORS con `Expose-Headers: ETag`) y `imports` (privado con expiración a 7 días), más CloudFront condicional.
- `security.tf`: CMK asimétrica KMS `ECC_NIST_P256` (`TR-06`), Secrets Manager (`NFR-07`) y Security Groups (`lambda_sg`, `db_sg`).
- `database.tf`: Selector por `db_mode` entre RDS PostgreSQL `db.t4g.micro` (`rds_lab`) y Aurora PostgreSQL Serverless v2 (`aurora`).
- `messaging.tf`: Tópico SNS `orquesta-notifications` en *fan-out* hacia `notify_sms` y `notify_email`, más `import_jobs` y `projection` (todas con DLQs).
- `compute_api.tf`: 6 Lambdas con `LabRole`, `scaling_config` de SQS para proteger el pool de PostgreSQL, `maximum_batching_window_in_seconds = 1` en `projector` (`TR-05`) y API Gateway HTTP API v2.
- `scheduler.tf`: Regla EventBridge `rate(1 minute)` hacia `outbox_poller` para *sweep* de outbox rezagado (`NFR-06`), recordatorios (`RF-10`), expiraciones (`RF-17`), `indeterminado` a 15 min (`RF-04`) y retención PII (`NFR-08`).
- `observability.tf`: Log groups con retención controlada y alarmas CloudWatch de `NFR-09` (`lag_frescura` p95 > 5 000 ms, `offline_queue_depth` > 500, `psp_error` > 0 y DLQs > 0).

## Modos disponibles (`db_mode` y `environment`)

| Variable | Default (`lab`) | Producción (`prod`) | Propósito |
| --- | --- | --- | --- |
| `db_mode` | `"rds_lab"` (`db.t4g.micro`) | `"aurora"` (Aurora PostgreSQL Serverless v2 `0.5–4.0` ACU) | Cuidar el crédito de \$100 USD en Learner Lab manteniendo el mismo esquema PostgreSQL |
| `enable_cloudfront` | `false` | `true` | `cloudfront:*` está bloqueado por `Pvoclabs` en Learner Lab; en Lab se usa S3 Website |
| `email_provider_mode` | `"capture"` | `"ses"` | `ses:*` está bloqueado por `Pvoclabs` en Learner Lab |
| `sms_provider_mode` | `"capture"` | `"sns"` | Evita consumir el crédito de \$100 USD en pruebas automatizadas; activable con `"sns"` para envío real |
| `lambda_in_vpc` | `false` | `true` (con NAT/VPC Endpoints) | Evita timeouts hacia SQS/SNS/Secrets Manager en Learner Lab sin NAT Gateway (~USD 32/mes) |

## Comandos principales

```powershell
cd terraform
terraform fmt -check
terraform init
terraform validate
terraform plan -out=tfplan
```

Para validar un plan en modo **Aurora PostgreSQL Serverless v2**:

```powershell
terraform plan -var="db_mode=aurora"
```

Cuando estés listo para desplegar en el Learner Lab:

```powershell
terraform apply tfplan
```

Y al terminar tu sesión de pruebas (para no consumir crédito innecesario de RDS):

```powershell
terraform destroy
```
