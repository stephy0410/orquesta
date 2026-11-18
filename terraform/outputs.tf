output "aws_account_id" {
  description = "Cuenta AWS sobre la que se planea/despliega."
  value       = data.aws_caller_identity.current.account_id
}

output "api_endpoint" {
  description = "URL base de API Gateway HTTP API v2."
  value       = aws_apigatewayv2_api.http_api.api_endpoint
}

output "assets_bucket_name" {
  description = "Bucket S3 para shell estático, consolas web y QR PNG."
  value       = aws_s3_bucket.assets.id
}

output "assets_website_url" {
  description = "URL del S3 Website endpoint (usada en Learner Lab cuando enable_cloudfront = false)."
  value       = "http://${aws_s3_bucket_website_configuration.assets.website_endpoint}"
}

output "frontend_url" {
  description = "URL pública principal de la aplicación web Angular."
  value       = var.enable_cloudfront ? "https://${aws_cloudfront_distribution.edge[0].domain_name}" : "http://${aws_s3_bucket_website_configuration.assets.website_endpoint}"
}

output "cloudfront_domain_name" {
  description = "Dominio de CloudFront si enable_cloudfront = true."
  value       = var.enable_cloudfront ? aws_cloudfront_distribution.edge[0].domain_name : null
}

output "imports_bucket_name" {
  description = "Bucket S3 privado para CSVs de importación masiva."
  value       = aws_s3_bucket.imports.id
}

output "db_mode" {
  description = "Modo activo de base de datos PostgreSQL (rds_lab | aurora)."
  value       = var.db_mode
}

output "db_endpoint" {
  description = "Endpoint de conexión a PostgreSQL."
  value       = local.db_endpoint
}

output "db_port" {
  description = "Puerto de conexión a PostgreSQL."
  value       = local.db_port
}

output "aurora_cluster_id" {
  description = "Identificador del clúster Aurora PostgreSQL Serverless v2 (null cuando db_mode = 'rds_lab')."
  value       = var.db_mode == "aurora" ? aws_rds_cluster.aurora[0].id : null
}

output "secrets_manager_arn" {
  description = "ARN del secreto en Secrets Manager con credenciales de DB y secretos de aplicación."
  value       = aws_secretsmanager_secret.app_secrets.arn
}

output "kms_signer_key_id" {
  description = "ID de la CMK ECDSA P-256 para firma offline ES256 (TR-06)."
  value       = var.enable_kms_signer ? aws_kms_key.qr_signer[0].key_id : null
}

output "sns_notifications_topic_arn" {
  description = "ARN del tópico SNS de fan-out para SMS y Email (RF-04, D11)."
  value       = aws_sns_topic.notifications.arn
}

output "sqs_queues" {
  description = "URLs de las colas SQS principales."
  value = {
    import_jobs  = aws_sqs_queue.import_jobs.url
    projection   = aws_sqs_queue.projection.url
    notify_sms   = aws_sqs_queue.notify_sms.url
    notify_email = aws_sqs_queue.notify_email.url
  }
}

output "lambda_functions" {
  description = "Nombres de las funciones Lambda desplegadas con LabRole."
  value = {
    api           = aws_lambda_function.api.function_name
    import_worker = aws_lambda_function.import_worker.function_name
    outbox_poller = aws_lambda_function.outbox_poller.function_name
    projector     = aws_lambda_function.projector.function_name
    notify_sms    = aws_lambda_function.notify_sms.function_name
    notify_email  = aws_lambda_function.notify_email.function_name
  }
}
