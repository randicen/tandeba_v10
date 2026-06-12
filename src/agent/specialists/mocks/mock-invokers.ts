/**
 * Worgena — Mock LLM Invokers (D2b.1).
 *
 * Fuente de verdad: `AGENT_D2B_1_SPEC.md` §3.5, §5.1.
 *
 * En D2b.1 los invocadores concretos son MOCKS. La integración real con
 * OpenRouter (D2b.2) los reemplaza. Ver `AGENT_D2B_1_SPEC.md` §2.1 goal 10
 * y §3.5.
 *
 * Los mocks NO son genéricos — retornan outputs específicos por specialist.
 * Esto es lo que el spec pide: "los invocadores concretos son mocks que
 * retornan outputs específicos por specialist (no por modelo)".
 *
 * Mocks provistos:
 *
 * - `MockDeepSeekFlashInvoker`: tier 3 (liviano). Retorna outputs de
 *   clasificación. Llamado por `IntakeSpecialist` con tier "liviano".
 *   Si lo llama otro specialist, retorna un error defensivo.
 *
 * - `MockM3ThinkingInvoker`: tier 1 (robusto). Retorna outputs de análisis
 *   de cláusulas o verificación. Llamado por `ClauseReviewerSpecialist`
 *   y `VerifierSpecialist` (ambos tier "robusto"). Si lo llama otro
 *   specialist, retorna un error defensivo.
 *
 * ¿Por qué mocks específicos por specialist y no genéricos?
 * - Tests deterministas: cada test sabe exactamente qué output esperar.
 * - Validación del routing: si un nodo apunta al specialist equivocado,
 *   el mock tira un error y el test falla en lugar de retornar basura.
 *
 * Trade-off: los mocks están acoplados a los specialists. Si un nuevo
 * specialist aparece, hay que agregar un nuevo mock. Aceptable en D2b.1
 * (3 specialists, 2 mocks). En D2b.2 esto se reemplaza por un solo
 * invocador real (OpenRouter) + un catálogo de respuestas por test.
 */

import type {
  LLMInvoker,
  LLMInvokeParams,
  LLMInvokeResult,
} from "../../workflow-engine/executor/types.js";

// ============================================================
// MockDeepSeekFlashInvoker (tier liviano)
// ============================================================

/**
 * Mock de tier liviano (DeepSeek Flash). Retorna un output de
 * clasificación simple — el que `IntakeSpecialist` espera.
 *
 * Comportamiento:
 * - Input: el user prompt es el `{{state.input.documentContent}}` interpolado.
 * - Output: `{ category: "contrato", confidence: 0.9 }`.
 *
 * ¿Cómo sabe que es IntakeSpecialist? El system prompt del `IntakeSpecialist`
 * empieza con "Sos un clasificador". Si el system prompt contiene esa
 * frase, retorna el output de clasificación. Si no, tira un error defensivo.
 *
 * **Costo en D2b.1**: `costUsd` es 0.001 USD (valor fijo para tests
 * deterministas). En D2b.2 el pricing es real (tokens × $/M).
 *
 * **Tokens en D2b.1**: 100 input + 50 output (constante). En D2b.2
 * son los tokens reales del LLM.
 */
export class MockDeepSeekFlashInvoker implements LLMInvoker {
  /** Override del output de clasificación (para tests que necesitan forzar categorías). */
  public classificationOverride: { category: string; confidence: number } = {
    category: "contrato",
    confidence: 0.9,
  };

  /** Cuenta de invocaciones (para tests). */
  public callCount = 0;

  /** Último params recibido (para tests). */
  public lastParams: LLMInvokeParams | undefined;

  async invoke(params: LLMInvokeParams): Promise<LLMInvokeResult> {
    this.callCount++;
    this.lastParams = params;
    const sys = params.systemPrompt ?? "";
    if (!sys.includes("clasificador")) {
      throw new Error(
        `MockDeepSeekFlashInvoker llamado por un specialist que no es clasificador. ` +
          `systemPrompt esperado: empieza con "Sos un clasificador". ` +
          `Recibido: ${sys.slice(0, 80)}`,
      );
    }
    return {
      output: { ...this.classificationOverride },
      tokensUsed: { input: 100, output: 50 },
      modelUsed: "deepseek-flash",
      costUsd: 0.001,
    };
  }
}

// ============================================================
// MockM3ThinkingInvoker (tier robusto)
// ============================================================

/**
 * Mock de tier robusto (M3 Thinking). Retorna un output específico
 * según el specialist que lo invoca:
 *
 * - Si el system prompt menciona "cláusula" o "abuso": retorna análisis
 *   de cláusulas (usado por `ClauseReviewerSpecialist`).
 *
 * - Si el system prompt menciona "verific" (verificar, verificación, etc.):
 *   retorna verdict de verificación (usado por `VerifierSpecialist`).
 *
 * - En cualquier otro caso: tira error defensivo.
 *
 * **Costo en D2b.1**: 0.01 USD (10× el tier liviano, refleja el pricing
 * relativo real). En D2b.2 es pricing real.
 */
export class MockM3ThinkingInvoker implements LLMInvoker {
  /** Override del output de análisis de cláusulas. */
  public clauseReviewOverride: Array<{
    clauseId: number;
    risk: "low" | "medium" | "high";
    reason: string;
  }> = [
    { clauseId: 1, risk: "low", reason: "Cláusula estándar" },
    { clauseId: 2, risk: "medium", reason: "Renovación tácita, revisar plazo" },
  ];

  /** Override del verdict de verificación. */
  public verifierOverride: {
    verified: boolean;
    confidence: number;
    notes: string;
  } = {
    verified: true,
    confidence: 0.85,
    notes: "El output es consistente con el contexto. Sin issues detectados.",
  };

  /** Override para forzar verificación fallida (test 6). */
  public verifierOverrideFails = false;

  /** Cuenta de invocaciones. */
  public callCount = 0;

  /** Último params recibido. */
  public lastParams: LLMInvokeParams | undefined;

  async invoke(params: LLMInvokeParams): Promise<LLMInvokeResult> {
    this.callCount++;
    this.lastParams = params;
    const sys = params.systemPrompt ?? "";
    if (sys.includes("cláusul") || sys.includes("revis") || sys.includes("abus")) {
      return {
        output: this.clauseReviewOverride.map((c) => ({ ...c })),
        tokensUsed: { input: 200, output: 150 },
        modelUsed: "m3-thinking",
        costUsd: 0.01,
      };
    }
    if (sys.includes("verific")) {
      const v = this.verifierOverrideFails
        ? { verified: false, confidence: 0.3, notes: "Conflicto detectado" }
        : this.verifierOverride;
      return {
        output: { ...v },
        tokensUsed: { input: 150, output: 100 },
        modelUsed: "m3-thinking",
        costUsd: 0.01,
      };
    }
    throw new Error(
      `MockM3ThinkingInvoker llamado por un specialist desconocido. ` +
        `systemPrompt debería mencionar cláusulas, revisión, abuso, o verificación. ` +
        `Recibido: ${sys.slice(0, 80)}`,
    );
  }
}
