/**
 * Worgena Workflow Engine — Function Registry.
 *
 * Registry simple de funciones nombradas que los nodos `function` invocan.
 *
 * Diseño:
 * - Map<string, WorkflowFunction>. Función por nombre (functionRef del nodo).
 * - Register / unregister / get. Sin auto-discovery (decisión de runtime).
 * - Las funciones son síncronas o async; el motor las await-ea.
 *
 * Por qué no un Map global: para multi-tenant y testing, cada WorkflowExecutor
 * tiene SU propio registry. Inyectar evita el estado global compartido.
 *
 * Uso en tests:
 *   const reg = new FunctionRegistry();
 *   reg.register("classify_document", (input) => ({ category: "contrato" }));
 *   const executor = new WorkflowExecutor({ functionRegistry: reg, ... });
 */

import type { WorkflowFunction } from "./types.js";

export class FunctionRegistry {
  private readonly functions = new Map<string, WorkflowFunction>();

  /** Registra una función. Si ya existía, la sobreescribe. */
  register(name: string, fn: WorkflowFunction): void {
    this.functions.set(name, fn);
  }

  /** Desregistra una función. No-op si no existía. */
  unregister(name: string): void {
    this.functions.delete(name);
  }

  /** Obtiene una función. Retorna undefined si no existe. */
  get(name: string): WorkflowFunction | undefined {
    return this.functions.get(name);
  }

  /** Lista de funciones registradas (para debugging). */
  list(): readonly string[] {
    return Array.from(this.functions.keys());
  }

  /** Cantidad de funciones registradas. */
  get size(): number {
    return this.functions.size;
  }
}
