/**
 * Worgena — Specialist Registry (D2b.1).
 *
 * Fuente de verdad: `AGENT_D2B_1_SPEC.md` §3.4, §3.8, §5.1.
 *
 * El `SpecialistRegistry` es el mapa de `agentId` → `Specialist`.
 * Centraliza la construcción de specialists y la resolución de
 * invocadores. El motor solo necesita `get(agentId)` para rutear.
 *
 * Cadena de delegación completa (de spec §3.4):
 *
 * ```
 * node-runner
 *   → specialistRegistry.get(agentId)        // devuelve Specialist
 *   → specialist.execute(params)             // Specialist tiene el invoker
 *     → invoker.invoke({system, user, ...})  // El LLM real (o mock)
 * ```
 *
 * Construcción de specialists (D2b.1):
 *
 * ```
 * SpecialistRegistry.create({
 *   tierResolver: defaultTierResolver,
 *   invokers: {
 *     "intake_specialist_v1": intakeSpecialist,   // class
 *     "clause_reviewer_specialist_v1": clauseReviewerSpecialist,
 *     "verifier_specialist_v1": verifierSpecialist,
 *   },
 * })
 * ```
 *
 * El registry:
 * 1. Para cada specialist, lee su `preferredModel` (tier o nombre).
 * 2. Llama `tierResolver.resolve(preferredModel)` para obtener el invocador.
 * 3. Construye el specialist con ese invocador.
 * 4. Lo guarda en un Map.
 *
 * Validación de `assignedSpecialist`:
 * - Si el nodo LLM tiene `assignedSpecialist: "foo_v1"` y el registry
 *   NO tiene ese agentId, el `WorkflowExecutor.startTask` falla con
 *   `ExecutorError` código `NODE_NOT_FOUND` (spec §3.11). Esto se valida
 *   en el executor, NO en el registry (que es solo el mapa).
 *
 * Por qué un registry en lugar de un Map<>: queremos centralizar la
 * construcción (resolver invocadores, validar capabilities) en un solo
 * lugar. Si en D2b.2 los specialists tienen dependencias más complejas
 * (config, skills, tools), el registry las inyecta.
 */

import type { Specialist } from "./specialist.js";
import type { TierResolver } from "./tier-resolver.js";

// ============================================================
// Tipo de factory: el registry necesita poder construir cada specialist.
// ============================================================

/**
 * Factory de un specialist. Recibe el invocador resuelto (vía TierResolver)
 * y retorna el specialist listo para usar.
 *
 * Patrón:
 * ```typescript
 * {
 *   agentId: "intake_specialist_v1",
 *   factory: (invoker) => new IntakeSpecialist(invoker),
 * }
 * ```
 *
 * El factory recibe el `LLMInvoker` ya resuelto por el `TierResolver`.
 * Esto desacopla la creación del invocador del specialist.
 */
export interface SpecialistFactory {
  readonly agentId: string;
  readonly factory: (invoker: import("../workflow-engine/executor/types.js").LLMInvoker) => Specialist;
}

// ============================================================
// SpecialistRegistry
// ============================================================

/**
 * Registry de specialists. Mapa inmutable `agentId` → `Specialist`.
 *
 * Construcción:
 * ```typescript
 * const registry = SpecialistRegistry.create({
 *   tierResolver: new DefaultTierResolver(livianoInvoker, robustoInvoker),
 *   factories: [
 *     { agentId: "intake_specialist_v1", factory: (i) => new IntakeSpecialist(i) },
 *     { agentId: "clause_reviewer_specialist_v1", factory: (i) => new ClauseReviewerSpecialist(i) },
 *     { agentId: "verifier_specialist_v1", factory: (i) => new VerifierSpecialist(i) },
 *   ],
 * });
 * ```
 *
 * Uso desde el node-runner:
 * ```typescript
 * const specialist = registry.get(node.assignedSpecialist);
 * if (specialist) {
 *   const outcome = await specialist.execute({ node, task, state, signal });
 *   // ...
 * }
 * ```
 *
 * Backward-compat: si el `ExecutorConfig` no tiene `specialistRegistry`,
 * el motor usa el `llmInvoker` default (D2a.4 behavior). El registry
 * es opt-in.
 */
export class SpecialistRegistry {
  private readonly specialists: ReadonlyMap<string, Specialist>;

  private constructor(specialists: ReadonlyMap<string, Specialist>) {
    this.specialists = specialists;
  }

  /**
   * Construye un registry. Resuelve los invocadores de cada specialist
   * usando el `TierResolver`, llama el factory, y guarda el resultado.
   *
   * Si dos factories declaran el mismo `agentId`, la segunda pisa a la
   * primera. Es un error de configuración; no lo validamos explícitamente
   * porque en D2b.1 los mocks se controlan desde un solo lugar.
   */
  static create(params: {
    readonly tierResolver: TierResolver;
    readonly factories: readonly SpecialistFactory[];
  }): SpecialistRegistry {
    const map = new Map<string, Specialist>();
    for (const { agentId, factory } of params.factories) {
      // Construimos un specialist "stub" para leer su `preferredModel`.
      // Esto requiere un truco: el factory se llama una vez con un
      // invoker descartable solo para leer `preferredModel`, luego
      // lo descartamos y construimos el real. En D2b.1 los specialists
      // son livianos (no tienen estado de constructor), así que esto
      // es barato. Si en D2b.2 los constructors son caros, el patrón
      // se refactoriza (ej: factories que retornan metadata + factory).
      //
      // Más limpio: cada factory provee su agentId + preferredModel
      // directamente, y el invocador se resuelve en build-time. Pero
      // eso obliga a duplicar el agentId/preferredModel en el factory
      // descriptor. Mantengo el patrón "construir stub" por simplicidad.
      const stubInvoker = params.tierResolver.resolve("liviano").invoker;
      const stub = factory(stubInvoker);
      const invoker = params.tierResolver.resolve(stub.preferredModel).invoker;
      const real = factory(invoker);
      map.set(agentId, real);
    }
    return new SpecialistRegistry(map);
  }

  /**
   * Obtiene un specialist por su `agentId`. Retorna `undefined` si no existe.
   *
   * El motor (D2b.1) valida que el specialist EXISTA en `startTask`
   * (falla con `NODE_NOT_FOUND` si no). Acá solo retornamos `undefined`
   * para que el caller decida.
   */
  get(agentId: string): Specialist | undefined {
    return this.specialists.get(agentId);
  }

  /**
   * Lista los `agentId`s registrados. Útil para diagnóstico y tests.
   */
  listAgentIds(): readonly string[] {
    return [...this.specialists.keys()];
  }
}
