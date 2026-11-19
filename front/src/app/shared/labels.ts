/**
 * Textos para personas de los valores internos que devuelve la API (estados, canales, roles).
 * Si llega un valor nuevo que no está aquí, se muestra sin guiones bajos para no exponer el código.
 */
const LABELS: Record<string, string> = {
  // Evento
  borrador: 'Borrador',
  publicado: 'Publicado',
  en_curso: 'En curso',
  cerrado: 'Cerrado',
  cancelado: 'Cancelado',
  suspendido: 'Pausado',
  // Envío de invitaciones
  pendiente_envio: 'Por enviar',
  enviado: 'Enviada',
  encolado: 'En cola',
  entregado: 'Entregada',
  rebotado: 'No llegó',
  indeterminado: 'Sin confirmar',
  fallido: 'Falló',
  parcial: 'Llegó por un canal',
  // RSVP
  confirma: 'Confirmó',
  declina: 'Declinó',
  pendiente: 'Sin respuesta',
  // Importación
  en_cola: 'En cola',
  procesando: 'Procesando',
  completado: 'Terminado',
  completado_con_errores: 'Terminado con errores',
  // Canales
  sms: 'SMS',
  email: 'Correo',
  ambos: 'SMS y correo',
  // Reservas y pagos
  solicitada: 'Solicitada',
  aceptada: 'Aceptada',
  rechazada: 'Rechazada',
  cancelada: 'Cancelada',
  expirada: 'Venció',
  completada: 'Completada',
  cancelada_pagada: 'Cancelada con pago',
  sin_cubrir: 'Sin cubrir',
  desconocido: 'Sin confirmar',
  pagada: 'Pagada',
  pago_pendiente: 'Pago pendiente',
  autorizado: 'Autorizado',
  capturado: 'Cobrado',
  reembolsado: 'Reembolsado',
  // Entradas
  admitido: 'Entró',
  anulacion: 'Anulada',
  duplicado_tardio: 'Repetida (tardía)',
  ya_registrado: 'Ya entró',
  no_corresponde_al_evento: 'Otro evento',
  invitacion_revocada: 'Cancelada',
  no_verificable_offline: 'Por revisar',
  no_en_roster: 'No estaba en la lista',
  vigente: 'Válida',
  revocada: 'Cancelada',
  aceptado: 'Aceptada',
  duplicado: 'Repetida',
  tardio: 'Tardía',
  // Puestos y categorías
  staff: 'Staff',
  hostess: 'Hostess',
  scanner: 'Staff de escaneo',
  capitan_meseros: 'Capitán de meseros',
  mesero: 'Mesero',
  maquillista: 'Maquillaje',
  fotografo: 'Fotografía',
  dj: 'DJ',
  catering: 'Catering',
  bartender: 'Bartender',
  seguridad: 'Seguridad',
  coordinacion: 'Coordinación',
  decoracion: 'Decoración',
  animacion: 'Animación',
  iluminacion_sonido: 'Iluminación y sonido',
  video: 'Video',
  servicio_mesa: 'Servicio de mesa',
  cocteleria: 'Coctelería',
  maquillaje_social: 'Maquillaje social',
  peinado: 'Peinado',
  fotografia_evento: 'Fotografía de evento',
  cabina_fotos: 'Cabina de fotos',
  mezcla_en_vivo: 'Mezcla en vivo',
  audio_iluminacion: 'Audio e iluminación',
  banquete: 'Banquete',
  mesa_dulces: 'Mesa de dulces',
  barra_libre: 'Barra libre',
  control_acceso: 'Control de acceso',
  // Zonas
  norte: 'Norte',
  sur: 'Sur',
  centro: 'Centro',
  oriente: 'Oriente',
  poniente: 'Poniente',
  cdmx_norte: 'CDMX Norte',
  cdmx_sur: 'CDMX Sur',
  cdmx_centro: 'CDMX Centro',
  cdmx_oriente: 'CDMX Oriente',
  cdmx_poniente: 'CDMX Poniente',
  polanco: 'Polanco',
  roma_condesa: 'Roma-Condesa',
  santa_fe: 'Santa Fe',
  coyoacan: 'Coyoacán',
  metropolitana: 'Zona metropolitana',
  guadalajara: 'Guadalajara',
  monterrey: 'Monterrey',
  // Idiomas
  es: 'Español',
  en: 'Inglés',
  fr: 'Francés',
  pt: 'Portugués',
  de: 'Alemán',
  it: 'Italiano',
  // Zonas horarias
  'America/Mexico_City': 'Ciudad de México',
  'America/Cancun': 'Cancún',
  'America/Monterrey': 'Monterrey',
  'America/Tijuana': 'Tijuana',
  'America/Bogota': 'Bogotá',
  'America/Lima': 'Lima',
  'America/Santiago': 'Santiago de Chile',
  'America/Argentina/Buenos_Aires': 'Buenos Aires',
  'America/New_York': 'Nueva York',
  'America/Los_Angeles': 'Los Ángeles',
  'Europe/Madrid': 'Madrid',
  UTC: 'UTC',
  // Tarifas
  hora: 'por hora',
  evento: 'por evento',
  jornada: 'por jornada',
};

export function humanize(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  return LABELS[value] ?? value.replace(/_/g, ' ');
}

/** Lista legible: ['dj', 'video'] → "DJ, Video". */
export function humanizeList(values: readonly string[] | null | undefined): string {
  return (values ?? []).map((v) => humanize(v)).join(', ');
}

/** Fecha y hora legibles ("18 nov 2026, 19:00"); deja pasar textos que no son fecha. */
export function formatFecha(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
}

const UNIDADES: Record<string, string> = {
  hora: 'por hora',
  persona_hora: 'por persona y hora',
  evento: 'por evento',
  jornada: 'por jornada',
};

/** "$1,200 MXN por hora" a partir de una tarifa de la API. */
export function precio(
  t: { monto: number; moneda: string; unidad?: string } | null | undefined,
): string {
  if (!t) return 'Sin tarifa';
  const monto = new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: t.moneda || 'MXN',
    maximumFractionDigits: 0,
  }).format(t.monto);
  const unidad = t.unidad ? ` ${UNIDADES[t.unidad] ?? t.unidad.replace(/_/g, ' ')}` : '';
  return `${monto} ${t.moneda}${unidad}`;
}
