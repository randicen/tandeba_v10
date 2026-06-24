/**
 * Worgena — Specialist (D2b.1 + D2b.2).
 *
 * Fuente de verdad:
 * - D2b.1: `AGENT_D2B_1_SPEC.md` §3.7, §5.2.
 * - D2b.2: `AGENT_D2B_2_SPEC.md` §3.5, §3.6, §5.6.
 *
 * Un `Specialist` es un sub-agente de Capa 3 (roadmap §5.3) que ejecuta
 * un nodo LLM con un system prompt especializado, tools acotadas, y
 * contexto limpio.
 *
 * **D2b.2 — cambios** (suma, no reemplaza):
 * - `agentCard: AgentCard` (A2A v1.0). Forward-compat con el A2A server
 *   de D3+.
 * - `lifecycle: Lifecycle` (state machine 6 estados). Para audit y
 *   observabilidad.
 * - `agentVersion` ahora es semver limpio ("1.0.0"), no "1.0.0-d2b.1".
 *   El constructor lo inicializa; el caller no lo pasa.
 *
 * **El método `execute()` no cambió**: backward-compat con D2b.1. Los
 * 16 tests D2b.1 siguen pasando sin cambios (los specialists extienden
 * la interface y agregan los nuevos campos).
 *
 * **Por qué `lifecycle` es required (no opcional)**: el lifecycle es
 * metadata del specialist. Si fuera opcional, los callers olvidarían
 * inicializarlo. Forzando required + inicialización en constructor,
 * garantizamos que TODOS los specialists tienen un lifecycle.
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
import type { AgentCard } from "./agent-card.js";
import type { Lifecycle } from "./lifecycle.js";
import type { SkillRegistry } from "../skills/index.js";

// ============================================================
// Specialist interface
// ============================================================

/**
 * Sub-agente de Capa 3 que ejecuta un nodo LLM con un prompt especializado.
 *
 * Cada specialist tiene:
 * - `agentId`: ID estable (ej: "intake_specialist_v1").
 * - `agentVersion`: semver del agent. D2b.2 = "1.0.0" (sin sufijo de sprint).
 * - `agentCard`: metadata A2A v1.0 (capacidades, skills, pricing, limits).
 * - `capabilities`: lista corta de skills que el specialist sabe usar
 *   (placeholder en D2b.1; en D2b.2 se llena desde el `agentCard.skills`).
 * - `preferredModel`: tier o nombre específico que el specialist prefiere.
 *   El `SpecialistRegistry` usa esto + el `TierResolver` para resolver
 *   el invocador concreto al construir el specialist.
 * - `lifecycle`: state machine de 6 estados (spawn → idle → busy →
 *   paused → done → archived). Para audit y observabilidad.
 *
 * El método `execute()` recibe el nodo + state + task + signal, y
 * retorna un `NodeExecutionOutcome` que el motor persiste en el state.
 */
export interface Specialist {
  readonly agentId: string;
  /** Semver del agent. D2b.2: "1.0.0" (sin sufijo de sprint). */
  readonly agentVersion: string;
  /** Agent Card A2A v1.0. Forward-compat con A2A server de D3+. */
  readonly agentCard: AgentCard;
  readonly capabilities: readonly string[];
  /** Modelo que el specialist prefiere. Se resuelve via TierResolver. */
  readonly preferredModel: ModelRef;
  /**
   * State machine del lifecycle del specialist. Cada specialist tiene
   * su propio lifecycle (1 instancia por specialist, no global).
   */
  readonly lifecycle: Lifecycle;

  /**
   * Catálogo de skills v1 disponible para este specialist.
   *
   * **D2c — opcional, backward-compat**: si está presente, el specialist
   * descubre las skills relevantes en cada `execute()` y las inyecta
   * en el system prompt. Si está ausente, el specialist opera sin
   * skills (modo actual de D2b.1/D2b.2).
   *
   * El motor no sabe de skills. Solo el specialist.
   */
  readonly skills?: SkillRegistry;

  /**
   * Ejecuta un nodo LLM como specialist. Retorna el outcome completo
   * (output, confidence, tokens, cost, prompt snapshot). El motor NO
   * valida nada extra — el specialist es opaco para el motor.
   *
   * El specialist hace TODA la lógica del nodo:
   * 1. Construir system + user prompts especializados.
   * 2. Transicionar el lifecycle a `busy` (y a `done` o `archived` al final).
   * 3. Llamar al invocador (mock en D2b.1, OpenRouter en D2b.2).
   * 4. Validar output contra `node.outputSchema` (si está declarado).
   * 5. Calcular confidence gating (si `node.confidenceGating` está).
   * 6. Retornar `NodeExecutionOutcome` con `metadata.executedBy`
   *    poblado en `NodeResult` (lo setea el motor, no el specialist).
   *
   * El specialist retorna el outcome sin metadata.executedBy — el
   * motor lo agrega en `makeSuccessResult` cuando persiste el resultado.
   * El specialist solo conoce su `agentId`, `agentVersion`, y `agentCard`
   * (para que el motor los lea después).
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
 * Versión del agent del specialist. En D2b.2 los specialists con
 * Agent Card formal tienen semver limpio "1.0.0" (sin sufijo de sprint).
 *
 * **D2b.1 backward-compat**: el constante sigue exportado por si algún
 * caller D2b.1 lo usa. Los 3 specialists D2b.2 NO lo usan — su
 * `agentVersion` se lee del `agentCard.version` (fuente única de verdad).
 *
 * **Por qué deprecated**: tener dos fuentes para la versión (este
 * constante + el `agentCard.version`) es un footgun. D3+ elimina
 * el constante.
 *
 * @deprecated Usar `specialist.agentCard.version` en su lugar.
 */
export const SPECIALIST_AGENT_VERSION = "1.0.0-d2b.1" as const;
