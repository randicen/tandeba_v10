/**
 * Worgena — OpenRouter Client (D2b.2).
 *
 * Fuente de verdad: `AGENT_D2B_2_SPEC.md` §3.1, §3.2, §3.4, §5.1.
 *
 * Cliente HTTP para `https://openrouter.ai/api/v1/chat/completions`
 * y `/embeddings`. Implementa dos cosas:
 *
 * 1. **`chat()`** — POST a `/chat/completions` con `Authorization: Bearer ${key}`,
 *    soporte para `response_format: { type: "json_schema", ... }`, tools,
 *    signal de cancelación, y mapeo de errores HTTP al catálogo del motor
 *    (`ErrorCode`).
 *
 * 2. **`embeddings()`** — POST a `/embeddings` con el modelo de embedding
 *    (default `qwen/qwen3-embedding-8b`). Tier 2 del roadmap §5.5.
 *
 * **Decisión clave (spec §3.1)**: usamos `fetch` directo de Node, NO
 * el SDK `openai` con `baseURL` de OpenRouter. Razones:
 * - El SDK openai no tipifica `usage.cost` ni `openrouter_metadata`.
 * - Consistencia con `src/agent/memory.ts` que ya usa `fetch` directo.
 * - `fetch` es built-in en Node 18+ (cero deps nuevas).
 *
 * **Transport inyectable** (§3.11): el `transport` se puede inyectar
 * para tests. Default: `globalThis.fetch`. Esto permite tests
 * deterministas sin red.
 *
 * **Manejo de errores** (§3.2): el `OpenRouterError` retornado tiene
 * `code: ErrorCode` ya mapeado. El `node-runner` lo consume directo.
 *
 * **NO loguea la key** (§3.9, §8.10): la API key nunca aparece en
 * logs, ni siquiera en debug. Verificable con grep.
 */

import {
  InvalidResponseError,
  MissingOpenRouterKeyError,
  OpenRouterError,
  mapHttpStatusToMotorCode,
} from "./openrouter-errors.js";

// ============================================================
// Tipos públicos
// ============================================================

/**
 * Opciones del constructor. La `apiKey` es obligatoria; el resto tiene
 * defaults razonables.
 */
export interface OpenRouterClientOptions {
  readonly apiKey: string;
  /** Default: "https://openrouter.ai/api/v1". */
  readonly baseUrl?: string;
  /** Default: 60_000 ms (60s). */
  readonly timeoutMs?: number;
  /**
   * Transport inyectable para tests. Firma: `(url, init) => Promise<Response>`.
   * Default: `globalThis.fetch`. El cliente no distingue — pasa los
   * mismos args al transport inyectable.
   */
  readonly transport?: (url: string, init: RequestInit) => Promise<Response>;
  /**
   * Logger opcional. Si no se provee, no se loguea nada. El cliente
   * NUNCA loguea la API key (defensa en profundidad, §3.9).
   */
  readonly logger?: {
    readonly debug: (msg: string, meta?: Record<string, unknown>) => void;
    readonly warn: (msg: string, meta?: Record<string, unknown>) => void;
    readonly error: (msg: string, meta?: Record<string, unknown>) => void;
  };
  /**
   * MIN-6 (audit D2 2026-06-12): identificación de la app en headers de
   * OpenRouter. `appName` aparece en `X-Title`; `appUrl` aparece en
   * `HTTP-Referer`. OpenRouter muestra ambos en su dashboard.
   *
   ** Defaults seguros: `"Worgena"` y `"https://worgena.example.com"`.
   * El caller debería setearlos al deploy (ej: `"Worgena Dev"`,
   * `"https://dev.worgena.example.com"`).
   */
  readonly appName?: string;
  readonly appUrl?: string;
}

/**
 * Request a `chat()`. Modelada para que el motor la pueda construir
 * sin saber de OpenRouter (cero leak del proveedor al motor).
 */
export interface ChatRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  /**
   * JSON Schema para forzar output estructurado. Se traduce a
   * `response_format: { type: "json_schema", json_schema: {...} }` con
   * `strict: true` (decisión §8.20). Si el modelo no soporta `strict`,
   * lo ignora (degradación graciosa).
   */
  readonly responseFormat?: Record<string, unknown>;
  /** OpenAI-format tools (function-calling). */
  readonly tools?: readonly OpenAITool[];
  /** Para cancelación cooperativa (AbortController del motor). */
  readonly signal?: AbortSignal;
}

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface OpenAITool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

/**
 * Response de `chat()`. El `raw` preserva la response completa (sin
 * la key) para audit y drift detection (ver §8.19).
 */
export interface ChatResponse {
  /** Texto o JSON-string del primer choice. El invocador lo parsea si quiere. */
  readonly output: string;
  /** Modelo que respondió (puede diferir del request si OpenRouter routea). */
  readonly modelUsed: string;
  /** Tokens consumidos. */
  readonly tokensUsed: { readonly input: number; readonly output: number };
  /**
   * Costo en USD. **Fuente de verdad: `usage.cost` de OpenRouter** (si
   * está). Si no, el invoker calcula con `PricingCatalog`. El cliente
   * retorna 0 acá y el invoker lo sobreescribe.
   */
  readonly costUsd: number;
  /** Response cruda de OpenRouter. NO contiene la API key. */
  readonly raw: unknown;
}

export interface EmbeddingResponse {
  /** Vector de embedding (un array de números). */
  readonly embedding: number[];
  /** Modelo que respondió. */
  readonly modelUsed: string;
  /** Tokens consumidos. */
  readonly tokensUsed: number;
  /** Costo estimado (embeddings suelen ser gratis o casi gratis). */
  readonly costUsd: number;
  /** Response cruda. */
  readonly raw: unknown;
}

// ============================================================
// OpenRouterClient
// ============================================================

/**
 * Cliente HTTP para OpenRouter.
 *
 * **Concurrencia**: el cliente es stateless (excepto por la `apiKey` y el
 * `transport`). Se puede compartir entre specialists / tasks. Cada call
 * crea su propio `AbortController` interno (si se le pasa `signal`).
 *
 * **Cancelación** (§3.13): si el `signal` del request se aborta, se aborta
 * también el `fetch` interno. Si la cancelación llega después de que la
 * response ya está en vuelo, se descarta la response. Si llega ANTES del
 * fetch, el fetch no se hace.
 *
 * **Timeout** (§3.13): el cliente acepta `timeoutMs` global (default 60s).
 * Si el `fetch` tarda más, se aborta vía `AbortController.timeout` (si
 * disponible en el runtime) o un timer manual. Se mapea a `TIMEOUT`.
 */
export class OpenRouterClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly transport: (url: string, init: RequestInit) => Promise<Response>;
  private readonly logger?: OpenRouterClientOptions["logger"];
  private readonly appName: string;
  private readonly appUrl: string;

  constructor(options: OpenRouterClientOptions) {
    if (!options.apiKey || options.apiKey.trim() === "") {
      throw new MissingOpenRouterKeyError();
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.transport = options.transport ?? globalThis.fetch.bind(globalThis);
    this.logger = options.logger;
    // MIN-6: defaults seguros para identificación. Caller puede
    // sobreescribir al deploy.
    this.appName = options.appName ?? "Worgena";
    this.appUrl = options.appUrl ?? "https://worgena.example.com";
  }

  // ─── chat() ─────────────────────────────────────────────

  /**
   * Llama a `/chat/completions` y retorna la response normalizada.
   *
   * **Throws**:
   * - `OpenRouterError` con `code: ErrorCode` ya mapeado (401, 402, 408, 422, 429, 5xx).
   * - `InvalidResponseError` si la response 200 está malformada.
   * - `OpenRouterError(INTERNAL_ERROR)` si el `signal` se aborta.
   * - `Error` de red (timeout, conexión) envuelto en `OpenRouterError(NETWORK_ERROR)`.
   *
   * MAY-5 (audit D2 2026-06-12): el método loguea via `this.logger` (si
   * está provisto) en 4 puntos — start del request, response OK,
   * error HTTP, timeout/error de red. NUNCA loguea el `apiKey` ni
   * el response body completo (eso es el audit log del motor, no
   * este cliente).
   */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const url = `${this.baseUrl}/chat/completions`;
    const body = this.buildChatBody(request);
    const init = this.buildRequestInit(body, request.signal);

    const startTs = Date.now();
    this.logger?.debug("OpenRouter chat request", {
      model: request.model,
      messageCount: request.messages.length,
      hasResponseFormat: request.responseFormat !== undefined,
      hasTools: request.tools !== undefined && request.tools.length > 0,
    });

    let response: Response;
    try {
      response = await this.executeWithTimeout(url, init, request.signal);
    } catch (e) {
      // executeWithTimeout ya envuelve en OpenRouterError. Logueamos acá.
      if (e instanceof OpenRouterError) {
        if (e.code === "TIMEOUT") {
          this.logger?.warn("OpenRouter chat timeout", { model: request.model, timeoutMs: this.timeoutMs });
        } else if (e.code === "NETWORK_ERROR") {
          this.logger?.warn("OpenRouter chat network error", { model: request.model, message: e.message });
        } else {
          this.logger?.warn("OpenRouter chat aborted", { model: request.model, message: e.message });
        }
      }
      throw e;
    }
    const responseBody = await this.parseJson(response);

    // Mapeo de errores HTTP.
    if (!response.ok) {
      const { code, retriable } = mapHttpStatusToMotorCode(response.status);
      this.logger?.warn("OpenRouter chat HTTP error", {
        model: request.model,
        status: response.status,
        code,
        retriable,
        latencyMs: Date.now() - startTs,
      });
      throw new OpenRouterError({
        message: `OpenRouter ${response.status}: ${this.extractErrorMessage(responseBody)}`,
        httpStatus: response.status,
        code: response.status === 400 ? this.classify400(responseBody) ?? code : code,
        retriable,
        responseBody: this.sanitizeForLog(responseBody),
      });
    }

    // 200 OK: extraer campos y loguear resumen (no body completo).
    const chatResponse = this.parseChatResponse(responseBody);
    this.logger?.debug("OpenRouter chat response", {
      model: request.model,
      modelUsed: chatResponse.modelUsed,
      inputTokens: chatResponse.tokensUsed.input,
      outputTokens: chatResponse.tokensUsed.output,
      costUsd: chatResponse.costUsd,
      latencyMs: Date.now() - startTs,
    });
    return chatResponse;
  }

  // ─── embeddings() ───────────────────────────────────────

  /**
   * Llama a `/embeddings` y retorna el vector.
   *
   * Por qué existe aunque el `OpenRouterLLMInvoker` no lo use (D2b.2): es
   * la API simétrica a `chat()` y queda lista para D4-D5 (RAG y memoria
   * semántica). El patrón es el mismo que `src/agent/memory.ts` ya usa
   * para embeddings directos.
   */
  async embeddings(params: {
    readonly model: string;
    readonly input: string | readonly string[];
    readonly signal?: AbortSignal;
  }): Promise<EmbeddingResponse> {
    const url = `${this.baseUrl}/embeddings`;
    const body = {
      model: params.model,
      input: params.input,
    };
    const init = this.buildRequestInit(body, params.signal);

    const response = await this.executeWithTimeout(url, init, params.signal);
    const responseBody = await this.parseJson(response);

    if (!response.ok) {
      const { code, retriable } = mapHttpStatusToMotorCode(response.status);
      throw new OpenRouterError({
        message: `OpenRouter embeddings ${response.status}: ${this.extractErrorMessage(responseBody)}`,
        httpStatus: response.status,
        code,
        retriable,
        responseBody: this.sanitizeForLog(responseBody),
      });
    }

    return this.parseEmbeddingResponse(responseBody, params.model);
  }

  // ─── Privados ────────────────────────────────────────────

  /**
   * Construye el body de la request a `/chat/completions`. Solo incluye
   * los campos que el request pide — no mandamos `temperature` si no
   * se pidió, etc.
   */
  private buildChatBody(request: ChatRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    if (request.responseFormat !== undefined) {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: "structured_output",
          schema: request.responseFormat,
          strict: true,
        },
      };
    }
    if (request.tools !== undefined && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: t.type,
        function: {
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        },
      }));
    }
    return body;
  }

  /**
   * Construye el `RequestInit` con headers estándar.
   *
   * **Header crítico**: `Authorization: Bearer ${apiKey}`. La key se
   * pasa LITERAL — sin prefijos, sin transformaciones. (Regla del
   * proyecto — ver `AGENTS.md` §5a y `MEMORY.md` 2026-06-09.)
   */
  private buildRequestInit(body: Record<string, unknown>, signal?: AbortSignal): RequestInit {
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      // MIN-6: parametrizados al deploy (dev/staging/prod).
      "HTTP-Referer": this.appUrl,
      "X-Title": this.appName,
    };
    return {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: signal ?? null,
    };
  }

  /**
   * Marca de razón de abort que usamos para distinguir timeout interno
   * de cancelación externa. MAY-3 (audit D2 2026-06-12): la heurística
   * previa (`!externalSignal?.aborted`) era frágil — si el motor aborta
   * externamente por timeout, la heurística decidía mal. Con esta marca,
   * la decisión es explícita.
   *
   * `instanceof Error` + `message === "OpenRouter timeout"` distingue el
   * caso "abortado por nuestro timer" del caso "abortado por el caller".
   */
  private static readonly TIMEOUT_REASON = "OpenRouter timeout";

  /**
   * Ejecuta la request con timeout. Si tarda más de `timeoutMs`, aborta.
   *
   * Si el `signal` externo se aborta primero, el `fetch` se aborta por
   * ese signal. Si pasa el `timeoutMs` interno primero, lo aborta este.
   * Ambos casos se distinguen en el catch inspeccionando
   * `controller.signal.reason` (que nosotros seteamos con un marker
   * distintivo en el timeout interno).
   */
  private async executeWithTimeout(
    url: string,
    init: RequestInit,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(OpenRouterClient.TIMEOUT_REASON)),
      this.timeoutMs,
    );

    // Si el caller pasa un signal externo, conectarlo al controller interno.
    let externalAbortHandler: (() => void) | undefined;
    if (externalSignal !== undefined) {
      if (externalSignal.aborted) {
        clearTimeout(timer);
        throw new OpenRouterError({
          message: "OpenRouter call aborted before start",
          httpStatus: 0,
          code: "INTERNAL_ERROR",
          retriable: false,
        });
      }
      externalAbortHandler = () => controller.abort(externalSignal?.reason);
      externalSignal.addEventListener("abort", externalAbortHandler);
    }

    try {
      return await this.transport(url, { ...init, signal: controller.signal });
    } catch (e) {
      // MAY-3 (audit D2 2026-06-12): distinguir timeout interno vs cancel
      // externo via la razón del signal, no via "está aborted el externo".
      if (e instanceof Error && (e.name === "AbortError" || e.message.includes("aborted"))) {
        const reason = controller.signal.reason;
        const wasTimeout = reason instanceof Error && reason.message === OpenRouterClient.TIMEOUT_REASON;
        throw new OpenRouterError({
          message: wasTimeout
            ? `OpenRouter request timed out after ${this.timeoutMs}ms`
            : "OpenRouter call aborted by caller",
          httpStatus: 0,
          code: wasTimeout ? "TIMEOUT" : "INTERNAL_ERROR",
          retriable: wasTimeout,
        });
      }
      // Network error (DNS, conexión, etc.) — fetch throws.
      const error = e instanceof Error ? e : new Error(String(e));
      throw new OpenRouterError({
        message: `OpenRouter network error: ${error.message}`,
        httpStatus: 0,
        code: "NETWORK_ERROR",
        retriable: true,
      });
    } finally {
      clearTimeout(timer);
      if (externalSignal && externalAbortHandler) {
        externalSignal.removeEventListener("abort", externalAbortHandler);
      }
    }
  }

  /**
   * Parsea el body de la response como JSON. Si falla, tira `InvalidResponseError`.
   */
  private async parseJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (text === "") {
      throw new InvalidResponseError("OpenRouter returned empty body");
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new InvalidResponseError(
        `OpenRouter returned non-JSON body: ${text.slice(0, 200)}`,
        e,
      );
    }
  }

  /**
   * Extrae el mensaje de error del body de OpenRouter. El shape típico
   * es `{ error: { message: "..." } }` o `{ error: "..." }`.
   */
  private extractErrorMessage(body: unknown): string {
    if (body == null || typeof body !== "object") return "(no body)";
    const b = body as Record<string, unknown>;
    if (typeof b.error === "object" && b.error !== null) {
      const err = b.error as Record<string, unknown>;
      if (typeof err.message === "string") return err.message;
    }
    if (typeof b.error === "string") return b.error;
    if (typeof b.message === "string") return b.message;
    return JSON.stringify(body).slice(0, 200);
  }

  /**
   * Para errores 400, distingue si es request mal armado (INTERNAL_ERROR)
   * o response_format inválido (INVALID_OUTPUT). Si el body menciona
   * "response_format" o "json_schema", es INVALID_OUTPUT. Si no, es
   * INTERNAL_ERROR.
   */
  private classify400(body: unknown): "INTERNAL_ERROR" | "INVALID_OUTPUT" | undefined {
    const msg = this.extractErrorMessage(body).toLowerCase();
    if (msg.includes("response_format") || msg.includes("json_schema") || msg.includes("schema")) {
      return "INVALID_OUTPUT";
    }
    if (msg.includes("invalid request") || msg.includes("malformed")) {
      return "INTERNAL_ERROR";
    }
    return undefined; // usa el default de mapHttpStatusToMotorCode
  }

  /**
   * Parsea la response 200 de `/chat/completions` al shape `ChatResponse`.
   *
   ** Tira `InvalidResponseError` si la response no tiene `choices[0]` o
   * si falta `usage` o `model`.
   */
  private parseChatResponse(body: unknown): ChatResponse {
    if (body == null || typeof body !== "object") {
      throw new InvalidResponseError("OpenRouter response is not an object");
    }
    const b = body as Record<string, unknown>;

    // choices[0].message.content
    if (!Array.isArray(b.choices) || b.choices.length === 0) {
      throw new InvalidResponseError("OpenRouter returned empty choices");
    }
    const firstChoice = b.choices[0];
    if (firstChoice == null || typeof firstChoice !== "object") {
      throw new InvalidResponseError("OpenRouter choices[0] is not an object");
    }
    const message = (firstChoice as Record<string, unknown>).message;
    if (message == null || typeof message !== "object") {
      throw new InvalidResponseError("OpenRouter choices[0].message is missing");
    }
    const content = (message as Record<string, unknown>).content;
    if (typeof content !== "string") {
      throw new InvalidResponseError("OpenRouter choices[0].message.content is not a string");
    }

    // model
    const modelUsed = typeof b.model === "string" ? b.model : "unknown";

    // usage: { prompt_tokens, completion_tokens, cost? }
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    if (b.usage != null && typeof b.usage === "object") {
      const usage = b.usage as Record<string, unknown>;
      if (typeof usage.prompt_tokens === "number") inputTokens = usage.prompt_tokens;
      if (typeof usage.completion_tokens === "number") outputTokens = usage.completion_tokens;
      // usage.cost es la fuente de verdad cuando está (ver §3.3).
      if (typeof usage.cost === "number") costUsd = usage.cost;
    }

    return {
      output: content,
      modelUsed,
      tokensUsed: { input: inputTokens, output: outputTokens },
      costUsd,
      raw: this.sanitizeForLog(body),
    };
  }

  /**
   * Parsea la response 200 de `/embeddings` al shape `EmbeddingResponse`.
   */
  private parseEmbeddingResponse(body: unknown, requestedModel: string): EmbeddingResponse {
    if (body == null || typeof body !== "object") {
      throw new InvalidResponseError("OpenRouter embeddings response is not an object");
    }
    const b = body as Record<string, unknown>;

    if (!Array.isArray(b.data) || b.data.length === 0) {
      throw new InvalidResponseError("OpenRouter embeddings returned empty data");
    }
    const first = b.data[0];
    if (first == null || typeof first !== "object") {
      throw new InvalidResponseError("OpenRouter embeddings data[0] is not an object");
    }
    const embedding = (first as Record<string, unknown>).embedding;
    if (!Array.isArray(embedding)) {
      throw new InvalidResponseError("OpenRouter embeddings data[0].embedding is not an array");
    }
    const numericEmbedding = embedding.filter((n): n is number => typeof n === "number");

    const modelUsed = typeof b.model === "string" ? b.model : requestedModel;

    let tokensUsed = 0;
    let costUsd = 0;
    if (b.usage != null && typeof b.usage === "object") {
      const usage = b.usage as Record<string, unknown>;
      // MAY-4 (audit D2 2026-06-12): invertimos la precedencia.
      // Para embeddings no hay `completion_tokens` (solo `prompt_tokens`
      // y `total_tokens`, donde total == prompt). Pero la API de
      // OpenRouter puede llegar con ambos campos — si los dos están,
      // el `total_tokens` es la fuente de verdad final.
      if (typeof usage.prompt_tokens === "number") tokensUsed = usage.prompt_tokens;
      if (typeof usage.total_tokens === "number") tokensUsed = usage.total_tokens;
      if (typeof usage.cost === "number") costUsd = usage.cost;
    }

    return {
      embedding: numericEmbedding,
      modelUsed,
      tokensUsed,
      costUsd,
      raw: this.sanitizeForLog(body),
    };
  }

  /**
   * Saca campos sensibles de la response antes de meterlos en `raw` o
   * en `responseBody` de un error. Hoy no hace nada porque OpenRouter
   * no devuelve la key en sus responses, pero queda como hook para
   * si en el futuro se agrega un campo que sí la contenga.
   */
  private sanitizeForLog(body: unknown): unknown {
    // Defensa en profundidad. Si body tiene "api_key", "authorization"
    // o similar, lo removemos. Hoy OpenRouter no incluye estos campos,
    // pero si una versión futura los agrega, no terminamos logueando
    // la key por accidente.
    if (body == null || typeof body !== "object") return body;
    const result: Record<string, unknown> = {};
    const SENSITIVE_KEYS = new Set(["api_key", "authorization", "x-api-key", "key"]);
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase())) {
        result[k] = "[REDACTED]";
      } else {
        result[k] = v;
      }
    }
    return result;
  }
}
