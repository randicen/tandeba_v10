/**
 * Worgena Workflow Engine — Node Runner.
 *
 * Ejecuta un SOLO nodo. El WorkflowExecutor le pasa el nodo, el state, los
 * handlers (LLM, FunctionRegistry), y el runner devuelve el outcome
 * (success / failure).
 *
 * Tipos de nodo manejados en D2a.4:
 * - function: ejecuta una función del FunctionRegistry.
 * - llm: invoca un LLM (via LLMInvoker), valida output contra outputSchema.
 *
 * Tipos de nodo NO manejados (interceptados por el executor, en `runLoop`):
 * - router: no ejecuta código, solo evalúa la decisión para encontrar el
 *   siguiente nodo. El executor lo maneja en su loop principal.
 * - hitl: la pausa HITL se maneja en el executor vía `pauseForHITL()` y
 *   `resumeTask()`. Si el executor llama a `runNode` con un nodo `hitl`
 *   por bug, tira `INTERNAL_BUG` (defensa).
 *
 * Por qué separar node-runner del executor:
 * - Testeable en aislamiento (un nodo a la vez).
 * - El executor solo tiene la lógica del grafo, no la del nodo individual.
 * - En D2b podemos agregar specializaciones (parallel runner, etc.) sin tocar el executor.
 */

import type {
  FunctionNode,
  LLMNode,
  Node as WorkflowNode,
  PromptSnapshot,
  Task,
  WorkflowDefinition,
  ErrorCode,
} from "../dsl/types.js";
import { isRetriableByDefault, toNodeRuntimeError, ExecutorError } from "./errors.js";
import { resolveStateRef } from "./state.js";
import type { CircuitBreaker } from "./circuit-breaker.js";
import { NoopCircuitBreaker } from "./circuit-breaker.js";
import type {
  LLMInvoker,
  NodeExecutionOutcome,
  NodeExecutionSuccess,
  WorkflowFunction,
} from "./types.js";
import type { SpecialistRegistry } from "../../specialists/specialist-registry.js";
import type { TierResolver } from "../../specialists/tier-resolver.js";
import Ajv from "ajv";

// ============================================================
// Public API
// ============================================================

export interface RunNodeParams {
  readonly node: WorkflowNode;
  readonly workflow: WorkflowDefinition;
  readonly task: Task;
  readonly llmInvoker: LLMInvoker;
  /**
   * D2a.4: el campo `hitlHandler` ya no se usa acá (HITL se maneja en
   * el executor). Se mantiene en la interface como `unknown` solo para
   * compatibilidad con callers viejos. En D2a.5+ se elimina de la firma.
   */
  readonly hitlHandler?: unknown;
  readonly functionLookup: (name: string) => WorkflowFunction | undefined;
  readonly signal?: AbortSignal;
  readonly logger?: {
    debug(msg: string, meta?: Record<string, unknown>): void;
    info(msg: string, meta?: Record<string, unknown>): void;
  };
  /**
   * Circuit breaker a reportar (D2a.2.3). Default: `NoopCircuitBreaker`.
   * El motor YA consulta `isOpen` antes de cada attempt; este parámetro
   * es para que el node-runner reporte `recordSuccess` / `recordFailure`
   * después de la invocación.
   */
  readonly circuitBreaker?: CircuitBreaker;
  /**
   * ID del specialist para el circuit breaker. Solo se usa para nodos LLM.
   * Si está provisto y el nodo es LLM, se llama `recordSuccess` o
   * `recordFailure` con este ID después de la invocación.
   */
  readonly specialistId?: string;
  /**
   * D2b.1: registry de specialists. Si el nodo LLM tiene `assignedSpecialist`
   * y el agentId existe en el registry, el node-runner delega al specialist
   * en lugar de invocar al `llmInvoker` default. Si no, comportamiento D2a.4.
   */
  readonly specialistRegistry?: SpecialistRegistry;
  /**
   * D2b.1: TierResolver. Si está provisto y el nodo LLM NO tiene
   * `assignedSpecialist` (o el specialist no existe), se usa el invocador
   * que el resolver retorna para el `node.model` del nodo. Si está ausente,
   * se usa el `llmInvoker` default (D2a.4).
   */
  readonly tierResolver?: TierResolver;
}

/**
 * Ejecuta un nodo. Devuelve el outcome (success/failure).
 * NO maneja retries; el WorkflowExecutor lo llama en loop si el outcome es failure retriable.
 *
 * D2a.4: el `case "hitl"` se eliminó. HITL se maneja en el executor
 * (pause/resume real). Si el executor llama a `runNode` con un nodo
 * HITL por bug, tira `INTERNAL_BUG`. Ver `executor.pauseForHITL()`.
 *
 * Decisión: la validación contra outputSchema es responsabilidad del INVOKER
 * (LLMInvoker) para nodos LLM. El nodo-runner no re-valida (sería trabajo
 * doble). El invoker garantiza el contrato.
 */
export async function runNode(params: RunNodeParams): Promise<NodeExecutionOutcome> {
  const { node } = params;
  const startedAt = new Date().toISOString();

  switch (node.type) {
    case "function":
      return runFunctionNode(node, params, startedAt);
    case "llm":
      return runLLMNode(node, params, startedAt);
    case "hitl":
      // D2a.4: HITL ya no se ejecuta acá. El executor intercepta nodos
      // hitl en runLoop y llama pauseForHITL(). Si llegamos acá, el
      // executor cometió un bug.
      throw new ExecutorError(
        `runNode no debe ser llamado con un hitl node (id="${node.id}"); el executor maneja HITL vía pauseForHITL`,
        "INTERNAL_BUG",
        { nodeId: node.id },
      );
    case "router":
      throw new ExecutorError(
        `runNode no debe ser llamado con un router node (id="${node.id}"); el executor lo maneja aparte`,
        "INTERNAL_BUG",
        { nodeId: node.id },
      );
  }
}

// ============================================================
// Function node
// ============================================================

async function runFunctionNode(
  node: FunctionNode,
  params: RunNodeParams,
  startedAt: string,
): Promise<NodeExecutionOutcome> {
  const { task, functionLookup, logger } = params;
  const state = task.state as Record<string, unknown>;

  const input = resolveStateRef(state, node.input.from, node.input.default);
  const fn = functionLookup(node.functionRef);
  if (!fn) {
    return failure({
      code: "INTERNAL_ERROR",
      message: `Función "${node.functionRef}" no registrada.`,
      retriable: false,
      startedAt,
    });
  }

  logger?.debug(`function node ${node.id} starting`, {
    nodeId: node.id,
    functionRef: node.functionRef,
  });

  try {
    const output = await fn(input);
    return success({
      output,
      retryCount: 0,
      startedAt,
    });
  } catch (e) {
    const err = toNodeRuntimeError(e);
    logger?.debug(`function node ${node.id} failed`, {
      nodeId: node.id,
      error: err.message,
    });
    return failure({
      code: err.code,
      message: err.message,
      retriable: isRetriableByDefault(err.code) || err.retriable,
      stack: err.stack,
      startedAt,
    });
  }
}

// ============================================================
// LLM node
// ============================================================

async function runLLMNode(
  node: LLMNode,
  params: RunNodeParams,
  startedAt: string,
): Promise<NodeExecutionOutcome> {
  const { task, llmInvoker, logger, signal, circuitBreaker, specialistId, specialistRegistry, tierResolver } = params;
  const state = task.state as Record<string, unknown>;
  const breaker = circuitBreaker ?? new NoopCircuitBreaker();

  // D2b.1: routing al specialist. Si el nodo tiene `assignedSpecialist` y
  // existe en el registry, delegamos TODO al specialist (system + user
  // prompt + output validation + confidence gating). El specialist retorna
  // un `NodeExecutionOutcome` completo. Ver `AGENT_D2B_1_SPEC.md` §3.4, §3.15.
  if (node.assignedSpecialist && specialistRegistry) {
    const specialist = specialistRegistry.get(node.assignedSpecialist);
    if (specialist) {
      logger?.debug(`llm node ${node.id} delegating to specialist ${specialist.agentId}`, {
        nodeId: node.id,
        specialistId: specialist.agentId,
        // MIN-11 (audit D2 2026-06-12): el `agentVersion` siempre
        // está poblado desde D2b.2 (viene del `agentCard.version`,
        // fuente única de verdad). El fallback a `SPECIALIST_AGENT_VERSION`
        // era un vestigio de D2b.1 — eliminado.
        specialistVersion: specialist.agentVersion,
      });

      let outcome: NodeExecutionOutcome;
      try {
        outcome = await specialist.execute({ node, task, state, signal });
      } catch (e) {
        if (specialistId) breaker.recordFailure(specialistId);
        if ((e as { name?: string }).name === "AbortError") {
          return failure({
            code: "INTERNAL_ERROR",
            message: `Specialist call cancelled.`,
            retriable: false,
            startedAt,
          });
        }
        const err = toNodeRuntimeError(e, classifyLLMError(e));
        return failure({
          code: err.code,
          message: err.message,
          retriable: isRetriableByDefault(err.code),
          stack: err.stack,
          startedAt,
        });
      }

      // Reportar al circuit breaker.
      if (specialistId) {
        if (outcome.status === "completed") breaker.recordSuccess(specialistId);
        else breaker.recordFailure(specialistId);
      }

      // Si el specialist devolvió confidence LOW y onLow='fail', falla
      // el nodo. Mismo patrón que D2a.4.
      if (
        outcome.status === "completed" &&
        node.confidenceGating &&
        node.confidenceGating.onLow === "fail" &&
        outcome.confidence === "LOW"
      ) {
        return failure({
          code: "INVALID_OUTPUT",
          message: `LLM node "${node.id}" confidence LOW (${outcome.confidenceValue}) — onLow='fail' en el workflow.`,
          retriable: false,
          startedAt,
        });
      }

      return outcome;
    }
    // El agentId no existe en el registry. Esto NO debería pasar porque
    // `startTask` valida, pero por defensa: si llegamos acá con un
    // specialistId declarado y sin match, caemos al flujo D2a.4.
    // NO fallamos acá — el caller (startTask) ya falló si el agentId no
    // existía. Si llegamos acá sin registry o con agentId ausente, es
    // flujo normal.
  }

  const input = resolveStateRef(state, node.input.from, node.input.default);

  // Interpolamos prompts con el state. Si el prompt no tiene {{state.X}},
  // se queda literal. Si el path no existe, `interpolatePrompt` retorna
  // string vacío (ver helper abajo). Esto es lo que el LLM ve — el
  // `promptSnapshot` lo refleja exactamente.
  const systemPrompt = node.systemPrompt
    ? interpolatePrompt(node.systemPrompt, state)
    : undefined;
  const userPrompt = node.userPrompt
    ? interpolatePrompt(node.userPrompt, state)
    : undefined;

  // D2a.2.3: promptSnapshot para audit. Lo construimos ANTES de la
  // invocación para que refleje exactamente lo que el LLM va a ver
  // (incluso si la invocación falla — el audit muestra qué le habríamos
  // mandado, no qué llegó).
  const promptSnapshot: PromptSnapshot = {
    system: systemPrompt,
    user: userPrompt,
    tools: node.tools ? [...node.tools] : undefined,
  };

  // D2b.1: TierResolver. Si está provisto, lo usamos para resolver el
  // invocador concreto de `node.model`. Si no, usamos el `llmInvoker`
  // default (D2a.4 behavior).
  const resolved = tierResolver
    ? tierResolver.resolve(node.model)
    : { invoker: llmInvoker, tier: node.model, model: node.model };

  logger?.debug(`llm node ${node.id} invoking ${resolved.model}`, {
    nodeId: node.id,
    model: resolved.model,
    tier: resolved.tier,
    viaSpecialist: false,
  });

  try {
    const result = await resolved.invoker.invoke({
      model: resolved.model,
      systemPrompt,
      userPrompt,
      tools: node.tools,
      outputSchema: node.outputSchema,
      signal,
    });

    // Reportar éxito al circuit breaker.
    if (specialistId) {
      breaker.recordSuccess(specialistId);
    }

    // Confidence gating: si el output trae `confidence`, evaluamos.
    let confidence: "HIGH" | "MEDIUM" | "LOW" | undefined;
    let confidenceValue: number | undefined;
    if (
      node.confidenceGating &&
      typeof result.output === "object" &&
      result.output !== null
    ) {
      const conf = (result.output as Record<string, unknown>).confidence;
      if (typeof conf === "number") {
        confidenceValue = conf;
        if (conf >= node.confidenceGating.highThreshold) {
          confidence = "HIGH";
        } else if (conf >= node.confidenceGating.mediumThreshold) {
          confidence = "MEDIUM";
        } else {
          confidence = "LOW";
        }

        if (confidence === "LOW" && node.confidenceGating.onLow === "fail") {
          return failure({
            code: "INVALID_OUTPUT",
            message: `LLM node "${node.id}" confidence LOW (${conf}) — onLow='fail' en el workflow.`,
            retriable: false,
            startedAt,
          });
        }
      }
    }

    return success({
      output: result.output,
      confidence,
      confidenceValue,
      tokensUsed: result.tokensUsed,
      // MIN-4 (audit D2 2026-06-12): normalizamos a 0 cuando el invoker
      // no retorna `costUsd`. El motor y el audit downstream siempre
      // ven un número, nunca undefined.
      costUsd: result.costUsd ?? 0,
      modelUsed: result.modelUsed ?? resolved.model,
      retryCount: 0,
      startedAt,
      promptSnapshot,
    });
  } catch (e) {
    // Reportar fallo al circuit breaker.
    if (specialistId) {
      breaker.recordFailure(specialistId);
    }

    // Si el error viene de un AbortError, lo marcamos como cancellation
    // (no como fallo del workflow).
    if ((e as { name?: string }).name === "AbortError") {
      return failure({
        code: "INTERNAL_ERROR",
        message: `LLM call cancelled.`,
        retriable: false,
        startedAt,
      });
    }
    const err = toNodeRuntimeError(e, classifyLLMError(e));
    return failure({
      code: err.code,
      message: err.message,
      retriable: isRetriableByDefault(err.code),
      stack: err.stack,
      startedAt,
    });
  }
}

/**
 * Heurística simple para clasificar errores de LLM. En D2b conectamos el
 * catálogo de errores del proveedor (OpenAI SDK tira tipos específicos).
 */
function classifyLLMError(e: unknown): ErrorCode {
  if (!(e instanceof Error)) return "INTERNAL_ERROR";
  const msg = e.message.toLowerCase();
  if (msg.includes("rate limit") || msg.includes("429")) return "RATE_LIMIT";
  if (msg.includes("timeout") || msg.includes("timed out")) return "TIMEOUT";
  if (msg.includes("network") || msg.includes("econnrefused") || msg.includes("fetch failed")) {
    return "NETWORK_ERROR";
  }
  if (msg.includes("context") && msg.includes("length")) return "CONTEXT_TOO_LONG";
  if (msg.includes("invalid") && msg.includes("output")) return "INVALID_OUTPUT";
  if (msg.includes("model") && (msg.includes("not found") || msg.includes("unavailable"))) {
    return "MODEL_UNAVAILABLE";
  }
  return "INTERNAL_ERROR";
}

// ============================================================
// Helpers
// ============================================================

function interpolatePrompt(prompt: string, state: unknown): string {
  if (typeof prompt !== "string") return prompt;
  return prompt.replace(/\{\{state\.([^}]+)\}\}/g, (_, path: string) => {
    const value = getByPathSafe(state, path);
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  });
}

function getByPathSafe(obj: unknown, path: string): unknown {
  if (obj == null || typeof obj !== "object") return undefined;
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

interface SuccessInput {
  output: unknown;
  confidence?: "HIGH" | "MEDIUM" | "LOW";
  confidenceValue?: number;
  tokensUsed?: { input: number; output: number };
  costUsd?: number;
  modelUsed?: string;
  retryCount: number;
  startedAt: string;
  promptSnapshot?: PromptSnapshot;
}

function success(input: SuccessInput): NodeExecutionSuccess {
  return {
    status: "completed",
    output: input.output,
    confidence: input.confidence,
    confidenceValue: input.confidenceValue,
    tokensUsed: input.tokensUsed,
    costUsd: input.costUsd,
    modelUsed: input.modelUsed,
    retryCount: input.retryCount,
    promptSnapshot: input.promptSnapshot,
  };
}

interface FailureInput {
  code: ErrorCode;
  message: string;
  retriable: boolean;
  startedAt: string;
  stack?: string;
}

function failure(input: FailureInput): NodeExecutionOutcome {
  return {
    status: "failed",
    code: input.code,
    message: input.message,
    retriable: input.retriable,
    retryCount: 0,
    stack: input.stack,
  };
}

/**
 * Valida un valor contra un JSON Schema usando ajv. Compila el schema por
 * llamada (es lo que usa el motor para outputSchema; los schemas suelen ser
 * chicos). En D2b podemos cachear compilations por hash.
 *
 * Retorna { ok: true } o { ok: false, error: string }.
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
