/**
 * Worgena — Job handlers registry (P0 #5 jobs v1).
 *
 * Map de `type → handler`. El worker despacha según este map.
 *
 * Spec: AGENT_JOBS_V1_SPEC.md §2.O5.
 *
 * Patrón: cada handler es `async (payload, deps) => Promise<void>`.
 * Si throw, el worker llama `markJobFailed` con willRetry según
 * `attempts < MAX_JOB_ATTEMPTS`. `deps` contiene `db` y `email`
 * (inyectados por el worker).
 */

import type Database from "better-sqlite3";
import type { EmailProvider } from "../../email/provider.js";
import type { JobType } from "../repository.js";
import { handleSendInvitationEmail } from "./send-invitation-email.js";
import { handleEnforceCreditWarning } from "./enforce-credit-warning.js";
import { handleCleanupAudit } from "./cleanup-audit.js";
import { handleCleanupInvitations } from "./cleanup-invitations.js";
import { handleSendEmailGeneric } from "./send-email-generic.js";

/**
 * Dependencias inyectadas al handler. Forward-compat: agregar más
 * servicios (logger, metrics) sin cambiar signature.
 */
export interface HandlerDeps {
  db: Database.Database;
  email: EmailProvider;
  /** Config del worker (opcional). */
  config?: {
    publicUrl?: string;
  };
}

export type JobHandler = (
  payload: Record<string, unknown>,
  deps: HandlerDeps,
) => Promise<void>;

/**
 * Registry central. Cada type registrado aquí es despachable.
 * El worker falla loud si llega un type desconocido (bug nuestro,
 * no del job).
 */
export const HANDLERS: Readonly<Record<JobType, JobHandler>> = {
  send_invitation_email: handleSendInvitationEmail,
  enforce_credit_warning: handleEnforceCreditWarning,
  cleanup_audit: handleCleanupAudit,
  cleanup_invitations: handleCleanupInvitations,
  send_email_generic: handleSendEmailGeneric,
};

/**
 * Helper: lista los job types conocidos. Útil para el startup del
 * worker y para validación en tests.
 */
export const JOB_TYPES: ReadonlyArray<JobType> = Object.keys(HANDLERS) as JobType[];
