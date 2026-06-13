/**
 * Worgena Workflow Engine — WorkflowExecutor.
 *
 * Fuente de verdad: AGENT_D2B_2_SPEC.md (v1.0) +
 *                   AGENT_D2B_1_SPEC.md (v1.0) +
 *                   AGENT_D2A_5_SPEC.md (v1.0) +
 *                   AGENT_D2A_4_HITL_PRIMITIVES_SPEC.md (v1.0) +
 *                   AGENT_D2A_2_3_CORE_PRIMITIVES_SPEC.md (v1.1) +
 *                   AGENT_D2A_2_2_TIMEOUT_RETRY_IDEMPOTENCY_SPEC.md (v1.0) +
 *                   AGENT_WORKFLOW_DSL_SPEC.md (v0.2).
 *
 * El motor. Ejecuta workflows recorriendo el grafo, llamando nodos,
 * escribiendo al state y manejando errores.
 *
 * Responsabilidades (D2a.2 + D2a.2.2 + D2a.2.3 + D2a.4):
 * - Task lifecycle: pending → running → completed / failed / paused_hitl / cancelled.
 * - Loop principal: ejecuta nodo, valida state post-output, escribe output,
 *   encuentra el siguiente.
 * - Router nodes: decision-based routing, no ejecuta código.
 * - Error actions: fail (default), continue, goto.
 * - In-memory persistence: Map<taskId, Task>. D3 introduce DB.
 * - **D2a.2.2**: Timeout per-attempt, retry con backoff, idempotency cache,
 *   safety net `NON_IDEMPOTENT_RETRY_DISALLOWED`.
 * - **D2a.2.3**: State schema validation (input + post-output), prompt snapshot
 *   persistence, time travel / replay, schema versioning lazy al ejecutar,
 *   circuit breaker interface (Noop default), limpieza de HITL paused branch,
 *   `cleanup()` no destructivo + nuevo `purgeTask()`.
 * - **D2a.4**: HITL primitives reales (pause/resume). El motor intercepta
 *   nodos `hitl` en `runLoop` y los delega a `pauseForHITL()` (que llama
 *   `HITLHandler.initiate()` no-bloqueante, persiste `pendingDecision`, y
 *   setea `status='paused_hitl'`). Nuevo método público `resumeTask(taskId, response)`
 *   que re-engancha el loop desde donde quedó. La espera humana NO bloquea
 *   el motor.
 *
 * Decisiones clave:
 * - El executor no valida el workflow al cargarlo más allá de `assertWorkflowValid`
 *   (defensa). Se asume que el caller ya pasó el workflow por `parseWorkflow`.
 * - Un task es identificado por taskId. Multi-task en paralelo funciona porque
 *   cada task tiene su propio state y currentNode.
 * - El loop se rompe cuando: completa (no hay next node), falla (error con
 *   action='fail' o router sin match), pausa (HITL → `paused_hitl`), cancela
 *   (status='cancelled'). El pause HITL es REAL: el `run()` retorna y la task
 *   queda esperando `resumeTask`.
 * - **Migración lazy**: `loadWorkflow` se llama en `startTask`, no en
 *   `parseWorkflow`. La task guarda `migratedWorkflow` para que el replay
 *   sea determinista respecto al código que corrió la original.
 * - **State validation**: el motor valida el state contra `stateSchema` después
 *   de cada output de nodo. Si no valida, la task falla con `SCHEMA_VIOLATION`.
 *   Acoplado a `ajv` (draft-07). Ver `AGENT_D2A_2_3_CORE_PRIMITIVES_SPEC.md` §4.
 * - **HITL pause/resume**: la pausa se persiste en `task.pendingDecision` con
 *   el contexto completo (nodeId, requestId, approvers, question, outputSchema,
 *   startedAt). `resumeTask` valida que la task esté en `paused_hitl`, aplica
 *   la respuesta, y continúa el loop. En D2a, la pausa vive solo en memoria
 *   (se pierde en restart del server; D3 introduce DB).
 */

import { randomUUID } from "node:crypto";
import type {
  Edge,
  ErrorCode,
  HITLNode,
  Node as WorkflowNode,
  NodeResult,
  PendingHITLDecision,
  PromptSnapshot,
  RouterNode,
  Task,
  TaskError,
  TaskStatus,
  WorkflowDefinition,
} from "../dsl/types.js";
import { runNode } from "./node-runner.js";
import { ExecutorError, isRetriableByDefault } from "./errors.js";
import {
  evaluateEdgeCondition,
  interpolate,
  resolveStateRef,
  setByPath,
  validateStateAgainstSchema,
} from "./state.js";
import { validateWorkflow } from "../dsl/schema.js";
import { loadWorkflow } from "../migrations.js";
import { NoopCircuitBreaker, type CircuitBreaker } from "./circuit-breaker.js";
import type { MigratorRegistry } from "../migrations.js";
import type {
  ExecutorConfig,
  ExecutorLogger,
  HITLHandler,
  HITLResponse,
  LLMInvoker,
  NodeExecutionOutcome,
  NodeExecutionSuccess,
  TaskRunResult,
  WorkflowFunction,
  WorkflowState,
} from "./types.js";
import Ajv from "ajv";

// ============================================================
// WorkflowExecutor
// ============================================================

export class WorkflowExecutor {
  private readonly tasks = new Map<string, Task>();
  /**
   * Workflows por taskId. La task (data pública del DSL) no guarda el
   * workflow completo para mantener el contrato limpio: la task es persistible
   * y la definición del workflow puede ser muy grande. El executor mantiene
   * la referencia en runtime.
   * D3 introduce DB: workflows se hidratan desde `workflows` table.
   */
  private readonly taskWorkflows = new Map<string, WorkflowDefinition>();
  /**
   * Set de taskIds cancelados. Necesario porque `task.status` se sobrescribe
   * a 'running' al ejecutar, lo que borra la señal de cancelación. El flag
   * separado permite cancelación cooperativa:
   * - cancelTask antes de run() → run() lo ve y bail
   * - cancelTask durante run() → el loop lo ve en la próxima iteración
   */
  private readonly cancelledTasks = new Set<string>();
  /**
   * Idempotency cache por taskId. Cada task tiene su propio Map<cacheKey, outcome>
   * para que dos tasks distintas con el mismo idempotencyKey NO se pisen.
   * El cache vive solo durante la task; cleanup() lo libera (parcialmente — ver §9.3).
   * D3 introduce cache persistente (DB) para que el cache sobreviva restarts.
   */
  private readonly idempotencyCaches = new Map<string, Map<string, NodeExecutionSuccess>>();
  private readonly config: ExecutorConfig;
  private readonly log?: ExecutorLogger;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly migrators: MigratorRegistry;
  private readonly schemaVersion: number;

  constructor(config: ExecutorConfig) {
    this.config = config;
    this.log = config.logger;
    this.circuitBreaker = config.circuitBreaker ?? new NoopCircuitBreaker();
    this.migrators = config.migrators ?? new Map();
    this.schemaVersion = config.schemaVersion ?? 1;
  }

  // ─── Task lifecycle ─────────────────────────────────────

  /**
   * Crea una nueva task a partir de un workflow. NO la ejecuta; para eso usar `run`.
   *
   * Pipeline (D2a.2.3):
   * 1. `assertWorkflowValid`: defensa, falla con `INTERNAL_BUG` si el workflow
   *    es trivialmente inválido (sin id, sin entryNode, sin nodos).
   * 2. `validateWorkflow`: shape + cross-validation. Falla con detalle si
   *    la estructura es inválida.
   * 3. `validateStateAgainstSchema({ input }, stateSchema)`: el input debe
   *    cumplir el `stateSchema`. Falla con `SCHEMA_VIOLATION` antes de crear
   *    la task.
   * 4. `loadWorkflow(workflow, migrators, schemaVersion)`: migración lazy.
   *    Si el workflow tiene un `schemaVersion` menor al del motor, aplica
   *    migradores del registry. El resultado se guarda en `task.migratedWorkflow`
   *    y las migraciones aplicadas en `task.appliedMigrations`.
   * 5. Crea la task con el workflow YA MIGRADO (o el original si no hubo
   *    migración). El `workflowVersion` en la task es el del workflow
   *    actual (no el del workflow original en DB si fue migrado — D3
   *    introduce DB; hoy se trabaja con el workflow en memoria).
   */
  startTask(workflow: WorkflowDefinition, input: unknown): Task {
    this.assertWorkflowValid(workflow);

    // Validación completa (schema + cross-validation). Compilada en ajv; ~5ms.
    const validation = validateWorkflow(workflow);
    if (validation.valid) {
      // OK, sigue.
    } else {
      // Narrowing explícito: si !valid, el union tiene `schemaErrors` y `crossErrors`.
      // Usamos un cast porque TypeScript no narrowea bien el union en este
      // contexto (preexistente — ver `parser.ts` mismo patrón).
      const failed = validation as unknown as {
        schemaErrors: ReadonlyArray<{ instancePath?: string; message?: string }> | null;
        crossErrors: ReadonlyArray<{ message: string }>;
      };
      const errs: string[] = [];
      if (failed.schemaErrors) {
        for (const e of failed.schemaErrors) {
          errs.push(`schema ${e.instancePath ?? "/"}: ${e.message ?? "?"}`);
        }
      }
      for (const e of failed.crossErrors) {
        errs.push(`cross: ${e.message}`);
      }
      throw new ExecutorError(
        `Workflow "${workflow.id}" no es válido:\n  - ${errs.join("\n  - ")}`,
        "INTERNAL_BUG",
        { workflowId: workflow.id, errors: errs },
      );
    }

    // Input validation contra stateSchema. El input inicial debe cumplir
    // el shape declarado por el workflow. Falla con SCHEMA_VIOLATION claro.
    const inputValidation = validateStateAgainstSchema({ input }, workflow.stateSchema);
    if (!inputValidation.ok) {
      throw new ExecutorError(
        `Input inicial no cumple stateSchema del workflow "${workflow.id}": ${inputValidation.error}`,
        "SCHEMA_VIOLATION",
        { workflowId: workflow.id, errors: inputValidation.error },
      );
    }

    // D2b.1: validar que cada `node.assignedSpecialist` (si está declarado)
    // exista en el `SpecialistRegistry`. Falla fast al cargar el workflow
    // con `NODE_NOT_FOUND`. Ver `AGENT_D2B_1_SPEC.md` §3.11.
    if (this.config.specialistRegistry) {
      for (const n of workflow.nodes) {
        if (n.type === "llm" && n.assignedSpecialist) {
          const agentId = n.assignedSpecialist;
          if (!this.config.specialistRegistry.get(agentId)) {
            throw new ExecutorError(
              `Nodo "${n.id}" declara assignedSpecialist="${agentId}" pero el SpecialistRegistry no tiene ese agentId. Registrá el specialist en el ExecutorConfig.`,
              "NODE_NOT_FOUND",
              { workflowId: workflow.id, nodeId: n.id, agentId },
            );
          }
        }
      }
    } else {
      // Sin registry, ningún nodo puede tener `assignedSpecialist` declarado.
      for (const n of workflow.nodes) {
        if (n.type === "llm" && n.assignedSpecialist) {
          throw new ExecutorError(
            `Nodo "${n.id}" declara assignedSpecialist="${n.assignedSpecialist}" pero el ExecutorConfig no tiene specialistRegistry configurado. Proveé uno o quitá el assignedSpecialist del nodo.`,
            "NODE_NOT_FOUND",
            { workflowId: workflow.id, nodeId: n.id, agentId: n.assignedSpecialist },
          );
        }
      }
    }

    // Migración lazy: si el workflow tiene schemaVersion menor al del motor,
    // aplicar los migradores del registry. El resultado se persiste con la task.
    const { workflow: effectiveWorkflow, appliedMigrations } = this.loadAndMigrate(workflow);

    const taskId = this.config.taskIdGenerator
      ? this.config.taskIdGenerator()
      : randomUUID();

    const initialState: WorkflowState = {
      input,
    };

    const task: Task = {
      taskId,
      workflowId: effectiveWorkflow.id,
      workflowVersion: effectiveWorkflow.workflowVersion,
      state: initialState,
      status: "pending",
      currentNode: effectiveWorkflow.entryNode,
      nodeResults: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tenantId: "default", // D3 introduce tenant_id real
      input,
      ...(appliedMigrations.length > 0 && { migratedWorkflow: effectiveWorkflow }),
      ...(appliedMigrations.length > 0 && { appliedMigrations }),
    };

    this.tasks.set(taskId, task);
    this.taskWorkflows.set(taskId, effectiveWorkflow);
    this.idempotencyCaches.set(taskId, new Map());
    this.log?.info(`task created`, { taskId, workflowId: effectiveWorkflow.id });
    return task;
  }

  /**
   * Ejecuta una task. Avanza el grafo hasta:
   * - completed (no hay más nodos)
   * - failed (error con action='fail' o router sin match)
   * - paused_hitl (alcanzó un nodo HITL que requiere respuesta humana)
   * - cancelled (fue cancelada antes/durante)
   *
   * Throws ExecutorError si la task no existe, ya está corriendo, o no está
   * en un estado válido para ejecutar.
   */
  async run(taskId: string): Promise<TaskRunResult> {
    const task = this.requireTask(taskId);

    // Chequeamos cancelación ANTES de cualquier otra cosa. Si fue cancelada
    // antes de run(), bail inmediatamente.
    if (this.cancelledTasks.has(taskId) || task.status === "cancelled") {
      return this.makeResult(task);
    }

    if (task.status === "running") {
      throw new ExecutorError(
        `Task ${taskId} ya está corriendo. Llamadas concurrentes a run() no soportadas en v1.`,
        "TASK_ALREADY_RUNNING",
        { taskId },
      );
    }
    if (task.status === "completed" || task.status === "failed") {
      throw new ExecutorError(
        `Task ${taskId} ya terminó (status=${task.status}). Crear una nueva task.`,
        "INVALID_TASK_STATE",
        { taskId, status: task.status },
      );
    }
    if (task.status === "paused_hitl") {
      // D2a.4: una task paused_hitl NO se debe reanudar con run(). Si lo
      // hiciéramos, el motor invocaría al handler de nuevo y enviaría otra
      // notificación. La única forma legítima de reanudar es `resumeTask()`.
      throw new ExecutorError(
        `Task ${taskId} está paused_hitl. Use resumeTask(taskId, response) para reanudarla, no run().`,
        "INVALID_TASK_STATE",
        { taskId, status: task.status, hasPendingDecision: !!task.pendingDecision },
      );
    }
    // 'cancelled' y 'pending' se permiten: el loop maneja ambos.

    task.status = "running";
    task.startedAt = task.startedAt ?? new Date().toISOString();
    task.updatedAt = new Date().toISOString();
    this.log?.info(`task started`, { taskId, entryNode: task.currentNode });

    // AbortController para la duración del run. Si cancelan la task, abortamos
    // el signal; los invokers que lo respeten cancelan su trabajo en curso.
    // Los que no lo respeten, reciben la señal en el próximo check del loop.
    const abortController = new AbortController();
    // Si la task ya estaba en cancelledTasks cuando empezó el run, abort.
    if (this.cancelledTasks.has(taskId)) abortController.abort();

    try {
      await this.runLoop(task, abortController.signal);
    } catch (e) {
      // Errores del motor (bugs, no del workflow). Los loggeamos y marcamos failed.
      this.log?.error(`task crashed`, {
        taskId,
        error: e instanceof Error ? e.message : String(e),
      });
      task.status = "failed";
      task.error = {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      };
    }

    task.completedAt = new Date().toISOString();
    task.updatedAt = task.completedAt;
    this.log?.info(`task finished`, { taskId, status: task.status });
    return this.makeResult(task);
  }

  /**
   * Cancela una task. Si está running, el loop la interrumpirá en la próxima
   * iteración (cooperative cancellation via `cancelledTasks` set).
   * Si aún no corrió, run() detectará la cancelación y bail inmediatamente.
   *
   * D2a.4: si la task estaba `paused_hitl`, el `pendingDecision` se RETIENE
   * en la task (no se borra) para audit ("cancelada tras 3 días esperando
   * aprobación"). El estado terminal es `cancelled`, no `failed` — la
   * decisión de cancelar es del operador, no un fallo del workflow.
   */
  cancelTask(taskId: string): void {
    const task = this.requireTask(taskId);
    if (task.status === "completed" || task.status === "failed") {
      return; // ya terminó, no se puede cancelar
    }
    this.cancelledTasks.add(taskId);
    const wasPaused = task.status === "paused_hitl" && !!task.pendingDecision;
    task.status = "cancelled";
    // NO limpiamos pendingDecision: es evidencia de que la task estuvo
    // esperando HITL y fue cancelada. Útil para audit ("cancelada tras 3 días").
    task.updatedAt = new Date().toISOString();
    this.log?.info(`task cancelled`, { taskId, wasPausedHITL: wasPaused });
  }

  /**
   * Libera el cache de idempotency Y el flag de cancelación de una task,
   * pero RETIENE la task en el map interno y su workflow asociado.
   * Esto permite que `replayTask(taskId)` siga funcionando sobre la task
   * original.
   *
   * Para eliminar la task completamente (irrecuperable), usar `purgeTask(taskId)`.
   *
   * **MAY-2 (audit D2 2026-06-12 — cleanup #2)**: el spec D2a.2.3 §9.3
   * decía "libera el cache de idempotency pero retiene la task". El
   * comportamiento real también libera `cancelledTasks` (cambio
   * silencioso, no documentado). Ahora el spec está sincronizado
   * con el código: `cleanup` es un "soft reset" que libera
   * idempotency cache + cancellation flag, retiene task + workflow.
   *
   * D2a.2.3: cambio de comportamiento (backward-incompatible). Antes
   * (D2a.2.2 v1) `cleanup` eliminaba la task del map. Ahora libera
   * cache + cancellation flag, retiene task + workflow. Ver
   * `AGENT_D2A_2_3_CORE_PRIMITIVES_SPEC.md` §9.3.
   */
  cleanup(taskId: string): void {
    // Libera 2 cosas:
    this.idempotencyCaches.delete(taskId);
    this.cancelledTasks.delete(taskId);
    // Retiene 3 cosas:
    // - this.tasks (la task en sí)
    // - this.taskWorkflows (workflow asociado)
    // (la tercera es el `task.error`/`task.status` que el caller ya
    // conoce — no se modifica)
    this.log?.debug(`task soft-reset (cache + cancel flag liberados, task retenida)`, {
      taskId,
      retainedForReplay: true,
    });
  }

  /**
   * Elimina una task completamente del motor. Después de `purgeTask`,
   * la task es irrecuperable: `getTask(taskId)`, `run(taskId)` y
   * `replayTask(taskId)` retornan error o no encuentran la task.
   *
   * Usar cuando el caller está seguro de que no quiere la task más
   * (ej: después de archivar el audit log a storage externo en D3+).
   */
  purgeTask(taskId: string): void {
    const existed = this.tasks.delete(taskId);
    this.taskWorkflows.delete(taskId);
    this.cancelledTasks.delete(taskId);
    this.idempotencyCaches.delete(taskId);
    if (existed) {
      this.log?.debug(`task purged completely`, { taskId });
    }
  }

  /** Obtiene el estado actual de una task (snapshot). */
  getTask(taskId: string): Task | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    return { ...task, state: { ...this.getState(task) } };
  }

  /**
   * Lista de task IDs activas (no completed/failed/cancelled).
   * Útil para debugging y para un futuro dashboard de running tasks.
   */
  listActiveTasks(): readonly string[] {
    const active: string[] = [];
    for (const [id, task] of this.tasks) {
      if (
        task.status !== "completed" &&
        task.status !== "failed" &&
        task.status !== "cancelled"
      ) {
        active.push(id);
      }
    }
    return active;
  }

  /**
   * Crea una NUEVA task que es un replay de `originalTaskId` (D2a.2.3).
   * La original queda intacta.
   *
   * El replay arranca desde `fromNode` (o `entryNode`) con state reseteado a
   * `{ input: newInput }`. NO comparte el cache de idempotency con la
   * original. Hereda `tenantId` de la original. Usa `workflowVersion`
   * del workflow actual (no la de la original) — para audit de "qué cambió
   * entre 1.0.0 y 1.1.0".
   *
   * Si la original no terminó (sigue 'running', 'paused_hitl', 'pending'),
   * no se puede hacer replay.
   *
   * El `fromNode` debe existir como nodo en el workflow y debe haberse
   * ejecutado en la original (tener snapshot en `nodeResults`).
   */
  replayTask(originalTaskId: string, options: ReplayOptions = {}): Task {
    const original = this.requireTask(originalTaskId);

    // Solo tasks terminales son replayables.
    if (
      original.status !== "completed" &&
      original.status !== "failed" &&
      original.status !== "cancelled"
    ) {
      throw new ExecutorError(
        `Task ${originalTaskId} no está en estado terminal (status=${original.status}). Solo se puede hacer replay de tasks completadas, fallidas o canceladas.`,
        "INVALID_TASK_STATE",
        { taskId: originalTaskId, status: original.status },
      );
    }

    // Si el workflow fue editado/migrado entre la original y el replay,
    // usamos el workflow ACTUAL (no el snapshot de la original). Si la
    // original tenía un migratedWorkflow persistido, también lo respetamos.
    const workflow = this.taskWorkflows.get(original.taskId);
    if (!workflow) {
      throw new ExecutorError(
        `Workflow de la task original ${originalTaskId} ya no está disponible. Replay no se puede crear.`,
        "WORKFLOW_NOT_FOUND",
        { taskId: originalTaskId, workflowId: original.workflowId },
      );
    }
    const fromNode = options.fromNode ?? workflow.entryNode;

    // Validar que fromNode existe en la lista de nodos del workflow.
    const nodeExists = workflow.nodes.some((n) => n.id === fromNode);
    if (!nodeExists) {
      throw new ExecutorError(
        `Nodo "${fromNode}" no existe en el workflow "${workflow.id}".`,
        "NODE_NOT_FOUND",
        { workflowId: workflow.id, nodeId: fromNode },
      );
    }

    // Validar input contra stateSchema (consistencia con startTask).
    const newInput = options.input ?? original.input;
    const stateSchema = workflow.stateSchema;
    if (stateSchema) {
      const validation = validateStateAgainstSchema({ input: newInput }, stateSchema);
      if (!validation.ok) {
        throw new ExecutorError(
          `Input del replay no cumple stateSchema del workflow "${workflow.id}": ${validation.error}`,
          "SCHEMA_VIOLATION",
          { workflowId: workflow.id, replayOf: original.taskId, errors: validation.error },
        );
      }
    }

    // Crear la nueva task con replayOf apuntando a la original.
    const newTaskId = this.config.taskIdGenerator
      ? this.config.taskIdGenerator()
      : randomUUID();

    const replay: Task = {
      taskId: newTaskId,
      workflowId: original.workflowId,
      // Usamos la workflowVersion del workflow ACTUAL (no la de la original).
      // Razón: si el workflow fue editado/migrado entre la original y el replay,
      // el audit debe registrar qué versión corrió.
      workflowVersion: workflow.workflowVersion,
      state: { input: newInput },
      status: "pending",
      currentNode: fromNode,
      nodeResults: {}, // vacío — los snapshots vendrán de la ejecución nueva
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // Heredamos tenantId de la original (multi-tenant D3 se basa en esto).
      tenantId: original.tenantId,
      input: newInput,
      replayOf: original.taskId,
      replayInput: options.input !== undefined ? { input: options.input } : undefined,
      replayFromNode: fromNode,
    };

    this.tasks.set(newTaskId, replay);
    this.taskWorkflows.set(newTaskId, workflow);
    // CRÍTICO: cache de idempotency NUEVO y vacío. NO se comparte con la
    // original. Si se compartiera, un retry en el replay podría devolver
    // un output cacheado de la original con un state distinto — bug silencioso.
    this.idempotencyCaches.set(newTaskId, new Map());
    this.log?.info(`task replay created`, {
      newTaskId,
      originalTaskId,
      fromNode,
    });

    return replay;
  }

  // ─── HITL pause/resume (D2a.4) ──────────────────────────

  /**
   * Reanuda una task que está en `paused_hitl`, aplicando la respuesta humana.
   *
   * Pipeline:
   * 1. Verifica que la task existe y está en `paused_hitl` con `pendingDecision`.
   *    Si no, tira `ExecutorError` con código `INVALID_TASK_STATE`.
   * 2. Aplica la respuesta (delega a `applyHITLResponse`):
   *    - 'approved' con output válido contra `outputSchema`: escribe al state,
   *      valida state, encuentra el siguiente nodo, continúa el loop.
   *    - 'approved' con output INVÁLIDO: falla con `INVALID_OUTPUT`.
   *    - 'declined': marca el nodo como `failed` con `HITL_DECLINED` y
   *      persiste `declinedReason`, luego aplica `onError`. El motor es
   *      permisivo: procesa el decline aunque `allowDecline=false` (con
   *      warning). La policy "no se puede declinar" la aplica el handler
   *      externo, no el motor. Ver spec §6.11.
   *    - 'timeout': aplica `onTimeout` del nodo ('fail'/'approve'/'reject').
   * 3. El `run()` interno recorre los nodos hasta que la task alcanza un
   *    estado terminal o vuelve a pausar (otro HITL encontrado).
   * 4. Retorna `TaskRunResult` con el estado final.
   *
   * Idempotencia: si se llama `resumeTask` dos veces con respuestas distintas
   * sobre la misma task, la segunda llamada falla con `INVALID_TASK_STATE`
   * (la task ya no está `paused_hitl`).
   *
   * Ver `AGENT_D2A_4_HITL_PRIMITIVES_SPEC.md` §4.3.
   */
  async resumeTask(taskId: string, response: HITLResponse): Promise<TaskRunResult> {
    const task = this.requireTask(taskId);

    if (task.status !== "paused_hitl" || !task.pendingDecision) {
      throw new ExecutorError(
        `Task ${taskId} no está en paused_hitl (status=${task.status}, hasPendingDecision=${!!task.pendingDecision}). resumeTask solo aplica a tasks esperando respuesta HITL.`,
        "INVALID_TASK_STATE",
        { taskId, status: task.status, hasPendingDecision: !!task.pendingDecision },
      );
    }

    const workflow = this.getWorkflow(task);
    const nodeId = task.pendingDecision.nodeId;
    const node = this.getNode(workflow, nodeId);
    if (node.type !== "hitl") {
      // Bug: el pendingDecision apunta a un nodo que ya no es hitl.
      throw new ExecutorError(
        `pendingDecision de task ${taskId} apunta a nodo "${nodeId}" que no es hitl. Bug interno.`,
        "INTERNAL_BUG",
        { taskId, nodeId, nodeType: node.type },
      );
    }

    this.log?.info(`task resuming from HITL`, {
      taskId,
      nodeId,
      responseType: response.type,
      requestId: task.pendingDecision.requestId,
    });

    // Aplicar la respuesta. Esto restaura status='running' o marca la task
    // como terminal (failed/completed). El `pendingDecision` se borra.
    await this.applyHITLResponse(task, node, response);

    // Si la respuesta hizo que la task sea terminal, retornar ya.
    // Después de `applyHITLResponse`, el status puede ser 'running', 'failed',
    // o 'completed' (no 'paused_hitl' ya que limpiamos el pendingDecision).
    // El type guard del inicio narroweó `task.status` a 'paused_hitl', pero
    // `applyHITLResponse` lo cambió. Usamos un cast para evitar el narrowing
    // incorrecto de TS.
    const currentStatus = (task as { status: TaskStatus }).status;
    if (currentStatus === "failed" || currentStatus === "completed" || currentStatus === "cancelled") {
      return this.makeResult(task);
    }

    // Si la respuesta fue 'approved' o 'timeout' con onTimeout 'approve'/'reject',
    // o 'declined' con onError='continue', la respuesta no terminó la task y
    // hay que avanzar al siguiente nodo via edges antes de continuar el loop
    // (sino el runLoop re-ejecuta el mismo nodo HITL y se cuelga).
    // Para 'declined' con onError='goto', applyHITLResponse ya setea currentNode.
    // Para 'timeout' con onTimeout='fail' y 'declined' con onError='fail', el
    // status arriba ya es terminal, no llegamos acá.
    if (response.type === "approved" || response.type === "timeout") {
      const nextId = this.findNextNodeViaEdges(workflow, nodeId, this.getState(task));
      if (nextId === null) {
        task.status = "completed";
        return this.makeResult(task);
      }
      task.currentNode = nextId;
      task.updatedAt = new Date().toISOString();
    } else if (response.type === "declined") {
      // 'declined' con onError='continue': applyHITLResponse marcó el nodo
      // como skipped y dejó la task en running. Hay que avanzar al siguiente nodo.
      const onError = node.onError ?? "fail";
      if (onError === "continue") {
        const nextId = this.findNextNodeViaEdges(workflow, nodeId, this.getState(task));
        if (nextId === null) {
          task.status = "completed";
          return this.makeResult(task);
        }
        task.currentNode = nextId;
        task.updatedAt = new Date().toISOString();
      }
      // onError='fail' o 'goto' ya manejados arriba (fail → terminal, goto → currentNode seteado adentro).
    }
    const abortController = new AbortController();
    if (this.cancelledTasks.has(taskId)) abortController.abort();

    try {
      await this.runLoop(task, abortController.signal);
    } catch (e) {
      this.log?.error(`task crashed during resume`, {
        taskId,
        error: e instanceof Error ? e.message : String(e),
      });
      task.status = "failed";
      task.error = {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      };
    }

    task.completedAt = new Date().toISOString();
    task.updatedAt = task.completedAt;
    return this.makeResult(task);
  }

  /**
   * Helper interno. Llamado por `runLoop` cuando llega a un nodo HITL.
   *
   * Pipeline:
   * 1. Resuelve question/context del state (template interpolado).
   * 2. Llama al `HITLHandler.initiate()` (no-bloqueante). El handler
   *    notifica al canal externo y retorna `{ requestId, immediateResponse? }`.
   * 3. Si hay `immediateResponse`: borra el `pendingDecision`, restaura
   *    `status='running'`, aplica la respuesta via `applyHITLResponse`.
   *    El loop continúa.
   * 4. Si NO hay `immediateResponse`: persiste el `pendingDecision`,
   *    setea `status='paused_hitl'`, retorna. El caller (`runLoop`)
   *    ve el status y sale del loop. La task queda esperando `resumeTask`.
   *
   * Ver `AGENT_D2A_4_HITL_PRIMITIVES_SPEC.md` §4.4.
   */
  private async pauseForHITL(
    task: Task,
    node: HITLNode,
    workflow: WorkflowDefinition,
  ): Promise<void> {
    const state = this.getState(task);
    const question = resolveStateRef(state, node.question.from, node.question.default);
    const context = node.context
      ? resolveStateRef(state, node.context.from, node.context.default)
      : undefined;

    const timeoutMs = node.timeoutMs ?? workflow.config?.hitlDefaults?.timeoutMs;

    this.log?.debug(`hitl node ${node.id} initiating`, {
      taskId: task.taskId,
      nodeId: node.id,
      approvers: node.approvers,
      timeoutMs,
    });

    const outcome = await this.config.hitlHandler.initiate({
      taskId: task.taskId,
      nodeId: node.id,
      approvers: node.approvers,
      question,
      context,
      outputSchema: node.outputSchema,
      timeoutMs,
    });

    if (outcome.immediateResponse) {
      // Modo "interactivo" o test: el handler ya tiene la respuesta. La
      // pausa es virtual. Procesamos inline y el caller (runLoop) continúa.
      this.log?.debug(`hitl node ${node.id} got immediateResponse, processing inline`, {
        taskId: task.taskId,
        responseType: outcome.immediateResponse.type,
      });
      // Restaurar status='running' ANTES de aplicar la respuesta (ella
      // asume que la task está running).
      task.status = "running";
      await this.applyHITLResponse(task, node, outcome.immediateResponse);
      // Si la respuesta hizo que la task sea terminal, retornar.
      // runLoop chequea el status al volver, pero si la task es terminal
      // tenemos que cortar el ciclo acá para no iterar sobre un estado
      // ya cerrado.
      const terminalStatus = (task as { status: TaskStatus }).status;
      if (terminalStatus === "failed" || terminalStatus === "completed" || terminalStatus === "cancelled") {
        return;
      }
      return;
    }

    // Modo "desacoplado": pausa real. Persistir pendingDecision y setear status.
    const pending: PendingHITLDecision = {
      nodeId: node.id,
      requestId: outcome.requestId,
      approvers: node.approvers,
      question,
      context,
      outputSchema: node.outputSchema,
      startedAt: new Date().toISOString(),
    };
    task.pendingDecision = pending;
    task.status = "paused_hitl";
    task.updatedAt = pending.startedAt;
    this.log?.info(`task paused for HITL`, {
      taskId: task.taskId,
      nodeId: node.id,
      requestId: outcome.requestId,
      approvers: node.approvers,
    });
  }

  /**
   * Helper interno. Aplica una `HITLResponse` al nodo HITL que estaba esperando.
   * Llamado por:
   * - `resumeTask` (después de validar que la task está `paused_hitl`).
   * - `pauseForHITL` (cuando el handler retorna `immediateResponse`).
   *
   * Comportamiento por `response.type`:
   *
   * - **'approved'**: valida `response.output` contra `node.outputSchema` (si
   *   está declarado). Si válido, escribe al state via `writeOutputToState`,
   *   valida state post-output (acoplado a ajv draft-07), y deja la task
   *   en `running` para que el caller (resumeTask/runLoop) encuentre el
   *   siguiente nodo. Si inválido, falla la task con `INVALID_OUTPUT` y la
   *   razón del schema.
   *
   * - **'declined'**: marca el nodo como `failed` con `code: 'HITL_DECLINED'`
   *   y persiste `response.reason` en `NodeResult.declinedReason`. Luego
   *   aplica `node.onError` ('fail' termina la task, 'continue' lo marca
   *   como `skipped` y la task sigue, o 'goto' salta a otro nodo).
   *
   *   El motor es permisivo: procesa el decline aunque `node.allowDecline`
   *   sea `false` (con warning). La policy "no se puede declinar" la aplica
   *   el handler externo, no el motor. Ver spec §6.11.
   *
   * - **'timeout'**: consulta `node.onTimeout` (default 'fail'). Si 'fail',
   *   marca el nodo como `failed` con `code: 'HITL_TIMEOUT'`. Si 'approve',
   *   equivalente a `approved` con `output: { approved: true }`. Si 'reject',
   *   equivalente a `approved` con `output: { approved: false, feedback: 'timeout' }`.
   *
   * Pre-condiciones: la task está en `running` o en proceso de transición
   * desde `paused_hitl`. El `pendingDecision` puede o no estar presente
   * (en el caso de `immediateResponse`, no se persistió).
   *
   * Post-condiciones: la task puede quedar en `running` (caso normal),
   * `failed` (caso inválido o decline), o seguir su `onError`.
   *
   * Limpia `task.pendingDecision` si estaba presente.
   *
   * Ver `AGENT_D2A_4_HITL_PRIMITIVES_SPEC.md` §4.4 y §6.
   */
  private async applyHITLResponse(
    task: Task,
    node: HITLNode,
    response: HITLResponse,
  ): Promise<void> {
    // Limpiar pendingDecision si estaba (en el caso immediateResponse no
    // se persistió, pero el `delete` es seguro — el campo es mutable).
    if (task.pendingDecision) {
      task.pendingDecision = undefined;
    }

    // Resolver la respuesta efectiva: el caso 'timeout' puede mapearse a
    // un output concreto según onTimeout.
    let effective: { type: "approved" | "declined" | "timeout"; output?: unknown; reason?: string };
    if (response.type === "timeout") {
      const onTimeout = node.onTimeout ?? "fail";
      if (onTimeout === "fail") {
        effective = { type: "timeout" };
      } else if (onTimeout === "approve") {
        effective = { type: "approved", output: { approved: true } };
      } else {
        effective = { type: "approved", output: { approved: false, feedback: "timeout" } };
      }
    } else {
      effective = response;
    }

    const nodeId = node.id;
    const startedAt = new Date().toISOString();

    switch (effective.type) {
      case "approved": {
        const output = effective.output;
        // Validar contra outputSchema si está declarado.
        if (node.outputSchema) {
          const valid = validateAgainstSchema(output, node.outputSchema);
          if (!valid.ok) {
            // Narrow: si !valid.ok, el union tiene `error: string`.
            const errMsg = (valid as { ok: false; error: string }).error;
            const result: NodeResult = {
              nodeId,
              status: "failed",
              startedAt,
              completedAt: new Date().toISOString(),
              error: {
                code: "INVALID_OUTPUT",
                message: `HITL response no cumple outputSchema del nodo "${nodeId}": ${errMsg}`,
                retriable: false,
              },
              retryCount: 0,
              costUsd: 0,
            };
            task.nodeResults[nodeId] = result;
            this.failTask(task, {
              code: "INVALID_OUTPUT",
              message: `HITL response no cumple outputSchema del nodo "${nodeId}": ${errMsg}`,
              failedNode: nodeId,
            });
            return;
          }
        }
        // Output válido: escribir al state y validar state post-output.
        task.nodeResults[nodeId] = {
          nodeId,
          status: "completed",
          startedAt,
          completedAt: new Date().toISOString(),
          output,
          retryCount: 0,
          costUsd: 0,  // HITL no incurre en costo LLM. MIN-5.
        };
        this.writeOutputToState(task, node, output);

        // State validation post-output (D2a.2.3).
        const workflow = this.getWorkflow(task);
        const stateValidation = validateStateAgainstSchema(task.state, workflow.stateSchema);
        if (!stateValidation.ok) {
          const failedResult: NodeResult = {
            ...task.nodeResults[nodeId]!,
            status: "failed",
            error: {
              code: "SCHEMA_VIOLATION",
              message: `Output del nodo "${nodeId}" dejó el state inválido: ${stateValidation.error}`,
              retriable: false,
            },
          };
          task.nodeResults[nodeId] = failedResult;
          this.failTask(task, {
            code: "SCHEMA_VIOLATION",
            message: `State inválido después de "${nodeId}": ${stateValidation.error}`,
            failedNode: nodeId,
          });
          return;
        }
        // OK: la task sigue running. El caller (resumeTask/runLoop) encontrará
        // el siguiente nodo.
        return;
      }
      case "declined": {
        if (!node.allowDecline) {
          // Backward-compatible: el test preexistente `test_workflow_executor.mts:1300`
          // asume que el decline se procesa aunque `allowDecline` no esté declarado.
          // El motor es permisivo: procesa el decline y loguea un warning. La
          // policy "no se puede declinar" la aplica el handler externo, no el motor.
          this.log?.warn(`HITL node "${nodeId}" received declined response but allowDecline=false. Processing anyway. Caller should enforce the policy.`, {
            taskId: task.taskId,
            nodeId,
            reason: effective.reason,
          });
        }
        // Marcar nodo como failed con razón.
        task.nodeResults[nodeId] = {
          nodeId,
          status: "failed",
          startedAt,
          completedAt: new Date().toISOString(),
          declinedReason: effective.reason,
          error: {
            code: "HITL_DECLINED",
            message: `Approver declinó: ${effective.reason}`,
            retriable: false,
          },
          retryCount: 0,
          costUsd: 0,  // HITL no incurre en costo LLM. MIN-5.
        };
        // Aplicar onError del nodo.
        const action = node.onError ?? "fail";
        if (action === "fail") {
          this.failTask(task, {
            code: "HITL_DECLINED",
            message: `Approver declinó: ${effective.reason}`,
            failedNode: nodeId,
          });
          return;
        }
        if (action === "continue") {
          // Marcar como skipped (visualmente claro que el nodo no se ejecutó
          // pero el workflow sigue) y dejar la task en running para que el
          // loop encuentre el siguiente nodo.
          task.nodeResults[nodeId] = {
            ...task.nodeResults[nodeId]!,
            status: "skipped",
            error: undefined,
          };
          return;
        }
        // action es { goto: ... }
        task.currentNode = action.goto;
        return;
      }
      case "timeout": {
        // onTimeout === 'fail' (los otros dos casos se mapearon a 'approved' arriba).
        task.nodeResults[nodeId] = {
          nodeId,
          status: "failed",
          startedAt,
          completedAt: new Date().toISOString(),
          error: {
            code: "HITL_TIMEOUT",
            message: `HITL timed out sin respuesta.`,
            retriable: false,
          },
          retryCount: 0,
          costUsd: 0,  // HITL no incurre en costo LLM. MIN-5.
        };
        this.failTask(task, {
          code: "HITL_TIMEOUT",
          message: `HITL node "${nodeId}" timed out.`,
          failedNode: nodeId,
        });
        return;
      }
    }
  }

  // ─── Loop principal ──────────────────────────────────────

  private async runLoop(task: Task, signal: AbortSignal): Promise<void> {
    const workflow = this.getWorkflow(task);

    while (true) {
      // Check cancellation en cada iteración (cooperative).
      if (this.cancelledTasks.has(task.taskId) || signal.aborted) {
        task.status = "cancelled";
        return;
      }

      // Check terminal state (D2a.4: defensa contra loops infinitos si un
      // helper interno como `applyHITLResponse` ya marcó la task como
      // terminal sin retornar). El cast es para escapar el narrowing de TS.
      const loopStatus = (task as { status: TaskStatus }).status;
      if (loopStatus === "failed" || loopStatus === "completed" || loopStatus === "cancelled") {
        return;
      }

      const node = this.getNode(workflow, task.currentNode);
      const state = this.getState(task);

      // 1. Router node: no se ejecuta, solo se evalúa para encontrar el siguiente nodo.
      if (node.type === "router") {
        const nextId = this.resolveRouter(node, state);
        if (nextId === null) {
          this.failTask(task, {
            code: "ROUTER_NO_MATCH",
            message: `Router "${node.id}" no encontró match ni default.`,
            failedNode: node.id,
          });
          return;
        }
        this.log?.debug(`router ${node.id} → ${nextId}`, { taskId: task.taskId });
        task.currentNode = nextId;
        task.updatedAt = new Date().toISOString();
        continue;
      }

      // 1b. HITL node (D2a.4): la pausa se maneja en el executor, NO en
      // el node-runner. Llamamos a `pauseForHITL`, que invoca al handler
      // (no-bloqueante) y setea `status='paused_hitl'`. Si el handler
      // retornó `immediateResponse`, la pausa es virtual: aplicamos la
      // respuesta inline y avanzamos al siguiente nodo. Si no, retornamos
      // y la task queda esperando `resumeTask`.
      if (node.type === "hitl") {
        await this.pauseForHITL(task, node, workflow);
        // Si la task quedó paused_hitl, salimos del loop (queda esperando resumeTask).
        if (task.status === "paused_hitl") {
          return;
        }
        // Si pauseForHITL marcó la task como terminal (falla de schema o
        // decline con onError='fail'), salimos del loop.
        const hitlStatus = (task as { status: TaskStatus }).status;
        if (hitlStatus === "failed" || hitlStatus === "completed" || hitlStatus === "cancelled") {
          return;
        }
        // immediateResponse procesado OK (output escrito al state, state validado).
        // Avanzar al siguiente nodo via edges. findNextNodeViaEdges retorna null
        // si el nodo HITL era terminal (sin edges salientes) → task completed.
        // Usamos `this.getState(task)` (state actualizado post-pauseForHITL) en lugar
        // del `state` del inicio del loop, por si los edges HITL son condicionales.
        const nextId = this.findNextNodeViaEdges(workflow, node.id, this.getState(task));
        if (nextId === null) {
          task.status = "completed";
          return;
        }
        task.currentNode = nextId;
        task.updatedAt = new Date().toISOString();
        continue;
      }

      // 2. Non-router, non-hitl node: ejecutar con timeout + retry + idempotency.
      //    El node-runner es PURO (1 intento, sin retries). El executor
      //    coordina los retries alrededor, incluyendo el check del circuit
      //    breaker antes de CADA attempt.
      const outcome = await this.executeWithTimeoutAndRetry(
        task,
        node,
        workflow,
        signal,
      );

      // 3. Failure: aplicar error action.
      if (outcome.status === "failed") {
        const action = this.resolveErrorAction(node);

        if (action === "fail") {
          // El nodo falló y la acción es fail → task failed.
          this.recordNodeResult(
            task,
            node,
            this.makeFailedResult(node.id, outcome, "failed"),
          );
          this.failTask(task, {
            code: outcome.code,
            message: outcome.message,
            failedNode: node.id,
          });
          return;
        }

        if (action === "continue") {
          // El nodo falló pero la acción es continue → marcamos como 'skipped'
          // (sin error, sin output) y seguimos al siguiente nodo.
          this.log?.debug(`node ${node.id} failed, continuing (skipped)`, {
            taskId: task.taskId,
            error: outcome.code,
          });
          this.recordNodeResult(
            task,
            node,
            this.makeFailedResult(node.id, outcome, "skipped"),
          );
          const nextId = this.findNextNodeViaEdges(workflow, node.id, state);
          if (nextId === null) {
            task.status = "completed";
            return;
          }
          task.currentNode = nextId;
          task.updatedAt = new Date().toISOString();
          continue;
        }

        // action es { goto: ... }: el nodo falló y saltamos a otro.
        this.log?.debug(`node ${node.id} failed, goto ${action.goto}`, {
          taskId: task.taskId,
          error: outcome.code,
        });
        this.recordNodeResult(
          task,
          node,
          this.makeFailedResult(node.id, outcome, "failed"),
        );
        task.currentNode = action.goto;
        task.updatedAt = new Date().toISOString();
        continue;
      }

      // 4. Success: persistir resultado, escribir al state, validar state.
      // D2b.1: si el nodo LLM tiene `assignedSpecialist`, calcular
      // `executedBy` (agentId, agentVersion, tier, model) para el audit.
      let executedBy: { agentId: string; agentVersion: string; tier: string; model: string } | undefined;
      if (node.type === "llm" && node.assignedSpecialist && this.config.specialistRegistry) {
        const specialist = this.config.specialistRegistry.get(node.assignedSpecialist);
        if (specialist) {
          const tier = outcome.modelUsed ?? node.model;
          executedBy = {
            agentId: specialist.agentId,
            agentVersion: specialist.agentVersion,
            tier,
            model: outcome.modelUsed ?? tier,
          };
        }
      }
      this.recordNodeResult(
        task,
        node,
        this.makeSuccessResult(node.id, outcome, executedBy),
      );
      this.writeOutputToState(task, node, outcome.output);

      // 4b. State validation post-output (D2a.2.3). Si el state quedó
      // inválido, el nodo se marca como failed con SCHEMA_VIOLATION y la
      // task falla. La validación se hace DESPUÉS de escribir al state.
      const stateValidation = validateStateAgainstSchema(
        task.state,
        workflow.stateSchema,
      );
      if (!stateValidation.ok) {
        this.log?.warn(`state invalid after node ${node.id}`, {
          taskId: task.taskId,
          error: stateValidation.error,
        });
        // Sobreescribimos el NodeResult a "failed" (era "completed").
        const failedResult: NodeResult = {
          ...task.nodeResults[node.id]!,
          status: "failed",
          error: {
            code: "SCHEMA_VIOLATION",
            message: `Output del nodo "${node.id}" dejó el state inválido: ${stateValidation.error}`,
            retriable: false,
          },
        };
        task.nodeResults[node.id] = failedResult;
        this.failTask(task, {
          code: "SCHEMA_VIOLATION",
          message: `State inválido después de "${node.id}": ${stateValidation.error}`,
          failedNode: node.id,
        });
        return;
      }

      // 5. Encontrar el siguiente nodo.
      const nextId = this.findNextNodeViaEdges(workflow, node.id, state);
      if (nextId === null) {
        task.status = "completed";
        return;
      }
      task.currentNode = nextId;
      task.updatedAt = new Date().toISOString();
    }
  }

  // ─── Helpers de navegación ───────────────────────────────

  private findNextNodeViaEdges(
    workflow: WorkflowDefinition,
    fromNodeId: string,
    state: WorkflowState,
  ): string | null {
    const outgoing = workflow.edges.filter((e) => e.from === fromNodeId);
    if (outgoing.length === 0) return null; // terminal node

    // Tomamos el primer edge cuya condición evalúa a true.
    // Si ninguno matchea y hay edges incondicionales, esos matchean.
    for (const edge of outgoing) {
      if (evaluateEdgeCondition(state, edge.condition)) {
        return edge.to;
      }
    }
    return null;
  }

  private resolveRouter(node: RouterNode, state: WorkflowState): string | null {
    const decisionValue = resolveStateRef(
      state,
      node.decision.from,
      node.decision.default,
    );
    if (typeof decisionValue !== "string") return null;

    let next: string | undefined;
    if (node.matchMode === "case-insensitive") {
      const lower = decisionValue.toLowerCase();
      for (const [k, v] of Object.entries(node.routes)) {
        if (k.toLowerCase() === lower) {
          next = v;
          break;
        }
      }
    } else {
      next = node.routes[decisionValue];
    }
    if (next === undefined && node.default !== undefined) {
      next = node.default;
    }
    return next ?? null;
  }

  // ─── State I/O ──────────────────────────────────────────

  private writeOutputToState(task: Task, node: WorkflowNode, output: unknown): void {
    const state = task.state as WorkflowState;

    if (node.type === "router" || node.type === "hitl") {
      // HITL tiene output; routers no.
      if (node.type === "router") return;
    }

    // Para function/llm/hitl, el output.to es un StateRef.
    // Convención: si tiene path, escribir a ese path. Si no, escribir a state[node.id].
    // Si tiene template (raro para output), ignorar.
    const outputRef = this.getOutputRef(node);
    if (outputRef?.path) {
      setByPath(state, outputRef.path, output);
    } else {
      // Default: escribir el output completo bajo la key del node ID.
      state[node.id] = output;
    }
    this.log?.debug(`wrote output to state`, {
      taskId: task.taskId,
      nodeId: node.id,
      path: outputRef?.path ?? node.id,
    });
  }

  private getOutputRef(node: WorkflowNode): { path?: string; template?: string } | null {
    if (node.type === "router") return null;
    return node.output.to;
  }

  // ─── Ejecución con timeout + retry + idempotency + circuit breaker ───

  /**
   * Ejecuta un nodo con timeout per-attempt, retry según RetryConfig,
   * idempotency cache si el nodo declara `idempotencyKey`, y circuit breaker.
   *
   * El nodo-runner es PURO: ejecuta 1 intento. Este método coordina:
   * 1. Crea un AbortController con timeoutMs.
   * 2. Combina con el signal del padre (cancelación).
   * 3. Consulta `breaker.isOpen(specialistId)` ANTES DE CADA ATTEMPT.
   * 4. Llama runNode.
   * 5. Si timedOut, convierte el outcome a TIMEOUT failure.
   * 6. Si success y hay idempotencyKey, cachea.
   * 7. Si failure, decide retry según RetryConfig.
   *
   * Decisión de diseño: el motor decide el retry, no el nodo. Esto permite
   * coordinar timeouts, idempotency, cancellation y circuit breaker en un
   * solo lugar.
   */
  private async executeWithTimeoutAndRetry(
    task: Task,
    node: WorkflowNode,
    workflow: WorkflowDefinition,
    parentSignal: AbortSignal,
  ): Promise<NodeExecutionOutcome> {
    const maxRetries = node.retries?.max ?? workflow.config?.defaultRetries ?? 0;
    const maxAttempts = maxRetries + 1;
    const onFilter = node.retries?.on;
    const backoffType = node.retries?.backoff ?? "exponential";
    const initialDelay = node.retries?.initialDelayMs ?? 1000;
    const timeoutMs = node.timeoutMs ?? workflow.config?.defaultTimeoutMs ?? 0;

    // Specialist ID para el circuit breaker. En D2a, mapeamos a node.model.
    // En D2b, esto se extiende para specialists reales.
    const specialistId = node.type === "llm" ? node.model : undefined;

    let attempt = 0;
    let lastOutcome: NodeExecutionOutcome | undefined;

    while (attempt < maxAttempts) {
      // ── 1. Circuit breaker check (antes de CADA attempt) ──
      if (specialistId && this.circuitBreaker.isOpen(specialistId)) {
        return {
          status: "failed",
          code: "MODEL_UNAVAILABLE",
          message: `Circuit breaker abierto para specialist "${specialistId}". Reintentá más tarde.`,
          retriable: true,
          retryCount: attempt,
        };
      }

      // ── 2. Idempotency cache check (solo en retries, attempt > 0) ──
      if (node.idempotencyKey && attempt > 0) {
        const cacheKey = this.getIdempotencyKey(task, node);
        const cached = this.idempotencyCaches.get(task.taskId)?.get(cacheKey);
        if (cached) {
          this.log?.debug(`idempotency cache hit`, {
            taskId: task.taskId,
            nodeId: node.id,
            cacheKey,
            attempt,
          });
          return { ...cached, retryCount: attempt };
        }
      }

      // ── 3. Execute con timeout ──
      const combined = this.createCombinedSignal(parentSignal);
      let timedOut = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          combined.controller.abort();
        }, timeoutMs);
      }

      let outcome: NodeExecutionOutcome;
      try {
        outcome = await runNode({
          node,
          workflow,
          task,
          llmInvoker: this.config.llmInvoker,
          hitlHandler: this.config.hitlHandler,
          functionLookup: (name) => this.config.functionRegistry.get(name),
          signal: combined.signal,
          logger: this.log,
          circuitBreaker: this.circuitBreaker,
          specialistId,
          specialistRegistry: this.config.specialistRegistry,
          tierResolver: this.config.tierResolver,
        });
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }

      // ── 4. Si timedOut, sobrescribimos con TIMEOUT failure ──
      if (timedOut) {
        lastOutcome = {
          status: "failed",
          code: "TIMEOUT",
          message: `Node "${node.id}" excedió timeout de ${timeoutMs}ms.`,
          retriable: true,
          retryCount: attempt,
        };
      } else {
        lastOutcome = { ...outcome, retryCount: attempt };
      }

      // ── 5. Success: cachear si corresponde ──
      if (lastOutcome.status === "completed" && node.idempotencyKey) {
        const cacheKey = this.getIdempotencyKey(task, node);
        const cache = this.idempotencyCaches.get(task.taskId);
        if (cache) {
          cache.set(cacheKey, lastOutcome as NodeExecutionSuccess);
          this.log?.debug(`idempotency cache stored`, {
            taskId: task.taskId,
            nodeId: node.id,
            cacheKey,
          });
        }
      }

      if (lastOutcome.status !== "failed") {
        return lastOutcome;
      }

      // ── 6. Failure: decidir si retry ──
      attempt++;
      if (attempt >= maxAttempts) break;

      // Safety net PRIMERO: si el nodo no es idempotent ni retriable, no podemos
      // re-ejecutar sin riesgo de duplicar efectos.
      if (!node.idempotencyKey && !node.retriable) {
        lastOutcome = {
          ...lastOutcome,
          code: "NON_IDEMPOTENT_RETRY_DISALLOWED",
          message: `Node "${node.id}" no declara idempotencyKey ni retriable=true; retry bloqueado para evitar duplicar efectos. Error original: ${lastOutcome.message}`,
          retryCount: attempt - 1,
        };
        break;
      }

      // Filtro de códigos de error.
      if (onFilter !== undefined) {
        if (!onFilter.includes(lastOutcome.code)) break;
      } else if (node.retries !== undefined) {
        // Override del usuario en el nodo. No aplicamos catalog filter.
      } else {
        // Solo defaultRetries del workflow. Catalog filter como safety net.
        if (!isRetriableByDefault(lastOutcome.code)) break;
      }

      // ── 7. Backoff antes del próximo intento ──
      const delay =
        backoffType === "exponential"
          ? initialDelay * Math.pow(2, attempt - 1)
          : initialDelay;
      this.log?.debug(`retrying node after backoff`, {
        taskId: task.taskId,
        nodeId: node.id,
        attempt,
        delayMs: delay,
        errorCode: lastOutcome.code,
      });
      await new Promise<void>((r) => setTimeout(r, delay));
    }

    return lastOutcome!;
  }

  /**
   * Combina el signal de cancelación del padre con un nuevo controller local.
   * Si el padre aborta, el controller local también aborta. Devuelve el signal
   * combinado (que se pasa a invokers) y el controller (que podemos abortar
   * manualmente desde el timeout).
   */
  private createCombinedSignal(parent: AbortSignal): {
    signal: AbortSignal;
    controller: AbortController;
  } {
    const controller = new AbortController();
    if (parent.aborted) {
      controller.abort();
      return { signal: controller.signal, controller };
    }
    const onAbort = () => controller.abort();
    parent.addEventListener("abort", onAbort, { once: true });
    return { signal: controller.signal, controller };
  }

  /**
   * Renderiza el `idempotencyKey` template con el state actual.
   */
  private getIdempotencyKey(task: Task, node: WorkflowNode): string {
    if (!node.idempotencyKey) return "";
    return interpolate(node.idempotencyKey, this.getState(task));
  }

  /**
   * Carga el workflow aplicando migradores si es necesario (D2a.2.3).
   * Wrapper trivial sobre `loadWorkflow` (migrations.ts). La única razón
   * de existir como método privado es inyectar `this.schemaVersion` y
   * `this.migrators` desde el `ExecutorConfig`. La lógica vive en
   * `migrations.ts` (single source of truth).
   *
   * MAY-1 (audit D2 2026-06-12): antes esta función duplicaba la lógica
   * de `loadWorkflow`. Consolidada en D2b.2 cleanup.
   */
  private loadAndMigrate(workflow: WorkflowDefinition): {
    workflow: WorkflowDefinition;
    appliedMigrations: readonly string[];
  } {
    return loadWorkflow(workflow, this.migrators, this.schemaVersion);
  }

  // ─── Helpers de task ────────────────────────────────────

  private getState(task: Task): WorkflowState {
    // Type guard: el state debería ser un objeto. Si por alguna razón no lo
    // es (e.g., DB corruption), retornamos {} para que el motor no tire.
    const s = task.state;
    if (s == null || typeof s !== "object" || Array.isArray(s)) {
      return {};
    }
    return s as WorkflowState;
  }

  private makeSuccessResult(
    nodeId: string,
    outcome: {
      output: unknown;
      confidence?: "HIGH" | "MEDIUM" | "LOW";
      confidenceValue?: number;
      tokensUsed?: { input: number; output: number };
      /** MIN-5: default 0 si el invoker no retornó costUsd. Nunca undefined. */
      costUsd?: number;
      modelUsed?: string;
      retryCount: number;
      promptSnapshot?: PromptSnapshot;
    },
    /**
     * D2b.1: metadata opcional. Si está presente, se setea
     * `NodeResult.metadata.executedBy` con agentId, agentVersion, tier y
     * model. Solo se popula para nodos LLM con `assignedSpecialist`
     * (información de quién ejecutó el nodo para audit/cost attribution).
     */
    executedBy?: {
      readonly agentId: string;
      readonly agentVersion: string;
      readonly tier: string;
      readonly model: string;
    },
  ): NodeResult {
    const base: NodeResult = {
      nodeId,
      status: "completed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      output: outcome.output,
      confidence: outcome.confidence,
      confidenceValue: outcome.confidenceValue,
      tokensUsed: outcome.tokensUsed,
      // MIN-5: `costUsd` siempre presente en NodeResult. Si el invoker
      // no retornó, default 0. Forward-compat con audit que asume
      // número, no undefined.
      costUsd: outcome.costUsd ?? 0,
      modelUsed: outcome.modelUsed,
      retryCount: outcome.retryCount,
      promptSnapshot: outcome.promptSnapshot,
    };
    if (executedBy) {
      (base as { metadata?: unknown }).metadata = { executedBy };
    }
    return base;
  }

  private makeFailedResult(
    nodeId: string,
    outcome: {
      code: import("../dsl/types.js").ErrorCode;
      message: string;
      retriable: boolean;
      stack?: string;
      retryCount: number;
    },
    status: "failed" | "skipped",
  ): NodeResult {
    if (status === "skipped") {
      return {
        nodeId,
        status: "skipped",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        retryCount: outcome.retryCount,
        costUsd: 0,  // MIN-5: skipped no incurre en costo LLM.
      };
    }
    return {
      nodeId,
      status: "failed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: {
        code: outcome.code,
        message: outcome.message,
        retriable: outcome.retriable,
        stack: outcome.stack,
      },
      retryCount: outcome.retryCount,
      costUsd: 0,  // MIN-5: failed sin output no incurre en costo LLM.
    };
  }

  private recordNodeResult(
    task: Task,
    node: WorkflowNode,
    result: NodeResult,
  ): void {
    task.nodeResults[node.id] = result;
  }

  private failTask(
    task: Task,
    error: { code: ErrorCode; message: string; failedNode?: string },
  ): void {
    task.status = "failed";
    task.error = error satisfies TaskError;
    task.updatedAt = new Date().toISOString();
    this.log?.warn(`task failed`, {
      taskId: task.taskId,
      code: error.code,
      failedNode: error.failedNode,
    });
  }

  private resolveErrorAction(
    node: WorkflowNode,
  ): "fail" | "continue" | { goto: string } {
    if (node.type === "router") return "fail";
    return node.onError ?? "fail";
  }

  private makeResult(task: Task): TaskRunResult {
    return {
      taskId: task.taskId,
      status: task.status,
      nodeResults: task.nodeResults,
      state: task.state as WorkflowState,
      error: task.error,
    };
  }

  // ─── Helpers de workflow / task lookup ──────────────────

  private requireTask(taskId: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new ExecutorError(
        `Task ${taskId} no existe.`,
        "TASK_NOT_FOUND",
        { taskId },
      );
    }
    return task;
  }

  private getWorkflow(task: Task): WorkflowDefinition {
    const w = this.taskWorkflows.get(task.taskId);
    if (!w) {
      throw new ExecutorError(
        `Task ${task.taskId} no tiene workflow asociado. Bug del executor.`,
        "INTERNAL_BUG",
        { taskId: task.taskId },
      );
    }
    return w;
  }

  private getNode(workflow: WorkflowDefinition, nodeId: string): WorkflowNode {
    const n = workflow.nodes.find((x) => x.id === nodeId);
    if (!n) {
      throw new ExecutorError(
        `Nodo "${nodeId}" no existe en el workflow "${workflow.id}".`,
        "NODE_NOT_FOUND",
        { workflowId: workflow.id, nodeId },
      );
    }
    return n;
  }

  private assertWorkflowValid(workflow: WorkflowDefinition): void {
    if (!workflow.id) {
      throw new ExecutorError("Workflow sin id.", "INTERNAL_BUG");
    }
    if (!workflow.entryNode) {
      throw new ExecutorError("Workflow sin entryNode.", "INTERNAL_BUG");
    }
    if (workflow.nodes.length === 0) {
      throw new ExecutorError("Workflow sin nodos.", "INTERNAL_BUG");
    }
  }
}

// ============================================================
// Helpers locales
// ============================================================

/**
 * Valida un valor contra un JSON Schema usando ajv. Compila el schema por
 * llamada. Usado por `applyHITLResponse` para validar `response.output`
 * contra `node.outputSchema` cuando llega un HITL approved.
 *
 * Retorna `{ ok: true }` o `{ ok: false, error: string }`.
 *
 * Acoplado a `ajv` (draft-07), mismo patrón que `node-runner.ts::validateAgainstSchema`.
 * Si en el futuro se centraliza la validación, este helper se elimina.
 */
function validateAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>,
):
  | { ok: true }
  | { ok: false; error: string } {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  const valid = validate(value);
  if (valid) return { ok: true };
  const errs = (validate.errors ?? [])
    .map((e: { instancePath?: string; message?: string }) => `${e.instancePath ?? "/"} ${e.message ?? ""}`)
    .join("; ");
  return { ok: false, error: errs };
}

// ============================================================
// Tipos auxiliares públicos
// ============================================================

/**
 * Opciones para `replayTask()`. D2a.2.3.
 *
 * - `input`: input nuevo. Si se omite, usa el input de la original.
 * - `fromNode`: nodo desde el cual re-ejecutar. Si se omite, desde `entryNode`.
 *
 * El `resetStateToSnapshot` del DSL spec §6.5 NO está implementado en D2a
 * (solo reset total). Reset parcial es D3+.
 */
export interface ReplayOptions {
  /** Input nuevo (opcional). Si se omite, usa el input original. */
  input?: unknown;
  /** Nodo desde el cual re-ejecutar (opcional, default: entryNode). */
  fromNode?: string;
}
