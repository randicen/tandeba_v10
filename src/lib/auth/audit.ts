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
 * Counter in-memory de errores de audit (NO persistido).
 * Si el counter sube mucho, indica DB caída o schema incompatible.
 */
let auditErrorCount = 0;

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
  } catch {
    // FIX B2 (audit 2026-06-25): NO loguear e.message. Podría revelar
    // schema info ("no such column: foo") que ayuda a un atacante a
    // mapear la DB. Solo incrementamos un counter y loggeamos el
    // tipo de evento + count. Si el counter sube, alertar.
    auditErrorCount += 1;
    if (auditErrorCount % 100 === 1) {
      console.error(
        `[audit] persist failed x${auditErrorCount} (latest event: ${params.event})`,
      );
    }
  }
}

/**
 * Hooks de Better Auth (databaseHooks) que capturan eventos de auth
 * desde el ciclo de vida de la DB. Se inyectan en `auth.options.databaseHooks`
 * al construir la instancia.
 *
 * Limitación conocida: Better Auth solo expone hooks de create/delete
 * de user/session. Para login_failed y eventos 2FA usamos wraparound
 * de la response en server.ts (FIX M4 audit 2026-06-25).
 *
 * FIX m5 (audit 2026-06-25): tipo inferido de los options de Better
 * Auth (no custom) para que matchee exactamente. Si BA cambia la
 * signature, TypeScript detecta en compile-time.
 */
export function auditDatabaseHooks(): NonNullable<
  Parameters<typeof import("better-auth").betterAuth>[0]["databaseHooks"]
> {
  return {
    user: {
      create: {
        after: async (user) => {
          // BA's User type has many fields; we only need id + email.
          // Cast to our minimal type.
          const u = user as unknown as { id: string; email?: string };
          logAuthEvent({
            event: "signup",
            userId: u.id,
            metadata: { email: u.email ?? null },
          });
        },
      },
    },
    session: {
      create: {
        after: async (session) => {
          const s = session as unknown as { id: string; userId: string };
          logAuthEvent({
            event: "login_success",
            userId: s.userId,
            metadata: { sessionId: s.id },
          });
        },
      },
      delete: {
        before: async (session) => {
          const s = session as unknown as { id: string; userId: string };
          logAuthEvent({
            event: "logout",
            userId: s.userId,
            metadata: { sessionId: s.id },
          });
          return true; // permite el delete
        },
      },
    },
  };
}

// Re-export db para que otros módulos del stack auth puedan usar la
// misma instancia sin re-importar.
export { db } from "../db.js";