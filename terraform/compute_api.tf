data "archive_file" "backend_bundle" {
  type        = "zip"
  source_dir  = "${path.module}/../back"
  output_path = "${path.module}/build/orquesta-back.zip"
  # Nunca empaquetar secretos locales (.env con la llave de Stripe) ni herramientas de desarrollo.
  excludes = [
    "test", "coverage", ".git", ".env", ".env.local", "dev", "load", "docker-compose.yml",
  ]
}

locals {
  common_lambda_env = {
    ENVIRONMENT              = var.environment
    DB_MODE                  = local.db_mode
    DB_HOST                  = local.db_endpoint
    DB_PORT                  = tostring(local.db_port)
    DB_NAME                  = var.db_name
    SECRETS_ARN              = aws_secretsmanager_secret.app_secrets.arn
    ASSETS_BUCKET            = aws_s3_bucket.assets.id
    IMPORTS_BUCKET           = aws_s3_bucket.imports.id
    KMS_SIGNER_KEY_ID        = var.enable_kms_signer ? aws_kms_key.qr_signer[0].key_id : ""
    CANALES_ACTIVOS          = join(",", var.canales_activos)
    EMAIL_PROVIDER_MODE      = var.email_provider_mode
    SMS_PROVIDER_MODE        = var.sms_provider_mode
    PROJECTION_QUEUE_URL     = aws_sqs_queue.projection.url
    NOTIFICATIONS_SNS_ARN    = aws_sns_topic.notifications.arn
    IMPORT_QUEUE_URL         = aws_sqs_queue.import_jobs.url
    PUBLIC_BASE_URL          = local.public_base_url
    EMAIL_FROM               = local.email_from
    AUTO_MIGRATE             = "true"
    SEATING_REQUIRE_IF_MATCH = "true" # FR7: el plano de mesas exige If-Match (issue #5)
  }
}

# 1. API HTTP Handler (consolas planner/trabajador, página RSVP, check-in batch ingest + immediate outbox flush)
resource "aws_lambda_function" "api" {
  function_name    = local.lambda_names["api"]
  role             = local.lambda_role_arn
  runtime          = "nodejs20.x"
  handler          = "src/lambdas/api/index.handler"
  filename         = data.archive_file.backend_bundle.output_path
  source_code_hash = data.archive_file.backend_bundle.output_base64sha256
  timeout          = 29
  memory_size      = 512

  depends_on = [
    aws_cloudwatch_log_group.lambdas,
    aws_secretsmanager_secret_version.app_secrets,
    aws_rds_cluster_instance.aurora_writer,
    aws_db_instance.postgres_lab,
  ]

  dynamic "vpc_config" {
    for_each = var.lambda_in_vpc ? [1] : []
    content {
      subnet_ids         = data.aws_subnets.default.ids
      security_group_ids = [aws_security_group.lambda_sg.id]
    }
  }

  environment {
    variables = merge(local.common_lambda_env, {
      ORQUESTA_COMPONENT = "api"
    })
  }
}

# 2. Import Worker (procesamiento asíncrono <= 20 000 filas en páginas de 500; almacenamiento efímero 1 GB)
resource "aws_lambda_function" "import_worker" {
  function_name    = local.lambda_names["import_worker"]
  role             = local.lambda_role_arn
  runtime          = "nodejs20.x"
  handler          = "src/lambdas/import-worker/index.handler"
  filename         = data.archive_file.backend_bundle.output_path
  source_code_hash = data.archive_file.backend_bundle.output_base64sha256
  timeout          = 300
  memory_size      = 512

  ephemeral_storage {
    size = 1024
  }

  depends_on = [
    aws_cloudwatch_log_group.lambdas,
    aws_secretsmanager_secret_version.app_secrets,
    aws_rds_cluster_instance.aurora_writer,
    aws_db_instance.postgres_lab,
  ]

  dynamic "vpc_config" {
    for_each = var.lambda_in_vpc ? [1] : []
    content {
      subnet_ids         = data.aws_subnets.default.ids
      security_group_ids = [aws_security_group.lambda_sg.id]
    }
  }

  environment {
    variables = merge(local.common_lambda_env, {
      ORQUESTA_COMPONENT = "import_worker"
    })
  }
}

resource "aws_lambda_event_source_mapping" "import_jobs" {
  # En cuenta propia, el rol necesita sus permisos de SQS antes de crear el mapeo.
  depends_on = [aws_iam_role_policy.lambda_app]

  event_source_arn        = aws_sqs_queue.import_jobs.arn
  function_name           = aws_lambda_function.import_worker.arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = 2
  }
}

# 3. Outbox Poller & Maintenance Sweep (EventBridge rate(1 min): outbox rezagado, ReminderJob, expiración 48h/15m, indeterminado 15m, retención NFR-08)
resource "aws_lambda_function" "outbox_poller" {
  function_name    = local.lambda_names["outbox_poller"]
  role             = local.lambda_role_arn
  runtime          = "nodejs20.x"
  handler          = "src/lambdas/outbox-poller/index.handler"
  filename         = data.archive_file.backend_bundle.output_path
  source_code_hash = data.archive_file.backend_bundle.output_base64sha256
  timeout          = 60
  memory_size      = 256

  depends_on = [
    aws_cloudwatch_log_group.lambdas,
    aws_secretsmanager_secret_version.app_secrets,
    aws_rds_cluster_instance.aurora_writer,
    aws_db_instance.postgres_lab,
  ]

  dynamic "vpc_config" {
    for_each = var.lambda_in_vpc ? [1] : []
    content {
      subnet_ids         = data.aws_subnets.default.ids
      security_group_ids = [aws_security_group.lambda_sg.id]
    }
  }

  environment {
    variables = merge(local.common_lambda_env, {
      ORQUESTA_COMPONENT = "outbox_poller"
    })
  }
}

# 4. Projector (coalescing de 1 s y concurrencia máxima de 5 para proteger pool PostgreSQL, TR-05 / NFR-03)
resource "aws_lambda_function" "projector" {
  function_name    = local.lambda_names["projector"]
  role             = local.lambda_role_arn
  runtime          = "nodejs20.x"
  handler          = "src/lambdas/projector/index.handler"
  filename         = data.archive_file.backend_bundle.output_path
  source_code_hash = data.archive_file.backend_bundle.output_base64sha256
  timeout          = 30
  memory_size      = 256

  depends_on = [
    aws_cloudwatch_log_group.lambdas,
    aws_secretsmanager_secret_version.app_secrets,
    aws_rds_cluster_instance.aurora_writer,
    aws_db_instance.postgres_lab,
  ]

  dynamic "vpc_config" {
    for_each = var.lambda_in_vpc ? [1] : []
    content {
      subnet_ids         = data.aws_subnets.default.ids
      security_group_ids = [aws_security_group.lambda_sg.id]
    }
  }

  environment {
    variables = merge(local.common_lambda_env, {
      ORQUESTA_COMPONENT = "projector"
    })
  }
}

resource "aws_lambda_event_source_mapping" "projection" {
  # En cuenta propia, el rol necesita sus permisos de SQS antes de crear el mapeo.
  depends_on = [aws_iam_role_policy.lambda_app]

  event_source_arn                   = aws_sqs_queue.projection.arn
  function_name                      = aws_lambda_function.projector.arn
  batch_size                         = 100
  maximum_batching_window_in_seconds = 1
  function_response_types            = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = var.sqs_consumer_max_concurrency
  }
}

# 5. Worker SMS (SNS Transactional SMS / captura, estado en InvitationDelivery)
resource "aws_lambda_function" "notify_sms" {
  function_name    = local.lambda_names["notify_sms"]
  role             = local.lambda_role_arn
  runtime          = "nodejs20.x"
  handler          = "src/lambdas/notify-sms/index.handler"
  filename         = data.archive_file.backend_bundle.output_path
  source_code_hash = data.archive_file.backend_bundle.output_base64sha256
  timeout          = 30
  memory_size      = 256

  depends_on = [
    aws_cloudwatch_log_group.lambdas,
    aws_secretsmanager_secret_version.app_secrets,
    aws_rds_cluster_instance.aurora_writer,
    aws_db_instance.postgres_lab,
  ]

  dynamic "vpc_config" {
    for_each = var.lambda_in_vpc ? [1] : []
    content {
      subnet_ids         = data.aws_subnets.default.ids
      security_group_ids = [aws_security_group.lambda_sg.id]
    }
  }

  environment {
    variables = merge(local.common_lambda_env, {
      ORQUESTA_COMPONENT = "notify_sms"
    })
  }
}

resource "aws_lambda_event_source_mapping" "notify_sms" {
  # En cuenta propia, el rol necesita sus permisos de SQS antes de crear el mapeo.
  depends_on = [aws_iam_role_policy.lambda_app]

  event_source_arn        = aws_sqs_queue.notify_sms.arn
  function_name           = aws_lambda_function.notify_sms.arn
  batch_size              = 10
  function_response_types = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = var.sqs_consumer_max_concurrency
  }
}

# 6. Worker Email (SES / adaptador captura en Learner Lab, estado en InvitationDelivery)
resource "aws_lambda_function" "notify_email" {
  function_name    = local.lambda_names["notify_email"]
  role             = local.lambda_role_arn
  runtime          = "nodejs20.x"
  handler          = "src/lambdas/notify-email/index.handler"
  filename         = data.archive_file.backend_bundle.output_path
  source_code_hash = data.archive_file.backend_bundle.output_base64sha256
  timeout          = 30
  memory_size      = 256

  depends_on = [
    aws_cloudwatch_log_group.lambdas,
    aws_secretsmanager_secret_version.app_secrets,
    aws_rds_cluster_instance.aurora_writer,
    aws_db_instance.postgres_lab,
  ]

  dynamic "vpc_config" {
    for_each = var.lambda_in_vpc ? [1] : []
    content {
      subnet_ids         = data.aws_subnets.default.ids
      security_group_ids = [aws_security_group.lambda_sg.id]
    }
  }

  environment {
    variables = merge(local.common_lambda_env, {
      ORQUESTA_COMPONENT = "notify_email"
    })
  }
}

resource "aws_lambda_event_source_mapping" "notify_email" {
  # En cuenta propia, el rol necesita sus permisos de SQS antes de crear el mapeo.
  depends_on = [aws_iam_role_policy.lambda_app]

  event_source_arn        = aws_sqs_queue.notify_email.arn
  function_name           = aws_lambda_function.notify_email.arn
  batch_size              = 10
  function_response_types = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = var.sqs_consumer_max_concurrency
  }
}

# API Gateway HTTP API v2 (verificado operativo en Learner Lab)
resource "aws_apigatewayv2_api" "http_api" {
  name          = "${local.name_prefix}-http-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_credentials = true
    allow_origins     = local.cors_origins
    allow_methods     = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
    allow_headers     = ["Authorization", "Content-Type", "Idempotency-Key", "If-None-Match", "If-Match"]
    expose_headers    = ["ETag", "Idempotency-Key", "Retry-After"]
    max_age           = 3600
  }
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.http_api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "v1_proxy" {
  api_id    = aws_apigatewayv2_api.http_api.id
  route_key = "ANY /v1/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_apigatewayv2_route" "health" {
  api_id    = aws_apigatewayv2_api.http_api.id
  route_key = "GET /health"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http_api.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 500
    throttling_rate_limit  = 250
  }
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowAPIGatewayV2Invoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http_api.execution_arn}/*/*"
}
