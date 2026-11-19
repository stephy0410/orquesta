#!/usr/bin/env node
/**
 * Datos de demostración para el servidor local (`npm run dev`). Usa SOLO el API público, igual que
 * el front, así que también sirve de prueba de humo de punta a punta.
 *
 * Crea:
 *   - Planner demo@orquesta.test / Demo12345!
 *   - "Boda de Ana y Luis" (publicada, en 10 días): 40 invitados, invitaciones enviadas, RSVPs,
 *     mesas con asientos, un DJ contratado con el pago pendiente.
 *   - "Gala Orquesta" (en curso ahora): 30 invitados, check-ins de dos puertas, acceso de staff.
 *   - "Cena de fin de año Grupo Lumbre" (publicada) y "XV años de Regina" (borrador).
 *   - Proveedor dj@orquesta.test / Demo12345! (verificado y publicado).
 *   - 12 proveedores más para el marketplace (meseros, foto, catering, bartender, seguridad…),
 *     verificados, publicados y con disponibilidad los próximos 60 días.
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

/** Catálogo del marketplace: perfiles variados para que la búsqueda tenga resultados reales. */
const PROVEEDORES = [
  { nombre: "Banquetes La Hacienda", tipo: "empresa", plazas: 20, categorias: ["catering", "mesero"], servicios: ["banquete", "mesa_dulces", "servicio_mesa"], tarifa: [1200, "persona_hora"], zonas: ["sur", "coyoacan"], idiomas: ["es"], exp: 12 },
  { nombre: "Lucía Herrera Fotografía", tipo: "persona", categorias: ["fotografo", "video"], servicios: ["fotografia_evento", "cabina_fotos"], tarifa: [14000, "evento"], zonas: ["centro", "roma_condesa", "polanco"], idiomas: ["es", "en"], exp: 8 },
  { nombre: "Meseros Pro CDMX", tipo: "empresa", plazas: 30, categorias: ["mesero"], servicios: ["servicio_mesa", "capitan_meseros", "cocteleria"], tarifa: [280, "persona_hora"], zonas: ["cdmx_centro", "cdmx_sur", "santa_fe"], idiomas: ["es"], exp: 9 },
  { nombre: "Barra Mezcal & Co.", tipo: "empresa", plazas: 6, categorias: ["bartender"], servicios: ["barra_libre"], tarifa: [9500, "evento"], zonas: ["roma_condesa", "polanco", "centro"], idiomas: ["es", "en"], exp: 6 },
  { nombre: "Valeria Glam Studio", tipo: "persona", categorias: ["maquillista"], servicios: ["maquillaje_social", "peinado"], tarifa: [3800, "evento"], zonas: ["polanco", "santa_fe"], idiomas: ["es"], exp: 7 },
  { nombre: "Seguridad Escudo", tipo: "empresa", plazas: 15, categorias: ["seguridad"], servicios: ["control_acceso"], tarifa: [320, "persona_hora"], zonas: ["norte", "centro", "cdmx_norte"], idiomas: ["es"], exp: 15 },
  { nombre: "Decoración Flor de Lis", tipo: "empresa", plazas: 8, categorias: ["decoracion"], servicios: ["decoracion"], tarifa: [18000, "evento"], zonas: ["sur", "coyoacan", "metropolitana"], idiomas: ["es"], exp: 10 },
  { nombre: "Audio Total Iluminación", tipo: "empresa", plazas: 5, categorias: ["iluminacion_sonido", "dj"], servicios: ["iluminacion_sonido", "audio_iluminacion", "mezcla_en_vivo"], tarifa: [12500, "evento"], zonas: ["oriente", "centro", "cdmx_oriente"], idiomas: ["es"], exp: 11 },
  { nombre: "Coordina Eventos Sofía", tipo: "persona", categorias: ["coordinacion"], servicios: ["coordinacion"], tarifa: [650, "hora"], zonas: ["centro", "polanco", "roma_condesa"], idiomas: ["es", "en", "fr"], exp: 5 },
  { nombre: "Animación Chispa", tipo: "empresa", plazas: 4, categorias: ["animacion"], servicios: ["animacion"], tarifa: [7000, "evento"], zonas: ["norte", "poniente"], idiomas: ["es"], exp: 4 },
  { nombre: "Mesa Dulce Mía", tipo: "persona", categorias: ["catering"], servicios: ["mesa_dulces"], tarifa: [5500, "evento"], zonas: ["sur", "coyoacan"], idiomas: ["es"], exp: 3 },
  { nombre: "Cinema Bodas Video", tipo: "persona", categorias: ["video", "fotografo"], servicios: ["fotografia_evento"], tarifa: [16500, "evento"], zonas: ["guadalajara", "metropolitana"], idiomas: ["es", "en"], exp: 9 },
];

/** Registra, verifica, publica y abre 60 días de disponibilidad para un proveedor del catálogo. */
async function proveedor(spec, i) {
  const email = `proveedor${i + 1}@orquesta.test`;
  const h = await account({ email, worker: true });
  const tel = `+52551900${String(1000 + i).slice(-4)}`;
  try {
    await call("POST", "/v1/worker/profile", {
      headers: h,
      body: {
        tipo: spec.tipo,
        plazas_ofrecidas: spec.plazas ?? 1,
        nombre_publico: spec.nombre,
        categorias: spec.categorias,
        servicios: spec.servicios,
        tarifa: { monto: spec.tarifa[0], moneda: "MXN", unidad: spec.tarifa[1] },
        zonas: spec.zonas,
        idiomas: spec.idiomas,
        anios_experiencia: spec.exp,
        telefono_e164: tel,
      },
    });
    const ch = (await call("POST", "/v1/worker/profile/verifications", { headers: h, body: { canal: "telefono" } })).data;
    const otp = await waitMessage("sms", (m) => m.to === tel && m.metadata?.codigo_otp, `OTP de ${spec.nombre}`);
    await call("POST", `/v1/worker/profile/verifications/${ch.desafio_id}/confirm`, { headers: h, body: { codigo_otp: otp.metadata.codigo_otp } });
    await call("POST", "/v1/worker/profile/publish", { headers: h });
  } catch (err) {
    if (!/EMAIL_YA_REGISTRADA|ya posee|ya existe/i.test(String(err.message))) throw err;
  }
  const desde = Date.now() - 2 * 86400_000;
  for (const rol of spec.categorias) {
    await call("POST", "/v1/worker/availability", {
      headers: h,
      body: { inicio: iso(desde), fin: iso(desde + 60 * 86400_000), zona: spec.zonas[0], rol },
    }).catch(() => {});
  }
}
const NOMBRES = ["Ana", "Luis", "Sofía", "Diego", "Valeria", "Mateo", "Camila", "Emiliano", "Regina", "Santiago", "Ximena", "Leonardo", "Renata", "Sebastián", "Daniela", "Andrés", "Fernanda", "Rodrigo", "Mariana", "Pablo", "Lucía", "Jorge", "Paola", "Ricardo", "Isabel", "Héctor", "Carmen", "Javier", "Natalia", "Gerardo", "Elena", "Tomás", "Alejandra", "Arturo", "Mónica", "Bruno", "Gabriela", "Iván", "Teresa", "Óscar"];
const APELLIDOS = ["García", "Hernández", "López", "Martínez", "González", "Pérez", "Ramírez", "Torres", "Flores", "Rivera", "Morales", "Cruz", "Ortiz", "Reyes", "Mendoza", "Castillo", "Vargas", "Romero", "Navarro", "Aguilar"];
const sinAcentos = (t) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
let telefono = 1000000;

/** Lista de invitados con nombres y correos realistas y sin repetir. `desde` desplaza los nombres por evento. */
function csv(n, desde = 0) {
  const rows = ["nombre,email,telefono"];
  const usados = new Set();
  for (let i = 0; i < n; i++) {
    const k = i + desde;
    const nombre = NOMBRES[k % NOMBRES.length];
    const ap1 = APELLIDOS[(k * 7 + Math.floor(k / NOMBRES.length)) % APELLIDOS.length];
    const ap2 = APELLIDOS[(k * 3 + 5) % APELLIDOS.length];
    let email = `${sinAcentos(nombre)}.${sinAcentos(ap1)}${sinAcentos(ap2)[0]}@correo.test`;
    for (let m = 2; usados.has(email); m++) email = email.replace(/(\d*)@/, `${m}@`);
    usados.add(email);
    const tel = i % 3 === 0 ? `+52553${String(telefono++).slice(-7)}` : "";
    rows.push(`${nombre} ${ap1} ${ap2},${email},${tel}`);
  }
  return rows.join("\n");
}

/** Envía las invitaciones de un evento y responde con los enlaces que "llegaron" por correo. */
async function invitarYResponder(planner, eventId, lista, { confirman = 0, declinan = 0 }) {
  const total = lista.split("\n").length - 1;
  await call("POST", `/v1/events/${eventId}/invitations/send`, { headers: planner, body: { alcance: "pendiente_envio", destinatarios_confirmados: total } });
  await wait(1500);
  const invitaciones = (await messages()).emails.filter((m) => m.metadata?.rsvp_url && lista.includes(`,${m.to},`));
  const tokens = [...new Map(invitaciones.map((m) => [m.to, new URL(m.metadata.rsvp_url.replace("#", "?")).searchParams.get("t")])).values()];
  for (const [i, token] of tokens.entries()) {
    if (i < confirman) await call("POST", `/v1/public/invitations/${token}/rsvp`, { body: { respuesta: "confirma" } });
    else if (i < confirman + declinan) await call("POST", `/v1/public/invitations/${token}/rsvp`, { body: { respuesta: "declina" } });
  }
  return invitaciones;
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

  // --- Marketplace: proveedores variados ---------------------------------------------
  for (const [i, spec] of PROVEEDORES.entries()) await proveedor(spec, i);

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
  const listaBoda = csv(40);
  await importGuests(planner, boda.id, listaBoda);
  const invitacionesBoda = await invitarYResponder(planner, boda.id, listaBoda, { confirman: 28, declinan: 5 });
  const linkInvitado = invitacionesBoda.at(-1)?.metadata.rsvp_url;

  // Mesas: 4 mesas de 8 y 20 invitados confirmados sentados (con If-Match).
  const guests = (await call("GET", `/v1/events/${boda.id}/guests?limit=100`, { headers: planner })).data.items;
  let version = (await call("GET", `/v1/events/${boda.id}/tables`, { headers: planner })).data.plan_version;
  const mesas = [];
  for (const nombre of ["Novios", "Familia Ana", "Familia Luis", "Amigos"]) {
    const t = (await call("POST", `/v1/events/${boda.id}/tables`, { headers: { ...planner, "if-match": `"${version}"` }, body: { nombre, capacidad: 8 } })).data;
    version = t.plan_version;
    mesas.push(t);
  }
  const confirmados = guests.filter((g) => g.estado_rsvp === "confirma").slice(0, 20);
  for (const [i, g] of confirmados.entries()) {
    const r = await call("POST", `/v1/events/${boda.id}/seat-assignments`, {
      headers: { ...planner, "if-match": `"${version}"` },
      body: { guest_id: g.id, table_id: mesas[Math.floor(i / 5)].id },
    }).catch(() => null);
    if (r) version = r.data.plan_version;
  }

  // Contratación: DJ solicitado y aceptado; el pago queda pendiente para mostrarlo en la demo.
  const solicitud = (await call("POST", `/v1/events/${boda.id}/worker-requests`, {
    headers: planner,
    body: { worker_id: djProfile.worker_id, rol: "dj", plazas: 1, ventana: { inicio: iso(bodaInicio), fin: iso(bodaFin) }, hora_llegada: iso(bodaInicio) },
  })).data;
  await call("POST", `/v1/worker/requests/${solicitud.id}/accept`, { headers: dj, body: {} });

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
  const listaGala = csv(30, 13);
  await importGuests(planner, gala.id, listaGala);
  await invitarYResponder(planner, gala.id, listaGala, { confirman: 24, declinan: 3 });
  await call("POST", `/v1/events/${gala.id}/start`, { headers: planner });
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

  // --- Evento 3: cena corporativa publicada, invitaciones recién enviadas -------------------
  const cenaInicio = new Date(Date.now() + 24 * 86400_000);
  cenaInicio.setUTCHours(2, 0, 0, 0); // 20:00 CDMX
  const cena = (await call("POST", "/v1/events", {
    headers: planner,
    body: {
      nombre: "Cena de fin de año Grupo Lumbre",
      fecha: iso(cenaInicio).slice(0, 10),
      timezone: "America/Mexico_City",
      ventana: { inicio: iso(cenaInicio), fin: iso(cenaInicio.getTime() + 5 * 3600_000) },
      venue_id: venue.id,
      aforo: 80,
      requerimientos: [{ rol: "mesero", cantidad: 4 }, { rol: "bartender", cantidad: 2 }],
    },
  })).data;
  await call("POST", `/v1/events/${cena.id}/publish`, { headers: planner });
  const listaCena = csv(50, 21);
  await importGuests(planner, cena.id, listaCena);
  await invitarYResponder(planner, cena.id, listaCena, { confirman: 12, declinan: 2 });

  // --- Evento 4: XV años en borrador, con la lista subida pero sin enviar ------------------
  const xvInicio = new Date(Date.now() + 45 * 86400_000);
  xvInicio.setUTCHours(1, 0, 0, 0);
  const xv = (await call("POST", "/v1/events", {
    headers: planner,
    body: {
      nombre: "XV años de Regina",
      fecha: iso(xvInicio).slice(0, 10),
      timezone: "America/Mexico_City",
      ventana: { inicio: iso(xvInicio), fin: iso(xvInicio.getTime() + 6 * 3600_000) },
      venue_id: venue.id,
      aforo: 150,
      requerimientos: [{ rol: "fotografo", cantidad: 1 }, { rol: "dj", cantidad: 1 }],
    },
  })).data;
  await importGuests(planner, xv.id, csv(18, 7));

  console.log(`
✅ Datos de demostración listos. Abre ${FRONT}

  Planner      demo@orquesta.test / ${PASSWORD}
               Eventos: "Gala Orquesta" (en curso, 18 de 24 confirmados ya llegaron por 2 puertas)
                        "Boda de Ana y Luis" (40 invitados, 28 confirmados, mesas, DJ con pago pendiente)
                        "Cena de fin de año Grupo Lumbre" (50 invitados, invitaciones enviadas)
                        "XV años de Regina" (borrador, lista subida sin enviar)
  Proveedor    dj@orquesta.test / ${PASSWORD}  (y ${PROVEEDORES.length} más en el marketplace: proveedor1..${PROVEEDORES.length}@orquesta.test)
  Invitado     ${linkInvitado ? linkInvitado.replace(/^https?:\/\/[^/]+/, FRONT) : "(ver consola del backend)"}
  Escáner      ${FRONT}/scan  →  código de acceso: ${acceso.qr_token}
`);
}

main().catch((err) => {
  console.error("\n❌", err.message);
  process.exitCode = 1;
});
