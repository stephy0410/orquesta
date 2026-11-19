#!/usr/bin/env node
/**
 * Datos de demostración para el servidor local (`npm run dev`). Usa SOLO el API público, igual que
 * el front, así que también sirve de prueba de humo de punta a punta.
 *
 * Crea:
 *   - Planner demo@orquesta.test / Demo12345!
 *   - "Boda de Ana y Luis" (publicada, en 10 días): 40 invitados, invitaciones enviadas, RSVPs,
 *     mesas con asientos, un DJ contratado y pagado.
 *   - "Gala Orquesta" (en curso ahora): 30 invitados, check-ins de dos puertas, acceso de staff.
 *   - Proveedor dj@orquesta.test / Demo12345! (verificado y publicado).
 *
 * Uso: npm run dev (otra terminal)  →  npm run seed        [API_URL=http://localhost:3001]
 */
import { randomUUID } from "node:crypto";
import { batchChecksum } from "../load/lib.js";

const API = (process.env.API_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, "");
const FRONT = process.env.FRONT_ORIGIN || "http://localhost:4200";
const PASSWORD = "Demo12345!";

async function call(method, path, { body, headers = {}, raw, contentType } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(contentType ? { "content-type": contentType } : {}),
      "idempotency-key": randomUUID(),
      ...headers,
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return { status: res.status, data, headers: res.headers };
}

const messages = async () => (await call("GET", "/__dev/messages")).data;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Espera a que el worker del servidor local "envíe" un mensaje que cumpla `pred`. */
async function waitMessage(kind, pred, what) {
  for (let i = 0; i < 40; i++) {
    const found = [...(await messages())[kind]].reverse().find(pred);
    if (found) return found;
    await wait(250);
  }
  throw new Error(`No llegó: ${what}`);
}

async function account({ email, worker = false }) {
  try {
    await call("POST", worker ? "/v1/auth/worker/register" : "/v1/auth/register", {
      body: { email, password: PASSWORD, ...(worker ? { tipo: "persona" } : {}) },
    });
    const msg = await waitMessage("emails", (m) => m.to === email && m.metadata?.token, `verificación de ${email}`);
    await call("POST", "/v1/auth/verify-email", { body: { token: msg.metadata.token } });
  } catch (err) {
    if (!/EMAIL_YA_REGISTRADA/.test(String(err.message))) throw err;
  }
  const login = await call("POST", "/v1/auth/login", { body: { email, password: PASSWORD } });
  return { authorization: `Bearer ${login.data.access_token}` };
}

const iso = (d) => new Date(d).toISOString();
const NOMBRES = ["Ana", "Luis", "Sofía", "Diego", "Valeria", "Mateo", "Camila", "Emiliano", "Regina", "Santiago", "Ximena", "Leonardo", "Renata", "Sebastián", "Daniela", "Andrés", "Fernanda", "Rodrigo", "Mariana", "Pablo"];
const APELLIDOS = ["García", "Hernández", "López", "Martínez", "González", "Pérez", "Ramírez", "Torres", "Flores", "Rivera"];

function csv(n, tag) {
  const rows = ["nombre,email,telefono"];
  for (let i = 0; i < n; i++) {
    const nombre = `${NOMBRES[i % NOMBRES.length]} ${APELLIDOS[(i * 7) % APELLIDOS.length]}`;
    const tel = i % 3 === 0 ? `+52551${String(1000000 + i + (tag === "gala" ? 500 : 0)).slice(-7)}` : "";
    rows.push(`${nombre},${tag}-${i}@invitados.test,${tel}`);
  }
  return rows.join("\n");
}

async function importGuests(planner, eventId, text) {
  const boundary = "----OrquestaSeed" + randomUUID();
  const raw = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="invitados.csv"\r\nContent-Type: text/csv\r\n\r\n${text}\r\n--${boundary}--\r\n`;
  const imp = await call("POST", `/v1/events/${eventId}/guests/import`, {
    headers: planner,
    raw,
    contentType: `multipart/form-data; boundary=${boundary}`,
  });
  for (let i = 0; i < 60; i++) {
    const st = await call("GET", `/v1/events/${eventId}/guests/imports/${imp.data.import_id}`, { headers: planner });
    if (st.data.estado === "completado") return st.data;
    await wait(500);
  }
  throw new Error("import no terminó");
}

async function main() {
  await call("GET", "/health");
  console.log(`Sembrando datos en ${API} ...`);
  const planner = await account({ email: "demo@orquesta.test" });
  const venue = (await call("POST", "/v1/venues", { headers: planner, body: { nombre: "Hacienda Los Olivos", zona: "sur", direccion: "Camino Real 120, CDMX" } })).data;

  // --- Proveedor (DJ) verificado y publicado -------------------------------------------
  const dj = await account({ email: "dj@orquesta.test", worker: true });
  const djPhone = "+525512345678";
  let djProfile;
  try {
    djProfile = (await call("POST", "/v1/worker/profile", {
      headers: dj,
      body: { tipo: "persona", nombre_publico: "DJ Marco Sonidos", categorias: ["dj"], tarifa: { monto: 8500, moneda: "MXN", unidad: "evento" }, zonas: ["sur", "centro"], telefono_e164: djPhone, idiomas: ["es", "en"] },
    })).data;
    const ch = (await call("POST", "/v1/worker/profile/verifications", { headers: dj, body: { canal: "telefono" } })).data;
    const otp = await waitMessage("sms", (m) => m.to === djPhone && m.metadata?.codigo_otp, "OTP del DJ");
    await call("POST", `/v1/worker/profile/verifications/${ch.desafio_id}/confirm`, { headers: dj, body: { codigo_otp: otp.metadata.codigo_otp } });
    await call("POST", "/v1/worker/profile/publish", { headers: dj });
  } catch (err) {
    if (!/EMAIL_YA_REGISTRADA|ya posee/.test(String(err.message))) throw err;
    djProfile = (await call("GET", "/v1/worker/profile", { headers: dj })).data.perfil;
  }

  // --- Evento 1: boda en 10 días -------------------------------------------------------
  const bodaInicio = new Date(Date.now() + 10 * 86400_000);
  bodaInicio.setUTCHours(1, 0, 0, 0); // 19:00 CDMX
  const bodaFin = new Date(bodaInicio.getTime() + 7 * 3600_000);
  await call("POST", "/v1/worker/availability", {
    headers: dj,
    body: { inicio: iso(bodaInicio.getTime() - 3 * 3600_000), fin: iso(bodaFin.getTime() + 3600_000), zona: "sur", rol: "dj" },
  }).catch(() => {});
  const boda = (await call("POST", "/v1/events", {
    headers: planner,
    body: {
      nombre: "Boda de Ana y Luis",
      fecha: iso(bodaInicio).slice(0, 10),
      timezone: "America/Mexico_City",
      ventana: { inicio: iso(bodaInicio), fin: iso(bodaFin) },
      venue_id: venue.id,
      aforo: 120,
      requerimientos: [{ rol: "dj", cantidad: 1 }, { rol: "mesero", cantidad: 6 }],
    },
  })).data;
  await call("POST", `/v1/events/${boda.id}/publish`, { headers: planner });
  await importGuests(planner, boda.id, csv(40, "boda"));
  await call("POST", `/v1/events/${boda.id}/invitations/send`, { headers: planner, body: { alcance: "pendiente_envio", destinatarios_confirmados: 40 } });
  await wait(1500);

  // RSVPs: 25 confirman, 5 declinan (usando el link que "llegó" por correo).
  const invitaciones = (await messages()).emails.filter((m) => m.metadata?.rsvp_url && /^boda-/.test(m.to));
  const tokens = [...new Map(invitaciones.map((m) => [m.to, new URL(m.metadata.rsvp_url.replace("#", "?")).searchParams.get("t")])).entries()];
  for (const [i, [, token]] of tokens.entries()) {
    if (i < 25) await call("POST", `/v1/public/invitations/${token}/rsvp`, { body: { respuesta: "confirma" } });
    else if (i < 30) await call("POST", `/v1/public/invitations/${token}/rsvp`, { body: { respuesta: "declina" } });
  }
  const linkInvitado = invitaciones.find((m) => m.to === "boda-35@invitados.test")?.metadata.rsvp_url;

  // Mesas: 4 mesas de 8 y 20 invitados confirmados sentados (con If-Match).
  const guests = (await call("GET", `/v1/events/${boda.id}/guests?limit=100`, { headers: planner })).data.items;
  let version = (await call("GET", `/v1/events/${boda.id}/tables`, { headers: planner })).data.plan_version;
  const mesas = [];
  for (const nombre of ["Novios", "Familia Ana", "Familia Luis", "Amigos"]) {
    const t = (await call("POST", `/v1/events/${boda.id}/tables`, { headers: { ...planner, "if-match": `"${version}"` }, body: { nombre, capacidad: 8 } })).data;
    version = t.plan_version;
    mesas.push(t);
  }
  const confirmados = guests.slice(0, 20);
  for (const [i, g] of confirmados.entries()) {
    const r = await call("POST", `/v1/events/${boda.id}/seat-assignments`, {
      headers: { ...planner, "if-match": `"${version}"` },
      body: { guest_id: g.id, table_id: mesas[Math.floor(i / 5)].id },
    }).catch(() => null);
    if (r) version = r.data.plan_version;
  }

  // Contratación: DJ solicitado, aceptado y pagado.
  const solicitud = (await call("POST", `/v1/events/${boda.id}/worker-requests`, {
    headers: planner,
    body: { worker_id: djProfile.worker_id, rol: "dj", plazas: 1, ventana: { inicio: iso(bodaInicio), fin: iso(bodaFin) }, hora_llegada: iso(bodaInicio) },
  })).data;
  await call("POST", `/v1/worker/requests/${solicitud.id}/accept`, { headers: dj, body: {} });
  await call("POST", `/v1/reservations/${solicitud.id}/payments`, { headers: planner, body: {} });

  // --- Evento 2: gala en curso con check-ins -------------------------------------------
  const galaInicio = new Date(Date.now() - 60 * 60_000);
  const galaFin = new Date(Date.now() + 5 * 3600_000);
  const gala = (await call("POST", "/v1/events", {
    headers: planner,
    body: {
      nombre: "Gala Orquesta",
      fecha: iso(galaInicio).slice(0, 10),
      timezone: "America/Mexico_City",
      ventana: { inicio: iso(galaInicio), fin: iso(galaFin) },
      venue_id: venue.id,
      aforo: 60,
    },
  })).data;
  await call("POST", `/v1/events/${gala.id}/publish`, { headers: planner });
  await call("POST", `/v1/events/${gala.id}/start`, { headers: planner });
  await importGuests(planner, gala.id, csv(30, "gala"));
  const acceso = (await call("POST", `/v1/events/${gala.id}/access-tokens`, { headers: planner, body: { rol: "staff" } })).data;

  for (const [d, n] of [["puerta-norte", 11], ["puerta-sur", 7]]) {
    const ses = (await call("POST", "/v1/auth/event-session", { body: { access_token: acceso.qr_token, device_id: d } })).data;
    const h = { authorization: `Bearer ${ses.session_token}` };
    const roster = (await call("GET", `/v1/scan-sessions/${ses.session_id}/roster`, { headers: h })).data.invitados;
    const start = d === "puerta-norte" ? 0 : 11;
    const events = roster.slice(start, start + n).map((r, i) => ({
      sequence: i + 1,
      invitation_id: r.invitation_id,
      scanned_at: new Date(Date.now() - (n - i) * 60_000).toISOString(),
      verdict_local: "admitido",
      modo: "camara",
    }));
    await call("POST", `/v1/scan-sessions/${ses.session_id}/batches`, {
      headers: h,
      body: { batch_id: randomUUID(), device_id: d, event_id: gala.id, seq_desde: 1, seq_hasta: n, checksum: { alg: "sha256", valor: batchChecksum(events) }, cola_reportada: 0, events },
    });
  }
  await wait(1500);

  console.log(`
✅ Datos de demostración listos. Abre ${FRONT}

  Planner      demo@orquesta.test / ${PASSWORD}
               Eventos: "Boda de Ana y Luis" (40 invitados, 25 confirmados, mesas, DJ pagado)
                        "Gala Orquesta" (en curso, 18 asistentes por 2 puertas)
  Proveedor    dj@orquesta.test / ${PASSWORD}
  Invitado     ${linkInvitado ? linkInvitado.replace(/^https?:\/\/[^/]+/, FRONT) : "(ver consola del backend)"}
  Escáner      ${FRONT}/scan  →  código de acceso: ${acceso.qr_token}
`);
}

main().catch((err) => {
  console.error("\n❌", err.message);
  process.exitCode = 1;
});
