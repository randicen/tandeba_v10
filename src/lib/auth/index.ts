/**
 * Worgena — Auth module barrel (D3.4).
 *
 * Re-exports del stack de Better Auth. server.ts importa de acá,
 * no de los archivos internos, para mantener una superficie pública
 * mínima y forward-compat con migraciones a otro provider (D3.6+).
 */

export { auth, runBetterAuthMigrations } from "./auth.js";
export { authHandler, authMiddleware, AUTH_ROUTE_PATTERN } from "./handlers.js";