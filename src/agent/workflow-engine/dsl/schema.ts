/**
 * Worgena Workflow DSL — JSON Schema (runtime validation) + cross-validation.
 *
 * Fuente de verdad: AGENT_WORKFLOW_DSL_SPEC.md §3, §4.
 * Spec version: 0.2
 *
 * Este archivo es LA fuente de verdad para validación en runtime. Los tipos en
 * `./types.ts` son la fuente de verdad para el sistema de tipos de TypeScript.
 * Deben mantenerse en sync. En D2b considerar generar uno desde el otro.
 *
 * Estrategia:
 * 1. JSON Schema estándar (draft-07) para la estructura (con ajv).
 * 2. Cross-validation explícita para reglas que JSON Schema no expresa bien:
 *    - confidenceGating <-> outputSchema.confidence
 *    - Todos los edge.from / edge.to / entryNode referencian nodos existentes
 *    - No hay ciclos en el grafo (workflow es DAG)
 *    - No hay nodos inalcanzables (revisión opcional, warning)
 *
 * Decisiones de diseño (post-auditoría D2a.1+D2a.1b):
 * - `validateWorkflow` retorna un discriminated union con `data: WorkflowDefinition`
 *   en el caso de éxito. Cero casts en el call site (el motor y el parser).
 * - Cross-validation corre incluso si la estructura es inválida (defensiva). Si
 *   falta la estructura mínima, no emite cross errors — el usuario primero
 *   arregla schema, después ve los cross. Esto es mejor UX que cortar early.
 * - `detectCycle` es iterativo (DFS con stack explícito). Antes era recursivo
 *   y podía reventar el stack con workflows grandes (>~5K nodos).
 */

import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import type {
  ConfidenceGatingConfig,
  ErrorCode,
  JSONSchema,
  WorkflowDefinition,
} from "./types.js";

// ============================================================
// JSON Schema (draft-07)
// ============================================================

const stateRefSchema = {
  type: "object",
  properties: {
    template: { type: "string", minLength: 1 },
    path: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
} as const;

const nodeInputSchema = {
  type: "object",
  required: ["from"],
  properties: {
    from: stateRefSchema,
    default: {},
  },
  additionalProperties: false,
} as const;

const nodeOutputSchema = {
  type: "object",
  required: ["to"],
  properties: {
    to: stateRefSchema,
  },
  additionalProperties: false,
} as const;

const retryConfigSchema = {
  type: "object",
  required: ["max"],
  properties: {
    max: { type: "integer", minimum: 0, maximum: 100 },
    backoff: { type: "string", enum: ["fixed", "exponential"] },
    initialDelayMs: { type: "integer", minimum: 0, maximum: 600000 },
    on: {
      type: "array",
      items: {
        type: "string",
        enum: [
          "RATE_LIMIT",
          "TIMEOUT",
          "NETWORK_ERROR",
          "INVALID_OUTPUT",
          "SCHEMA_VIOLATION",
          "CONTEXT_TOO_LONG",
          "MODEL_UNAVAILABLE",
          "INTERNAL_ERROR",
          "HITL_TIMEOUT",
          "HITL_DECLINED",
          "NON_IDEMPOTENT_RETRY_DISALLOWED",
          "ROUTER_NO_MATCH",
          "WORKFLOW_HAS_CYCLE",
          "TASK_ALREADY_RUNNING",
          "SCHEMA_VERSION_UNSUPPORTED",
        ],
      },
    },
  },
  additionalProperties: false,
} as const;

const nodeErrorActionSchema = {
  oneOf: [
    { type: "string", enum: ["fail", "continue"] },
    {
      type: "object",
      required: ["goto"],
      properties: { goto: { type: "string", minLength: 1 } },
      additionalProperties: false,
    },
  ],
} as const;

const confidenceGatingConfigSchema = {
  type: "object",
  required: ["highThreshold", "mediumThreshold", "onMedium", "onLow"],
  properties: {
    highThreshold: { type: "number", minimum: 0, maximum: 1 },
    mediumThreshold: { type: "number", minimum: 0, maximum: 1 },
    onMedium: { type: "string", enum: ["search_more", "continue", "ask_user"] },
    onLow: { type: "string", enum: ["ask_user", "fail"] },
  },
  additionalProperties: false,
} as const;

const baseNodeProperties = {
  id: { type: "string", pattern: "^[a-zA-Z0-9_-]+$", minLength: 1 },
  name: { type: "string" },
  description: { type: "string" },
  timeoutMs: { type: "integer", minimum: 0, maximum: 3600000 },
  retries: retryConfigSchema,
  idempotencyKey: { type: "string", minLength: 1 },
  retriable: { type: "boolean" },
  onError: nodeErrorActionSchema,
} as const;

const functionNodeSchema = {
  type: "object",
  required: ["type", "id", "functionRef", "input", "output"],
  properties: {
    ...baseNodeProperties,
    type: { const: "function" },
    functionRef: { type: "string", minLength: 1 },
    input: nodeInputSchema,
    output: nodeOutputSchema,
  },
  additionalProperties: false,
} as const;

const llmNodeSchema = {
  type: "object",
  required: ["type", "id", "model", "input", "output"],
  properties: {
    ...baseNodeProperties,
    type: { const: "llm" },
    model: {
      // 'liviano' o 'robusto' o cualquier string (nombre específico de modelo)
      type: "string",
      minLength: 1,
    },
    systemPrompt: { type: "string" },
    userPrompt: { type: "string" },
    skills: { type: "array", items: { type: "string", minLength: 1 } },
    tools: { type: "array", items: { type: "string", minLength: 1 } },
    input: nodeInputSchema,
    output: nodeOutputSchema,
    outputSchema: { type: "object" },
    confidenceGating: confidenceGatingConfigSchema,
  },
  additionalProperties: false,
} as const;

const hitlNodeSchema = {
  type: "object",
  required: ["type", "id", "approvers", "question", "output"],
  properties: {
    ...baseNodeProperties,
    type: { const: "hitl" },
    approvers: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    question: nodeInputSchema,
    context: nodeInputSchema,
    input: nodeInputSchema,
    output: nodeOutputSchema,
    approvalMode: { type: "string", enum: ["any", "all", "majority"] },
    outputSchema: { type: "object" },
    timeoutMs: { type: "integer", minimum: 0, maximum: 2592000000 }, // max 30 días
    onTimeout: { type: "string", enum: ["fail", "approve", "reject"] },
    allowDecline: { type: "boolean" },
    declineReasons: { type: "array", items: { type: "string", minLength: 1 } },
  },
  additionalProperties: false,
} as const;

const routerNodeSchema = {
  type: "object",
  required: ["type", "id", "decision", "routes"],
  properties: {
    ...baseNodeProperties,
    type: { const: "router" },
    decision: nodeInputSchema,
    routes: {
      type: "object",
      minProperties: 1,
      additionalProperties: { type: "string", minLength: 1 },
    },
    default: { type: "string", minLength: 1 },
    matchMode: { type: "string", enum: ["exact", "case-insensitive"] },
  },
  additionalProperties: false,
} as const;

const nodeSchema = {
  oneOf: [functionNodeSchema, llmNodeSchema, hitlNodeSchema, routerNodeSchema],
} as const;

const edgeSchema = {
  type: "object",
  required: ["from", "to"],
  properties: {
    from: { type: "string", minLength: 1 },
    to: { type: "string", minLength: 1 },
    condition: nodeInputSchema,
  },
  additionalProperties: false,
} as const;

const workflowConfigSchema = {
  type: "object",
  properties: {
    defaultRetries: { type: "integer", minimum: 0, maximum: 100 },
    defaultTimeoutMs: { type: "integer", minimum: 0, maximum: 3600000 },
    hitlDefaults: { type: "object" },
  },
  additionalProperties: false,
} as const;

const workflowDefinitionSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://worgena.local/schemas/workflow-definition.v1.json",
  type: "object",
  required: [
    "id",
    "name",
    "workflowVersion",
    "schemaVersion",
    "stateSchema",
    "nodes",
    "edges",
    "entryNode",
  ],
  properties: {
    // Workflow IDs son URL slugs (lowercase, no underscores). Ver types.ts para
    // el contraste con node IDs (que aceptan mayúsculas y underscores).
    id: { type: "string", pattern: "^[a-z0-9-]+$", minLength: 1 },
    name: { type: "string", minLength: 1 },
    description: { type: "string" },
    workflowVersion: {
      type: "string",
      pattern: "^\\d+\\.\\d+\\.\\d+$",
    },
    schemaVersion: { const: 1 },
    stateSchema: { type: "object" },
    nodes: { type: "array", minItems: 1, items: nodeSchema },
    edges: { type: "array", items: edgeSchema },
    entryNode: { type: "string", minLength: 1 },
    config: workflowConfigSchema,
  },
  additionalProperties: false,
} as const;

// ============================================================
// Compilador ajv (singleton)
// ============================================================

const ajv = new Ajv({
  allErrors: true,
  strict: false, // toleramos keywords extra en draft-07 vs 2020-12
  verbose: true,
});

const compiledWorkflowSchema: ValidateFunction<WorkflowDefinition> =
  ajv.compile<WorkflowDefinition>(workflowDefinitionSchema);

// ============================================================
// API pública
// ============================================================

/** El JSON Schema del top-level. Exportado para tests y debugging. */
export const workflowSchemaJson = workflowDefinitionSchema;

/**
 * Valida SOLO la estructura (JSON Schema). No hace cross-validation.
 * Para validación completa (estructura + integridad del grafo), usar `validateWorkflow`.
 */
export function validateWorkflowSchema(workflow: unknown): {
  readonly valid: boolean;
  readonly errors: readonly ErrorObject[] | null;
} {
  const valid = compiledWorkflowSchema(workflow);
  return {
    valid,
    errors: compiledWorkflowSchema.errors,
  };
}

export interface CrossValidationError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly nodeId?: string;
  /**
   * Camino al campo problemático en dotted notation (ej: "nodes[2].outputSchema.confidence").
   * Ausente para errores que no se asocian a un campo específico (ej: ciclo en el grafo).
   */
  readonly path?: string;
}

/**
 * Resultado de validación completa.
 *
 * Discriminated union: en el branch `valid: true` el campo `data` contiene el
 * workflow ya tipado (cero casts en el call site). En el branch `valid: false`
 * se reportan schema errors Y cross errors juntos — el usuario ve todos los
 * problemas en una sola pasada, no en cascada.
 */
export type ValidationResult<T> =
  | {
      readonly valid: true;
      readonly data: T;
      /** Siempre vacío en el branch válido (kept for symmetry with the failure branch). */
      readonly crossErrors: readonly CrossValidationError[];
    }
  | {
      readonly valid: false;
      /** Errores de estructura (JSON Schema). Null si la estructura es válida. */
      readonly schemaErrors: readonly ErrorObject[] | null;
      /** Errores de cross-validation. Vacío si no se pudo determinar (schema muy mal). */
      readonly crossErrors: readonly CrossValidationError[];
    };

/**
 * Validación completa: estructura (JSON Schema) + integridad del grafo + cross-validation.
 * Esta es la función que el motor llama al cargar un workflow.
 *
 * Cross-validation corre incluso si el schema falla. Si la estructura es tan
 * inválida que no podemos determinar nodos/edges/entry, no emitimos cross
 * errors — el usuario primero arregla schema y después ve los cross. Esto es
 * defensivo, no cascada: mejor feedback que cortar early.
 */
export function validateWorkflow(workflow: unknown): ValidationResult<WorkflowDefinition> {
  // 1. Estructura (JSON Schema)
  const schemaResult = validateWorkflowSchema(workflow);
  const schemaErrors = schemaResult.valid ? null : schemaResult.errors;

  // 2. Cross-validation (defensiva: corre aunque schema haya fallado)
  const crossErrors = crossValidate(workflow);

  if (!schemaResult.valid || crossErrors.length > 0) {
    return { valid: false, schemaErrors, crossErrors };
  }

  // En este punto, ajv garantizó la shape. El cast es seguro: el motor y el
  // parser consumen el resultado a través de este branch, donde `data` ya está
  // tipado. Si ajv cambiara su garantía, este cast sería el primer sitio en
  // romperse — y está marcado para revisión.
  return {
    valid: true,
    data: workflow as WorkflowDefinition,
    crossErrors: [],
  };
}

// ============================================================
// Cross-validation (defensiva)
// ============================================================

/**
 * Validación de integridad del grafo. Defensiva: si la estructura es inválida
 * (no hay nodes/edges/entryNode), retorna []. El usuario primero ve los schema
 * errors; cuando los arregle, los cross errors aparecerán.
 */
function crossValidate(workflow: unknown): readonly CrossValidationError[] {
  if (!isPlainObject(workflow)) return [];
  const w = workflow as Record<string, unknown>;

  if (!Array.isArray(w.nodes) || !Array.isArray(w.edges) || typeof w.entryNode !== "string") {
    return [];
  }
  // Después de este punto, podemos tratar w como WorkflowDefinition para los
  // chequeos de nodos individuales, pero seguimos siendo cuidadosos.
  const wf = w as unknown as WorkflowDefinition;

  const errors: CrossValidationError[] = [];

  // 2a. entryNode existe en nodes
  const nodeIds = new Set<string>();
  for (const n of wf.nodes) {
    if (isPlainObject(n) && typeof (n as { id?: unknown }).id === "string") {
      nodeIds.add((n as { id: string }).id);
    }
  }
  if (!nodeIds.has(wf.entryNode)) {
    errors.push({
      code: "INTERNAL_ERROR",
      message: `entryNode "${wf.entryNode}" no existe en la lista de nodos.`,
      path: "entryNode",
    });
  }

  // 2b. Cada edge.from y edge.to referencia un nodo existente
  for (let i = 0; i < wf.edges.length; i++) {
    const e = wf.edges[i];
    if (!isPlainObject(e)) continue;
    const from = (e as { from?: unknown }).from;
    const to = (e as { to?: unknown }).to;
    if (typeof from === "string" && !nodeIds.has(from)) {
      errors.push({
        code: "INTERNAL_ERROR",
        message: `edge[${i}].from "${from}" no existe en la lista de nodos.`,
        path: `edges[${i}].from`,
      });
    }
    if (typeof to === "string" && !nodeIds.has(to)) {
      errors.push({
        code: "INTERNAL_ERROR",
        message: `edge[${i}].to "${to}" no existe en la lista de nodos.`,
        path: `edges[${i}].to`,
      });
    }
  }

  // 2c. IDs de nodos únicos
  const seen = new Set<string>();
  for (let i = 0; i < wf.nodes.length; i++) {
    const n = wf.nodes[i];
    if (!isPlainObject(n)) continue;
    const id = (n as { id?: unknown }).id;
    if (typeof id !== "string") continue;
    if (seen.has(id)) {
      errors.push({
        code: "INTERNAL_ERROR",
        message: `nodos[${i}].id "${id}" está duplicado.`,
        path: `nodes[${i}].id`,
      });
    }
    seen.add(id);
  }

  // 2d. No ciclos (DAG) — iterativo
  const cycleError = detectCycle(wf);
  if (cycleError) {
    errors.push({
      code: "WORKFLOW_HAS_CYCLE",
      message: `El workflow tiene un ciclo: ${cycleError.join(" → ")}. Los workflows deben ser DAGs.`,
    });
  }

  // 2e. confidenceGating requiere outputSchema.confidence (number 0-1)
  for (let i = 0; i < wf.nodes.length; i++) {
    const n = wf.nodes[i];
    if (!isPlainObject(n)) continue;
    const nTyped = n as { type?: string; id?: string; confidenceGating?: unknown; outputSchema?: unknown };
    if (nTyped.type !== "llm" || !nTyped.confidenceGating) continue;

    const confidenceError = checkConfidenceGatingConsistency(
      nTyped.id ?? `nodes[${i}]`,
      nTyped.confidenceGating as ConfidenceGatingConfig,
      nTyped.outputSchema as JSONSchema | undefined,
      i,
    );
    if (confidenceError) errors.push(confidenceError);
  }

  return errors;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ============================================================
// Helpers privados
// ============================================================

/**
 * Detecta ciclos en el grafo. Retorna el camino del ciclo si lo encuentra,
 * null si no. Algoritmo: DFS iterativo con stack explícito (3 colores).
 *
 * Por qué iterativo: la versión recursiva podía reventar el stack de V8 con
 * workflows grandes (>~5K nodos). Con stack explícito el límite es memoria
 * disponible, no frames de V8.
 *
 * Estructura del frame: [nodeId, path-so-far, índice del próximo hijo].
 * Simulamos la pila de recursión sin pagar stack frames del lenguaje.
 */
function detectCycle(wf: WorkflowDefinition): readonly string[] | null {
  const adj = new Map<string, string[]>();
  for (const n of wf.nodes) adj.set(n.id, []);
  for (const e of wf.edges) {
    const list = adj.get(e.from);
    if (list) list.push(e.to);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const n of wf.nodes) color.set(n.id, WHITE);

  interface Frame {
    nodeId: string;
    path: readonly string[];
    nextChildIdx: number;
  }

  // Iteramos por todos los nodos para cubrir grafos con múltiples entry points.
  for (const start of wf.nodes) {
    if (color.get(start.id) !== WHITE) continue;

    color.set(start.id, GRAY);
    const stack: Frame[] = [
      { nodeId: start.id, path: [start.id], nextChildIdx: 0 },
    ];

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const children = adj.get(frame.nodeId) ?? [];

      if (frame.nextChildIdx >= children.length) {
        // Terminamos con este nodo.
        color.set(frame.nodeId, BLACK);
        stack.pop();
        continue;
      }

      const next = children[frame.nextChildIdx]!;
      frame.nextChildIdx++;

      const c = color.get(next);
      if (c === undefined) continue; // edge a nodo inexistente (otro check lo agarra)
      if (c === GRAY) {
        // Back edge → ciclo. Devolvemos el camino del ciclo.
        const cycleStart = frame.path.indexOf(next);
        return [...frame.path.slice(cycleStart), next];
      }
      if (c === WHITE) {
        color.set(next, GRAY);
        stack.push({
          nodeId: next,
          path: [...frame.path, next],
          nextChildIdx: 0,
        });
      }
      // c === BLACK: ya visitado, no hay ciclo por acá.
    }
  }
  return null;
}

/**
 * Valida que si un nodo LLM declara confidenceGating, su outputSchema tenga
 * `confidence: { type: "number", minimum: 0, maximum: 1 }`.
 *
 * Tipo del outputSchema directo: este check solo aplica a nodos LLM, donde
 * `outputSchema: JSONSchema | undefined`. Antes había un `infer` chain de 4
 * niveles que era un smell.
 */
function checkConfidenceGatingConsistency(
  nodeId: string,
  gating: ConfidenceGatingConfig,
  outputSchema: JSONSchema | undefined,
  nodeIndex: number,
): CrossValidationError | null {
  const basePath = `nodes[${nodeIndex}]`;

  if (!outputSchema) {
    return {
      code: "INVALID_OUTPUT",
      message: `nodo "${nodeId}" declara confidenceGating pero no tiene outputSchema. Se requiere outputSchema con confidence: number 0-1.`,
      nodeId,
      path: `${basePath}.outputSchema`,
    };
  }

  const props = (outputSchema as { properties?: Record<string, unknown> })
    .properties;
  const confidence = props?.confidence as
    | { type?: string; minimum?: number; maximum?: number }
    | undefined;

  if (!confidence) {
    return {
      code: "INVALID_OUTPUT",
      message: `nodo "${nodeId}" declara confidenceGating pero outputSchema no tiene propiedad "confidence".`,
      nodeId,
      path: `${basePath}.outputSchema.properties.confidence`,
    };
  }

  if (confidence.type !== "number") {
    return {
      code: "INVALID_OUTPUT",
      message: `nodo "${nodeId}" declara confidenceGating pero outputSchema.properties.confidence.type debe ser "number", no "${confidence.type}".`,
      nodeId,
      path: `${basePath}.outputSchema.properties.confidence.type`,
    };
  }

  if (confidence.minimum !== undefined && confidence.minimum < 0) {
    return {
      code: "INVALID_OUTPUT",
      message: `nodo "${nodeId}" outputSchema.properties.confidence.minimum debe ser >= 0.`,
      nodeId,
      path: `${basePath}.outputSchema.properties.confidence.minimum`,
    };
  }

  if (confidence.maximum !== undefined && confidence.maximum > 1) {
    return {
      code: "INVALID_OUTPUT",
      message: `nodo "${nodeId}" outputSchema.properties.confidence.maximum debe ser <= 1.`,
      nodeId,
      path: `${basePath}.outputSchema.properties.confidence.maximum`,
    };
  }

  // Sanity check de los thresholds del gating
  if (gating.mediumThreshold >= gating.highThreshold) {
    return {
      code: "INVALID_OUTPUT",
      message: `nodo "${nodeId}" confidenceGating.mediumThreshold (${gating.mediumThreshold}) debe ser < highThreshold (${gating.highThreshold}).`,
      nodeId,
      path: `${basePath}.confidenceGating.mediumThreshold`,
    };
  }

  return null;
}
