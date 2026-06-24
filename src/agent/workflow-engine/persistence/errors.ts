/**
 * Worgena Workflow Engine — Persistencia D3.2: Errores.
 *
 * `MissingTenantIdError` se lanza cuando una operación del `TaskStore`
 * recibe `tenantId` undefined. D3.2 hace el param OBLIGATORIO en la
 * interface para forzar a los callers a pensar en multi-tenant.
 *
 * Spec: `AGENT_D3_2_MULTI_TENANT_SPEC.md` §2.5.
 */

export class MissingTenantIdError extends Error {
  constructor(method: string) {
    super(
      `TaskStore.${method}() requiere tenantId (D3.2 strict). ` +
        `Pasá task.tenantId o un string explícito. ` +
        `Para acceso cross-tenant (admin), esperá a D3.3 que introduce ` +
        `loadCrossTenant() / loadAllTenantsActive() con flag de capacidad.`,
    );
    this.name = "MissingTenantIdError";
    Object.setPrototypeOf(this, MissingTenantIdError.prototype);
  }
}
