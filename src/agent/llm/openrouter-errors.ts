/**
 * Worgena — Errores del cliente OpenRouter (D2b.2).
 *
 * Fuente de verdad: `AGENT_D2B_2_SPEC.md` §3.2, §3.12, §3.14, §3.15.
 *
 * Tres tipos de error:
 *
 * - `MissingOpenRouterKeyError`: tirado al construir el cliente si la
 *   `OPENROUTER_API_KEY` no está disponible. NO se tira en cada call.
 *
 * - `InvalidResponseError`: tirado cuando la response de OpenRouter es
 *   200 pero está malformada (JSON inválido, `choices` vacío). Se mapea
 *   a `INTERNAL_ERROR` en el catálogo del motor.
 *
 * - `OpenRouterError`: el "resto" de los errores HTTP / de red. Tiene
 *   `httpStatus` y `code` (código del catálogo del motor) ya mapeados.
 *   Esto le permite al `node-runner` consumir `error.code` directamente
 *   en vez de hacer substring matching (ver `classifyLLMError` en
 *   `node-runner.ts:393`).
 *
 * Decisión clave (§3.2):
 * - 401 → INTERNAL_ERROR (la key es nuestra responsabilidad).
 * - 402 → MODEL_UNAVAILABLE (sin crédito, no tiene sentido retry).
 * - 408 → TIMEOUT.
 * - 422 → INVALID_OUTPUT.
 * - 429 → RATE_LIMIT.
 * - 5xx → MODEL_UNAVAILABLE (transitorio del lado del proveedor).
 * - Network error → NETWORK_ERROR.
 * - AbortError → INTERNAL_ERROR (cancelación cooperativa, no es fault del workflow).
 *
 * Regla de oro: la API key **nunca** se incluye en el mensaje de error.
 * Si el response incluye la key (improbable, pero defensa), el cliente
 * la filtra antes de propagar el error.
 */

import type { ErrorCode } from "../workflow-engine/dsl/types.js";

// ============================================================
// MissingOpenRouterKeyError
// ============================================================

/**
 * Error tirado al construir `OpenRouterClient` sin una `apiKey` válida.
 *
 * El cliente exige la key en construcción (no la lee lazy del env) para
 * que un deploy mal configurado falle rápido al boot, no en el primer
 * call del workflow. Esto es lo que la regla de "fail loud" del proyecto
 * (AGENTS.md §5) pide: si la config está mal, el operador se entera de
 * inmediato, no cuando un cliente ejecuta un workflow.
 */
export class MissingOpenRouterKeyError extends Error {
  public readonly code: "MISSING_API_KEY" = "MISSING_API_KEY" as const;

  constructor(
    message: string = "OPENROUTER_API_KEY no está configurada. " +
      "Pasala al constructor de OpenRouterClient o seteala en process.env antes de bootear.",
  ) {
    super(message);
    this.name = "MissingOpenRouterKeyError";
  }
}

// ============================================================
// InvalidResponseError
// ============================================================

/**
 * Error tirado cuando la response de OpenRouter es 200 pero está malformada
 * (JSON no parseable, `choices` vacío, falta `usage`, etc.).
 *
 * Estos casos son raros pero posibles (bug de OpenRouter, drift de schema,
 * response parcial). Se mapean a `INTERNAL_ERROR` (no retriable): si el
 * servidor nos devolvió basura, retry no ayuda.
 */
export class InvalidResponseError extends Error {
  public readonly code: "INVALID_RESPONSE" = "INVALID_RESPONSE" as const;
  /** Código del catálogo del motor al que se mapea este error. */
  public readonly motorCode: ErrorCode = "INTERNAL_ERROR";

  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "InvalidResponseError";
  }
}

// ============================================================
// OpenRouterError (genérico con status + código del motor)
// ============================================================

/**
 * Error HTTP / de red de OpenRouter. Tiene el `httpStatus` original
 * y el `code` ya mapeado al catálogo del motor (`ErrorCode`).
 *
 * Esto le permite al `node-runner` consumir `error.code` directamente
 * en lugar de hacer substring matching sobre el mensaje. Es además
 * forward-compat con el `classifyLLMError` actual (D2a.2.2): si ese
 * matcher recibe un `OpenRouterError`, puede usar `error.code` directo
 * y solo caer al substring fallback para errores legacy.
 */
export class OpenRouterError extends Error {
  public readonly name = "OpenRouterError";

  /**
   * Código del catálogo del motor al que se mapea este error HTTP.
   * Consumible directamente por el node-runner y el `isRetriableByDefault`.
   */
  public readonly code: ErrorCode;

  /** Status HTTP original (0 si fue error de red antes de tener response). */
  public readonly httpStatus: number;

  /** Si el error es retriable según el catálogo del motor. */
  public readonly retriable: boolean;

  /** Body crudo de la response (si lo hay) para audit. NO contiene la key. */
  public readonly responseBody?: unknown;

  constructor(params: {
    message: string;
    httpStatus: number;
    code: ErrorCode;
    retriable: boolean;
    responseBody?: unknown;
  }) {
    super(params.message);
    this.httpStatus = params.httpStatus;
    this.code = params.code;
    this.retriable = params.retriable;
    this.responseBody = params.responseBody;
  }
}

// ============================================================
// Mapeo HTTP → código del motor (función pura, reutilizable)
// ============================================================

/**
 * Mapea un status HTTP de OpenRouter al `ErrorCode` del catálogo del motor.
 *
 * La función es **pura** y testeable independientemente del cliente. El
 * cliente la usa para construir un `OpenRouterError`; los tests la usan
 * directo para verificar la tabla §3.2.
 *
 * Tabla de mapeo (ver `AGENT_D2B_2_SPEC.md` §3.2):
 * - 400 → INVALID_OUTPUT (response_format mal armado) o INTERNAL_ERROR
 *          según el body (lo decide el cliente mirando el body).
 * - 401 → INTERNAL_ERROR (key nuestra, no del workflow).
 * - 402 → MODEL_UNAVAILABLE (sin crédito, no retriable).
 * - 408 → TIMEOUT.
 * - 422 → INVALID_OUTPUT (modelo devolvió output semánticamente inválido).
 * - 429 → RATE_LIMIT.
 * - 5xx → MODEL_UNAVAILABLE (transitorio, retriable).
 * - otros → INTERNAL_ERROR.
 */
export function mapHttpStatusToMotorCode(
  httpStatus: number,
): { code: ErrorCode; retriable: boolean } {
  switch (httpStatus) {
    case 401:
      return { code: "INTERNAL_ERROR", retriable: false };
    case 402:
      return { code: "MODEL_UNAVAILABLE", retriable: false };
    case 408:
      return { code: "TIMEOUT", retriable: true };
    case 422:
      return { code: "INVALID_OUTPUT", retriable: false };
    case 429:
      return { code: "RATE_LIMIT", retriable: true };
    case 500:
    case 502:
    case 503:
    case 504:
      return { code: "MODEL_UNAVAILABLE", retriable: true };
    case 400:
      // Decidido por el cliente según el body; default conservador.
      return { code: "INVALID_OUTPUT", retriable: false };
    default:
      return { code: "INTERNAL_ERROR", retriable: false };
  }
}
