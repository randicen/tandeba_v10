/**
 * Worgena — IntakeSpecialist (D2b.1 + D2b.2).
 *
 * Fuente de verdad:
 * - D2b.1: `AGENT_D2B_1_SPEC.md` §2.1 goal 3, §5.3.
 * - D2b.2: `AGENT_D2B_2_SPEC.md` §5.6 (suma agentCard + lifecycle).
 *
 * Specialist de tier liviano. Clasifica un documento legal en una
 * categoría y devuelve un nivel de confianza.
 *
 * **D2b.2 cambios**:
 * - `agentCard = INTAKE_AGENT_CARD` (constante, fuente única de verdad).
 * - `lifecycle = new Lifecycle()` (inicializado en constructor).
 * - `agentVersion` ahora se lee del `agentCard.version` (semver "1.0.0").
 * - `execute()` transiciona el lifecycle: spawn→idle (en constructor) →
 *   busy (al empezar) → done (al terminar) o archived (al fallar).
 *
 * **Sin cambios al contrato `execute()`**: backward-compat con D2b.1.
 * Los 16 tests D2b.1 siguen pasando sin tocar.
 *
 * System prompt (D2b.2): sigue siendo genérico, sin principios jurídicos
 * colombianos específicos. Los principios reales (ley posterior, ley
 * especial, etc.) entran en D2c (skills v1). Ver `AGENT_ROADMAP.md` §5.14.
 *
 * Salida: `{ category: string, confidence: number (0-1) }`. El nodo debe
 * declarar un `outputSchema` que valide esta forma; el specialist lo
 * pasa al invocador y confía en que el mock/real LLM lo retorna válido.
 *
 * **Confidence gating**: el specialist evalúa el confidence del output
 * contra `node.confidenceGating` (si está declarado). El motor no duplica
 * la lógica. Ver roadmap §5.12.
 */

import type {
  LLMNode,
} from "../workflow-engine/dsl/types.js";
import type {
  LLMInvoker,
  LLMInvokeParams,
  NodeExecutionOutcome,
  NodeExecutionSuccess,
} from "../workflow-engine/executor/types.js";
import { toNodeRuntimeError } from "../workflow-engine/executor/errors.js";
import { resolveStateRef } from "../workflow-engine/executor/state.js";
import type { Specialist, SpecialistExecuteParams } from "./specialist.js";
import type { ModelRef } from "./tier-resolver.js";
import { Lifecycle } from "./lifecycle.js";
import { INTAKE_AGENT_CARD } from "./agent-cards/index.js";

// ============================================================
// IntakeSpecialist
// ============================================================

/**
 * Specialist de intake. Clasifica un documento legal.
 *
 * System prompt:
 * "Sos un clasificador de documentos legales. Recibís el contenido de un
 *  documento y devolvés su categoría (contrato / demanda / sentencia /
 *  opinión / otro) y tu nivel de confianza entre 0 y 1 (0 = sin idea,
 *  1 = absolutamente seguro)."
 *
 * User prompt: el contenido del documento (`state.input.documentContent`).
 *
 * Salida: `{ category, confidence }`.
 */
export class IntakeSpecialist implements Specialist {
  public readonly agentId = "intake_specialist_v1";
  /** Semver desde el agentCard. D2b.2: "1.0.0". */
  public readonly agentVersion: string = INTAKE_AGENT_CARD.version;
  /** Agent Card A2A v1.0. Fuente única de verdad para metadata. */
  public readonly agentCard = INTAKE_AGENT_CARD;
  public readonly capabilities: readonly string[] = INTAKE_AGENT_CARD.skills.map((s) => s.id);
  public readonly preferredModel: ModelRef = "liviano";
  /** Lifecycle del specialist. Inicializado en constructor. */
  public readonly lifecycle: Lifecycle;

  constructor(private readonly invoker: LLMInvoker) {
    this.lifecycle = new Lifecycle();
    // Primera transición: spawn → idle. El specialist ya está registrado
    // y listo para ejecutar. Esta transición es un evento de audit que
    // queda en `lifecycle.events` desde el primer instante.
    this.lifecycle.transition("idle", "registered");
  }

  async execute(params: SpecialistExecuteParams): Promise<NodeExecutionOutcome> {
    const { node, state, signal } = params;

    // Transición de lifecycle: idle → busy. Si por algún motivo el
    // lifecycle ya está en `archived` (terminal), esto tira — pero
    // eso sería un bug, no un caso normal. Dejamos que tire.
    this.lifecycle.transition("busy", `node ${node.id} starting`);

    // 1. Construir system prompt.
    const systemPrompt = this.buildSystemPrompt();

    // 2. Construir user prompt. El input del nodo puede ser un path o
    //    template. Usamos resolveStateRef del motor para mantener consistencia
    //    con D2a.4.
    const userInput = resolveStateRef(state, node.input.from, node.input.default);
    const userPrompt = this.buildUserPrompt(userInput);

    // 3. Construir params para el invocador.
    const invokeParams: LLMInvokeParams = {
      model: this.preferredModel,
      systemPrompt,
      userPrompt,
      tools: node.tools ? [...node.tools] : undefined,
      outputSchema: node.outputSchema,
      signal,
    };

    // 4. Invocar.
    try {
      const result = await this.invoker.invoke(invokeParams);

      // 5. NO validamos la shape del output. El invocador (mocks en D2b.1,
      //    OpenRouter real en D2b.2) garantiza cumplimiento, y la validación
      //    contra `node.outputSchema` la hace el motor después (state
      //    validation). Ver `AGENT_D2B_1_SPEC.md` §3.12.
      //
      // 6. Confidence gating. El specialist tiene el system prompt que
      //    define las reglas de confidence. Ver roadmap §5.12.
      const gating = this.evaluateConfidence(node, result.output);

      // Transición: busy → done.
      this.lifecycle.transition("done", `node ${node.id} completed`);

      // 7. Retornar outcome completo.
      return {
        status: "completed",
        output: result.output,
        confidence: gating.confidence,
        confidenceValue: gating.confidenceValue,
        tokensUsed: result.tokensUsed,
        costUsd: result.costUsd,
        modelUsed: result.modelUsed,
        retryCount: 0,
        promptSnapshot: { system: systemPrompt, user: userPrompt, tools: node.tools ? [...node.tools] : undefined },
      } satisfies NodeExecutionSuccess;
    } catch (e) {
      // Transición: busy → archived (en caso de error).
      const err = toNodeRuntimeError(e);
      this.lifecycle.transition("archived", `error: ${err.message}`);
      return {
        status: "failed",
        code: err.code,
        message: err.message,
        retriable: false,
        retryCount: 0,
        stack: err.stack,
      };
    }
  }

  // ─── Helpers ────────────────────────────────────────────

  protected buildSystemPrompt(): string {
    return (
      "Sos un clasificador de documentos legales. Recibís el contenido de un " +
      "documento y devolvés su categoría (contrato / demanda / sentencia / " +
      "opinión / otro) y tu nivel de confianza entre 0 y 1 (0 = sin idea, " +
      "1 = absolutamente seguro)."
    );
  }

  protected buildUserPrompt(input: unknown): string {
    if (typeof input === "string") return input;
    if (input == null) return "";
    return JSON.stringify(input);
  }

  private evaluateConfidence(
    node: LLMNode,
    output: unknown,
  ): { confidence?: "HIGH" | "MEDIUM" | "LOW"; confidenceValue?: number } {
    if (!node.confidenceGating) return {};
    if (output == null || typeof output !== "object") return {};
    const conf = (output as Record<string, unknown>).confidence;
    if (typeof conf !== "number") return {};
    const { highThreshold, mediumThreshold } = node.confidenceGating;
    if (conf >= highThreshold) return { confidence: "HIGH", confidenceValue: conf };
    if (conf >= mediumThreshold) return { confidence: "MEDIUM", confidenceValue: conf };
    return { confidence: "LOW", confidenceValue: conf };
  }
}
