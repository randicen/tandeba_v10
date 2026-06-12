/**
 * apify-tracker.ts
 * -----------------------------------------------------------------------------
 * Loguea cada llamada a `apify_scrape_url` con costo estimado a la DB.
 *
 * Por qué: el costo real de Apify solo lo ve el admin en el dashboard externo.
 * El usuario quiere captura local para poder agregar por sesión / por firma /
 * por período sin tener que entrar al dashboard.
 *
 * Cost estimation:
 *   - Por default, $0.005 USD por call (conservador para plan Starter).
 *   - Configurable via env `APIFY_COST_PER_CALL_USD` (ej. 0.01 si tu plan
 *     es más caro, 0.002 si tenés tier alto).
 *   - En el futuro se puede mejorar leyendo el runUsage del actor, pero
 *     hoy Apify no expone eso de forma trivial.
 *
 * Tabla: `apify_usage` (ver migración en src/lib/db.ts).
 *   - Por sesión
 *   - Con timestamp
 *   - Con success/failure flag
 *   - Con result_size_bytes (proxy de qué tan pesada fue la call)
 *
 * Tests: test_apify_tracker.mts
 */

import { pool } from "./db.js";

export interface ApifyUsageRecord {
  sessionId: string;
  targetUrl: string;
  success: boolean;
  durationMs: number;
  resultSizeBytes: number | null;
  errorMessage: string | null;
}

/**
 * Lee el costo por call configurado. Default $0.005 USD.
 */
function getCostPerCallUsd(): number {
  const envValue = process.env.APIFY_COST_PER_CALL_USD;
  if (envValue) {
    const parsed = parseFloat(envValue);
    if (!isNaN(parsed) && parsed >= 0) return parsed;
  }
  return 0.005;
}

/**
 * Loguea una llamada a Apify. Safe: si la DB falla, solo loguea warning
 * sin propagar el error (queremos que el flujo de scraping no se rompa
 * porque el tracking falló).
 */
export async function logApifyUsage(record: ApifyUsageRecord): Promise<void> {
  try {
    const costUsd = getCostPerCallUsd();
    await pool.query(
      `INSERT INTO apify_usage
         (session_id, target_url, called_at, success, error_message, duration_ms, result_size_bytes, cost_estimate_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.sessionId,
        record.targetUrl,
        Date.now(),
        record.success ? 1 : 0,
        record.errorMessage,
        record.durationMs,
        record.resultSizeBytes,
        costUsd,
      ]
    );
  } catch (e: any) {
    // No propagar — el tracking no debe romper el flujo de scraping.
    console.warn(`[APIFY-TRACKER] failed to log usage: ${e.message}`);
  }
}

/**
 * Helper: agrega el costo total en un período (útil para reportes ad-hoc).
 */
export async function getApifyUsageTotal(
  sinceMs: number,
  untilMs: number = Date.now()
): Promise<{ calls: number; costUsd: number; successCount: number; errorCount: number }> {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) as calls,
       COALESCE(SUM(cost_estimate_usd), 0) as cost_usd,
       COALESCE(SUM(success), 0) as success_count,
       COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) as error_count
     FROM apify_usage
     WHERE called_at >= ? AND called_at <= ?`,
    [sinceMs, untilMs]
  );
  const r = (rows[0] || {}) as any;
  return {
    calls: Number(r.calls || 0),
    costUsd: Number(r.cost_usd || 0),
    successCount: Number(r.success_count || 0),
    errorCount: Number(r.error_count || 0),
  };
}

/**
 * Helper: agrega el costo por sesión.
 */
export async function getApifyUsageBySession(
  sessionId: string
): Promise<{ calls: number; costUsd: number }> {
  const { rows } = await pool.query(
    `SELECT COUNT(*) as calls, COALESCE(SUM(cost_estimate_usd), 0) as cost_usd
     FROM apify_usage WHERE session_id = ?`,
    [sessionId]
  );
  const r = (rows[0] || {}) as any;
  return { calls: Number(r.calls || 0), costUsd: Number(r.cost_usd || 0) };
}
