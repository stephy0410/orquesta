# Accesibilidad WCAG 2.2 AA · superficies de planner e invitación

Issue #9. Rutas auditadas: tablero, nuevo evento, detalle de evento, invitados, mesas e invitación
pública, más la landing y el login.

## Cómo se auditó

- **axe-core 4** con las reglas `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` y `wcag22aa`, sobre el
  build de producción servido junto a la API en memoria (`InMemoryStore`) con datos de prueba: un
  planner con 3 eventos, 26 invitados, invitaciones enviadas, respuestas RSVP y 4 mesas.
- **Teclado solamente**: recorrido automatizado con Playwright (Tab, Shift+Tab, flechas y Enter,
  sin mouse).

## Resultado de axe

| Ruta | Antes | Después |
| --- | --- | --- |
| `/planner/dashboard` | 0 | 0 |
| `/planner/events/new` | 2 críticas (`label`, `select-name`) | 0 |
| `/planner/events/:id` | 1 crítica (`select-name`) | 0 |
| `/planner/events/:id/guests` | 2 críticas, 15 nodos (`label`, `select-name`) | 0 |
| `/planner/events/:id/seating` | 0 | 0 |
| `/invitacion` | 0 | 0 |

**0 violaciones serias o críticas** en todas las rutas.

## Recorrido solo con teclado

1. **Login.** El primer Tab llega a “Saltar al contenido”; se sigue con Tab hasta “Correo
   electrónico”, se escribe, Tab a “Contraseña” y Enter inicia sesión.
2. **Mesas.** En `/planner/events/:id/seating` el primer Tab vuelve a ser “Saltar al contenido”. Con
   Tab se llega al selector “Mesa para Andrés Paz”; con flecha abajo se elige otra mesa, Tab lleva a
   “Asignar mesa a Andrés Paz” y Enter asigna. El lector anuncia “Andrés Paz quedó en Familia
   novia.” (`role="status"`). En las filas de invitados que declinaron, el botón está deshabilitado y
   Tab lo salta.
3. **Mover y liberar.** En “Con mesa”, cada fila tiene un selector “Mover a … a otra mesa” y los
   botones “Mover” y “Liberar”. No hace falta drag-and-drop.
4. **Invitación.** En `/invitacion#t=…` el primer Tab llega a “Confirmar asistencia” y Enter confirma;
   el aviso “Tu asistencia ha sido confirmada…” se anuncia con `role="status"`.

## Cambios

- **Contraste.** Paleta nueva con todos los pares de texto de 5.07:1 o más (tinta 12.4:1, olivo
  6.0:1, texto secundario 5.7:1). Los bordes de inputs miden 3:1 o más contra el fondo (1.4.11).
- **Foco visible.** Anillo olivo de 2 px con separación en todo elemento enfocable
  (`:focus-visible`), según 2.4.7 y 2.4.11.
- **Saltar al contenido** como primer elemento enfocable en landing, login, registro y shells.
- **Etiquetas.** `aria-label` en los `select` e inputs que no tenían etiqueta (requerimientos de
  personal, rol de acceso, reenvío, filtros de entregas y selección de invitados); `<label>`
  visualmente oculto en los selectores de mesa.
- **Errores y avisos.** `role="alert"` en errores y en el conflicto de edición de mesas;
  `role="status"` en confirmaciones; `aria-invalid` con estilo de error para formularios.
- **Tablero en vivo.** Región `aria-live="polite"` que anuncia llegadas y confirmaciones como
  máximo una vez cada 15 s (`LiveAnnouncer`). Los cambios ocurridos durante la espera se suman en
  el siguiente anuncio en lugar de perderse. El avance de llegadas es un `role="meter"` con
  `aria-valuetext` (“3 de 7 confirmados”).
- **Navegación.** `aria-current="page"` en el menú y en las pestañas del evento; `scope="col"` y
  `caption` en las tablas; `aria-expanded` y `aria-controls` en “Ver escáneres”.
- **Movimiento.** `prefers-reduced-motion` desactiva animaciones y transiciones.
- **Lenguaje.** Títulos y mensajes en lenguaje de usuario (por ejemplo “Acomodo de mesas” en vez de
  “Acomodo de Mesas y Seating (RF-12, TR-10)”); los códigos de requisito se conservan en el
  atributo `data-requisitos` del `h1` para trazabilidad. Fechas de la invitación en la zona horaria
  del evento (“sábado, 21 de noviembre de 2026 · 19:00 a 23:59 h”).
