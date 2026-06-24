/**
 * Worgena Workflow Engine — Auth Provider (D3.3).
 *
 * D3.3: provee el `tenantId` del request al motor.
 * El server.ts es responsable de inyectar la implementación real.
 *
 * Hoy: `StaticTenantProvider('default')` hardcoded.
 * Mañana (D3.4+): `JwtAuthProvider` lee el JWT del request.
 *
 * Spec: `AGENT_D3_3_AUTH_SWEEPER_AUDIT_SPEC.md` §3.1.
 */

/**
 * Proveedor del `tenantId` del request. El motor es provider-agnostic.
 *
 * **D3.3 minimal**: solo necesita `getTenantId`. El método es sync O
 * async (string | Promise<string>). Esto permite que `JwtAuthProvider`
 * (D3.4+) haga I/O asíncrono si necesita (e.g., consultar una DB
 * de usuarios para mapear userId → tenantId).
 *
 * Si el provider retorna undefined o string vacío, el motor tira
 * `MissingTenantIdError` (de D3.2) — el caller del motor es
 * responsable de manejar el error.
 */
export interface AuthProvider {
  getTenantId(): string | Promise<string>;
}

/**
 * Implementación stub: retorna un tenantId hardcoded. Útil para
 * dev/staging y para tests.
 *
 * D3.4+ reemplaza con `JwtAuthProvider` o `SessionCookieAuthProvider`.
 * El motor no cambia.
 */
export class StaticTenantProvider implements AuthProvider {
  constructor(private readonly tenantId: string = "default") {}

  getTenantId(): string {
    return this.tenantId;
  }
}
