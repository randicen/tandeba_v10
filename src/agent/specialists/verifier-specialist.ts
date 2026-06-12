/**
 * Worgena — VerifierSpecialist (D2b.1).
 *
 * Fuente de verdad: `AGENT_D2B_1_SPEC.md` §3.10, §5.3.
 *
 * Specialist de tier robusto. Verifica el output de un productor (otro
 * specialist o un nodo LLM directo). Retorna un verdict (pass/fail) +
 * confidence + notes.
 *
 * **Importante (D2b.1)**: este verifier es un MOCK que ejecuta en el
 * mismo proceso, no en sub-sesión aislada. El verdadero "verifier en
 * sub-sesión sin sesgo confirmatorio" es D2b.2. Ver spec §3.10.
 *
 * System prompt (D2b.1): genérico, sin principios jurídicos detallados.
 * Los principios reales (defendibilidad, jerarquía de normas, etc.)
 * entran en D2b.2.
 *
 * Input: el output a verificar + el contexto.
 * Salida: `{ verified: boolean, confidence: number (0-1), notes: string }`.
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
// VerifierSpecialist
// ============================================================

/**
 * Specialist verificador. Tier robusto (m3-thinking mock).
 *
 * System prompt: "Sos un verificador de outputs. Recibís el output de un
 *  productor y el contexto en que se produjo. Respondé con un verdict
 *  (verified: true/false), un nivel de confianza entre 0 y 1, y notas
 *  breves explicando tu razonamiento. Si el output parece inconsistente
 *  con el contexto, marcá verified=false."
 *
 * User prompt: el output a verificar + contexto.
 *
 * Salida: `{ verified, confidence, notes }`.
 */
export class VerifierSpecialist implements Specialist {
  public readonly agentId = "verifier_specialist_v1";
  public readonly capabilities: readonly string[] = [
    "output_verification",
    "consistency_check",
    "defendibility",
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
      "Sos un verificador de outputs. Recibís el output de un productor y " +
      "el contexto en que se produjo. Tu trabajo es decidir si el output es " +
      "consistente con el contexto. Respondé con un objeto JSON que tenga: " +
      "'verified' (true si es consistente, false si no), 'confidence' (tu " +
      "confianza entre 0 y 1), y 'notes' (texto breve explicando tu razonamiento). " +
      "Si el output parece inconsistente con el contexto, tiene errores " +
      "factuales, o le falta información crítica, marcá verified=false."
    );
  }

  protected buildUserPrompt(input: unknown): string {
    if (typeof input === "string") return input;
    if (input == null) return "";
    return JSON.stringify(input, null, 2);
  }

  private validateOutputShape(output: unknown): void {
    if (output == null || typeof output !== "object") {
      throw new Error(`VerifierSpecialist: output no es objeto. Recibido: ${typeof output}`);
    }
    const o = output as Record<string, unknown>;
    if (typeof o.verified !== "boolean") {
      throw new Error(`VerifierSpecialist: output.verified no es boolean. Recibido: ${typeof o.verified}`);
    }
    if (typeof o.confidence !== "number" || o.confidence < 0 || o.confidence > 1) {
      throw new Error(
        `VerifierSpecialist: output.confidence no es número entre 0 y 1. Recibido: ${o.confidence}`,
      );
    }
    if (typeof o.notes !== "string") {
      throw new Error(`VerifierSpecialist: output.notes no es string. Recibido: ${typeof o.notes}`);
    }
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
