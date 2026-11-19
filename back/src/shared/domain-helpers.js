import { haversineKm, isValidCategoria, isValidRol, isValidZona } from "./catalogs.js";
import { computeBatchChecksum, sha256Hex } from "./crypto.js";
import { AppError, IMPORT_ROW_ERRORS, validationError } from "./errors.js";

export function normalizeEmail(email) {
  if (typeof email !== "string") return null;
  const trimmed = email.trim().toLowerCase();
  if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return trimmed;
}

export function normalizePhoneE164(phone) {
  if (typeof phone !== "string") return null;
  const cleaned = phone.replace(/[\s\-().]/g, "").trim();
  if (!cleaned || !/^\+[1-9][0-9]{7,14}$/.test(cleaned)) return null;
  return cleaned;
}

export function buildTr12Destinatario(subjectId, normalizedAddress, canal) {
  return `${subjectId}:${sha256Hex(normalizedAddress)}:${canal}`;
}

export function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

export function decodeCursor(cursor) {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    const off = Number(parsed?.offset);
    return Number.isInteger(off) && off >= 0 ? off : 0;
  } catch {
    return 0;
  }
}

export function paginateArray(items, limit = 20, cursor = null, maxLimit = 100) {
  const safeLimit = Math.min(Math.max(1, Number(limit) || 20), maxLimit);
  const offset = decodeCursor(cursor);
  const slice = items.slice(offset, offset + safeLimit);
  const nextOffset = offset + slice.length;
  const next_cursor = nextOffset < items.length ? encodeCursor(nextOffset) : null;
  return { items: slice, next_cursor };
}

export function windowsOverlap(aStart, aEnd, bStart, bEnd) {
  const s1 = new Date(aStart).getTime();
  const e1 = new Date(aEnd).getTime();
  const s2 = new Date(bStart).getTime();
  const e2 = new Date(bEnd).getTime();
  return s1 < e2 && e1 > s2;
}

export function windowContains(outerStart, outerEnd, innerStart, innerEnd) {
  const os = new Date(outerStart).getTime();
  const oe = new Date(outerEnd).getTime();
  const is = new Date(innerStart).getTime();
  const ie = new Date(innerEnd).getTime();
  return os <= is && oe >= ie;
}

export function computeReminderTimes(ventanaInicioIso) {
  const baseMs = new Date(ventanaInicioIso).getTime();
  return {
    t_7d: new Date(baseMs - 7 * 24 * 60 * 60 * 1000).toISOString(),
    t_1d: new Date(baseMs - 1 * 24 * 60 * 60 * 1000).toISOString(),
    t_24h: new Date(baseMs - 24 * 60 * 60 * 1000).toISOString(),
    t_2h: new Date(baseMs - 2 * 60 * 60 * 1000).toISOString(),
  };
}

/**
 * Parser CSV ligero RFC 4180 (sin dependencias nativas) para <= 20 000 filas (RF-02).
 */
export function parseGuestsCsv(csvText) {
  if (typeof csvText !== "string") {
    throw validationError("CSV inválido", "file");
  }
  const cleanText = csvText.replace(/^\uFEFF/, "");
  const lines = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < cleanText.length; i++) {
    const ch = cleanText[i];
    if (inQuotes) {
      if (ch === '"') {
        if (cleanText[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && cleanText[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c.trim() !== "")) {
        lines.push(row);
      }
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) {
    lines.push(row);
  }

  if (lines.length === 0) {
    throw validationError("Archivo CSV vacío", "file");
  }

  const header = lines[0].map((h) => h.trim().toLowerCase());
  const nombreIdx = header.indexOf("nombre");
  const emailIdx = header.indexOf("email");
  const telIdx = header.indexOf("telefono");

  if (nombreIdx === -1 || (emailIdx === -1 && telIdx === -1)) {
    throw validationError("Encabezados CSV requeridos: nombre, email, telefono", "file");
  }

  const dataRows = lines.slice(1);
  if (dataRows.length > 20000) {
    throw new AppError("IMPORT_FILAS_EXCEDIDAS", "El archivo supera el máximo de 20 000 filas", {
      max_filas: 20000,
      total_filas: dataRows.length,
    });
  }

  return dataRows.map((cols, idx) => ({
    linea: idx + 2,
    nombre: (cols[nombreIdx] ?? "").trim(),
    emailRaw: emailIdx !== -1 ? (cols[emailIdx] ?? "").trim() : "",
    telefonoRaw: telIdx !== -1 ? (cols[telIdx] ?? "").trim() : "",
  }));
}

export function validateAndNormalizeCsvRow(row) {
  if (!row.nombre || row.nombre.length > 120) {
    return { valid: false, motivo: IMPORT_ROW_ERRORS.GUEST_CLAVE_INVALIDA };
  }

  const hasEmailRaw = row.emailRaw.length > 0;
  const hasPhoneRaw = row.telefonoRaw.length > 0;

  if (!hasEmailRaw && !hasPhoneRaw) {
    return { valid: false, motivo: IMPORT_ROW_ERRORS.GUEST_SIN_CLAVE };
  }

  const email = hasEmailRaw ? normalizeEmail(row.emailRaw) : null;
  if (hasEmailRaw && !email) {
    return { valid: false, motivo: IMPORT_ROW_ERRORS.GUEST_CLAVE_INVALIDA };
  }

  const telefono = hasPhoneRaw ? normalizePhoneE164(row.telefonoRaw) : null;
  if (hasPhoneRaw && !telefono) {
    return { valid: false, motivo: IMPORT_ROW_ERRORS.GUEST_CLAVE_INVALIDA };
  }

  return { valid: true, nombre: row.nombre, email, telefono };
}

/**
 * Validación de lote de check-in offline (TR-03).
 */
export function validateCheckinBatchPayload(batch) {
  if (!batch || typeof batch !== "object") {
    throw validationError("Cuerpo de lote inválido");
  }
  if (!Array.isArray(batch.events)) {
    throw validationError("events debe ser un arreglo", "events");
  }
  if (batch.events.length > 500) {
    throw new AppError("BATCH_TOO_LARGE", "El lote supera el límite de 500 eventos", {
      max_eventos: 500,
      recibidos: batch.events.length,
    });
  }
  if (!batch.device_id || !batch.event_id || !batch.batch_id) {
    throw validationError("device_id, event_id y batch_id son obligatorios");
  }

  // Verificar orden monotónico por sequence (TR-03)
  let prevSeq = null;
  for (const ev of batch.events) {
    const seq = Number(ev.sequence);
    if (!Number.isInteger(seq) || seq <= 0) {
      throw new AppError("BATCH_OUT_OF_ORDER", "Cada evento debe tener sequence entero > 0");
    }
    if (prevSeq !== null && seq <= prevSeq) {
      throw new AppError("BATCH_OUT_OF_ORDER", "Secuencia desordenada o duplicada dentro del lote", {
        anterior: prevSeq,
        actual: seq,
      });
    }
    prevSeq = seq;
  }

  if (batch.events.length > 0) {
    if (batch.seq_desde !== undefined && Number(batch.seq_desde) !== Number(batch.events[0].sequence)) {
      throw new AppError("BATCH_OUT_OF_ORDER", "seq_desde no coincide con el primer evento del lote");
    }
    if (
      batch.seq_hasta !== undefined &&
      Number(batch.seq_hasta) !== Number(batch.events[batch.events.length - 1].sequence)
    ) {
      throw new AppError("BATCH_OUT_OF_ORDER", "seq_hasta no coincide con el último evento del lote");
    }
  }

  if (!batch.checksum || batch.checksum.alg !== "sha256" || typeof batch.checksum.valor !== "string") {
    throw new AppError("BATCH_CHECKSUM_MISMATCH", "Checksum sha256 obligatorio");
  }
  const expectedChecksum = computeBatchChecksum(batch.events);
  if (batch.checksum.valor.toLowerCase() !== expectedChecksum) {
    throw new AppError("BATCH_CHECKSUM_MISMATCH", "Checksum de lote inválido", {
      esperado: expectedChecksum,
    });
  }
}

/**
 * Cálculo de `pendientes` por dispositivo (TR-18) y estado `desconocido` > 5 min.
 */
export function deriveSyncPendingState(syncStates, nowMs = Date.now()) {
  if (!syncStates || syncStates.length === 0) {
    return { valor: 0, estado: "conocido", dispositivos: [] };
  }
  const FIVE_MINUTES_MS = 5 * 60 * 1000;
  let hasStale = false;
  let totalPendientes = 0;

  const dispositivos = syncStates.map((s) => {
    const hbMs = new Date(s.heartbeat_en).getTime();
    const stale = !Number.isFinite(hbMs) || nowMs - hbMs > FIVE_MINUTES_MS;
    if (stale) hasStale = true;
    const pendingDevice = Math.max(
      0,
      Number(s.cola_reportada || 0) - (Number(s.ultima_seq_ackeada || 0) - Number(s.seq_confirmada || 0))
    );
    totalPendientes += pendingDevice;
    return {
      device_id: s.device_id,
      cola_reportada: Number(s.cola_reportada || 0),
      ultima_seq_ackeada: Number(s.ultima_seq_ackeada || 0),
      seq_confirmada: Number(s.seq_confirmada || 0),
      heartbeat_en: s.heartbeat_en,
      estado: stale ? "desconocido" : "conocido",
    };
  });

  if (hasStale) {
    return { valor: null, estado: "desconocido", dispositivos };
  }
  return { valor: totalPendientes, estado: "conocido", dispositivos };
}

/**
 * Filtrado y orden determinista de búsqueda de trabajadores (RF-07, NFR-11 exc. 2).
 */
export function filterAndRankWorkers({
  profiles,
  completedCounts,
  acceptedReservations,
  filters,
}) {
  const {
    categorias = [],
    zonas = [],
    radioKm = null,
    tarifaMin = null,
    tarifaMax = null,
    unidad = null,
    desde = null,
    hasta = null,
    plazas = 1,
  } = filters;

  for (const c of categorias) {
    if (!isValidCategoria(c)) throw validationError(`Categoría inválida: ${c}`, "categorias");
  }
  for (const z of zonas) {
    if (!isValidZona(z)) throw validationError(`Zona inválida: ${z}`, "zonas");
  }
  if (unidad && !["hora", "persona_hora", "evento"].includes(unidad)) {
    throw validationError("Unidad de tarifa inválida", "unidad");
  }

  const results = [];
  for (const wp of profiles) {
    if (
      wp.estado !== "publicado" ||
      !wp.email_verificado_en ||
      !wp.telefono_verificado_en ||
      wp.deleted_at
    ) {
      continue;
    }

    // AND semántico en categorías (RF-07)
    if (categorias.length > 0 && !categorias.every((c) => wp.categorias.includes(c))) {
      continue;
    }

    // Costos (RF-07)
    if (unidad && wp.tarifa_unidad !== unidad) continue;
    if (tarifaMin !== null && Number(wp.tarifa_monto) < Number(tarifaMin)) continue;
    if (tarifaMax !== null && Number(wp.tarifa_monto) > Number(tarifaMax)) continue;

    // Excluir quien no tenga plazas libres por reservas `aceptada` solapadas (RF-07, TR-08)
    if (desde && hasta) {
      const usedPlazas = acceptedReservations
        .filter(
          (r) =>
            r.worker_id === wp.id &&
            r.estado === "aceptada" &&
            !r.deleted_at &&
            windowsOverlap(r.inicio, r.fin, desde, hasta)
        )
        .reduce((sum, r) => sum + Number(r.plazas || 1), 0);
      const offered = Number(wp.plazas_ofrecidas || 1);
      if (usedPlazas + Number(plazas || 1) > offered) continue;
    }

    // Lugares: zona exacta o radio_km (D10.3: radio ordena dentro del filtro por zona / cercanía)
    let exactZoneMatch = zonas.length === 0 ? 1 : 0;
    let minDistanceKm = 0;

    if (zonas.length > 0) {
      const exact = zonas.some((z) => wp.zonas.includes(z));
      if (exact) {
        exactZoneMatch = 1;
        minDistanceKm = 0;
      } else if (radioKm !== null && Number(radioKm) > 0) {
        let bestDist = Number.POSITIVE_INFINITY;
        for (const reqZ of zonas) {
          for (const wZ of wp.zonas) {
            const d = haversineKm(reqZ, wZ);
            if (d < bestDist) bestDist = d;
          }
        }
        const effectiveRadius = wp.radio_km !== null ? Math.min(Number(radioKm), Number(wp.radio_km)) : Number(radioKm);
        if (bestDist > effectiveRadius) continue;
        exactZoneMatch = 0;
        minDistanceKm = bestDist;
      } else {
        continue;
      }
    }

    // Lista blanca estricta (NFR-11 exc. 2): NUNCA contacto
    results.push({
      _rank: {
        catMatches: wp.categorias.length,
        exactZoneMatch,
        distanceKm: minDistanceKm,
        tarifa: Number(wp.tarifa_monto),
      },
      item: {
        worker_id: wp.id,
        tipo: wp.tipo,
        plazas_ofrecidas: wp.plazas_ofrecidas,
        nombre_publico: wp.nombre_publico,
        categorias: [...wp.categorias],
        servicios: [...(wp.servicios || [])],
        tarifa: {
          modo: wp.tarifa_modo || "fijo",
          monto: Number(wp.tarifa_monto),
          moneda: wp.tarifa_moneda,
          unidad: wp.tarifa_unidad,
        },
        zonas: [...wp.zonas],
        radio_km: wp.radio_km !== null && wp.radio_km !== undefined ? Number(wp.radio_km) : null,
        idiomas: [...(wp.idiomas || [])],
        anios_experiencia: wp.anios_experiencia ?? null,
        eventos_completados: completedCounts.get(wp.id) || 0,
      },
    });
  }

  // Orden determinista de RF-07:
  // coincidencias categoría DESC -> zona exacta DESC -> distancia ASC -> tarifa ASC -> worker_id ASC
  results.sort((a, b) => {
    if (b._rank.catMatches !== a._rank.catMatches) return b._rank.catMatches - a._rank.catMatches;
    if (b._rank.exactZoneMatch !== a._rank.exactZoneMatch) {
      return b._rank.exactZoneMatch - a._rank.exactZoneMatch;
    }
    if (a._rank.distanceKm !== b._rank.distanceKm) return a._rank.distanceKm - b._rank.distanceKm;
    if (a._rank.tarifa !== b._rank.tarifa) return a._rank.tarifa - b._rank.tarifa;
    return a.item.worker_id < b.item.worker_id ? -1 : a.item.worker_id > b.item.worker_id ? 1 : 0;
  });

  return results.map((r) => r.item);
}

export function validateRolParam(rol) {
  if (!isValidRol(rol)) {
    throw validationError(`Rol inválido: ${rol}`, "rol");
  }
}

/** Mensaje para la planner cuando el estado del evento no permite enviar invitaciones. */
export function sendBlockedMessage(estado) {
  return estado === "borrador"
    ? "Publica el evento antes de enviar las invitaciones."
    : "Este evento ya terminó o fue cancelado; ya no se pueden enviar invitaciones.";
}
