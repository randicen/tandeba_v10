/**
 * Worgena — `cleanup_invitations` handler (P0 #5 jobs).
 *
 * Borra `tenant_invitations` que:
 * - Están expiradas hace más de 30 días, O
 * - Fueron usadas (used_at NOT NULL) hace más de 30 días.
 *
 * Payload: `{olderThanMs?: number}` (default 30 días).
 */

import type { JobHandler } from "../handlers/index.js";
import { getDb } from "../../billing/db-instance.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * ONE_DAY_MS;

export const handleCleanupInvitations: JobHandler = async (payload, deps) => {
  const olderThanMs =
    typeof payload.olderThanMs === "number" ? payload.olderThanMs : THIRTY_DAYS_MS;
  const cutoff = Date.now() - olderThanMs;

  const db = deps.db ?? getDb();
  // Borrar:
  // - expired hace >30 días (con o sin used_at)
  // - usadas (used_at NOT NULL) hace >30 días
  const result = db
    .prepare(
      `DELETE FROM tenant_invitations
       WHERE (expires_at < ? AND expires_at > 0)
          OR (used_at IS NOT NULL AND used_at < ?)`,
    )
    .run(cutoff, cutoff);

  console.log(
    `[cleanup_invitations] deleted ${result.changes} tenant_invitations older than ${new Date(cutoff).toISOString()}`,
  );
};
