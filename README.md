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

# Fuera de alcance: facturación CFDI, presupuestos, asistente de IA, apps nativas y portal del anfitrión.

## Estimación de capacidad
Objetivo de diseño: 5 mil planners, por 4 eventos al mes, por 200 invitados, da aproximadamente 4 millones de invitados al mes.
Pico: la mayoría de los eventos caen en viernes, sábado y domingo, y el sábado en la noche es el peor caso. Son unos 4,600 eventos por semana; con alrededor del 40% en sábado, son unos 2 mil eventos esa noche. Con llegadas concentradas en 90 minutos, son 400 mil check ins en 5,400 segundos, aproximadamente 75 escrituras por segundo en promedio. Como la mayoría llega en los primeros 30 minutos, el pico real es unas 5 veces el promedio: unas 400 escrituras por segundo. Diseñamos para 500 por segundo, con margen. 
Sincronización offline: cuando un venue recupera señal, los escáneres mandan de golpe todo lo pendiente. Eso agrega ráfagas cortas sobre el pico, y por eso la sincronización es por lotes.
RSVP: cada invitado abre su invitación unas 10 veces y responde una o dos, alrededor de 10 lecturas por escritura. Son unos 40 millones de lecturas al mes, unas 15 por segundo en promedio, con picos justo después de enviar invitaciones. Se resuelve con caché en CloudFront.
Almacenamiento: alrededor de 1 kilobyte por invitado, unos 4 gigabytes al mes y unos 50 al año, más los registros de check in y de notificaciones.
Conclusión: el almacenamiento no es el problema. Lo difícil son las ráfagas de escritura del check in, la idempotencia en check in y pagos, el fan out del tablero y la concurrencia en reservas y mesas.
