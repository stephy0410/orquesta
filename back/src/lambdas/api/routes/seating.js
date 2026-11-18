import { validationError } from "../../../shared/errors.js";
import { authenticateUser, jsonResponse, withIdempotency } from "../../../shared/http.js";

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
          });
          return jsonResponse(201, created);
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
      return jsonResponse(200, res);
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
          });
          return jsonResponse(res.created ? 201 : 200, res.body);
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
      await ctx.store.releaseSeat({
        eventId: req.params.eventId,
        guestId: req.params.guestId,
      });
      return jsonResponse(204, null);
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
