// Adaptador de Stripe (FR6) contra un `fetch` falso: valida lo que se envía a la API de Stripe
// (centavos, idempotencia, diseño de la página de pago) y cómo se interpretan sus respuestas.
// No usa red ni base de datos; corre igual con TEST_DB=pg.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { safeReturnUrl } from "../src/lambdas/api/routes/payments.js";
import { verifyStripeSignature } from "../src/shared/crypto.js";
import { ORQUESTA_CHECKOUT_BRANDING, StripeApiError, StripePspAdapter } from "../src/shared/ports.js";

function fakeStripe(responder) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const params = init.body ? new URLSearchParams(init.body) : u.searchParams;
    calls.push({ method: init.method, path: u.pathname, params, headers: init.headers });
    const { status = 200, json } = await responder({ method: init.method, path: u.pathname, params });
    return { ok: status < 400, status, json: async () => json };
  };
  return { calls, fetchImpl };
}

const KEY = "sk_test_unitario";

test("charge crea un Checkout en centavos, en español, con el diseño de Orquesta e idempotente", async () => {
  const { calls, fetchImpl } = fakeStripe(() => ({
    json: { id: "cs_test_1", status: "open", payment_status: "unpaid", url: "https://checkout.stripe.com/c/pay/cs_test_1" },
  }));
  const psp = new StripePspAdapter({ secretKey: KEY, fetchImpl, iconUrl: "https://orquesta.app/icons/icon-512x512.png" });
  const r = await psp.charge({
    idempotencyKey: "pay:01RESERVA",
    amount: 1234.5,
    currency: "MXN",
    metadata: { reservation_id: "01RESERVA" },
    successUrl: "https://orquesta.app/ok",
    cancelUrl: "https://orquesta.app/no",
  });
  assert.deepEqual(
    { status: r.status, reference: r.reference, url: r.checkout_url },
    { status: "requires_action", reference: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" }
  );
  const [c] = calls;
  assert.equal(c.method, "POST");
  assert.equal(c.path, "/v1/checkout/sessions");
  assert.equal(c.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(c.headers["Idempotency-Key"], "pay:01RESERVA:checkout:1");
  const p = Object.fromEntries(c.params);
  assert.equal(p.mode, "payment");
  assert.equal(p.locale, "es-419");
  assert.equal(p["line_items[0][price_data][unit_amount]"], "123450");
  assert.equal(p["line_items[0][price_data][currency]"], "mxn");
  assert.equal(p["metadata[idempotency_key]"], "pay:01RESERVA");
  assert.equal(p["payment_intent_data[metadata][idempotency_key]"], "pay:01RESERVA");
  assert.equal(p["branding_settings[background_color]"], ORQUESTA_CHECKOUT_BRANDING.background_color);
  assert.equal(p["branding_settings[button_color]"], ORQUESTA_CHECKOUT_BRANDING.button_color);
  assert.equal(p["branding_settings[border_style]"], "rectangular");
  assert.equal(p["branding_settings[font_family]"], "inter");
  assert.equal(p["branding_settings[icon][url]"], "https://orquesta.app/icons/icon-512x512.png");

  // Tras expirar una sesión, la siguiente usa otra llave (y no reutiliza la caducada).
  await psp.charge({
    idempotencyKey: "pay:01RESERVA",
    amount: 1234.5,
    currency: "MXN",
    successUrl: "https://orquesta.app/ok",
    cancelUrl: "https://orquesta.app/no",
    previousReference: "cs_test_1",
  });
  assert.equal(calls[1].headers["Idempotency-Key"], "pay:01RESERVA:checkout:cs_test_1");
});

test("logo de Orquesta: archivo subido a Stripe (local) o URL pública (AWS)", async () => {
  const { calls, fetchImpl } = fakeStripe(() => ({ json: { id: "cs_1", status: "open", payment_status: "unpaid", url: "https://x" } }));
  const args = { idempotencyKey: "pay:L", amount: 100, currency: "MXN", successUrl: "https://a/ok", cancelUrl: "https://a/no" };
  await new StripePspAdapter({ secretKey: KEY, fetchImpl, logoFileId: "file_123", logoUrl: "https://orquesta.app/brand/l.png" }).charge(args);
  assert.equal(calls[0].params.get("branding_settings[logo][type]"), "file");
  assert.equal(calls[0].params.get("branding_settings[logo][file]"), "file_123");
  await new StripePspAdapter({ secretKey: KEY, fetchImpl, logoUrl: "https://orquesta.app/brand/l.png" }).charge(args);
  assert.equal(calls[1].params.get("branding_settings[logo][url]"), "https://orquesta.app/brand/l.png");
  await new StripePspAdapter({ secretKey: KEY, fetchImpl, logoUrl: "http://localhost:4200/brand/l.png" }).charge(args);
  assert.equal(calls[2].params.get("branding_settings[logo][type]"), null, "Stripe no puede descargar de localhost");
});

test("el ícono solo se manda si es una URL pública https", () => {
  for (const iconUrl of ["http://localhost:4200/icons/a.png", "https://localhost/icons/a.png", "ftp://x/a.png"]) {
    assert.equal(new StripePspAdapter({ secretKey: KEY, iconUrl }).iconUrl, null);
  }
});

test("queryByKey interpreta sesiones pagadas, abiertas y caducadas, y busca por metadata sin sesión", async () => {
  const sesiones = {
    cs_paid: { id: "cs_paid", status: "complete", payment_status: "paid", payment_intent: "pi_1", amount_total: 70000, currency: "mxn" },
    cs_open: { id: "cs_open", status: "open", payment_status: "unpaid", url: "https://checkout.stripe.com/c/pay/cs_open" },
    cs_exp: { id: "cs_exp", status: "expired", payment_status: "unpaid" },
  };
  const { calls, fetchImpl } = fakeStripe(({ path, params }) => {
    if (path.startsWith("/v1/checkout/sessions/")) return { json: sesiones[path.split("/").pop()] };
    if (path === "/v1/payment_intents/search") {
      assert.match(params.get("query"), /metadata\['idempotency_key'\]:'pay:01X'/);
      return { json: { data: [{ id: "pi_9", status: "succeeded", amount_received: 50000, currency: "mxn", created: 1780000000, metadata: { idempotency_key: "pay:01X" } }] } };
    }
    throw new Error(`ruta inesperada ${path}`);
  });
  const psp = new StripePspAdapter({ secretKey: KEY, fetchImpl });

  const paid = await psp.queryByKey("pay:01A", { reference: "cs_paid" });
  assert.deepEqual(
    { found: paid.found, status: paid.status, id: paid.psp_charge_id, amount: paid.amount, currency: paid.currency },
    { found: true, status: "succeeded", id: "pi_1", amount: 700, currency: "MXN" }
  );
  const open = await psp.queryByKey("pay:01A", { reference: "cs_open" });
  assert.equal(open.status, "open");
  assert.equal(open.checkout_url, "https://checkout.stripe.com/c/pay/cs_open");
  assert.equal((await psp.queryByKey("pay:01A", { reference: "cs_exp" })).status, "expired");

  const porMetadata = await psp.queryByKey("pay:01X");
  assert.equal(porMetadata.found, true);
  assert.equal(porMetadata.amount, 500);
  assert.equal(calls.at(-1).path, "/v1/payment_intents/search");
});

test("listCharges pagina y solo cuenta cobros de Orquesta", async () => {
  const pagina1 = {
    has_more: true,
    data: [
      { id: "pi_a", status: "succeeded", amount_received: 10000, currency: "mxn", created: 1780000000, metadata: { idempotency_key: "pay:A" } },
      { id: "pi_ajeno", status: "succeeded", amount_received: 999, currency: "mxn", created: 1780000001, metadata: {} },
    ],
  };
  const pagina2 = {
    has_more: false,
    data: [{ id: "pi_b", status: "requires_payment_method", amount: 5000, currency: "mxn", created: 1780000002, metadata: { idempotency_key: "pay:B" } }],
  };
  const { calls, fetchImpl } = fakeStripe(({ params }) => ({ json: params.get("starting_after") ? pagina2 : pagina1 }));
  const psp = new StripePspAdapter({ secretKey: KEY, fetchImpl });
  const cobros = await psp.listCharges({ from: new Date("2026-06-01T00:00:00Z"), to: new Date("2026-06-02T00:00:00Z") });
  assert.deepEqual(cobros.map((c) => [c.idempotency_key, c.amount]), [["pay:A", 100]]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].params.get("starting_after"), "pi_ajeno");
  assert.equal(calls[0].params.get("created[gte]"), String(Date.UTC(2026, 5, 1) / 1000));
});

test("errores de Stripe: sin respuesta o 5xx es incierto; 4xx es rechazo definitivo", async () => {
  const caida = new StripePspAdapter({ secretKey: KEY, fetchImpl: async () => { throw new Error("ECONNRESET"); } });
  await assert.rejects(caida.queryByKey("pay:1", { reference: "cs" }), (e) => e.isTimeout === true);

  const s500 = new StripePspAdapter({ secretKey: KEY, fetchImpl: fakeStripe(() => ({ status: 503, json: {} })).fetchImpl });
  await assert.rejects(s500.queryByKey("pay:1", { reference: "cs" }), (e) => e instanceof StripeApiError && e.isTimeout === true);

  const s400 = new StripePspAdapter({
    secretKey: KEY,
    fetchImpl: fakeStripe(() => ({ status: 400, json: { error: { type: "invalid_request_error", message: "Amount too small" } } })).fetchImpl,
  });
  await assert.rejects(
    s400.charge({ idempotencyKey: "pay:1", amount: 1, currency: "MXN", successUrl: "https://a/ok", cancelUrl: "https://a/no" }),
    (e) => e instanceof StripeApiError && e.status === 400 && !e.isTimeout
  );
});

test("solo acepta llaves secretas de Stripe", () => {
  assert.throws(() => new StripePspAdapter({ secretKey: "pk_test_publica" }), /STRIPE_SECRET_KEY/);
  assert.throws(() => new StripePspAdapter({ secretKey: "" }), /STRIPE_SECRET_KEY/);
  assert.equal(new StripePspAdapter({ secretKey: KEY }).mode, "test");
});

test("firma de webhook de Stripe: válida, alterada, vencida y con varias v1", () => {
  const secret = "whsec_unitario";
  const body = '{"id":"evt_1"}';
  const now = Date.UTC(2026, 5, 1, 12);
  const t = Math.floor(now / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  assert.equal(verifyStripeSignature(body, `t=${t},v1=${v1}`, secret, { nowMs: now }), true);
  assert.equal(verifyStripeSignature(body, `t=${t},v1=${"0".repeat(64)},v1=${v1}`, secret, { nowMs: now }), true);
  assert.equal(verifyStripeSignature(`${body} `, `t=${t},v1=${v1}`, secret, { nowMs: now }), false);
  assert.equal(verifyStripeSignature(body, `t=${t},v1=${v1}`, "whsec_otro", { nowMs: now }), false);
  assert.equal(verifyStripeSignature(body, `t=${t},v1=${v1}`, secret, { nowMs: now + 10 * 60_000 }), false);
  assert.equal(verifyStripeSignature(body, `v1=${v1}`, secret, { nowMs: now }), false);
  assert.equal(verifyStripeSignature(body, "", secret, { nowMs: now }), false);
});

test("URL de regreso del checkout: solo el front propio (y localhost fuera de prod)", () => {
  const env = { PUBLIC_BASE_URL: "https://orquesta.app", ALLOWED_RETURN_ORIGINS: "https://staging.orquesta.app", ENVIRONMENT: "lab" };
  const fb = "https://orquesta.app/fallback";
  assert.equal(safeReturnUrl("https://orquesta.app/planner?pago=exito", fb, env), "https://orquesta.app/planner?pago=exito");
  assert.equal(safeReturnUrl("https://staging.orquesta.app/x", fb, env), "https://staging.orquesta.app/x");
  assert.equal(safeReturnUrl("http://localhost:4200/x", fb, env), "http://localhost:4200/x");
  assert.equal(safeReturnUrl("https://evil.example/x", fb, env), fb);
  assert.equal(safeReturnUrl("http://orquesta.app/x", fb, env), fb);
  assert.equal(safeReturnUrl("javascript:alert(1)", fb, env), fb);
  assert.equal(safeReturnUrl(undefined, fb, env), fb);
  assert.equal(safeReturnUrl("http://localhost:4200/x", fb, { ...env, ENVIRONMENT: "prod" }), fb);
});
