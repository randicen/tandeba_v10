/**
 * Worgena — ClauseReviewerSpecialist (D2b.1).
 *
 * Fuente de verdad: `AGENT_D2B_1_SPEC.md` §2.1 goal 3, §5.3.
 *
 * Specialist de tier robusto. Revisa cláusulas en busca de abusividad.
 *
 * System prompt (D2b.1): menciona principios genéricos de revisión. Los
 * principios jurídicos colombianos específicos (ley 1429, estatuto
 * consumidor, etc.) entran en D2b.2 con skills v1 de D2c. Ver spec §3.16.
 *
 * Input: lista de cláusulas (array de objetos).
 * Salida: array de análisis por cláusula `{ clauseId, risk, reason }`.
 *
 * Backward-compat: el system prompt del nodo se REEMPLAZA. Si el nodo
 * NO tiene `assignedSpecialist`, el comportamiento es D2a.4.
 */

import type { LLMNode } from "../workflow-engine/dsl/types.js";
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
// ClauseReviewerSpecialist
// ============================================================

/**
 * Specialist de revisión de cláusulas. Tier robusto (m3-thinking mock).
 *
 * System prompt: "Sos un revisor de cláusulas contractuales. Recibís una
 *  lista de cláusulas y devolvés, para cada una, su nivel de riesgo
 *  (low / medium / high) y una razón breve. Si una cláusula parece
 *  abusiva bajo principios generales de derecho contractual, marcala
 *  como 'high'."
 *
 * User prompt: la lista de cláusulas (JSON o array).
 *
 * Salida: array de `{ clauseId, risk, reason }`.
 */
export class ClauseReviewerSpecialist implements Specialist {
  public readonly agentId = "clause_reviewer_specialist_v1";
  public readonly capabilities: readonly string[] = [
    "clause_review",
    "contract_analysis",
    "risk_classification",
  ];
  public readonly preferredModel: ModelRef = "robusto";
  public readonly agentVersion = SPECIALIST_AGENT_VERSION;

  constructor(private readonly invoker: LLMInvoker) {}

  async execute(params: SpecialistExecuteParams): Promise<NodeExecutionOutcome> {
    const { node, state, signal } = params;

    const systemPrompt = this.buildSystemPrompt();
    const userInput = resolveStateRef(state, node.input.from, node.input.default);
    const userPrompt = this.buildUserPrompt(userInput);

    const invokeParams: LLMInvokeParams = {
      model: this.preferredModel,
      systemPrompt,
      userPrompt,
      tools: node.tools ? [...node.tools] : undefined,
      outputSchema: node.outputSchema,
      signal,
    };

    try {
      const result = await this.invoker.invoke(invokeParams);

      this.validateOutputShape(result.output);

      // Confidence gating también aplica (no es específico de intake).
      const gating = this.evaluateConfidence(node, result.output);

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

  protected buildSystemPrompt(): string {
    return (
      "Sos un revisor de cláusulas contractuales. Recibís una lista de cláusulas " +
      "(cada una con un id numérico y un texto) y devolvés, para cada una, su " +
      "nivel de riesgo ('low' / 'medium' / 'high') y una razón breve (una o dos " +
      "frases) explicando por qué. Si una cláusula parece abusiva bajo principios " +
      "generales de derecho contractual (desequilibrio manifiesto, renuncia a " +
      "derechos, cláusulas penales excesivas, etc.), marcala como 'high'. Si la " +
      "cláusula es estándar, marcala como 'low'. Para zonas grises, 'medium'."
    );
  }

  protected buildUserPrompt(input: unknown): string {
    if (typeof input === "string") return input;
    if (Array.isArray(input)) return JSON.stringify(input, null, 2);
    if (input == null) return "";
    return JSON.stringify(input);
  }

  private validateOutputShape(output: unknown): void {
    if (!Array.isArray(output)) {
      throw new Error(`ClauseReviewerSpecialist: output no es array. Recibido: ${typeof output}`);
    }
    for (const item of output) {
      if (item == null || typeof item !== "object") {
        throw new Error(`ClauseReviewerSpecialist: item de output no es objeto.`);
      }
      const it = item as Record<string, unknown>;
      if (typeof it.clauseId !== "number") {
        throw new Error(`ClauseReviewerSpecialist: clauseId no es número. Recibido: ${typeof it.clauseId}`);
      }
      if (it.risk !== "low" && it.risk !== "medium" && it.risk !== "high") {
        throw new Error(`ClauseReviewerSpecialist: risk no es 'low'|'medium'|'high'. Recibido: ${it.risk}`);
      }
      if (typeof it.reason !== "string") {
        throw new Error(`ClauseReviewerSpecialist: reason no es string. Recibido: ${typeof it.reason}`);
      }
    }
  }

  private evaluateConfidence(
    node: LLMNode,
    output: unknown,
  ): { confidence?: "HIGH" | "MEDIUM" | "LOW"; confidenceValue?: number } {
    if (!node.confidenceGating) return {};
    if (output == null || typeof output !== "object") return {};
    // Para arrays, el gating puede aplicar al primer item o a un campo
    // "confidence" del array si existe. Por simplicidad, D2b.1 NO aplica
    // gating a arrays. Si el workflow lo necesita, lo declara en
    // `node.confidenceGating` con un field "confidence" en el outputSchema.
    return {};
  }
}
