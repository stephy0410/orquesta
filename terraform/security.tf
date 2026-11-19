# CMK asimétrica ECDSA P-256 para firma offline ES256 del QR y del roster (TR-06)
resource "aws_kms_key" "qr_signer" {
  count                    = var.enable_kms_signer ? 1 : 0
  description              = "Orquesta ES256 offline QR and roster signer (TR-06)"
  customer_master_key_spec = "ECC_NIST_P256"
  key_usage                = "SIGN_VERIFY"
  deletion_window_in_days  = 7
}

resource "aws_kms_alias" "qr_signer" {
  count         = var.enable_kms_signer ? 1 : 0
  name          = "alias/${local.name_prefix}-qr-signer-${random_id.suffix.hex}"
  target_key_id = aws_kms_key.qr_signer[0].key_id
}

# Secretos de aplicación fuera del bundle (NFR-07)
resource "aws_secretsmanager_secret" "app_secrets" {
  name                    = "${local.name_prefix}/app-secrets-${random_id.suffix.hex}"
  description             = "Credenciales PostgreSQL, secreto de sesión y webhook PSP para Orquesta"
  recovery_window_in_days = local.is_lab ? 0 : 30
}

resource "aws_secretsmanager_secret_version" "app_secrets" {
  secret_id = aws_secretsmanager_secret.app_secrets.id
  secret_string = jsonencode({
    db_host            = local.db_endpoint
    db_port            = local.db_port
    db_name            = var.db_name
    db_username        = var.db_master_username
    db_password        = random_password.db_password.result
    session_secret     = random_password.session_secret.result
    psp_webhook_secret = random_password.psp_webhook_secret.result
    pii_encryption_key = random_password.pii_encryption_key.result
    # Pagos con Stripe Checkout (FR6); vacíos = PSP simulado.
    stripe_secret_key     = var.stripe_secret_key
    stripe_webhook_secret = var.stripe_webhook_secret
  })
}

# Security Groups
resource "aws_security_group" "lambda_sg" {
  name        = "${local.name_prefix}-lambda-sg-${random_id.suffix.hex}"
  description = "Security group para funciones Lambda cuando operan dentro de la VPC"
  vpc_id      = data.aws_vpc.default.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "rds_proxy_sg" {
  count       = var.enable_rds_proxy ? 1 : 0
  name        = "${local.name_prefix}-rds-proxy-sg-${random_id.suffix.hex}"
  description = "Security group para RDS Proxy entre Lambdas y PostgreSQL"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description     = "PostgreSQL desde Lambda SG hacia RDS Proxy"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.lambda_sg.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "db_sg" {
  name        = "${local.name_prefix}-db-sg-${random_id.suffix.hex}"
  description = "Security group para PostgreSQL (RDS / Aurora)"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description     = "PostgreSQL desde Lambda SG"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.lambda_sg.id]
  }

  dynamic "ingress" {
    for_each = var.enable_rds_proxy ? [1] : []
    content {
      description     = "PostgreSQL desde RDS Proxy SG"
      from_port       = 5432
      to_port         = 5432
      protocol        = "tcp"
      security_groups = [aws_security_group.rds_proxy_sg[0].id]
    }
  }

  dynamic "ingress" {
    for_each = var.lambda_in_vpc ? [] : [1]
    content {
      description = "PostgreSQL con TLS cuando Lambdas corren fuera de VPC en Learner Lab (sin NAT Gateway)"
      from_port   = 5432
      to_port     = 5432
      protocol    = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
