locals {
  name_prefix = "${var.project_name}-${var.environment}"
  is_lab      = var.environment == "lab"

  common_tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }

  rds_engine_version    = var.db_engine_version_rds != "" ? var.db_engine_version_rds : data.aws_rds_engine_version.postgres.version
  aurora_engine_version = var.db_engine_version_aurora != "" ? var.db_engine_version_aurora : data.aws_rds_engine_version.aurora.version

  db_endpoint = var.db_mode == "aurora" ? aws_rds_cluster.aurora[0].endpoint : aws_db_instance.postgres_lab[0].address
  db_port     = var.db_mode == "aurora" ? aws_rds_cluster.aurora[0].port : aws_db_instance.postgres_lab[0].port

  # Nota: cuando enable_cloudfront = true, CloudFront enruta tanto S3 como /v1/*
  # bajo el mismo origen (same-origin), evitando un ciclo entre API Gateway y CloudFront.
  cors_origins = distinct(compact(concat(
    var.cors_allow_origins,
    ["http://${aws_s3_bucket_website_configuration.assets.website_endpoint}"]
  )))
}

data "aws_caller_identity" "current" {}

data "aws_iam_role" "lab_role" {
  name = "LabRole"
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
