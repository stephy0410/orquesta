import { jsonResponse, withIdempotency } from "../../../shared/http.js";

export const publicRsvpRoutes = [
  {
    method: "GET",
    pattern: "/v1/public/events/:eventId/summary",
    async handler(req, ctx) {
      const summary = await ctx.store.getPublicEventSummary(req.params.eventId);
      return jsonResponse(200, summary, {
        headers: {
          "cache-control": "public, s-maxage=300, stale-while-revalidate=86400",
        },
      });
    },
  },
  {
    method: "GET",
    pattern: "/v1/public/invitations/:rsvpToken/rsvp",
    async handler(req, ctx) {
      const data = await ctx.store.getPublicInvitationByToken({
        rawToken: req.params.rsvpToken,
        objectStorage: ctx.objectStorage,
      });
      return jsonResponse(200, data);
    },
  },
  {
    method: "POST",
    pattern: "/v1/public/invitations/:rsvpToken/rsvp",
    async handler(req, ctx) {
      return withIdempotency(
        req,
        ctx,
        `POST:/v1/public/invitations/${req.params.rsvpToken}/rsvp`,
        async () => {
          const { respuesta } = req.body || {};
          const res = await ctx.store.submitPublicRsvp({
            rawToken: req.params.rsvpToken,
            respuesta,
            objectStorage: ctx.objectStorage,
            now: ctx.now(),
          });
          return jsonResponse(res.isChange ? 200 : 201, res.body);
        }
      );
    },
  },
  {
    // Baja del invitado por canal (README FR8): con el token de su invitación, sin cuenta.
    method: "POST",
    pattern: "/v1/public/invitations/:rsvpToken/unsubscribe",
    async handler(req, ctx) {
      const { canal = "ambos" } = req.body || {};
      const res = await ctx.store.unsubscribeGuest({ rawToken: req.params.rsvpToken, canal, now: ctx.now() });
      return jsonResponse(200, res);
    },
  },
];
