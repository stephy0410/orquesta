# EventBridge Scheduler / Rule cada 1 minuto para tareas periódicas y resiliencia del outbox:
# 1. Reintentar filas de `outbox` rezagadas (NFR-06 RPO 0)
# 2. Disparar `ReminderJob` vencidos (RF-10: T-7d, T-1d, T-24h, T-2h)
# 3. Expirar solicitudes `WorkerReservation` tras 48 h o 15 min en emergencia (RF-08, RF-17, AC-22)
# 4. Marcar `InvitationDelivery` como `indeterminado` a los 15 min sin respuesta (RF-04)
# 5. Ejecutar barrido diario de retención y anonimización de PII a 12 / 24 meses (NFR-08)
resource "aws_cloudwatch_event_rule" "maintenance_sweep" {
  name                = "${local.name_prefix}-maintenance-sweep"
  description         = "Barrido cada 1 min hacia outbox_poller para outbox, recordatorios, expiraciones y retencion"
  schedule_expression = "rate(1 minute)"
}

resource "aws_cloudwatch_event_target" "outbox_poller" {
  rule      = aws_cloudwatch_event_rule.maintenance_sweep.name
  target_id = "outbox-poller"
  arn       = aws_lambda_function.outbox_poller.arn
}

resource "aws_lambda_permission" "eventbridge_outbox_poller" {
  statement_id  = "AllowEventBridgeInvokeOutboxPoller"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.outbox_poller.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.maintenance_sweep.arn
}
