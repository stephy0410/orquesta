# 06 — Deep Dives (sección 6 del delivery framework)

Los **siete problemas difíciles** de Orquesta, cada uno con las cinco partes del framework: **Problema** (lo que duele, con su cifra), **Decisión** (qué se
eligió), **Mecanismo** (cómo funciona), **Qué se rompe si falta** (la falla concreta) y **Riesgo residual** (lo que queda aceptado). Prosa en español,
identificadores en inglés, cada cifra rastreable a `docs/requerimientos.md` §6 o a un `NFR`.

## 1. Ráfaga de escritura del check-in

**Problema**
222 escrituras/s sostenidas 30 min y 500/s en ráfagas de 60 s (NFR-01, §6.1), sobre un promedio de 90 min de 68/s (§6.2). La ráfaga son 30 000 llegadas
= 8 % del sábado ≈ 16 por evento, y el techo es **contención e IOPS de escritura**, no cómputo de la Lambda: cada check-in es una fila pequeña.

**Decisión**
El check-in es un log **append-only** en la tabla `checkin_event` de Aurora/RDS PostgreSQL particionada por `event_id` (TR-01, TR-04, TR-16), donde la ingesta llega en **lotes de ≤ 500 eventos** (`TR-03`) y la admisión única se resuelve con `INSERT ... ON CONFLICT` sobre `(invitation_id, device_id, sequence)` y el índice único parcial `(invitation_id, admision_ciclo) WHERE kind = 'admitido'` (TR-17).

**Mecanismo**
`api` valida el lote (checksum sha256, `sequence` monotónica por dispositivo, TR-03) y ejecuta una sola transacción SQL con inserción multi-fila (`INSERT ... VALUES ... ON CONFLICT DO NOTHING`) sobre la partición del `event_id`. 500 eventos/s distribuidos en lotes equivalen a apenas **1–15 transacciones multi-fila por segundo**, sin `UPDATE` ni bloqueos sobre filas calientes de `Guest`/`Invitation`. El ack (`200`) se devuelve **después** del `COMMIT` durable.

**Qué se rompe si falta**
Sin log append-only ni inserción por lotes, 500 `UPDATE` individuales/s sobre filas calientes saturan IOPS y locks, el p99 de ingesta incumple AC-01 y el ack se atrasa impidiendo drenar la cola durable del teléfono. Sin partición por `event_id`, los índices de un evento gigante degradan a todos los demás eventos de la ráfaga.

**Riesgo residual**
En el Learner Lab (`db.t4g.micro`), la capacidad máxima de IOPS no reproduce a escala real Aurora Serverless v2 Multi-AZ ni la concurrencia multi-venue; además, la tabla crece hasta la purga de 24 meses (`NFR-08`), mitigado por el particionado por evento/fecha.

## 2. Convergencia entre dispositivos offline

**Problema**
Dos escáneres sin red pueden admitir al mismo invitado, y la clave natural `(invitation_id, device_id, sequence)` es idempotente **por dispositivo**, no
**entre** dispositivos: dos teléfonos con `sequence` propios producen dos filas válidas para el mismo `invitation_id`, y el tablero contaría dos asistentes.

**Decisión**
Gana la primera fila durable por `invitation_id` según `recibido_en` **del servidor**, nunca según el reloj del dispositivo; las demás se conservan como
`duplicado_tardio` con veredicto `ya_registrado` y se cuentan aparte (TR-17, AC-05).

**Mecanismo**
Dentro de la transacción de ingesta en PostgreSQL, el índice único parcial `UNIQUE (invitation_id, admision_ciclo) WHERE kind = 'admitido'` arbitra el ganador de forma atómica: el primer dispositivo que confirma el `INSERT` crea la fila vigente; el segundo choca contra la restricción parcial y se inserta automáticamente como `kind = 'duplicado_tardio'` (`verdict = 'ya_registrado'`). El `sequence` local solo ordena las escrituras del mismo dispositivo (`TR-03`).

**Qué se rompe si falta**
Con reloj de dispositivo gana el que tiene la hora adelantada, sin autoridad que arbitre entre venues. Sin la marca `duplicado_tardio` se pierde la
evidencia del doble escaneo y nadie puede distinguir "un asistente" de "un dispositivo que perdió su escritura"; descartar la fila tardía rompería RPO 0 (NFR-06).

**Riesgo residual**
El veredicto local del segundo teléfono ya dijo "admitido" y no se revierte: el sistema cuenta un asistente y el venue puede dejar entrar dos. Se acepta
reportando la diferencia en el consolidado del cierre y no prometiendo puerta única.

## 3. Idempotencia de punta a punta

**Problema**
Cuatro caminos pueden ejecutarse dos veces por un reintento —de red, de usuario o de cola— y cada uno tiene un efecto externo irreversible: una admisión
duplicada, un invitado duplicado, un SMS cobrado dos veces, un cobro en el PSP. En un venue sin red el reintento no es la excepción: es el modo normal.

**Decisión**
Cada camino lleva su clave natural, persistida **antes** del efecto y reusada en todo reintento: `(invitation_id, device_id, sequence)` en check-in
(TR-01), clave de negocio dentro del evento en import (TR-11), `(destinatario, plantilla, ventana, canal)` en envío (TR-12) y clave de pago acuñada una sola vez (TR-09).

**Mecanismo**
La clave se acuña una vez y se guarda: reenviar el mismo lote, el mismo CSV, el mismo job o el mismo cobro escribe contra el mismo índice único y devuelve
el resultado previo como no-op con el mismo veredicto (AC-03, AC-11, AC-13). En el pago, un `UNIQUE (idempotency_key)` convierte 3 reintentos y 5 solicitudes concurrentes en un solo cobro (AC-08).

**Qué se rompe si falta**
Sin clave por operación la idempotencia se implementa leyendo antes de escribir, y dos reintentos concurrentes leen ambos "no existe": el duplicado se crea
igual. Una clave acuñada dos veces, o incrementada en cada reintento, convierte un timeout en un segundo cobro real.

**Riesgo residual**
La clave no revierte un efecto ya aplicado en el proveedor externo: el SMS enviado y el cobro aceptado por el PSP solo se concilian consultando por clave
(TR-09), y esa consulta depende de la ventana de retención del proveedor.

## 4. Invariante de plazas

**Problema**
La aceptación debe cumplir `Σ plazas aceptadas solapadas ≤ plazas_ofrecidas` sobre el agregado `(worker_id, ventana)`, cross-evento (TR-08, D10). PostgreSQL
expresa la forma binaria con `EXCLUDE USING gist` parcial `WHERE estado = 'aceptada'`, pero con N plazas **ninguna restricción declarativa compara una suma contra un techo**.

**Decisión**
Dos salidas, ambas dentro de la transacción y ninguna con *read-then-write*: **A**, exclusión `gist` parcial cuando `plazas_ofrecidas = 1`; **B**,
compare-and-set sobre la suma de plazas aceptadas del agregado cuando N > 1. La aceptación parcial de una empresa se resuelve siempre por B.

**Mecanismo**
En A el índice rechaza la segunda fila `aceptada` y el perdedor recibe `409 RESERVATION_OVERLAP` nombrando la ganadora, y su fila queda `solicitada`
(RF-17). En B la transacción lee la suma bajo bloqueo del agregado, verifica `Σ + plazas_nuevas ≤ plazas_ofrecidas`, escribe y confirma versión.

**Qué se rompe si falta**
Solo A: con `plazas_ofrecidas = 6` se aceptan una reserva de 6 y otra de 6 —la exclusión es binaria y no suma cantidades—, sobreventa silenciosa. Solo B:
se pierde la garantía barata del caso dominante y un CAS sin bloqueo del agregado admite dos aceptaciones que leen la misma suma y escriben las dos.

**Riesgo residual**
B serializa sobre un agregado cross-evento: con muchas aceptaciones sobre el mismo trabajador aparecen contención y reintentos. AC-07 cubre 100 eventos
concurrentes, no un trabajador con cientos de plazas aceptadas en la misma ventana.

## 5. Fan-out del tablero y frescura de 5 s

**Problema**
NFR-03 exige `t_visible − t_ingest ≤ 5 s p95` y ≤ 10 s p99 con reloj de servidor, desde el ack de ingesta y no desde el escaneo. Un fan-out síncrono haría
que la latencia de escritura dependiera de cuántos planners miran el tablero, y `COUNT(*)` sobre el log no entra en 5 s con 1 840 eventos activos.

**Decisión**
El ingest nunca hace fan-out síncrono (TR-05): escribe el delta en el **outbox transaccional** de PostgreSQL en la misma transacción que `checkin_event` y ackea. `outbox_poller` publica a **SQS `projection`** (`maximum_batching_window_in_seconds = 1`) y **`projector`** aplica el delta a la tabla **`event_counters`** en PostgreSQL con dedupe por `outbox_event_id`/`checkin_id`; el tablero lee `event_counters` por PK (`WHERE event_id = ANY($ids)`).

**Mecanismo**
Presupuesto descompuesto: outbox → SQS ~0,3 s, coalescing en SQS/projector ≤ 1 s, `UPDATE event_counters SET ...` por PK ~0,2 s y lectura del tablero `< 5 ms` (sin Redis ni DynamoDB): eso da **1,5–2 s p95**, con ~3 s de margen sobre el objetivo (AC-10). El delta —nunca un incremento ciego— permite reaplicar sin desviar el contador.

**Qué se rompe si falta**
Sin outbox transaccional hay dual write: si el mensaje se pierde después del commit, el contador queda corto para siempre y PostgreSQL ya no lo dispara automáticamente.
Sin coalescing, 222 w/s golpean la misma fila de contador; sin `event_counters`, cada refresco del tablero es un `COUNT(*)` sobre el log.

**Riesgo residual**
El contador es derivado y puede divergir del log un instante; reconstruirlo cuesta un replay desde `checkin_event`/`rsvp_response`/`guest` por evento. El presupuesto de 1,5–2 s se valida con
un planner y una fracción de la carga en el lab, no con los 200 planners concurrentes del dimensionamiento.

## 6. Canales de notificación y su costo

**Problema**
D11 manda que todo aviso —invitación, recordatorio y OTP— salga **duplicado por SMS y email en paralelo**, sin canal preferido. A 4 M invitados/mes por
dos canales, el SMS es ≈ **85 % de la factura** (~$25 000–$400 000/mes), y el fallo o el reintento de un canal no puede bloquear ni duplicar al otro.

**Decisión**
Un tópico **SNS `orquesta-notifications`** hace *fan-out* hacia dos colas **SQS Standard** independientes (`notify_sms` y `notify_email`, con sus DLQs); el worker de SMS entrega vía **SNS Transactional SMS** y el de Email envía correos personalizados 1-a-1 vía **SES** (o adaptador SMTP/captura en sandbox del Lab). Nunca se usa SNS Email directo (que es broadcast y exige confirmación previa del invitado). El estado vive por canal en `InvitationDelivery` (`encolado → entregado | rebotado | indeterminado`) con dedupe `(destinatario, plantilla, ventana, canal)` (TR-12).

**Mecanismo**
`ventana` es el offset declarado (T-7d, T-24h) e inmutable por job; `destinatario` es `guest_id`/`provider_id` + dirección normalizada + canal, así que dos
direcciones del mismo sujeto no son dos destinatarios. Un reintento es **el mismo** job en la cola del canal (≤ 3, luego `rebotado`; `indeterminado` a los 15 min, RF-04).

**Qué se rompe si falta**
Una sola cola mezcla destinos y reintentos: el SMS lento bloquea el email y el estado por canal deja de ser medible (NFR-09). Una clave de tres componentes
rechaza el email como duplicado del SMS, con lo que D11 no se cumple aunque existan los dos pollers. Usar SNS Email directo rompería `RF-03` porque no envía enlaces/QR únicos por invitado.

**Riesgo residual**
El rubro dominante no se optimiza sin cambiar producto: `canales_activos` (§11) apaga SMS y pierde alcance. En el lab, SES sandbox exige destinatarios
verificados (mitigado con adaptador de captura) y el crédito de USD 100 tolera ~2 000 SMS, así que la entrega real a México y los 4 M/mes no se demuestran.

## 7. Shell de la invitación con hit ≥ 95 %

**Problema**
NFR-02 pide hit de CDN **≥ 95 %** sobre ~40 M lecturas/mes (≈15 r/s, 75 r/s p95, 200/s en 60 s) y ≤ 2 M lecturas al origen. Si la URL del shell
identificara al invitado, cada uno tendría su propia clave de caché y el hit caería a cero; si el estado del RSVP se sirviera dentro del shell cacheado, mostraría respuestas viejas.

**Decisión**
El shell HTML/JS se sirve desde **CloudFront + S3** en `/invitacion/#t=<rsvp_token>`, con el token en el **fragment**, que el navegador no envía al servidor: la URL del shell es un único objeto cacheable (`s-maxage=300`), igual que el PNG del QR (`qr/{qr_token}.png`) y los metadatos públicos del evento. El estado vigente del RSVP viaja exclusivamente por `/v1/public/invitations/{rsvp_token}/rsvp` (`Cache-Control: no-store`) y en la respuesta del `POST`.

**Mecanismo**
`CloudFront` absorbe prácticamente todas las aperturas del shell, assets y QR PNG; solo las consultas/respuestas puntuales a `/v1/public/invitations/{rsvp_token}/rsvp` llegan a API Gateway + `api`. El `POST …/rsvp` resuelve la invitación por hash del token, valida el tipo (TR-07) y devuelve `{respuesta, qr}`.

**Qué se rompe si falta**
Con el token en el path o query string del shell, 20 000 invitaciones del cohorte son 20 000 objetos distintos: hit ≈ 0 y las 40 M lecturas golpean el origen (§6.4). Con
el estado en un GET cacheable, el invitado que acaba de confirmar ve la respuesta vieja del caché, o hay que invalidar por objeto y se pierde el hit que sostiene todo.

**Riesgo residual**
El fragment no llega al servidor, así que el shell se sirve sin estado y depende de JS para leer `#t=...` e hidratar la vista. Y el hit se sostiene solo mientras
`s-maxage` y el conjunto de claves no se ajusten a la baja sin volver a mirar el presupuesto de lecturas al origen.

## Qué no se puede demostrar en Learner Lab

| Afirmación | Por qué no se puede demostrar | Cómo se mitiga en el entregable |
| --- | --- | --- |
| 222 w/s sostenidas 30 min y 500 w/s en ráfagas de 60 s (NFR-01, AC-01/AC-02) | Una sesión de 4 h y RDS `db.t4g.micro` (`db_mode="rds_lab"`) no reproducen Aurora Serverless v2 ni la concurrencia multi-venue de 1 840 eventos | Se mide la fracción alcanzada con lotes multi-fila y se documenta el parámetro `db_mode = "aurora"` en Terraform para producción |
| Frescura `t_ingest → t_visible` ≤ 5 s p95 con 1 840 eventos activos (NFR-03, AC-10) | No hay 200 planners refrescando cada segundo ni ese catálogo de eventos activos en el lab | Presupuesto descompuesto por etapa (0,3 / 1 / 0,2 / 0,01 s) y verificación extremo a extremo sobre `event_counters` |
| Hit de CDN ≥ 95 % sobre 40 M lecturas/mes (NFR-02, AC-23) | El tráfico real no existe: no se puede saturar el borde con 20 000 invitaciones de prueba | Se valida que `/invitacion/#t=...` y QR PNG son cacheables puros y que el estado viaja en `no-store` / `POST` |
| 99,9 % mensual, RTO ≤ 1 h, Aurora Multi-AZ y PITR (NFR-05, NFR-06, AC-19) | El lab corre single-AZ `db.t4g.micro` y no permite provocar un failover Multi-AZ dentro de la sesión | El ensayo de restauración se valida como procedimiento documentado; `db_mode="aurora"` queda configurado en Terraform |
| SMS ≈ 85 % de la factura y emails masivos (D11, §5 de `05-high-level-design.md`) | SES sandbox exige destinatarios verificados y el crédito de USD 100 tolera ~2 000 SMS de los 4 M/mes | Fan-out SNS → SQS con adaptador de captura en Lab; el costo se estima con tarifa pública y `canales_activos` (§11) queda configurable |
