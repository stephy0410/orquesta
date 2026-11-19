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
  alarm_actions       = local.alarm_actions
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
  alarm_actions       = local.alarm_actions
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
  alarm_actions       = local.alarm_actions
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
  alarm_actions       = local.alarm_actions

  dimensions = {
    QueueName = each.value
  }
}

# ----------------------------------------------------------------------------
# README (transversal): "alarmas de p99, errores 5xx y colas atascadas, para detectar un problema
# en menos de 5 minutos, antes que el usuario". Todas las alarmas notifican al tópico SNS de abajo.
# ----------------------------------------------------------------------------
resource "aws_sns_topic" "alarms" {
  name = "${local.name_prefix}-alarms"
}

resource "aws_sns_topic_subscription" "alarms_email" {
  count     = var.alarm_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  alarm_actions = [aws_sns_topic.alarms.arn]
  main_queue_names = {
    import_jobs  = aws_sqs_queue.import_jobs.name
    projection   = aws_sqs_queue.projection.name
    notify_sms   = aws_sqs_queue.notify_sms.name
    notify_email = aws_sqs_queue.notify_email.name
  }
}

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${local.name_prefix}-api-5xx"
  alarm_description   = "Errores 5xx del API: más de 5 por minuto en 3 de los últimos 5 minutos"
  namespace           = "AWS/ApiGateway"
  metric_name         = "5xx"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  threshold           = 5
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  dimensions = {
    ApiId = aws_apigatewayv2_api.http_api.id
  }
}

resource "aws_cloudwatch_metric_alarm" "api_latency_p99" {
  alarm_name          = "${local.name_prefix}-api-latency-p99"
  alarm_description   = "Latencia p99 del API > 1 s en 3 de los últimos 5 minutos"
  namespace           = "AWS/ApiGateway"
  metric_name         = "Latency"
  extended_statistic  = "p99"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  threshold           = 1000
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  dimensions = {
    ApiId = aws_apigatewayv2_api.http_api.id
  }
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each            = local.lambda_names
  alarm_name          = "${each.value}-errors"
  alarm_description   = "Errores no controlados en la Lambda ${each.key}"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 2
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  dimensions = {
    FunctionName = each.value
  }
}

resource "aws_cloudwatch_metric_alarm" "queue_stuck" {
  for_each            = local.main_queue_names
  alarm_name          = "${local.name_prefix}-queue-stuck-${each.key}"
  alarm_description   = "Cola atascada: el mensaje más viejo de ${each.key} lleva más de 5 minutos"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 300
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  dimensions = {
    QueueName = each.value
  }
}
