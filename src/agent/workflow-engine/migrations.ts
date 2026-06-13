/**
 * Worgena Workflow Engine — Schema versioning con migradores.
 *
 * Fuente de verdad: AGENT_D2A_2_3_CORE_PRIMITIVES_SPEC.md §7.
 *
 * Responsabilidades:
 * 1. Definir el contrato de un migrador (función pura que transforma un
 *    WorkflowDefinition de un schemaVersion a otro).
 * 2. Proveer `loadWorkflow(workflow, registry, targetVersion)` que aplica
 *    los migradores en cadena si el schemaVersion del workflow es menor
 *    al del motor.
 * 3. Rechazar workflows con schemaVersion > target con `SCHEMA_VERSION_UNSUPPORTED`.
 *
 * Decisiones de diseño (revisión v1.1):
 *
 * - **DI del registry**: el `MigratorRegistry` se inyecta al `ExecutorConfig`.
 *   NO es un `Map` global mutable a nivel de módulo. Cada Executor tiene su
 *   propio registry. Esto evita que un test que registra un migrador contamine
 *   a todos los tests siguientes. Mismo patrón que el `CircuitBreaker`.
 *
 * - **Migración LAZY al ejecutar** (decisión específica de Worgena, no genérica):
 *   `loadWorkflow` NO se llama en `parseWorkflow` ni en `validateWorkflow`. Se
 *   llama en el `WorkflowExecutor` al cargar la task. La task guarda
 *   `migratedWorkflow` y `appliedMigrations` para audit legal coherente. El
 *   replay usa `migratedWorkflow` (no re-aplica migradores). Ver
 *   `AGENT_D2A_2_3_CORE_PRIMITIVES_SPEC.md` §7.4.
 *
 * - **Atomicidad de los migradores**: los migradores son funciones puras
 *   `(WorkflowDefinition) => WorkflowDefinition`. Si uno tira, no se aplica
 *   nada — la función pura no completó y no hay estado intermedio que
 *   persistir. Atomicidad por construcción, no requiere transacción explícita.
 *
 * - **Versión actual**: hoy es 1. Cuando salga spec v2, se bumpa este
 *   constante, se escribe el primer migrador `1->2`, y se registra en
 *   el `MigratorRegistry` del `ExecutorConfig`.
 */

import { ExecutorError } from "./executor/errors.js";
import type { WorkflowDefinition } from "./dsl/types.js";

// ============================================================
// Constantes
// ============================================================

/**
 * Versión actual del spec del DSL que este motor implementa.
 *
 * Spec v0.2 (ver `AGENT_WORKFLOW_DSL_SPEC.md`) corresponde a schemaVersion: 1.
 * Cuando salga spec v2, este constante se bumpa a 2 y se agrega el migrador
 * `1->2` en el registry del ExecutorConfig.
 */
export const CURRENT_SCHEMA_VERSION = 1 as const;

// ============================================================
// Tipos públicos
// ============================================================

/**
 * Un migrador transforma un workflow de un schemaVersion a otro. Es una
 * función pura: no toca DB, no hace I/O, no registra side effects. Solo
 * adapta la shape.
 *
 * Si el migrador tira, NO se aplica nada (atomicidad de función pura).
 * Si requiere decisión humana (ej: borrar datos), el migrador tira con
 * un error claro y pide acción manual.
 */
export type Migrator = (workflow: WorkflowDefinition) => WorkflowDefinition;

/**
 * Registry de migradores. Key: `${fromVersion}->${toVersion}`.
 * Ej: `"1->2"` para migrar de spec v1 a v2.
 *
 * Se inyecta al ExecutorConfig. NO es global mutable. Ver header del archivo.
 */
export type MigratorRegistry = Map<string, Migrator>;

// ============================================================
// API pública
// ============================================================

/**
 * Resultado de aplicar migraciones a un workflow.
 *
 * - `workflow`: el workflow efectivo (post-migración, o el original si no
 *   hubo migración).
 * - `appliedMigrations`: lista de keys `"${from}->${to}"` que se aplicaron.
 *   Vacía si no hubo migración.
 *
 * El caller (WorkflowExecutor) usa `appliedMigrations` para setear
 * `Task.appliedMigrations` en audit (`AGENT_D2A_2_3_CORE_PRIMITIVES_SPEC.md` §7.4).
 */
export interface LoadWorkflowResult {
  readonly workflow: WorkflowDefinition;
  readonly appliedMigrations: readonly string[];
}

/**
 * Carga un workflow aplicando migradores del registry si es necesario.
 *
 * Comportamiento:
 * - Si `workflow.schemaVersion === targetVersion`, retorna el workflow tal cual con `appliedMigrations: []`.
 * - Si `workflow.schemaVersion > targetVersion`, tira `ExecutorError` con
 *   `SCHEMA_VERSION_UNSUPPORTED` y mensaje claro: el workflow fue escrito
 *   contra un schema más nuevo que el del motor actual.
 * - Si `workflow.schemaVersion < targetVersion`, busca migradores en cadena
 *   (ej: 1→2, 2→3). Si falta algún migrador intermedio, tira con mensaje
 *   específico sobre qué migración falta. Trackea las keys aplicadas.
 *
 * El `registry` y el `targetVersion` se pasan explícitamente. El `targetVersion`
 * default es `CURRENT_SCHEMA_VERSION` (1) si no se especifica.
 *
 * Atomicidad: si un migrador tira a mitad de la cadena, no se aplica nada.
 * El workflow no queda con shape parcial.
 *
 * @example
 *   const registry = new Map();
 *   registry.set("1->2", (wf) => ({ ...wf, schemaVersion: 2, /* renames *\/ }));
 *   const { workflow, appliedMigrations } = loadWorkflow(oldWorkflow, registry, 2);
 */
export function loadWorkflow(
  workflow: WorkflowDefinition,
  registry: MigratorRegistry,
  targetVersion: number = CURRENT_SCHEMA_VERSION,
): LoadWorkflowResult {
  // Caso base: ya está en la versión del motor.
  if (workflow.schemaVersion === targetVersion) {
    return { workflow, appliedMigrations: [] };
  }

  // Workflow escrito contra schema más nuevo que el del motor.
  if (workflow.schemaVersion > targetVersion) {
    throw new ExecutorError(
      `Workflow "${workflow.id}" v${workflow.workflowVersion} escrito contra schema v${workflow.schemaVersion}, pero el motor solo soporta hasta v${targetVersion}. Actualizá el motor o reescribí el workflow.`,
      "SCHEMA_VERSION_UNSUPPORTED",
      {
        workflowId: workflow.id,
        workflowSchemaVersion: workflow.schemaVersion,
        motorSchemaVersion: targetVersion,
      },
    );
  }

  // workflow.schemaVersion < targetVersion. Aplicar migradores en cadena.
  const appliedMigrations: string[] = [];
  let current: WorkflowDefinition = workflow;
  let currentVersion = current.schemaVersion;

  while (currentVersion < targetVersion) {
    const key = `${currentVersion}->${currentVersion + 1}`;
    const migrator = registry.get(key);
    if (!migrator) {
      throw new ExecutorError(
        `No hay migrador de schema v${currentVersion} a v${currentVersion + 1} para workflows. Workflow "${workflow.id}" v${workflow.workflowVersion} no se puede cargar. Registrá el migrador en el ExecutorConfig.migrators.`,
        "SCHEMA_VERSION_UNSUPPORTED",
        {
          workflowId: workflow.id,
          missingMigration: key,
        },
      );
    }
    // Aplicar el migrador. Si tira, no se aplica nada (atomicidad de función pura).
    current = migrator(current);
    currentVersion = current.schemaVersion;
    appliedMigrations.push(key);
  }

  return { workflow: current, appliedMigrations };
}
