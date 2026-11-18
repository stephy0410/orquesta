import { createAppContext, flushOutboxNow } from "../../shared/context.js";
import { AppError } from "../../shared/errors.js";
import { errorResponse, jsonResponse, parseHttpRequest } from "../../shared/http.js";
import { authRoutes } from "./routes/auth.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { eventRoutes } from "./routes/events.js";
import { guestRoutes } from "./routes/guests.js";
import { invitationRoutes } from "./routes/invitations.js";
import { paymentRoutes } from "./routes/payments.js";
import { publicRsvpRoutes } from "./routes/public-rsvp.js";
import { scanRoutes } from "./routes/scan.js";
import { seatingRoutes } from "./routes/seating.js";
import { workerRoutes } from "./routes/workers.js";

const ALL_ROUTES = [
  ...authRoutes,
  ...eventRoutes,
  ...guestRoutes,
  ...invitationRoutes,
  ...publicRsvpRoutes,
  ...dashboardRoutes,
  ...seatingRoutes,
  ...workerRoutes,
  ...scanRoutes,
  ...paymentRoutes,
];

function compileRoute(route) {
  const paramNames = [];
  const regexStr = route.pattern
    .split("/")
    .map((seg) => {
      if (seg.startsWith(":")) {
        paramNames.push(seg.slice(1));
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return {
    ...route,
    paramNames,
    regex: new RegExp(`^${regexStr}$`),
  };
}

const COMPILED_ROUTES = ALL_ROUTES.map(compileRoute);

function matchRoute(method, path) {
  for (const r of COMPILED_ROUTES) {
    if (r.method !== method) continue;
    const m = path.match(r.regex);
    if (!m) continue;
    const params = {};
    for (let i = 0; i < r.paramNames.length; i++) {
      params[r.paramNames[i]] = decodeURIComponent(m[i + 1]);
    }
    return { route: r, params };
  }
  return null;
}

let defaultCtxPromise = null;
async function getDefaultContext() {
  if (!defaultCtxPromise) defaultCtxPromise = createAppContext();
  return defaultCtxPromise;
}

export function createApiHandler(ctx) {
  return async function apiHandler(event) {
    let req = null;
    try {
      req = parseHttpRequest(event);

      if (req.method === "OPTIONS") {
        return jsonResponse(204, null);
      }

      if (req.method === "GET" && req.path === "/health") {
        return jsonResponse(200, {
          status: "ok",
          service: "orquesta",
          component: process.env.ORQUESTA_COMPONENT || "api",
          environment: process.env.ENVIRONMENT || "lab",
          db_mode: process.env.DB_MODE || "memory",
        });
      }

      const matched = matchRoute(req.method, req.path);
      if (!matched) {
        throw new AppError("NOT_FOUND", `Ruta no encontrada: ${req.method} ${req.path}`);
      }
      req.params = matched.params;

      const response = await matched.route.handler(req, ctx);

      // Immediate Outbox Flush post-commit (07-system-design §2.3, NFR-03)
      if (
        ctx.autoFlushOutbox &&
        ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
        response.statusCode >= 200 &&
        response.statusCode < 400
      ) {
        await flushOutboxNow(ctx);
      }

      return response;
    } catch (err) {
      return errorResponse(err, req);
    }
  };
}

export const handler = async (event) => {
  const ctx = await getDefaultContext();
  return createApiHandler(ctx)(event);
};
