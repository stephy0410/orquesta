// Catálogo cerrado de códigos HTTP y de negocio (03-api.md, 03a, 03b)
export const ERROR_CATALOG = Object.freeze({
  VALIDATION_ERROR: 422,
  EVENT_STATE_INVALID: 409,
  AUTH_REQUIRED: 401,
  INVALID_CREDENTIALS: 401,
  EMAIL_NOT_VERIFIED: 403,
  FORBIDDEN_EVENT_SCOPE: 403,
  EMAIL_YA_REGISTRADA: 409,
  TELEFONO_YA_REGISTRADO: 409,
  NOT_FOUND: 404,
  AFORO_EXCEDIDO: 422,
  IMPORT_FILAS_EXCEDIDAS: 413,
  CONFIRMACION_REQUERIDA: 409,
  SIN_DESTINATARIOS_PENDIENTES: 409,
  MESA_SIN_CAPACIDAD: 409,
  MESA_CON_ASIENTOS: 409,
  SEATING_VERSION_CONFLICT: 409,
  PRECONDITION_REQUIRED: 428,
  WINDOW_NOT_AVAILABLE: 422,
  RESERVATION_OVERLAP: 409,
  TRABAJADOR_SIN_TARIFA: 422,
  CORRECTION_WINDOW_CLOSED: 409,
  INVITACION_REVOCADA: 410,
  TOKEN_INVALIDO: 404,
  TOKEN_EXPIRADO: 410,
  TOKEN_TIPO_INCORRECTO: 400,
  IDEMPOTENCY_CONFLICT: 409,
  PROFILE_NOT_VERIFIED: 409,
  RESERVATION_NOT_PENDING: 409,
  RESERVATION_NOT_ACCEPTED: 409,
  PLAZAS_INVALIDAS: 409,
  REQUEST_EXPIRED: 410,
  CHECKIN_NOT_FOUND: 404,
  BATCH_TOO_LARGE: 413,
  BATCH_CHECKSUM_MISMATCH: 400,
  BATCH_OUT_OF_ORDER: 400,
  RATE_LIMITED: 429,
  PSP_ERROR: 502,
  INTERNAL_ERROR: 500,
});

// Códigos de motivo a nivel fila de importación (RF-02)
export const IMPORT_ROW_ERRORS = Object.freeze({
  GUEST_SIN_CLAVE: "GUEST_SIN_CLAVE",
  GUEST_CLAVE_INVALIDA: "GUEST_CLAVE_INVALIDA",
  GUEST_DUPLICADO: "GUEST_DUPLICADO",
  AFORO_EXCEDIDO: "AFORO_EXCEDIDO",
});

const PII_SENSITIVE_KEYS = new Set([
  "email",
  "email_normalizado",
  "telefono",
  "telefono_e164",
  "password",
  "password_hash",
  "token",
  "rsvp_token",
  "qr_token",
  "access_token",
  "session_token",
  "codigo_otp",
  "direccion",
]);

function sanitizeDetails(value) {
  if (value === null || value === undefined) return {};
  if (Array.isArray(value)) return value.map((v) => sanitizeValue(v));
  if (typeof value !== "object") return {};
  const clean = {};
  for (const [k, v] of Object.entries(value)) {
    if (PII_SENSITIVE_KEYS.has(k.toLowerCase())) continue;
    clean[k] = sanitizeValue(v);
  }
  return clean;
}

function sanitizeValue(v) {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map((item) => sanitizeValue(item));
  if (typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (PII_SENSITIVE_KEYS.has(k.toLowerCase())) continue;
      out[k] = sanitizeValue(val);
    }
    return out;
  }
  return v;
}

export class AppError extends Error {
  constructor(code, message, details = {}, httpStatusOverride = null) {
    if (!Object.prototype.hasOwnProperty.call(ERROR_CATALOG, code)) {
      throw new Error(`Unknown error code outside closed catalog: ${code}`);
    }
    super(message);
    this.name = "AppError";
    this.code = code;
    this.httpStatus = httpStatusOverride ?? ERROR_CATALOG[code];
    this.details = sanitizeDetails(details);
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
      },
    };
  }
}

export function validationError(message, campo = null, extra = {}) {
  const details = campo ? { campo, ...extra } : { ...extra };
  return new AppError("VALIDATION_ERROR", message, details);
}

export function isAppError(err) {
  return err instanceof AppError || (err && err.name === "AppError" && typeof err.code === "string");
}
