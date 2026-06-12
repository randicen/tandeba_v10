/**
 * Worgena Workflow DSL — Parser unificado JSON + YAML.
 *
 * Fuente de verdad: AGENT_ROADMAP.md §5.4 y §6.1 (D2a.1b).
 * Spec version: 0.2
 *
 * Responsabilidades:
 * 1. Detectar formato (auto) o aceptar formato explícito (json/yaml).
 * 2. Parsear el texto a un valor JS.
 * 3. Correr `validateWorkflow` (estructura + cross-validation).
 * 4. Devolver un `ParseResult` discriminado: o workflow listo, o lista de errores
 *    con ubicación (line/column/path) para que la UI muestre diagnósticos útiles.
 *
 * **NO llama a `loadWorkflow` (D2a.2.3)**: la migración de schema se aplica
 * LAZY al ejecutar la task, no al parsear. Esto preserva la coherencia del
 * audit legal (Worgena): el `workflowVersion` declarado en el workflow
 * persistido se mantiene hasta la ejecución. La task guarda
 * `migratedWorkflow` y `appliedMigrations` para trazabilidad. Ver
 * `AGENT_D2A_2_3_CORE_PRIMITIVES_SPEC.md` §7.4.
 *
 * Filosofía:
 * - NO throw en errores de validación. Esos son `ParseResult.ok = false`.
 * - SÍ throw en errores de I/O (parseWorkflowFile): archivo no existe, permisos.
 *   Esos son errores del programador, no del workflow.
 * - Auto-detección: primer char no-espacio (post-BOM) = `{` → JSON, sino → YAML.
 *   Los workflows siempre son objetos, así que es seguro.
 *
 * Decisiones post-auditoría (D2a.1+D2a.1b):
 * - Strip BOM al inicio del source (común en archivos guardados por VSCode en
 *   Windows). Antes dependíamos de que el lib YAML lo soportara.
 * - Paths de error normalizados a dotted notation (parseJsonPointer). AJV emite
 *   JSON Pointer (`/nodes/2/id`); cross-validation ya emite dotted. La UI ve
 *   un solo formato consistente.
 * - Sin casts: el resultado tipado viene de `validation.data` (discriminated
 *   union introducido en D2a.1).
 */

import * as YAML from "yaml";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { ErrorObject } from "ajv";
import {
  validateWorkflow,
  type CrossValidationError,
} from "./schema.js";
import type { WorkflowDefinition } from "./types.js";

// ============================================================
// Tipos públicos
// ============================================================

/** Códigos de error del parser. Diferencian la fase donde ocurrió el problema. */
export type ParseErrorCode =
  | "SYNTAX_ERROR" // JSON/YAML malformado
  | "SCHEMA_INVALID" // estructura no cumple JSON Schema
  | "CROSS_VALIDATION_FAILED"; // grafo cíclico, entryNode faltante, etc.

export interface ParseError {
  readonly code: ParseErrorCode;
  readonly message: string;
  /** Línea 1-indexed. Ausente si el parser no puede determinarla. */
  readonly line?: number;
  /** Columna 1-indexed. Ausente si el parser no puede determinarla. */
  readonly column?: number;
  /**
   * Camino al campo problemático en dotted notation (ej: "nodes[2].outputSchema.confidence").
   * Ausente para errores que no se asocian a un campo específico (ej: ciclo en el grafo).
   * JSON Pointer de AJV se traduce a dotted acá para uniformidad con los cross errors.
   */
  readonly path?: string;
  /** Sugerencia accionable para el usuario (opcional). */
  readonly hint?: string;
}

export type Format = "json" | "yaml" | "auto";

export type ParseResult =
  | {
      readonly ok: true;
      readonly workflow: WorkflowDefinition;
      readonly format: "json" | "yaml";
    }
  | {
      readonly ok: false;
      readonly errors: readonly ParseError[];
      readonly format: "json" | "yaml";
    };

// ============================================================
// Constantes
// ============================================================

/** BOM UTF-8 (U+FEFF). Común al inicio de archivos guardados por editores en Windows. */
const BOM = "\uFEFF";

/** Strip BOM del inicio del texto, si está presente. */
function stripBom(source: string): string {
  return source.startsWith(BOM) ? source.slice(1) : source;
}

// ============================================================
// Detección de formato
// ============================================================

/**
 * Auto-detecta el formato según el primer carácter no-espacio.
 * `{` → JSON, todo lo demás → YAML.
 * Los workflows son siempre objetos top-level, así que es seguro.
 *
 * Strip BOM antes de mirar: editores en Windows suelen guardarlos con BOM.
 */
function detectFormat(source: string): "json" | "yaml" {
  const trimmed = stripBom(source).trimStart();
  if (trimmed.startsWith("{")) return "json";
  return "yaml";
}

/** Infiere formato desde la extensión del archivo. */
function formatFromPath(path: string): Format {
  const ext = extname(path).toLowerCase();
  if (ext === ".json") return "json";
  if (ext === ".yaml" || ext === ".yml") return "yaml";
  return "auto";
}

// ============================================================
// API pública
// ============================================================

/**
 * Parsea un string que contiene un workflow en JSON o YAML.
 *
 * - Si `format` es "auto" (default), detecta por el primer char no-espacio.
 * - Si hay error de sintaxis o validación, retorna `{ ok: false, errors: [...] }`.
 * - NO throw. Las excepciones son bugs del parser.
 */
export function parseWorkflow(
  source: string,
  format: Format = "auto",
): ParseResult {
  const actualFormat = format === "auto" ? detectFormat(source) : format;

  // 1. Parseo del texto
  const parseResult = parseSource(source, actualFormat);
  if (!parseResult.ok) {
    return { ok: false, format: actualFormat, errors: parseResult.errors };
  }
  const parsed = parseResult.value;

  // 2. Validación (estructura + cross-validation)
  const validation = validateWorkflow(parsed);
  if (!validation.valid) {
    const errors = collectValidationErrors(validation);
    return { ok: false, format: actualFormat, errors };
  }

  // Cero casts: validation.data ya viene tipado como WorkflowDefinition.
  return {
    ok: true,
    format: actualFormat,
    workflow: validation.data,
  };
}

/**
 * Lee un archivo del disco y lo parsea. El formato se infiere de la extensión
 * (`.json`, `.yaml`, `.yml`). Si la extensión no es reconocida, usa auto-detect.
 *
 * THROWS: si el archivo no existe, no hay permisos, o el read falla por I/O.
 * Esos son errores del programador, no del workflow.
 */
export async function parseWorkflowFile(path: string): Promise<ParseResult> {
  const content = await readFile(path, "utf-8");
  return parseWorkflow(content, formatFromPath(path));
}

// ============================================================
// Internos: parseo del texto
// ============================================================

type ParseSourceResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly errors: readonly ParseError[] };

function parseSource(source: string, format: "json" | "yaml"): ParseSourceResult {
  if (format === "json") return parseJson(source);
  return parseYaml(source);
}

function parseJson(source: string): ParseSourceResult {
  // Strip BOM antes de parsear: JSON.parse NO maneja BOM (a diferencia del
  // lib YAML). Es la misma lógica que detectFormat usa para elegir formato.
  const hadBom = source.startsWith(BOM);
  const cleaned = stripBom(source);
  try {
    const value = JSON.parse(cleaned);
    return { ok: true, value };
  } catch (e) {
    const err = e as SyntaxError;
    // Calculamos posición sobre el texto limpio, después ajustamos si había
    // BOM para que el editor del usuario (que ve el BOM) pueda highlight correcto.
    const { line, column } = extractJsonPosition(cleaned, err);
    // BOM siempre está en línea 1 (si está). Sumamos 1 a la columna para
    // reflejar el offset del BOM en el archivo original.
    const adjusted = hadBom ? { line, column: column + 1 } : { line, column };
    return {
      ok: false,
      errors: [
        {
          code: "SYNTAX_ERROR",
          message: `JSON inválido: ${err.message}`,
          line: adjusted.line,
          column: adjusted.column,
          hint: "Revisá comas, comillas y llaves balanceadas.",
        },
      ],
    };
  }
}

function parseYaml(source: string): ParseSourceResult {
  const doc = YAML.parseDocument(source, {
    // Silencia el console.warn que yaml emite por default en warnings.
    logLevel: "silent",
    // YAML 1.2 (default) y estricto en tipos. Evita surprises tipo "yes" → true.
    version: "1.2",
    strict: true,
  });

  if (doc.errors.length > 0) {
    return {
      ok: false,
      errors: doc.errors.map((e) => ({
        code: "SYNTAX_ERROR" as const,
        message: `YAML inválido: ${e.message}`,
        // yaml usa 0-indexed; lo paso a 1-indexed para uniformidad con JSON.
        line: e.linePos?.[0]?.line !== undefined ? e.linePos[0].line + 1 : undefined,
        column: e.linePos?.[0]?.col !== undefined ? e.linePos[0].col + 1 : undefined,
        hint: "Revisá la indentación (espacios, no tabs) y los dos puntos.",
      })),
    };
  }

  return { ok: true, value: doc.toJS() };
}

// ============================================================
// Internos: errores de validación → ParseError
// ============================================================

function collectValidationErrors(
  validation: ReturnType<typeof validateWorkflow>,
): readonly ParseError[] {
  if (validation.valid) return [];

  const errors: ParseError[] = [];

  if (validation.schemaErrors) {
    for (const e of validation.schemaErrors) {
      errors.push(humanizeAjvError(e));
    }
  }
  for (const e of validation.crossErrors) {
    errors.push(humanizeCrossError(e));
  }
  return errors;
}

function humanizeAjvError(e: ErrorObject): ParseError {
  // AJV emite JSON Pointer (`/nodes/2/id`). Lo normalizamos a dotted (`nodes[2].id`)
  // para uniformidad con los cross errors.
  const path = e.instancePath ? parseJsonPointer(e.instancePath) : undefined;
  const base = { code: "SCHEMA_INVALID" as const, path };

  // Cada keyword tiene un mensaje custom más útil que el default de ajv.
  switch (e.keyword) {
    case "required": {
      const prop = (e.params as { missingProperty?: string }).missingProperty;
      return {
        ...base,
        message: `Falta la propiedad requerida "${prop}".`,
        hint: `Agregá "${prop}" al objeto${path ? ` en ${path}` : ""}.`,
      };
    }
    case "additionalProperties": {
      const prop = (e.params as { additionalProperty?: string }).additionalProperty;
      return {
        ...base,
        message: `Propiedad no permitida: "${prop}".`,
        hint: `El schema no declara "${prop}". Si es intencional, agregalo al schema. Si no, quitalo.`,
      };
    }
    case "type": {
      const expected = (e.params as { type?: string }).type;
      return {
        ...base,
        message: `Tipo incorrecto: se esperaba ${expected}.`,
      };
    }
    case "enum": {
      const allowed = (e.params as { allowedValues?: readonly unknown[] }).allowedValues;
      return {
        ...base,
        message: `Valor fuera del enum. Valores permitidos: ${JSON.stringify(allowed)}.`,
      };
    }
    case "const": {
      const allowed = (e.params as { allowedValue?: unknown }).allowedValue;
      return {
        ...base,
        message: `Valor debe ser exactamente ${JSON.stringify(allowed)}.`,
      };
    }
    case "pattern": {
      const pattern = (e.params as { pattern?: string }).pattern;
      return {
        ...base,
        message: `No cumple el patrón regex: ${pattern}.`,
      };
    }
    case "minLength": {
      const limit = (e.params as { limit?: number }).limit;
      return {
        ...base,
        message: `Longitud mínima: ${limit} caracteres.`,
      };
    }
    case "minimum":
    case "maximum": {
      const limit = (e.params as { limit?: number }).limit;
      const cmp = e.keyword === "minimum" ? `>= ${limit}` : `<= ${limit}`;
      return {
        ...base,
        message: `Valor fuera de rango: debe ser ${cmp}.`,
      };
    }
    case "oneOf": {
      return {
        ...base,
        message: `El nodo no coincide con ninguno de los tipos válidos (function/llm/hitl/router).`,
        hint: "Verificá que el campo 'type' esté bien escrito y que tenga las propiedades requeridas para ese tipo.",
      };
    }
    default:
      return {
        ...base,
        message: e.message ?? "Error de validación de schema.",
      };
  }
}

function humanizeCrossError(e: CrossValidationError): ParseError {
  return {
    code: "CROSS_VALIDATION_FAILED",
    message: e.message,
    path: e.path,
  };
}

// ============================================================
// Helpers: JSON Pointer → dotted notation
// ============================================================

/**
 * Convierte un JSON Pointer RFC 6901 (`/nodes/2/id`) a dotted notation
 * (`nodes[2].id`). AJV emite JSON Pointer; los cross errors usan dotted.
 * El parser normaliza ambos al mismo formato para que la UI no tenga que
 * parsear dos cosas distintas.
 *
 * Edge cases:
 * - Pointer vacío `""` → `""` (raíz, sin path)
 * - Segment con caracteres especiales: se mantiene literal (no escapamos `~0`/`~1`
 *   porque AJV no los emite para nombres de campo normales).
 * - Segment numérico → notación de índice `nodes[2]`.
 * - Segment no-numérico → acceso por punto `nodes.id` o primer segmento sin prefijo.
 */
export function parseJsonPointer(pointer: string): string {
  if (!pointer || pointer === "/") return "";
  // Quitar el "/" inicial y splittear.
  const segments = pointer.slice(1).split("/");
  let result = "";
  for (const raw of segments) {
    const seg = raw; // AJV no usa escapes ~0/~1 para keys normales
    if (/^\d+$/.test(seg)) {
      // Índice numérico → notación [n]
      result += `[${seg}]`;
    } else if (result === "") {
      // Primer segmento no-numérico → sin prefijo
      result = seg;
    } else {
      // Segmento siguiente → punto
      result += `.${seg}`;
    }
  }
  return result;
}

// ============================================================
// Helpers: posición de error JSON
// ============================================================

/**
 * Extrae line/column de un error de `JSON.parse`.
 * V8 moderno emite "at line X column Y"; versiones viejas emitían "at position N".
 * Este helper maneja ambos formatos.
 */
function extractJsonPosition(
  source: string,
  err: SyntaxError,
): { line: number; column: number } {
  // Formato moderno: "Unexpected token ... at line 3 column 5"
  const lineColMatch = err.message.match(/at line (\d+) column (\d+)/);
  if (lineColMatch) {
    return {
      line: Number(lineColMatch[1]),
      column: Number(lineColMatch[2]),
    };
  }

  // Formato viejo: "Unexpected token ... in JSON at position 42"
  const posMatch = err.message.match(/at position (\d+)/);
  if (posMatch) {
    return offsetToLineCol(source, Number(posMatch[1]));
  }

  // Sin info de posición
  return { line: 1, column: 1 };
}

/** Convierte un offset de caracteres a {line, column} 1-indexed. */
function offsetToLineCol(
  source: string,
  offset: number,
): { line: number; column: number } {
  let line = 1;
  let col = 1;
  const max = Math.min(offset, source.length);
  for (let i = 0; i < max; i++) {
    if (source[i] === "\n") {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, column: col };
}
