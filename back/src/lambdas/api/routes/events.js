import { AppError, validationError } from "../../../shared/errors.js";
import { authenticateUser, jsonResponse, withIdempotency } from "../../../shared/http.js";

function assertPlannerRole(auth) {
  if (!auth.roles.includes("planner")) {
    throw new AppError("FORBIDDEN_EVENT_SCOPE", "Se requiere rol planner");
  }
}

export const eventRoutes = [
  {
    method: "POST",
    pattern: "/v1/venues",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      assertPlannerRole(auth);
      return withIdempotency(req, ctx, `POST:/v1/venues:${auth.userId}`, async () => {
        const { nombre, zona, direccion } = req.body || {};
        const venue = await ctx.store.createVenue({ nombre, zona, direccion });
        return jsonResponse(201, venue);
      });
    },
  },
  {
    method: "GET",
    pattern: "/v1/venues",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      assertPlannerRole(auth);
      const data = await ctx.store.listVenues({
        limit: req.query.limit,
        cursor: req.query.cursor,
      });
      return jsonResponse(200, data);
    },
  },
  {
    method: "POST",
    pattern: "/v1/events",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      assertPlannerRole(auth);
      return withIdempotency(req, ctx, `POST:/v1/events:${auth.userId}`, async () => {
        const { nombre, fecha, timezone, ventana, venue_id: venueId, aforo, requerimientos } =
          req.body || {};
        const created = await ctx.store.createEvent({
          userId: auth.userId,
          nombre,
          fecha,
          timezone,
          ventana,
          venueId,
          aforo,
          requerimientos,
        });
        return jsonResponse(201, created);
      });
    },
  },
  {
    method: "GET",
    pattern: "/v1/events",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      const data = await ctx.store.listEventsForUser({
        userId: auth.userId,
        limit: req.query.limit,
        cursor: req.query.cursor,
      });
      return jsonResponse(200, data);
    },
  },
  {
    method: "GET",
    pattern: "/v1/events/:eventId",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      await ctx.store.authorizeEventAccess({
        userId: auth.userId,
        eventId: req.params.eventId,
      });
      const detail = await ctx.store.getEventDetail({ eventId: req.params.eventId });
      return jsonResponse(200, detail);
    },
  },
  {
    method: "PATCH",
    pattern: "/v1/events/:eventId",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      await ctx.store.authorizeEventAccess({
        userId: auth.userId,
        eventId: req.params.eventId,
        requiredMembershipRoles: ["owner", "editor"],
      });
      const updated = await ctx.store.updateEvent({
        eventId: req.params.eventId,
        patch: req.body || {},
      });
      return jsonResponse(200, updated);
    },
  },
  {
    method: "POST",
    pattern: "/v1/events/:eventId/publish",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      await ctx.store.authorizeEventAccess({
        userId: auth.userId,
        eventId: req.params.eventId,
        requiredMembershipRoles: ["owner"],
      });
      const res = await ctx.store.transitionEvent({
        eventId: req.params.eventId,
        targetState: "publicado",
        actorId: auth.userId,
        now: ctx.now(),
      });
      return jsonResponse(200, res);
    },
  },
  {
    method: "POST",
    pattern: "/v1/events/:eventId/start",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      await ctx.store.authorizeEventAccess({
        userId: auth.userId,
        eventId: req.params.eventId,
        requiredMembershipRoles: ["owner"],
      });
      const res = await ctx.store.transitionEvent({
        eventId: req.params.eventId,
        targetState: "en_curso",
        actorId: auth.userId,
        now: ctx.now(),
      });
      return jsonResponse(200, res);
    },
  },
  {
    method: "POST",
    pattern: "/v1/events/:eventId/cancel",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      await ctx.store.authorizeEventAccess({
        userId: auth.userId,
        eventId: req.params.eventId,
        requiredMembershipRoles: ["owner"],
      });
      const res = await ctx.store.transitionEvent({
        eventId: req.params.eventId,
        targetState: "cancelado",
        actorId: auth.userId,
        motivo: req.body?.motivo || "Cancelado por owner",
        now: ctx.now(),
      });
      return jsonResponse(200, res);
    },
  },
  {
    method: "POST",
    pattern: "/v1/events/:eventId/close",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      await ctx.store.authorizeEventAccess({
        userId: auth.userId,
        eventId: req.params.eventId,
        requiredMembershipRoles: ["owner"],
      });
      const res = await ctx.store.transitionEvent({
        eventId: req.params.eventId,
        targetState: "cerrado",
        actorId: auth.userId,
        motivo: "Cierre de evento",
        now: ctx.now(),
      });
      return jsonResponse(200, res);
    },
  },
  {
    method: "GET",
    pattern: "/v1/events/:eventId/members",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      await ctx.store.authorizeEventAccess({
        userId: auth.userId,
        eventId: req.params.eventId,
      });
      const res = await ctx.store.listEventMembers({
        eventId: req.params.eventId,
        limit: req.query.limit,
        cursor: req.query.cursor,
      });
      return jsonResponse(200, res);
    },
  },
  {
    method: "POST",
    pattern: "/v1/events/:eventId/members",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      await ctx.store.authorizeEventAccess({
        userId: auth.userId,
        eventId: req.params.eventId,
        requiredMembershipRoles: ["owner"],
      });
      return withIdempotency(req, ctx, `POST:/v1/events/${req.params.eventId}/members:${auth.userId}`, async () => {
        const { user_id: targetUserId, email: targetEmail, rol = "editor" } = req.body || {};
        if (!targetUserId && !targetEmail) {
          throw validationError("user_id o email es obligatorio", "email");
        }
        const res = await ctx.store.addEventEditor({
          eventId: req.params.eventId,
          targetUserId,
          targetEmail,
          rol,
        });
        return jsonResponse(201, res);
      });
    },
  },
  {
    method: "DELETE",
    pattern: "/v1/events/:eventId/members/:userId",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      await ctx.store.authorizeEventAccess({
        userId: auth.userId,
        eventId: req.params.eventId,
        requiredMembershipRoles: ["owner"],
      });
      await ctx.store.removeEventEditor({
        eventId: req.params.eventId,
        targetUserId: req.params.userId,
      });
      return jsonResponse(204, null);
    },
  },
  {
    method: "POST",
    pattern: "/v1/events/:eventId/staff-assignments",
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
        `POST:/v1/events/${req.params.eventId}/staff-assignments:${auth.userId}`,
        async () => {
          const { user_id: userId, permisos } = req.body || {};
          if (!userId) throw validationError("user_id obligatorio", "user_id");
          const res = await ctx.store.grantStaffAssignment({
            eventId: req.params.eventId,
            userId,
            permisos,
            grantedByUserId: auth.userId,
            now: ctx.now(),
          });
          return jsonResponse(201, res);
        }
      );
    },
  },
  {
    method: "POST",
    pattern: "/v1/events/:eventId/access-tokens",
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
        `POST:/v1/events/${req.params.eventId}/access-tokens:${auth.userId}`,
        async () => {
          const { rol = "staff" } = req.body || {};
          const res = await ctx.store.createEventAccessToken({
            eventId: req.params.eventId,
            rol,
            emittedByUserId: auth.userId,
          });
          return jsonResponse(201, res);
        }
      );
    },
  },
  {
    method: "PUT",
    pattern: "/v1/events/:eventId/requirements",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      await ctx.store.authorizeEventAccess({
        userId: auth.userId,
        eventId: req.params.eventId,
        requiredMembershipRoles: ["owner", "editor"],
      });
      const res = await ctx.store.replaceEventRequirements({
        eventId: req.params.eventId,
        requerimientos: req.body?.requerimientos,
      });
      return jsonResponse(200, res);
    },
  },
  {
    method: "GET",
    pattern: "/v1/events/:eventId/requirements",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      await ctx.store.authorizeEventAccess({
        userId: auth.userId,
        eventId: req.params.eventId,
      });
      const res = await ctx.store.getEventRequirements({ eventId: req.params.eventId });
      return jsonResponse(200, res);
    },
  },
  {
    method: "GET",
    pattern: "/v1/events/:eventId/alerts",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      await ctx.store.authorizeEventAccess({
        userId: auth.userId,
        eventId: req.params.eventId,
      });
      const items = await ctx.store.listEventAlerts({ eventId: req.params.eventId });
      return jsonResponse(200, { items, next_cursor: null });
    },
  },
];
