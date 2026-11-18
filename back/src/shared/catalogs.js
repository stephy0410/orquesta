// Catálogos cerrados de Orquesta (02a, 02c, RF-07, RF-21, RF-22)

export const ZONAS_CATALOGO = Object.freeze({
  norte: { nombre: "Zona Norte", lat: 19.489, lng: -99.133 },
  sur: { nombre: "Zona Sur", lat: 19.315, lng: -99.18 },
  centro: { nombre: "Zona Centro", lat: 19.432608, lng: -99.133209 },
  oriente: { nombre: "Zona Oriente", lat: 19.4, lng: -99.07 },
  poniente: { nombre: "Zona Poniente", lat: 19.39, lng: -99.25 },
  cdmx_norte: { nombre: "CDMX Norte", lat: 19.49, lng: -99.135 },
  cdmx_sur: { nombre: "CDMX Sur", lat: 19.31, lng: -99.175 },
  cdmx_centro: { nombre: "CDMX Centro", lat: 19.432608, lng: -99.133209 },
  cdmx_oriente: { nombre: "CDMX Oriente", lat: 19.402, lng: -99.072 },
  cdmx_poniente: { nombre: "CDMX Poniente", lat: 19.388, lng: -99.255 },
  polanco: { nombre: "Polanco", lat: 19.4335, lng: -99.195 },
  roma_condesa: { nombre: "Roma / Condesa", lat: 19.414, lng: -99.168 },
  santa_fe: { nombre: "Santa Fe", lat: 19.361, lng: -99.275 },
  coyoacan: { nombre: "Coyoacán", lat: 19.3467, lng: -99.1617 },
  metropolitana: { nombre: "Área Metropolitana", lat: 19.42, lng: -99.15 },
  guadalajara: { nombre: "Guadalajara", lat: 20.659699, lng: -103.349609 },
  monterrey: { nombre: "Monterrey", lat: 25.686614, lng: -100.316113 },
});

export const CATEGORIAS_CATALOGO = new Set([
  "mesero",
  "maquillista",
  "fotografo",
  "dj",
  "catering",
  "bartender",
  "seguridad",
  "coordinacion",
  "decoracion",
  "animacion",
  "iluminacion_sonido",
  "video",
]);

export const SERVICIOS_POR_CATEGORIA = Object.freeze({
  mesero: new Set(["mesero", "servicio_mesa", "capitan_meseros", "cocteleria"]),
  maquillista: new Set(["maquillista", "maquillaje_social", "peinado"]),
  fotografo: new Set(["fotografo", "fotografia_evento", "cabina_fotos"]),
  dj: new Set(["dj", "mezcla_en_vivo", "audio_iluminacion"]),
  catering: new Set(["catering", "banquete", "mesa_dulces"]),
  bartender: new Set(["bartender", "barra_libre"]),
  seguridad: new Set(["seguridad", "control_acceso"]),
  coordinacion: new Set(["coordinacion"]),
  decoracion: new Set(["decoracion"]),
  animacion: new Set(["animacion"]),
  iluminacion_sonido: new Set(["iluminacion_sonido"]),
  video: new Set(["video"]),
});

export const ROLES_CATALOGO = new Set([
  ...CATEGORIAS_CATALOGO,
  "staff",
  "hostess",
  "scanner",
  "capitan_meseros",
]);

export function isValidZona(zona) {
  return typeof zona === "string" && Object.prototype.hasOwnProperty.call(ZONAS_CATALOGO, zona);
}

export function isValidCategoria(cat) {
  return typeof cat === "string" && CATEGORIAS_CATALOGO.has(cat);
}

export function isValidRol(rol) {
  return typeof rol === "string" && ROLES_CATALOGO.has(rol);
}

export function isServicioAllowedForCategorias(servicio, categorias) {
  if (typeof servicio !== "string") return false;
  if (categorias.includes(servicio)) return true;
  return categorias.some((cat) => SERVICIOS_POR_CATEGORIA[cat]?.has(servicio));
}

export function isValidIanaTimezone(tz) {
  if (typeof tz !== "string" || tz.trim().length === 0) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function haversineKm(zonaA, zonaB) {
  const a = ZONAS_CATALOGO[zonaA];
  const b = ZONAS_CATALOGO[zonaB];
  if (!a || !b) return Number.POSITIVE_INFINITY;
  if (zonaA === zonaB) return 0;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
