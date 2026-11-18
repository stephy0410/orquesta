# Página de RSVP: LCP p75 menor a 2.5 s en 4G

Issue #8. NFR de FR1: *la página de RSVP carga en menos de 2.5 s (LCP p75) en 4G*.

## Cómo se midió

- **Lighthouse 12**, perfil móvil con throttling simulado (*Slow 4G*: 150 ms de RTT, 1.6 Mbps de
  bajada y CPU 4x más lenta). Es más estricto que el 4G del NFR.
- **5 corridas por versión.** Se reporta el p75 del LCP.
- **Ruta medida:** `/invitacion#t=<token>` con un token real. Se usó el build de producción servido
  con gzip junto a la API en memoria (`InMemoryStore`), para medir solo el frontend sin la latencia
  de AWS.
- **Elemento LCP:** el `h1` con el nombre del evento.

Comando para repetirlo:

```bash
CHROME_PATH=$(which google-chrome) npx lighthouse "http://localhost:4200/invitacion#t=<token>" \
  --only-categories=performance --form-factor=mobile --throttling-method=simulate \
  --chrome-flags="--headless=new" --output=json --output-path=lh.json
```

## Resultados

| Versión | LCP p75 | FCP mediana | Transferido |
| --- | --- | --- | --- |
| Inicial (identidad visual nueva) | 2.83 s | 2.18 s | 244 KiB |
| + `runtime-config.js` con `defer`, QR con import diferido y sin fuente caligráfica | 2.74 s | 1.77 s | 206 KiB |
| + fuente de títulos con URL estable y `preload` | 2.73 s | 1.70 s | 205 KiB |
| + invitación sin `FormsModule` ni `CommonModule` | 2.75 s | 1.68 s | 195 KiB |
| **+ ruta `/invitacion` en el bundle inicial** | **2.35 s** | **1.66 s** | **189 KiB** |

**Resultado: LCP p75 de 2.35 s, menor a 2.5 s.**

## Qué se cambió y por qué

1. **`runtime-config.js` con `defer`.** Bloqueaba el render unos 300 ms. Con `defer` se sigue
   ejecutando antes que `main.js`, porque los scripts diferidos y los módulos respetan el orden del
   documento.
2. **Librería de QR con `import()` diferido.** Pesa unos 45 KB y ya no está en el camino crítico; el
   QR se dibuja justo después del nombre del evento.
3. **Fuentes con URL estable.** Bodoni Moda y Figtree (solo el subconjunto latin) se copian a
   `/fonts` y la de títulos se precarga desde `index.html`. Así se descarga en paralelo con el JS y
   no hasta que aparece el `h1`.
4. **Sin `FormsModule` en la invitación.** El campo para pegar el código usa `(input)` y
   `(submit)`, lo que quita un chunk de 45 KB (11 KB gzip) de la cadena de carga.
5. **`/invitacion` en el bundle inicial.** Era la mejora más grande: la carga diferida de la ruta
   agregaba un viaje de red secuencial (HTML → `main` → chunk de la ruta → API). Cuesta unos 3 KB
   gzip en el bundle inicial. El planner, el proveedor y el escáner **siguen en carga diferida**, así
   que la invitación no descarga su código.
6. **Budget más estricto** en `angular.json`: el bundle inicial avisa en 340 kB y falla en 400 kB
   (antes 500 kB y 1 MB), para que el LCP no se degrade sin que nadie lo note.

## AC-23: responder sin cookie

`invitation.page.spec.ts` comprueba que la invitación se abre, se confirma, se declina y se cambia
la respuesta **sin cookie y sin `Authorization`**.

## Pendiente

- **Medir en `lab`.** Falta medir con CloudFront y API Gateway en `lab` cuando el CD esté listo
  (issue #10), para sumar la latencia real de la API.
- **Resumen cacheado (PR #1 de Emmanuel).** Cuando entre, la invitación ya no necesitará el GET a
  la API para pintar el nombre y la fecha, y el LCP debería bajar otra vez.
