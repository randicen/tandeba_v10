/**
 * Worgena — Agent Card (D2b.2).
 *
 * Fuente de verdad: `AGENT_D2B_2_SPEC.md` §3.5, §5.4.
 *
 * Implementa la metadata A2A v1.0 (Agent-to-Agent spec de Google) que
 * cada specialist expone. En D3+ se sirve en `/.well-known/agent.json`
 * vía un A2A server. En D2b.2 es metadata in-memory, accesible vía
 * `specialist.agentCard.toJSON()`.
 *
 * **Estructura** (basada en A2A v1.0, sección 4.4.1):
 * - Identidad: `name`, `description`, `version` (semver), `provider`.
 * - Endpoint: `url` (placeholder en D2b.2 — el A2A server real es D3+).
 * - Capabilities A2A: `streaming`, `pushNotifications`, `extendedAgentCard`.
 * - Skills: array de `AgentSkill` (id, name, description, tags, examples).
 * - Security: `securitySchemes` (apiKey Bearer) + `security` (qué schemes se usan).
 * - Modalities: `defaultInputModes` / `defaultOutputModes` (text, json, etc.).
 * - Extensiones Worgena: `pricing` y `limits` (no son estándar A2A, son
 *   forward-compat para que el A2A server de D3+ las pueda usar).
 *
 * **Por qué un objeto TS en lugar de un JSON Schema estático** (§3.5):
 * el card se construye en código con tipos, IntelliSense, y refactors
 * seguros. `toJSON()` produce el JSON A2A v1.0 válido (validable contra
 * el schema oficial). Una sola fuente de verdad.
 *
 * **Inmutabilidad**: todos los campos son `readonly`. El card se
 * construye una vez en el `agentCard` field del specialist y no
 * se muta. Si en el futuro se necesita versioning dinámico, se
 * reemplaza con un builder.
 */

// ============================================================
// Tipos públicos
// ============================================================

/**
 * Skill que un agent puede realizar. A2A v1.0 spec §4.4.1.
 *
 * El `id` debe ser estable y único dentro del agent (no se reutiliza
 * entre skills). Las `tags` son strings libres que el descubridor
 * (A2A server de D3+) puede usar para matching.
 */
export interface AgentSkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  /** Ejemplos de input/output esperado (forward-compat con discovery). */
  readonly examples?: readonly string[];
}

/**
 * Provider del agent. Identifica la organización dueña. A2A v1.0.
 */
export interface AgentProvider {
  readonly organization: string;
  readonly url?: string;
}

/**
 * Capabilities A2A v1.0. Flags declarativos de qué soporta el agent.
 *
 * En D2b.2 todos son `false` porque:
 * - `streaming`: no soportado (D3+ o demanda).
 * - `pushNotifications`: no soportado (el audit es pull-based).
 * - `extendedAgentCard`: no soportado (los cards son estáticos).
 */
export interface AgentCapabilities {
  readonly streaming: boolean;
  readonly pushNotifications: boolean;
  readonly extendedAgentCard: boolean;
}

/**
 * Esquema de seguridad A2A. Hoy solo Bearer apiKey (OpenRouter style).
 * Forward-compat: si en D3+ se agrega OAuth, mTLS, etc., se extiende.
 */
export interface AgentSecurityScheme {
  readonly apiKey: {
    readonly type: "http";
    readonly scheme: "bearer";
  };
}

/**
 * Extensión Worgena: pricing del agent (no estándar A2A).
 *
 * Es forward-compat: el A2A server de D3+ puede exponerla a clientes
 * que quieran calcular costo antes de invocar. Los precios de las
 * AgentPricing son los MISMOS que el `PricingCatalog` (fuente única
 * de verdad). El `agentCard` los snapshot al construirse — si el
 * catálogo cambia después, el card no se actualiza (es metadata
 * del agent al deploy, no en runtime).
 */
export interface AgentPricing {
  readonly promptUsdPerM: number;
  readonly completionUsdPerM: number;
  readonly currency: "USD";
}

/**
 * Extensión Worgena: límites operacionales del agent.
 *
 * El motor o el A2A server pueden usar estos límites para rate-limit,
 * circuit-breaking, o budgeting por tenant.
 */
export interface AgentLimits {
  /** Máximo de tokens por request (input + output). */
  readonly maxTokens: number;
  /** Máximo de requests por minuto. */
  readonly maxRequestsPerMinute: number;
  /** Máximo de ejecuciones concurrentes del agent. */
  readonly maxConcurrent: number;
}

/**
 * Agent Card completo. Cumple A2A v1.0 spec §4.4.1 más extensiones
 * Worgena (`pricing`, `limits`).
 *
 * **Inmutable**: todos los campos `readonly`. Si necesitás un card
 * distinto, construí uno nuevo.
 */
export interface AgentCard {
  // Identidad.
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly provider: AgentProvider;
  // Service endpoint (D3+ — hoy placeholder).
  readonly url: string;
  // Capabilities A2A.
  readonly capabilities: AgentCapabilities;
  // Skills.
  readonly skills: readonly AgentSkill[];
  // Security.
  readonly securitySchemes: AgentSecurityScheme;
  readonly security: readonly { readonly apiKey: readonly string[] }[];
  // Modalities.
  readonly defaultInputModes: readonly string[];
  readonly defaultOutputModes: readonly string[];
  // Extensiones Worgena (forward-compat con A2A server de D3+).
  readonly pricing?: AgentPricing;
  readonly limits?: AgentLimits;
}

// ============================================================
// Helpers para construir cards
// ============================================================

/**
 * Builder ergonómico para construir un `AgentCard`. Centraliza los
 * defaults (capabilities todas en false, modalidades default) y hace
 * que el código de los 3 cards sea declarativo.
 *
 * **Uso**:
 * ```typescript
 * const card = buildAgentCard({
 *   name: "Intake Specialist",
 *   description: "...",
 *   version: "1.0.0",
 *   provider: { organization: "Worgena" },
 *   skills: [{ id: "classify", name: "...", ... }],
 *   pricing: { promptUsdPerM: 0.14, completionUsdPerM: 0.28, currency: "USD" },
 *   limits: { maxTokens: 8000, maxRequestsPerMinute: 60, maxConcurrent: 5 },
 * });
 * ```
 *
 * **Por qué un builder en vez de objeto literal**: garantiza que todos
 * los cards tengan los mismos defaults (ej: todas las capabilities en
 * false), evitando inconsistencias. Si un card necesita un override,
 * se pasa explícitamente al builder.
 */
export function buildAgentCard(params: {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly provider: AgentProvider;
  readonly url: string;
  readonly skills: readonly AgentSkill[];
  readonly capabilities?: Partial<AgentCapabilities>;
  readonly defaultInputModes?: readonly string[];
  readonly defaultOutputModes?: readonly string[];
  readonly pricing?: AgentPricing;
  readonly limits?: AgentLimits;
}): AgentCard {
  // Defaults de capabilities: D2b.2 no streamea, no usa webhooks,
  // no expone card extendido.
  const capabilities: AgentCapabilities = {
    streaming: params.capabilities?.streaming ?? false,
    pushNotifications: params.capabilities?.pushNotifications ?? false,
    extendedAgentCard: params.capabilities?.extendedAgentCard ?? false,
  };

  return {
    name: params.name,
    description: params.description,
    version: params.version,
    provider: params.provider,
    url: params.url,
    capabilities,
    skills: params.skills,
    securitySchemes: { apiKey: { type: "http", scheme: "bearer" } },
    security: [{ apiKey: [] }],
    defaultInputModes: params.defaultInputModes ?? ["text"],
    defaultOutputModes: params.defaultOutputModes ?? ["json"],
    ...(params.pricing !== undefined ? { pricing: params.pricing } : {}),
    ...(params.limits !== undefined ? { limits: params.limits } : {}),
  };
}

/**
 * Convierte un `AgentCard` a JSON A2A v1.0. El output es serializable
 * a `JSON.stringify()` y validable contra el schema oficial de A2A
 * (cuando se agregue esa validación en D3+).
 *
 * **Por qué un método separado**: en runtime queremos el `AgentCard`
 * como objeto TS con tipos. Cuando lo exponemos (audit, debug, A2A
 * server), queremos JSON. Separar las dos vistas evita "any-ificar"
 * el card en runtime.
 */
export function agentCardToJSON(card: AgentCard): Record<string, unknown> {
  // Construimos explícitamente para garantizar el shape (TS no
  // infiere `as const` de un readonly anidado).
  const out: Record<string, unknown> = {
    name: card.name,
    description: card.description,
    version: card.version,
    provider: {
      organization: card.provider.organization,
      ...(card.provider.url !== undefined ? { url: card.provider.url } : {}),
    },
    url: card.url,
    capabilities: {
      streaming: card.capabilities.streaming,
      pushNotifications: card.capabilities.pushNotifications,
      extendedAgentCard: card.capabilities.extendedAgentCard,
    },
    skills: card.skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      tags: [...s.tags],
      ...(s.examples !== undefined ? { examples: [...s.examples] } : {}),
    })),
    securitySchemes: {
      apiKey: {
        type: card.securitySchemes.apiKey.type,
        scheme: card.securitySchemes.apiKey.scheme,
      },
    },
    security: card.security.map((s) => ({ apiKey: [...s.apiKey] })),
    defaultInputModes: [...card.defaultInputModes],
    defaultOutputModes: [...card.defaultOutputModes],
  };
  if (card.pricing !== undefined) {
    out.pricing = {
      promptUsdPerM: card.pricing.promptUsdPerM,
      completionUsdPerM: card.pricing.completionUsdPerM,
      currency: card.pricing.currency,
    };
  }
  if (card.limits !== undefined) {
    out.limits = {
      maxTokens: card.limits.maxTokens,
      maxRequestsPerMinute: card.limits.maxRequestsPerMinute,
      maxConcurrent: card.limits.maxConcurrent,
    };
  }
  return out;
}
