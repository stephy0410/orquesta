# Orquesta — Backend (`back/`)

Servicios serverless en Node.js 20 (ESM) sobre AWS Lambda y PostgreSQL 16 (RDS / Aurora Serverless v2). Visión general, ADRs y trazabilidad: [README raíz](../README.md).

## Estructura

| Ruta | Contenido |
| --- | --- |
| `migrations/` | DDL versionado `NNN_*.sql`, aplicado en orden por `runMigrations` (ver abajo) |
| `src/lambdas/api/` | Handler HTTP (API Gateway HTTP API v2): 83 endpoints en `routes/*.js` + *flush* inmediato del outbox |
| `src/lambdas/import-worker/` | SQS `import_jobs`: CSV ≤ 20 000 filas, aforo atómico, QR PNG |
| `src/lambdas/outbox-poller/` | EventBridge cada minuto: outbox rezagado, recordatorios, expiraciones 48 h / 15 min, `indeterminado`, retención NFR-08, **reintento de pagos sin confirmar** y **conciliación diaria** |
| `src/lambdas/projector/` | SQS `projection`: *coalescing* de 1 s sobre `event_counters` (tablero) |
| `src/lambdas/notify-sms/`, `notify-email/` | SQS por canal (alimentadas por SNS), reintentos y DLQ |
| `src/shared/store.js` | `InMemoryStore`: implementación de referencia para pruebas rápidas |
| `src/shared/db.js` + `pg-store-methods.js` | `PgStore`: implementación de producción sobre PostgreSQL |
| `src/shared/payment-reconciliation.js` | Barrido de pagos `pendiente`/`desconocido` y conciliación diaria ledger ↔ procesador |
| `src/shared/qr-png.js` | Render del PNG del QR (filtro PNG fijo: ~2× más rápido, mismo tamaño) |
| `dev/server.js` | Servidor local de desarrollo (API + workers en proceso) |
| `load/` | Pruebas de carga del check-in y del import ([`load/README.md`](load/README.md)) |
| `src/shared/{http,crypto,ports,observability}.js` | Auth cookie/Bearer, idempotencia, AES-256-GCM, ES256, puertos SMS/Email/PSP/QR, métricas EMF |

Ambos stores exponen **la misma interfaz** y la suite de aceptación corre contra los dos.

## Servidor local

`npm run dev` levanta el API en `http://localhost:3000` (el front en modo desarrollo apunta ahí) con los workers en proceso y CORS para `http://localhost:4200`. Usa PostgreSQL de `npm run db:up`, o `npm run dev -- --memory` para no necesitar Docker. Email y SMS se imprimen en consola (tokens, OTP, links de invitación). Código: [`dev/server.js`](dev/server.js).

### Pagos con Stripe

Sin configuración, los pagos usan el PSP simulado (cobra al momento; es lo que usan las pruebas). Para usar **Stripe Checkout en modo prueba**:

1. Crea `back/.env` (está en `.gitignore`) con `STRIPE_SECRET_KEY=sk_test_…` (también acepta `STRIPE_SECRET`).
2. `npm run stripe:logo` sube el logo de Orquesta a Stripe y guarda `STRIPE_LOGO_FILE_ID` en `.env` (en AWS no hace falta: Stripe lo descarga de `PUBLIC_BASE_URL/brand/orquesta-logo-verde.png`).
3. `npm run dev` debe decir `Pagos: Stripe Checkout (modo prueba)`. Paga con la tarjeta de prueba `4242 4242 4242 4242`, cualquier fecha futura y cualquier CVC.

Cómo funciona ([`StripePspAdapter`](src/shared/ports.js)):

- **Pagar** crea una sesión de Checkout con los colores, la tipografía y el logo de Orquesta y responde `checkout_url`. La llave de idempotencia de Stripe es `pay:<reserva>:checkout:<sesión anterior>`: un doble clic devuelve la misma sesión; solo cuando una sesión caduca (1 h) se abre otra.
- La confirmación llega por tres caminos, todos idempotentes sobre el mismo ledger: el **GET** de pagos al volver del checkout (consulta la sesión), el **webhook** `checkout.session.completed` firmado (`STRIPE_WEBHOOK_SECRET`, cabecera `Stripe-Signature`) y el **barrido** del outbox-poller. Una sesión caducada sin pago deja el pago `fallido` para poder reintentar.
- Las URL de regreso solo pueden ser del front propio (`PUBLIC_BASE_URL`, `ALLOWED_RETURN_ORIGINS`; `localhost` fuera de prod).
- Si la reserva pagada se cancela (por la planner **o por el proveedor**) se reembolsa en Stripe con la llave `refund:<pay:reserva>` y se asienta el reverso en el ledger; `GET /payments` devuelve `reembolsado: true`.
- La conciliación diaria compara el ledger con los PaymentIntent cobrados del día que traen `metadata.idempotency_key`.

En AWS, la llave y el secreto del webhook llegan por Secrets Manager desde los secrets `STRIPE_SECRET_KEY` y `STRIPE_WEBHOOK_SECRET` del environment de GitHub (`deploy.yml` → `TF_VAR_stripe_*`). El webhook en el dashboard de Stripe apunta a `<API>/v1/webhooks/psp` con los eventos `checkout.session.completed` y `checkout.session.async_payment_succeeded`.

## Pruebas

```bash
npm ci
npm test            # 17 escenarios de aceptación con InMemoryStore + pruebas del adaptador de Stripe
npm run db:up       # PostgreSQL 16 en localhost:55432 (docker compose)
npm run test:pg     # la misma suite contra PgStore + migraciones reales
npm run test:all    # ambas
npm run lint        # chequeo de sintaxis de todo src/ y test/
npm run load:checkin   # carga del check-in (AC-01, AC-04)
npm run load:import    # carga del import (1 000 en < 30 s; 5 000; 20 000)
npm run db:down
```

`TEST_DB=pg` crea un **esquema nuevo por escenario** (aislamiento total, se borra al terminar; `KEEP_TEST_SCHEMAS=1` para inspeccionarlos). Variables: `PGHOST`, `PGPORT` (55432), `PGUSER`, `PGPASSWORD`, `PGDATABASE`.

**Reloj simulado.** Las reglas de negocio usan `ctx.now()` (inyectable), nunca `DEFAULT now()` de la BD, para que las pruebas puedan "viajar" meses. En los esquemas de prueba, el trigger `set_updated_at()` lee una tabla `test_clock` sincronizada con el reloj simulado; producción no se modifica.

**Regla para cambios:** todo cambio en `PgStore` debe pasar `npm run test:pg`; todo comportamiento nuevo se agrega a la suite y debe pasar en **ambos** stores.

## Migraciones

| Archivo | Propósito |
| --- | --- |
| `001_initial_schema.sql` | 22 entidades, catálogos, vistas, triggers e invariantes |
| `002_fix_aceptar_worker_reservation.sql` | Columnas OUT ambiguas en la función de aceptación (TR-08) |
| `003_fix_payment_entry_unicidad.sql` | Unicidad del ledger por `(pago, movimiento, cuenta)` (TR-09) |
| `004_permitir_revocacion_inmediata.sql` | Cerrar un evento con accesos emitidos en el mismo instante |
| `005_seating_plan_version.sql` | Versión optimista del plano de mesas (FR7) |
| `006_payment_reconciliation.sql` | Resultado de la conciliación diaria ledger ↔ procesador (FR6) |
| `007_guest_unsubscribe.sql` | Baja del invitado por canal (FR8) |
| `008_payment_checkout.sql` | Sesión de Stripe Checkout del pago (FR6) |

- Se aplican automáticamente en el *cold start* (`AUTO_MIGRATE=true`), en **una** transacción serializada con advisory lock, registrando cada archivo en `schema_migrations`.
- Cada archivo trae su propio `BEGIN/COMMIT` para poder aplicarse también con `psql -f`.
- **Inmutables una vez en `main`:** cualquier cambio de esquema es un archivo nuevo con el siguiente número.

## Convenciones del código

- **Transacciones:** toda escritura multi-fila va en `withTx`. No leer con `this.pool` dentro de una transacción abierta (otra conexión no ve la fila hasta el `COMMIT`): leer después.
- **Concurrencia:** `FOR UPDATE` sobre la fila agregada o `pg_advisory_xact_lock` por clave de negocio; las invariantes duras viven además como constraints en la BD.
- **Outbox:** cualquier cambio que mueva contadores o dispare avisos inserta en `outbox_event` **en la misma transacción**.
- **Errores:** `AppError` con código del catálogo cerrado (`src/shared/errors.js`); lo no controlado se registra en log estructurado sin PII y responde un `500` genérico.
- **DTOs:** nunca devolver filas crudas de `pg` (p. ej. `numeric` llega como string).

Diseño técnico completo: [`docs/delivery/07-system-design-back-front.md`](../docs/delivery/07-system-design-back-front.md) · esquemas: [`02-entidades.md`](../docs/delivery/02-entidades.md) · contratos HTTP: [`03-api.md`](../docs/delivery/03-api.md).
