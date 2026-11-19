# Pruebas de carga

Dos scripts con la misma infraestructura (`lib.js`: cliente local en proceso contra PostgreSQL o HTTP contra AWS):

- [`checkin-load.js`](#check-in-checkin-loadjs): FR2, AC-01 y AC-04.
- [`import-load.js`](#import-de-invitados-import-loadjs): FR1, importar 1 000 invitados en < 30 s (issue #7).

## Check-in (`checkin-load.js`)

Valida bajo carga los criterios de FR2 que la suite de aceptación no puede probar:

- **AC-01:** 500 escrituras/s durante 60 s sobre 50 eventos → cada check-in confirmado aparece **una sola vez** y ninguno se pierde.
- **AC-04 / NFR:** un dispositivo que vuelve de estar offline sincroniza su cola (lotes de 500) en **< 30 s**.
- **FR3:** al terminar, el tablero (`GET /v1/dashboard`) converge a los asistentes reales de cada evento.

### Perfil de carga

*Open loop*, como un venue real: no espera respuestas para seguir enviando.

| Parámetro | Default | Flag |
| --- | --- | --- |
| Eventos simultáneos | 50 | `--events` |
| Dispositivos por evento | 2 | `--devices-per-event` |
| Tasa objetivo (check-ins/s) | 500 | `--rate` |
| Duración (s) | 60 | `--duration` |
| % de QR escaneados también en otra puerta | 2 % | `--dup-rate` |
| Escaneos acumulados del dispositivo offline | 1 000 | `--offline-backlog` |

Cada segundo, cada dispositivo envía un lote con su parte de la tasa (500 / 100 = 5 escaneos). A la mitad de la corrida, un dispositivo adicional vacía 1 000 escaneos en lotes de 500, en serie, como hace `BatchSyncService` en la PWA.

### Verificaciones (el script sale con código 1 si alguna falla)

1. Ningún lote con error y todo escaneo con `checkin_id` (0 pérdidas).
2. Ninguna invitación con más de un veredicto `admitido`; en local también se verifica en la BD (`checkin_event`).
3. Invitaciones admitidas = invitaciones únicas escaneadas.
4. Tasa sostenida ≥ 95 % del objetivo.
5. Ráfaga offline < 30 s.
6. Tablero = asistentes esperados en cada evento.

### Fase 1: local (sin AWS)

```bash
cd back
npm run db:up
npm run load:checkin                                   # perfil completo
node load/checkin-load.js --rate=1000 --duration=30    # buscar el punto de saturación
```

Crea un esquema `load_*` aislado y lo borra al terminar (`KEEP_LOAD_SCHEMA=1` para conservarlo). El reporte JSON queda en `load/results/` (ignorado por git).

### Resultado de referencia (2026-11-18, MacBook, PostgreSQL 16 en Docker, pool 20)

| Métrica | Resultado |
| --- | --- |
| Tasa sostenida | 517 check-ins/s · 31 000 escaneos · 6 002 lotes · 0 errores |
| Perdidos / dobles admisiones | 0 / 0 (API y BD) |
| Duplicados cross-dispositivo | 607 `ya_registrado` |
| Ráfaga offline 1 000 | 1.4 s (lotes de 736 y 636 ms) |
| Tablero converge | 1.2 s |
| Latencia por lote | p50 179 · p95 358 · p99 481 · máx 736 ms |

El p99 local está inflado porque los 100 dispositivos comparten **un proceso Node**; en AWS cada lote corre en su propia Lambda. La cifra que cuenta para el NFR (p99 < 300 ms) es la de la fase 2.

### Fase 2: AWS (necesita el Learner Lab abierto)

1. Desplegar con el workflow **Deploy** (README raíz §8) y tomar `api_endpoint` de `terraform output`.
2. Crear un planner y verificar su email. En `lab` el email está en modo *capture*: el token aparece en los logs de CloudWatch de `notify-email`.
3. Correr:

```bash
node load/checkin-load.js --target=http \
  --base-url="$(terraform -chdir=../terraform output -raw api_endpoint)" \
  --planner-email=planner@ejemplo.com --planner-password='...'
```

Notas:
- API Gateway está limitado a 250 req/s (ráfaga 500). Con lotes de 5 escaneos, 500 check-ins/s son ~100 req/s, dentro del límite.
- RDS de `lab` es `db.t4g.micro`: el resultado será más pesimista que con Aurora en producción. Reportarlo así.
- La verificación en BD no aplica en `http`; se verifica por API (veredictos + tablero).

## Import de invitados (`import-load.js`)

Mide desde `POST /guests/import` hasta `estado = completado` para 1 000, 5 000 y 20 000 filas (límite de RF-02). Cada archivo trae 2 % de filas duplicadas y 1 % sin clave válida, y se verifica:
- aceptadas = válidas únicas, con rechazadas y duplicadas reportadas;
- 0 mensajes enviados (todos quedan `pendiente_envío`);
- reimportar el mismo archivo no crea nada.

```bash
npm run load:import                                        # local, sin latencia de red
node load/import-load.js --kms-ms=15 --s3-ms=30            # simula AWS: firma en KMS y PUT a S3 por invitado
node load/import-load.js --target=http --base-url=... --planner-email=... --planner-password=...
```

### Resultado (2026-11-18, local, latencia de AWS simulada: KMS 15 ms y S3 30 ms por invitado)

| Filas | Antes (import en serie) | Después | Meta |
| --- | --- | --- | --- |
| 1 000 | **64.9 s** ❌ | **6.3 s** ✅ | < 30 s |
| 5 000 | — | 31 s | — |
| 20 000 | ~21 min (estimado; supera el timeout de 300 s de la Lambda) | 125 s ✅ | < 300 s (timeout de `import-worker`) |

Qué cambió en `PgStore.executeImportBatch`:
1. **Inserción en lote** de invitados e invitaciones con `INSERT … SELECT FROM unnest(...)`: 2 consultas por cada 1 000 filas en lugar de 2 por fila.
2. **Firma de los QR en paralelo** con concurrencia acotada (`IMPORT_SIGN_CONCURRENCY`, default 16), para no rebasar la cuota de KMS.
3. **PNG del QR después del COMMIT**, en paralelo y con 3 reintentos. El PNG es un derivado cacheable del token, así que no retiene el lock del evento.
4. **PNG 2× más rápido** con filtro PNG fijo (`src/shared/qr-png.js`): 2.6 ms en lugar de 5 ms, mismo tamaño (≈ 6.4 KB).
5. **Bug corregido:** si el aforo se agotaba en el worker, el job quedaba `en_proceso` para siempre (el ROLLBACK deshacía el `fallido`). Ahora queda `fallido` con 0 creados. Hay prueba de aceptación.

El costo restante (~6 ms por fila) es CPU: cifrado AES de PII, HMAC y render del PNG.
