# 04 — Data Flow (sección 4 del delivery framework)

Sección **4. Data Flow**, opcional en el framework: la secuencia de acciones de alto nivel de cada flujo, **quién actúa** y **qué estado cambia**. No es un diagrama de despliegue ni un contrato de API —eso vive en `03a`/`03b`—; es la entrada que decide componentes, particiones y **dónde se arbitra cada escritura**.

Convención: cada paso nombra el componente (`planner-console`, `api`, `import-worker`, `outbox`, `delivery-worker`, `scan-pwa`, `ingest`, `read-model`, `psp-adapter`) y el estado que cambia, con identificadores en inglés de [`02-entidades.md`](./02-entidades.md) y sus anexos. Prosa en español. Fuente normativa: `docs/requerimientos.md` v2.1.

## 1. Importación y envío de invitaciones (`RF-02`, `RF-16`, `RF-04`, `RF-03`)

1. **`planner-console`** sube el CSV con `Idempotency-Key`; **`api`** responde `202` y crea el job de import en `en_proceso` con `total_filas` — nada se escribe todavía sobre invitados (`RF-02`).
2. **`import-worker`** normaliza fila por fila: email en minúsculas sin espacios y teléfono a E.164; sin ninguna de las dos claves la fila se rechaza con `GUEST_SIN_CLAVE` y no cambia ningún contador de invitados.
3. **`import-worker`** evalúa la clave de negocio dentro del evento `(event_id, email_normalizado)` o `(event_id, telefono_e164)`: duplicado en el archivo suma `duplicadas_en_archivo`, duplicado ya existente es no-op — el estado queda igual y reimportar no crea ni reenvía nada (`TR-11`).
4. **`import-worker`** verifica el aforo contra `Σ guests (vigentes + baja lógica) + nuevas válidas ≤ event.aforo`; si excede, el import rechaza el archivo completo con `422 AFORO_EXCEDIDO` y `0 invitados creados`, listando las filas que desbordan en `errores[]` con motivo `AFORO_EXCEDIDO` (`RF-01`, `RF-02`, `AC-20`).
5. **`api`** confirma las filas válidas en **una transacción**: inserta `Guest` con `estado_envio = pendiente_envio` y deja el asiento en `sin_mesa`; el import **no envía nada** (`RF-02`, `P03`).
6. **`import-worker`** publica el progreso y cierra el job en `completado` con `{aceptadas, rechazadas, duplicadas_en_archivo, errores[]}`; **`planner-console`** lo consulta por polling.
7. **`planner-console`** lee `pending-summary` → `{destinatarios, por_canal{sms,email}}` y confirma el número de destinatarios antes de disparar (`RF-16`).
8. **`api`** valida membresía y `event.estado ∈ {publicado, en_curso}`; un evento `borrador` o `cerrado` no acepta envío y no cambia estado (`RF-01`).
9. **`api`** crea en una transacción la `Invitation` (`rsvp_token_hash`, `checkin_key_id`, `codigo_corto`) y **dos** `InvitationDelivery` en `encolado` — SMS y email, siempre ambos (`D11`); `guest.estado_envio` sale de `pendiente_envio` (`RF-04`).
10. **`outbox_poller`** lee el `outbox` de PostgreSQL y publica en el tópico **SNS** `orquesta-notifications`, que hace *fan-out* hacia dos colas **SQS** independientes (`notify_sms` y `notify_email`), una por canal con clave `(destinatario, plantilla, ventana, canal)`; la publicación es asíncrona y el ingest nunca hace fan-out síncrono (`TR-05`, `TR-12`, `D11`).
11. **`delivery-worker`** (`notify_sms` → SNS Transactional SMS; `notify_email` → SES / adaptador SMTP-captura) entrega cada canal en paralelo: `encolado → entregado | rebotado | indeterminado`; un reintento es **el mismo** job con `intentos ≤ 3`, e `indeterminado` se fija a los 15 min (`RF-04`).
12. **`api`** firma el QR de check-in con `invitation_id` y `key_id` (`TR-06`), y el enlace del SMS/email lleva el token de RSVP: dos tokens, dos propósitos, nunca intercambiables (`RF-03`, `TR-07`). **`projector`** sube el contador `entregas_parciales` en `event_counters`.

## 2. RSVP del invitado (`RF-05`, `RF-18`, `NFR-02`, `RF-10`)

1. **`invitation-page`** (S3 + CloudFront) sirve el shell HTML/JS público cacheable en `/invitacion/#t=<rsvp_token>`: sin cuenta, sin cookie, desde cualquier dispositivo; el token viaja en el **fragment** y por eso nunca entra en la clave de caché del CDN (`RF-18`, `NFR-02`).
2. **`api`** recibe el token desde el cliente en `/v1/public/invitations/{rsvp_token}/rsvp` (`no-store`) y valida **tipo** = `rsvp`; un token de check-in usado acá se rechaza con `TOKEN_TIPO_INCORRECTO` y no toca ninguna fila (`TR-07`).
3. **`api`** valida vigencia: `Invitation.checkin_revocado_en IS NULL` y `guest.deleted_at IS NULL`; una invitación revocada responde `410` y su estado no cambia (`RF-20`).
4. **`api`** devuelve la respuesta vigente por un `GET …/rsvp` con `Cache-Control: no-store`: `{respuesta, respondido_en}`; el shell mantiene el QR PNG cacheable visible antes y después de responder (`NFR-02`, `RF-18`).
5. **`invitation-page`** envía `POST …/rsvp` con `{respuesta: "confirma" | "declina"}`; confirmar, declinar y cambiar son la **misma** escritura, así que 100 escrituras/s p95 no duplican estado (`RF-05`, `NFR-01b`).
6. **`api`** inserta `RsvpResponse` en un log append-only y marca la anterior con `superseded_at = now()`: una sola respuesta vigente por invitación, la última gana (`RF-05`).
7. **`api`** cancela, en la misma transacción, los `ReminderJob` pendientes de RSVP por clave `(destinatario, plantilla, ventana, canal)`; el job consumido no se reprograma (`RF-10`, `AC-12`).
8. **`api`** responde `201`/`200` con `{respuesta, respondido_en, superseded_at, qr, recordatorios_cancelados}`: el estado del RSVP viaja en la respuesta del POST, nunca en el shell cacheable (`NFR-02`).
9. **`api`** ajusta seating: si la respuesta vigente queda en `declina`, el `SeatAssignment` pasa a `liberado` y devuelve capacidad a la `Table`, conservando su historial (`RF-12`).
10. **`api`** publica un **delta** —no un incremento— en `outbox` dentro de la misma transacción; **`outbox_poller`** lo publica en SQS `projection` y **`projector`** lo coalesce 1 s actualizando `confirmados` y `aun_no_llegaron` en `event_counters` (`TR-05`).
11. **`planner-console`** lee el tablero: la frescura se mide con reloj de servidor de `t_ingest` a `t_visible` (≤ 5 s p95), no desde cuándo el invitado hizo clic (`NFR-03`).

## 3. Check-in offline (`RF-13`, `TR-01` a `TR-03`, `TR-17`, `RF-06`)

1. **`scan-pwa`** abre sesión con el `EventAccessToken` del QR de acceso o con login, en el navegador del teléfono; `StaffAssignment` vigente con permiso `checkin` es obligatorio (`RF-19`, `TR-15`).
2. **`api`** crea `ScanSession{event_id, device_id}` —una sesión de escaneo = un evento— y rechaza el evento `cerrado` o `cancelado` sin habilitar check-in (`TR-19`, `RF-01`).
3. **`scan-pwa`** precarga el roster **firmado y versionado** (≤ 2 000 invitados, ETag) y la lista de revocación con TTL 2 h; ambos quedan en almacenamiento durable del dispositivo (`TR-02`, `TR-06`).
4. **`scan-pwa`** lee el QR con la cámara (o busca por nombre + `codigo_corto` de 6 dígitos) y verifica la firma **offline** con `key_id`: la verificación no consulta al backend (`NFR-05`).
5. **`scan-pwa`** emite el veredicto local `admitido | ya registrado | no corresponde al evento | invitación revocada | no verificable offline (revocación > 2 h) | no_en_roster` en ≤ 100 ms p95 y actualiza su conjunto local de invitaciones admitidas (`RF-13`, `NFR-04`).
6. **`scan-pwa`** persiste la fila en la cola durable **antes** de mostrar el veredicto: `(invitation_id, device_id, sequence)` con checksum y estado `encolado_local`; RPO 0 en el dispositivo, ≥ 8 h y ≥ 1 000 escaneos (`NFR-06`, `TR-02`).
7. **`scan-pwa`** sigue operando sin red: el estado del dispositivo avanza solo y ningún veredicto espera al backend (`NFR-05`).
8. **`scan-pwa`** al reconectar drena el backlog en lotes de **≤ 500 eventos** en orden de `sequence` monotónica; el drenaje es **diferible** y se espacia para no competir con la ingesta viva (`TR-03`, §6.6).
9. **`ingest`** (en Aurora/RDS PostgreSQL, tabla append-only `checkin_event` particionada por `event_id`) inserta el lote en **una sola transacción** mediante `INSERT ... ON CONFLICT`: deduplica por la clave natural `(invitation_id, device_id, sequence)` (replay = no-op con el mismo veredicto); un lote fuera de orden o con checksum distinto se rechaza completo (`TR-01`, `TR-03`).
10. **`ingest`** resuelve la convergencia en la misma transacción mediante el índice único parcial `(invitation_id, admision_ciclo) WHERE kind = 'admitido'`: gana la primera fila durable por `recibido_en` **del servidor**; las demás se insertan como `duplicado_tardio` con veredicto `ya_registrado` y se cuentan aparte (`TR-17`, `AC-05`).
11. **`ingest`** acepta y marca `tardio` lo escaneado dentro de la ventana del evento aunque llegue tras el cierre; solo rechaza lo escaneado **fuera** de la ventana (`RF-15`, `AC-17`).
12. **`ingest`** escribe el delta en `outbox` dentro de la misma transacción y actualiza `DeviceSyncState{cola_reportada, ultima_seq_ackeada, heartbeat_en}`; **`outbox_poller`** lo publica en SQS `projection` (coalescing de 1 s), **`projector`** incrementa `asistentes` en `event_counters` y `planner-console` ve el contador en ≤ 5 s p95 desde `t_ingest`, con la antigüedad del backlog reportada aparte (`TR-18`, `NFR-03`).

## 4. Contratación de un trabajador (`RF-07`, `RF-08`, `RF-17`, `RF-22`, `TR-08`)

1. **`planner-console`** declara `EventRequirement{rol, cantidad}` y **`api`** calcula la cobertura: `cubiertos`, `pendientes`, `sin_cubrir` (`RF-22`).
2. **`api`** busca por las tres dimensiones —capacidades con semántica AND, lugares (zona del `Venue` o `radio_km`) y rango de tarifa—, devuelve **solo** perfiles `publicado` y verificados con lista blanca de campos y **sin** contacto, excluye a quien tenga una reserva `aceptada` solapada y ordena determinista: categoría ↓, zona exacta antes que radio y distancia ↑, tarifa ↑, empate por `worker_id` ↑ (`RF-07`, `NFR-11` excepción 2).
4. **`planner-console`** consulta disponibilidad y recibe solo `{worker_id, ventana_ocupada[{inicio, fin}]}`: el planificador nunca ve en qué evento trabaja ese perfil (`NFR-11` excepción 1).
5. **`api`** crea la solicitud en una transacción: valida contención temprana en `AvailabilityWindow` (`422 WINDOW_NOT_AVAILABLE`, `03-api.md` §3.c), copia `costo_congelado` de la tarifa publicada y la deja **inmutable**; sin tarifa publicada responde `TRABAJADOR_SIN_TARIFA` y no crea fila (`TR-20`).
6. **`api`** inserta `WorkerReservation` en `solicitada` con `expira_en = min(48 h, fin − ahora)` y `hora_llegada` obligatoria; las `solicitada` **no bloquean**, varias pueden solaparse sin conflicto de plazas (`RF-08`, `TR-08`).
7. **`delivery-worker`** (vía tópico SNS `orquesta-notifications` → colas SQS `notify_sms` y `notify_email`) notifica la solicitud al trabajador por SMS **y** email; el estado de cada canal se mide por separado (`D11`, `RF-17`).
8. **`api`** al aceptar ejecuta **compare-and-set** sobre el agregado `(worker_id, ventana)`: `Σ plazas aceptadas + plazas_nuevas ≤ plazas_ofrecidas` se verifica **dentro** de la transacción, nunca con *read-then-write* (`TR-08`).
9. **`api`** valida la contención: la ventana debe estar dentro de una `AvailabilityWindow` vigente del **mismo** `rol`; si no, error determinista y la reserva sigue en `solicitada` sin cambiar (`RF-22`, `AC-22`).
10. **`api`** aplica la aceptación **parcial** de una empresa: `aceptada` con menos `plazas_aceptadas` de las pedidas y devuelve la diferencia; el requerimiento solo cuenta lo aceptado (`D10`, `AC-07`).
11. **`api`** ante conflicto responde `409 RESERVATION_OVERLAP` **nombrando la reserva ganadora**; la fila perdedora queda `solicitada` —nunca se borra— y `reservation_conflicts` sube en 1 (`RF-17`, `NFR-09`).
12. **`api`** al alcanzar `Σ plazas aceptadas ≥ cantidad` marca el requerimiento como cubierto; si la solicitud no se acepta en 48 h (15 min en `modo_emergencia`), un job la pasa a `expirada` y el trabajador vuelve a la búsqueda (`RF-22`, `RF-17`).
13. **`api`** al cierre del evento (`POST …/close`) pasa **toda** reserva `aceptada` a `completada` e incrementa `eventos_completados` del perfil: `evento` queda `cerrado` de solo lectura y nadie marca `completada` a mano (`RF-15`, `AC-29`).

## 5. Pago a trabajador — *nice-to-have* (`RF-11`, `TR-09`, `TR-14`, `D1`, `D5`)

1. **`planner-console`** inicia el cobro de una reserva `aceptada`; un cobro contra otro estado responde `RESERVATION_NOT_ACCEPTED` y no crea `Payment` (`RF-11`).
2. **`api`** lee el monto del `costo_congelado` de la reserva —nunca de la tarifa vigente del perfil— y lo contrasta por trigger con `Payment.monto` y `moneda` (`TR-20`, `AC-26`).
3. **`api`** acuña la `idempotency_key` **una sola vez** (el `id` de la reserva o un `payment_attempt_id` inmutable) y la persiste **antes** de llamar al PSP: `Payment` queda creado sin `cobrado_en` (`TR-09`).
4. **`api`** reusa esa clave en todo reintento y en toda solicitud concurrente: el índice `UNIQUE (idempotency_key)` hace que 3 reintentos y 5 solicitudes simultáneas produzcan **un** cobro (`AC-08`).
5. **`psp-adapter`** implementa el puerto `PaymentProvider` en **modo test**; cambiar de adaptador no cambia el flujo de la aplicación (`TR-14`).
6. **`psp-adapter`** ante resultado desconocido consulta al PSP **por clave** antes de reintentar; nunca incrementa ni reacuña la clave (`TR-09`).
7. **`api`** al resultado confirmado escribe, en una transacción, el asiento del ledger: `transaccion_id` con exactamente **dos líneas** —`debito psp_clearing +X` y `credito worker_payable −X`— cuyo `sum(importe) = 0` verifica un constraint trigger diferido (`RF-11`).
8. **`api`** fija `Payment.cobrado_en` y el índice `UNIQUE (pago_id) WHERE movimiento = 'cobro'` impide una segunda transacción de cobro ante webhooks reenviados (`AC-09`).
9. **`api`** recibe el webhook del PSP de forma idempotente: reenviado 3 veces y fuera de orden no altera el estado final ni crea entradas nuevas; el webhook **concilia**, no cobra (`TR-09`).
10. **`api`** registra una divergencia entre el PSP y el ledger como métrica `psp_error`, no como un cobro nuevo ni como una edición del asiento (`NFR-09`).
11. **`api`** si la reserva se cancela después del cobro la pasa a `cancelada_pagada` y **agrega** un asiento nuevo de `reverso` con otra `transaccion_id`: el ledger es append-only, el reverso nunca edita el cobro (`RF-11`).
12. **`worker-console`** lee el estado `pendiente | pagado | desconocido | reversado`; el ledger no guarda PII y se conserva 24 meses (`NFR-08`).

## Dónde vive cada decisión

- **Import y envío → la base.** Qué invitado existe y qué entrega salió se arbitra con índices únicos (clave de negocio del evento y `(destinatario, plantilla, ventana, canal)`); el broker solo transporta, porque un `delivery-worker` no puede deduplicar lo que ya publicó en otro intento ni sobrevivir a un reinicio de la cola.
- **RSVP → la base, en una sola transacción.** "Cuál es la respuesta vigente" no puede vivir en la CDN ni en el cliente: el shell es puro y cacheable, y un caché no puede arbitrar "la última gana". Por eso el estado viaja en la respuesta del POST y no en un GET cacheable.
- **Check-in: veredicto en el cliente, admisión en la base.** El veredicto local es la decisión del cliente porque el venue puede no tener red (A+P local, `NFR-05`); la admisión vigente la decide la base por `recibido_en` del servidor (`TR-17`). **Ni la convergencia ni el "primero gana" viven en la cola**: la cola durable solo garantiza RPO 0 y el orden de *este* dispositivo, y su reloj no es autoridad entre dos teléfonos.
- **Contratación → la base.** La ocupación es un agregado cross-evento `(worker_id, ventana)`; la aceptación se resuelve con compare-and-set o restricción de exclusión parcial dentro de la transacción. El broker no puede verificar `Σ plazas ≤ plazas_ofrecidas` y el cliente menos: para eso existe `TR-08`.
- **Pago → la base, antes que el PSP.** La idempotencia del cobro es una fila única persistida **antes** de la llamada externa; el webhook y el broker solo concilian y transportan, nunca son autoridad sobre si un cobro ocurrió.
- **Tablero → la proyección, no la fuente.** Los contadores viven en el read model alimentado por `outbox` con coalescing de 1 s (`TR-05`, `TR-13`): son derivados y recomputables, así que perder el read model cuesta una reconstrucción, nunca la verdad —y por eso la decisión de frescura no se delega al cliente.

