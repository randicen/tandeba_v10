/**
 * Worgena — Auth audit hook (D3.5).
 *
 * Persiste eventos de auth a la tabla `audit_auth` (append-only).
 *
 * Eventos cubiertos:
 * - `login_success`: cuando Better Auth crea una session válida.
 * - `logout`: cuando Better Auth elimina una session.
 * - `login_failed`: cuando el sign-in falla (HTTP >= 400 en /api/auth/*).
 * - `signup`: cuando se crea un user nuevo (D3.4 mapProfileToUser).
 *
 * **P4 del sprint spec D3.5: el hook NO bloquea el flow.** Si la DB
 * falla al insertar, se loguea a stderr pero el user sigue logueado.
 * Audit es observabilidad, no feature crítica.
 *
 * Forward-compat: en D6+ podemos agregar eventos de 2FA (enabled,
 * disabled, verified, backup_code_used). Hoy no los capturamos porque
 * `databaseHooks` de Better Auth solo cubre create/delete de
 * user/session.
 */

import type Database from "better-sqlite3";
import { db } from "../db.js";

/**
 * Eventos válidos de audit_auth. Si agregás uno nuevo, también
 * agregalo a la tabla `audit_auth` y a este enum (TS).
 */
export type AuthAuditEvent =
  | "login_success"
  | "login_failed"
  | "logout"
  | "signup"
  | "two_factor_enabled"
  | "two_factor_disabled"
  | "two_factor_verified";

/**
 * Persiste un evento de auth a la tabla `audit_auth`.
 *
 * Si la DB falla, loguea a stderr pero NO throw. El caller no debe
 * romper el flow de auth por un fallo de audit.
 */
export function logAuthEvent(params: {
  event: AuthAuditEvent;
  userId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}): void {
  try {
    db.prepare(
      `INSERT INTO audit_auth (id, user_id, event, ip, user_agent, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      params.userId ?? null,
      params.event,
      params.ip ?? null,
      params.userAgent ?? null,
      params.metadata ? JSON.stringify(params.metadata) : null,
      Date.now(),
    );
  } catch (e) {
    // Log a stderr pero NO throw. Audit es observabilidad.
    console.error(
      "[audit] failed to persist event:",
      params.event,
      (e as Error).message,
    );
  }
}

/**
 * Hooks de Better Auth (databaseHooks) que capturan eventos de auth
 * desde el ciclo de vida de la DB. Se inyectan en `auth.options.databaseHooks`
 * al construir la instancia.
 *
 * Limitación conocida: Better Auth solo expone hooks de create/delete
 * de user/session. Para login_failed y eventos 2FA usamos el
 * middleware `auditAuthRequests` (abajo).
 */
export function auditDatabaseHooks(): NonNullable<
  Parameters<typeof import("better-auth").betterAuth>[0]["databaseHooks"]
> {
  return {
    user: {
      create: {
        after: async (user) => {
          logAuthEvent({
            event: "signup",
            userId: user.id,
            metadata: { email: user.email },
          });
        },
      },
    },
    session: {
      create: {
        after: async (session) => {
          logAuthEvent({
            event: "login_success",
            userId: session.userId,
            metadata: { sessionId: session.id },
          });
        },
      },
      delete: {
        before: async (session) => {
          logAuthEvent({
            event: "logout",
            userId: session.userId,
            metadata: { sessionId: session.id },
          });
          return true; // permite el delete
        },
      },
    },
  };
}

/**
 * Middleware Express que captura login_failed en /api/auth/*.
 * Better Auth no expone hook nativo para esto (su endpoints /sign-in
 * retornan error sin distinguir "user no existe" de "password
 * incorrecto" — pero el response status es 4xx, suficiente para
 * distinguir success vs failure).
 *
 * Uso en server.ts:
 * ```ts
 * app.use("/api/auth", auditAuthRequests, authHandler);
 * ```
 *
 * ⚠️ NOTA: este middleware NO se implementa en D3.5 inicial. La razón
 * es que `app.use` con middleware async + handler es complejo en
 * Express, y Better Auth tiene sus propios hooks que cubren los
 * eventos críticos (create session, delete session, create user).
 *
 * Forward-compat: si en D6 un enterprise pide audit de failed logins,
 * agregar este middleware. Por ahora, audit cubre:
 * - signup (databaseHooks.user.create.after)
 * - login_success (databaseHooks.session.create.after)
 * - logout (databaseHooks.session.delete.before)
 *
 * login_failed queda logged a stdout por Better Auth pero NO
 * persistido en audit_auth. Trade-off aceptado en MVP.
 */
export function auditAuthRequests(
  _req: import("express").Request,
  _res: import("express").Response,
  next: import("express").NextFunction,
): void {
  // Por ahora no-op. Ver doc arriba.
  next();
}

// Re-export db para que otros módulos del stack auth puedan usar la
// misma instancia sin re-importar.
export { db } from "../db.js";

// Silenciar warning de unused import (Database) — type-only re-export
// útil para callers que quieran tipar el parámetro.
export type { Database };