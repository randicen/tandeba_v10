/**
 * Worgena Workflow Engine — Circuit Breaker.
 *
 * Fuente de verdad: AGENT_D2A_2_3_CORE_PRIMITIVES_SPEC.md §3, §8.
 *
 * El circuit breaker decide si una "specialist" (modelo LLM) debe ser
 * invocada o no, basándose en su historial reciente de fallos.
 *
 * Filosofía de diseño:
 *
 * - El motor de workflows (Capa 1) NO implementa la policy (cuándo abrir,
 *   cuánto tiempo, cuántos fallos, etc.). Solo expone la interfaz y un
 *   default no-op.
 *
 * - La policy real la implementa el **multi-model router de D2b**, que es
 *   quien sabe qué es un "specialist" en el sentido real (ej:
 *   `clause_extractor_specialist_v1`, `intake_router_specialist`).
 *
 * - El motor trata `specialistId` como **string opaco**. Hoy (D2a) se mapea
 *   a `node.model`; mañana (D2b) se mapea al ID del specialist. El motor
 *   no asume que es un modelo.
 *
 * - El `breaker.isOpen(specialistId)` se consulta **antes de CADA attempt** de
 *   un nodo LLM, no solo antes del primero. Si el breaker abre durante los
 *   retries, el siguiente attempt lo ve y falla rápido sin invocar al LLM.
 *
 * Por qué esta separación (de `AGENT_ROADMAP.md` §6.1 vs spec 2a.2.2 §2.2):
 *
 * El roadmap §6.1 describe el circuit breaker como primitiva del motor.
 * El spec 2a.2.2 §2.2 dice que vive en D2b. Ambos tienen razón desde
 * distintos ángulos: el motor necesita la **infraestructura** (interfaz +
 * instrumentación) y D2b necesita la **policy** (cuándo abrir, con qué
 * umbral, con qué cool-down). D2a.2.3 provee lo primero; D2b enchufa
 * lo segundo. Ver `AGENT_D2A_2_3_CORE_PRIMITIVES_SPEC.md` §3.
 */

// ============================================================
// Interfaz pública
// ============================================================

/**
 * El circuit breaker decide si un specialist debe ser invocado.
 *
 * Implementación provista por el caller (D2a: `NoopCircuitBreaker`; D2b:
 * implementación real con policy configurable).
 */
export interface CircuitBreaker {
  /**
   * Registra un éxito del specialist. Resetea contadores de fallos
   * (en la implementación que el caller provea).
   */
  recordSuccess(specialistId: string): void;

  /**
   * Registra un fallo del specialist. Incrementa contadores.
   */
  recordFailure(specialistId: string): void;

  /**
   * ¿El circuito está abierto para este specialist? Si true, el motor
   * NO invoca al specialist; el nodo retorna `MODEL_UNAVAILABLE` con
   * `retriable: true` (los retries del workflow siguen aplicando).
   *
   * Se consulta antes de CADA attempt, no solo el primero.
   */
  isOpen(specialistId: string): boolean;
}

// ============================================================
// Default: no-op
// ============================================================

/**
 * Circuit breaker que nunca abre. Default del motor si el caller no
 * inyecta uno distinto.
 *
 * Útil para:
 * - Tests que no quieren que el breaker afecte la ejecución.
 * - D2a, donde la policy real es no-op (D2b la provee).
 * - Single-tenant / single-model setups donde el breaker no aporta.
 */
export class NoopCircuitBreaker implements CircuitBreaker {
  recordSuccess(_specialistId: string): void {
    // No-op.
  }

  recordFailure(_specialistId: string): void {
    // No-op.
  }

  isOpen(_specialistId: string): boolean {
    return false;
  }
}
