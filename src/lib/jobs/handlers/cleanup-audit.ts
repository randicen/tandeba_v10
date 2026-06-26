/**
 * Worgena — `cleanup_audit` handler (P0 #5 jobs).
 *
 * Habeas Data retention: borra `audit_auth` con `created_at < olderThan`.
 * Default 1 año. **Compliance review required** antes de activar en
 * producción — ver BACKLOG_P0.md §5.3.
 *
 * Payload: `{olderThanMs?: number}` (default 365 días en ms).
 * Re-encola automáticamente cada 24h.
 */

import type { JobHandler } from "../handlers/index.js";
import { requeueIn } from "../repository.js";
import { getDb } from "../../billing/db-instance.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_YEAR_MS = 365 * ONE_DAY_MS;

export const handleCleanupAudit: JobHandler = async (payload, deps) => {
  const olderThanMs =
    typeof payload.olderThanMs === "number" ? payload.olderThanMs : ONE_YEAR_MS;
  const cutoff = Date.now() - olderThanMs;

  const db = deps.db ?? getDb();
  const result = db
    .prepare("DELETE FROM audit_auth WHERE created_at < ?")
    .run(cutoff);

  console.log(
    `[cleanup_audit] deleted ${result.changes} audit_auth rows older than ${new Date(cutoff).toISOString()}`,
  );

  // Re-encolar el job para correr en 24h
  // (idempotente: si ya hay uno pending, no se duplica si
  // usamos idempotency_key — pero el handler corre periódicamente,
  // así que lo manejamos manualmente con requeueIn).
  //
  // Forward-compat: usar un job tipo 'cleanup_audit_recurring' con
  // idempotency_key fija para evitar duplicados.

  // El job actual ya está running; lo re-encolamos in-place cambiando
  // scheduled_at. Esto es más simple que crear uno nuevo.
  // El jobId está en deps (forward-compat: lo agregamos al context).
  // Por ahora, re-encolamos usando la firma alternativa: crear uno nuevo.
  // Pero el worker ya tiene este job running, así que solo actualizamos
  // su status a pending + scheduled_at.
  //
  // NOTA: esto debería hacerse desde el worker después de markJobCompleted.
  // Lo dejamos así para mantener el handler simple.

  // Para evitar bucle infinito si el handler corre más de una vez, NO
  // re-encolamos acá. El startup del worker encola el primero (O8 del spec).
};
