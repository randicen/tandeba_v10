/**
 * Worgena — Jobs repository (P0 #5 jobs v1).
 *
 * CRUD de la tabla `jobs`. Source of truth para el sistema de jobs.
 * Patrón: cada función acepta `dbInstance?` opcional (default = DB
 * global). Tests pasan `:memory:` para aislamiento.
 *
 * Spec: AGENT_JOBS_V1_SPEC.md §2.O2, §4.P1-P4, §4.P6.
 */

import type Database from "better-sqlite3";
import { getDb, type DbInstance } from "../billing/db-instance.js";

// ============================================================
// Types
// ============================================================

export type JobType =
  | "send_invitation_email"
  | "enforce_credit_warning"
  | "cleanup_audit"
  | "cleanup_invitations"
  | "send_email_generic";

export type JobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "dead_letter";

export interface Job {
  id: string;
  type: JobType;
  payloadJson: string;
  idempotencyKey: string | null;
  status: JobStatus;
  attempts: number;
  lastError: string | null;
  scheduledAt: number;
  startedAt: number | null;
  completedAt: number | null;
  createdAt: number;
}

export interface EnqueueJobOptions {
  /** Idempotency key. Si se pasa y ya hay un job con misma key,
   *  retorna el job existente en vez de crear uno nuevo. */
  idempotencyKey?: string;
  /** Cuándo correr el job. Default: now. */
  scheduledAt?: number;
}

export interface ListJobsFilter {
  type?: JobType;
  status?: JobStatus;
  limit?: number;
}

// ============================================================
// Helpers
// ============================================================

function resolveDb(dbInstance?: DbInstance): Database.Database {
  return dbInstance ?? getDb();
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `job-${crypto.randomUUID()}`;
  }
  return `job-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function rowToJob(row: Record<string, unknown>): Job {
  return {
    id: row.id as string,
    type: row.type as JobType,
    payloadJson: row.payload_json as string,
    idempotencyKey: (row.idempotency_key as string | null) ?? null,
    status: row.status as JobStatus,
    attempts: row.attempts as number,
    lastError: (row.last_error as string | null) ?? null,
    scheduledAt: row.scheduled_at as number,
    startedAt: (row.started_at as number | null) ?? null,
    completedAt: (row.completed_at as number | null) ?? null,
    createdAt: row.created_at as number,
  };
}

// ============================================================
// Read operations
// ============================================================

/**
 * Lee un job por id.
 */
export function getJobById(id: string, dbInstance?: DbInstance): Job | null {
  const db = resolveDb(dbInstance);
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToJob(row) : null;
}

/**
 * Lista jobs con filtros opcionales. Más recientes primero (por rowid).
 */
export function listJobs(
  filter: ListJobsFilter = {},
  dbInstance?: DbInstance,
): Job[] {
  const db = resolveDb(dbInstance);
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.type !== undefined) {
    where.push("type = ?");
    params.push(filter.type);
  }
  if (filter.status !== undefined) {
    where.push("status = ?");
    params.push(filter.status);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const limit = filter.limit ?? 100;
  const rows = db
    .prepare(
      `SELECT * FROM jobs ${whereClause} ORDER BY rowid DESC LIMIT ?`,
    )
    .all(...params, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToJob);
}

// ============================================================
// Write operations
// ============================================================

/**
 * Encola un job. Si `idempotencyKey` ya existe y el job con esa key
 * no está completed/failed/dead_letter, retorna el existente (no-op).
 *
 * **Idempotencia**: dos llamadas con misma `idempotencyKey` retornan
 * el mismo job_id. Si el job anterior está completed, crea uno nuevo
 * (idempotency_key es por active job, no histórico).
 */
export function enqueueJob(
  type: JobType,
  payload: Record<string, unknown>,
  options: EnqueueJobOptions = {},
  dbInstance?: DbInstance,
): Job {
  const db = resolveDb(dbInstance);
  const now = Date.now();
  const scheduledAt = options.scheduledAt ?? now;
  const payloadJson = JSON.stringify(payload);
  const idempotencyKey = options.idempotencyKey ?? null;

  // Si hay idempotency_key, intentar lookup primero
  if (idempotencyKey) {
    const existing = db
      .prepare(
        "SELECT * FROM jobs WHERE idempotency_key = ? AND status IN ('pending', 'running') LIMIT 1",
      )
      .get(idempotencyKey) as Record<string, unknown> | undefined;
    if (existing) {
      return rowToJob(existing);
    }
  }

  const id = newId();
  // INSERT OR IGNORE: si idempotency_key choca (race condition con
  // otro worker), no falla. Retorna el row existente.
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO jobs
         (id, type, payload_json, idempotency_key, status, attempts, scheduled_at, created_at)
       VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
    )
    .run(id, type, payloadJson, idempotencyKey, scheduledAt, now);

  if (result.changes === 0) {
    // Race condition: otro worker creó con misma key. Retornar el row.
    const existing = db
      .prepare("SELECT * FROM jobs WHERE idempotency_key = ? LIMIT 1")
      .get(idempotencyKey) as Record<string, unknown> | undefined;
    if (!existing) {
      throw new Error(
        `enqueueJob: INSERT OR IGNORE returned 0 changes but no row found for idempotency_key=${idempotencyKey}`,
      );
    }
    return rowToJob(existing);
  }

  const inserted = getJobById(id, dbInstance);
  if (!inserted) {
    throw new Error(`enqueueJob: row missing post-insert (id=${id})`);
  }
  return inserted;
}

/**
 * Claims up to `limit` jobs pending. Atomic via SQL UPDATE.
 *
 * Algoritmo:
 * 1. Encuentra los N jobs pending con `scheduled_at <= now`, ordenados
 *    por scheduled_at asc.
 * 2. UPDATE atómico: status='running', started_at=now, attempts+=1.
 *    Solo si status='pending' (no race con otros workers).
 * 3. Retorna los rows actualizados.
 *
 * **No race condition**: si dos workers ejecutan claimPendingJobs
 * simultáneamente, cada uno toma un subset distinto (porque el UPDATE
 * con WHERE status='pending' es atómico en SQLite).
 */
export function claimPendingJobs(
  limit: number,
  dbInstance?: DbInstance,
): Job[] {
  const db = resolveDb(dbInstance);
  const now = Date.now();
  const txn = db.transaction(() => {
    // 1. Encuentra los IDs a claim. ORDER BY scheduled_at ASC, rowid ASC:
    //    `rowid` (implícito en SQLite) es monotónico → orden determinístico
    //    cuando múltiples jobs tienen el mismo scheduled_at.
    const ids = db
      .prepare(
        `SELECT id FROM jobs
         WHERE status = 'pending' AND scheduled_at <= ?
         ORDER BY scheduled_at ASC, rowid ASC
         LIMIT ?`,
      )
      .all(now, limit) as Array<{ id: string }>;
    if (ids.length === 0) return [];
    // 2. UPDATE atómico: solo si status='pending' (candado pesimista)
    const placeholders = ids.map(() => "?").join(",");
    const updateResult = db
      .prepare(
        `UPDATE jobs
         SET status = 'running', started_at = ?, attempts = attempts + 1
         WHERE id IN (${placeholders}) AND status = 'pending'`,
      )
      .run(now, ...ids.map((r) => r.id));
    if (updateResult.changes === 0) {
      return [];
    }
    // 3. Lee los rows actualizados. ORDER BY del primer SELECT (preservado
    //    via IN clause) — el orden de la IN clause no se preserva en SQLite,
    //    así que usamos el mismo ORDER BY explícito.
    const claimed = db
      .prepare(
        `SELECT * FROM jobs
         WHERE id IN (${placeholders}) AND status = 'running'
         ORDER BY scheduled_at ASC, rowid ASC`,
      )
      .all(...ids.map((r) => r.id)) as Array<Record<string, unknown>>;
    return claimed;
  });
  return txn().map(rowToJob);
}

/**
 * Marca un job como completed. Idempotente.
 */
export function markJobCompleted(id: string, dbInstance?: DbInstance): void {
  const db = resolveDb(dbInstance);
  db.prepare(
    "UPDATE jobs SET status = 'completed', completed_at = ? WHERE id = ?",
  ).run(Date.now(), id);
}

/**
 * Marca un job como failed. Si `willRetry` es true, recalcula
 * `scheduled_at = now + backoff(attempts)` y vuelve a pending. Si
 * `willRetry` es false, lo marca como dead_letter.
 *
 * **Backoff exponencial con jitter** (P3): 5s, 30s, 2min, 10min, 1h.
 * `MAX_JOB_ATTEMPTS=5` default. Después de 5 intentos, dead_letter.
 */
export function markJobFailed(
  id: string,
  error: Error | string,
  willRetry: boolean,
  dbInstance?: DbInstance,
): void {
  const db = resolveDb(dbInstance);
  const now = Date.now();
  const errMsg = typeof error === "string" ? error : `${error.name}: ${error.message}`;
  const job = getJobById(id, dbInstance);
  if (!job) {
    throw new Error(`markJobFailed: job id=${id} not found`);
  }
  if (willRetry) {
    const nextRunAt = computeBackoffMs(job.attempts, now);
    db.prepare(
      "UPDATE jobs SET status = 'pending', scheduled_at = ?, last_error = ? WHERE id = ?",
    )
      .run(nextRunAt, errMsg, id);
  } else {
    db.prepare(
      "UPDATE jobs SET status = 'dead_letter', completed_at = ?, last_error = ? WHERE id = ?",
    )
      .run(now, errMsg, id);
  }
}

/**
 * Marca un job como dead_letter (sin retry).
 */
export function markJobDeadLetter(
  id: string,
  error: Error | string,
  dbInstance?: DbInstance,
): void {
  markJobFailed(id, error, false, dbInstance);
}

/**
 * Calcula el `scheduled_at` para el próximo retry: backoff exponencial
 * con jitter. Default: 5s, 30s, 2min, 10min, 1h (después del 5 intento).
 */
export function computeBackoffMs(attempts: number, baseTimeMs: number = Date.now()): number {
  const baseDelays = [5_000, 30_000, 120_000, 600_000, 3_600_000];
  const idx = Math.min(attempts - 1, baseDelays.length - 1);
  const base = baseDelays[idx] ?? 3_600_000;
  const jitter = Math.random() * base * 0.2; // 20% jitter
  return baseTimeMs + base + jitter;
}

// ============================================================
// Backwards-compat helper: re-encolar cleanup jobs
// ============================================================

/**
 * Re-encola un job para correr en el futuro. Helper usado por handlers
 * de cleanup que quieren repetirse cada 24h.
 */
export function requeueIn(
  jobId: string,
  delayMs: number,
  dbInstance?: DbInstance,
): void {
  const db = resolveDb(dbInstance);
  db.prepare(
    "UPDATE jobs SET status = 'pending', scheduled_at = ? WHERE id = ?",
  ).run(Date.now() + delayMs, jobId);
}
