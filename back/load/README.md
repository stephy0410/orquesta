# Prueba de carga del check-in

Valida bajo carga los criterios de FR2 que la suite de aceptación no puede probar:

- **AC-01:** 500 escrituras/s durante 60 s sobre 50 eventos → cada check-in confirmado aparece **una sola vez** y ninguno se pierde.
- **AC-04 / NFR:** un dispositivo que vuelve de estar offline sincroniza su cola (lotes de 500) en **< 30 s**.
- **FR3:** al terminar, el tablero (`GET /v1/dashboard`) converge a los asistentes reales de cada evento.

## Perfil de carga

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

## Verificaciones (el script sale con código 1 si alguna falla)

1. Ningún lote con error y todo escaneo con `checkin_id` (0 pérdidas).
2. Ninguna invitación con más de un veredicto `admitido`; en local también se verifica en la BD (`checkin_event`).
3. Invitaciones admitidas = invitaciones únicas escaneadas.
4. Tasa sostenida ≥ 95 % del objetivo.
5. Ráfaga offline < 30 s.
6. Tablero = asistentes esperados en cada evento.

## Fase 1: local (sin AWS)

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

## Fase 2: AWS (necesita el Learner Lab abierto)

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
