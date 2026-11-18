export type UserRole = 'planner' | 'worker';
export type MembershipRol = 'owner' | 'editor';
export type EventEstado = 'borrador' | 'publicado' | 'en_curso' | 'cerrado' | 'cancelado';
export type StaffPermiso = 'roster' | 'checkin' | 'anulacion';

export type WorkerTipo = 'persona' | 'empresa';
export type WorkerProfileEstado = 'borrador' | 'publicado' | 'suspendido';
export type TarifaUnidad = 'hora' | 'persona_hora' | 'evento';

export type ReservationEstado =
  | 'solicitada'
  | 'aceptada'
  | 'rechazada'
  | 'expirada'
  | 'cancelada'
  | 'cancelada_pagada'
  | 'sin_cubrir'
  | 'completada';

export type RsvpRespuesta = 'confirma' | 'declina';
export type CanalEntrega = 'sms' | 'email';
export type EstadoEntrega = 'encolado' | 'entregado' | 'rebotado' | 'indeterminado';

export type CheckinVerdict =
  | 'admitido'
  | 'ya_registrado'
  | 'no_corresponde_al_evento'
  | 'invitacion_revocada'
  | 'no_verificable_offline'
  | 'no_en_roster';

export type CheckinKind = 'admitido' | 'anulacion' | 'duplicado_tardio';
export type ScanModo = 'camara' | 'codigo_corto' | 'manual';

export const WORKER_CATEGORIES = [
  'mesero',
  'maquillista',
  'fotografo',
  'dj',
  'catering',
  'bartender',
  'seguridad',
  'coordinacion',
  'decoracion',
  'animacion',
  'iluminacion_sonido',
  'video',
] as const;

export type WorkerCategory = (typeof WORKER_CATEGORIES)[number];

export const ROLES_CATALOGO = [
  'staff',
  'hostess',
  'scanner',
  'capitan_meseros',
  ...WORKER_CATEGORIES,
] as const;

export const SERVICES_BY_CATEGORY: Record<string, readonly string[]> = {
  mesero: ['mesero', 'servicio_mesa', 'capitan_meseros', 'cocteleria'],
  maquillista: ['maquillista', 'maquillaje_social', 'peinado'],
  fotografo: ['fotografo', 'fotografia_evento', 'cabina_fotos'],
  dj: ['dj', 'mezcla_en_vivo', 'audio_iluminacion'],
  catering: ['catering', 'banquete', 'mesa_dulces'],
  bartender: ['bartender', 'barra_libre'],
  seguridad: ['seguridad', 'control_acceso'],
  coordinacion: ['coordinacion'],
  decoracion: ['decoracion'],
  animacion: ['animacion'],
  iluminacion_sonido: ['iluminacion_sonido'],
  video: ['video'],
};

export const WORKER_ZONES = [
  'norte',
  'sur',
  'centro',
  'oriente',
  'poniente',
  'cdmx_norte',
  'cdmx_sur',
  'cdmx_centro',
  'cdmx_oriente',
  'cdmx_poniente',
  'polanco',
  'roma_condesa',
  'santa_fe',
  'coyoacan',
  'metropolitana',
  'guadalajara',
  'monterrey',
] as const;

export type WorkerZone = (typeof WORKER_ZONES)[number];

export const COMMON_TIMEZONES = [
  'America/Mexico_City',
  'America/Cancun',
  'America/Monterrey',
  'America/Tijuana',
  'America/Bogota',
  'America/Lima',
  'America/Santiago',
  'America/Argentina/Buenos_Aires',
  'America/New_York',
  'America/Los_Angeles',
  'Europe/Madrid',
  'UTC',
] as const;

export const COMMON_LANGUAGES = ['es', 'en', 'fr', 'pt', 'de', 'it'] as const;

export interface PaginatedResponse<T> {
  items: T[];
  next_cursor: string | null;
}

export interface VenueDto {
  id: string;
  nombre: string;
  zona: string;
  direccion: string;
  created_at?: string;
}

export interface EventVentana {
  inicio: string;
  fin: string;
}

export interface EventRequirementDto {
  rol: string;
  cantidad: number;
  cubiertos?: number;
  pendientes?: number;
  sin_cubrir?: boolean;
}

export interface EventDto {
  id: string;
  nombre: string;
  fecha: string;
  timezone: string;
  ventana: EventVentana;
  venue_id: string;
  venue?: VenueDto;
  aforo: number;
  estado: EventEstado;
  cerrado_en?: string | null;
  corte?: Record<string, unknown> | null;
  membership?: { user_id: string; rol: MembershipRol };
  requerimientos?: EventRequirementDto[];
  created_at?: string;
}

export interface EventMemberDto {
  membership_id?: string;
  user_id: string;
  email: string;
  rol: MembershipRol;
  created_at?: string;
}

export interface StaffAssignmentDto {
  staff_assignment_id: string;
  event_id: string;
  user_id: string;
  permisos: StaffPermiso[];
  expira_en: string;
}

export interface EventAccessTokenDto {
  access_token_id: string;
  event_id: string;
  rol: string;
  qr_token: string;
  expira_en: string;
}

export interface DashboardDeviceState {
  device_id: string;
  cola_reportada: number;
  ultima_seq_ackeada: number;
  seq_confirmada: number;
  heartbeat_en: string;
}

export interface DashboardEventItem {
  event_id: string;
  nombre: string;
  estado: EventEstado;
  contadores: {
    invitados: number;
    confirmados: number;
    asistentes: number;
    aun_no_llegaron: number;
    pendientes_sincronizar: number;
    entregas_parciales: number;
  };
  no_show: number | null;
  pendientes: {
    valor: number | null;
    estado: 'conocido' | 'desconocido';
    dispositivos?: DashboardDeviceState[];
  };
  frescura: {
    t_ingest: string | null;
    t_visible: string;
    lag_ms: number | null;
    lag_p95_ms: number | null;
  };
}

export interface DashboardResponse {
  generado_en: string;
  items: DashboardEventItem[];
  next_cursor: string | null;
}

export interface GuestDto {
  id?: string;
  guest_id?: string;
  nombre: string;
  email?: string | null;
  telefono?: string | null;
  estado_envio?: string;
  estado_rsvp?: RsvpRespuesta | 'pendiente' | null;
  codigo_corto?: string;
  mesa?: string | number | null;
  table_id?: string | null;
  deleted_at?: string | null;
}

export interface ImportErrorRow {
  linea: number;
  motivo: string;
}

export interface GuestImportJobDto {
  import_id: string;
  estado: 'en_proceso' | 'completado' | 'fallido' | string;
  progreso: number;
  total_filas: number;
  aceptadas: number;
  rechazadas: number;
  duplicadas_en_archivo: number;
  errores: ImportErrorRow[];
  aforo?: { limite: number; ocupado: number };
}

export interface PendingSummaryResponse {
  destinatarios: number;
  por_canal: {
    sms: number;
    email: number;
  };
  pendiente_envio: number;
}

export interface SendInvitationsResponse {
  envio_id: string;
  destinatarios?: number;
  entregas_encoladas: number;
  canales?: CanalEntrega[];
}

export interface DeliveryDto {
  guest_id: string;
  canal: CanalEntrega;
  estado: EstadoEntrega;
  intentos: number;
  ventana?: string;
  estado_en?: string;
}

export interface TableDto {
  id: string;
  nombre?: string;
  numero?: number;
  capacidad: number;
  ocupacion: number;
}

export interface UnseatedGuestDto {
  guest_id: string;
  nombre?: string;
  estado_rsvp: RsvpRespuesta | 'pendiente' | string;
}

export interface SeatAssignmentResponse {
  guest_id: string;
  table_id: string;
  estado: 'asignado' | 'confirmado' | 'pendiente' | 'liberado';
}

export interface TarifaDto {
  modo: 'fijo';
  monto: number;
  moneda: string;
  unidad: TarifaUnidad;
}

export interface PublicWorkerDto {
  worker_id: string;
  nombre_publico: string;
  tipo?: WorkerTipo;
  plazas_ofrecidas?: number;
  categorias: string[];
  servicios?: string[];
  tarifa: TarifaDto;
  zonas: string[];
  radio_km?: number | null;
  idiomas: string[];
  años_experiencia?: number | null;
  anios_experiencia?: number | null;
  eventos_completados: number;
}

export interface WorkerAvailabilityOccupiedResponse {
  worker_id: string;
  ventana_ocupada: EventVentana[];
}

export interface WorkerProfileDto {
  worker_id?: string;
  id?: string;
  tipo: WorkerTipo;
  nombre_publico: string;
  plazas_ofrecidas: number;
  categorias: string[];
  servicios: string[];
  tarifa: TarifaDto | null;
  zonas: string[];
  radio_km?: number | null;
  idiomas: string[];
  años_experiencia?: number | null;
  anios_experiencia?: number | null;
  fotos?: string[];
  referencias?: string[];
  telefono_e164?: string | null;
  estado: WorkerProfileEstado;
  eventos_completados?: number;
}

export interface WorkerProfileStatusResponse {
  perfil: WorkerProfileDto | null;
  verificado: {
    email: boolean;
    telefono: boolean;
  };
}

export interface AvailabilityWindowDto {
  window_id: string;
  inicio: string;
  fin: string;
  zona: string;
  rol: string;
}

export interface WorkerRequestItemDto {
  id?: string;
  reservation_id?: string;
  event_id?: string;
  worker_id?: string;
  evento?: {
    id?: string;
    nombre: string;
    fecha?: string;
    timezone?: string;
    lugar?: string;
    direccion?: string;
  };
  zona?: string;
  ventana?: EventVentana;
  rol: string;
  plazas: number;
  hora_llegada: string;
  costo_congelado: TarifaDto;
  estado: ReservationEstado;
  expira_en?: string;
  modo_emergencia?: boolean;
  sla_respuesta?: string;
  llegada_registrada_en?: string | null;
}

export interface EventRequirementsCoverageDto {
  cubiertos: number;
  pendientes: number;
  sin_cubrir: number;
  por_rol: EventRequirementDto[];
}

export interface PlannerAlertDto {
  id: string;
  event_id: string;
  reservation_id?: string | null;
  tipo: 'reserva_cancelada_en_vivo' | 'requerimiento_sin_cubrir' | string;
  detalle?: Record<string, unknown>;
  leida_en?: string | null;
  created_at: string;
}

export interface PlannerWorkerRequestsResponse extends PaginatedResponse<WorkerRequestItemDto> {
  cobertura?: EventRequirementDto[] | EventRequirementsCoverageDto;
}

export interface PaymentDto {
  payment_id: string;
  estado: 'pendiente' | 'confirmado' | 'pagado' | 'desconocido' | 'reversado' | string;
  monto: number;
  moneda?: string;
  idempotency_key?: string;
  ledger_tx_id?: string;
  intentos?: number;
  reverso_de?: string | null;
}

export interface PublicEventSummary {
  nombre: string;
  fecha: string;
  inicio: string;
  fin?: string;
  timezone?: string;
  lugar?: string;
  venue?: VenueDto | string;
}

export interface PublicQrInfo {
  token: string;
  png_url?: string;
  codigo_corto?: string;
}

export interface PublicRsvpStateResponse {
  respuesta: RsvpRespuesta | null;
  respondido_en: string | null;
  superseded_at?: string | null;
  qr: PublicQrInfo;
  evento: PublicEventSummary;
  recordatorios_cancelados?: number;
}

export interface RosterGuest {
  invitation_id: string;
  nombre: string;
  codigo_corto: string;
  zona?: string;
  mesa?: string | number | null;
  token_key_id?: string;
  token_version?: number;
}

export interface RosterRevocationsMeta {
  version: number;
  emitida_en: string;
  ttl_horas: number;
  vigente_hasta: string;
  refrescar_antes_de?: string;
}

export interface SignedRosterResponse {
  event_id: string;
  evento: {
    nombre: string;
    inicio: string;
    fin: string;
    estado: EventEstado;
    timezone: string;
  };
  roster_version: number;
  generado_en: string;
  expira_en: string;
  canonical_payload?: string;
  firma: {
    alg: 'ES256' | string;
    key_id: string;
    valor: string;
    sobre?: string;
  };
  key_publica_pem: string;
  limites?: {
    max_invitados: number;
    autonomia_horas: number;
    max_escaneos_dispositivo: number;
    max_eventos_por_sesion: number;
  };
  revocaciones: RosterRevocationsMeta;
  invitados: RosterGuest[];
}

export interface RevocationsResponse {
  version: number;
  emitida_en?: string;
  ttl_horas: number;
  vigente_hasta: string;
  revocados: string[];
}

export interface OutboundScanEvent {
  sequence: number;
  invitation_id: string;
  scanned_at: string;
  token_sha256: string;
  verdict_local: CheckinVerdict;
  modo: ScanModo;
  key_id?: string;
}

export interface StoredOutboundScanEvent extends OutboundScanEvent {
  synced: 0 | 1;
  batch_id?: string;
  guest_nombre?: string;
  server_result?: BatchEventResult;
}

export interface BatchUploadRequest {
  batch_id: string;
  device_id: string;
  event_id: string;
  key_id?: string;
  roster_version: number;
  revocation_version: number;
  seq_desde: number;
  seq_hasta: number;
  checksum: {
    alg: 'sha256';
    valor: string;
    sobre: 'events_json_canonico_ordenado_por_sequence';
  };
  cola_reportada: number;
  heartbeat_en: string;
  events: OutboundScanEvent[];
}

export interface BatchEventResult {
  sequence: number;
  invitation_id: string;
  checkin_id?: string;
  kind?: CheckinKind;
  verdict: CheckinVerdict;
  verdict_local?: CheckinVerdict;
  vigente_checkin_id?: string;
  resolucion_al_sincronizar?: 'invalidado_al_sincronizar' | string;
  tardio: boolean;
  duplicado: boolean;
  error?: string;
}

export interface BatchUploadResponse {
  batch_id: string;
  estado: string;
  recibido_en: string;
  ack_hasta_sequence: number;
  contadores: {
    aceptados: number;
    tardios: number;
    duplicados: number;
    invalidados_al_sincronizar?: number;
    rechazados: number;
  };
  results: BatchEventResult[];
  sync_state: {
    device_id: string;
    pendientes: number;
    ultima_seq_ackeada: number;
    heartbeat_en: string;
  };
}

export interface CheckinItemDto {
  checkin_id: string;
  invitation_id: string;
  kind: CheckinKind;
  verdict: CheckinVerdict;
  scanned_at: string;
  tardio: boolean;
  device_id?: string | null;
  annuls_checkin_id?: string | null;
}

export interface AnnulmentResponse {
  annulment_id?: string;
  checkin_id?: string;
  annuls_checkin_id: string;
  actor_id: string;
  kind: 'anulacion';
  scanned_at: string;
  asistentes?: number;
}
