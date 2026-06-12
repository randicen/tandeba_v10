/**
 * Worgena Workflow Engine — Executor.
 *
 * Barrel export. El executor consume el DSL (tipos + parser) y agrega
 * las primitivas de runtime.
 *
 * D2a.2 + D2a.2.2 + D2a.2.3 + D2a.4 + D2b.1 incluye:
 * - WorkflowExecutor: clase principal, ejecuta workflows
 * - FunctionRegistry: registry de funciones para nodos function
 * - runNode: ejecuta un solo nodo (usado internamente y testeable en aislamiento)
 * - State helpers: getByPath, setByPath, resolveStateRef, interpolate, validateStateAgainstSchema
 * - CircuitBreaker interface + NoopCircuitBreaker default
 * - ReplayOptions (replayTask)
 * - Interfaces: LLMInvoker, HITLHandler, ExecutorLogger
 * - D2a.4: HITL primitives reales (initiate no-bloqueante + resumeTask).
 * - D2b.1: multi-model router (TierResolver) + 3 specialists con mocks.
 *
 * Cubre:
 * - D2a.2: Task lifecycle, loop principal, router nodes, error actions, state I/O.
 * - D2a.2.2: Timeout per-attempt, retry config con backoff, idempotency cache,
 *   NON_IDEMPOTENT_RETRY_DISALLOWED safety net.
 * - D2a.2.3: State schema validation (input + post-output), prompt snapshot
 *   persistence, time travel / replay, lazy schema migration al ejecutar,
 *   circuit breaker interface, limpieza de HITL paused branch, `cleanup()`
 *   no destructivo + `purgeTask()`.
 * - D2a.4: HITL primitives con pause/resume reales. `HITLHandler.initiate()`
 *   no-bloqueante + `executor.resumeTask(taskId, response)` para continuar.
 *   Tasks `paused_hitl` viven en memoria hasta `resumeTask`/`cancelTask`/`purgeTask`.
 * - D2b.1: routing a specialists vía `node.assignedSpecialist` +
 *   `ExecutorConfig.specialistRegistry`. Si el nodo tiene `assignedSpecialist`
 *   y el registry lo tiene, el motor delega al specialist. Si no, comportamiento
 *   D2a.4 (con la opción de pasar por `TierResolver` si está configurado).
 *
 * Decisión: el executor NO re-valida la shape del workflow. Se asume que
 * el caller ya lo pasó por `parseWorkflow` o `validateWorkflow`. La
 * state validation SÍ corre en runtime (D2a.2.3) — el input en `startTask`
 * y el state después de cada output de nodo.
 */

export { WorkflowExecutor } from "./executor.js";
export type { ReplayOptions } from "./executor.js";
export { runNode } from "./node-runner.js";
export { FunctionRegistry } from "./function-registry.js";
export {
  getByPath,
  setByPath,
  resolveStateRef,
  interpolate,
  evaluateEdgeCondition,
  validateStateAgainstSchema,
} from "./state.js";
export type { StateValidationResult } from "./state.js";
export { ExecutorError, toNodeRuntimeError, isRetriableByDefault } from "./errors.js";
export { NoopCircuitBreaker } from "./circuit-breaker.js";
export type { CircuitBreaker } from "./circuit-breaker.js";

export type {
  LLMInvoker,
  LLMInvokeParams,
  LLMInvokeResult,
  HITLHandler,
  HITLInitiateParams,
  HITLInitiateResult,
  HITLResponse,
  WorkflowFunction,
  WorkflowState,
  NodeExecutionOutcome,
  NodeExecutionSuccess,
  NodeExecutionFailure,
  ExecutorConfig,
  ExecutorLogger,
  TaskRunResult,
} from "./types.js";
