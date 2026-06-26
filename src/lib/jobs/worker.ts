/**
 * Worgena — Jobs worker (P0 #5 jobs v1).
 *
 * Loop asíncrono que:
 * 1. Poll cada `JOB_POLL_INTERVAL_MS` (default 1s).
 * 2. Claim hasta `MAX_CONCURRENCY` jobs pending.
 * 3. Dispatch cada job a su handler según `HANDLERS` map.
 * 4. Maneja retries con backoff o dead_letter.
 *
 * Spec: AGENT_JOBS_V1_SPEC.md §2.O3, §4.P1, §4.P3, §4.P7, §4.P9.
 */

import type Database from "better-sqlite3";
import type { EmailProvider } from "../email/provider.js";
import {
  claimPendingJobs,
  enqueueJob,
  getJobById,
  listJobs,
  markJobCompleted,
  markJobFailed,
  type Job,
  type JobType,
} from "./repository.js";
import { HANDLERS, type HandlerDeps } from "./handlers/index.js";

// ============================================================
// Config
// ============================================================

const MAX_JOB_ATTEMPTS = Number(process.env.MAX_JOB_ATTEMPTS ?? 5);
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY ?? 5);
const JOB_POLL_INTERVAL_MS = Number(process.env.JOB_POLL_INTERVAL_MS ?? 1000);
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const SHUTDOWN_TIMEOUT_MS = 30_000; // 30s

// ============================================================
// Worker
// ============================================================

export interface WorkerOptions {
  db: Database.Database;
  email: EmailProvider;
  /** URL pública base para links en emails. Default: PUBLIC_URL env o localhost. */
  publicUrl?: string;
  /** Concurrencia. Default: env o 5. */
  maxConcurrency?: number;
  /** Poll interval. Default: env o 1000ms. */
  pollIntervalMs?: number;
  /** Si true, no encola cleanup jobs al startup (útil para tests). */
  skipStartupCleanup?: boolean;
}

export class JobsWorker {
  private readonly db: Database.Database;
  private readonly email: EmailProvider;
  private readonly publicUrl: string;
  private readonly maxConcurrency: number;
  private readonly pollIntervalMs: number;
  private readonly skipStartupCleanup: boolean;
  private runningJobs = new Set<Promise<void>>();
  private stopping = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly abortController = new AbortController();

  constructor(options: WorkerOptions) {
    this.db = options.db;
    this.email = options.email;
    this.publicUrl =
      options.publicUrl ?? process.env.PUBLIC_URL ?? "http://localhost:3000";
    this.maxConcurrency = options.maxConcurrency ?? MAX_CONCURRENCY;
    this.pollIntervalMs = options.pollIntervalMs ?? JOB_POLL_INTERVAL_MS;
    this.skipStartupCleanup = options.skipStartupCleanup ?? false;
  }

  /**
   * Arranca el worker. Setup SIGTERM handler (P7).
   * Si `skipStartupCleanup=false`, encola cleanup jobs al inicio.
   */
  async start(): Promise<void> {
    if (!this.skipStartupCleanup) {
      await this.enqueueCleanupJobs();
    }

    process.on("SIGTERM", () => this.stop("SIGTERM"));
    process.on("SIGINT", () => this.stop("SIGINT"));

    this.scheduleNextPoll();
  }

  /**
   * Detiene el worker. Espera a que los jobs running terminen
   * (max SHUTDOWN_TIMEOUT_MS).
   */
  async stop(reason: string = "manual"): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    console.log(`[jobs-worker] stopping (reason: ${reason})`);

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.abortController.abort();

    // Esperar a que los jobs running terminen, con timeout.
    const start = Date.now();
    while (this.runningJobs.size > 0 && Date.now() - start < SHUTDOWN_TIMEOUT_MS) {
      await Promise.race([
        Promise.all(Array.from(this.runningJobs)),
        new Promise((r) => setTimeout(r, 1000)),
      ]);
    }
    if (this.runningJobs.size > 0) {
      console.warn(
        `[jobs-worker] ${this.runningJobs.size} jobs still running after timeout, abandoning`,
      );
    }
    console.log(`[jobs-worker] stopped`);
  }

  /**
   * Encola los cleanup jobs al startup (O8 del spec).
   * Idempotente via idempotency_key.
   */
  private async enqueueCleanupJobs(): Promise<void> {
    enqueueJob(
      "cleanup_audit",
      { olderThanMs: 365 * 24 * 60 * 60 * 1000 },
      {
        idempotencyKey: "cleanup_audit_recurring",
        scheduledAt: Date.now() + 60_000, // primer run en 1 min
      },
      this.db,
    );
    enqueueJob(
      "cleanup_invitations",
      { olderThanMs: 30 * 24 * 60 * 60 * 1000 },
      {
        idempotencyKey: "cleanup_invitations_recurring",
        scheduledAt: Date.now() + 60_000,
      },
      this.db,
    );
  }

  private scheduleNextPoll(): void {
    if (this.stopping) return;
    this.pollTimer = setTimeout(() => this.poll(), this.pollIntervalMs);
  }

  /**
   * Una pasada del loop. Claim jobs pending, dispatch, schedule next.
   */
  private async poll(): Promise<void> {
    if (this.stopping) return;
    try {
      // Solo claim si hay slot libre
      const slots = this.maxConcurrency - this.runningJobs.size;
      if (slots > 0) {
        const jobs = claimPendingJobs(slots, this.db);
        for (const job of jobs) {
          const promise = this.processJob(job);
          this.runningJobs.add(promise);
          promise.finally(() => this.runningJobs.delete(promise));
        }
      }
    } catch (e) {
      console.error("[jobs-worker] poll error:", e);
    } finally {
      this.scheduleNextPoll();
    }
  }

  private async processJob(job: Job): Promise<void> {
    const handler = HANDLERS[job.type as JobType];
    if (!handler) {
      // Bug nuestro: type no registrado.
      console.error(`[jobs-worker] no handler for type=${job.type} (job id=${job.id})`);
      markJobFailed(
        job.id,
        `No handler registered for job type '${job.type}'`,
        false,
        this.db,
      );
      return;
    }

    const payload = parsePayload(job.payloadJson);
    const deps: HandlerDeps = {
      db: this.db,
      email: this.email,
      config: { publicUrl: this.publicUrl },
    };

    try {
      await handler(payload, deps);
      markJobCompleted(job.id, this.db);
      // Re-encolar cleanup jobs si el handler lo indica via tipo
      if (job.type === "cleanup_audit" || job.type === "cleanup_invitations") {
        this.requeueCleanupJob(job);
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      const willRetry = job.attempts < MAX_JOB_ATTEMPTS;
      console.error(
        `[jobs-worker] job id=${job.id} type=${job.type} failed (attempt ${job.attempts}/${MAX_JOB_ATTEMPTS}, willRetry=${willRetry}): ${err.message}`,
      );
      markJobFailed(job.id, err, willRetry, this.db);
    }
  }

  private requeueCleanupJob(job: Job): void {
    // Re-encola el mismo job (mismo id) para correr en 24h.
    // UPDATE directo: scheduled_at = now + 24h, status = pending.
    this.db
      .prepare(
        "UPDATE jobs SET status = 'pending', scheduled_at = ?, last_error = NULL WHERE id = ?",
      )
      .run(Date.now() + CLEANUP_INTERVAL_MS, job.id);
  }
}

function parsePayload(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`parsePayload: invalid JSON: ${(e as Error).message}`);
  }
}

// ============================================================
// Startup helper
// ============================================================

/**
 * Helper para que `server.ts` arranque el worker fácilmente.
 *
 * Uso:
 *   const worker = await startJobsWorker({db, email, publicUrl: '...'});
 *   // worker corre en background.
 *   process.on('SIGTERM', async () => {
 *     await worker.stop('SIGTERM');
 *   });
 */
export async function startJobsWorker(
  options: WorkerOptions,
): Promise<JobsWorker> {
  const worker = new JobsWorker(options);
  await worker.start();
  return worker;
}

// ============================================================
// Health check helper (forward-compat con /api/health)
// ============================================================

export interface JobsHealth {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  deadLetter: number;
}

export function getJobsHealth(db: Database.Database): JobsHealth {
  const counts = db
    .prepare(
      "SELECT status, COUNT(*) as count FROM jobs GROUP BY status",
    )
    .all() as Array<{ status: string; count: number }>;
  const map = new Map(counts.map((c) => [c.status, c.count]));
  return {
    pending: map.get("pending") ?? 0,
    running: map.get("running") ?? 0,
    completed: map.get("completed") ?? 0,
    failed: map.get("failed") ?? 0,
    deadLetter: map.get("dead_letter") ?? 0,
  };
}
