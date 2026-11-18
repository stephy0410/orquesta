# Orquesta — Frontend (`front/`)

Aplicación web en **Angular** (Standalone Components, Signals y `@angular/pwa`) que implementa las cuatro superficies del producto sin apps nativas (`docs/requerimientos.md` §1.1).

## Diseño Técnico

Consulta el System Design detallado de componentes, rutas, estado con Signals, verificación criptográfica offline (Web Crypto ES256) y almacenamiento en IndexedDB en [`docs/delivery/07-system-design-back-front.md`](../docs/delivery/07-system-design-back-front.md).

## Superficies (`src/app/features/`)

- `planner/`: Consola desktop-first (eventos, importación masiva, disparo de envíos, tablero en vivo con frescura ≤ 5 s p95, acomodo de mesas y contratación de trabajadores).
- `worker/`: Consola del trabajador (perfil persona/empresa, verificación OTP, ventanas de disponibilidad, aceptación total/parcial de solicitudes y pagos).
- `invitation/`: Página pública sin cuenta (`/invitacion/#t=<rsvp_token>`), optimizada para ≥ 95 % de *cache hit* en CDN (`NFR-02`).
- `scanner/`: PWA instalable de check-in offline-first (`TR-02`, `TR-15`), con cámara + fallback manual de 6 dígitos, cola durable en IndexedDB (`RPO 0`) y sincronización por lotes ≤ 500.
