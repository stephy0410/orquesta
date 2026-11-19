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
  backup_retention_period = 1
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
