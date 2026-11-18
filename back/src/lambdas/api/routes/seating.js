import { AppError, validationError } from "../../../shared/errors.js";
import { authenticateUser, jsonResponse, withIdempotency } from "../../../shared/http.js";

/**
 * Control de versión optimista del plano (FR7). El cliente envía la versión que leyó en
 * `If-Match` (formato ETag `"12"`, `W/"12"` o `12`) o en el cuerpo como `plan_version`.
 * Sin versión la edición se acepta (compatibilidad), salvo que SEATING_REQUIRE_IF_MATCH=true.
 */
function readExpectedSeatingVersion(req) {
  const header = req.headers["if-match"];
  const raw = header !== undefined ? String(header).trim().replace(/^W\//, "").replace(/^"|"$/g, "") : req.body?.plan_version;
  if (raw === undefined || raw === null || raw === "" || raw === "*") {
    if (process.env.SEATING_REQUIRE_IF_MATCH === "true") {
      throw new AppError("PRECONDITION_REQUIRED", "Envía If-Match con la versión del plano (GET .../tables)");
    }
    return null;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw validationError("If-Match / plan_version inválido", "plan_version");
  return n;
}

const etagFor = (version) => ({ etag: `"${version}"` });

export const seatingRoutes = [
  {
    method: "POST",
    pattern: "/v1/events/:eventId/tables",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      await ctx.store.authorizeEventAccess({
        userId: auth.userId,
        eventId: req.params.eventId,
        requiredMembershipRoles: ["owner", "editor"],
      });
      return withIdempotency(
        req,
        ctx,
        `POST:/v1/events/${req.params.eventId}/tables:${auth.userId}`,
        async () => {
          const { numero, nombre, capacidad } = req.body || {};
          const created = await ctx.store.createTable({
            eventId: req.params.eventId,
            numero,
            nombre,
            capacidad,
            expectedVersion: readExpectedSeatingVersion(req),
          });
          return jsonResponse(201, created, { headers: etagFor(created.plan_version) });
        }
      );
    },
  },
  {
    method: "GET",
    pattern: "/v1/events/:eventId/tables",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      await ctx.store.authorizeEventAccess({
        userId: auth.userId,
        eventId: req.params.eventId,
      });
      const res = await ctx.store.listTables({
        eventId: req.params.eventId,
        limit: req.query.limit,
        cursor: req.query.cursor,
      });
      return jsonResponse(200, res, { headers: etagFor(res.plan_version) });
    },
  },
  {
    method: "POST",
    pattern: "/v1/events/:eventId/seat-assignments",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      await ctx.store.authorizeEventAccess({
        userId: auth.userId,
        eventId: req.params.eventId,
        requiredMembershipRoles: ["owner", "editor"],
      });
      return withIdempotency(
        req,
        ctx,
        `POST:/v1/events/${req.params.eventId}/seat-assignments:${auth.userId}`,
        async () => {
          const { guest_id: guestId, table_id: tableId } = req.body || {};
          if (!guestId || !tableId) {
            throw validationError("guest_id y table_id son obligatorios", "guest_id");
          }
          const res = await ctx.store.assignSeat({
            eventId: req.params.eventId,
            guestId,
            tableId,
            actorId: auth.userId,
            expectedVersion: readExpectedSeatingVersion(req),
            now: ctx.now(),
          });
          return jsonResponse(res.created ? 201 : 200, res.body, { headers: etagFor(res.body.plan_version) });
        }
      );
    },
  },
  {
    method: "DELETE",
    pattern: "/v1/events/:eventId/seat-assignments/:guestId",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      await ctx.store.authorizeEventAccess({
        userId: auth.userId,
        eventId: req.params.eventId,
        requiredMembershipRoles: ["owner", "editor"],
      });
      const res = await ctx.store.releaseSeat({
        eventId: req.params.eventId,
        guestId: req.params.guestId,
        expectedVersion: readExpectedSeatingVersion(req),
        now: ctx.now(),
      });
      return jsonResponse(204, null, { headers: etagFor(res.plan_version) });
    },
  },
  {
    method: "GET",
    pattern: "/v1/events/:eventId/seat-assignments/unseated",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      await ctx.store.authorizeEventAccess({
        userId: auth.userId,
        eventId: req.params.eventId,
      });
      const res = await ctx.store.listUnseatedGuests({
        eventId: req.params.eventId,
        limit: req.query.limit,
        cursor: req.query.cursor,
      });
      return jsonResponse(200, res);
    },
  },
];
