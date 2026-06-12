/**
 * Worgena — IntakeSpecialist (D2b.1).
 *
 * Fuente de verdad: `AGENT_D2B_1_SPEC.md` §2.1 goal 3, §5.3.
 *
 * Specialist de tier liviano. Clasifica un documento legal en una
 * categoría y devuelve un nivel de confianza.
 *
 * System prompt (D2b.1): genérico, sin principios jurídicos específicos.
 * Los principios reales (ley posterior, ley especial, etc.) entran en
 * D2b.2 con skills v1 de D2c. Ver spec §3.16.
 *
 * Salida: `{ category: string, confidence: number (0-1) }`. El nodo debe
 * declarar un `outputSchema` que valide esta forma; el specialist lo
 * pasa al invocador y confía en que el mock/real LLM lo retorna válido.
 *
 * Backward-compat: el system prompt del nodo original (en el fixture
 * `revision-generica.workflow.json`) se REEMPLAZA por el system prompt
 * del specialist. Esto es opt-in: si el nodo NO tiene `assignedSpecialist`,
 * el system prompt del nodo se usa tal cual (D2a.4 behavior).
 *
 * **Confidence gating**: el specialist evalúa el confidence del output
 * contra `node.confidenceGating` (si está declarado). El motor no duplica
 * la lógica. Ver spec §3.15.
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
import { SPECIALIST_AGENT_VERSION, type Specialist, type SpecialistExecuteParams } from "./specialist.js";
import type { ModelRef } from "./tier-resolver.js";

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
  public readonly capabilities: readonly string[] = [
    "document_classification",
    "categorization",
  ];
  public readonly preferredModel: ModelRef = "liviano";

  /** Versión del agent. En D2b.2 esto vive en la Agent Card formal. */
  public readonly agentVersion = SPECIALIST_AGENT_VERSION;

  constructor(private readonly invoker: LLMInvoker) {}

  async execute(params: SpecialistExecuteParams): Promise<NodeExecutionOutcome> {
    const { node, state, signal } = params;

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
      //    define las reglas de confidence. Ver §3.15.
      const gating = this.evaluateConfidence(node, result.output);

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
      const err = toNodeRuntimeError(e);
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
