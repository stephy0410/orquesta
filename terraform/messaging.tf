# Tópico SNS único para fan-out hacia canales paralelos SMS y Email (RF-04, D11)
resource "aws_sns_topic" "notifications" {
  name = "${local.name_prefix}-notifications-${random_id.suffix.hex}"
}

# 1. Cola de importación masiva de invitados (RF-02, <= 20 000 filas)
resource "aws_sqs_queue" "import_jobs_dlq" {
  name                      = "${local.name_prefix}-import-jobs-dlq-${random_id.suffix.hex}"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "import_jobs" {
  name                       = "${local.name_prefix}-import-jobs-${random_id.suffix.hex}"
  visibility_timeout_seconds = 360
  message_retention_seconds  = 345600

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.import_jobs_dlq.arn
    maxReceiveCount     = 3
  })
}

# 2. Cola de proyección de contadores del tablero (TR-05, coalescing de 1 s en Event Source Mapping)
resource "aws_sqs_queue" "projection_dlq" {
  name                      = "${local.name_prefix}-projection-dlq-${random_id.suffix.hex}"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "projection" {
  name                       = "${local.name_prefix}-projection-${random_id.suffix.hex}"
  visibility_timeout_seconds = 60
  message_retention_seconds  = 345600

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.projection_dlq.arn
    maxReceiveCount     = 5
  })
}

# 3. Cola de notificaciones SMS (RF-04, maxReceiveCount = 3 -> rebotado)
resource "aws_sqs_queue" "notify_sms_dlq" {
  name                      = "${local.name_prefix}-notify-sms-dlq-${random_id.suffix.hex}"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "notify_sms" {
  name                       = "${local.name_prefix}-notify-sms-${random_id.suffix.hex}"
  visibility_timeout_seconds = 60
  message_retention_seconds  = 345600

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.notify_sms_dlq.arn
    maxReceiveCount     = 3
  })
}

# 4. Cola de notificaciones Email (RF-04, maxReceiveCount = 3 -> rebotado)
resource "aws_sqs_queue" "notify_email_dlq" {
  name                      = "${local.name_prefix}-notify-email-dlq-${random_id.suffix.hex}"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "notify_email" {
  name                       = "${local.name_prefix}-notify-email-${random_id.suffix.hex}"
  visibility_timeout_seconds = 60
  message_retention_seconds  = 345600

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.notify_email_dlq.arn
    maxReceiveCount     = 3
  })
}

# Políticas para que SNS orquesta-notifications publique a las colas SQS de SMS y Email
resource "aws_sqs_queue_policy" "notify_sms" {
  queue_url = aws_sqs_queue.notify_sms.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowSnsNotificationTopic"
        Effect    = "Allow"
        Principal = { Service = "sns.amazonaws.com" }
        Action    = "sqs:SendMessage"
        Resource  = aws_sqs_queue.notify_sms.arn
        Condition = {
          ArnEquals = {
            "aws:SourceArn" = aws_sns_topic.notifications.arn
          }
        }
      }
    ]
  })
}

resource "aws_sqs_queue_policy" "notify_email" {
  queue_url = aws_sqs_queue.notify_email.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowSnsNotificationTopic"
        Effect    = "Allow"
        Principal = { Service = "sns.amazonaws.com" }
        Action    = "sqs:SendMessage"
        Resource  = aws_sqs_queue.notify_email.arn
        Condition = {
          ArnEquals = {
            "aws:SourceArn" = aws_sns_topic.notifications.arn
          }
        }
      }
    ]
  })
}

# Suscripciones fan-out con filtrado por atributo de canal (o ambos canales por defecto en D11)
resource "aws_sns_topic_subscription" "notify_sms" {
  topic_arn            = aws_sns_topic.notifications.arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.notify_sms.arn
  raw_message_delivery = true
  filter_policy        = jsonencode({ canal = ["sms", "ambos"] })
}

resource "aws_sns_topic_subscription" "notify_email" {
  topic_arn            = aws_sns_topic.notifications.arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.notify_email.arn
  raw_message_delivery = true
  filter_policy        = jsonencode({ canal = ["email", "ambos"] })
}
