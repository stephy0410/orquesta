import { sha256Hex } from "../../../shared/crypto.js";
import { parseGuestsCsv } from "../../../shared/domain-helpers.js";
import { AppError, validationError } from "../../../shared/errors.js";
import { authenticateUser, jsonResponse, withIdempotency } from "../../../shared/http.js";
import { ulid } from "../../../shared/ulid.js";

function extractCsvText(req) {
  if (req.multipart?.files?.length > 0) {
    return req.multipart.files[0].text;
  }
  if (req.multipart?.fields?.csv) {
    return req.multipart.fields.csv;
  }
  if (req.contentType.includes("text/csv") && req.rawBuffer.length > 0) {
    return req.rawBuffer.toString("utf8");
  }
  if (req.body?.csv && typeof req.body.csv === "string") {
    return req.body.csv;
  }
  throw validationError("Se requiere archivo CSV en multipart/form-data", "file");
}

export const guestRoutes = [
  {
    method: "POST",
    pattern: "/v1/events/:eventId/guests/import",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      const { event } = await ctx.store.authorizeEventAccess({
        userId: auth.userId,
        eventId: req.params.eventId,
        requiredMembershipRoles: ["owner", "editor"],
      });
      if (event.estado === "cerrado" || event.estado === "cancelado") {
        throw new AppError("EVENT_STATE_INVALID", "Evento cerrado o cancelado no admite imports");
      }

      return withIdempotency(
        req,
        ctx,
        `POST:/v1/events/${req.params.eventId}/guests/import:${auth.userId}`,
        async () => {
          const csvText = extractCsvText(req);
          const parsedRows = parseGuestsCsv(csvText);

          // Validación atómica temprana de aforo (RF-02, AC-20)
          if (typeof ctx.store.previewImportCapacity === "function") {
            await ctx.store.previewImportCapacity({
              eventId: req.params.eventId,
              parsedRows,
            });
          }

          const s3Key = `imports/${req.params.eventId}/${ulid()}.csv`;
          await ctx.objectStorage.putObject({
            bucket: ctx.importsBucket,
            key: s3Key,
            body: Buffer.from(csvText, "utf8"),
            contentType: "text/csv; charset=utf-8",
          });

          const fileHash = sha256Hex(csvText);
          const job = await ctx.store.createImportJob({
            eventId: req.params.eventId,
            s3Key,
            fileHash,
            totalFilas: parsedRows.length,
          });

          await ctx.queueBus.sendToImportQueue({
            import_id: job.id,
            event_id: req.params.eventId,
            s3_key: s3Key,
          });

          return jsonResponse(202, {
            import_id: job.id,
            estado: "en_proceso",
            progreso: 0.0,
            total_filas: parsedRows.length,
            aceptadas: 0,
            rechazadas: 0,
            duplicadas_en_archivo: 0,
            errores: [],
          });
        }
      );
    },
  },
  {
    method: "GET",
    pattern: "/v1/events/:eventId/guests/imports/:importId",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      await ctx.store.authorizeEventAccess({
        userId: auth.userId,
        eventId: req.params.eventId,
      });
      const report = await ctx.store.getImportJob({
        eventId: req.params.eventId,
        importId: req.params.importId,
      });
      return jsonResponse(200, report);
    },
  },
  {
    method: "GET",
    pattern: "/v1/events/:eventId/guests",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      await ctx.store.authorizeEventAccess({
        userId: auth.userId,
        eventId: req.params.eventId,
      });
      const res = await ctx.store.listGuests({
        eventId: req.params.eventId,
        limit: req.query.limit,
        cursor: req.query.cursor,
        sinMesa: req.query.sin_mesa === "true" || req.query.sin_mesa === "1",
        includeDeleted: req.query.deleted === "true" || req.query.deleted === "1",
      });
      return jsonResponse(200, res);
    },
  },
  {
    method: "DELETE",
    pattern: "/v1/events/:eventId/guests/:guestId",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      await ctx.store.authorizeEventAccess({
        userId: auth.userId,
        eventId: req.params.eventId,
        requiredMembershipRoles: ["owner"],
      });
      const res = await ctx.store.softDeleteGuest({
        eventId: req.params.eventId,
        guestId: req.params.guestId,
        actorId: auth.userId,
        now: ctx.now(),
      });
      return jsonResponse(200, res);
    },
  },
];
