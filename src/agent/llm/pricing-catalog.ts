/**
 * Worgena — Pricing Catalog (D2b.2).
 *
 * Fuente de verdad: `AGENT_D2B_2_SPEC.md` §3.3, §5.2.
 *
 * Tabla de precios por modelo (`promptUsdPerM`, `completionUsdPerM`).
 * Usado como **fallback** cuando OpenRouter no devuelve `usage.cost` en
 * la response. OpenRouter devuelve el costo real facturado en `usage.cost`
 * para la mayoría de los modelos; cuando no, estimamos con este catálogo.
 *
 * **Defaults** (precios públicos de OpenRouter y OpenCode Zen, redondeados, fecha 2026-06-15):
 * - `deepseek/deepseek-chat`     → $0.14 prompt / $0.28 completion por 1M tokens (OpenRouter).
 * - `anthropic/claude-3.5-sonnet` → $3.00 prompt / $15.00 completion por 1M tokens (OpenRouter).
 * - `qwen/qwen3-embedding-8b`     → $0.05 prompt / $0.00 completion por 1M tokens (OpenRouter).
 * - `deepseek-v4-flash`           → $0.14 prompt / $0.28 completion por 1M tokens (OpenCode Zen, mismo precio que chat, mismo modelo).
 * - `deepseek-v4-flash-free`      → $0.00 prompt / $0.00 completion por 1M tokens (OpenCode Zen, tier promocional temporal; datos pueden usarse para entrenar el modelo. Aceptable solo para ingesta de docs institucionales).
 *
 * El caller puede extender/sobrescribir vía `extend()` o `set()`. Esto
 * permite que D3+ meta precios por tenant o por firma sin tocar este
 * código.
 *
 * **Importante**: el catálogo es una estimación. El `OpenRouterLLMInvoker`
 * prefiere `usage.cost` cuando está; usa el catálogo solo como fallback.
 * El `raw` field del `ChatResponse` preserva la response completa, así
 * el equipo de audit puede detectar drift entre lo que OpenRouter cobró
 * y lo que el catálogo estimó.
 */

import { randomUUID } from "node:crypto";

// ============================================================
// Tipos públicos
// ============================================================

/**
 * Pricing de un modelo en USD por millón de tokens.
 *
 * El naming `UsdPerM` es deliberado para forzar al caller a hacer la
 * división por 1_000_000 al calcular. Es un error común olvidar la
 * división y terminar con costos 1M× más altos. Ver `estimateCost`.
 */
export interface ModelPricing {
  readonly promptUsdPerM: number;
  readonly completionUsdPerM: number;
  /** Moneda del precio. Hoy siempre USD. Forward-compat. */
  readonly currency: "USD";
}

/**
 * Defaults del catálogo. Se usan al construir un `PricingCatalog` sin
 * argumentos o como base del `extend()`.
 *
 * **No mutar** — los callers deben usar `extend()` o `set()` para
 * personalizar. Si lo mutamos, las instancias cacheadas del catálogo
 * (ej: en el `OpenRouterLLMInvoker`) quedan con valores alterados.
 */
export const DEFAULT_MODEL_PRICING: Readonly<Record<string, ModelPricing>> = Object.freeze({
  "deepseek/deepseek-chat": { promptUsdPerM: 0.14, completionUsdPerM: 0.28, currency: "USD" },
  "anthropic/claude-3.5-sonnet": { promptUsdPerM: 3.00, completionUsdPerM: 15.00, currency: "USD" },
  "qwen/qwen3-embedding-8b": { promptUsdPerM: 0.05, completionUsdPerM: 0.00, currency: "USD" },
  "deepseek-v4-flash": { promptUsdPerM: 0.14, completionUsdPerM: 0.28, currency: "USD" },
  "deepseek-v4-flash-free": { promptUsdPerM: 0.00, completionUsdPerM: 0.00, currency: "USD" },
});

// ============================================================
// PricingCatalog
// ============================================================

/**
 * Catálogo inmutable (excepto vía `set()` / `extend()`) de precios por modelo.
 *
 * Es la fuente de verdad para estimar costo cuando OpenRouter no devuelve
 * `usage.cost`. El `OpenRouterLLMInvoker` recibe este catálogo en su
 * constructor y lo consulta como fallback.
 *
 * **Decisión de inmutabilidad**: el `extend()` retorna un NUEVO catálogo
 * con merge, no muta el actual. Esto permite que el catálogo global
 * (default) se reutilice como base para catálogos por tenant sin riesgo
 * de contaminación cruzada. `set()` sí muta — el caller que quiera
 * inmutabilidad usa `extend()` con spread.
 *
 * **Por qué no Map<>**: la API de `get` / `set` / `extend` / `estimateCost`
 * es más limpia con `Record<string, ModelPricing>`. Map<> agrega ceremonia
 * (`.get`, `.set`, `.has`, `.entries`) que acá no aporta.
 */
export class PricingCatalog {
  private readonly pricing: Record<string, ModelPricing>;

  /**
   * Crea un catálogo.
   *
   * @param initial - Mapa inicial de precios. Si se omite, usa `DEFAULT_MODEL_PRICING`.
   *   Si se pasa, hace shallow merge con los defaults (los del parámetro pisan los defaults).
   */
  constructor(initial?: Record<string, ModelPricing>) {
    if (initial === undefined) {
      // Shallow copy para evitar que mutar `this.pricing` afecte al default global.
      this.pricing = { ...DEFAULT_MODEL_PRICING };
    } else {
      // Merge: defaults + initial. Initial pisa defaults en keys compartidas.
      this.pricing = { ...DEFAULT_MODEL_PRICING, ...initial };
    }
  }

  /**
   * Obtiene el pricing de un modelo. Retorna `undefined` si el modelo
   * no está en el catálogo. Esto le permite al caller decidir qué hacer
   * (log + 0 vs. error vs. fallback a otro catálogo).
   */
  get(modelId: string): ModelPricing | undefined {
    return this.pricing[modelId];
  }

  /**
   * Setea o sobrescribe el pricing de un modelo. Muta la instancia actual.
   *
   * Para no mutar, usar `extend()` que retorna un nuevo catálogo.
   */
  set(modelId: string, pricing: ModelPricing): void {
    this.pricing[modelId] = pricing;
  }

  /**
   * Retorna un NUEVO catálogo con los precios provistos mergeados.
   *
   * NO muta el catálogo actual — el catálogo original queda intacto y
   * el nuevo tiene los precios merged encima. Esto permite al caller
   * construir variantes (ej: por tenant) sin contaminar el base.
   */
  extend(pricings: Record<string, ModelPricing>): PricingCatalog {
    const next = new PricingCatalog({ ...this.pricing, ...pricings });
    return next;
  }

  /**
   * Lista los `modelId`s del catálogo. Útil para diagnóstico y tests.
   */
  listModelIds(): readonly string[] {
    return Object.keys(this.pricing);
  }

  /**
   * Estima el costo en USD para un call dado.
   *
   * Fórmula:
   *   costUsd = (inputTokens / 1_000_000) * promptUsdPerM
   *           + (outputTokens / 1_000_000) * completionUsdPerM
   *
   * Si el modelo no está en el catálogo, retorna 0 (no tira error). Esto
   * es defensa contra un modelo nuevo de OpenRouter que el catálogo no
   * conoce: el workflow corre, el log registra "0 USD estimado", y el
   * operador agrega el precio al catálogo. El `usage.cost` de OpenRouter
   * (cuando está) pisa este 0 con el valor real facturado.
   */
  estimateCost(modelId: string, inputTokens: number, outputTokens: number): number {
    const p = this.pricing[modelId];
    if (p === undefined) return 0;
    if (inputTokens < 0 || outputTokens < 0) return 0;
    const inputCost = (inputTokens / 1_000_000) * p.promptUsdPerM;
    const outputCost = (outputTokens / 1_000_000) * p.completionUsdPerM;
    return roundUsd(inputCost + outputCost);
  }
}

// ============================================================
// Helpers
// ============================================================

/**
 * Redondea un valor USD a 8 decimales (precisión de satoshis级别的).
 *
 * Por qué: los precios por millón dan costos del orden de 1e-6 a 1e-2 USD.
 * Sin redondeo, los floats suman ruido (0.1 + 0.2 !== 0.3). Con 8
 * decimales alcanzamos precisión útil para audit y reporte sin arrastrar
 * basura de punto flotante.
 */
function roundUsd(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1e8) / 1e8;
}

/**
 * Helper para tests: genera un `modelId` único (útil para tests que
 * quieren aislar entradas del catálogo sin colisionar entre sí).
 *
 * No se exporta en el barrel — solo se usa internamente.
 */
export function _uniqueModelIdForTests(prefix: string = "test-model"): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}
