/**
 * Worgena — Better Auth Express handler (D3.4).
 *
 * Capa 3 de la arquitectura (ver design spec §3): server.ts middleware.
 *
 * Funciones exportadas:
 * - `authHandler`: el handler de Better Auth para `/api/auth/*`. Usar
 *   con `app.all("/api/auth/*", authHandler)`.
 * - `authMiddleware`: middleware para `/api/*` que valida la session
 *   cookie e inyecta `req.user` con `{ id, email, default_tenant_id }`.
 *   Si no hay session válida, retorna 401.
 *
 * CRÍTICO: el handler de Better Auth DEBE montarse ANTES de
 * `express.json()` para que Better Auth pueda parsear los bodies de
 * los callbacks OAuth. Ver docs:
 * https://www.better-auth.com/docs/installation#mount-handler
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./auth.js";

/**
 * Patrón de ruta para las rutas de Better Auth.
 *
 * Express 4 (instalado: 4.22.1): wildcard `*`.
 * Express 5+: wildcard con named syntax `/{*splat}` (path-to-regexp@6).
 *
 * Si el proyecto upgradea a Express 5, cambiar a `/{*splat}`. Por ahora
 * hardcoded a Express 4 para evitar runtime require() en módulo ESM.
 */
export const AUTH_ROUTE_PATTERN = "/api/auth/*";

/**
 * Handler de Better Auth. Mejor Auth expone un handler genérico
 * que cubre todas las rutas bajo AUTH_ROUTE_PATTERN:
 * - GET /api/auth/session
 * - POST /api/auth/sign-in/social (Google OAuth redirect)
 * - GET /api/auth/callback/google (Google OAuth callback)
 * - POST /api/auth/sign-out
 * - etc.
 */
export const authHandler: RequestHandler = toNodeHandler(auth);

/**
 * Middleware que valida la session para rutas protegidas.
 *
 * Si la ruta empieza con `/api/auth/`, deja pasar (es el handler
 * público de Better Auth). Para todo lo demás bajo `/api/*`, exige
 * session válida.
 *
 * Inyecta `req.user` con la forma:
 * {
 *   id: string,
 *   email: string,
 *   emailVerified: boolean,
 *   name: string,
 *   image: string | null,
 *   default_tenant_id: string,
 *   createdAt: Date,
 *   updatedAt: Date,
 * }
 *
 * Esto es lo que `DbAuthProvider` lee en `req.user.default_tenant_id`.
 *
 * NOTA: TypeScript no sabe que mutamos `req.user`. Usamos un cast
 * explícito (escape de tipos deliberado para extender el request).
 * Los callers pueden usar `req.user!` después del middleware.
 */
export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Auth routes son públicas. Express `app.use("/api", mw)` strips
  // el prefijo "/api" del req.path, por eso comparamos sin él.
  if (req.path.startsWith("/auth/") || req.path === "/auth") {
    return next();
  }

  // Health check es público (necesario para monitoring externo).
  if (req.path === "/health") {
    return next();
  }

  try {
    // Convert IncomingHttpHeaders to a Web Headers instance.
    // Better Auth's getSession expects a Web Headers object.
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    const session = await auth.api.getSession({ headers });

    if (!session?.user) {
      res.status(401).json({ error: "UNAUTHORIZED" });
      return;
    }

    // Inyectar user en req. TypeScript no lo permite directo; usamos cast.
    (req as Request & { user?: unknown }).user = session.user;
    next();
  } catch (e) {
    console.error("[authMiddleware] error:", e);
    res.status(500).json({ error: "INTERNAL_AUTH_ERROR" });
  }
}