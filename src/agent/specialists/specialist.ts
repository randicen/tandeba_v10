/**
 * Worgena — Specialist (D2b.1).
 *
 * Fuente de verdad: `AGENT_D2B_1_SPEC.md` §3.7, §5.2.
 *
 * Un `Specialist` es un sub-agente de Capa 3 (roadmap §5.3) que ejecuta
 * un nodo LLM con un system prompt especializado, tools acotadas, y
 * contexto limpio. En D2b.1 los specialists son MOCKS (no usan LLM real);
 * en D2b.2 se enchufa OpenRouter real.
 *
 * Interfaz mínima:
 * - `agentId`: string estable que identifica al specialist en logs/métricas.
 *   Ej: "intake_specialist_v1".
 * - `capabilities`: lista de skills/tools que el specialist sabe usar.
 *   En D2b.1 son placeholders (los specialists no invocan tools aún).
 *   En D2b.2 + D2c (skills v1) esto se llena con los skills reales.
 * - `preferredModel`: tier o nombre específico que el specialist prefiere.
 *   El `SpecialistRegistry` usa esto + el `TierResolver` para resolver
 *   el invocador concreto al construir el specialist.
 * - `execute(params)`: corre el nodo. Retorna un `NodeExecutionOutcome`
 *   completo (output, confidence, tokens, cost, prompt snapshot). El
 *   motor NO valida nada extra — el specialist es opaco.
 *
 * Por qué el specialist retorna `NodeExecutionOutcome` (en lugar de
 * delegar al motor y dejar que el motor valide): el specialist tiene
 * el system prompt y el output completo, así que puede hacer TODO
 * (system + user prompt + output validation + confidence gating)
 * adentro. El motor no duplica esa lógica. Ver spec §3.4.
 *
 * Backward-compat: el motor (D2a) no sabe que existen los specialists.
 * El `node-runner` enruta al specialist si el nodo tiene
 * `assignedSpecialist` Y el registry lo tiene. Si no, usa el
 * `llmInvoker` default (D2a.4 behavior).
 */

import type {
  LLMNode,
  Task,
} from "../workflow-engine/dsl/types.js";
import type {
  NodeExecutionOutcome,
  WorkflowState,
} from "../workflow-engine/executor/types.js";
import type { ModelRef } from "./tier-resolver.js";

// ============================================================
// Specialist interface
// ============================================================

/**
 * Sub-agente de Capa 3 que ejecuta un nodo LLM con un prompt especializado.
 *
 * Cada specialist tiene un `agentId` estable, una lista de `capabilities`
 * (placeholder en D2b.1), y un `preferredModel` (tier que el registry
 * resuelve a un invocador concreto).
 *
 * El método `execute()` recibe el nodo + state + task + signal, y
 * retorna un `NodeExecutionOutcome` que el motor persiste en el state.
 */
export interface Specialist {
  readonly agentId: string;
  readonly capabilities: readonly string[];
  /** Modelo que el specialist prefiere. Se resuelve via TierResolver. */
  readonly preferredModel: ModelRef;
  /**
   * Versión semver del agent. En D2b.1 todos son mocks con
   * `SPECIALIST_AGENT_VERSION` ("1.0.0-d2b.1"). En D2b.2 cada
   * specialist con Agent Card formal tiene su propia versión.
   */
  readonly agentVersion: string;

  /**
   * Ejecuta un nodo LLM como specialist. Retorna el outcome completo
   * (output, confidence, tokens, cost, prompt snapshot). El motor NO
   * valida nada extra — el specialist es opaco para el motor.
   *
   * El specialist hace TODA la lógica del nodo:
   * 1. Construir system + user prompts especializados.
   * 2. Llamar al invocador (mock en D2b.1, OpenRouter en D2b.2).
   * 3. Validar output contra `node.outputSchema` (si está declarado).
   * 4. Calcular confidence gating (si `node.confidenceGating` está).
   * 5. Retornar `NodeExecutionOutcome` con `metadata.executedBy`
   *    poblado en `NodeResult` (lo setea el motor, no el specialist).
   *
   * El specialist retorna el outcome sin metadata.executedBy — el
   * motor lo agrega en `makeSuccessResult` cuando persiste el resultado.
   * El specialist solo conoce su `agentId` y `agentVersion` (para que
   * el motor los lea después).
   */
  execute(params: SpecialistExecuteParams): Promise<NodeExecutionOutcome>;
}

/**
 * Parámetros que el motor pasa al specialist al ejecutar un nodo.
 *
 * El specialist NO tiene acceso al `LLMInvoker` directamente — ese
 * detalle lo maneja el registry al construir el specialist. El motor
 * le pasa lo que necesita: el nodo, la task, el state, y un signal
 * para cancelación cooperativa.
 */
export interface SpecialistExecuteParams {
  readonly node: LLMNode;
  readonly task: Task;
  readonly state: WorkflowState;
  readonly signal?: AbortSignal;
}

/**
 * Versión del agent del specialist. Hoy es siempre "1.0.0-d2b.1" porque
 * los specialists son mocks. En D2b.2 cada specialist con Agent Card
 * formal tendrá su versión semver (ej: "1.0.0", "1.1.0" cuando evolucione).
 *
 * Esta constante se exporta para que el motor la use al poblar
 * `NodeResult.metadata.executedBy.agentVersion`.
 */
export const SPECIALIST_AGENT_VERSION = "1.0.0-d2b.1" as const;
