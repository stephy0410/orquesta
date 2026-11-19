resource "aws_db_subnet_group" "main" {
  name       = "${local.name_prefix}-db-subnets-${random_id.suffix.hex}"
  subnet_ids = data.aws_subnets.default.ids
}

# Modo Learner Lab económico (db_mode = "rds_lab"): RDS PostgreSQL db.t4g.micro
resource "aws_db_instance" "postgres_lab" {
  count = local.db_mode == "rds_lab" ? 1 : 0

  identifier            = "${local.name_prefix}-pg-${random_id.suffix.hex}"
  engine                = "postgres"
  engine_version        = local.rds_engine_version
  instance_class        = var.db_instance_class
  allocated_storage     = 20
  max_allocated_storage = 50
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = var.db_name
  username = var.db_master_username
  password = random_password.db_password.result

  db_subnet_group_name    = aws_db_subnet_group.main.name
  vpc_security_group_ids  = [aws_security_group.db_sg.id]
  publicly_accessible     = !var.lambda_in_vpc
  multi_az                = false
  backup_retention_period = var.db_backup_retention_days
  skip_final_snapshot     = true
  deletion_protection     = false
}

# Modo Producción escalable (db_mode = "aurora"): Aurora PostgreSQL Serverless v2
resource "aws_rds_cluster" "aurora" {
  count = local.db_mode == "aurora" ? 1 : 0

  cluster_identifier      = "${local.name_prefix}-aurora-${random_id.suffix.hex}"
  engine                  = "aurora-postgresql"
  engine_mode             = "provisioned"
  engine_version          = local.aurora_engine_version
  database_name           = var.db_name
  master_username         = var.db_master_username
  master_password         = random_password.db_password.result
  db_subnet_group_name    = aws_db_subnet_group.main.name
  vpc_security_group_ids  = [aws_security_group.db_sg.id]
  storage_encrypted       = true
  backup_retention_period = local.is_lab ? 1 : 7
  skip_final_snapshot     = local.is_lab
  deletion_protection     = !local.is_lab

  serverlessv2_scaling_configuration {
    min_capacity = var.aurora_min_capacity
    max_capacity = var.aurora_max_capacity
  }
}

resource "aws_rds_cluster_instance" "aurora_writer" {
  count = local.db_mode == "aurora" ? 1 : 0

  identifier          = "${local.name_prefix}-aurora-w1-${random_id.suffix.hex}"
  cluster_identifier  = aws_rds_cluster.aurora[0].id
  instance_class      = "db.serverless"
  engine              = aws_rds_cluster.aurora[0].engine
  engine_version      = aws_rds_cluster.aurora[0].engine_version
  publicly_accessible = !var.lambda_in_vpc
}

# Réplica en otra zona de disponibilidad para failover automático (README: "si cae una zona no se
# pierde ningún pago ni check-in confirmado"). El almacenamiento de Aurora ya replica cada escritura
# confirmada en 6 copias sobre 3 AZ; la réplica de lectura aporta el failover del cómputo (RTO).
resource "aws_rds_cluster_instance" "aurora_reader" {
  count = local.db_mode == "aurora" && !local.is_lab ? var.aurora_reader_instances : 0

  identifier          = "${local.name_prefix}-aurora-r${count.index + 1}-${random_id.suffix.hex}"
  cluster_identifier  = aws_rds_cluster.aurora[0].id
  instance_class      = "db.serverless"
  engine              = aws_rds_cluster.aurora[0].engine
  engine_version      = aws_rds_cluster.aurora[0].engine_version
  publicly_accessible = !var.lambda_in_vpc
  promotion_tier      = 1
}

# ----------------------------------------------------------------------------
# RDS Proxy opcional (issue #32, ADR-7): multiplexa conexiones de Lambdas a escala.
# Apagado por defecto en lab/demo (~USD 20/mes); encender con enable_rds_proxy = true y lambda_in_vpc = true.
# ----------------------------------------------------------------------------
resource "aws_secretsmanager_secret" "rds_proxy_credentials" {
  count                   = var.enable_rds_proxy ? 1 : 0
  name                    = "${local.name_prefix}/rds-proxy-creds-${random_id.suffix.hex}"
  description             = "Credenciales PostgreSQL en formato {username, password} requeridas por RDS Proxy"
  recovery_window_in_days = local.is_lab ? 0 : 30
}

resource "aws_secretsmanager_secret_version" "rds_proxy_credentials" {
  count     = var.enable_rds_proxy ? 1 : 0
  secret_id = aws_secretsmanager_secret.rds_proxy_credentials[0].id
  secret_string = jsonencode({
    username = var.db_master_username
    password = random_password.db_password.result
  })
}

resource "aws_db_proxy" "main" {
  count = var.enable_rds_proxy ? 1 : 0

  name                   = "${local.name_prefix}-db-proxy-${random_id.suffix.hex}"
  debug_logging          = false
  engine_family          = "POSTGRESQL"
  idle_client_timeout    = 1800
  require_tls            = true
  role_arn               = local.rds_proxy_role_arn
  vpc_security_group_ids = [aws_security_group.rds_proxy_sg[0].id]
  vpc_subnet_ids         = data.aws_subnets.default.ids

  auth {
    auth_scheme = "SECRETS"
    iam_auth    = "DISABLED"
    secret_arn  = aws_secretsmanager_secret.rds_proxy_credentials[0].arn
  }

  lifecycle {
    precondition {
      condition     = var.lambda_in_vpc
      error_message = "enable_rds_proxy = true requiere lambda_in_vpc = true (RDS Proxy solo es accesible dentro de la VPC)."
    }
  }

  depends_on = [aws_secretsmanager_secret_version.rds_proxy_credentials]
}

resource "aws_db_proxy_default_target_group" "main" {
  count         = var.enable_rds_proxy ? 1 : 0
  db_proxy_name = aws_db_proxy.main[0].name

  connection_pool_config {
    connection_borrow_timeout    = 120
    max_connections_percent      = 90
    max_idle_connections_percent = 50
  }
}

resource "aws_db_proxy_target" "main" {
  count = var.enable_rds_proxy ? 1 : 0

  db_proxy_name          = aws_db_proxy.main[0].name
  target_group_name      = aws_db_proxy_default_target_group.main[0].name
  db_instance_identifier = local.db_mode == "rds_lab" ? aws_db_instance.postgres_lab[0].identifier : null
  db_cluster_identifier  = local.db_mode == "aurora" ? aws_rds_cluster.aurora[0].cluster_identifier : null

  depends_on = [
    aws_db_instance.postgres_lab,
    aws_rds_cluster_instance.aurora_writer,
  ]
}
