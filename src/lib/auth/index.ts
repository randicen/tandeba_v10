/**
 * Worgena — Auth module barrel (D3.4).
 *
 * Re-exports del stack de Better Auth. server.ts importa de acá,
 * no de los archivos internos, para mantener una superficie pública
 * mínima y forward-compat con migraciones a otro provider (D3.6+).
 */

export { auth, runBetterAuthMigrations } from "./auth.js";
export { authHandler, authMiddleware, AUTH_ROUTE_PATTERN } from "./handlers.js";
export { logAuthEvent, auditDatabaseHooks } from "./audit.js";
export type { AuthAuditEvent } from "./audit.js";

// D3.4 redesign: firm management. El server.ts importa de acá.
// Inicializa el default db al worgena.db real para que las funciones
// sin parámetro `dbInstance` operen sobre la DB correcta.
import { db as defaultWorgenaDb } from "../db.js";
import { setDefaultDb } from "./firm.js";
setDefaultDb(defaultWorgenaDb);

export {
  createFirm,
  joinFirmViaInvite,
  createInvitation,
  revokeInvitation,
  getUserFirms,
  getSingleActiveFirmId,
  listMembers,
  getFirm,
  isMemberOf,
} from "./firm.js";
export type {
  Tenant,
  TenantMember,
  TenantInvitation,
  FirmWithRole,
  FirmMember,
  FirmRole,
} from "./firm.js";