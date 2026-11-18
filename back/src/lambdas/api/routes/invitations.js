import { validationError } from "../../../shared/errors.js";
import { authenticateUser, jsonResponse, withIdempotency } from "../../../shared/http.js";

export const invitationRoutes = [
  {
    method: "GET",
    pattern: "/v1/events/:eventId/invitations/pending-summary",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      await ctx.store.authorizeEventAccess({
        userId: auth.userId,
        eventId: req.params.eventId,
      });
      const summary = await ctx.store.getPendingSendSummary({ eventId: req.params.eventId });
      return jsonResponse(200, summary);
    },
  },
  {
    method: "POST",
    pattern: "/v1/events/:eventId/invitations/send",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      await ctx.store.authorizeEventAccess({
        userId: auth.userId,
        eventId: req.params.eventId,
        requiredMembershipRoles: ["owner"],
      });
      return withIdempotency(
        req,
        ctx,
        `POST:/v1/events/${req.params.eventId}/invitations/send:${auth.userId}`,
        async () => {
          const {
            alcance = "pendiente_envio",
            guest_ids: guestIds = [],
            destinatarios_confirmados: destinatariosConfirmados,
          } = req.body || {};
          if (!["pendiente_envio", "seleccion"].includes(alcance)) {
            throw validationError("alcance debe ser 'pendiente_envio' o 'seleccion'", "alcance");
          }
          const res = await ctx.store.dispatchInvitationSend({
            eventId: req.params.eventId,
            alcance,
            guestIds,
            destinatariosConfirmados,
            canalesActivos: ctx.canalesActivos,
            actorId: auth.userId,
            now: ctx.now(),
          });
          return jsonResponse(202, res);
        }
      );
    },
  },
  {
    method: "POST",
    pattern: "/v1/events/:eventId/invitations/resend",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      await ctx.store.authorizeEventAccess({
        userId: auth.userId,
        eventId: req.params.eventId,
        requiredMembershipRoles: ["owner"],
      });
      return withIdempotency(
        req,
        ctx,
        `POST:/v1/events/${req.params.eventId}/invitations/resend:${auth.userId}`,
        async () => {
          const { guest_ids: guestIds = [], canal = "ambos", ventana = "resend_1" } = req.body || {};
          if (!Array.isArray(guestIds) || guestIds.length === 0) {
            throw validationError("guest_ids requerido", "guest_ids");
          }
          const res = await ctx.store.dispatchInvitationResend({
            eventId: req.params.eventId,
            guestIds,
            canal,
            ventana,
            canalesActivos: ctx.canalesActivos,
            actorId: auth.userId,
            now: ctx.now(),
          });
          return jsonResponse(202, res);
        }
      );
    },
  },
  {
    method: "GET",
    pattern: "/v1/events/:eventId/invitations/deliveries",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      await ctx.store.authorizeEventAccess({
        userId: auth.userId,
        eventId: req.params.eventId,
      });
      const res = await ctx.store.listDeliveries({
        eventId: req.params.eventId,
        estado: req.query.estado || null,
        canal: req.query.canal || null,
        limit: req.query.limit,
        cursor: req.query.cursor,
      });
      return jsonResponse(200, res);
    },
  },
  {
    method: "POST",
    pattern: "/v1/events/:eventId/invitations/:invitationId/regenerate",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      await ctx.store.authorizeEventAccess({
        userId: auth.userId,
        eventId: req.params.eventId,
        requiredMembershipRoles: ["owner", "editor"],
      });
      const res = await ctx.store.regenerateInvitationTokens({
        eventId: req.params.eventId,
        invitationId: req.params.invitationId,
        qrSigner: ctx.qrSigner,
        objectStorage: ctx.objectStorage,
        assetsBucket: ctx.assetsBucket,
        now: ctx.now(),
      });
      return jsonResponse(200, res);
    },
  },
];
