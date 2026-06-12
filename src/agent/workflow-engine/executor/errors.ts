/**
 * Worgena Workflow Engine — errores del executor.
 *
 * El executor tiene dos clases de errores:
 * 1. Errores de runtime durante la ejecución de un nodo → se traducen a
 *    NodeResult.error con un ErrorCode del catálogo del DSL.
 * 2. Errores del propio executor (bugs, configuración inválida) → se tiran
 *    como ExecutorError. Estos son bugs del programador, no del workflow.
 *
 * Filosofía: los errores del WORKFLOW van a NodeResult, no se tiran. Los
 * errores del MOTOR se tiran. El caller decide cómo manejar cada uno.
 */

import type { ErrorCode } from "../dsl/types.js";

/** Errores del propio executor (bugs o mal uso). NO se atrapan, se tiran. */
export class ExecutorError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "TASK_NOT_FOUND"
      | "TASK_ALREADY_RUNNING"
      | "INVALID_TASK_STATE"
      | "NODE_NOT_FOUND"
      | "NO_NEXT_NODE"
      | "FUNCTION_NOT_REGISTERED"
      | "WORKFLOW_NOT_FOUND"
      | "SCHEMA_VIOLATION"
      | "SCHEMA_VERSION_UNSUPPORTED"
      | "INTERNAL_BUG",
    public readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ExecutorError";
  }
}

/**
 * Error de runtime de un nodo. Se construye en el node-runner y se devuelve
 * como parte de NodeExecutionFailure. NO se tira.
 */
export interface NodeRuntimeError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retriable: boolean;
  readonly stack?: string;
}

/** Helper para construir NodeRuntimeError desde cualquier error. */
export function toNodeRuntimeError(e: unknown, fallbackCode: ErrorCode = "INTERNAL_ERROR"): NodeRuntimeError {
  if (e instanceof Error) {
    return {
      code: fallbackCode,
      message: e.message,
      retriable: false,
      stack: e.stack,
    };
  }
  return {
    code: fallbackCode,
    message: String(e),
    retriable: false,
  };
}

/**
 * Mapea un error de catálogo a un flag retriable.
 * Reglas (de `AGENT_ROADMAP.md` §6.1 — primitivas del motor):
 * - RATE_LIMIT, TIMEOUT, NETWORK_ERROR, MODEL_UNAVAILABLE: retriable.
 * - Resto: no retriable por default.
 *
 * Si el nodo declara `retries.on`, ese filtro se aplica después de este mapeo.
 */
export function isRetriableByDefault(code: ErrorCode): boolean {
  switch (code) {
    case "RATE_LIMIT":
    case "TIMEOUT":
    case "NETWORK_ERROR":
    case "MODEL_UNAVAILABLE":
      return true;
    default:
      return false;
  }
}
