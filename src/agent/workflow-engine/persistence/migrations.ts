/**
 * Worgena Workflow Engine — Persistencia D3.1 + D3.2 + D3.3 + Audit fix: Migrations.
 *
 * D3.1: crea la tabla `paused_tasks` y los índices asociados.
 * D3.2: agrega columna `tenant_id` a `sessions` y `spaces` (las 2 tablas
 *        del dominio donde multi-tenant es más urgente). Idempotente.
 * D3.2 audit fix (I-1): el PK de `paused_tasks` cambia de `task_id` a
 *        compuesto `(task_id, tenant_id)`.
 * D3.3: agrega columna `last_heartbeat_at` a `paused_tasks` (para sweeper)
 *        y crea la tabla `workflow_audit` (audit del motor).
 *
 * Esta función se invoca en el constructor de `SqliteTaskStore`, NO en
 * `src/lib/db.ts`. Razón: el motor no acopla a la DB global.
 *
 * Spec: `AGENT_D3_1_STORAGE_PERSISTENCE_SPEC.md` §5 +
 *       `AGENT_D3_2_MULTI_TENANT_SPEC.md` §3.3 +
 *       `AGENT_D3_3_AUTH_SWEEPER_AUDIT_SPEC.md` §2.4 +
 *       `AUDIT_D3_2` (2026-06-13) I-1.
 */

import type { Database as BetterSqliteDatabase } from "better-sqlite3";

/**
 * Crea/actualiza las tablas del motor (paused_tasks, workflow_audit),
 * agrega columnas a tablas D1 (sessions, spaces), todo idempotente.
 */
export function runPersistenceMigrations(
  db: BetterSqliteDatabase
): void {
  db.exec(`
    -- D3.1 + D3.2 audit fix: PK compuesto (task_id, tenant_id).
    CREATE TABLE IF NOT EXISTS paused_tasks (
      task_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      workflow_id TEXT NOT NULL,
      workflow_version TEXT NOT NULL,
      status TEXT NOT NULL,
      current_node TEXT NOT NULL,
      state_json TEXT NOT NULL,
      node_results_json TEXT NOT NULL,
      pending_decision_json TEXT,
      migrated_workflow_json TEXT,
      applied_migrations_json TEXT,
      input_json TEXT NOT NULL,
      error_json TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      replay_of TEXT,
      replay_input_json TEXT,
      replay_from_node TEXT,
      last_heartbeat_at INTEGER,
      PRIMARY KEY (task_id, tenant_id)
    );

    CREATE INDEX IF NOT EXISTS paused_tasks_tenant_idx
      ON paused_tasks(tenant_id, status);
    CREATE INDEX IF NOT EXISTS paused_tasks_status_idx
      ON paused_tasks(status, updated_at);
    -- D3.3: índice para el sweeper. Cubre
    -- "running con last_heartbeat_at viejo".
    CREATE INDEX IF NOT EXISTS paused_tasks_heartbeat_idx
      ON paused_tasks(status, last_heartbeat_at);

    -- D3.3: tabla de audit del workflow engine.
    -- Liviana: NO guarda prompt_sent/raw_response (eso es step_logs de D1).
    -- Solo el evento + metadata ligera.
    CREATE TABLE IF NOT EXISTS workflow_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS workflow_audit_tenant_idx
      ON workflow_audit(tenant_id, created_at);
    CREATE INDEX IF NOT EXISTS workflow_audit_task_idx
      ON workflow_audit(task_id, created_at);
  `);

  // D3.2: tenant_id en `sessions` y `spaces`. ALTER TABLE + CREATE INDEX
  // idempotentes via PRAGMA table_info.
  addTenantIdIfMissing(db, "sessions");
  addTenantIdIfMissing(db, "spaces");

  // D3.3: columna last_heartbeat_at en paused_tasks (si la tabla
  // existía pre-D3.3 con la columna faltante, la agregamos).
  addColumnIfMissing(db, "paused_tasks", "last_heartbeat_at", "INTEGER");
}

/**
 * Helper: agrega una columna a una tabla si no existe.
 * Idempotente. Usado por D3.3 para agregar `last_heartbeat_at` a
 * `paused_tasks` en DBs que se crearon pre-D3.3.
 *
 * **Forward-compat**: D3.4+ puede usar este helper para más
 * migraciones aditivas.
 */
function addColumnIfMissing(
  db: BetterSqliteDatabase,
  tableName: string,
  columnName: string,
  columnType: string,
): void {
  // Whitelist: solo tablas del motor. Defensa contra SQL injection.
  const ALLOWED_TABLES = new Set(["paused_tasks"]);
  if (!ALLOWED_TABLES.has(tableName)) {
    throw new Error(
      `addColumnIfMissing: tabla "${tableName}" no está en la whitelist.`,
    );
  }
  // Whitelist de columnas. Una por sprint. Defense in depth.
  const ALLOWED_COLUMNS = new Set(["last_heartbeat_at"]);
  if (!ALLOWED_COLUMNS.has(columnName)) {
    throw new Error(
      `addColumnIfMissing: columna "${columnName}" no está en la whitelist.`,
    );
  }
  // Whitelist de tipos. Idem.
  const ALLOWED_TYPES = new Set(["INTEGER", "TEXT", "REAL", "BLOB"]);
  if (!ALLOWED_TYPES.has(columnType)) {
    throw new Error(
      `addColumnIfMissing: tipo "${columnType}" no está en la whitelist.`,
    );
  }

  // Skip si la tabla no existe (e.g., test con :memory: que aún no
  // corrió el CREATE TABLE).
  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(tableName);
  if (!tableExists) return;

  const cols = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === columnName)) return;

  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
}

/**
 * Helper: agrega columna `tenant_id` a una tabla si no existe.
 * Idempotente. Usado por D3.2 para preparar las tablas de D1 (`sessions`,
 * `spaces`) para multi-tenant. El resto de las tablas (messages, step_logs,
 * etc.) se migra en D3.3.
 */
function addTenantIdIfMissing(
  db: BetterSqliteDatabase,
  tableName: string,
): void {
  // Whitelist de tablas permitidas. Defensa contra SQL injection si
  // alguien pasa un valor no controlado.
  const ALLOWED = new Set(["sessions", "spaces"]);
  if (!ALLOWED.has(tableName)) {
    throw new Error(
      `addTenantIdIfMissing: tabla "${tableName}" no está en la whitelist. ` +
        `Solo se permite: ${[...ALLOWED].join(", ")}`,
    );
  }

  // D3.2 fix: si la tabla NO existe (e.g., test con :memory: o DB
  // recién creada sin schema de D1), no hacer nada. La tabla la va
  // a crear `src/lib/db.ts` cuando se inicialice la DB global.
  // La migración de tenant_id es ADITIVA: no crea tablas, solo agrega
  // columna a tablas existentes.
  const tableExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
    )
    .get(tableName);
  if (!tableExists) {
    return; // Tabla no existe. Skip silencioso.
  }

  const cols = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === "tenant_id")) {
    return; // Ya existe. No-op idempotente.
  }
  // ALTER TABLE + CREATE INDEX. NO usamos string concat fuera de la whitelist
  // (tableName está validado arriba).
  db.exec(
    `ALTER TABLE ${tableName} ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS ${tableName}_tenant_idx ON ${tableName}(tenant_id)`,
  );
}
