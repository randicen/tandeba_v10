import { pool } from '../lib/db.js';
import { v4 as uuidv4 } from 'uuid';

export interface StepLog {
  id?: number;            // asignado por la DB al insertar
  sessionId: string;
  stepNumber: number;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  messagesCount: number;
  model: string;
  apiCallDurationMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** JSON del array completo de mensajes enviado al LLM. Útil para replay y tuning. */
  promptSent?: unknown;
  /** JSON crudo de la respuesta del LLM (choices, finish_reason, logprobs, etc.). */
  rawResponse?: unknown;
  toolCalls: Array<{
    name: string;
    args: Record<string, unknown>;
    durationMs: number;
    success: boolean;
    resultPreview: string;
  }>;
  status: 'running' | 'completed' | 'error';
  errorMessage?: string;
}

export interface ToolCallLog {
  name: string;
  args: Record<string, unknown>;
  durationMs: number;
  success: boolean;
  resultPreview: string;
}

export interface SessionMetrics {
  sessionId: string;
  startedAt: number;
  totalSteps: number;
  completedSteps: number;
  errorSteps: number;
  totalApiDurationMs: number;
  totalToolDurationMs: number;
  totalTokens: number;
  avgStepDurationMs: number;
  steps: StepLog[];
}

/**
 * Inserta un step log nuevo en estado "running". Retorna el StepLog con el
 * id asignado por la DB (lo necesitamos para asociarle las tool calls después).
 */
export async function createStepLog(
  sessionId: string,
  stepNumber: number,
  messagesCount: number,
  model: string
): Promise<StepLog> {
  const startTime = Date.now();
  const log: StepLog = {
    sessionId,
    stepNumber,
    startTime,
    messagesCount,
    model,
    toolCalls: [],
    status: 'running',
  };
  const result = await pool.query(
    `INSERT INTO step_logs (session_id, step_number, start_time, model, status, messages_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, stepNumber, startTime, model, 'running', messagesCount, startTime]
  );
  // better-sqlite3 con la capa pool devuelve rows vacías en INSERT; recuperamos
  // el lastInsertRowid ejecutando un SELECT para mantener la API antigua.
  const idRow = await pool.query('SELECT last_insert_rowid() as id');
  log.id = (idRow.rows[0] as any)?.id;
  return log;
}

/**
 * Marca el step como completed y persiste el prompt enviado, la respuesta cruda
 * del LLM, los tokens y todas las tool calls ejecutadas. Todo en una sola
 * transacción para que la auditoría sea consistente.
 */
export async function completeStepLog(
  sessionId: string,
  log: StepLog,
  apiDurationMs: number,
  promptTokens: number,
  completionTokens: number,
  totalTokens: number,
  toolCalls: ToolCallLog[],
  promptSent?: unknown,
  rawResponse?: unknown
): Promise<void> {
  const endTime = Date.now();
  const durationMs = endTime - log.startTime;
  const promptSentJson = promptSent !== undefined ? JSON.stringify(promptSent) : null;
  const rawResponseJson = rawResponse !== undefined ? JSON.stringify(rawResponse) : null;

  // Persistir el step + tool calls en una transacción.
  await runInTransaction(async (run) => {
    run(
      `UPDATE step_logs
       SET end_time = ?, duration_ms = ?, api_call_duration_ms = ?,
           prompt_tokens = ?, completion_tokens = ?, total_tokens = ?,
           status = ?, prompt_sent = ?, raw_response = ?
       WHERE id = ?`,
      [
        endTime,
        durationMs,
        apiDurationMs,
        promptTokens,
        completionTokens,
        totalTokens,
        'completed',
        promptSentJson,
        rawResponseJson,
        log.id,
      ]
    );

    // Insertar cada tool call. Las borramos primero por si reintentamos.
    run(`DELETE FROM tool_calls WHERE step_log_id = ?`, [log.id]);
    for (const tc of toolCalls) {
      run(
        `INSERT INTO tool_calls (step_log_id, name, args, duration_ms, success, result_preview)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          log.id,
          tc.name,
          JSON.stringify(tc.args || {}),
          tc.durationMs,
          tc.success ? 1 : 0,
          tc.resultPreview || '',
        ]
      );
    }
  });

  // Mantener la copia en memoria sincronizada para que el caller la vea fresca.
  log.endTime = endTime;
  log.durationMs = durationMs;
  log.apiCallDurationMs = apiDurationMs;
  log.promptTokens = promptTokens;
  log.completionTokens = completionTokens;
  log.totalTokens = totalTokens;
  log.promptSent = promptSent;
  log.rawResponse = rawResponse;
  log.toolCalls = toolCalls;
  log.status = 'completed';
}

export async function failStepLog(
  sessionId: string,
  log: StepLog,
  errorMessage: string
): Promise<void> {
  const endTime = Date.now();
  const durationMs = endTime - log.startTime;
  await pool.query(
    `UPDATE step_logs
     SET end_time = ?, duration_ms = ?, status = ?, error_message = ?
     WHERE id = ?`,
    [endTime, durationMs, 'error', errorMessage, log.id]
  );
  log.endTime = endTime;
  log.durationMs = durationMs;
  log.status = 'error';
  log.errorMessage = errorMessage;
}

/**
 * Helper para ejecutar varias queries en una sola transacción SQLite. Usado por
 * completeStepLog para que el step y sus tool calls se guarden atómicamente.
 */
async function runInTransaction(
  fn: (run: (sql: string, params?: any[]) => void) => void
): Promise<void> {
  const Database = (await import('better-sqlite3')).default;
  const path = (await import('path')).default;
  const DB_PATH = path.join(process.cwd(), 'worgena.db');
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  try {
    db.exec('BEGIN IMMEDIATE');
    fn((sql, params) => {
      const stmt = db.prepare(convertSql(sql));
      stmt.run(...(params || []));
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.close();
  }
}

function convertSql(sql: string): string {
  return sql.replace(/\$\d+/g, '?');
}

/**
 * Lee los step logs de una sesión y los hidrata con sus tool calls. Reemplaza
 * al antiguo `getSessionMetrics` que leía de filesystem.
 */
export async function getSessionMetrics(sessionId: string): Promise<SessionMetrics | null> {
  const stepsRows = await pool.query(
    `SELECT * FROM step_logs WHERE session_id = ? ORDER BY step_number ASC`,
    [sessionId]
  );
  if (!stepsRows.rows || stepsRows.rows.length === 0) return null;

  const toolRows = await pool.query(
    `SELECT tc.*, sl.step_number
     FROM tool_calls tc
     JOIN step_logs sl ON sl.id = tc.step_log_id
     WHERE sl.session_id = ?
     ORDER BY sl.step_number ASC, tc.id ASC`,
    [sessionId]
  );
  const toolByStep = new Map<number, ToolCallLog[]>();
  for (const row of toolRows.rows as any[]) {
    const list = toolByStep.get(row.step_number) || [];
    list.push({
      name: row.name,
      args: row.args ? JSON.parse(row.args) : {},
      durationMs: row.duration_ms || 0,
      success: !!row.success,
      resultPreview: row.result_preview || '',
    });
    toolByStep.set(row.step_number, list);
  }

  const steps: StepLog[] = (stepsRows.rows as any[]).map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    stepNumber: r.step_number,
    startTime: Number(r.start_time),
    endTime: r.end_time ? Number(r.end_time) : undefined,
    durationMs: r.duration_ms ?? undefined,
    messagesCount: r.messages_count,
    model: r.model,
    apiCallDurationMs: r.api_call_duration_ms ?? undefined,
    promptTokens: r.prompt_tokens ?? undefined,
    completionTokens: r.completion_tokens ?? undefined,
    totalTokens: r.total_tokens ?? undefined,
    promptSent: r.prompt_sent ? safeJsonParse(r.prompt_sent) : undefined,
    rawResponse: r.raw_response ? safeJsonParse(r.raw_response) : undefined,
    toolCalls: toolByStep.get(r.step_number) || [],
    status: r.status,
    errorMessage: r.error_message ?? undefined,
  }));

  const completedSteps = steps.filter((s) => s.status === 'completed').length;
  const errorSteps = steps.filter((s) => s.status === 'error').length;
  const totalApiDurationMs = steps.reduce((acc, s) => acc + (s.apiCallDurationMs || 0), 0);
  const totalToolDurationMs = steps.reduce(
    (acc, s) => acc + s.toolCalls.reduce((a, tc) => a + (tc.durationMs || 0), 0),
    0
  );
  const totalTokens = steps.reduce((acc, s) => acc + (s.totalTokens || 0), 0);
  const totalDurationMs = totalApiDurationMs + totalToolDurationMs;
  const avgStepDurationMs = steps.length > 0 ? totalDurationMs / steps.length : 0;

  return {
    sessionId,
    startedAt: steps[0]?.startTime || Date.now(),
    totalSteps: steps.length,
    completedSteps,
    errorSteps,
    totalApiDurationMs,
    totalToolDurationMs,
    totalTokens,
    avgStepDurationMs,
    steps,
  };
}

export async function getRecentLogs(sessionId: string, limit = 10): Promise<StepLog[]> {
  const metrics = await getSessionMetrics(sessionId);
  if (!metrics) return [];
  return metrics.steps.slice(-limit);
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
