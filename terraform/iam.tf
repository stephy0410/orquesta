# Rol de ejecución de las 6 Lambdas en una cuenta propia (use_lab_role = false).
# En Learner Lab no se pueden crear roles y se usa LabRole (main.tf).
# Permisos mínimos: solo los recursos de este despliegue (prefijo orquesta-<entorno>-…),
# salvo sns:Publish a teléfonos y SES, que AWS solo acepta con recurso "*" o por identidad.

data "aws_iam_policy_document" "lambda_assume" {
  count = var.use_lab_role ? 0 : 1
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  count              = var.use_lab_role ? 0 : 1
  name               = "${local.name_prefix}-lambda-${random_id.suffix.hex}"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume[0].json
}

resource "aws_iam_role_policy_attachment" "lambda_logs" {
  count      = var.use_lab_role ? 0 : 1
  role       = aws_iam_role.lambda[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "lambda_vpc" {
  count      = !var.use_lab_role && var.lambda_in_vpc ? 1 : 0
  role       = aws_iam_role.lambda[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

data "aws_iam_policy_document" "lambda_app" {
  count = var.use_lab_role ? 0 : 1

  statement {
    sid = "Colas"
    actions = [
      "sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage",
      "sqs:GetQueueAttributes", "sqs:GetQueueUrl", "sqs:ChangeMessageVisibility",
    ]
    resources = ["arn:aws:sqs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:${local.name_prefix}-*"]
  }

  statement {
    sid       = "TopicoDeNotificaciones"
    actions   = ["sns:Publish"]
    resources = ["arn:aws:sns:${var.aws_region}:${data.aws_caller_identity.current.account_id}:${local.name_prefix}-*"]
  }

  statement {
    # Los SMS directos a un teléfono no tienen ARN: AWS exige "*".
    sid       = "SmsDirecto"
    actions   = ["sns:Publish"]
    resources = ["*"]
  }

  statement {
    sid       = "Correo"
    actions   = ["ses:SendEmail", "ses:SendRawEmail"]
    resources = ["arn:aws:ses:${var.aws_region}:${data.aws_caller_identity.current.account_id}:identity/*"]
  }

  statement {
    sid     = "Archivos"
    actions = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = [
      "${aws_s3_bucket.assets.arn}/*",
      "${aws_s3_bucket.imports.arn}/*",
    ]
  }

  statement {
    sid       = "ListarArchivos"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.assets.arn, aws_s3_bucket.imports.arn]
  }

  statement {
    sid       = "Secretos"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.app_secrets.arn]
  }

  dynamic "statement" {
    for_each = var.enable_kms_signer ? [1] : []
    content {
      sid       = "FirmaDeQr"
      actions   = ["kms:Sign", "kms:GetPublicKey", "kms:DescribeKey"]
      resources = [aws_kms_key.qr_signer[0].arn]
    }
  }

  statement {
    sid       = "Metricas"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "lambda_app" {
  count  = var.use_lab_role ? 0 : 1
  name   = "orquesta-app"
  role   = aws_iam_role.lambda[0].id
  policy = data.aws_iam_policy_document.lambda_app[0].json
}
