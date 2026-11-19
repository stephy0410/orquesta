# Pago a proveedores con Stripe

> **Estado:** el backend ya lo implementa (Stripe Checkout, webhook firmado, conciliación y
> reembolsos). Configuración y detalles en [`back/README.md` → Pagos con Stripe](../back/README.md#pagos-con-stripe).

El front ya tiene el flujo completo en **Personal y pagos**: la planner pulsa **Pagar**, ve el resumen
(proveedor, servicio, evento, total) y confirma.

## Qué manda el front

`POST /v1/reservations/{id}/payments` con la cabecera `Idempotency-Key: pay:{id}` y este cuerpo:

```json
{
  "success_url": "https://<front>/planner/events/{eventId}/workers?pago=exito",
  "cancel_url": "https://<front>/planner/events/{eventId}/workers?pago=cancelado"
}
```

## Qué necesita del backend

- **Con Stripe Checkout:** crear una Checkout Session (modo `payment`, `metadata.payment_id`,
  `idempotency_key` = la misma clave) con esas dos URL y responder `checkout_url` además de lo que
  ya responde (`payment_id`, `estado: "pendiente"`, `monto`, `moneda`). El front redirige a esa URL.
  Al volver con `?pago=exito` muestra el aviso y consulta `GET /v1/reservations/{id}/payments`;
  la confirmación real llega por el webhook `/v1/webhooks/psp` (ya acepta `stripe-signature`).
- **Sin Stripe configurado (modo de prueba actual):** no hace falta cambiar nada. Si la respuesta
  no trae `checkout_url`, el front muestra el resultado al momento (`confirmado` → "Pagado").

La llave secreta de Stripe solo vive en el backend; el front no necesita la llave publicable con
Checkout.
