#!/usr/bin/env node
/**
 * Sube el logo de Orquesta (front/public/brand/orquesta-logo-verde.png) a Stripe y deja su id en
 * back/.env como STRIPE_LOGO_FILE_ID, para que la página de pago muestre nuestro logo.
 *
 * Solo hace falta en local: en AWS Stripe descarga el logo de PUBLIC_BASE_URL/brand/… por https.
 * Uso: npm run stripe:logo   (requiere STRIPE_SECRET_KEY o STRIPE_SECRET en back/.env)
 */
import { appendFile, readFile } from "node:fs/promises";

const envPath = new URL("../.env", import.meta.url);
try {
  process.loadEnvFile(envPath);
} catch {
  // sin .env
}
const key = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET;
if (!key) {
  console.error("Falta STRIPE_SECRET_KEY en back/.env");
  process.exit(1);
}
if (process.env.STRIPE_LOGO_FILE_ID) {
  console.log(`Ya existe STRIPE_LOGO_FILE_ID=${process.env.STRIPE_LOGO_FILE_ID} en back/.env; bórrala para volver a subir el logo.`);
  process.exit(0);
}

const png = await readFile(new URL("../../front/public/brand/orquesta-logo-verde.png", import.meta.url));
const form = new FormData();
form.append("purpose", "business_logo");
form.append("file", new Blob([png], { type: "image/png" }), "orquesta-logo-verde.png");
const res = await fetch("https://files.stripe.com/v1/files", {
  method: "POST",
  headers: { Authorization: `Bearer ${key}` },
  body: form,
});
const json = await res.json();
if (!res.ok) {
  console.error(`Stripe rechazó el logo: ${json?.error?.message || res.status}`);
  process.exit(1);
}
await appendFile(envPath, `\nSTRIPE_LOGO_FILE_ID=${json.id}\n`);
console.log(`Logo subido (${json.id}) y guardado en back/.env. Reinicia "npm run dev".`);
