/**
 * Worgena — LLM clients (D2b.2).
 *
 * Barrel export del módulo de integración con proveedores de LLM.
 *
 * Componentes:
 * - `OpenRouterClient`: cliente HTTP con `fetch` directo a OpenRouter
 *   (chat + embeddings). Transport inyectable para tests.
 *
 * - `OpenRouterLLMInvoker`: implementa `LLMInvoker` (D2a.4) sobre el
 *   cliente. Es la pieza que el motor usa para invocar LLMs.
 *
 * - `PricingCatalog`: tabla de precios por modelo. Fallback para
 *   cuando OpenRouter no devuelve `usage.cost` en la response.
 *
 * - Errores: `OpenRouterError`, `MissingOpenRouterKeyError`,
 *   `InvalidResponseError`. Mapean HTTP status al catálogo del motor
 *   (`ErrorCode`).
 *
 * - Helper: `mapHttpStatusToMotorCode` (función pura, testeable).
 *
 * **Backward-compat**: este módulo es aditivo. El motor (D2a) y los
 * specialists de D2b.1 (con mocks) siguen funcionando. Los callers
 * pueden pasar un `OpenRouterLLMInvoker` al `TierResolver` en lugar
 * de un mock, o viceversa — la interface `LLMInvoker` es la misma.
 *
 * Ver `AGENT_D2B_2_SPEC.md` para el spec completo.
 */

export {
  OpenRouterClient,
} from "./openrouter-client.js";
export type {
  OpenRouterClientOptions,
  ChatRequest,
  ChatResponse,
  ChatMessage,
  OpenAITool,
  EmbeddingResponse,
} from "./openrouter-client.js";

export { OpenRouterLLMInvoker } from "./openrouter-invoker.js";

export {
  PricingCatalog,
  DEFAULT_MODEL_PRICING,
} from "./pricing-catalog.js";
export type { ModelPricing } from "./pricing-catalog.js";

export {
  OpenRouterError,
  MissingOpenRouterKeyError,
  InvalidResponseError,
  mapHttpStatusToMotorCode,
} from "./openrouter-errors.js";
