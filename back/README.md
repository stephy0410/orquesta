# Orquesta — Backend (`back/`)

Servicios serverless en Node.js 20 (ESM) sobre AWS Lambda y PostgreSQL 16 (RDS / Aurora Serverless v2). Visión general, ADRs y trazabilidad: [README raíz](../README.md).

## Estructura

| Ruta | Contenido |
| --- | --- |
| `migrations/` | DDL versionado `NNN_*.sql`, aplicado en orden por `runMigrations` (ver abajo) |
| `src/lambdas/api/` | Handler HTTP (API Gateway HTTP API v2): 82 endpoints en `routes/*.js` + *flush* inmediato del outbox |
| `src/lambdas/import-worker/` | SQS `import_jobs`: CSV ≤ 20 000 filas, aforo atómico, QR PNG |
| `src/lambdas/outbox-poller/` | EventBridge cada minuto: outbox rezagado, recordatorios, expiraciones 48 h / 15 min, `indeterminado`, retención NFR-08 y **conciliación de pagos** |
| `src/lambdas/projector/` | SQS `projection`: *coalescing* de 1 s sobre `event_counters` (tablero) |
| `src/lambdas/notify-sms/`, `notify-email/` | SQS por canal (alimentadas por SNS), reintentos y DLQ |
| `src/shared/store.js` | `InMemoryStore`: implementación de referencia para pruebas rápidas |
| `src/shared/db.js` + `pg-store-methods.js` | `PgStore`: implementación de producción sobre PostgreSQL |
| `src/shared/payment-reconciliation.js` | Barrido de pagos `pendiente`/`desconocido` contra el PSP |
| `src/shared/{http,crypto,ports,observability}.js` | Auth cookie/Bearer, idempotencia, AES-256-GCM, ES256, puertos SMS/Email/PSP/QR, métricas EMF |

Ambos stores exponen **la misma interfaz** y la suite de aceptación corre contra los dos.

## Pruebas

```bash
npm ci
npm test            # 12 escenarios de aceptación con InMemoryStore (~3 s)
npm run db:up       # PostgreSQL 16 en localhost:55432 (docker compose)
npm run test:pg     # la misma suite contra PgStore + migraciones reales
npm run test:all    # ambas
npm run lint        # chequeo de sintaxis de todo src/ y test/
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
