# 01 — Requirements (sección 1 del delivery framework)

Sección **1. Requirements** del *delivery framework* de Hello Interview aplicada a Orquesta: funcionales priorizados y cortos, no funcionales cuantificados, y capacidad **solo** donde cambia el diseño.

Fuente normativa: `docs/requerimientos.md` v2.1. Toda cifra cita su sección; `README.md` es origen histórico y no se cita como autoridad (§15.4). Identificadores en inglés (`RF`/`NFR`/`TR`/`D`), prosa en español.

## 1. Requerimientos funcionales

El producto tiene **dos pilares** y el MVP construye los dos (§12). Prioridad según la tabla de gate de §12: `must` → `should` → `nice-to-have`.

- `must` **El planner debe poder crear y publicar un evento** con zona horaria obligatoria, ventana horaria, `Venue` y aforo como límite duro; estados `borrador → publicado → en_curso → cerrado` + `cancelado`, y solo `publicado`/`en_curso` aceptan envíos y check-in (`RF-01`). Es la unidad de partición, de ownership y de corte (`TR-16`).
- `must` **El planner debe poder importar invitados de forma masiva e idempotente** (≤ 20 000 filas, asíncrono, clave de negocio dentro del evento); reimportar el mismo archivo no duplica ni reenvía nada, y el import **no envía mensajes**: cada invitado queda `pendiente_envío` (`RF-02`, `TR-11`).
- `must` **Cada invitado debe recibir una invitación con dos tokens de propósito distinto**: token de RSVP (enlace) y token de check-in (contenido del QR). El QR es un bearer de **un solo uso**, firmado y revocable: reenviarlo nunca produce una admisión extra (`RF-03`, `TR-06`, `TR-07`).
- `must` **El planner debe poder disparar el envío, y todo aviso debe salir por SMS y por email en paralelo**, con estado por canal y destinatario (`encolado → entregado | rebotado | indeterminado`); el fallo de un canal no bloquea al otro (`RF-16`, `RF-04`, `D11`).
- `must` **El invitado debe poder confirmar o declinar sin crear cuenta**, desde una página pública que también renderiza su QR; hay una sola respuesta vigente (la última gana) y el estado del RSVP nunca se sirve por un GET cacheable (`RF-05`, `RF-18`, `NFR-02`).
- `must` **Un trabajador habilitado debe poder verificar el QR en el venue con o sin conectividad**, con veredictos explícitos (`admitido`, `ya registrado`, `no corresponde al evento`, `invitación revocada`, `no verificable offline`, `no_en_roster`) y fallback por nombre + código corto de 6 dígitos; un invitado se admite **una sola vez en el sistema**, no por dispositivo (`RF-13`, `TR-17`). Es el problema #1 de la spec y no se recorta.
- `must` **El planner debe poder monitorear todos sus eventos en un solo tablero** con invitados, confirmados, asistentes, aún-no-llegaron, pendientes de sincronizar y entregas parciales; `no-show` se calcula al cierre, no en vivo (`RF-06`, con la frescura de `NFR-03`).
- `must` **Planner y trabajador deben poder autorregistrarse y abrir sesión** (email verificado, OTP por SMS para el trabajador); el invitado **nunca** se registra, y **el permiso de escanear no se obtiene registrándose**: lo otorga el planner por evento o el QR de acceso al evento (`RF-19`, `StaffAssignment`).
- `must` **El trabajador debe poder publicar su perfil contratable** —tipo, categorías de taxonomía cerrada, tarifa con unidad, zonas declaradas ± radio, idiomas, referencias— **sin exponer datos de contacto** y sin ser visible en la búsqueda hasta verificar email y teléfono (`RF-21`, `NFR-07`).
- `must` **El trabajador debe declarar su disponibilidad y el planner debe declarar los requerimientos del evento**: sin ventana declarada no es contratable, y una reserva solo se acepta si su ventana está **contenida** en una ventana del mismo rol; el requerimiento se cubre con la suma de plazas aceptadas (`RF-22`).
- `must` **El planner debe poder buscar trabajadores por las tres dimensiones del negocio**: capacidades (AND), lugares (zona del `Venue` o radio) y costos (rango de tarifa); devuelve solo perfiles `publicado` y verificados, sin contacto, con orden determinista (`RF-07`).
- `must` **La contratación debe ser solicitar → aceptar/rechazar, no asignación unilateral**: el planner solicita con `costo_congelado`, el trabajador acepta o rechaza desde su consola de forma idempotente, y solo la reserva `aceptada` ocupa la ventana —cross-evento, por compare-and-set sobre la suma de plazas (`RF-08`, `RF-17`, `TR-08`, `TR-20`).

El resto del catálogo queda **agrupado** y no encabeza el producto: `RF-09` emergencia (`should`), `RF-10` recordatorios (`should`; la mitad de llegada es post-MVP), `RF-11` pagos (`nice-to-have`, `D5`), `RF-12` seating (`should`), `RF-14` anulación de check-in (`should`), `RF-15` cierre (`post-MVP`), `RF-20` baja de invitado (`should`). Prioridades en §12.

## 2. Requerimientos no funcionales

**Entorno y CAP** (§1.1, `NFR-05`, `TR-17`): solo web, sin apps nativas; tres superficies y la de escaneo es el navegador del teléfono (PWA, `TR-15`). Durante el evento el escáner prioriza **A+P local** (resuelve contra su copia) y el sistema converge a **C server-side** por `recibido_en` del servidor. Disponibilidad objetivo 99,9 % mensual, medida sobre lecturas de invitación y tablero; **el veredicto offline no cuenta** contra ese número.

- `NFR-01` **Ráfaga de escritura del check-in**: **222 escrituras/s sostenidas 30 min** y **500 escrituras/s en ráfagas de 60 s**. El drenaje del backlog offline es **diferible**: se espacia hasta no competir con la ingesta viva (§6.1, §6.6).
- `NFR-03` **Frescura del tablero**: **≤ 5 s p95 (≤ 10 s p99)** con **reloj de servidor**, de `t_ingest` (commit + ack al dispositivo) a `t_visible`. El tiempo sin red del dispositivo **se excluye** de la métrica y se reporta aparte como antigüedad del backlog (`DeviceSyncState`, `TR-18`).
- `NFR-04` **Latencia de veredicto offline**: **≤ 100 ms p95 sin red** para verificación de QR + append durable, con roster **≤ 2 000 invitados** y **≤ 5 eventos** por sesión de escaneo.
- `NFR-06` **Durabilidad del check-in**: **RPO 0 en el dispositivo** (persistido *antes* de emitir el veredicto, con autonomía ≥ 8 h / ≥ 1 000 escaneos, `TR-02`) y **RPO 0 tras el ack de ingesta**; RSVP, reservas, seating y pagos con RPO ≤ 5 min; **RTO ≤ 1 h**.
- `NFR-02` **Lecturas de invitación**: ~40 M/mes (≈ 15 r/s), **75 r/s p95** y **200 r/s por 60 s**, con hit de CDN **≥ 95 %** (≤ 2 M lecturas al origen/mes). El shell es cacheable; el estado del RSVP viaja en la respuesta del POST.
- `NFR-11` + `NFR-07` **Aislamiento y seguridad**: **cero** filas de un evento ajeno en tablero, roster, autocompletado o check-in; token de RSVP **≥ 128 bits**, token de check-in verificado por firma offline; PII cifrada en reposo; el perfil público nunca expone contacto (solo hay dos excepciones acotadas y con lista blanca). Retención: 12 meses post-cierre para PII de evento, 24 para check-in y ledger (`NFR-08`, `should`).

## 3. Estimación de capacidad

Solo lo que **dimensiona el diseño**. Aritmética de §6, con la corrección de `README.md` donde la spec la documenta.

**Escrituras de check-in — el problema #1**

- Sábado: 4 600 eventos/semana × 40 % = **1 840 eventos** (§6.2); × 200 invitados = **368 000 check-ins** ÷ 5 400 s = **68/s** promedio en la ventana de 90 min (§6.2). El objetivo de diseño no cambia.
- Sostenido en la primera media hora: 400 000 ÷ 1 800 s = **222/s**, que es **3,0×** el promedio, no 5× (§6.1). *Corrige `README.md:17`.*
- Ráfaga: 500 w/s × 60 s = **30 000 llegadas** = 8 % del sábado ≈ **16 por evento** (§6.1).
- Replay offline: 20 venues reconectando × 2 eventos × 200 invitados = **8 000 pendientes en ≤ 120 s = 67/s**; 222 + 67 = **289/s**, dentro de 500/s. Si coincide con la ráfaga de 60 s, **el drenaje se espacia**: la sincronización se atrasa, el veredicto no se pierde (§6.6).
- RSVP, el otro pico de escritura: **100/s p95** y **400/s por 60 s** tras un envío masivo, p99 ≤ 300 ms (`NFR-01b`).

**Lecturas de invitación**

- 40 M/mes ÷ 2,6 M s ≈ **15 r/s** de promedio; la relación real es 10 aperturas ÷ 1,5 respuestas ≈ **6,7:1**, no 10:1 (§6.4).
- Pico derivado: 100 planners × 200 invitados = **20 000 invitaciones**; ~3 aperturas en 15 min = 60 000 ÷ 900 s = **67/s → 75 r/s p95**; **200/s por 60 s** si coinciden tres cohortes (§6.5).
- Con hit ≥ 95 % el origen ve **≤ 2 M al mes**, no 40 M (`NFR-02`, §6.4). Eso es lo que decide poner CDN, no un servidor más grande.

**Almacenamiento**

- 1 KB/invitado × 4 M invitados/mes = **4 GB/mes ≈ 48 GB/año** (§6.7), más check-ins, notificaciones y ledger. **El almacenamiento no es el problema** (§6.7, conclusión de `README.md:20`).

**Costo dominante de la factura: SMS**

- 4 M invitados/mes, **duplicados por SMS y email siempre** (`D11`), × $0,006–$0,10 por mensaje ≈ **$25 000–$400 000/mes**, alrededor del **85 % del costo total estimado** (`D11`). Es una decisión de producto que manda sobre la optimización de costo; el parámetro `canales_activos` (§11) permite apagar SMS sin tocar el modelo.

**Cifras que no cambian el diseño y por eso se omiten**

- Volumen de eventos al mes: **20 000** = 5 000 planners × 4 (§6.3). Es un derivado; no dimensiona ninguna decisión.
- Mesas, asientos y reservas: el riesgo es de **invariante** (capacidad de mesa, plazas solapadas cross-evento), no de tasa; ningún número de capacidad lo mueve (`TR-08`, `TR-10`).
- Costo y latencia del PSP: modo test, sin dispersión real de dinero (`D1`, `D5`).
- Peso en bytes de check-ins, notificaciones y ledger: §6.7 no los cuantifica y no alteran la conclusión de almacenamiento.
- Directorio de trabajadores: §6 no cuantifica su volumen, así que no hay cifra que estimar (`NFR-09` solo pide `worker_search_zero_results`/1 h).

## 4. Alcance del MVP

**Gate de dos pilares** (§12, `D9`): los dos son `must` y lo que queda afuera es **el dinero**. Sobre una **base compartida que se termina antes de bifurcar** (`D10`): `RF-19` (auth), `RF-01` (evento), `NFR-11` (membresía) y el esquema de datos de ambos pilares.

| Pilar | Ciclo | Entra en el MVP |
| --- | --- | --- |
| **A · invitado** | crear → importar → enviar → RSVP → check-in → tablero en vivo | `RF-01`, `RF-02`, `RF-03`, `RF-04`, `RF-05`, `RF-06`, `RF-13`, `RF-16`, `RF-18` |
| **B · contratación** | perfil → buscar → solicitar → aceptar → cubrir requerimiento | `RF-07`, `RF-08`, `RF-17`, `RF-21`, `RF-22` (+ `RF-19`, base) |

| Queda afuera del MVP | Por qué |
| --- | --- |
| Pagos a trabajadores: solo el puerto `PaymentProvider`, su contract test y el esquema del ledger | `nice-to-have` (`D5`, §12) |
| Reputación con puntajes y automatización del reemplazo | §12 |
| Empresas con `plazas_ofrecidas > 1` y aceptación parcial | §12; el modelo las soporta (`RF-08`, `TR-08`) porque cambiarlo después es más caro |
| `RF-09` emergencia, `RF-10` recordatorio de llegada, `RF-12` seating, `RF-14` anulación, `RF-15` cierre, `RF-20` baja, `NFR-08` retención | `should` / `post-MVP`: §12 |
| CFDI, presupuestos, asistente de IA, apps nativas, portal del anfitrión | Fuera del producto (`README.md:12`, §7) |

