/**
 * Worgena — OpenRouter LLM Invoker (D2b.2).
 *
 * Fuente de verdad: `AGENT_D2B_2_SPEC.md` §3.3, §5.3.
 *
 * `LLMInvoker` que envuelve un `OpenRouterClient`. Es la pieza que el
 * motor conoce (cumple la interface D2a.4). Por dentro:
 *
 * 1. Construye `messages: [...]` desde `systemPrompt` + `userPrompt`.
 * 2. Traduce `outputSchema` a `response_format: { type: "json_schema", ... }`
 *    con `strict: true` (decisión §8.20).
 * 3. Traduce `tools` al formato OpenAI (OpenRouter lo acepta igual).
 * 4. Llama al `client.chat(...)`.
 * 5. Calcula `costUsd`: `usage.cost` de OpenRouter si está, sino
 *    `PricingCatalog.estimateCost(...)`.
 * 6. Parsea el output: si `outputSchema` está y el output es JSON, lo
 *    parsea como objeto. Si no, lo retorna como string. El motor
 *    valida contra el `stateSchema` después (D2a.4 pattern).
 *
 * **Por qué un invoker separado del cliente**: el cliente HTTP no sabe
 * nada de la interface `LLMInvoker` del motor. El invoker es el adapter
 * que traduce entre el contrato del motor (LLMInvokeParams/Result) y el
 * shape nativo de OpenRouter. Si mañana cambiamos a otro proveedor,
 * escribimos un nuevo invoker, no tocamos el cliente.
 *
 * **Backward-compat con D2a.4**: el `LLMInvokeResult` retornado tiene
 * exactamente los campos que el motor espera: `output`, `tokensUsed`,
 * `modelUsed`, `costUsd?`. Los tests D2a.4 siguen pasando porque la
 * interface no cambió.
 */

import type {
  LLMInvoker,
  LLMInvokeParams,
  LLMInvokeResult,
} from "../workflow-engine/executor/types.js";
import type { WorkflowAudit } from "../workflow-engine/persistence/workflow-audit.js";
import type {
  ChatRequest,
  OpenRouterClient,
  OpenAITool,
  ChatResponse as OpenRouterChatResponse,
} from "./openrouter-client.js";
import { OpenRouterError } from "./openrouter-errors.js";
import { DEFAULT_MODEL_PRICING, PricingCatalog } from "./pricing-catalog.js";
import { consumeCredit, hasActivePlan, InsufficientCreditsError, usdToCredits } from "../../lib/billing/index.js";

// ============================================================
// OpenRouterLLMInvoker
// ============================================================

/**
 * Invoker que envuelve un `OpenRouterClient`. Resuelve el `model`
 * (un `ModelRef` del motor: "liviano" | "robusto" | string) a un
 * `modelId` real de OpenRouter.
 *
 * El `modelMap` es la traducción tier → modelo real:
 * - `"liviano"` → `"deepseek/deepseek-chat"`
 * - `"robusto"` → `"anthropic/claude-3.5-sonnet"`
 * - cualquier otro string → se pasa literal (es un `modelId` directo).
 *
 * **Por qué se resuelve acá, no en el cliente**: el cliente no sabe
 * qué tier es qué modelo (eso es policy de Worgena, no de OpenRouter).
 * Si mañana cambiamos a otro proveedor, el invoker cambia, el cliente no.
 */
export class OpenRouterLLMInvoker implements LLMInvoker {
  private readonly client: OpenRouterClient;
  private readonly catalog: PricingCatalog;
  /**
   * Mapa de `ModelRef` (del motor) a `modelId` real de OpenRouter.
   * Default configurable: tier "liviano" y "robusto" mapean a los
   * modelos más usados en el roadmap §5.5.
   */
  private readonly modelMap: Readonly<Record<string, string>>;
  /**
   * Catálogo de tools disponibles para los nodos LLM (D2c+).
   * Mapa `nombre → definición OpenAI`. Si está undefined, el invoker
   * falla loud cuando un workflow declara `tools` (CRIT-2). Si está
   * presente pero el workflow pide una tool no registrada, también
   * falla loud.
   */
  private readonly toolCatalog?: ReadonlyMap<string, OpenAITool>;
  /**
   * Backlog P0 #3: audit opcional para cost attribution. Si está
   * presente y el caller pasa `taskId`/`tenantId`/`nodeId` en
   * `LLMInvokeParams`, se persiste un evento `llm_call` después
   * de cada `chat()` exitoso. Si está undefined o falta alguno de
   * los campos, NO se registra (P1 del sprint spec).
   */
  private readonly audit?: WorkflowAudit;
  /**
   * Backlog P0 #4: billing enforcement opcional. Si está `true`,
   * el invoker chequea `getCreditBalance(tenantId) >= usdToCredits(costUsd)`
   * ANTES de hacer el chat. Si el balance no alcanza, throwea
   * `OpenRouterError({code: "INSUFFICIENT_CREDITS", retriable: false})`.
   * Si está `false` (default para backward-compat con tests pre-billing),
   * el chequeo se skipea.
   */
  private readonly enforceCredits: boolean;

  constructor(
    client: OpenRouterClient,
    options?: {
      readonly catalog?: PricingCatalog;
      readonly modelMap?: Readonly<Record<string, string>>;
      /** D2c+: catálogo de tools. Si se omite, workflows con tools fallan. */
      readonly toolCatalog?: ReadonlyMap<string, OpenAITool>;
      /** Backlog P0 #3: cost attribution. Optional. */
      readonly audit?: WorkflowAudit;
      /** P0 #4 billing: enforce credit balance antes de cada chat. */
      readonly enforceCredits?: boolean;
    },
  ) {
    this.client = client;
    this.catalog = options?.catalog ?? new PricingCatalog();
    this.modelMap = options?.modelMap ?? DEFAULT_MODEL_MAP;
    this.toolCatalog = options?.toolCatalog;
    this.audit = options?.audit;
    this.enforceCredits = options?.enforceCredits ?? false;
  }

  /**
   * Implementación de `LLMInvoker.invoke()`. El motor la llama con los
   * params canónicos; este método los traduce y llama al cliente.
   *
   * **Errores**: cualquier error del cliente (HTTP, timeout, abort) se
   * propaga como `OpenRouterError` con `code: ErrorCode`. El motor y
   * el `node-runner` los manejan según su `code` (ver `classifyLLMError`
   * en `node-runner.ts:393` — backward-compat: ese clasificador acepta
   * tanto `OpenRouterError` con `.code` como errores legacy con substring
   * matching).
   */
  async invoke(params: LLMInvokeParams): Promise<LLMInvokeResult> {
    const modelId = this.resolveModel(params.model);

    const messages: ChatRequest["messages"] = this.buildMessages(params);

    const chatRequest: ChatRequest = {
      model: modelId,
      messages,
      ...(params.outputSchema !== undefined ? { responseFormat: params.outputSchema } : {}),
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
      // Tools: por ahora el motor pasa `tools` como `readonly string[]`
      // (Nombres de tools registradas). OpenRouter espera el shape
      // OpenAI completo. Si el workflow no declara tools en el nodo,
      // no mandamos nada. Forward-compat: cuando se enchufe el catálogo
      // de tools (D2c skills v1), este invoker las traduce.
      ...(params.tools !== undefined && params.tools.length > 0
        ? { tools: this.translateTools(params.tools) }
        : {}),
    };

    const startTs = Date.now();
    const chatResponse = await this.client.chat(chatRequest);
    const durationMs = Date.now() - startTs;

    // Costo real: usage.cost de OpenRouter pisa la estimación del catálogo.
    const costUsd = this.resolveCost(chatResponse, modelId);

    // P0 #4: billing enforcement. Si está habilitado y tenemos tenantId,
    // chequea balance. Si no alcanza, throw. Si alcanza, consume.
    // Esto ocurre DESPUÉS del chat (necesitamos el costo real). Trade-off:
    // un cliente sin créditos puede generar 1 call "gratis" antes de ser
    // bloqueado. Alternativa: pre-estimar y bloquear antes. Elegimos post
    // porque la estimación puede ser inexacta (spec §2.O4).
    if (this.enforceCredits && params.tenantId !== undefined) {
      const tenantId = params.tenantId;
      if (!hasActivePlan(tenantId)) {
        throw new OpenRouterError({
          message: `OpenRouterLLMInvoker: tenant=${tenantId} no tiene plan activo. Subscribe at /api/billing/me.`,
          httpStatus: 0,
          code: "INSUFFICIENT_CREDITS",
          retriable: false,
        });
      }
      const requiredCredits = usdToCredits(costUsd);
      try {
        consumeCredit(
          tenantId,
          requiredCredits,
          "llm_call",
          {
            taskId: params.taskId,
            nodeId: params.nodeId,
            agentCardId: params.agentCardId,
            costUsd,
            modelId,
          },
        );
      } catch (e) {
        if (e instanceof InsufficientCreditsError) {
          throw new OpenRouterError({
            message: e.message,
            httpStatus: 0,
            code: "INSUFFICIENT_CREDITS",
            retriable: false,
          });
        }
        // Cualquier otro error de DB → fail-loud per P7.
        throw e;
      }
    }

    // Output: si se pidió outputSchema (json_schema), el modelo debería
    // haber retornado JSON. Lo parseamos. Si falla, retornamos el string
    // raw y el motor valida con SCHEMA_VIOLATION (D2a.4 behavior).
    const output = this.parseOutput(chatResponse.output, params.outputSchema);

    // Backlog P0 #3: persistir evento de cost attribution. Solo si
    // audit está configurado Y el caller pasó los 3 campos requeridos.
    // P1 — audit es secundario; si falla, NO throwea al caller.
    if (
      this.audit &&
      params.tenantId !== undefined &&
      params.taskId !== undefined &&
      params.nodeId !== undefined
    ) {
      try {
        this.audit.recordLLMCall({
          tenantId: params.tenantId,
          taskId: params.taskId,
          nodeId: params.nodeId,
          ...(params.agentCardId !== undefined
            ? { agentCardId: params.agentCardId }
            : {}),
          model: chatResponse.modelUsed,
          inputTokens: chatResponse.tokensUsed.input,
          outputTokens: chatResponse.tokensUsed.output,
          costUsd,
          durationMs,
          createdAt: Date.now(),
        });
      } catch (e) {
        // P1: NO throwear. Log a stderr y seguir.
        // FIX audit 2026-06-25: no loggear e.message (puede tener
        // schema info). Solo el counter.
        process.stderr.write(
          `[cost-attribution] failed to record llm_call: ${(e as Error).name}\n`,
        );
      }
    }

    return {
      output,
      tokensUsed: chatResponse.tokensUsed,
      modelUsed: chatResponse.modelUsed,
      costUsd,
    };
  }

  // ─── Privados ────────────────────────────────────────────

  /**
   * Resuelve un `ModelRef` del motor a un `modelId` real de OpenRouter.
   * Si el ModelRef es "liviano" o "robusto", usa el mapa. Si no, asume
   * que es un modelId directo (un workflow puede apuntar a un modelo
   * específico, ej: "openai/gpt-4o").
   */
  private resolveModel(modelRef: string): string {
    return this.modelMap[modelRef] ?? modelRef;
  }

  /**
   * Construye el array de `messages` desde `systemPrompt` + `userPrompt`.
   *
   * **Edge cases**:
   * - Solo `systemPrompt`: tira error (LLM sin input no tiene sentido).
   * - Solo `userPrompt`: válido (caso "completar texto").
   * - Ambos: el system va primero, después el user.
   */
  private buildMessages(params: LLMInvokeParams): ChatRequest["messages"] {
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
    if (params.systemPrompt !== undefined && params.systemPrompt !== "") {
      messages.push({ role: "system", content: params.systemPrompt });
    }
    if (params.userPrompt !== undefined && params.userPrompt !== "") {
      messages.push({ role: "user", content: params.userPrompt });
    }
    if (messages.length === 0) {
      throw new OpenRouterError({
        message: "OpenRouterLLMInvoker: al menos uno de systemPrompt/userPrompt es requerido",
        httpStatus: 0,
        code: "INTERNAL_ERROR",
        retriable: false,
      });
    }
    return messages;
  }

  /**
   * Traduce `tools: readonly string[]` (nombres de tools del motor)
   * al shape OpenAI que OpenRouter espera.
   *
   * **CRIT-2 (audit D2, 2026-06-12)**: el método NO retorna array vacío
   * silenciosamente. Si un workflow declara tools pero no hay catálogo
   * registrado, falla con `INTERNAL_ERROR` para que el workflow autor
   * se entere al ejecutar la task. **No es válido perder tools sin
   * avisar** — un LLM sin la tool de búsqueda de jurisprudencia puede
   * alucinar citas. Ver `AUDIT_D2_2026-06-12.md` §CRIT-2.
   *
   * Hoy (D2b.2 → D2c) no hay catálogo de tools real (las topic-based
   * policies de D1 y los skills jurídicos de §5.14 son D2c+). Por eso
   * el catálogo se inyecta como `this.catalog` (futuro). Si en D2c el
   * catálogo no está pero el workflow pide tools, fallar loud.
   *
   * Forward-compat: en D2c se enchufa el catálogo y este método traduce
   * los nombres a las definiciones OpenAI.
   */
  private translateTools(toolNames: readonly string[]): readonly OpenAITool[] {
    if (toolNames.length === 0) return [];
    // CRIT-2: si hay tools declaradas pero no hay catálogo, fail loud.
    // El workflow autor debe enterarse al ejecutar la task, no
    // descubrirlo en producción cuando un LLM alucine sin la tool.
    if (this.toolCatalog === undefined) {
      throw new OpenRouterError({
        message: `OpenRouterLLMInvoker: workflow declara tools [${toolNames.join(", ")}] pero el catálogo de tools no está registrado en el OpenRouterLLMInvoker. D2c enchufa el catálogo (skill catalog). Mientras tanto, los workflows con tools no son ejecutables.`,
        httpStatus: 0,
        code: "INTERNAL_ERROR",
        retriable: false,
      });
    }
    // Si el catálogo está, traducimos. Hoy retorna [] (placeholder);
    // D2c lo llena.
    const translated: OpenAITool[] = [];
    for (const name of toolNames) {
      const def = this.toolCatalog.get(name);
      if (def === undefined) {
        // Tool declarada pero no existe en el catálogo. Fail loud.
        throw new OpenRouterError({
          message: `OpenRouterLLMInvoker: tool "${name}" declarada en el workflow pero no existe en el catálogo de tools registrado. Registrá la tool en el catálogo antes de ejecutar el workflow.`,
          httpStatus: 0,
          code: "INTERNAL_ERROR",
          retriable: false,
        });
      }
      translated.push(def);
    }
    return translated;
  }

  /**
   * Resuelve el costo: `usage.cost` de OpenRouter pisa la estimación.
   *
   * Decisión §3.3: si `usage.cost` está, ese es el costo real facturado
   * (la fuente de verdad). El catálogo es fallback. El `raw` field del
   * `ChatResponse` preserva la response completa, así que el equipo de
   * audit puede ver el drift entre el catálogo y lo facturado.
   */
  private resolveCost(chatResponse: OpenRouterChatResponse, modelId: string): number {
    if (chatResponse.costUsd > 0) {
      return chatResponse.costUsd;
    }
    return this.catalog.estimateCost(
      modelId,
      chatResponse.tokensUsed.input,
      chatResponse.tokensUsed.output,
    );
  }

  /**
   * Parsea el output del LLM. Si se pidió `outputSchema` y el output
   * es JSON, lo retorna como objeto parseado. Si falla el parse, retorna
   * el string raw y deja que el motor valide con `SCHEMA_VIOLATION`.
   *
   ** Sin `outputSchema`, retorna el string tal cual.
   */
  private parseOutput(raw: string, outputSchema?: Record<string, unknown>): unknown {
    if (outputSchema === undefined) return raw;
    try {
      return JSON.parse(raw);
    } catch {
      // El modelo no devolvió JSON válido a pesar del response_format.
      // Devolvemos el string raw. El motor (D2a.4) lo validará contra
      // node.outputSchema y fallará con INVALID_OUTPUT o SCHEMA_VIOLATION.
      return raw;
    }
  }
}

// ============================================================
// Constantes
// ============================================================

/**
 * Mapa default de `ModelRef` del motor → `modelId` real de OpenRouter.
 *
 * **Por qué los modelos del roadmap §5.5**:
 * - `"liviano"` → `deepseek/deepseek-chat`: tier 3, clasificación, intake.
 * - `"robusto"` → `anthropic/claude-3.5-sonnet`: tier 1, razonamiento jurídico.
 *
 * El caller puede sobreescribirlo pasando `modelMap` al constructor.
 * Si en D3+ se introduce un gateway (LiteLLM, Portkey), el mapa cambia
 * a apuntar a los `modelId`s del gateway (que el gateway traduce al
 * proveedor real).
 */
const DEFAULT_MODEL_MAP: Readonly<Record<string, string>> = Object.freeze({
  liviano: "deepseek/deepseek-chat",
  robusto: "anthropic/claude-3.5-sonnet",
});

// Re-export para que el barrel pueda importar DEFAULT_MODEL_PRICING si lo necesita.
export { DEFAULT_MODEL_PRICING };
