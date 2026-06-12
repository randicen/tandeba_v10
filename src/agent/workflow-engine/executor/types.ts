/**
 * Worgena Workflow Engine — Executor (D2a.2 + D2a.2.2 + D2a.2.3 + D2a.4).
 *
 * Tipos del runtime. El executor usa los tipos del DSL (src/agent/workflow-engine/dsl)
 * para las definiciones inmutables de workflow y los tipos de Task/NodeResult, y
 * agrega tipos específicos de runtime (invokers, handlers, execution context).
 *
 * El executor NO contiene lógica de dominio: solo sabe cómo recorrer un grafo,
 * ejecutar un nodo, escribir al state y manejar errores. La lógica específica
 * (qué hace un LLM, qué hace un HITL) se inyecta via interfaces (LLMInvoker,
 * HITLHandler, FunctionRegistry).
 *
 * D2a.4: la interfaz `HITLHandler` cambió de `request()` (bloqueante) a
 * `initiate()` (no-bloqueante) para soportar HITL primitives reales con
 * pause/resume. Ver `AGENT_D2A_4_HITL_PRIMITIVES_SPEC.md`.
 *
 * Esto es la diferencia entre "motor de demo" y "motor de producción":
 *   - El motor es puro código determinista.
 *   - Las decisiones de runtime (qué modelo, qué tool, qué humano) se inyectan.
 *   - Cada componente es testeable en aislamiento con mocks.
 */

// ============================================================
// Runtime interfaces (inyectables)
// ============================================================

import type { CircuitBreaker } from "./circuit-breaker.js";
import type { MigratorRegistry } from "../migrations.js";

// D2b.1: tipos del multi-model router. Importamos SOLO tipos para evitar
// ciclos de import en runtime (los specialists importan del motor, y el
// motor importa solo tipos de specialists, que TypeScript borra en
// compilación). Importar desde el barrel `../../specialists/index.js`
// sería tentador pero causaría un ciclo (el barrel carga los specialists
// concretos, que a su vez importan del motor).
import type { TierResolver } from "../../specialists/tier-resolver.js";
import type { SpecialistRegistry } from "../../specialists/specialist-registry.js";

// ============================================================
// Re-exports (para que el barrel index.ts siga funcionando)
// ============================================================

export type { CircuitBreaker, NoopCircuitBreaker } from "./circuit-breaker.js";


/**
 * Interface para invocar un LLM. El motor la llama; la implementación puede
 * ser real (D2b) o un mock (tests). El motor no sabe qué proveedor es.
 */
export interface LLMInvoker {
  invoke(params: LLMInvokeParams): Promise<LLMInvokeResult>;
}

export interface LLMInvokeParams {
  readonly model: string;
  readonly systemPrompt?: string;
  readonly userPrompt?: string;
  readonly tools?: readonly string[];
  /** JSON Schema para validar el output del LLM. Si está presente, el invoker DEBE garantizar cumplimiento. */
  readonly outputSchema?: Record<string, unknown>;
  /**
   * Signal de cancelación. Cuando se aborta, el invoker debería interrumpir
   * la llamada en curso (cuando sea posible). Si el invoker no soporta
   * cancelación, puede ignorarlo — el motor tiene un timeout aparte (v2).
   */
  readonly signal?: AbortSignal;
}

export interface LLMInvokeResult {
  /** Output parseado. Si el LLM devolvió JSON inválido, el invoker debe tirar error. */
  readonly output: unknown;
  readonly tokensUsed: { readonly input: number; readonly output: number };
  readonly modelUsed: string;
  /** Costo en USD. */
  readonly costUsd?: number;
}

/**
 * Interface para manejar un HITL. El motor la llama cuando llega a un nodo HITL.
 *
 * D2a.4: la interfaz cambió de `request()` (bloqueante) a `initiate()`
 * (no-bloqueante). El handler ahora es solo **notificador** — envía la
 * pregunta al canal correspondiente (email, webhook, push, UI) y retorna
 * inmediatamente con un `requestId`. La respuesta humana llega después
 * via `executor.resumeTask(taskId, response)`.
 *
 * Razón del cambio: el `await` bloqueante congelaba el motor entero
 * cuando un humano debía responder (HITL puede esperar horas). El motor
 * debe poder manejar N tasks en paralelo.
 *
 * Para tests con respuestas pre-cargadas o para handlers interactivos
 * que ya tienen la respuesta al momento de iniciar, `initiate()` puede
 * retornar `immediateResponse` y el motor la procesa inline sin pausar.
 *
 * Ver `AGENT_D2A_4_HITL_PRIMITIVES_SPEC.md` §4.2.
 */
export interface HITLHandler {
  /**
   * Inicia la solicitud HITL. El handler notifica al canal correspondiente
   * (email, webhook, push, etc.) y retorna inmediatamente con un requestId.
   *
   * El motor NO espera la respuesta acá. La respuesta llega via
   * `executor.resumeTask(taskId, response)` cuando el handler externo
   * (o un listener, o un cron) la obtiene.
   *
   * Si la implementación ya tiene la respuesta (ej: test, o handler
   * interactivo que preguntó y recibió sincrónicamente), puede retornarla
   * via `immediateResponse` y el motor la procesa sin pausar.
   */
  initiate(params: HITLInitiateParams): Promise<HITLInitiateResult>;
}

export interface HITLInitiateParams {
  readonly taskId: string;
  readonly nodeId: string;
  readonly approvers: readonly string[];
  /** Pregunta resuelta del state (template interpolado). */
  readonly question: unknown;
  /** Contexto adicional resuelto. */
  readonly context?: unknown;
  /** Output schema del HITL (valida la respuesta humana si está presente). */
  readonly outputSchema?: Record<string, unknown>;
  /**
   * Timeout del nodo en ms. Es responsabilidad del handler externo
   * respetar este timeout y llamar `cancelTask` o `resumeTask({type:'timeout'})`
   * cuando expire. D2a no tiene sweeper automático; D3 sí.
   */
  readonly timeoutMs?: number;
}

export interface HITLInitiateResult {
  /**
   * Identificador del request. Lo emite el handler (no el motor); se persiste
   * en `Task.pendingDecision.requestId` para vincular la notificación externa
   * con la task. Si el handler no tiene noción de ID, genera un UUID.
   */
  readonly requestId: string;
  /**
   * Opcional. Si está presente, el motor la procesa inmediatamente sin
   * pausar la task. Útil para tests con respuestas pre-cargadas y para
   * handlers interactivos. Si está ausente, el motor entra en `paused_hitl`
   * y espera un `resumeTask` posterior.
   */
  readonly immediateResponse?: HITLResponse;
}

export type HITLResponse =
  | { readonly type: "approved"; readonly output: unknown }
  | { readonly type: "declined"; readonly reason: string }
  | { readonly type: "timeout" };

/**
 * Function signature: lo que se registra en el FunctionRegistry.
 * Recibe el input (ya resuelto del state) y devuelve el output.
 */
export type WorkflowFunction = (input: unknown) => Promise<unknown> | unknown;

// ============================================================
// Execution context (read-only durante un nodo)
// ============================================================

/**
 * Estado mutable de la task. Se pasa al nodo como `state`. El nodo lee
 * (via StateRef) y escribe (via output.to). El motor valida que el state
 * final cumpla con el stateSchema del workflow (D2a.2.2).
 */
export type WorkflowState = Record<string, unknown>;

/**
 * Resultado de ejecutar un nodo. Es lo que el node-runner devuelve al loop
 * principal; el loop lo usa para escribir al state y decidir el siguiente nodo.
 *
 * D2a.2.3: eliminado `NodeExecutionPaused`. El `node-runner.ts::runHITLNode`
 * siempre resolvía con `success` o `failure` (códigos específicos como
 * `HITL_DECLINED` o `HITL_TIMEOUT`).
 *
 * D2a.4: el `node-runner` ya NO maneja nodos HITL directamente. El caso
 * `hitl` se intercepta en el `executor.runLoop` y se delega a
 * `executor.pauseForHITL()`. La pausa es real (`status='paused_hitl'`,
 * `task.pendingDecision` persistido), no un `await` bloqueante.
 */
export type NodeExecutionOutcome =
  | NodeExecutionSuccess
  | NodeExecutionFailure;

export interface NodeExecutionSuccess {
  readonly status: "completed";
  /** Output del nodo. Se va a escribir al state según `output.to`. */
  readonly output: unknown;
  /** Para LLM nodes. */
  readonly confidence?: "HIGH" | "MEDIUM" | "LOW";
  readonly confidenceValue?: number;
  readonly tokensUsed?: { readonly input: number; readonly output: number };
  readonly costUsd?: number;
  readonly modelUsed?: string;
  /** Cantidad de retries que se ejecutaron antes del éxito. 0 si primera ejecución. */
  readonly retryCount: number;
  /**
   * Snapshot del prompt enviado al LLM (system + user + tools, interpolados).
   * Solo para nodos LLM. Es el activo de audit ("¿qué le dijimos al modelo?").
   * Si el template referenciaba un path inexistente, el interpolador retorna
   * string vacío (ver `interpolate` en `state.ts`).
   */
  readonly promptSnapshot?: {
    readonly system?: string;
    readonly user?: string;
    readonly tools?: readonly string[];
  };
}

export interface NodeExecutionFailure {
  readonly status: "failed";
  readonly code: import("../dsl/types.js").ErrorCode;
  readonly message: string;
  readonly retriable: boolean;
  /** Si el nodo tiene retries y el error es retriable, esto es cuánto avanzamos. */
  readonly retryCount: number;
  /** Stack del error original (para debugging). */
  readonly stack?: string;
}

// ============================================================
// Executor config
// ============================================================

export interface ExecutorConfig {
  readonly functionRegistry: Map<string, WorkflowFunction>;
  readonly llmInvoker: LLMInvoker;
  readonly hitlHandler: HITLHandler;
  /**
   * Generador de IDs para tasks. Por default usa crypto.randomUUID().
   * Inyectable para tests deterministas.
   */
  readonly taskIdGenerator?: () => string;
  /**
   * Logger hook. Por ahora solo emite console.log en debug.
   * Si es `undefined`, el executor corre silencioso.
   */
  readonly logger?: ExecutorLogger;
  /**
   * Circuit breaker para specialists (D2a.2.3). Default: `NoopCircuitBreaker`
   * (nunca abre). En D2b se inyecta la implementación real con policy
   * configurable (umbral de fallos, cool-down, etc.).
   *
   * El motor consulta `breaker.isOpen(specialistId)` antes de CADA attempt
   * de un nodo LLM, no solo el primero. Si el breaker abre durante los
   * retries, el siguiente attempt lo ve y falla rápido con `MODEL_UNAVAILABLE`.
   */
  readonly circuitBreaker?: CircuitBreaker;
  /**
   * Registry de migradores de schema (D2a.2.3). Default: Map vacío.
   * Si un workflow tiene `schemaVersion` menor a `schemaVersion` del motor
   * y no hay migrador en este registry, falla al ejecutar con
   * `SCHEMA_VERSION_UNSUPPORTED`.
   *
   * NO es un global mutable: cada Executor tiene su propio registry.
   * Esto permite que tests registren migradores sin contaminar otros tests.
   */
  readonly migrators?: MigratorRegistry;
  /**
   * Versión del spec del DSL que este motor ejecuta (D2a.2.3). Default: 1.
   * Inyectable para tests que simulan motores viejos. Si un workflow tiene
   * un `schemaVersion` mayor, falla con `SCHEMA_VERSION_UNSUPPORTED`.
   */
  readonly schemaVersion?: number;
  /**
   * D2b.1: TierResolver (multi-model router). Mapea `ModelRef` (tier o
   * nombre) a un `LLMInvoker` concreto. Si está presente y un nodo LLM
   * NO tiene `assignedSpecialist`, el node-runner usa el invocador que
   * el resolver retorna para el `node.model` del nodo. Si está ausente,
   * el node-runner usa el `llmInvoker` default (D2a.4 behavior).
   *
   * Backward-compat: opcional. Si no se provee, ningún cambio.
   */
  readonly tierResolver?: TierResolver;
  /**
   * D2b.1: registry de specialists. Si un nodo LLM tiene
   * `assignedSpecialist: string`, el node-runner busca ese agentId
   * en este registry y delega la ejecución al specialist. Si el
   * nodo NO tiene `assignedSpecialist` o el agentId no existe, el
   * comportamiento depende de `tierResolver` (ver arriba).
   *
   * Validación: la existencia del `assignedSpecialist` se chequea
   * en `startTask` (falla con `NODE_NOT_FOUND` si no existe). Ver
   * `AGENT_D2B_1_SPEC.md` §3.11.
   *
   * Backward-compat: opcional. Si no se provee, ningún cambio (los
   * nodos con `assignedSpecialist` se ignoran? NO — falla en
   * startTask porque no hay dónde rutear. La validación es eager).
   */
  readonly specialistRegistry?: SpecialistRegistry;
}

export interface ExecutorLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

// ============================================================
// Task execution result (lo que devuelve el run principal)
// ============================================================

export interface TaskRunResult {
  readonly taskId: string;
  readonly status: import("../dsl/types.js").TaskStatus;
  readonly nodeResults: Readonly<Record<string, import("../dsl/types.js").NodeResult>>;
  readonly state: WorkflowState;
  readonly error?: import("../dsl/types.js").TaskError;
}
