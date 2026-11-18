locals {
  lambda_names = {
    api           = "${local.name_prefix}-api"
    import_worker = "${local.name_prefix}-import-worker"
    outbox_poller = "${local.name_prefix}-outbox-poller"
    projector     = "${local.name_prefix}-projector"
    notify_sms    = "${local.name_prefix}-notify-sms"
    notify_email  = "${local.name_prefix}-notify-email"
  }

  log_retention_days = local.is_lab ? 14 : 30

  dlq_names = {
    import_jobs  = aws_sqs_queue.import_jobs_dlq.name
    projection   = aws_sqs_queue.projection_dlq.name
    notify_sms   = aws_sqs_queue.notify_sms_dlq.name
    notify_email = aws_sqs_queue.notify_email_dlq.name
  }
}

# Log groups explícitos con retención controlada para las 6 Lambdas y API Gateway
resource "aws_cloudwatch_log_group" "lambdas" {
  for_each          = local.lambda_names
  name              = "/aws/lambda/${each.value}"
  retention_in_days = local.log_retention_days
}

resource "aws_cloudwatch_log_group" "http_api" {
  name              = "/aws/apigateway/${local.name_prefix}-http-api"
  retention_in_days = local.log_retention_days
}

# Alarmas de negocio y operación exigidas por NFR-09 y NFR-03
resource "aws_cloudwatch_metric_alarm" "lag_frescura_p95" {
  alarm_name          = "${local.name_prefix}-lag-frescura-p95"
  alarm_description   = "NFR-03 / NFR-09: lag de frescura del tablero p95 > 5000 ms"
  namespace           = "Orquesta"
  metric_name         = "lag_frescura"
  extended_statistic  = "p95"
  period              = 60
  evaluation_periods  = 2
  threshold           = 5000
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "offline_queue_depth" {
  alarm_name          = "${local.name_prefix}-offline-queue-depth"
  alarm_description   = "NFR-09: cola offline reportada por escáneres > 500 eventos"
  namespace           = "Orquesta"
  metric_name         = "offline_queue_depth"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 500
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "psp_error" {
  alarm_name          = "${local.name_prefix}-psp-error"
  alarm_description   = "NFR-09: error o divergencia detectada contra PSP en 1 h"
  namespace           = "Orquesta"
  metric_name         = "psp_error"
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "dlq_messages" {
  for_each            = local.dlq_names
  alarm_name          = "${local.name_prefix}-dlq-${each.key}"
  alarm_description   = "Mensajes fallidos en DLQ ${each.key} requieren inspección"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = each.value
  }
}
