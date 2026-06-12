/**
 * Worgena — Tier Resolver (D2b.1).
 *
 * Fuente de verdad: `AGENT_D2B_1_SPEC.md` §3.2, §3.4, §5.1.
 *
 * El `TierResolver` mapea `ModelRef` (tier o nombre específico) a un
 * `LLMInvoker` concreto + tier + nombre de modelo. Es una función pura,
 * NO un LLM decidiendo en runtime.
 *
 * Tres tipos de `ModelRef`:
 * - `"liviano"`: tier 3 (clasificación, extracción simple, etc.).
 * - `"robusto"`: tier 1 (razonamiento jurídico, verificador, etc.).
 * - string arbitrario: nombre específico de modelo (ej: "gpt-4o",
 *   "claude-3.5-sonnet"). Cae a robusto por default (defensa).
 *
 * `DefaultTierResolver` es la implementación standard. Worgena en producción
 * probablemente usa una variante (configurada por tenant / firma / modelo
 * legal), pero la lógica es la misma.
 *
 * Por qué existe este tipo:
 * - Hoy (D2a.4) el `node-runner` lee `node.model` y lo pasa directo al
 *   `llmInvoker.invoke()`. No hay separación entre "qué modelo" y
 *   "qué invocador".
 * - D2b.1 introduce esa separación: tier es la categoría, invoker es
 *   la implementación concreta, model es el nombre específico.
 * - Esto permite que un mismo workflow apunte a distintos invocadores
 *   según el nodo (multi-model routing), sin hardcodear en el motor.
 *
 * Decisión: backward-compat con D2a.4. Si el `ExecutorConfig` NO tiene
 * `tierResolver`, el motor usa el `llmInvoker` default (D2a.4 behavior).
 * El `tierResolver` es opt-in.
 *
 * D2b.2: integración real con OpenRouter. El `DefaultTierResolver`
 * mantiene los mocks de D2b.1; un `OpenRouterTierResolver` se enchufa
 * en D2b.2 con la lógica de mapping tier → nombre de modelo real
 * (ej: "liviano" → "deepseek/deepseek-chat", "robusto" → "anthropic/claude-3.5-sonnet").
 */

import type { LLMInvoker } from "../workflow-engine/executor/types.js";

// ============================================================
// Tipos públicos
// ============================================================

/**
 * Referencia simbólica o nombre específico de modelo. Hoy se acepta:
 * - `"liviano"`: tier 3.
 * - `"robusto"`: tier 1.
 * - string arbitrario: nombre de modelo específico.
 *
 * En D2b.2 se mantiene la misma forma, pero el `DefaultTierResolver`
 * se reemplaza por uno que conoce los nombres reales de OpenRouter.
 */
export type ModelRef = "liviano" | "robusto" | string;

/**
 * Resultado de resolver un `ModelRef`. Contiene:
 * - `invoker`: la implementación concreta a invocar.
 * - `tier`: la categoría ("liviano" | "robusto" | string custom).
 * - `model`: el nombre específico del modelo (para logging/audit/cost).
 *
 * El `invoker` se usa para hacer la llamada; el `tier` y `model` se
 * usan para reporting (NodeResult.modelUsed, cost attribution, etc.).
 */
export interface ResolvedTier {
  readonly invoker: LLMInvoker;
  readonly tier: "liviano" | "robusto" | string;
  readonly model: string;
}

/**
 * Interface del resolver. Una sola función: dado un `ModelRef`, retorna
 * el invocador concreto + tier + nombre de modelo.
 *
 * Implementación: `DefaultTierResolver` (mocks en D2b.1). En D2b.2 se
 * puede inyectar uno que sepa mapear tier → OpenRouter real.
 *
 * Por qué función pura: el motor es determinista (Capa 1). El routing
 * no puede tener "sorpresas" en runtime. Si el caller quiere routing
 * dinámico, lo hace en Capa 2 (intake router) o Capa 3 (specialist
 * decide), no acá.
 */
export interface TierResolver {
  resolve(modelRef: ModelRef): ResolvedTier;
}

// ============================================================
// DefaultTierResolver
// ============================================================

/**
 * Resolver por default. Mapea tier simbólico a invocador mock.
 *
 * Comportamiento:
 * - `modelRef === "liviano"` → invocador liviano + tier "liviano" + model "deepseek-flash".
 * - `modelRef === "robusto"` → invocador robusto + tier "robusto" + model "m3-thinking".
 * - Cualquier otro string → cae a robusto (defensa). El model específico
 *   es el string original (para que se loguee "gpt-4o" en `modelUsed`
 *   si el nodo lo declara, no "robusto").
 *
 * Por qué fallback a robusto: en D2a.4, un workflow con `model: "gpt-4o"`
 * se invocaba al `llmInvoker` default (que era el robusto). En D2b.1
 * mantenemos ese comportamiento: un modelRef desconocido va al invocador
 * robusto. Esto preserva backward-compat con workflows existentes.
 *
 * **D2b.2**: este resolver se reemplaza por uno que conoce el mapping
 * real a OpenRouter. La interface `TierResolver` se mantiene igual.
 */
export class DefaultTierResolver implements TierResolver {
  constructor(
    private readonly livianoInvoker: LLMInvoker,
    private readonly robustoInvoker: LLMInvoker,
  ) {}

  resolve(modelRef: ModelRef): ResolvedTier {
    if (modelRef === "liviano") {
      return {
        invoker: this.livianoInvoker,
        tier: "liviano",
        model: "deepseek-flash",
      };
    }
    if (modelRef === "robusto") {
      return {
        invoker: this.robustoInvoker,
        tier: "robusto",
        model: "m3-thinking",
      };
    }
    // Fallback: modelRef es un nombre específico (ej: "gpt-4o"). Va al
    // invocador robusto, conservando el nombre original en `model` para
    // que el audit log lo registre tal cual.
    return {
      invoker: this.robustoInvoker,
      tier: "robusto",
      model: modelRef,
    };
  }
}
