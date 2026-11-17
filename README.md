# Orquesta
## Requisitos funcionales
Las planners crean eventos e importan invitados; cada invitado recibe una invitación con QR único y confirma sin crear cuenta.
El staff hace check in escaneando el QR en el venue, incluso con mala o nula conectividad.
Los planners monitorean todos sus eventos en vivo desde un solo tablero, casi en tiempo real.
Los planners pueden buscar proveedores y asignarlos al evento antes del evento y por alguna emergencia en el evento.
Recordatorios automáticos: RSVP para invitados y hora de llegada para proveedores.
El planner puede pagar a los proveedores.
Los planners pueden organizar el acomodo de mesas de los invitados
Los invitados reciben su invitación por SMS y email.

#### Fuera de alcance: facturación CFDI, presupuestos, asistente de IA, apps nativas y portal del anfitrión.

## Estimación de capacidad
Objetivo de diseño: 5 mil planners, por 4 eventos al mes, por 200 invitados, da aproximadamente 4 millones de invitados al mes.
Pico: la mayoría de los eventos caen en viernes, sábado y domingo, y el sábado en la noche es el peor caso. Son unos 4,600 eventos por semana; con alrededor del 40% en sábado, son unos 2 mil eventos esa noche. Con llegadas concentradas en 90 minutos, son 400 mil check ins en 5,400 segundos, aproximadamente 75 escrituras por segundo en promedio. Como la mayoría llega en los primeros 30 minutos, el pico real es unas 5 veces el promedio: unas 400 escrituras por segundo. Diseñamos para 500 por segundo, con margen. 
Sincronización offline: cuando un venue recupera señal, los escáneres mandan de golpe todo lo pendiente. Eso agrega ráfagas cortas sobre el pico, y por eso la sincronización es por lotes.
RSVP: cada invitado abre su invitación unas 10 veces y responde una o dos, alrededor de 10 lecturas por escritura. Son unos 40 millones de lecturas al mes, unas 15 por segundo en promedio, con picos justo después de enviar invitaciones. Se resuelve con caché en CloudFront.
Almacenamiento: alrededor de 1 kilobyte por invitado, unos 4 gigabytes al mes y unos 50 al año, más los registros de check in y de notificaciones.
Conclusión: el almacenamiento no es el problema. Lo difícil son las ráfagas de escritura del check in, la idempotencia en check in y pagos, el fan out del tablero y la concurrencia en reservas y mesas.
## Requerimientos No funcionales
Invitaciones y RSVP (FR 1). Objetivo: importar 1,000 invitados en menos de 30 segundos. El token del QR está firmado con HMAC, no se puede adivinar y no contiene datos personales. La página de RSVP carga en menos de 2.5 segundos (LCP p75) en 4G.
Check in (FR 2). Objetivo: p99 menor a 300 milisegundos en línea y menor a 100 milisegundos sin conexión. Soporta 500 escrituras por segundo en el pico. Cero check ins perdidos, y un QR nunca admite más personas que su cupo. Al recuperar señal, 500 registros pendientes se sincronizan en menos de 30 segundos. 
Tablero en vivo (FR 3). Objetivo: un cambio aparece en menos de 3 segundos. Soporta 10 mil conexiones abiertas a la vez y reconecta solo en menos de 5 segundos. 
Proveedores (FR 4). Objetivo: buscar proveedores en un radio de 25 km tarda menos de 500 milisegundos (p95). Un proveedor nunca queda asignado a dos eventos que se traslapan. En emergencias, los primeros proveedores reciben la solicitud en menos de 60 segundos, y nunca se asignan más proveedores que lugares. 
Recordatorios (FR 5). Objetivo: se envían a la hora programada con un margen de 5 minutos, en la zona horaria del evento, y nunca dos veces. 
Pagos a proveedores (FR 6). Objetivo: ningún pago se cobra ni se envía dos veces, porque cada pago lleva una llave de idempotencia. No guardamos datos de tarjetas ni de cuentas; los maneja el procesador de pagos. Cada movimiento queda en un libro contable que solo se agrega y nunca se edita, con conciliación diaria contra el procesador. Si el procesador falla, el pago queda pendiente y se reintenta; nunca se pierde. 
Acomodo de mesas (FR 7). Objetivo: ningún invitado queda en dos mesas y ninguna mesa rebasa su capacidad. Si dos personas editan el mismo plano a la vez, el segundo cambio se rechaza con aviso en lugar de sobrescribir el primero (control de versión optimista). Guardar un cambio tarda menos de 1 segundo, con soporte para 500 invitados en 50 mesas. 
Envío por SMS y email (FR 8). Objetivo: 200 invitaciones se encolan en menos de 1 segundo y se entregan en menos de 5 minutos, con reintentos automáticos y una cola para mensajes fallidos. Ningún invitado recibe la misma invitación dos veces por el mismo canal, y si falla un canal, el otro se entrega igual. Se respeta la baja del invitado, y el dominio usa SPF, DKIM y DMARC para no caer en spam.
Transversales. Aplican a toda la plataforma.
Disponibilidad: 99.9% para la plataforma y 99.95% para check in de viernes a domingo de 17:00 a 02:00, con congelamiento de despliegues los sábados.
Aislamiento de fallas: si fallan Notification, Live o el procesador de pagos, el check in y la asignación de proveedores siguen funcionando. Es la razón de ser de los microservicios.
Durabilidad y recuperación: si cae una zona de disponibilidad, no se pierde ningún pago ni check in confirmado, gracias a la réplica síncrona en varias zonas. Ante corrupción o un borrado accidental, se restaura a cualquier punto de los últimos 7 días, perdiendo como máximo 5 minutos de datos (RPO), y el servicio vuelve en menos de 1 hora (RTO).
Seguridad y privacidad: TLS en todo el tráfico y cifrado en reposo con KMS. Cada organización solo ve sus datos y el QR no contiene datos personales. Aviso de privacidad conforme a la LFPDPPP, y los teléfonos de los invitados se borran 90 días después del evento.
Escalabilidad: crecer 10 veces, a unas 5 mil escrituras por segundo, sin rediseñar; solo se agrega capacidad.
Accesibilidad: WCAG 2.2 AA en toda la aplicación web.
Observabilidad: alarmas de p99, errores 5xx y colas atascadas, para detectar un problema en menos de 5 minutos, antes que el usuario.
Preparado para internacional: fechas en UTC con zona horaria IANA por evento, idioma y moneda por organización, y arquitectura por celdas, con una celda por país o región y residencia de datos. Las traducciones se manejan con POEditor. México ya tiene 4 zonas horarias, por ejemplo las bodas en Cancún.
La consistencia se elige por funcionalidad, no por sistema
Es la idea clave para la presentación.
Pagos: CP, consistencia fuerte y exactamente una vez. Un cobro doble es peor que un pago que tarda.
Asignación de proveedores, antes del evento y en emergencias: CP, sin doble reserva.
Check in: AP en el borde con reconciliación. Una puerta que deja de funcionar por falta de señal es peor que un duplicado ocasional.
Tablero: consistencia eventual, en menos de 3 segundos.
Acomodo de mesas: control de versión optimista. Cada quien ve sus propios cambios al instante, y un conflicto se avisa en lugar de sobrescribirse.
Notificaciones: entrega al menos una vez con deduplicación, que para el invitado equivale a exactamente una vez.
Entidades principales y su dueño
Event Service es dueño de Organization, User con su rol, Event, Guest, Invitation, Rsvp, SeatingPlan, Table y SeatAssignment.
Checkin Service es dueño de Manifest (una réplica), Admission y CheckinRecord.
Dispatch Service es dueño de Vendor, VendorCategory, Availability, Booking, EmergencyRequest y EmergencyAssignment.
Notification Service es dueño de Notification, DeliveryAttempt, Reminder y Unsubscribe.
Payment Service es dueño de Payment, Payout, LedgerEntry e IdempotencyKey.
Live Service no tiene entidades persistentes, solo proyecciones efímeras en Valkey.
Regla: cada entidad tiene un solo servicio dueño. Los demás reciben copias por eventos y nunca leen su base de datos.
Arquitectura de eventdriving
Principio: dividimos por perfil de consistencia y de escalamiento, no por sustantivos. Seis servicios, cada uno con una razón defendible para existir.
Event Service
Responsabilidad: organizaciones, eventos, invitados, invitaciones, RSVP, importación CSV y acomodo de mesas. Datos: PostgreSQL con esquema propio. Por qué es independiente: lectura intensa en RSVP y es el dueño del ciclo de vida del evento. Responsable: Hannah.
Checkin Service
Responsabilidad: manifiesto, check in y sincronización offline. Datos: DynamoDB on demand. Por qué es independiente: es la ruta de escritura más caliente, con ráfagas de 500 por segundo; escala sola y usa escrituras condicionales. Responsable: Stephanie.
Dispatch Service
Responsabilidad: catálogo de proveedores, búsqueda geoespacial, contratación antes del evento, emergencias y asignación. Datos: PostgreSQL con PostGIS y esquema propio. Por qué es independiente: necesita consistencia fuerte y es el único dueño de las reservas y la asignación. Responsable: Emmanuel.
Notification Service
Responsabilidad: invitaciones y avisos por email y SMS, y recordatorios. Datos: PostgreSQL con el registro de entregas y las bajas. Por qué es independiente: integra proveedores externos lentos e inestables y aísla sus fallas. Responsable: Emmanuel.
Live Service
Responsabilidad: conexiones SSE del tablero. Datos: Valkey, efímero. Por qué es independiente: mantiene miles de conexiones abiertas, un perfil de escalamiento distinto al resto. Responsable: Hannah.
Payment Service
Responsabilidad: pagos de la planner a proveedores, anticipos y liquidaciones, y conciliación diaria con el procesador de pagos. Datos: PostgreSQL con esquema propio y un libro contable de solo agregar. Por qué es independiente: es la única parte que mueve dinero, exige consistencia fuerte y concentra el alcance de PCI DSS; aislarla reduce la superficie de riesgo y permite auditarla por separado. Responsable: Stephanie.
Cómo fluye una petición
Esta es la descripción del diagrama de arquitectura, paso a paso.
Los cuatro clientes (tablero de la planner, escáner PWA offline, página de RSVP del invitado y app del proveedor) entran por CloudFront con WAF.
CloudFront sirve la aplicación web desde S3 y manda las llamadas de API al ALB.
El ALB enruta por path hacia Event, Checkin, Dispatch, Payment o Live Service, todos en ECS Fargate.
Event usa su esquema de PostgreSQL. Dispatch usa su esquema de PostgreSQL con PostGIS. Notification y Payment usan cada uno su propio esquema. Checkin usa DynamoDB.
Event, Dispatch y Payment publican eventos al bus de EventBridge con un outbox. Checkin los publica con DynamoDB Streams y EventBridge Pipes. EventBridge Scheduler publica los recordatorios.
El bus entrega cada evento a una cola SQS por consumidor, cada una con su DLQ.
Checkin, Notification, Live, Event, Dispatch y Payment consumen de sus propias colas.
Live reparte las actualizaciones entre sus instancias con pub/sub de Valkey y las empuja por SSE al tablero.
Notification envía email por SES y SMS por AWS End User Messaging. El procesador de pagos confirma cada pago con un webhook firmado hacia Payment Service.
