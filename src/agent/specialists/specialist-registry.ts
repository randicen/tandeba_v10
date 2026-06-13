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
  /**
   * MAY-7 (audit D2 2026-06-12 cleanup #2): modelo preferido del
   * specialist. **Opcional** por backward-compat. Si está presente,
   * el registry evita construir el specialist dos veces (una vez
   * con un invoker stub para leer `preferredModel`, otra vez con
   * el invoker real). Si está ausente, se usa el patrón viejo
   * (doble construcción).
   *
   * Forward-compat: cuando todos los callers migren, este campo
   * puede ser obligatorio.
   */
  readonly preferredModel?: import("../specialists/tier-resolver.js").ModelRef;
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
    for (const factoryDesc of params.factories) {
      const { agentId, factory } = factoryDesc;
      // MIN-7 (audit D2 2026-06-12): el `set` silencioso del primer
      // specialist era un bug latente. En D2b.2 con multi-tenant (D3+)
      // se vuelve un problema real. Ahora tira si el agentId está
      // duplicado. En single-tenant / single-registro no afecta.
      if (map.has(agentId)) {
        throw new Error(
          `SpecialistRegistry: agentId "${agentId}" declarado en más de una factory. ` +
            `Cada factory debe tener un agentId único. Si querés sobreescribir un specialist, ` +
            `remové el anterior del array factories.`,
        );
      }
      // MAY-7 (audit D2 2026-06-12 cleanup #2): antes, el factory se
      // llamaba DOS veces — una vez con un invoker descartable para leer
      // `preferredModel`, otra vez con el invoker real. Eso es 2
      // side effects por cada specialist (en D2b.2, el `Lifecycle` se
      // inicializaba 2 veces; en D3+ si el factory hace I/O sería peor).
      //
      // Solución: si el factory provee `preferredModel` (opcional en
      // `SpecialistFactory`), el registry evita el doble constructor.
      // Si no, fallback al patrón viejo por backward-compat.
      let preferredModel: import("../specialists/tier-resolver.js").ModelRef;
      if (factoryDesc.preferredModel !== undefined) {
        preferredModel = factoryDesc.preferredModel;
      } else {
        // Fallback: construir stub para leer `preferredModel`. Patrón
        // viejo, deprecated. Migrar factories gradualmente.
        const stubInvoker = params.tierResolver.resolve("liviano").invoker;
        const stub = factory(stubInvoker);
        preferredModel = stub.preferredModel;
      }
      const invoker = params.tierResolver.resolve(preferredModel).invoker;
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
