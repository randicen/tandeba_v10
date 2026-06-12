/**
 * Worgena — Specialists (D2b.1).
 *
 * Barrel export de la Capa 3 del sistema agéntico.
 *
 * Componentes:
 * - `TierResolver` / `DefaultTierResolver` / `ModelRef` / `ResolvedTier`:
 *   mapea tier simbólico a invocador concreto + tier + nombre de modelo.
 *   Default: liviano → deepseek-flash, robusto → m3-thinking.
 *
 * - `Specialist` / `SpecialistExecuteParams` / `SPECIALIST_AGENT_VERSION`:
 *   interface de un specialist de Capa 3.
 *
 * - `SpecialistRegistry` / `SpecialistFactory`: construcción centralizada
 *   de specialists. Usa el `TierResolver` para inyectar el invocador
 *   correcto a cada specialist.
 *
 * - `IntakeSpecialist` / `ClauseReviewerSpecialist` / `VerifierSpecialist`:
 *   los 3 specialists del roadmap §6.2, implementados con mocks.
 *
 * - `MockDeepSeekFlashInvoker` / `MockM3ThinkingInvoker`:
 *   invocadores mock para tests. Se reemplazan por OpenRouter real en D2b.2.
 *
 * Backward-compat: ningún cambio al motor. Si el `ExecutorConfig` no tiene
 * `tierResolver` ni `specialistRegistry`, el comportamiento es D2a.4.
 *
 * Ver `AGENT_D2B_1_SPEC.md` para el spec completo.
 */

export type { ModelRef, ResolvedTier, TierResolver } from "./tier-resolver.js";
export { DefaultTierResolver } from "./tier-resolver.js";

export type { Specialist, SpecialistExecuteParams } from "./specialist.js";
export { SPECIALIST_AGENT_VERSION } from "./specialist.js";

export type { SpecialistFactory } from "./specialist-registry.js";
export { SpecialistRegistry } from "./specialist-registry.js";

export { IntakeSpecialist } from "./intake-specialist.js";
export { ClauseReviewerSpecialist } from "./clause-reviewer-specialist.js";
export { VerifierSpecialist } from "./verifier-specialist.js";

export { MockDeepSeekFlashInvoker, MockM3ThinkingInvoker } from "./mocks/mock-invokers.js";
