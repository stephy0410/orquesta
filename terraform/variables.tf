variable "project_name" {
  description = "Nombre base del proyecto para prefijos y etiquetas."
  type        = string
  default     = "orquesta"
}

variable "environment" {
  description = "Entorno de despliegue: 'lab' para AWS Learner Lab o 'prod' para producción."
  type        = string
  default     = "lab"

  validation {
    condition     = contains(["lab", "prod"], var.environment)
    error_message = "environment debe ser 'lab' o 'prod'."
  }
}

variable "aws_region" {
  description = "Región AWS de despliegue."
  type        = string
  default     = "us-east-1"
}

variable "db_mode" {
  description = "Motor PostgreSQL: 'aurora' (Aurora PostgreSQL Serverless v2) o 'rds_lab' (RDS db.t4g.micro). Vacío = rds_lab en lab, aurora en prod."
  type        = string
  default     = null

  validation {
    condition     = var.db_mode == null || contains(["rds_lab", "aurora"], coalesce(var.db_mode, "rds_lab"))
    error_message = "db_mode debe ser 'rds_lab' o 'aurora'."
  }
}

variable "db_instance_class" {
  description = "Clase de instancia cuando db_mode = 'rds_lab'."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_engine_version_rds" {
  description = "Versión explícita de PostgreSQL para RDS (vacío usa el data source de PostgreSQL 16 en us-east-1)."
  type        = string
  default     = ""
}

variable "db_engine_version_aurora" {
  description = "Versión explícita de Aurora PostgreSQL (vacío usa el data source de Aurora PostgreSQL 16 en us-east-1)."
  type        = string
  default     = ""
}

variable "aurora_min_capacity" {
  description = "ACUs mínimos de Aurora PostgreSQL Serverless v2 cuando db_mode = 'aurora'."
  type        = number
  default     = 0.5
}

variable "aurora_max_capacity" {
  description = "ACUs máximos de Aurora PostgreSQL Serverless v2 cuando db_mode = 'aurora'."
  type        = number
  default     = 4.0
}

variable "db_name" {
  description = "Nombre lógico de la base de datos PostgreSQL."
  type        = string
  default     = "orquesta"
}

variable "db_master_username" {
  description = "Usuario administrador de la base de datos PostgreSQL."
  type        = string
  default     = "orquesta_admin"
}

variable "lambda_in_vpc" {
  description = "Coloca las Lambdas dentro de la VPC. En Learner Lab sin NAT Gateway ni VPC Interface Endpoints se deja en false para evitar timeouts hacia SQS/SNS/Secrets Manager."
  type        = bool
  default     = false
}

variable "enable_cloudfront" {
  description = "Crea CloudFront delante de S3 y API Gateway (false por defecto en Learner Lab porque cloudfront:* está bloqueado por Pvoclabs; true en prod)."
  type        = bool
  default     = false
}

variable "enable_kms_signer" {
  description = "Crea una CMK asimétrica ECC_NIST_P256 en KMS para firma offline ES256 de QR y roster (TR-06)."
  type        = bool
  default     = true
}

variable "canales_activos" {
  description = "Canales activos de notificación (RF-04, D11, §11 de requerimientos.md)."
  type        = list(string)
  default     = ["sms", "email"]
}

variable "email_provider_mode" {
  description = "Adaptador de correo: 'capture' en Learner Lab (ses:* está bloqueado por Pvoclabs) o 'ses' en producción."
  type        = string
  default     = "capture"

  validation {
    condition     = contains(["capture", "ses"], var.email_provider_mode)
    error_message = "email_provider_mode debe ser 'capture' o 'ses'."
  }
}

variable "sms_provider_mode" {
  description = "Adaptador de SMS: 'capture' para pruebas sin gasto de crédito o 'sns' para envío real con SNS Transactional SMS."
  type        = string
  default     = "capture"

  validation {
    condition     = contains(["capture", "sns"], var.sms_provider_mode)
    error_message = "sms_provider_mode debe ser 'capture' o 'sns'."
  }
}

variable "cors_allow_origins" {
  description = "Orígenes CORS adicionales permitidos por API Gateway HTTP API v2 (con allow_credentials = true)."
  type        = list(string)
  default     = ["http://localhost:3000", "http://localhost:4200", "http://localhost:5173"]
}

# ----------------------------------------------------------------------------
# Producción: dominio propio, WAF, alarmas y alta disponibilidad
# ----------------------------------------------------------------------------
variable "custom_domain" {
  description = "Dominio propio (p. ej. 'orquesta.mx'). Vacío = usar los dominios de AWS. Requiere enable_cloudfront = true y route53_zone_id."
  type        = string
  default     = ""
}

variable "route53_zone_id" {
  description = "Hosted zone de Route 53 del custom_domain (para validar el certificado y crear los registros DNS, SPF, DKIM y DMARC)."
  type        = string
  default     = ""
}

variable "use_lab_role" {
  description = "true en AWS Learner Lab (usa su LabRole). false en una cuenta propia: Terraform crea el rol de las Lambdas con permisos mínimos (iam.tf)."
  type        = bool
  default     = true
}

variable "ses_sender_email" {
  description = "Sin dominio propio: correo remitente que SES verifica (llega un correo de confirmación). En sandbox de SES también hay que verificar cada destinatario."
  type        = string
  default     = ""
}

variable "email_from_local_part" {
  description = "Parte local del remitente de los emails cuando hay custom_domain (no-reply@<custom_domain>)."
  type        = string
  default     = "no-reply"
}

variable "enable_waf" {
  description = "Adjunta AWS WAF a CloudFront (reglas administradas + límite por IP). Requiere enable_cloudfront = true."
  type        = bool
  default     = false
}

variable "waf_rate_limit_per_5min" {
  description = "Peticiones máximas por IP en 5 minutos antes de bloquear. Un venue con 10 escáneres detrás de una sola IP hace ~600."
  type        = number
  default     = 3000
}

variable "stripe_secret_key" {
  description = "Llave secreta de Stripe (sk_test_… en lab, sk_live_… en prod). Vacía = PSP simulado. Viene del secret STRIPE_SECRET_KEY del environment de GitHub."
  type        = string
  default     = ""
  sensitive   = true
}

variable "stripe_webhook_secret" {
  description = "Secreto de firma (whsec_…) del endpoint de webhook en Stripe que apunta a /v1/webhooks/psp. Vacío = solo se concilia consultando a Stripe."
  type        = string
  default     = ""
  sensitive   = true
}

variable "alarm_email" {
  description = "Email que recibe las alarmas de CloudWatch (vacío = solo se publican en el tópico SNS de alarmas)."
  type        = string
  default     = ""
}

variable "aurora_reader_instances" {
  description = "Réplicas de lectura de Aurora en otras zonas para failover automático (prod >= 1; en lab no aplica)."
  type        = number
  default     = 1
}
