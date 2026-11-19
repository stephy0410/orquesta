# Infraestructura de Orquesta en AWS (Terraform)

Infraestructura como código alineada con [`docs/delivery/05-high-level-design.md`](../docs/delivery/05-high-level-design.md) y verificada contra la cuenta de AWS Learner Lab (`647018795197`, `us-east-1`).

## Módulos y archivos principales

- `versions.tf` / `variables.tf` / `main.tf`: Providers (`aws`, `archive`, `random`), variables parametrizables y lookup de `LabRole`, VPC por defecto y versión PostgreSQL `16.11`.
- `storage.tf` + `scripts/lab-s3-buckets.mjs`: Buckets S3 `assets` (shell estático `/invitacion/#t=...`, QR PNGs, Website + CORS con `Expose-Headers: ETag`) y `imports` (privado con expiración a 7 días), más CloudFront condicional. En Learner Lab (`manage_s3_with_cli` automático con `use_lab_role=true`), crea/elimina los buckets vía AWS CLI para evitar el bloqueo de `s3:GetBucketObjectLockConfiguration`; en cuenta propia/`prod` usa `aws_s3_bucket` nativo con bloques `moved` para preservar estados existentes (`personal`/`prod`). Si migras un estado previo de `lab` al modo CLI, ejecuta primero `terraform state rm aws_s3_bucket.assets aws_s3_bucket.imports` para evitar que Terraform destruya los buckets anteriores.
- `security.tf`: CMK asimétrica KMS `ECC_NIST_P256` (`TR-06`), Secrets Manager (`NFR-07`) y Security Groups (`lambda_sg`, `db_sg`, `rds_proxy_sg`).
- `database.tf`: Selector por `db_mode` entre RDS PostgreSQL `db.t4g.micro` (`rds_lab`) y Aurora PostgreSQL Serverless v2 (`aurora`), más RDS Proxy opcional (`enable_rds_proxy`, issue #32).
- `messaging.tf`: Tópico SNS `orquesta-notifications` en *fan-out* hacia `notify_sms` y `notify_email`, más `import_jobs` y `projection` (todas con DLQs).
- `compute_api.tf`: 6 Lambdas con `LabRole` o rol mínimo (`iam.tf`), `DB_POOL_MAX`, `api_reserved_concurrency`, `scaling_config` de SQS para proteger el pool de PostgreSQL, `maximum_batching_window_in_seconds = 1` en `projector` (`TR-05`) y API Gateway HTTP API v2.
- `scheduler.tf`: Regla EventBridge `rate(1 minute)` hacia `outbox_poller` para *sweep* de outbox rezagado (`NFR-06`), recordatorios (`RF-10`), expiraciones (`RF-17`), `indeterminado` a 15 min (`RF-04`) y retención PII (`NFR-08`).
- `observability.tf`: Log groups con retención controlada y alarmas CloudWatch de `NFR-09` (`lag_frescura` p95 > 5 000 ms, `offline_queue_depth` > 500, `psp_error` > 0 y DLQs > 0).

## Producción (`prod`) y estado local

El despliegue se ejecuta localmente con Terraform usando estado local (se eliminó el workflow de CD en GitHub Actions y el estado remoto en S3). Para `prod` se pasa `-var environment=prod -var use_lab_role=false -var enable_cloudfront=true -var enable_waf=true -var email_provider_mode=ses -var sms_provider_mode=sns -var lambda_in_vpc=true -var enable_rds_proxy=true` (**prerrequisito:** contar con NAT Gateway o VPC Interface Endpoints para Secrets Manager, KMS, SQS, SNS, SES y S3 antes de activar `lambda_in_vpc=true`): Aurora con réplica en otra zona, RDS Proxy, CloudFront + WAF, SES, SMS real y firma con KMS. Archivos adicionales:

- `domain.tf`: dominio propio opcional (`custom_domain` + `route53_zone_id`). Crea el certificado ACM, el alias de CloudFront, los registros A/AAAA y, con SES, la verificación del dominio, DKIM, SPF y DMARC. También fija `PUBLIC_BASE_URL` y `EMAIL_FROM` de las Lambdas.
- `waf.tf`: Web ACL en CloudFront (reglas administradas de AWS + límite por IP; `SizeRestrictions_BODY` en modo *count* para no romper el import de CSV ni los lotes de check-in).
- `observability.tf`: tópico SNS de alarmas (`alarm_email` opcional) y alarmas de 5xx, latencia p99, errores por Lambda y colas atascadas, además de las de negocio.
- `database.tf`: `aurora_reader_instances` (default 1) para failover entre zonas en `prod`.

## Modos disponibles (`db_mode` y `environment`)

| Variable | Default (`lab`) | Producción (`prod`) | Propósito |
| --- | --- | --- | --- |
| `db_mode` | `"rds_lab"` (`db.t4g.micro`) | `"aurora"` (Aurora PostgreSQL Serverless v2 `0.5–4.0` ACU) | Cuidar el crédito de \$100 USD en Learner Lab manteniendo el mismo esquema PostgreSQL |
| `enable_cloudfront` | `false` | `true` | `cloudfront:*` está bloqueado por `Pvoclabs` en Learner Lab; en Lab se usa S3 Website |
| `email_provider_mode` | `"capture"` | `"ses"` | `ses:*` está bloqueado por `Pvoclabs` en Learner Lab |
| `sms_provider_mode` | `"capture"` | `"sns"` | Evita consumir el crédito de \$100 USD en pruebas automatizadas; activable con `"sns"` para envío real |
| `lambda_in_vpc` | `false` | `true` (con NAT/VPC Endpoints) | Evita timeouts hacia SQS/SNS/Secrets Manager en Learner Lab sin NAT Gateway (~USD 32/mes) |
| `manage_s3_with_cli` | `true` (si `use_lab_role=true`) | `false` | Evita el error de `s3:GetBucketObjectLockConfiguration` en Learner Lab usando AWS CLI (`scripts/lab-s3-buckets.mjs`) |
| `enable_rds_proxy` | `false` | `true` (requiere `lambda_in_vpc=true`) | Multiplexa conexiones PostgreSQL a escala (~USD 20/mes, issue #32) |
| `db_pool_max` | `5` (`2` con RDS Proxy) | `2` | Tope de conexiones por instancia Lambda (`DB_POOL_MAX`) |
| `api_reserved_concurrency` | `-1` (sin reserva) | `> 0` (según cuota) | Reserva capacidad para `api` en picos de check-in |

## Cuenta propia de AWS (fuera de Learner Lab)

Learner Lab bloquea SES, SMS, CloudFront, WAF y Aurora, así que para probar correo real y HTTPS con CloudFront se despliega en una cuenta propia con el perfil barato de `lab`:

```bash
export AWS_PROFILE=orquesta            # usuario IAM con AdministratorAccess (no la cuenta root)
terraform workspace new personal       # estado separado del de Learner Lab
terraform apply \
  -var use_lab_role=false \
  -var enable_cloudfront=true \
  -var email_provider_mode=ses -var ses_sender_email=<tu-correo> \
  -var sms_provider_mode=sns
```

- `use_lab_role=false` crea el rol de las Lambdas con permisos mínimos ([`iam.tf`](iam.tf)) y usa `aws_s3_bucket` nativo.
- SES arranca en *sandbox*: el remitente recibe un correo de verificación y solo se puede enviar a correos verificados.
- SNS SMS también arranca en *sandbox*: cada teléfono destino se verifica con `aws sns create-sms-sandbox-phone-number --phone-number +52…` y el código que llega por SMS.
- Costo aproximado: unos USD 5–10 al mes (IP pública de RDS, KMS, Secrets Manager y alarmas); RDS micro, Lambda, API Gateway, SQS y CloudFront entran en la capa gratuita. `terraform destroy` lo borra todo.
- La llave de Stripe se pasa con `TF_VAR_stripe_secret_key`; sin ella los pagos usan el PSP simulado.

## Comandos principales (Learner Lab)

Antes de aplicar Terraform, genera el build del front y las dependencias de producción de `back`:

```powershell
cd front; npm ci; npx ng build
cd ..\back; npm ci --omit=dev
cd ..\terraform
terraform fmt -check
terraform init
terraform validate
terraform plan -out=lab.tfplan
```

Para validar un plan en modo **Aurora PostgreSQL Serverless v2**:

```powershell
terraform plan -var="db_mode=aurora" -var="use_lab_role=false"
```

Cuando estés listo para desplegar en el Learner Lab:

```powershell
terraform apply lab.tfplan
```

Y al terminar tu sesión de pruebas (para no consumir crédito innecesario de RDS):

```powershell
terraform destroy
```
