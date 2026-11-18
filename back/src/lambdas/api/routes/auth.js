import {
  generateOpaqueToken,
  hashPassword,
  signSessionJwt,
  verifyPassword,
} from "../../../shared/crypto.js";
import { normalizeEmail } from "../../../shared/domain-helpers.js";
import { AppError, validationError } from "../../../shared/errors.js";
import {
  authenticateUser,
  buildSessionCookie,
  clearSessionCookie,
  jsonResponse,
  withIdempotency,
} from "../../../shared/http.js";
import { ulid } from "../../../shared/ulid.js";

export const authRoutes = [
  {
    method: "POST",
    pattern: "/v1/auth/register",
    async handler(req, ctx) {
      const { email, password } = req.body || {};
      const normalized = normalizeEmail(email);
      if (!normalized) throw validationError("email inválido", "email");
      if (typeof password !== "string" || password.length < 8) {
        throw validationError("password debe tener al menos 8 caracteres", "password");
      }

      const passwordHash = await hashPassword(password);
      const user = await ctx.store.createUser({
        email: normalized,
        roles: ["planner"],
        passwordHash,
      });

      const rawToken = generateOpaqueToken("vfy_", 24);
      const expiraEn = new Date(ctx.now().getTime() + 72 * 60 * 60 * 1000);
      await ctx.store.createChallenge({
        userId: user.id,
        proposito: "verify_email",
        canal: "email",
        destino: normalized,
        codigoRaw: rawToken,
        expiraEn,
      });

      await ctx.queueBus.publishNotification(
        {
          event_type: "verify_email",
          user_id: user.id,
          to: normalized,
          token: rawToken,
        },
        "email"
      );

      return jsonResponse(201, {
        user_id: user.id,
        email: user.email,
        email_verificado: false,
      });
    },
  },
  {
    method: "POST",
    pattern: "/v1/auth/worker/register",
    async handler(req, ctx) {
      return withIdempotency(req, ctx, "POST:/v1/auth/worker/register", async () => {
        const { email, password, tipo = "persona" } = req.body || {};
        const normalized = normalizeEmail(email);
        if (!normalized) throw validationError("email inválido", "email");
        if (typeof password !== "string" || password.length < 8) {
          throw validationError("password debe tener al menos 8 caracteres", "password");
        }
        if (!["persona", "empresa"].includes(tipo)) {
          throw validationError("tipo debe ser 'persona' o 'empresa'", "tipo");
        }

        const passwordHash = await hashPassword(password);
        const user = await ctx.store.createUser({
          email: normalized,
          roles: ["worker"],
          passwordHash,
        });

        const rawToken = generateOpaqueToken("vfy_", 24);
        const expiraEn = new Date(ctx.now().getTime() + 72 * 60 * 60 * 1000);
        await ctx.store.createChallenge({
          userId: user.id,
          proposito: "verify_email",
          canal: "email",
          destino: normalized,
          codigoRaw: rawToken,
          expiraEn,
        });

        await ctx.queueBus.publishNotification(
          {
            event_type: "verify_email",
            user_id: user.id,
            to: normalized,
            token: rawToken,
            tipo,
          },
          "email"
        );

        return jsonResponse(201, {
          user_id: user.id,
          email: user.email,
          estado_email: "pendiente",
        });
      });
    },
  },
  {
    method: "POST",
    pattern: "/v1/auth/verify-email",
    async handler(req, ctx) {
      const { token } = req.body || {};
      if (!token || typeof token !== "string") {
        throw validationError("token es obligatorio", "token");
      }
      const res = await ctx.store.confirmEmailChallenge(token, ctx.now());
      return jsonResponse(200, { email_verificado: res.email_verificado });
    },
  },
  {
    method: "POST",
    pattern: "/v1/auth/login",
    async handler(req, ctx) {
      const { email, password } = req.body || {};
      const normalized = normalizeEmail(email);
      if (!normalized || typeof password !== "string" || !password) {
        throw validationError("email y password requeridos", "email");
      }

      const user = await ctx.store.findUserByEmail(normalized);
      if (!user || user.deleted_at) {
        throw new AppError("INVALID_CREDENTIALS", "Credenciales inválidas");
      }
      const valid = await verifyPassword(password, user.password_hash);
      if (!valid) {
        throw new AppError("INVALID_CREDENTIALS", "Credenciales inválidas");
      }
      if (!user.email_verificado_en) {
        throw new AppError("EMAIL_NOT_VERIFIED", "Debes verificar tu email antes de iniciar sesión");
      }

      const ttl = 86400;
      const jwt = signSessionJwt(
        {
          sub: user.id,
          roles: user.roles,
          token_type: "user_session",
          jti: ulid(),
        },
        ctx.sessionSecret,
        ttl,
        ctx.now().getTime()
      );

      return jsonResponse(
        200,
        {
          access_token: jwt,
          token_type: "Bearer",
          expires_in: ttl,
          user: { id: user.id, roles: user.roles },
        },
        { cookies: [buildSessionCookie(jwt, ttl)] }
      );
    },
  },
  {
    method: "POST",
    pattern: "/v1/auth/password-reset",
    async handler(req, ctx) {
      const { email } = req.body || {};
      const normalized = normalizeEmail(email);
      if (!normalized) throw validationError("email inválido", "email");

      const user = await ctx.store.findUserByEmail(normalized);
      if (user && !user.deleted_at) {
        const rawToken = generateOpaqueToken("rst_", 24);
        const expiraEn = new Date(ctx.now().getTime() + 72 * 60 * 60 * 1000);
        await ctx.store.createChallenge({
          userId: user.id,
          proposito: "password_reset",
          canal: "email",
          destino: normalized,
          codigoRaw: rawToken,
          expiraEn,
        });
        await ctx.queueBus.publishNotification(
          {
            event_type: "password_reset",
            user_id: user.id,
            to: normalized,
            token: rawToken,
          },
          "email"
        );
      }

      // Siempre 202 sin enumeración de usuarios (03a §2.1)
      return jsonResponse(202, {});
    },
  },
  {
    method: "POST",
    pattern: "/v1/auth/password-reset/confirm",
    async handler(req, ctx) {
      const { token, password } = req.body || {};
      if (!token || typeof token !== "string") throw validationError("token obligatorio", "token");
      if (typeof password !== "string" || password.length < 8) {
        throw validationError("password debe tener al menos 8 caracteres", "password");
      }
      const passwordHash = await hashPassword(password);
      await ctx.store.confirmPasswordReset(token, passwordHash, ctx.now());
      return jsonResponse(204, null);
    },
  },
  {
    method: "POST",
    pattern: "/v1/auth/logout",
    async handler(req, ctx) {
      const auth = await authenticateUser(req, ctx);
      await ctx.store.revokeSessionJti(auth.jti, auth.claims.exp);
      return jsonResponse(204, null, { cookies: [clearSessionCookie()] });
    },
  },
  {
    method: "POST",
    pattern: "/v1/auth/event-session",
    async handler(req, ctx) {
      const { access_token: accessToken, qr_token: qrToken, device_id: deviceId } = req.body || {};
      const token = accessToken || qrToken;
      if (!token || !deviceId) {
        throw validationError("access_token y device_id son obligatorios", "access_token");
      }
      const exchanged = await ctx.store.exchangeEventAccessToken({
        rawToken: token,
        deviceId,
        now: ctx.now(),
      });
      const expSec = Math.floor(new Date(exchanged.expira_en).getTime() / 1000);
      const sessionToken = signSessionJwt(
        {
          sub: exchanged.session_id,
          token_type: "event_session",
          session_id: exchanged.session_id,
          event_id: exchanged.event_id,
          rol: exchanged.rol,
          device_id: deviceId,
          access_token_id: exchanged.access_token_id,
          actor_id: exchanged.actor_id,
          exp: expSec,
        },
        ctx.sessionSecret,
        86400,
        ctx.now().getTime()
      );

      return jsonResponse(200, {
        session_token: sessionToken,
        session_id: exchanged.session_id,
        event_id: exchanged.event_id,
        rol: exchanged.rol,
        expira_en: exchanged.expira_en,
      });
    },
  },
];
