# Resultados en AWS: qué se cumple y qué no

Medido el **2026-11-22** contra la demo desplegada en la cuenta propia (ADR-6). La ruta fue API Gateway → Lambda (Node 20) → **RDS PostgreSQL `db.t4g.micro`**, sin RDS Proxy (ADR-7). Los scripts son los mismos de las pruebas locales, con `--target=http` ([`back/load/`](../back/load/README.md)), y los reportes JSON están en `back/load/results/`.

> **Contexto que pesa en los números.** La meta de diseño (500 check-ins/s con p99 < 300 ms) supone Aurora con RDS Proxy. La demo corre en la base más chica que existe (2 vCPU con ráfaga y 1 GB, unas 90 conexiones). Los números de abajo son el piso, no el techo.

## Resumen para la slide

| Prueba | Meta | Local (PostgreSQL 16, MacBook) | **AWS (RDS micro)** |
| --- | --- | --- | --- |
| Check-in sostenido 60 s en 50 eventos | 500/s | 500/s | **500/s**, con reintentos (ver abajo) |
| Dobles admisiones | 0 | 0 | **0** |
| Latencia por lote (5 escaneos) | p99 < 300 ms | p99 221 ms | p50 **93 ms** · p95 **370 ms** · p99 **1.3 s** ❌ (era 1.7 s antes del arreglo del outbox) |
| Ráfaga offline de 1 000 escaneos | < 30 s | 0.5 s | **9.7–22 s** ✅ (en medio del pico) |
| Import de 1 000 invitados | < 30 s | 6.3 s (latencia simulada) | **4.6 s** ✅ (22.8 s con los PNG del QR) |
| Import de 5 000 invitados | — | 31 s | **8.4 s** (96 s con los PNG) |
| Import de 20 000 invitados | < 300 s (timeout) | 125 s | **no se corrió** ❌ (ver abajo) |
| Búsqueda de proveedores | p95 < 500 ms | — | p95 **123 ms** ✅ |
| Guardar en el plano de mesas (500 invitados, 50 mesas) | < 1 s | — | p99 **524 ms** ✅ |
| Lectura del tablero (25 eventos) | p95 ≤ 2 s | — | p95 **414 ms** ✅ |

En el check-in local, el "517/s" que se reportaba antes sumaba la ráfaga offline a la tasa. Ahora el script reporta la carga en línea por separado: **500/s** en los dos entornos.

## Requerimientos, uno por uno

✅ se cumple y se midió en AWS · ⚠️ se cumple con una condición · ❌ no se cumple en la demo · ➖ no se midió en AWS

### Check-in (FR2, NFR-01, AC-01, AC-04)

| Requerimiento | Estado | Resultado real |
| --- | --- | --- |
| 500 escrituras/s durante 60 s (NFR-01) | ⚠️ | Se mandaron 31 000 escaneos en 6 002 lotes a 500/s. La micro llegó a su límite (CPU al **86 %**): unas **13 600 respuestas 429/503** que el cliente reintentó con la misma llave, y **185–230 lotes (3–4 %)** agotaron los 6 intentos del script. El escáner real no se rinde: su cola es durable y sigue reintentando. |
| Un QR nunca admite dos veces (AC-01) | ✅ | **0** invitaciones admitidas dos veces en 29 565 admisiones, con 510 escaneos repetidos en otra puerta detectados como `ya_registrado`. |
| Cero check-ins perdidos (AC-01) | ✅ | Todo lote confirmado trae su `checkin_id`. Los 185 lotes sin confirmar se quedan en la cola del dispositivo, que es lo que exige el diseño (RPO 0 en el dispositivo). |
| p99 < 300 ms en línea | ❌ | p50 93 ms · p95 370 ms · **p99 1.3 s** (1.7 s antes del arreglo del outbox, defecto 4). No son arranques en frío: solo hubo 28, de ~330 ms. La causa es la **CPU de la base micro (86 %)**. El veredicto en la puerta **no depende de esto**: se calcula en el dispositivo (NFR-04). |
| 1 000 pendientes sincronizan en < 30 s (AC-04) | ✅ | **9.7 s y 22.1 s** en dos corridas, con 2 lotes de 500 en medio del pico. Sin pico: 1.3 s con 500. |
| Tablero converge (FR3, NFR-03 ≤ 5 s) | ⚠️ | Sin saturación converge en **0.1 s**. En la corrida a 500/s no se pudo certificar, porque los 185 lotes sin confirmar faltan en el tablero, como debe ser. |

### Invitados (FR1)

| Requerimiento | Estado | Resultado real |
| --- | --- | --- |
| Importar 1 000 invitados en < 30 s | ✅ | **4.6 s** hasta `completado`. La Lambda termina los PNG del QR a los 22.8 s; el PNG es un derivado y la invitación puede dibujar el QR desde el token. |
| Aceptadas = válidas únicas; rechazadas y duplicadas reportadas (RF-02) | ✅ | Se cumple con 1 000 y con 5 000 filas. Al reimportar el mismo archivo no se crea nada. Todas quedan `pendiente_envío`: el import no envía mensajes. |
| Hasta 20 000 filas (RF-02) | ❌ | **No se corrió a propósito.** Los registros se crearían en ~35 s, pero los 20 000 PNG (~19 ms cada uno) llevarían la Lambda a ~380 s, arriba del timeout de 300 s. La corrida acabaría en reintentos y en la DLQ. **Arreglo propuesto:** generar los PNG en su propia cola o bajo demanda. |

### Resto de los NFR medidos en AWS

| Requerimiento | Estado | Resultado real |
| --- | --- | --- |
| Búsqueda de proveedores p95 < 500 ms (FR4) | ✅ | 200 búsquedas: p50 98 · **p95 123** · p99 317 ms |
| Guardar el plano en < 1 s con 500 invitados y 50 mesas (FR7) | ✅ | 500 asignaciones con `If-Match`: p50 121 · p95 185 · **p99 524 ms**. Nadie sin mesa y ninguna mesa sobre su capacidad. |
| Tablero ≤ 2 s p95 con 25 eventos (NFR-10) | ✅ | p50 254 · **p95 414 ms** |
| HTTPS, WAF, cifrado en reposo, cabeceras de seguridad | ✅ | Verificado en la demo (CloudFront con WAF, KMS en RDS/S3/SQS, `Managed-SecurityHeadersPolicy`). |
| Alarmas de p99, 5xx y colas atascadas | ✅ | 19 alarmas de CloudWatch con aviso por correo. |
| Invitación y verificación por email (FR8) | ✅ | SES entrega a direcciones verificadas (sandbox). |
| Invitación por SMS (FR8) | ❌ | El plan gratuito de AWS no permite SMS; en la demo el SMS queda en modo `capture`. |
| Pago a proveedores con Stripe (FR6) | ✅ | Checkout de Stripe creado y pagado desde AWS (500 MXN en modo prueba). |
| RSVP con LCP p75 < 2.5 s en 4G | ➖ | 2.35 s medido local con Lighthouse ([`rendimiento-rsvp.md`](rendimiento-rsvp.md)); no se midió contra CloudFront. |

## Defectos que solo aparecieron en AWS (y ya están corregidos)

1. **El roster offline daba 500** (PR #38). KMS `Sign` en modo `RAW` acepta hasta 4 096 bytes, y el roster de un evento pesa mucho más, así que ningún escáner podía bajar su lista. Ahora se firma el digest SHA-256, que da la misma firma. En local no aparecía porque ahí no se usa KMS.
2. **El import era ~13× más lento que en local** (PR #39). Con 512 MB la Lambda tiene ~0.3 vCPU, y el import es CPU: cifrado de PII, HMAC y PNG. Tardaba ~80 ms por invitado. Con 1 769 MB (1 vCPU) baja a ~19 ms.
3. **Tormenta de conexiones.** Con la cuota de 1 000 Lambdas, el API escaló a **641 instancias** y la micro respondió `too many clients`: 82 % de los lotes fallaron. Es el riesgo de no tener RDS Proxy (ADR-7, issue #32). **Arreglo:** tope de 30 instancias para el API con 2 conexiones cada una (`api_reserved_concurrency` y `api_db_pool_max` en Terraform). Al rebasarlo, API Gateway responde 503 y el cliente reintenta. Ese tope es el que produce los 429/503 de la tabla de check-in.
4. **Outbox publicado varias veces** (PR #41). Después de cada petición, todas las Lambdas tomaban los mismos ~100 pendientes del outbox (consulta global y sin bloqueo) y los reenviaban a SQS en 10 llamadas en serie. Ahora cada flush reclama sus filas con `FOR UPDATE SKIP LOCKED`. El p99 dentro de la Lambda bajó de 3.1 s a 1.9 s y el del cliente, de 1.7 s a 1.3 s.

## Qué haría falta para cumplir el p99 a 500/s

Tras el arreglo del outbox, el límite ya no está en el código sino en la base: la micro llega al **86 % de CPU**. En orden de impacto:
1. **Base más grande** (Aurora, como en `prod`, o `db.t4g.medium`+). La micro tiene 2 vCPU con ráfaga, 1 GB de RAM y ~90 conexiones.
2. **RDS Proxy** (issue #32). Las conexiones dejan de crecer con las Lambdas y se puede subir el tope de concurrencia.
3. **Concurrencia provisionada** en el API durante los picos del sábado, para quitar los arranques en frío de la cola p99.

## Cómo se corrió

```bash
cd back
# planner de carga verificado (no es la cuenta de la demo)
node load/checkin-load.js --target=http --base-url=$API --planner-email=... --planner-password=...
node load/import-load.js  --target=http --base-url=$API ... --sizes=1000,5000 --runs=1
node load/api-latency.js  --target=http --base-url=$API ...
```

Volumen total: unas 70 000 peticiones en ~30 min, máximo ~100 por segundo. Costo estimado: menos de USD 2 de créditos (firmas de KMS, PUTs de S3 y tiempo de Lambda).
