# Orquesta en acción

Orquesta es una plataforma para organizadoras de bodas y eventos (*planners*). Desde una sola consola crean el evento, mandan invitaciones con QR por SMS y correo, acomodan las mesas, contratan y pagan a los proveedores, y el día del evento ven en vivo quién va llegando a cada uno de sus eventos.

Esta página recorre la aplicación tal como funciona hoy, con capturas tomadas de la app corriendo con datos de demostración. El diseño técnico completo (requisitos, API, arquitectura en AWS y decisiones) está en el [README](../README.md).

**En números:** 83 endpoints HTTP · 6 servicios en AWS Lambda · PostgreSQL 16 · Angular · 26 pruebas automatizadas que corren contra PostgreSQL real en cada cambio · check-in probado a **517 invitados por segundo** sin perder ni duplicar una sola entrada.

**Contenido:** [Planner](#1-la-planner-organiza-el-evento) · [Pagos](#2-contrata-y-paga-a-sus-proveedores) · [Invitado](#3-el-invitado-confirma-desde-su-celular) · [Día del evento](#4-el-día-del-evento) · [Proveedor](#5-el-proveedor-recibe-y-acepta-trabajos) · [Lo que no se ve](#lo-que-no-se-ve-en-las-capturas) · [Equipo](#equipo)

---

## La página de inicio

Cada tipo de usuario tiene su propia entrada: planners, proveedores, el personal de la puerta y los invitados.

![Página de inicio de Orquesta](capturas/01-inicio.jpg)

![Accesos para planners, proveedores, día del evento e invitados](capturas/02-inicio-roles.jpg)

---

## 1. La planner organiza el evento

### Tablero en vivo

Lo primero que ve la planner: todos sus eventos en una pantalla, cuántos confirmados ya llegaron y alertas, como un escáner que dejó de reportar. Se actualiza solo cada pocos segundos.

![Tablero en vivo con varios eventos](capturas/04-tablero-en-vivo.jpg)

### Crear un evento

Fecha, horario, aforo, lugar y el personal que va a necesitar. El evento queda como borrador y nadie recibe nada hasta que se publica.

![Formulario para crear un evento](capturas/05-nuevo-evento.jpg)

### Invitados y envíos

La lista de invitados con su respuesta (confirmó, no viene o sin respuesta). Desde aquí se mandan las invitaciones por SMS y correo.

![Lista de invitados con su estado de respuesta](capturas/07-invitados.jpg)

La lista se sube como archivo CSV. Subir el mismo archivo dos veces no duplica a nadie, y una lista de 1 000 invitados queda lista, con su QR firmado cada uno, en unos 6 segundos.

![Subir la lista de invitados desde un CSV](capturas/08-importar-invitados.jpg)

### Acomodo de mesas

Cada invitado confirmado se asigna a una mesa y el pase de entrada le muestra dónde se sienta. Si dos personas editan el plano al mismo tiempo, el sistema lo detecta y no deja que una sobrescriba a la otra.

![Mesas con su ocupación e invitados asignados](capturas/09-mesas.jpg)

---

## 2. Contrata y paga a sus proveedores

### Marketplace de proveedores

Meseros, fotografía, DJ, catering y más, con filtros por precio, zona y fecha del evento. Todos los perfiles están verificados por correo y teléfono.

![Marketplace de proveedores con filtros](capturas/11-marketplace.jpg)

Desde el perfil se contrata directo para un evento. El sistema avisa si el proveedor ya tiene otro compromiso a esa hora, y nunca deja contratar más personas de las que ofrece.

![Perfil de un proveedor con el formulario para contratarlo](capturas/12-perfil-proveedor.jpg)

### Personal y pagos

Cuánta gente necesita la planner por puesto, a quién contrató y si ya le pagó. El precio queda fijo desde que se envía la solicitud.

![Contrataciones del evento con su estado de pago](capturas/10-personal-y-pagos.jpg)

### Pago con Stripe

El pago se hace en la página de Stripe, con los colores y el logo de Orquesta, así que la app nunca toca datos de tarjeta. Un doble clic no cobra dos veces, y si la reserva pagada se cancela, el dinero se devuelve solo.

![Página de pago de Stripe con el diseño de Orquesta](capturas/23-pago-stripe.jpg)

---

## 3. El invitado confirma desde su celular

La invitación llega por SMS y correo. El invitado la abre sin crear cuenta y confirma con un toque.

![Invitación a la boda con botones para confirmar](capturas/16-invitacion.jpg)

![Invitación con la asistencia confirmada](capturas/17-invitacion-confirmada.jpg)

Al confirmar recibe su pase de entrada: un QR firmado digitalmente, sin datos personales, y un código de 6 dígitos por si la cámara no lo lee. También puede dejar de recibir mensajes por SMS o por correo sin perder su invitación.

![Pase de entrada con QR y código de respaldo](capturas/18-pase-qr.jpg)

---

## 4. El día del evento

La planner inicia el evento y ve cada entrada conforme se registra. Si alguien entró por error, la entrada se puede anular.

![Evento en curso con las entradas registradas](capturas/13-evento-en-curso.jpg)

El escáner corre en el navegador de cualquier celular. **Funciona sin señal:** valida el QR en el propio teléfono, guarda las entradas y las sincroniza cuando vuelve la conexión. Si dos puertas escanean al mismo invitado, solo cuenta una entrada.

![Escáner de QR con contadores de sincronización](capturas/14-escaner-qr.jpg)

Si el QR no se lee, se busca al invitado por nombre o por su código de 6 dígitos.

![Búsqueda de invitados por nombre o código en la puerta](capturas/15-escaner-busqueda.jpg)

---

## 5. El proveedor recibe y acepta trabajos

Las solicitudes le llegan al proveedor con el precio, el horario y el estado del pago. Puede registrar su llegada o cancelar.

![Solicitudes y reservas del proveedor](capturas/20-proveedor-solicitudes.jpg)

Su perfil: qué ofrece, tarifa y los pasos para aparecer en la búsqueda. Sus datos de contacto nunca se muestran a las planners.

![Perfil del proveedor](capturas/21-proveedor-perfil.jpg)

Solo puede recibir solicitudes dentro de los horarios en que marcó que está disponible.

![Disponibilidad del proveedor](capturas/22-proveedor-disponibilidad.jpg)

---

## Privacidad

Aviso de privacidad conforme a la ley mexicana (LFPDPPP), enlazado desde la invitación, los registros y los correos. Los teléfonos de los invitados se borran solos 90 días después del evento.

![Aviso de privacidad](capturas/19-aviso-privacidad.jpg)

---

## Lo que no se ve en las capturas

- **Check-in sin conexión, sin perder ni duplicar entradas.** En la prueba de carga: 517 entradas por segundo, 1 000 entradas acumuladas sin señal sincronizadas en medio segundo, y el tablero al día en 1.2 s. [Resultados](../back/load/README.md).
- **Pagos que no se pierden ni se duplican.** Cada cobro tiene una llave de idempotencia y un libro contable de doble entrada; un barrido automático retoma los pagos con respuesta incierta y una conciliación diaria compara el libro con Stripe.
- **Nada se manda dos veces.** Las invitaciones salen por colas independientes para SMS y correo, con reintentos; si un canal falla, el otro igual se entrega.
- **Pruebas contra la base de datos real.** Los mismos escenarios de aceptación corren en memoria y contra PostgreSQL 16 en cada cambio. Correrlos contra PostgreSQL destapó fallas que las pruebas en memoria ocultaban; están documentadas en el [README](../README.md#7-calidad-y-trazabilidad).
- **Infraestructura como código.** Toda la plataforma en AWS (API Gateway, Lambda, PostgreSQL, SQS/SNS, S3, CloudFront, WAF y alarmas) está definida en Terraform. El despliegue sale de GitHub Actions y se bloquea los sábados, que es cuando hay eventos.

## Equipo

| Persona | Qué hizo |
| --- | --- |
| **Hannah** | Frontend en Angular: consola de la planner, consola del proveedor, invitación pública y escáner. |
| **Stephanie** | Backend: los servicios del dominio, PostgreSQL, pagos con Stripe, pruebas de aceptación y de carga. |
| **Emmanuel** | Infraestructura: AWS con Terraform, despliegue y observabilidad. |

## Verlo en tu máquina

```bash
cd back && npm ci && npm run db:up && npm run dev   # API local + PostgreSQL en Docker
npm run seed                                         # en otra terminal: datos de demostración
cd ../front && npm ci && npx ng serve                # http://localhost:4200
```

Entra como planner con `demo@orquesta.test` / `Demo12345!` o como proveedor con `dj@orquesta.test` / `Demo12345!`. Más detalle en [Cómo correrlo](../README.md#9-cómo-correrlo).
