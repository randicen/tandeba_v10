/**
 * Worgena Workflow Engine — state helpers.
 *
 * Maneja las tres operaciones sobre el state del workflow:
 * 1. `getFromState(state, ref)`: resuelve un StateRef contra el state.
 * 2. `setInState(state, ref, value)`: escribe un valor en un path del state.
 * 3. `interpolate(template, state)`: reemplaza {{state.X}} en un string.
 *
 * El state es un `Record<string, unknown>` plano (un objeto JSON-like).
 * Los paths son dot-notation: "foo.bar.baz".
 *
 * Casos edge:
 * - Path que no existe → undefined (no tira).
 * - Write a un path cuyo padre no es objeto → crea el objeto en el camino.
 * - Template con state paths inexistentes → reemplaza con string vacío.
 */

import type { StateRef } from "../dsl/types.js";
import type { JSONSchema } from "../dsl/types.js";
import Ajv from "ajv";

// ============================================================
// Get / Set por path
// ============================================================

/** Lee un valor del state por dot-notation path. Retorna undefined si no existe. */
export function getByPath(state: unknown, path: string): unknown {
  if (path === "" || path === undefined) return state;
  const parts = path.split(".");
  let current: unknown = state;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Escribe un valor en un path del state. Crea objetos intermedios si hace falta. */
export function setByPath(
  state: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  if (path === "" || path === undefined) {
    // Path vacío = reemplazar el state completo. Caller responsibility.
    throw new Error("setByPath con path vacío no soportado; usar output directo al state");
  }
  const parts = path.split(".");
  let current: Record<string, unknown> = state;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const next = current[key];
    if (next == null || typeof next !== "object" || Array.isArray(next)) {
      // Crear objeto intermedio.
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

// ============================================================
// StateRef resolution
// ============================================================

/**
 * Resuelve un StateRef a un valor del state.
 *
 * Prioridad:
 * 1. `template`: si es un string con {{state.X}}, interpola. Si no tiene
 *    interpolación, devuelve el template literal.
 * 2. `path`: lee por dot-notation.
 * 3. Si ninguno está: undefined (caller puede usar default).
 */
export function resolveStateRef(
  state: unknown,
  ref: StateRef,
  defaultValue?: unknown,
): unknown {
  if (ref.template !== undefined) {
    return interpolate(ref.template, state);
  }
  if (ref.path !== undefined) {
    const value = getByPath(state, ref.path);
    return value === undefined ? defaultValue : value;
  }
  return defaultValue;
}

// ============================================================
// Template interpolation
// ============================================================

/**
 * Reemplaza {{state.foo.bar}} en un string con el valor del state.
 * Si el path no existe, reemplaza con string vacío.
 *
 * Soporta múltiples interpolaciones en el mismo string.
 * No escapa nada (es para prompts, no para SQL).
 */
export function interpolate(template: string, state: unknown): string {
  if (typeof template !== "string") return template;
  return template.replace(/\{\{state\.([^}]+)\}\}/g, (_, path: string) => {
    const value = getByPath(state, path);
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  });
}

// ============================================================
// Edge condition evaluation
// ============================================================

import type { NodeInput } from "../dsl/types.js";

/**
 * Evalúa la condición de un edge. El valor resuelto se interpreta como
 * boolean: truthy = tomar el edge, falsy = no tomar.
 *
 * El param es un NodeInput (con `from: StateRef` y `default?`), igual que el
 * input de un nodo. Si es undefined, el edge es incondicional.
 */
export function evaluateEdgeCondition(
  state: unknown,
  condition: NodeInput | undefined,
): boolean {
  if (condition === undefined) return true; // edge incondicional

  const value = resolveStateRef(state, condition.from, condition.default);
  return Boolean(value);
}

// ============================================================
// Validación del state contra stateSchema (D2a.2.3)
// ============================================================

/**
 * Resultado de validar un state contra un stateSchema.
 *
 * Decisión de shape: usamos un objeto plano (no discriminated union) para
 * evitar el patrón `if (!result.ok) result.error` que es ruidoso en el call
 * site y requiere type narrowing. Con el objeto plano, `error` es `""` cuando
 * `ok: true` y los callers chequean `result.ok` antes de leer `result.error`.
 */
export interface StateValidationResult {
  readonly ok: boolean;
  readonly error: string;
}

/**
 * Valida un state contra un `stateSchema` (JSON Schema).
 *
 * Se usa en dos lugares del motor (D2a.2.3):
 * 1. En `startTask(workflow, input)`: valida el `input` antes de crear la task.
 * 2. Después de cada output de nodo: valida el state actualizado.
 *
 * **Acoplamiento con `ajv`**: el motor usa `ajv` (draft-07). El comportamiento
 * es específico a `ajv`. No es portable a otros validadores sin cambio
 * explícito. Si en el futuro se cambia de validador, este helper se actualiza.
 *
 * **Schema "parcial" durante la ejecución**: el `stateSchema` describe el
 * state FINAL, no el state intermedio. JSON Schema draft-07: si un campo
 * no está en `required`, puede faltar. Si está en `required`, debe existir
 * al final del nodo. Los tipos se validan siempre que el campo exista.
 *
 * **Edge cases documentados en `AGENT_D2A_2_3_CORE_PRIMITIVES_SPEC.md` §4.5**:
 * - `null` vs tipo declarado (JSON Schema estándar)
 * - Template fallido en `output.to` (se manifiesta como SCHEMA_VIOLATION)
 * - State vacío `{}` (válido solo si todos los campos son opcionales)
 */
export function validateStateAgainstSchema(
  state: unknown,
  schema: JSONSchema,
): StateValidationResult {
  // Compilamos el schema por llamada. Workflows típicos tienen 1-3 schemas
  // totales, no es un cuello de botella. Si se vuelve hot path en D3+, cachear.
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  const valid = validate(state);
  if (valid) return { ok: true, error: "" };
  const errs = (validate.errors ?? [])
    .map((e: { instancePath?: string; message?: string }) => `${e.instancePath ?? "/"} ${e.message ?? ""}`)
    .join("; ");
  return { ok: false, error: errs };
}
