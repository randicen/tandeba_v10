/**
 * Worgena — ClauseReviewerSpecialist (D2b.1 + D2b.2).
 *
 * Fuente de verdad:
 * - D2b.1: `AGENT_D2B_1_SPEC.md` §2.1 goal 3, §5.3.
 * - D2b.2: `AGENT_D2B_2_SPEC.md` §5.6.
 *
 * Specialist de tier robusto. Revisa cláusulas en busca de abusividad.
 *
 * **D2b.2 cambios**: agentCard + lifecycle + agentVersion desde card
 * + transición de lifecycle en execute(). Sin cambios al contrato.
 *
 * System prompt (D2b.2): sigue siendo genérico, menciona principios
 * generales de revisión contractual. Los principios jurídicos colombianos
 * específicos (ley 1429, estatuto consumidor, etc.) entran en D2c
 * (skills v1). Ver `AGENT_ROADMAP.md` §5.14.
 *
 * Input: lista de cláusulas (array de objetos).
 * Salida: array de análisis por cláusula `{ clauseId, risk, reason }`.
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
import type { Specialist, SpecialistExecuteParams } from "./specialist.js";
import type { ModelRef } from "./tier-resolver.js";
import { Lifecycle } from "./lifecycle.js";
import { CLAUSE_REVIEWER_AGENT_CARD } from "./agent-cards/index.js";
import { formatSkillsForPrompt, type SkillRegistry, type SkillDiscoveryContext } from "../skills/index.js";

// ============================================================
// ClauseReviewerSpecialist
// ============================================================

/**
 * Specialist de revisión de cláusulas. Tier robusto (Claude 3.5 Sonnet).
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
  public readonly agentVersion: string = CLAUSE_REVIEWER_AGENT_CARD.version;
  public readonly agentCard = CLAUSE_REVIEWER_AGENT_CARD;
  public readonly capabilities: readonly string[] = CLAUSE_REVIEWER_AGENT_CARD.skills.map((s) => s.id);
  public readonly preferredModel: ModelRef = "robusto";
  public readonly lifecycle: Lifecycle;

  constructor(
    private readonly invoker: LLMInvoker,
    public readonly skills?: SkillRegistry,
  ) {
    this.lifecycle = new Lifecycle();
    this.lifecycle.transition("idle", "registered");
  }

  async execute(params: SpecialistExecuteParams): Promise<NodeExecutionOutcome> {
    const { node, state, signal } = params;

    this.lifecycle.transition("busy", `node ${node.id} starting`);

    const userInput = resolveStateRef(state, node.input.from, node.input.default);
    const userPrompt = this.buildUserPrompt(userInput);

    // D2c: construir discovery context para skills. Si el workflow declara
    // topic/jurisdicción en node.metadata, los usamos. userMessage es el
    // userInput como string (puede ser JSON serializado).
    const discoveryCtx: SkillDiscoveryContext = {
      topic: node.metadata?.topic,
      jurisdiction: node.metadata?.jurisdiction,
      userMessage: typeof userInput === "string" ? userInput : JSON.stringify(userInput),
    };

    const systemPrompt = this.buildSystemPrompt(discoveryCtx);

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

      const gating = this.evaluateConfidence(node, result.output);

      this.lifecycle.transition("done", `node ${node.id} completed`);

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

  protected buildSystemPrompt(discoveryCtx?: SkillDiscoveryContext): string {
    const base =
      "Sos un revisor de cláusulas contractuales. Recibís una lista de cláusulas " +
      "(cada una con un id numérico y un texto) y devolvés, para cada una, su " +
      "nivel de riesgo ('low' / 'medium' / 'high') y una razón breve (una o dos " +
      "frases) explicando por qué. Si una cláusula parece abusiva bajo principios " +
      "generales de derecho contractual (desequilibrio manifiesto, renuncia a " +
      "derechos, cláusulas penales excesivas, etc.), marcala como 'high'. Si la " +
      "cláusula es estándar, marcala como 'low'. Para zonas grises, 'medium'.";

    // D2c: inyectar skills relevantes si el registry está disponible
    // y el caller pasó un contexto de discovery (topic, jurisdicción, mensaje).
    if (this.skills && discoveryCtx) {
      const skillSection = formatSkillsForPrompt(this.skills, discoveryCtx);
      return base + skillSection;
    }
    return base;
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
