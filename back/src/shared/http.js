import { canonicalJson, sha256Hex, verifySessionJwt } from "./crypto.js";
import { AppError, isAppError } from "./errors.js";

export function normalizeHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (v !== undefined) out[k.toLowerCase()] = v;
  }
  return out;
}

export function parseCookies(event, normalizedHeaders) {
  const cookies = {};
  const list = [];
  if (Array.isArray(event?.cookies)) {
    list.push(...event.cookies);
  }
  if (normalizedHeaders?.cookie) {
    list.push(...String(normalizedHeaders.cookie).split(";"));
  }
  for (const part of list) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (name) cookies[name] = decodeURIComponent(val);
  }
  return cookies;
}

export function parseQuery(event) {
  const single = {};
  const multi = {};
  if (event?.rawQueryString) {
    const params = new URLSearchParams(event.rawQueryString);
    for (const [k, v] of params.entries()) {
      single[k] = v;
      if (!multi[k]) multi[k] = [];
      multi[k].push(v);
    }
  } else if (event?.queryStringParameters) {
    for (const [k, v] of Object.entries(event.queryStringParameters)) {
      if (v === undefined) continue;
      single[k] = v;
      multi[k] = String(v).split(",").filter(Boolean);
    }
  }
  return { single, multi };
}

export function getRawBodyBuffer(event) {
  if (!event || event.body === undefined || event.body === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(event.body)) return event.body;
  if (event.isBase64Encoded) {
    return Buffer.from(String(event.body), "base64");
  }
  return Buffer.from(String(event.body), "utf8");
}

/**
 * Parser RFC 2046 para multipart/form-data (CSV import RF-02).
 */
export function parseMultipartFormData(rawBuffer, contentType) {
  const match = String(contentType || "").match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  if (!match) {
    throw new AppError("VALIDATION_ERROR", "Falta boundary en multipart/form-data", {
      campo: "content-type",
    });
  }
  const boundary = match[1] || match[2];
  const boundaryBuf = Buffer.from(`--${boundary}`, "latin1");
  const fields = {};
  const files = [];

  let pos = rawBuffer.indexOf(boundaryBuf);
  while (pos !== -1) {
    let start = pos + boundaryBuf.length;
    if (rawBuffer.subarray(start, start + 2).toString("latin1") === "--") {
      break; // fin del multipart
    }
    if (rawBuffer[start] === 0x0d && rawBuffer[start + 1] === 0x0a) start += 2;
    else if (rawBuffer[start] === 0x0a) start += 1;

    const nextPos = rawBuffer.indexOf(boundaryBuf, start);
    if (nextPos === -1) break;

    let partEnd = nextPos;
    if (rawBuffer[partEnd - 2] === 0x0d && rawBuffer[partEnd - 1] === 0x0a) partEnd -= 2;
    else if (rawBuffer[partEnd - 1] === 0x0a) partEnd -= 1;

    const partBuf = rawBuffer.subarray(start, partEnd);
    let headerEnd = partBuf.indexOf("\r\n\r\n");
    let sepLen = 4;
    if (headerEnd === -1) {
      headerEnd = partBuf.indexOf("\n\n");
      sepLen = 2;
    }
    if (headerEnd !== -1) {
      const headerStr = partBuf.subarray(0, headerEnd).toString("utf8");
      const contentBuf = partBuf.subarray(headerEnd + sepLen);
      const dispMatch = headerStr.match(/Content-Disposition:\s*form-data;\s*([^;\r\n]+.*)/i);
      const nameMatch = dispMatch?.[1]?.match(/name="([^"]+)"/i);
      const fileMatch = dispMatch?.[1]?.match(/filename="([^"]*)"/i);
      const ctMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/i);
      const fieldName = nameMatch?.[1] || "file";

      if (fileMatch) {
        files.push({
          fieldName,
          filename: fileMatch[1],
          contentType: ctMatch?.[1]?.trim() || "text/csv",
          buffer: contentBuf,
          text: contentBuf.toString("utf8"),
        });
      } else {
        fields[fieldName] = contentBuf.toString("utf8");
      }
    }
    pos = nextPos;
  }

  return { fields, files };
}

export function parseHttpRequest(event) {
  const method = (event?.requestContext?.http?.method || event?.httpMethod || "GET").toUpperCase();
  const rawPath = event?.rawPath || event?.path || "/";
  const headers = normalizeHeaders(event?.headers);
  const cookies = parseCookies(event, headers);
  const query = parseQuery(event);
  const rawBuffer = getRawBodyBuffer(event);
  const contentType = headers["content-type"] || "";

  let jsonBody = null;
  let multipart = null;

  if (rawBuffer.length > 0) {
    if (contentType.includes("multipart/form-data")) {
      multipart = parseMultipartFormData(rawBuffer, contentType);
    } else if (contentType.includes("application/json") || contentType === "") {
      const text = rawBuffer.toString("utf8").trim();
      if (text.length > 0) {
        try {
          jsonBody = JSON.parse(text);
        } catch {
          throw new AppError("VALIDATION_ERROR", "Cuerpo JSON inválido", { campo: "body" });
        }
      }
    }
  }

  return {
    method,
    path: rawPath,
    headers,
    cookies,
    query: query.single,
    queryMulti: query.multi,
    rawBuffer,
    contentType,
    body: jsonBody,
    multipart,
    idempotencyKey: headers["idempotency-key"] || null,
    ifNoneMatch: headers["if-none-match"] || null,
  };
}

export function buildSessionCookie(token, maxAgeSeconds = 86400) {
  return `session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookie() {
  return "session=; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=0";
}

export function jsonResponse(statusCode, body = null, { headers = {}, cookies = [] } = {}) {
  const finalHeaders = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  };
  const res = {
    statusCode,
    headers: finalHeaders,
    body: statusCode === 204 || statusCode === 304 || body === null ? "" : JSON.stringify(body),
  };
  if (cookies && cookies.length > 0) {
    res.cookies = cookies;
  }
  return res;
}

export function errorResponse(err, req = null) {
  if (isAppError(err)) {
    return jsonResponse(err.httpStatus, err.toJSON());
  }
  // Error no controlado: se registra (estructurado, sin cuerpo ni PII) para que la
  // alarma de 5xx (NFR-09) tenga causa raíz; al cliente solo se le da el envelope genérico.
  if (process.env.ORQUESTA_SILENT_ERRORS !== "1") {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "unhandled_error",
        method: req?.method,
        path: req?.path,
        error: err?.message,
        pg_code: err?.code,
        stack: err?.stack,
      })
    );
  }
  return jsonResponse(500, {
    error: {
      code: "INTERNAL_ERROR",
      message: "Error interno del servidor",
      details: {},
    },
  });
}

export function extractBearerToken(req) {
  const authHeader = req.headers.authorization || "";
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }
  return null;
}

export async function authenticateUser(req, ctx) {
  const bearer = extractBearerToken(req);
  const rawToken = bearer || req.cookies?.session || null;
  if (!rawToken) {
    throw new AppError("AUTH_REQUIRED", "Autenticación requerida");
  }
  const claims = verifySessionJwt(rawToken, ctx.sessionSecret, ctx.now().getTime());
  if (!claims || claims.token_type !== "user_session") {
    throw new AppError("AUTH_REQUIRED", "Sesión inválida o expirada");
  }
  if (await ctx.store.isSessionRevoked(claims.jti)) {
    throw new AppError("AUTH_REQUIRED", "Sesión revocada");
  }
  const user = await ctx.store.findUserById(claims.sub);
  if (!user || user.deleted_at) {
    throw new AppError("AUTH_REQUIRED", "Usuario inválido");
  }
  if (!user.email_verificado_en) {
    throw new AppError("EMAIL_NOT_VERIFIED", "Email no verificado");
  }
  return {
    type: "user",
    userId: user.id,
    roles: user.roles,
    jti: claims.jti,
    claims,
  };
}

export async function authenticateScanSession(req, ctx) {
  const bearer = extractBearerToken(req);
  const rawToken = bearer || req.cookies?.session || null;
  if (!rawToken) {
    throw new AppError("AUTH_REQUIRED", "Sesión de escaneo requerida");
  }
  const claims = verifySessionJwt(rawToken, ctx.sessionSecret, ctx.now().getTime());
  if (!claims) {
    throw new AppError("AUTH_REQUIRED", "Token de sesión inválido o expirado");
  }
  if (claims.token_type === "event_session") {
    return {
      type: "event_session",
      sessionId: claims.session_id,
      eventId: claims.event_id,
      rol: claims.rol,
      deviceId: claims.device_id,
      actorId: claims.actor_id || null,
      accessTokenId: claims.access_token_id || null,
      claims,
    };
  }
  if (claims.token_type === "user_session") {
    const user = await ctx.store.findUserById(claims.sub);
    if (!user || user.deleted_at) throw new AppError("AUTH_REQUIRED", "Usuario inválido");
    return {
      type: "user",
      userId: user.id,
      roles: user.roles,
      claims,
    };
  }
  throw new AppError("AUTH_REQUIRED", "Tipo de token inválido");
}

export async function withIdempotency(req, ctx, scope, fn) {
  if (!req.idempotencyKey) {
    return fn();
  }
  const hashSource =
    req.multipart
      ? req.rawBuffer
      : req.body !== null
        ? Buffer.from(canonicalJson(req.body), "utf8")
        : req.rawBuffer;
  const requestHash = sha256Hex(hashSource);

  const existing = await ctx.store.getIdempotency(scope, req.idempotencyKey);
  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new AppError(
        "IDEMPOTENCY_CONFLICT",
        "La misma Idempotency-Key fue usada con un cuerpo diferente"
      );
    }
    return jsonResponse(existing.status_code, existing.response_body, {
      headers: existing.response_headers || {},
    });
  }

  const res = await fn();
  if (res.statusCode >= 200 && res.statusCode < 300) {
    const parsedBody = res.body ? JSON.parse(res.body) : null;
    await ctx.store.saveIdempotency({
      scope,
      key: req.idempotencyKey,
      requestHash,
      statusCode: res.statusCode,
      headers: res.headers || {},
      body: parsedBody,
    });
  }
  return res;
}
