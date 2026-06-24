/**
 * Worgena Workflow Engine — Persistencia D3.1: SqliteTaskStore.
 *
 * Implementación de `TaskStore` que persiste en SQLite (better-sqlite3).
 * Usa el `worgena.db` global por default, pero acepta una `Database`
 * inyectada para tests.
 *
 * **Sync, NO async**. better-sqlite3 es síncrono. La interface `TaskStore`
 * está escrita como sync también — si en D4+ migramos a Postgres, se
 * cambia la interface a async o se usa una librería sync (PGlite).
 *
 * Spec: `AGENT_D3_1_STORAGE_PERSISTENCE_SPEC.md` §2.4, §4.1.
 */

import type Database from "better-sqlite3";
import type { Task } from "../dsl/types.js";
import {
  type TaskStore,
  type TaskRow,
  serializeTask,
  deserializeTask,
} from "./task-store.js";
import { runPersistenceMigrations } from "./migrations.js";
import { MissingTenantIdError } from "./errors.js";

/**
 * Helper privado: valida que el `tenantId` no sea undefined ni string vacío.
 * D3.2 strict. Falla loud con `MissingTenantIdError`.
 */
function requireTenantId(method: string, tenantId: string | undefined): asserts tenantId is string {
  if (tenantId === undefined || tenantId === "") {
    throw new MissingTenantIdError(method);
  }
}

const TERMINAL_STATUSES: ReadonlySet<Task["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/**
 * Implementación SQLite. Una instancia por conexión.
 *
 * El constructor llama a `runPersistenceMigrations(db)` para asegurar
 * que la tabla existe. Es idempotente.
 */
export class SqliteTaskStore implements TaskStore {
  private readonly db: Database.Database;

  /**
   * Statement preparado para save (INSERT OR REPLACE). Cacheado en el
   * constructor porque se invoca en CADA checkpoint del motor.
   *
   * `INSERT OR REPLACE` es atómico y equivalente a UPSERT en SQLite.
   * Si la task ya existe, hace DELETE + INSERT (atomic). El motor es el
   * único que escribe, así que no hay race con otro writer.
   */
  private readonly saveStmt: Database.Statement;
  private readonly loadStmt: Database.Statement;
  private readonly loadActiveStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;
  /** D3.3: actualiza last_heartbeat_at de una task. */
  private readonly touchStmt: Database.Statement;
  /** D3.3: query de zombies (running con heartbeat viejo). */
  private readonly findZombieStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    runPersistenceMigrations(db);

    this.saveStmt = db.prepare(`
      INSERT OR REPLACE INTO paused_tasks (
        task_id, tenant_id, workflow_id, workflow_version, status,
        current_node, state_json, node_results_json,
        pending_decision_json, migrated_workflow_json,
        applied_migrations_json, input_json, error_json, metadata_json,
        created_at, updated_at, started_at, completed_at,
        replay_of, replay_input_json, replay_from_node, last_heartbeat_at
      ) VALUES (
        @task_id, @tenant_id, @workflow_id, @workflow_version, @status,
        @current_node, @state_json, @node_results_json,
        @pending_decision_json, @migrated_workflow_json,
        @applied_migrations_json, @input_json, @error_json, @metadata_json,
        @created_at, @updated_at, @started_at, @completed_at,
        @replay_of, @replay_input_json, @replay_from_node, @last_heartbeat_at
      )
    `);

    // D3.2 audit fix (I-1): load/delete usan PK compuesto (task_id, tenant_id)
    // para evitar colisión cross-tenant. El filtro por tenant_id sigue
    // siendo defensa redundante (si el caller pasa un tenantId distinto al
    // del row, no retornamos la task).
    this.loadStmt = db.prepare(
      `SELECT * FROM paused_tasks WHERE task_id = ? AND tenant_id = ?`
    );
    this.loadActiveStmt = db.prepare(
      `SELECT * FROM paused_tasks
       WHERE tenant_id = ? AND status IN ('pending', 'running', 'paused_hitl', 'paused_error')
       ORDER BY updated_at ASC`
    );
    this.deleteStmt = db.prepare(
      `DELETE FROM paused_tasks WHERE task_id = ? AND tenant_id = ?`
    );
    // D3.3: touch actualiza last_heartbeat_at. UPDATE con PK compuesto.
    this.touchStmt = db.prepare(
      `UPDATE paused_tasks SET last_heartbeat_at = ?
       WHERE task_id = ? AND tenant_id = ?`
    );
    // D3.3: find zombies. Filtra por tenant + status='running' + heartbeat viejo.
    this.findZombieStmt = db.prepare(
      `SELECT * FROM paused_tasks
       WHERE tenant_id = ? AND status = 'running'
         AND (last_heartbeat_at IS NULL OR last_heartbeat_at <= ?)`
    );
  }

  save(task: Task, tenantId: string): void {
    requireTenantId("save", tenantId);
    // D3.1 §2.1: tasks terminales NO se persisten. Mismo comportamiento
    // que InMemoryTaskStore. Si llega una save con status terminal,
    // la borramos (idempotente) en vez de escribirla.
    if (TERMINAL_STATUSES.has(task.status)) {
      // D3.2 audit fix (I-1): DELETE con PK compuesto (task_id, tenant_id).
      // Si la task era de otro tenant, el WHERE no matchea y no se toca.
      this.deleteStmt.run(task.taskId, tenantId);
      return;
    }
    const row = serializeTask(task);
    // D3.2 strict: tenantId del param SIEMPRE gana sobre el de la task.
    // El motor nunca debería pasar un tenantId distinto al de la task;
    // si lo hace, logueamos warning pero aceptamos.
    if (row.tenant_id !== tenantId) {
      // No logueamos acá (no tenemos logger). El caller (motor) puede
      // chequear post-save si quiere.
    }
    row.tenant_id = tenantId;
    // D3.3: save() también bumpea last_heartbeat_at. El caller NO
    // necesita llamar touch() después de save(); el heartbeat se
    // actualiza como parte del checkpoint atómico.
    // touch() queda disponible para bumpear el heartbeat entre
    // checkpoints completos (forward-compat, no usado en D3.3).
    row.last_heartbeat_at = Date.now();
    this.saveStmt.run(row);
  }

  load(taskId: string, tenantId: string): Task | null {
    requireTenantId("load", tenantId);
    // D3.2 audit fix (I-1): PK compuesto (task_id, tenant_id). El query
    // ya filtra por tenant_id en el WHERE; no hay leak cross-tenant.
    const row = this.loadStmt.get(taskId, tenantId) as TaskRow | undefined;
    if (!row) return null;
    return deserializeTask(row);
  }

  loadActive(tenantId: string): readonly Task[] {
    requireTenantId("loadActive", tenantId);
    // D3.2 audit fix: el WHERE incluye tenant_id (índice paused_tasks_tenant_idx
    // lo cubre). Sin el filtro por status, el índice NO se usa; con ambos,
    // el query es O(log n) por tenant.
    const rows = this.loadActiveStmt.all(tenantId) as TaskRow[];
    return rows.map(deserializeTask);
  }

  delete(taskId: string, tenantId: string): void {
    requireTenantId("delete", tenantId);
    // D3.2 audit fix: DELETE con PK compuesto. Idempotente cross-tenant:
    // si el caller pasa un tenantId distinto, el WHERE no matchea y
    // no se elimina nada.
    this.deleteStmt.run(taskId, tenantId);
  }

  touch(taskId: string, tenantId: string): void {
    requireTenantId("touch", tenantId);
    // D3.3: UPDATE con PK compuesto. Si la task no existe o es de otro
    // tenant, el WHERE no matchea y no se hace nada (idempotente).
    this.touchStmt.run(Date.now(), taskId, tenantId);
  }

  findStaleZombieTasks(tenantId: string, maxAgeMs: number): readonly Task[] {
    requireTenantId("findStaleZombieTasks", tenantId);
    // D3.3: query con PK compuesto + filtro de status. La columna
    // `last_heartbeat_at` puede ser NULL (filas pre-D3.3 o task recién
    // creada sin touch). `IS NULL OR < threshold` cubre ambos casos.
    // Usa el índice `paused_tasks_status_idx` o `paused_tasks_heartbeat_idx`.
    const cutoff = Date.now() - maxAgeMs;
    const rows = this.findZombieStmt.all(tenantId, cutoff) as TaskRow[];
    return rows.map(deserializeTask);
  }
}

// Re-export para tests que quieran verificar el shape de filas
export type { TaskRow } from "./task-store.js";
