locals {
  name_prefix = "${var.project_name}-${var.environment}"
  is_lab      = var.environment == "lab"
  # Learner Lab no permite Aurora: si no se elige motor, lab usa RDS micro y prod Aurora.
  db_mode = coalesce(var.db_mode, local.is_lab ? "rds_lab" : "aurora")
  # Learner Lab trae su LabRole; en una cuenta propia el rol de las Lambdas se crea en iam.tf.
  lambda_role_arn    = var.use_lab_role ? data.aws_iam_role.lab_role[0].arn : aws_iam_role.lambda[0].arn
  rds_proxy_role_arn = var.use_lab_role ? data.aws_iam_role.lab_role[0].arn : (var.enable_rds_proxy ? aws_iam_role.rds_proxy[0].arn : null)

  common_tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }

  rds_engine_version    = var.db_engine_version_rds != "" ? var.db_engine_version_rds : data.aws_rds_engine_version.postgres.version
  aurora_engine_version = var.db_engine_version_aurora != "" ? var.db_engine_version_aurora : data.aws_rds_engine_version.aurora.version

  db_pool_max        = coalesce(var.db_pool_max, var.enable_rds_proxy ? 2 : 5)
  db_direct_endpoint = local.db_mode == "aurora" ? aws_rds_cluster.aurora[0].endpoint : aws_db_instance.postgres_lab[0].address
  db_endpoint        = var.enable_rds_proxy ? aws_db_proxy.main[0].endpoint : local.db_direct_endpoint
  db_port            = local.db_mode == "aurora" ? aws_rds_cluster.aurora[0].port : aws_db_instance.postgres_lab[0].port

  # Nota: cuando enable_cloudfront = true, CloudFront enruta tanto S3 como /v1/*
  # bajo el mismo origen (same-origin), evitando un ciclo entre API Gateway y CloudFront.
  cors_origins = distinct(compact(concat(
    var.cors_allow_origins,
    ["http://${local.assets_website_endpoint}"],
    var.custom_domain != "" ? ["https://${var.custom_domain}"] : []
  )))
}

data "aws_caller_identity" "current" {}

data "aws_iam_role" "lab_role" {
  count = var.use_lab_role ? 1 : 0
  name  = "LabRole"
}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

data "aws_rds_engine_version" "postgres" {
  engine             = "postgres"
  preferred_versions = ["16.11", "16.10", "16.9", "16.12", "16.13"]
}

data "aws_rds_engine_version" "aurora" {
  engine             = "aurora-postgresql"
  preferred_versions = ["16.11", "16.10", "16.9", "16.8"]
}

resource "random_id" "suffix" {
  byte_length = 4
}

resource "random_password" "db_password" {
  length  = 24
  special = false
}

resource "random_password" "session_secret" {
  length  = 48
  special = false
}

resource "random_password" "psp_webhook_secret" {
  length  = 32
  special = false
}

resource "random_password" "pii_encryption_key" {
  length  = 32
  special = false
}
