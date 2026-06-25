/**
 * Worgena Workflow Engine — Auth Provider (D3.4 redesign).
 *
 * D3.4 rediseño: el `activeFirmId` vive en la SESIÓN activa, no en el
 * user. El middleware `authMiddleware` lo inyecta en `req.activeFirmId`
 * después de validar la session cookie.
 *
 * Flujo:
 * 1. Cliente hace request con session cookie.
 * 2. `authMiddleware` valida session, chequea `activeFirmId`, lo inyecta en `req`.
 * 3. Endpoint crea `new DbAuthProvider(req)` y llama `getTenantId()`.
 * 4. `DbAuthProvider` lee `req.activeFirmId` y lo retorna.
 * 5. Si falta, tira error accionable. Bug del caller.
 *
 * Migración desde D3.4 original (single-user-per-firm): el código viejo
 * leía `req.user.default_tenant_id`. Eso se eliminó en el rediseño.
 *
 * Concurrencia: el provider es stateless. Cada request crea su propio
 * provider con su propio `req`. No hay cache ni state compartido.
 */

import type { Request } from "express";
import type { AuthProvider } from "./auth-provider.js";

/**
 * AuthProvider que lee el `activeFirmId` del request validado.
 *
 * El middleware (`authMiddleware` en `src/lib/auth/handlers.ts`) ya
 * validó la session Y chequeó que activeFirmId exista. Si llegamos
 * acá sin `activeFirmId`, es un bug del caller.
 */
export class DbAuthProvider implements AuthProvider {
  constructor(private readonly req: Request) {}

  getTenantId(): string {
    const activeFirmId = (
      this.req as Request & { activeFirmId?: string }
    ).activeFirmId;

    if (!activeFirmId) {
      throw new Error(
        "DbAuthProvider invoked on request without activeFirmId. " +
          "Did authMiddleware() run before this endpoint? " +
          "If yes, the user may not have completed onboarding. " +
          "Check the session's activeFirmId field.",
      );
    }

    return activeFirmId;
  }
}
