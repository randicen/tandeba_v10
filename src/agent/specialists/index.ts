/**
 * Worgena — Specialists (D2b.1 + D2b.2).
 *
 * Barrel export de la Capa 3 del sistema agéntico.
 *
 * Componentes D2b.1:
 * - `TierResolver` / `DefaultTierResolver` / `ModelRef` / `ResolvedTier`.
 * - `Specialist` / `SpecialistExecuteParams` / `SPECIALIST_AGENT_VERSION` (deprecated).
 * - `SpecialistRegistry` / `SpecialistFactory`.
 * - `IntakeSpecialist` / `ClauseReviewerSpecialist` / `VerifierSpecialist`.
 * - `MockDeepSeekFlashInvoker` / `MockM3ThinkingInvoker`.
 *
 * Componentes D2b.2 (suma):
 * - `AgentCard` / `AgentSkill` / `AgentPricing` / `AgentLimits` / `buildAgentCard` / `agentCardToJSON`.
 * - `Lifecycle` / `LifecycleState` / `LifecycleEvent` / `LifecycleListener`.
 * - `LIFECYCLE_TRANSITIONS` / `isValidLifecycleTransition`.
 * - `INTAKE_AGENT_CARD` / `CLAUSE_REVIEWER_AGENT_CARD` / `VERIFIER_AGENT_CARD` / `AGENT_CARDS_BY_ID`.
 * - `VerifierOutput` / `VerifierCitationValidation` / `VERIFIER_OUTPUT_SCHEMA` (heurística Citation Grounding v2).
 * - `MockOpenRouterClient` (mock del cliente HTTP, no del invoker).
 *
 * Backward-compat: el motor (D2a) y los tests D2b.1 (16) siguen funcionando.
 *
 * Ver `AGENT_D2B_2_SPEC.md` para el spec completo.
 */

export type { ModelRef, ResolvedTier, TierResolver } from "./tier-resolver.js";
export { DefaultTierResolver } from "./tier-resolver.js";

export type { Specialist, SpecialistExecuteParams } from "./specialist.js";
// SPECIALIST_AGENT_VERSION deprecated pero exportado por backward-compat D2b.1.
export { SPECIALIST_AGENT_VERSION } from "./specialist.js";

export type { SpecialistFactory } from "./specialist-registry.js";
export { SpecialistRegistry } from "./specialist-registry.js";

export { IntakeSpecialist } from "./intake-specialist.js";
export { ClauseReviewerSpecialist } from "./clause-reviewer-specialist.js";
export {
  VerifierSpecialist,
  VERIFIER_OUTPUT_SCHEMA,
} from "./verifier-specialist.js";
export type { VerifierOutput, VerifierCitationValidation } from "./verifier-specialist.js";

export { MockDeepSeekFlashInvoker, MockM3ThinkingInvoker, MockOpenRouterClient } from "./mocks/mock-invokers.js";

// D2b.2 — Agent Card (A2A v1.0).
export type {
  AgentCard,
  AgentSkill,
  AgentProvider,
  AgentCapabilities,
  AgentSecurityScheme,
  AgentPricing,
  AgentLimits,
} from "./agent-card.js";
export { buildAgentCard, agentCardToJSON } from "./agent-card.js";

// D2b.2 — Lifecycle.
export type { LifecycleState, LifecycleEvent, LifecycleListener } from "./lifecycle.js";
export {
  Lifecycle,
  LIFECYCLE_TRANSITIONS,
  isValidLifecycleTransition,
} from "./lifecycle.js";

// D2b.2 — Agent Cards pre-construidos de los 3 specialists.
export {
  INTAKE_AGENT_CARD,
  CLAUSE_REVIEWER_AGENT_CARD,
  VERIFIER_AGENT_CARD,
  AGENT_CARDS_BY_ID,
} from "./agent-cards/index.js";
