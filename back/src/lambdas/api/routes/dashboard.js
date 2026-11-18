import { authenticateUser, jsonResponse } from "../../../shared/http.js";

export const dashboardRoutes = [
  {
    method: "GET",
    pattern: "/v1/dashboard",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      const data = await ctx.store.getDashboard({
        userId: auth.userId,
        limit: req.query.limit ?? 25,
        cursor: req.query.cursor || null,
        now: ctx.now(),
      });
      return jsonResponse(200, data);
    },
  },
];
