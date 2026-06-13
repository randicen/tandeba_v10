/**
 * Worgena — Mock LLM Invokers (D2b.1).
 *
 * Fuente de verdad: `AGENT_D2B_1_SPEC.md` §3.5, §5.1.
 *
 * En D2b.1 los invocadores concretos son MOCKS. La integración real con
 * OpenRouter (D2b.2) los reemplaza. Ver `AGENT_D2B_1_SPEC.md` §2.1 goal 10
 * y §3.5.
 *
 * Los mocks NO son genéricos — retornan outputs específicos por specialist.
 * Esto es lo que el spec pide: "los invocadores concretos son mocks que
 * retornan outputs específicos por specialist (no por modelo)".
 *
 * Mocks provistos:
 *
 * - `MockDeepSeekFlashInvoker`: tier 3 (liviano). Retorna outputs de
 *   clasificación. Llamado por `IntakeSpecialist` con tier "liviano".
 *   Si lo llama otro specialist, retorna un error defensivo.
 *
 * - `MockM3ThinkingInvoker`: tier 1 (robusto). Retorna outputs de análisis
 *   de cláusulas o verificación. Llamado por `ClauseReviewerSpecialist`
 *   y `VerifierSpecialist` (ambos tier "robusto"). Si lo llama otro
 *   specialist, retorna un error defensivo.
 *
 * ¿Por qué mocks específicos por specialist y no genéricos?
 * - Tests deterministas: cada test sabe exactamente qué output esperar.
 * - Validación del routing: si un nodo apunta al specialist equivocado,
 *   el mock tira un error y el test falla en lugar de retornar basura.
 *
 * Trade-off: los mocks están acoplados a los specialists. Si un nuevo
 * specialist aparece, hay que agregar un nuevo mock. Aceptable en D2b.1
 * (3 specialists, 2 mocks). En D2b.2 esto se reemplaza por un solo
 * invocador real (OpenRouter) + un catálogo de respuestas por test.
 */

import type {
  LLMInvoker,
  LLMInvokeParams,
  LLMInvokeResult,
} from "../../workflow-engine/executor/types.js";

// ============================================================
// MockDeepSeekFlashInvoker (tier liviano)
// ============================================================

/**
 * Mock de tier liviano (DeepSeek Flash). Retorna un output de
 * clasificación simple — el que `IntakeSpecialist` espera.
 *
 * Comportamiento:
 * - Input: el user prompt es el `{{state.input.documentContent}}` interpolado.
 * - Output: `{ category: "contrato", confidence: 0.9 }`.
 *
 * ¿Cómo sabe que es IntakeSpecialist? El system prompt del `IntakeSpecialist`
 * empieza con "Sos un clasificador". Si el system prompt contiene esa
 * frase, retorna el output de clasificación. Si no, tira un error defensivo.
 *
 * **Costo en D2b.1**: `costUsd` es 0.001 USD (valor fijo para tests
 * deterministas). En D2b.2 el pricing es real (tokens × $/M).
 *
 * **Tokens en D2b.1**: 100 input + 50 output (constante). En D2b.2
 * son los tokens reales del LLM.
 */
export class MockDeepSeekFlashInvoker implements LLMInvoker {
  /** Override del output de clasificación (para tests que necesitan forzar categorías). */
  public classificationOverride: { category: string; confidence: number } = {
    category: "contrato",
    confidence: 0.9,
  };

  /** Cuenta de invocaciones (para tests). */
  public callCount = 0;

  /** Último params recibido (para tests). */
  public lastParams: LLMInvokeParams | undefined;

  async invoke(params: LLMInvokeParams): Promise<LLMInvokeResult> {
    this.callCount++;
    this.lastParams = params;
    const sys = params.systemPrompt ?? "";
    if (!sys.includes("clasificador")) {
      throw new Error(
        `MockDeepSeekFlashInvoker llamado por un specialist que no es clasificador. ` +
          `systemPrompt esperado: empieza con "Sos un clasificador". ` +
          `Recibido: ${sys.slice(0, 80)}`,
      );
    }
    return {
      output: { ...this.classificationOverride },
      tokensUsed: { input: 100, output: 50 },
      modelUsed: "deepseek-flash",
      costUsd: 0.001,
    };
  }
}

// ============================================================
// MockM3ThinkingInvoker (tier robusto)
// ============================================================

/**
 * Mock de tier robusto (M3 Thinking). Retorna un output específico
 * según el specialist que lo invoca:
 *
 * - Si el system prompt menciona "cláusula" o "abuso": retorna análisis
 *   de cláusulas (usado por `ClauseReviewerSpecialist`).
 *
 * - Si el system prompt menciona "verific" (verificar, verificación, etc.):
 *   retorna verdict de verificación (usado por `VerifierSpecialist`).
 *
 * - En cualquier otro caso: tira error defensivo.
 *
 * **Costo en D2b.1**: 0.01 USD (10× el tier liviano, refleja el pricing
 * relativo real). En D2b.2 es pricing real.
 */
export class MockM3ThinkingInvoker implements LLMInvoker {
  /** Override del output de análisis de cláusulas. */
  public clauseReviewOverride: Array<{
    clauseId: number;
    risk: "low" | "medium" | "high";
    reason: string;
  }> = [
    { clauseId: 1, risk: "low", reason: "Cláusula estándar" },
    { clauseId: 2, risk: "medium", reason: "Renovación tácita, revisar plazo" },
  ];

  /** Override del verdict de verificación. */
  public verifierOverride: {
    verified: boolean;
    confidence: number;
    notes: string;
  } = {
    verified: true,
    confidence: 0.85,
    notes: "El output es consistente con el contexto. Sin issues detectados.",
  };

  /** Override para forzar verificación fallida (test 6). */
  public verifierOverrideFails = false;

  /** Cuenta de invocaciones. */
  public callCount = 0;

  /** Último params recibido. */
  public lastParams: LLMInvokeParams | undefined;

  async invoke(params: LLMInvokeParams): Promise<LLMInvokeResult> {
    this.callCount++;
    this.lastParams = params;
    const sys = params.systemPrompt ?? "";
    if (sys.includes("cláusul") || sys.includes("revis") || sys.includes("abus")) {
      return {
        output: this.clauseReviewOverride.map((c) => ({ ...c })),
        tokensUsed: { input: 200, output: 150 },
        modelUsed: "m3-thinking",
        costUsd: 0.01,
      };
    }
    if (sys.includes("verific")) {
      const v = this.verifierOverrideFails
        ? { verified: false, confidence: 0.3, notes: "Conflicto detectado" }
        : this.verifierOverride;
      return {
        output: { ...v },
        tokensUsed: { input: 150, output: 100 },
        modelUsed: "m3-thinking",
        costUsd: 0.01,
      };
    }
    throw new Error(
      `MockM3ThinkingInvoker llamado por un specialist desconocido. ` +
        `systemPrompt debería mencionar cláusulas, revisión, abuso, o verificación. ` +
        `Recibido: ${sys.slice(0, 80)}`,
    );
  }
}

// ============================================================
// MockOpenRouterClient (D2b.2) — mock del cliente HTTP, no del invoker
// ============================================================

/**
 * Mock del `OpenRouterClient`. Implementa el mismo constructor
 * signature (acepta `transport`, `timeoutMs`, `logger`) pero su
 * `transport` interno es programable.
 *
 * **Diferencia con `MockDeepSeekFlashInvoker` / `MockM3ThinkingInvoker`**:
 * esos son mocks de `LLMInvoker` (la abstracción del motor). Este es
 * un mock del cliente HTTP de OpenRouter — más bajo en el stack.
 * Permite testear el `OpenRouterClient` y el `OpenRouterLLMInvoker`
 * con responses HTTP controladas (status, body, headers).
 *
 * **Programación de responses**: el caller setea `nextResponse` o usa
 * `scriptedResponses` (un array FIFO) antes de cada call. Si no hay
 * response programada, retorna 200 con un body de chat completion
 * genérico (para que los tests que olvidan setearlo fallen suave).
 *
 * **Tests típicos**:
 * 1. Chat happy path: `nextResponse = makeChat200({...})` y verifica
 *    que el `OpenRouterClient.chat()` retorna el `ChatResponse` correcto.
 * 2. Chat 429: `nextResponse = makeHttpError(429, "rate limit")` y
 *    verifica que tira `OpenRouterError` con `code: RATE_LIMIT`.
 * 3. Chat 500: `nextResponse = makeHttpError(500, "server error")` y
 *    verifica que tira con `code: MODEL_UNAVAILABLE`.
 * 4. Chat con `choices` vacío: `nextResponse = makeChat200({choices: []})`
 *    y verifica `InvalidResponseError`.
 * 5. Embeddings happy path: `nextResponse = makeEmbedding200({...})` y
 *    verifica el `EmbeddingResponse`.
 */
import type {
  ChatRequest,
  ChatResponse,
  EmbeddingResponse,
  OpenRouterClientOptions,
} from "../../llm/openrouter-client.js";
import { OpenRouterClient } from "../../llm/openrouter-client.js";

/** Tipo de la response que retorna el transport mock. */
interface MockResponse {
  readonly status: number;
  readonly statusText?: string;
  readonly body: string;
  readonly headers?: Record<string, string>;
}

export class MockOpenRouterClient {
  /** API key que se le pasa al constructor (para asserts en tests). */
  public readonly apiKey: string;
  /** Opciones del constructor. */
  public readonly options: OpenRouterClientOptions;
  /** Lista de calls hechos al transport (orden FIFO). */
  public readonly calls: Array<{ url: string; init: RequestInit }> = [];

  /**
   * Helper: la última call al transport (NIT-3, audit D2 2026-06-12).
   * Si el caller quiere inspeccionar la última call, no tiene que
   * hacer `calls[calls.length - 1]`. Es `undefined` si no hubo calls.
   */
  get lastCall(): { url: string; init: RequestInit } | undefined {
    return this.calls[this.calls.length - 1];
  }
  /** Script de responses en orden FIFO. Si está vacío, se usa `defaultResponse`. */
  public scriptedResponses: MockResponse[] = [];
  /** Response default si no hay scripted. */
  public defaultResponse: MockResponse = makeChat200({
    id: "gen-mock-1",
    model: "anthropic/claude-3.5-sonnet",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: '{"result":"mock"}' },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0001 },
  });

  constructor(options: OpenRouterClientOptions) {
    this.apiKey = options.apiKey;
    this.options = options;
  }

  /**
   * El "transport" que se le inyecta al `OpenRouterClient` real.
   * Simula `fetch` y retorna la siguiente response del script.
   */
  public readonly transport = async (url: string, init: RequestInit): Promise<Response> => {
    this.calls.push({ url, init });
    const response = this.scriptedResponses.length > 0
      ? this.scriptedResponses.shift()!
      : this.defaultResponse;
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText ?? "",
      headers: response.headers ?? { "Content-Type": "application/json" },
    });
  };

  /**
   * Devuelve una instancia de `OpenRouterClient` real que usa el
   * `transport` programable de este mock.
   *
   * MAY-10 (audit D2 2026-06-12): el mock ya no duplica el parseo
   * del response — delega al cliente real. Cualquier cambio en
   * `OpenRouterClient` (parseo, headers, transport) se refleja
   * automáticamente en el mock. Single source of truth.
   */
  public toOpenRouterClient(): OpenRouterClient {
    return new OpenRouterClient({
      apiKey: this.apiKey,
      timeoutMs: 60_000,
      transport: this.transport,
    });
  }

  /**
   * `chat()` y `embeddings()` legacy: implementaciones paralelas que
   * parsean el response. Se mantienen por backward-compat con tests
   * D2b.2 que las usan directo. **Deprecated** (MAY-10): preferir
   * `toOpenRouterClient().chat(...)` que delega al cliente real.
   *
   * Si D3+ quiere eliminar esto, los tests que las usan son los del
   * D2b.2 (que pueden migrarse). El único caller externo conocido
   * es el smoke E2E con OpenRouter real (que NO usa el mock).
   */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body = JSON.stringify({
      model: request.model,
      messages: request.messages,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      ...(request.responseFormat !== undefined
        ? { response_format: { type: "json_schema", json_schema: { name: "structured_output", schema: request.responseFormat, strict: true } } }
        : {}),
    });
    const res = await this.transport("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body,
    });
    if (!res.ok) {
      const errBody = await res.json() as { error?: { message?: string } };
      throw new Error(`OpenRouter mock ${res.status}: ${errBody.error?.message ?? "(no message)"}`);
    }
    const json = await res.json() as {
      model: string;
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };
    if (!Array.isArray(json.choices) || json.choices.length === 0) {
      throw new Error("MockOpenRouterClient: empty choices");
    }
    const content = json.choices[0]?.message.content ?? "";
    return {
      output: content,
      modelUsed: json.model,
      tokensUsed: {
        input: json.usage?.prompt_tokens ?? 0,
        output: json.usage?.completion_tokens ?? 0,
      },
      costUsd: json.usage?.cost ?? 0,
      raw: json,
    };
  }

  async embeddings(params: { model: string; input: string | readonly string[] }): Promise<EmbeddingResponse> {
    const res = await this.transport("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: { "Authorization": `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: params.model, input: params.input }),
    });
    if (!res.ok) {
      throw new Error(`MockOpenRouterClient embeddings ${res.status}`);
    }
    const json = await res.json() as {
      model: string;
      data: Array<{ embedding: number[] }>;
      usage?: { total_tokens?: number; prompt_tokens?: number; cost?: number };
    };
    if (!Array.isArray(json.data) || json.data.length === 0) {
      throw new Error("MockOpenRouterClient: empty embeddings data");
    }
    return {
      embedding: json.data[0]?.embedding ?? [],
      modelUsed: json.model,
      // MAY-4 (audit D2 2026-06-12): precedence invertida — `total_tokens`
      // pisa a `prompt_tokens` si ambos están. Mismo orden que el
      // OpenRouterClient real ahora usa.
      tokensUsed: json.usage?.prompt_tokens ?? json.usage?.total_tokens ?? 0,
      costUsd: json.usage?.cost ?? 0,
      raw: json,
    };
  }
}

// ============================================================
// Helpers para construir responses mock
// ============================================================

/** Builder de response 200 para `/chat/completions`. */
export function makeChat200(body: unknown): MockResponse {
  return {
    status: 200,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  };
}

/** Builder de response HTTP de error (4xx/5xx). */
export function makeHttpError(status: number, message: string): MockResponse {
  return {
    status,
    body: JSON.stringify({ error: { message, type: "mock_error" } }),
    headers: { "Content-Type": "application/json" },
  };
}

/** Builder de response 200 para `/embeddings`. */
export function makeEmbedding200(body: unknown): MockResponse {
  return {
    status: 200,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  };
}

/** Builder de response con body inválido (no JSON). */
export function makeNonJsonResponse(status: number = 200): MockResponse {
  return {
    status,
    body: "<html>not json</html>",
    headers: { "Content-Type": "text/html" },
  };
}
