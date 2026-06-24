/**
 * Worgena Workflow Engine — Persistencia de Tasks (D3.1).
 *
 * Interface `TaskStore` y tipos auxiliares. Las implementaciones concretas
 * (SqliteTaskStore, InMemoryTaskStore) viven en archivos aparte.
 *
 * El motor usa el `TaskStore` para sobrevivir restarts. D3.1 introduce la
 * interface y la implementación SQLite; D4+ puede agregar una implementación
 * Postgres sin tocar el motor.
 *
 * Spec: `AGENT_D3_1_STORAGE_PERSISTENCE_SPEC.md`.
 */

import type { Task } from "../dsl/types.js";

// ============================================================
// TaskStore — interface pública
// ============================================================

/**
 * Persistencia de tasks en estado no terminal.
 *
 * El motor usa esto para sobrevivir restarts: cuando una task entra en
 * `paused_hitl` o `paused_error`, el motor llama `save(task)`. Al instanciar
 * el `WorkflowExecutor` con un `TaskStore`, el motor llama `loadActive()` y
 * re-hidrata las tasks en su `Map<taskId, Task>` interno.
 *
 * D3.1: la interface es sync. La implementación actual (SQLite vía
 * better-sqlite3) es síncrona por naturaleza. En D4+ puede migrarse a
 * async (Postgres) sin tocar el motor — la interface no especifica sync
 * vs async, pero los métodos se invocan en puntos donde el motor espera
 * una respuesta inmediata.
 *
 * D3.2: `tenantId` es OBLIGATORIO en TODOS los métodos. Falla loud
 * (`MissingTenantIdError`) si llega undefined. Esto fuerza a los callers
 * a pensar en multi-tenant desde el día 1. Si en el futuro queremos
 * acceso cross-tenant (admin), D3.3 introduce métodos explícitos
 * (`loadCrossTenant`, `loadAllTenantsActive`) con flag de capacidad.
 *
 * Las implementaciones deben ser ACID: si `save()` lanza, NINGÚN cambio
 * fue persistido. El motor NO captura el error — se propaga al caller.
 *
 * Las implementaciones deben ser thread-safe (single-process) o
 * connection-safe (multi-process). SQLite ya cumple single-process
 * porque usa 1 conexión WAL.
 */
export interface TaskStore {
  /**
   * Persiste o actualiza la task. Si `taskId` ya existe, hace UPDATE.
   * Lanza `MissingTenantIdError` si `tenantId` es undefined.
   * Lanza error si la persistencia falla. El motor NO captura el error.
   *
   * **D3.2 strict**: `tenantId` es REQUERIDO. El motor siempre lee
   * `task.tenantId` y lo pasa. Si los dos difieren, gana el param
   * (con warning) — esto permite tests multi-tenant sin tener que
   * mutar la task.
   */
  save(task: Task, tenantId: string): void;

  /**
   * Carga una task por ID. Retorna null si no existe O si pertenece
   * a otro tenant (mismo resultado para no leak de existencia cross-tenant).
   *
   * **D3.2 strict**: `tenantId` es REQUERIDO. Filtra por tenant.
   *
   * D3.2 audit fix (I-1): PK compuesto (task_id, tenant_id). El query
   * usa ambos en el WHERE; no hay pisado cross-tenant.
   */
  load(taskId: string, tenantId: string): Task | null;

  /**
   * Carga todas las tasks en estado no terminal
   * (`pending`, `running`, `paused_hitl`, `paused_error`).
   *
   * **D3.2 strict**: `tenantId` es REQUERIDO. Retorna SOLO tasks del tenant.
   *
   * D3.2 audit fix: el WHERE incluye `tenant_id` (cubre índice
   * `paused_tasks_tenant_idx`). O(log n) por tenant.
   *
   * Performance: en la mayoría de deployments habrá <100 tasks paused.
   * Si en el futuro hay miles, las implementaciones deben paginar.
   */
  loadActive(tenantId: string): readonly Task[];

  /**
   * Elimina la task del store. Usado por `executor.purgeTask`.
   * Si la task no existe, no lanza (es idempotente).
   *
   * **D3.2 strict**: `tenantId` es REQUERIDO. No elimina cross-tenant.
   */
  delete(taskId: string, tenantId: string): void;

  /**
   * D3.3: actualiza el `last_heartbeat_at` de una task a "ahora".
   * Usado por el motor después de cada `persistCheckpoint` para que
   * el sweeper distinga "running 3 horas" de "running 3 segundos".
   *
   * Si la task no existe o es de otro tenant, no-op (idempotente).
   * `tenantId` es REQUERIDO.
   */
  touch(taskId: string, tenantId: string): void;

  /**
   * D3.3: retorna las tasks en `running` con `last_heartbeat_at` viejo
   * (o NULL, lo cual también cuenta como zombie). Usado por
   * `executor.sweepStaleTasks()`. Retorna un array vacío si no hay
   * zombies. NO retorna tasks de otros tenants.
   */
  findStaleZombieTasks(tenantId: string, maxAgeMs: number): readonly Task[];
}

// ============================================================
// Helpers de serialización (compartidos por todas las implementaciones)
// ============================================================

/**
 * Serializa una task a un objeto plano con campos JSON-safe.
 * Usado por SqliteTaskStore. Las implementaciones in-memory no lo necesitan.
 *
 * Política: JSON.stringify directo. Si en D3.3+ guardamos `Buffer` o `Date`,
 * agregamos un replacer. D3.1 no lo necesita porque el `Task` y todos sus
 * sub-tipos son JSON-safe por convención (ver `dsl/types.ts`).
 */
export function serializeTask(task: Task): TaskRow {
  return {
    task_id: task.taskId,
    tenant_id: task.tenantId,
    workflow_id: task.workflowId,
    workflow_version: task.workflowVersion,
    status: task.status,
    current_node: task.currentNode,
    state_json: JSON.stringify(task.state),
    node_results_json: JSON.stringify(task.nodeResults),
    pending_decision_json: task.pendingDecision
      ? JSON.stringify(task.pendingDecision)
      : null,
    migrated_workflow_json: task.migratedWorkflow
      ? JSON.stringify(task.migratedWorkflow)
      : null,
    applied_migrations_json: task.appliedMigrations
      ? JSON.stringify(task.appliedMigrations)
      : null,
    input_json: JSON.stringify(task.input),
    error_json: task.error ? JSON.stringify(task.error) : null,
    metadata_json: task.metadata ? JSON.stringify(task.metadata) : null,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    started_at: task.startedAt ?? null,
    completed_at: task.completedAt ?? null,
    replay_of: task.replayOf ?? null,
    replay_input_json: task.replayInput
      ? JSON.stringify(task.replayInput)
      : null,
    replay_from_node: task.replayFromNode ?? null,
    // D3.3: last_heartbeat_at. El caller (motor) pasa el timestamp
    // actual en el `save` para que quede registrado.
    // D3.3: en este sprint, el motor llama `touch()` después de `save()`,
    // así que acá no necesitamos inicializarlo.
    last_heartbeat_at: null,
  };
}

/**
 * Revierte `serializeTask`. Lanza error si el JSON está corrupto.
 * Las implementaciones NO deben capturar este error — se propaga al motor.
 */
export function deserializeTask(row: TaskRow): Task {
  // D3.1: el `state` se carga como `unknown`. El motor no lo tipa porque
  // cada workflow tiene su propio `stateSchema` que valida en runtime.
  // Si la validación falla, el motor ya tiene infraestructura para eso
  // (D2a.2.3 `validateStateAgainstSchema`).
  //
  // D3.3: `last_heartbeat_at` se IGNORA acá (no es parte del `Task`
  // interface público). El sweeper lo lee directamente de la fila de DB
  // via un SELECT custom.
  return {
    taskId: row.task_id,
    tenantId: row.tenant_id,
    workflowId: row.workflow_id,
    workflowVersion: row.workflow_version,
    status: row.status as Task["status"],
    currentNode: row.current_node,
    state: JSON.parse(row.state_json),
    nodeResults: JSON.parse(row.node_results_json),
    pendingDecision: row.pending_decision_json
      ? JSON.parse(row.pending_decision_json)
      : undefined,
    migratedWorkflow: row.migrated_workflow_json
      ? JSON.parse(row.migrated_workflow_json)
      : undefined,
    appliedMigrations: row.applied_migrations_json
      ? JSON.parse(row.applied_migrations_json)
      : undefined,
    input: JSON.parse(row.input_json),
    error: row.error_json ? JSON.parse(row.error_json) : undefined,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    replayOf: row.replay_of ?? undefined,
    replayInput: row.replay_input_json
      ? JSON.parse(row.replay_input_json)
      : undefined,
    replayFromNode: row.replay_from_node ?? undefined,
  };
}

/**
 * Shape de la fila en la tabla `paused_tasks`. NO se exporta como tipo
 * público — es interno al motor. Las implementaciones lo usan pero
 * los callers no.
 */
export interface TaskRow {
  task_id: string;
  tenant_id: string;
  workflow_id: string;
  workflow_version: string;
  status: string;
  current_node: string;
  state_json: string;
  node_results_json: string;
  pending_decision_json: string | null;
  migrated_workflow_json: string | null;
  applied_migrations_json: string | null;
  input_json: string;
  error_json: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  replay_of: string | null;
  replay_input_json: string | null;
  replay_from_node: string | null;
  /**
   * D3.3: Unix ms de la última actividad de la task. Usado por el
   * sweeper para detectar zombies. `null` en filas legacy (migración
   * rellena con el timestamp de la migración o con 0).
   */
  last_heartbeat_at: number | null;
}
