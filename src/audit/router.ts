/**
 * Router de auditoría de runs del agente (Worgena).
 * -----------------------------------------------------------------------------
 * Endpoints para que nosotros (no el usuario final) consultemos los runs
 * almacenados: lista de runs, detalle de uno, exportación a JSON.
 *
 * Cada run = una sesión. Cada step = una llamada al LLM. Cada tool call = una
 * herramienta ejecutada. prompt_sent y raw_response están disponibles en el
 * detalle completo (pueden ser grandes, ~10-100KB por step).
 *
 * Filtros soportados en /api/audit/runs:
 *   - since=<ms>            solo runs con start_time >= since
 *   - until=<ms>            solo runs con start_time <= until
 *   - minTokens=<n>         solo runs con total_tokens >= n
 *   - maxTokens=<n>         solo runs con total_tokens <= n
 *   - status=error          solo runs con al menos un step en error
 *   - model=<modelo>        solo runs cuyo step más reciente use ese modelo
 *   - limit=<n>             máximo de runs a retornar (default 100)
 */
import { Router } from 'express';
import { pool } from '../lib/db.js';
import { getSessionMetrics } from '../agent/logger.js';

interface RunSummary {
  sessionId: string;
  sessionName: string | null;
  spaceId: string | null;
  createdAt: number;
  updatedAt: number;
  totalSteps: number;
  completedSteps: number;
  errorSteps: number;
  totalTokens: number;
  totalApiMs: number;
  totalToolMs: number;
  totalDurationMs: number;
  avgStepMs: number;
  status: 'idle' | 'running' | 'waiting_human' | 'error';
  model: string | null;
  firstUserMessage: string | null;
}

const router = Router();

/**
 * GET /api/audit/runs
 * Lista runs con métricas agregadas. Soporta filtros via query string.
 */
router.get('/runs', async (req, res) => {
  try {
    const since = parseNum(req.query.since);
    const until = parseNum(req.query.until);
    const minTokens = parseNum(req.query.minTokens);
    const maxTokens = parseNum(req.query.maxTokens);
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const model = typeof req.query.model === 'string' ? req.query.model : undefined;
    const limit = Math.min(parseNum(req.query.limit) ?? 100, 500);

    // Construimos el WHERE dinámicamente para no escribir SQL de más.
    const where: string[] = ['1=1'];
    const params: any[] = [];

    if (since !== undefined) { where.push('s.created_at >= ?'); params.push(since); }
    if (until !== undefined) { where.push('s.created_at <= ?'); params.push(until); }
    if (status === 'error') { where.push('EXISTS (SELECT 1 FROM step_logs sl WHERE sl.session_id = s.id AND sl.status = ?)'); params.push('error'); }
    if (model) { where.push(`EXISTS (SELECT 1 FROM step_logs sl WHERE sl.session_id = s.id AND sl.model = ?)`); params.push(model); }
    if (minTokens !== undefined || maxTokens !== undefined) {
      const min = minTokens ?? 0;
      const max = maxTokens ?? Number.MAX_SAFE_INTEGER;
      where.push(`(SELECT COALESCE(SUM(total_tokens), 0) FROM step_logs WHERE session_id = s.id) BETWEEN ? AND ?`);
      params.push(min, max);
    }

    const sql = `
      SELECT s.id as session_id, s.name as session_name, s.space_id, s.status,
             s.created_at, s.updated_at,
             (SELECT COUNT(*) FROM step_logs sl WHERE sl.session_id = s.id) as total_steps,
             (SELECT COUNT(*) FROM step_logs sl WHERE sl.session_id = s.id AND sl.status = 'completed') as completed_steps,
             (SELECT COUNT(*) FROM step_logs sl WHERE sl.session_id = s.id AND sl.status = 'error') as error_steps,
             (SELECT COALESCE(SUM(total_tokens), 0) FROM step_logs sl WHERE sl.session_id = s.id) as total_tokens,
             (SELECT COALESCE(SUM(api_call_duration_ms), 0) FROM step_logs sl WHERE sl.session_id = s.id) as total_api_ms,
             (SELECT COALESCE(SUM(tc.duration_ms), 0) FROM tool_calls tc JOIN step_logs sl ON sl.id = tc.step_log_id WHERE sl.session_id = s.id) as total_tool_ms,
             (SELECT model FROM step_logs sl WHERE sl.session_id = s.id ORDER BY step_number DESC LIMIT 1) as last_model,
             (SELECT content FROM messages m WHERE m.session_id = s.id AND m.role = 'user' ORDER BY created_at ASC LIMIT 1) as first_user_message
      FROM sessions s
      WHERE ${where.join(' AND ')}
      ORDER BY s.created_at DESC
      LIMIT ?`;
    params.push(limit);

    const rowsResult = await pool.query(sql, params);
    const runs: RunSummary[] = (rowsResult.rows as any[]).map((r) => {
      const totalApiMs = Number(r.total_api_ms) || 0;
      const totalToolMs = Number(r.total_tool_ms) || 0;
      const totalDurationMs = totalApiMs + totalToolMs;
      const totalSteps = Number(r.total_steps) || 0;
      return {
        sessionId: r.session_id,
        sessionName: r.session_name,
        spaceId: r.space_id,
        createdAt: Number(r.created_at),
        updatedAt: Number(r.updated_at),
        totalSteps,
        completedSteps: Number(r.completed_steps) || 0,
        errorSteps: Number(r.error_steps) || 0,
        totalTokens: Number(r.total_tokens) || 0,
        totalApiMs,
        totalToolMs,
        totalDurationMs,
        avgStepMs: totalSteps > 0 ? totalDurationMs / totalSteps : 0,
        status: r.status,
        model: r.last_model,
        firstUserMessage: r.first_user_message ? truncate(r.first_user_message, 200) : null,
      };
    });

    res.json({ runs, count: runs.length });
  } catch (e: any) {
    console.error('Audit runs error:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/audit/runs/:id
 * Detalle completo: session + messages + métricas + step logs + tool calls +
 * prompt completo enviado al LLM + respuesta cruda del LLM.
 *
 * ⚠️ Este endpoint puede retornar MB de datos. Úsalo con cabeza. Para análisis
 * programático, mejor usa /export.
 */
router.get('/runs/:id', async (req, res) => {
  try {
    const sessionId = req.params.id;
    const sessionRows = await pool.query('SELECT * FROM sessions WHERE id = ?', [sessionId]);
    if (!sessionRows.rows || sessionRows.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const session = (sessionRows.rows as any[])[0];

    const messagesRows = await pool.query(
      `SELECT id, role, content, name, reasoning_content, tool_calls, tool_call_id,
              is_human_intervention, created_at
       FROM messages WHERE session_id = ? ORDER BY created_at ASC`,
      [sessionId]
    );

    const metrics = await getSessionMetrics(sessionId);

    res.json({
      session: {
        id: session.id,
        name: session.name,
        spaceId: session.space_id,
        status: session.status,
        createdAt: Number(session.created_at),
        updatedAt: Number(session.updated_at),
      },
      messages: (messagesRows.rows as any[]).map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        name: m.name,
        reasoningContent: m.reasoning_content,
        toolCalls: m.tool_calls ? safeJsonParse(m.tool_calls) : null,
        toolCallId: m.tool_call_id,
        isHumanIntervention: !!m.is_human_intervention,
        createdAt: Number(m.created_at),
      })),
      metrics,
    });
  } catch (e: any) {
    console.error('Audit run detail error:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/audit/runs/:id/export
 * Descarga el run completo como JSON. Pensado para análisis offline
 * (Jupyter, Excel, scripts propios).
 */
router.get('/runs/:id/export', async (req, res) => {
  try {
    const sessionId = req.params.id;
    const sessionRows = await pool.query('SELECT * FROM sessions WHERE id = ?', [sessionId]);
    if (!sessionRows.rows || sessionRows.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const session = (sessionRows.rows as any[])[0];
    const messagesRows = await pool.query(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC',
      [sessionId]
    );
    const metrics = await getSessionMetrics(sessionId);

    const exportData = {
      exportedAt: new Date().toISOString(),
      session,
      messages: messagesRows.rows,
      metrics,
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="worgena-run-${sessionId}.json"`
    );
    res.send(JSON.stringify(exportData, null, 2));
  } catch (e: any) {
    console.error('Audit export error:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/audit/stats
 * Estadísticas agregadas de todos los runs (útil para dashboard).
 */
router.get('/stats', async (_req, res) => {
  try {
    const runsTotal = (await pool.query('SELECT COUNT(*) as c FROM sessions')).rows[0] as any;
    const stepsTotal = (await pool.query('SELECT COUNT(*) as c FROM step_logs')).rows[0] as any;
    const tokensTotal = (await pool.query('SELECT COALESCE(SUM(total_tokens), 0) as t FROM step_logs')).rows[0] as any;
    const errorsTotal = (await pool.query(`SELECT COUNT(*) as c FROM step_logs WHERE status = 'error'`)).rows[0] as any;
    const byModel = (await pool.query(`SELECT model, COUNT(*) as runs FROM step_logs GROUP BY model`)).rows;
    const byTool = (await pool.query(`
      SELECT tc.name, COUNT(*) as calls, AVG(tc.duration_ms) as avg_ms,
             SUM(CASE WHEN tc.success = 0 THEN 1 ELSE 0 END) as failures
      FROM tool_calls tc GROUP BY tc.name ORDER BY calls DESC
    `)).rows;
    const byFinishReason = (await pool.query(`
      SELECT
        json_extract(raw_response, '$.choices[0].finish_reason') as finish_reason,
        COUNT(*) as n
      FROM step_logs
      WHERE raw_response IS NOT NULL
      GROUP BY finish_reason
    `)).rows;

    res.json({
      totalRuns: Number(runsTotal.c) || 0,
      totalSteps: Number(stepsTotal.c) || 0,
      totalTokens: Number(tokensTotal.t) || 0,
      totalErrors: Number(errorsTotal.c) || 0,
      byModel: (byModel as any[]).map((r) => ({ model: r.model, runs: Number(r.runs) })),
      byTool: (byTool as any[]).map((r) => ({
        name: r.name,
        calls: Number(r.calls),
        avgMs: Math.round(Number(r.avg_ms) || 0),
        failures: Number(r.failures) || 0,
      })),
      byFinishReason: (byFinishReason as any[]).map((r) => ({
        finishReason: r.finish_reason || 'unknown',
        n: Number(r.n),
      })),
    });
  } catch (e: any) {
    console.error('Audit stats error:', e);
    res.status(500).json({ error: e.message });
  }
});

function parseNum(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.substring(0, n) + '...' : s;
}

function safeJsonParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

export default router;
