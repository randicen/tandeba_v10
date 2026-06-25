/**
 * Worgena Workflow Engine — Auth Provider (D3.4): DbAuthProvider.
 *
 * D3.3 introdujo la interface `AuthProvider` con un stub
 * `StaticTenantProvider('default')` hardcoded. D3.4 implementa
 * `DbAuthProvider` que lee el `tenantId` del request HTTP validado.
 *
 * Spec: `AGENT_D3_4_SPRINT_SPEC.md` §5 (diseño) +
 *       `AGENT_D3_4_5_DB_AUTH_SPEC.md` §4.5 (sketch).
 *
 * Flujo:
 * 1. Cliente hace request a `/api/sessions` con cookie de session.
 * 2. `authMiddleware` (de src/lib/auth/handlers.ts) valida la cookie
 *    vía `auth.api.getSession()` e inyecta `req.user` con la shape
 *    `{ id, email, default_tenant_id, ... }`.
 * 3. El endpoint crea `new DbAuthProvider(req)` y llama `getTenantId()`.
 * 4. `DbAuthProvider` lee `req.user.default_tenant_id` y lo retorna.
 * 5. Si no hay `req.user` (middleware no corrió, o falló), tira error
 *    loud con mensaje accionable. Esto es un bug del caller — el
 *    middleware debería haber rechazado con 401 antes.
 *
 * Concurrencia / multi-request: el provider es stateless. Cada request
 * crea su propio provider con su propio `req`. No hay cache ni state
 * compartido entre requests (eso es responsabilidad del motor).
 */

import type { Request } from "express";
import type { AuthProvider } from "./auth-provider.js";

/**
 * Shape mínima del `req.user` que el middleware inyecta.
 *
 * Esto es un subset del tipo `User` que retorna Better Auth. Solo
 * nos importa `default_tenant_id` para el motor; el resto lo lee
 * cada endpoint según necesite (email para notificaciones, name
 * para UI, etc.).
 */
interface AuthenticatedUser {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  image: string | null;
  default_tenant_id: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * AuthProvider que lee el `tenantId` del request HTTP validado.
 *
 * El middleware (`authMiddleware` en `src/lib/auth/handlers.ts`) ya
 * validó la session y rechazó con 401 si no era válida. Si llegamos
 * a este provider sin `req.user`, es un bug del caller (el endpoint
 * no montó el middleware, o lo montó mal).
 */
export class DbAuthProvider implements AuthProvider {
  constructor(private readonly req: Request) {}

  getTenantId(): string {
    const user = (this.req as Request & { user?: AuthenticatedUser }).user;

    if (!user) {
      throw new Error(
        "DbAuthProvider invoked on unauthenticated request. " +
          "Did authMiddleware() run before this endpoint? " +
          "Check that the route is mounted under app.use('/api', authMiddleware).",
      );
    }

    if (!user.default_tenant_id || user.default_tenant_id.trim() === "") {
      // Caso raro: user autenticado pero sin tenantId. Podría pasar
      // si la columna `default_tenant_id` no se seteó al crear el user
      // (bug de migración o signup custom). Tiramos loud.
      throw new Error(
        `DbAuthProvider: authenticated user ${user.id} has empty default_tenant_id. ` +
          "This is a data integrity bug — the user should have a tenant. " +
          "Check the auth_user.default_tenant_id column.",
      );
    }

    return user.default_tenant_id;
  }
}