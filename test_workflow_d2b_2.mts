/**
 * D2b.2 — Specialists Reales: OpenRouter + Agent Cards + Lifecycle + Verifier Sub-sesión: Tests.
 *
 * Fuente de verdad: `AGENT_D2B_2_SPEC.md`.
 *
 * Cubre:
 * - OpenRouterClient (mock): 13 tests (chat/embeddings, errores HTTP, parseo, etc.).
 * - PricingCatalog: 5 tests.
 * - OpenRouterLLMInvoker: 8 tests.
 * - AgentCard: 5 tests.
 * - Lifecycle: 8 tests.
 * - Specialists con cards y lifecycle: 6 tests.
 * - VerifierSpecialist con sub-sesión + Citation Grounding v2: 8 tests.
 * - Backward-compat: 2 tests.
 * - Smoke E2E con OpenRouter real (opcional): 1 test.
 *
 * Patrón: igual que `test_workflow_d2b_1.mts`. Counter de passed/failed
 * con `assert` (Node built-in). No usa libs externas.
 *
 * Total: 56 tests planeados.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  OpenRouterClient,
  OpenRouterLLMInvoker,
  PricingCatalog,
  DEFAULT_MODEL_PRICING,
  OpenRouterError,
  MissingOpenRouterKeyError,
  InvalidResponseError,
  mapHttpStatusToMotorCode,
} from "./src/agent/llm/index.js";
import type {
  ChatRequest,
  ChatResponse,
  OpenRouterClientOptions,
} from "./src/agent/llm/openrouter-client.js";
import {
  IntakeSpecialist,
  ClauseReviewerSpecialist,
  VerifierSpecialist,
  SpecialistRegistry,
  type Specialist,
  DefaultTierResolver,
  buildAgentCard,
  agentCardToJSON,
  Lifecycle,
  LIFECYCLE_TRANSITIONS,
  isValidLifecycleTransition,
  INTAKE_AGENT_CARD,
  CLAUSE_REVIEWER_AGENT_CARD,
  VERIFIER_AGENT_CARD,
  AGENT_CARDS_BY_ID,
  VERIFIER_OUTPUT_SCHEMA,
} from "./src/agent/specialists/index.js";
import type { AgentCard } from "./src/agent/specialists/agent-card.js";
import type { LifecycleState, LifecycleEvent } from "./src/agent/specialists/lifecycle.js";
import type { LLMInvoker, LLMInvokeParams, LLMInvokeResult } from "./src/agent/workflow-engine/executor/types.js";
import type { LLMNode } from "./src/agent/workflow-engine/dsl/types.js";
import {
  MockDeepSeekFlashInvoker,
  MockM3ThinkingInvoker,
  MockOpenRouterClient,
  makeChat200,
  makeHttpError,
  makeEmbedding200,
  makeNonJsonResponse,
} from "./src/agent/specialists/mocks/mock-invokers.js";

// ============================================================
// Test infrastructure
// ============================================================

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Lee OPENROUTER_API_KEY del env. Si no está, retorna null. */
function getOpenRouterKey(): string | null {
  const k = process.env.OPENROUTER_API_KEY;
  if (k === undefined || k === "") return null;
  return k;
}

/** LLMInvoker fake que retorna el output que el caller quiera. */
class StubLLMInvoker implements LLMInvoker {
  public callCount = 0;
  constructor(private readonly output: unknown) {}
  async invoke(_params: LLMInvokeParams): Promise<LLMInvokeResult> {
    this.callCount++;
    return {
      output: this.output,
      tokensUsed: { input: 1, output: 1 },
      modelUsed: "stub",
    };
  }
}

console.log("D2b.2 — Specialists Reales: OpenRouter + Agent Cards + Lifecycle + Verifier Sub-sesión: Tests\n");

// ============================================================
// §6.1. OpenRouterClient (~13 tests)
// ============================================================

console.log("── OpenRouterClient ──");

await test("client: constructor con key válida acepta opciones y las guarda", () => {
  const client = new OpenRouterClient({ apiKey: "sk-or-v1-test" });
  assert.ok(client instanceof OpenRouterClient);
});

await test("client: constructor con key vacía tira MissingOpenRouterKeyError", () => {
  assert.throws(() => new OpenRouterClient({ apiKey: "" }), MissingOpenRouterKeyError);
  assert.throws(() => new OpenRouterClient({ apiKey: "   " }), MissingOpenRouterKeyError);
});

// MIN-6: appName y appUrl se inyectan al constructor y se usan en los headers.
await test("client: appName y appUrl se inyectan y se usan en HTTP-Referer / X-Title", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({
        model: "m",
        choices: [{ message: { content: "ok" } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const client = new OpenRouterClient({
    apiKey: "sk-or-v1-test",
    transport,
    appName: "Worgena Dev",
    appUrl: "https://dev.worgena.example.com",
  });
  await client.chat({ model: "m", messages: [{ role: "user", content: "hi" }] });
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers["HTTP-Referer"], "https://dev.worgena.example.com");
  assert.equal(headers["X-Title"], "Worgena Dev");
});

await test("client: chat() con response 200 válido retorna ChatResponse con todos los campos", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({
        id: "gen-1",
        model: "anthropic/claude-3.5-sonnet",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Hola, ¿en qué puedo ayudarte?" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18, cost: 0.00024 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const client = new OpenRouterClient({ apiKey: "sk-or-v1-test", transport });
  const response = await client.chat({
    model: "robusto",
    messages: [{ role: "user", content: "Hola" }],
  });
  assert.ok(response.output.startsWith("Hola"));
  assert.equal(response.modelUsed, "anthropic/claude-3.5-sonnet");
  assert.equal(response.tokensUsed.input, 10);
  assert.equal(response.tokensUsed.output, 8);
  assert.equal(response.costUsd, 0.00024);
  assert.ok(calls.length === 1);
  assert.ok(calls[0]!.url.includes("/chat/completions"));
  // La key se pasa LITERAL al header Authorization.
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer sk-or-v1-test");
});

await test("client: chat() con responseFormat se traduce a response_format: json_schema con strict:true", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({
        model: "anthropic/claude-3.5-sonnet",
        choices: [{ index: 0, message: { role: "assistant", content: '{"x":1}' }, finish_reason: "stop" }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const client = new OpenRouterClient({ apiKey: "sk-or-v1-test", transport });
  await client.chat({
    model: "robusto",
    messages: [{ role: "user", content: "Hola" }],
    responseFormat: { type: "object", properties: { x: { type: "number" } } },
  });
  const body = JSON.parse(calls[0]!.init.body as string) as { response_format?: { type: string; json_schema: { name: string; schema: unknown; strict: boolean } } };
  assert.equal(body.response_format?.type, "json_schema");
  assert.equal(body.response_format?.json_schema.strict, true);
  assert.equal(body.response_format?.json_schema.name, "structured_output");
});

await test("client: chat() con response 401 tira OpenRouterError con code=INTERNAL_ERROR", async () => {
  const transport = async () => new Response(JSON.stringify({ error: { message: "Invalid API key" } }), { status: 401 });
  const client = new OpenRouterClient({ apiKey: "sk-or-v1-test", transport });
  await assert.rejects(
    client.chat({ model: "x", messages: [{ role: "user", content: "y" }] }),
    (e: unknown) => e instanceof OpenRouterError && e.code === "INTERNAL_ERROR" && e.httpStatus === 401,
  );
});

await test("client: chat() con response 402 tira OpenRouterError con code=MODEL_UNAVAILABLE (no retriable)", async () => {
  const transport = async () => new Response(JSON.stringify({ error: { message: "Insufficient credit" } }), { status: 402 });
  const client = new OpenRouterClient({ apiKey: "sk-or-v1-test", transport });
  await assert.rejects(
    client.chat({ model: "x", messages: [{ role: "user", content: "y" }] }),
    (e: unknown) => e instanceof OpenRouterError && e.code === "MODEL_UNAVAILABLE" && e.retriable === false,
  );
});

await test("client: chat() con response 408 tira OpenRouterError con code=TIMEOUT (retriable)", async () => {
  const transport = async () => new Response(JSON.stringify({ error: { message: "timeout" } }), { status: 408 });
  const client = new OpenRouterClient({ apiKey: "sk-or-v1-test", transport });
  await assert.rejects(
    client.chat({ model: "x", messages: [{ role: "user", content: "y" }] }),
    (e: unknown) => e instanceof OpenRouterError && e.code === "TIMEOUT" && e.retriable === true,
  );
});

await test("client: chat() con response 429 tira OpenRouterError con code=RATE_LIMIT (retriable)", async () => {
  const transport = async () => new Response(JSON.stringify({ error: { message: "rate limit" } }), { status: 429 });
  const client = new OpenRouterClient({ apiKey: "sk-or-v1-test", transport });
  await assert.rejects(
    client.chat({ model: "x", messages: [{ role: "user", content: "y" }] }),
    (e: unknown) => e instanceof OpenRouterError && e.code === "RATE_LIMIT" && e.retriable === true,
  );
});

await test("client: chat() con response 5xx tira OpenRouterError con code=MODEL_UNAVAILABLE (retriable)", async () => {
  for (const status of [500, 502, 503, 504]) {
    const transport = async () => new Response(JSON.stringify({ error: { message: "server error" } }), { status });
    const client = new OpenRouterClient({ apiKey: "sk-or-v1-test", transport });
    await assert.rejects(
      client.chat({ model: "x", messages: [{ role: "user", content: "y" }] }),
      (e: unknown) => e instanceof OpenRouterError && e.code === "MODEL_UNAVAILABLE" && e.retriable === true,
      `status ${status}`,
    );
  }
});

await test("client: chat() con response 200 y choices vacío tira InvalidResponseError", async () => {
  const transport = async () => new Response(JSON.stringify({ choices: [] }), { status: 200 });
  const client = new OpenRouterClient({ apiKey: "sk-or-v1-test", transport });
  await assert.rejects(
    client.chat({ model: "x", messages: [{ role: "user", content: "y" }] }),
    InvalidResponseError,
  );
});

await test("client: chat() con response 200 y body no JSON tira InvalidResponseError", async () => {
  const transport = async () => new Response("<html>error</html>", { status: 200, headers: { "Content-Type": "text/html" } });
  const client = new OpenRouterClient({ apiKey: "sk-or-v1-test", transport });
  await assert.rejects(
    client.chat({ model: "x", messages: [{ role: "user", content: "y" }] }),
    InvalidResponseError,
  );
});

await test("client: chat() con transport que tira network error → OpenRouterError(NETWORK_ERROR)", async () => {
  const transport = async () => {
    throw new TypeError("fetch failed: ECONNREFUSED");
  };
  const client = new OpenRouterClient({ apiKey: "sk-or-v1-test", transport });
  await assert.rejects(
    client.chat({ model: "x", messages: [{ role: "user", content: "y" }] }),
    (e: unknown) => e instanceof OpenRouterError && e.code === "NETWORK_ERROR" && e.retriable === true,
  );
});

await test("client: embeddings() con response 200 válido retorna EmbeddingResponse", async () => {
  const transport = async () =>
    new Response(
      JSON.stringify({
        model: "qwen/qwen3-embedding-8b",
        data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }],
        usage: { prompt_tokens: 5, total_tokens: 5, cost: 0.000001 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  const client = new OpenRouterClient({ apiKey: "sk-or-v1-test", transport });
  const response = await client.embeddings({ model: "qwen/qwen3-embedding-8b", input: "test" });
  assert.deepEqual(response.embedding, [0.1, 0.2, 0.3, 0.4]);
  assert.equal(response.tokensUsed, 5);
  assert.equal(response.modelUsed, "qwen/qwen3-embedding-8b");
});

// ============================================================
// §6.2. PricingCatalog (5 tests)
// ============================================================

console.log("\n── PricingCatalog ──");

await test("catalog: get() con modelo existente retorna su pricing", () => {
  const catalog = new PricingCatalog();
  const p = catalog.get("anthropic/claude-3.5-sonnet");
  assert.ok(p !== undefined);
  assert.equal(p!.promptUsdPerM, 3.00);
  assert.equal(p!.completionUsdPerM, 15.00);
});

await test("catalog: get() con modelo inexistente retorna undefined", () => {
  const catalog = new PricingCatalog();
  assert.equal(catalog.get("no/existe"), undefined);
});

await test("catalog: set() agrega o sobrescribe un modelo", () => {
  const catalog = new PricingCatalog();
  catalog.set("custom/model", { promptUsdPerM: 1.0, completionUsdPerM: 2.0, currency: "USD" });
  const p = catalog.get("custom/model");
  assert.equal(p?.promptUsdPerM, 1.0);
  assert.equal(p?.completionUsdPerM, 2.0);
  // Sobrescribir:
  catalog.set("custom/model", { promptUsdPerM: 0.5, completionUsdPerM: 1.0, currency: "USD" });
  assert.equal(catalog.get("custom/model")?.promptUsdPerM, 0.5);
});

await test("catalog: extend() retorna NUEVO catálogo con merge (no muta el original)", () => {
  const original = new PricingCatalog();
  const nuevo = original.extend({ "nuevo/model": { promptUsdPerM: 0.01, completionUsdPerM: 0.02, currency: "USD" } });
  assert.equal(original.get("nuevo/model"), undefined, "el original no se muta");
  assert.equal(nuevo.get("nuevo/model")?.promptUsdPerM, 0.01);
  // El nuevo hereda los precios del original:
  assert.equal(nuevo.get("anthropic/claude-3.5-sonnet")?.promptUsdPerM, 3.00);
});

await test("catalog: estimateCost() calcula correctamente con la fórmula de la spec", () => {
  const catalog = new PricingCatalog();
  // deepseek/deepseek-chat: 0.14 prompt + 0.28 completion per 1M
  // 1_000_000 input + 1_000_000 output = 0.14 + 0.28 = 0.42 USD
  assert.equal(catalog.estimateCost("deepseek/deepseek-chat", 1_000_000, 1_000_000), 0.42);
  // 1000 input + 500 output = (1000/1M * 0.14) + (500/1M * 0.28) = 0.00014 + 0.00014 = 0.00028
  assert.equal(catalog.estimateCost("deepseek/deepseek-chat", 1000, 500), 0.00028);
  // Modelo no catalogado: 0
  assert.equal(catalog.estimateCost("no/existe", 100, 100), 0);
});

// ============================================================
// §6.3. OpenRouterLLMInvoker (8 tests)
// ============================================================

console.log("\n── OpenRouterLLMInvoker ──");

/** Helper: cliente mockeado que retorna la response que el caller quiera. */
function makeMockClient(responses: Array<{ status: number; body: unknown }> | { status: number; body: unknown }): {
  client: OpenRouterClient;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const transport = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = queue.shift() ?? { status: 200, body: { choices: [{ message: { content: "{}" } }] } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
  };
  return { client: new OpenRouterClient({ apiKey: "sk-or-v1-test", transport }), calls };
}

await test("invoker: invoke() con systemPrompt y userPrompt los traduce a messages: [...]", async () => {
  const { client, calls } = makeMockClient({ status: 200, body: { model: "deepseek/deepseek-chat", choices: [{ message: { content: "ok" } }] } });
  const invoker = new OpenRouterLLMInvoker(client);
  await invoker.invoke({ model: "liviano", systemPrompt: "Sos X", userPrompt: "Hola" });
  const body = JSON.parse(calls[0]!.init.body as string) as { messages: Array<{ role: string; content: string }> };
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0]?.role, "system");
  assert.equal(body.messages[0]?.content, "Sos X");
  assert.equal(body.messages[1]?.role, "user");
  assert.equal(body.messages[1]?.content, "Hola");
});

await test("invoker: invoke() con outputSchema parsea el output como JSON", async () => {
  const { client } = makeMockClient({ status: 200, body: { model: "m", choices: [{ message: { content: '{"verified":true,"confidence":0.9,"notes":"ok"}' } }] } });
  const invoker = new OpenRouterLLMInvoker(client);
  const result = await invoker.invoke({ model: "robusto", systemPrompt: "Sos Y", userPrompt: "z", outputSchema: { type: "object" } });
  assert.deepEqual(result.output, { verified: true, confidence: 0.9, notes: "ok" });
});

await test("invoker: invoke() con outputSchema y output NO JSON → retorna string raw", async () => {
  const { client } = makeMockClient({ status: 200, body: { model: "m", choices: [{ message: { content: "no soy json" } }] } });
  const invoker = new OpenRouterLLMInvoker(client);
  const result = await invoker.invoke({ model: "robusto", systemPrompt: "Sos Y", userPrompt: "z", outputSchema: { type: "object" } });
  assert.equal(result.output, "no soy json");
});

await test("invoker: invoke() con usage.cost en response lo retorna en costUsd", async () => {
  const { client } = makeMockClient({
    status: 200,
    body: {
      model: "m",
      choices: [{ message: { content: "{}" } }],
      usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.123 },
    },
  });
  const invoker = new OpenRouterLLMInvoker(client);
  const result = await invoker.invoke({ model: "robusto", systemPrompt: "S", userPrompt: "U" });
  assert.equal(result.costUsd, 0.123);
});

await test("invoker: invoke() sin usage.cost usa catalog.estimateCost() como fallback", async () => {
  const { client } = makeMockClient({
    status: 200,
    body: { model: "deepseek/deepseek-chat", choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 1000, completion_tokens: 500 } },
  });
  const catalog = new PricingCatalog();
  const invoker = new OpenRouterLLMInvoker(client, { catalog });
  const result = await invoker.invoke({ model: "liviano", systemPrompt: "S", userPrompt: "U" });
  // 1000/1M * 0.14 + 500/1M * 0.28 = 0.00014 + 0.00014 = 0.00028
  assert.equal(result.costUsd, 0.00028);
});

await test("invoker: invoke() traduce ModelRef liviano/robusto a modelId de OpenRouter", async () => {
  const { client, calls } = makeMockClient({ status: 200, body: { model: "m", choices: [{ message: { content: "{}" } }] } });
  const invoker = new OpenRouterLLMInvoker(client);
  await invoker.invoke({ model: "liviano", systemPrompt: "S", userPrompt: "U" });
  assert.equal((JSON.parse(calls[0]!.init.body as string) as { model: string }).model, "deepseek/deepseek-chat");
  await invoker.invoke({ model: "robusto", systemPrompt: "S", userPrompt: "U" });
  assert.equal((JSON.parse(calls[1]!.init.body as string) as { model: string }).model, "anthropic/claude-3.5-sonnet");
});

await test("invoker: invoke() sin systemPrompt ni userPrompt tira error", async () => {
  const { client } = makeMockClient({ status: 200, body: { model: "m", choices: [{ message: { content: "{}" } }] } });
  const invoker = new OpenRouterLLMInvoker(client);
  await assert.rejects(invoker.invoke({ model: "robusto" }), OpenRouterError);
});

await test("invoker: invoke() propaga errores del cliente con su code", async () => {
  const { client } = makeMockClient({ status: 429, body: { error: { message: "rate limit" } } });
  const invoker = new OpenRouterLLMInvoker(client);
  await assert.rejects(
    invoker.invoke({ model: "robusto", systemPrompt: "S", userPrompt: "U" }),
    (e: unknown) => e instanceof OpenRouterError && e.code === "RATE_LIMIT",
  );
});

// CRIT-2 (audit D2 2026-06-12): tools declaradas sin catálogo deben fallar loud.
await test("invoker: invoke() con tools declaradas y SIN toolCatalog → tira error (no pierde tools en silencio)", async () => {
  const { client } = makeMockClient({ status: 200, body: { model: "m", choices: [{ message: { content: "ok" } }] } });
  // Sin toolCatalog (D2b.2 default).
  const invoker = new OpenRouterLLMInvoker(client);
  await assert.rejects(
    invoker.invoke({ model: "robusto", systemPrompt: "S", userPrompt: "U", tools: ["search_web"] }),
    (e: unknown) =>
      e instanceof OpenRouterError &&
      e.code === "INTERNAL_ERROR" &&
      e.message.includes("search_web") &&
      e.message.includes("catálogo de tools no está registrado"),
    "workflow con tools sin catálogo debe fallar loud (CRIT-2)",
  );
});

await test("invoker: invoke() con toolCatalog registrado y tool existente → la traduce al body", async () => {
  const { client, calls } = makeMockClient({ status: 200, body: { model: "m", choices: [{ message: { content: "ok" } }] } });
  const catalog = new Map<string, { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }>();
  catalog.set("search_web", {
    type: "function",
    function: { name: "search_web", description: "Search the web", parameters: { type: "object" } },
  });
  const invoker = new OpenRouterLLMInvoker(client, { toolCatalog: catalog });
  await invoker.invoke({ model: "robusto", systemPrompt: "S", userPrompt: "U", tools: ["search_web"] });
  // La request body tiene que incluir la tool traducida.
  const body = JSON.parse(calls[0]!.init.body as string) as { tools?: Array<{ type: string; function: { name: string } }> };
  assert.ok(Array.isArray(body.tools), "body.tools debe existir");
  assert.equal(body.tools!.length, 1);
  assert.equal(body.tools![0]!.function.name, "search_web");
});

await test("invoker: invoke() con toolCatalog pero tool inexistente → tira error (no alucina tool no registrada)", async () => {
  const { client } = makeMockClient({ status: 200, body: { model: "m", choices: [{ message: { content: "ok" } }] } });
  const catalog = new Map<string, { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }>();
  // El catálogo tiene "search_web" pero el workflow pide "ask_human".
  catalog.set("search_web", { type: "function", function: { name: "search_web", description: "x", parameters: {} } });
  const invoker = new OpenRouterLLMInvoker(client, { toolCatalog: catalog });
  await assert.rejects(
    invoker.invoke({ model: "robusto", systemPrompt: "S", userPrompt: "U", tools: ["ask_human"] }),
    (e: unknown) =>
      e instanceof OpenRouterError &&
      e.code === "INTERNAL_ERROR" &&
      e.message.includes("ask_human") &&
      e.message.includes("no existe en el catálogo"),
    "tool declarada pero no en catálogo debe fallar loud",
  );
});

// ============================================================
// §6.4. AgentCard (5 tests)
// ============================================================

console.log("\n── AgentCard ──");

await test("agentCard: toJSON() produce JSON con name, version, capabilities, skills, securitySchemes", () => {
  const card: AgentCard = buildAgentCard({
    name: "Test Agent",
    description: "Test",
    version: "1.0.0",
    provider: { organization: "Worgena" },
    url: "https://example.com/agent",
    skills: [{ id: "s1", name: "Skill 1", description: "desc", tags: ["t1"] }],
  });
  const json = agentCardToJSON(card);
  assert.equal(json["name"], "Test Agent");
  assert.equal(json["version"], "1.0.0");
  assert.ok(json["capabilities"] !== undefined);
  assert.ok(json["skills"] !== undefined);
  assert.ok(json["securitySchemes"] !== undefined);
  assert.equal((json["provider"] as { organization: string }).organization, "Worgena");
});

await test("agentCard: capabilities default es streaming=false, pushNotifications=false, extendedAgentCard=false", () => {
  const card = buildAgentCard({
    name: "X", description: "Y", version: "1.0.0", provider: { organization: "W" }, url: "x", skills: [],
  });
  assert.equal(card.capabilities.streaming, false);
  assert.equal(card.capabilities.pushNotifications, false);
  assert.equal(card.capabilities.extendedAgentCard, false);
});

await test("agentCard: pricing y limits son opcionales (no aparecen en toJSON si no se pasan)", () => {
  const card = buildAgentCard({
    name: "X", description: "Y", version: "1.0.0", provider: { organization: "W" }, url: "x", skills: [],
  });
  assert.equal(card.pricing, undefined);
  assert.equal(card.limits, undefined);
  const json = agentCardToJSON(card);
  assert.equal(json["pricing"], undefined);
  assert.equal(json["limits"], undefined);
});

await test("agentCard: pricing y limits se incluyen en toJSON cuando se pasan", () => {
  const card = buildAgentCard({
    name: "X", description: "Y", version: "1.0.0", provider: { organization: "W" }, url: "x", skills: [],
    pricing: { promptUsdPerM: 0.1, completionUsdPerM: 0.2, currency: "USD" },
    limits: { maxTokens: 1000, maxRequestsPerMinute: 10, maxConcurrent: 2 },
  });
  const json = agentCardToJSON(card);
  assert.deepEqual(json["pricing"], { promptUsdPerM: 0.1, completionUsdPerM: 0.2, currency: "USD" });
  assert.deepEqual(json["limits"], { maxTokens: 1000, maxRequestsPerMinute: 10, maxConcurrent: 2 });
});

await test("agentCard: INTAKE/CLAUSE_REVIEWER/VERIFIER_AGENT_CARD tienen agentId matching su nombre de card", () => {
  assert.equal(INTAKE_AGENT_CARD.name, "Intake Specialist");
  assert.equal(INTAKE_AGENT_CARD.version, "1.0.0");
  assert.equal(CLAUSE_REVIEWER_AGENT_CARD.name, "Clause Reviewer Specialist");
  assert.equal(CLAUSE_REVIEWER_AGENT_CARD.version, "1.0.0");
  assert.equal(VERIFIER_AGENT_CARD.name, "Verifier Specialist");
  assert.equal(VERIFIER_AGENT_CARD.version, "1.0.0");
  assert.ok(AGENT_CARDS_BY_ID[INTAKE_AGENT_CARD.name] === INTAKE_AGENT_CARD);
  assert.ok(AGENT_CARDS_BY_ID[VERIFIER_AGENT_CARD.name] === VERIFIER_AGENT_CARD);
});

// ============================================================
// §6.5. Lifecycle (8 tests)
// ============================================================

console.log("\n── Lifecycle ──");

await test("lifecycle: arranca en 'spawn'", () => {
  const lc = new Lifecycle();
  assert.equal(lc.state, "spawn");
});

await test("lifecycle: transición spawn → idle es válida", () => {
  const lc = new Lifecycle();
  lc.transition("idle", "registered");
  assert.equal(lc.state, "idle");
});

await test("lifecycle: transición idle → busy es válida", () => {
  const lc = new Lifecycle();
  lc.transition("idle", "registered");
  lc.transition("busy", "starting");
  assert.equal(lc.state, "busy");
});

await test("lifecycle: transición busy → done es válida", () => {
  const lc = new Lifecycle();
  lc.transition("idle");
  lc.transition("busy");
  lc.transition("done");
  assert.equal(lc.state, "done");
});

await test("lifecycle: transición busy → paused es válida", () => {
  const lc = new Lifecycle();
  lc.transition("idle");
  lc.transition("busy");
  lc.transition("paused", "HITL pause");
  assert.equal(lc.state, "paused");
});

await test("lifecycle: transición inválida (spawn → busy) tira error", () => {
  const lc = new Lifecycle();
  assert.throws(() => lc.transition("busy"), /Invalid lifecycle transition: spawn → busy/);
});

await test("lifecycle: events array se popula en cada transición", () => {
  const lc = new Lifecycle();
  lc.transition("idle", "registered");
  lc.transition("busy", "starting");
  lc.transition("done", "completed");
  assert.equal(lc.events.length, 3);
  assert.equal(lc.events[0]?.from, "spawn");
  assert.equal(lc.events[0]?.to, "idle");
  assert.equal(lc.events[0]?.reason, "registered");
  assert.equal(lc.events[2]?.to, "done");
});

await test("lifecycle: stateChangedAt se actualiza en cada transición", async () => {
  const lc = new Lifecycle();
  const t0 = lc.stateChangedAt;
  // Pequeño delay para que el timestamp cambie.
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  await wait(5);
  lc.transition("idle");
  const t1 = lc.stateChangedAt;
  assert.notEqual(t0, t1, "stateChangedAt cambia después de transition");
  // Verifica que es un ISO válido.
  assert.ok(!isNaN(Date.parse(t1)));
});

// ============================================================
// §6.6. Specialists con cards y lifecycle (6 tests)
// ============================================================

console.log("\n── Specialists con cards y lifecycle ──");

await test("specialists: cada specialist tiene agentCard con agentId matching", () => {
  const livInvoker = new MockDeepSeekFlashInvoker();
  const robInvoker = new MockM3ThinkingInvoker();
  const intake = new IntakeSpecialist(livInvoker);
  const clause = new ClauseReviewerSpecialist(robInvoker);
  const verifier = new VerifierSpecialist(robInvoker);
  assert.equal(intake.agentCard.name, "Intake Specialist");
  assert.equal(clause.agentCard.name, "Clause Reviewer Specialist");
  assert.equal(verifier.agentCard.name, "Verifier Specialist");
  assert.equal(intake.agentId, "intake_specialist_v1");
  assert.equal(clause.agentId, "clause_reviewer_specialist_v1");
  assert.equal(verifier.agentId, "verifier_specialist_v1");
});

await test("specialists: cada specialist tiene lifecycle que arranca en 'spawn' y se mueve a 'idle' en constructor", () => {
  const intake = new IntakeSpecialist(new MockDeepSeekFlashInvoker());
  assert.equal(intake.lifecycle.state, "idle", "constructor transiciona spawn→idle");
  assert.equal(intake.lifecycle.events.length, 1);
  assert.equal(intake.lifecycle.events[0]?.from, "spawn");
  assert.equal(intake.lifecycle.events[0]?.to, "idle");
});

await test("specialists: execute() exitoso transiciona idle → busy → done", async () => {
  const intake = new IntakeSpecialist(new MockDeepSeekFlashInvoker());
  const node: LLMNode = {
    id: "n1", type: "llm", model: "liviano",
    userPrompt: "test",
    input: { from: { template: "x" } },
    output: { to: { path: "y" } },
  };
  await intake.execute({ node, task: {} as never, state: { input: "doc" } as never });
  // spawn→idle (constructor) + idle→busy + busy→done
  const events = intake.lifecycle.events;
  assert.equal(events.length, 3);
  assert.equal(events[0]?.to, "idle");
  assert.equal(events[1]?.to, "busy");
  assert.equal(events[2]?.to, "done");
});

await test("specialists: execute() con error transiciona a 'archived'", async () => {
  const invoker: LLMInvoker = {
    async invoke(): Promise<LLMInvokeResult> { throw new Error("LLM falló"); },
  };
  const intake = new IntakeSpecialist(invoker);
  const node: LLMNode = {
    id: "n1", type: "llm", model: "liviano",
    userPrompt: "test",
    input: { from: { template: "x" } },
    output: { to: { path: "y" } },
  };
  const result = await intake.execute({ node, task: {} as never, state: { input: "doc" } as never });
  assert.equal(result.status, "failed");
  assert.equal(intake.lifecycle.state, "archived");
  const lastEvent = intake.lifecycle.events[intake.lifecycle.events.length - 1];
  assert.equal(lastEvent?.to, "archived");
  assert.ok(lastEvent?.reason?.includes("LLM falló"));
});

await test("specialists: agentVersion es '1.0.0' (no '1.0.0-d2b.1')", () => {
  const intake = new IntakeSpecialist(new MockDeepSeekFlashInvoker());
  const clause = new ClauseReviewerSpecialist(new MockM3ThinkingInvoker());
  const verifier = new VerifierSpecialist(new MockM3ThinkingInvoker());
  assert.equal(intake.agentVersion, "1.0.0");
  assert.equal(clause.agentVersion, "1.0.0");
  assert.equal(verifier.agentVersion, "1.0.0");
});

await test("specialists: agentCard.toJSON() es serializable a JSON", () => {
  const json = JSON.stringify(agentCardToJSON(INTAKE_AGENT_CARD));
  assert.ok(json.includes("Intake Specialist"));
  assert.ok(json.includes("anthropic") === false, "INTAKE no menciona anthropic (es tier liviano)");
  // Round-trip:
  const parsed = JSON.parse(json);
  assert.equal(parsed.name, "Intake Specialist");
  assert.ok(Array.isArray(parsed.skills));
});

// ============================================================
// §6.7. VerifierSpecialist con sub-sesión + Citation Grounding v2 (8 tests)
// ============================================================

console.log("\n── VerifierSpecialist sub-sesión + Citation Grounding v2 ──");

/** Stub LLM que retorna el output que el caller le pasa. */
function makeVerifierStub(output: unknown): LLMInvoker {
  return {
    async invoke(): Promise<LLMInvokeResult> {
      return { output, tokensUsed: { input: 1, output: 1 }, modelUsed: "stub" };
    },
  };
}

await test("verifier: execute() NO lee params.node.systemPrompt del productor", async () => {
  // Capturamos los params que recibe el LLM.
  let receivedSystemPrompt: string | undefined;
  const stub: LLMInvoker = {
    async invoke(p: LLMInvokeParams): Promise<LLMInvokeResult> {
      receivedSystemPrompt = p.systemPrompt;
      return {
        output: { verified: true, confidence: 0.9, notes: "ok" },
        tokensUsed: { input: 1, output: 1 },
        modelUsed: "stub",
      };
    },
  };
  const verifier = new VerifierSpecialist(stub);
  // El nodo del productor tiene un system prompt "delicado" — el verifier NO debe leerlo.
  const node: LLMNode = {
    id: "n1", type: "llm", model: "robusto",
    systemPrompt: "ESTE PROMPT ES DEL PRODUCTOR — EL VERIFIER NO DEBE USARLO",
    userPrompt: "input del productor",
    input: { from: { template: "x" } },
    output: { to: { path: "y" } },
  };
  await verifier.execute({ node, task: {} as never, state: { input: "x" } as never });
  assert.ok(receivedSystemPrompt !== undefined);
  assert.ok(!receivedSystemPrompt!.includes("DEL PRODUCTOR"), "el verifier no usa el system prompt del productor");
  assert.ok(receivedSystemPrompt!.includes("verificador independiente"), "el verifier usa su propio system prompt");
});

await test("verifier: execute() retorna output.verifierSessionId (UUID válido)", async () => {
  const verifier = new VerifierSpecialist(makeVerifierStub({ verified: true, confidence: 0.9, notes: "ok" }));
  const node: LLMNode = {
    id: "n1", type: "llm", model: "robusto",
    userPrompt: "x",
    input: { from: { template: "y" } },
    output: { to: { path: "z" } },
  };
  const result = await verifier.execute({ node, task: {} as never, state: { input: "y" } as never });
  assert.ok(result.status === "completed");
  const out = (result as { output: { verifierSessionId: string } }).output;
  assert.ok(typeof out.verifierSessionId === "string");
  // UUID format: 8-4-4-4-12
  assert.match(out.verifierSessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
});

await test("verifier: execute() retorna output.verifiedAt (ISO timestamp)", async () => {
  const verifier = new VerifierSpecialist(makeVerifierStub({ verified: true, confidence: 0.9, notes: "ok" }));
  const node: LLMNode = {
    id: "n1", type: "llm", model: "robusto",
    userPrompt: "x",
    input: { from: { template: "y" } },
    output: { to: { path: "z" } },
  };
  const result = await verifier.execute({ node, task: {} as never, state: { input: "y" } as never });
  const out = (result as { output: { verifiedAt: string } }).output;
  assert.ok(typeof out.verifiedAt === "string");
  assert.ok(!isNaN(Date.parse(out.verifiedAt)), "verifiedAt es ISO válido");
});

await test("verifier: Citation Grounding v2 — citas a texto válidas → verified=true", async () => {
  // El LLM retorna un output con notas que mencionan una cita a texto
  // en formato Citation Grounding v2 ([Doc X, '...']).
  // El state contiene ese texto. El verifier debe validar la cita.
  const stub = makeVerifierStub({
    verified: true,
    confidence: 0.9,
    notes: "Citando a [Doc 1, 'rango 1234-5678'] del contexto.",
  });
  const verifier = new VerifierSpecialist(stub);
  const node: LLMNode = {
    id: "n1", type: "llm", model: "robusto",
    userPrompt: "x",
    input: { from: { template: "y" } },
    output: { to: { path: "z" } },
  };
  const result = await verifier.execute({
    node,
    task: {} as never,
    state: { input: "y", doc: "Contenido que incluye rango 1234-5678" } as never,
  });
  const out = (result as { output: { verified: boolean; citations: Array<{ type: string; valid: boolean }>; issues: string[] } }).output;
  assert.equal(out.verified, true);
  assert.equal(out.issues.length, 0);
  assert.ok(Array.isArray(out.citations));
  assert.ok(out.citations.length >= 1, "debe detectar al menos una cita");
  assert.equal(out.citations[0]?.type, "text");
  assert.equal(out.citations[0]?.valid, true);
});

await test("verifier: Citation Grounding v2 — citas a texto inválidas → verified=false con issues", async () => {
  const stub = makeVerifierStub({
    verified: true,
    confidence: 0.9,
    notes: "Citando a [Doc 1, 'rango 9999-0000'] que NO está en el contexto.",
  });
  const verifier = new VerifierSpecialist(stub);
  const node: LLMNode = {
    id: "n1", type: "llm", model: "robusto",
    userPrompt: "x",
    input: { from: { template: "y" } },
    output: { to: { path: "z" } },
  };
  const result = await verifier.execute({
    node,
    task: {} as never,
    state: { input: "y", doc: "Contenido con rango 1234-5678" } as never,
  });
  const out = (result as { output: { verified: boolean; issues: string[] } }).output;
  assert.equal(out.verified, false, "el verifier marca false cuando una cita falla");
  assert.ok(out.issues.length > 0);
  assert.ok(out.issues[0]!.includes("9999-0000"));
});

await test("verifier: Citation Grounding v2 — citas a metadatos → valida existencia del campo en el state", async () => {
  const stub = makeVerifierStub({
    verified: true,
    confidence: 0.9,
    notes: "El output cita [Doc 1, derogado_por: 'Ley 2297'].",
  });
  const verifier = new VerifierSpecialist(stub);
  const node: LLMNode = {
    id: "n1", type: "llm", model: "robusto",
    userPrompt: "x",
    input: { from: { template: "y" } },
    output: { to: { path: "z" } },
  };
  // State con el campo derogado_por presente.
  const result = await verifier.execute({
    node,
    task: {} as never,
    state: { input: "y", derogado_por: "Ley 2297" } as never,
  });
  const out = (result as { output: { verified: boolean; citations: Array<{ type: string; valid: boolean }> } }).output;
  assert.equal(out.verified, true);
  assert.equal(out.citations[0]?.type, "metadata");
  assert.equal(out.citations[0]?.valid, true);
});

// MAY-6 (audit D2 2026-06-12): el LLM puede escribir el field con case
// distinto al del state (ej: "DEROGADO_POR" en vez de "derogado_por").
// El verifier debe normalizar a lowercase para que la validación no
// falle por case-sensitivity.
await test("verifier: Citation Grounding v2 — field en MAYÚSCULAS matchea con field lowercase en state", async () => {
  const stub = makeVerifierStub({
    verified: true,
    confidence: 0.9,
    notes: "Citando a [Doc 1, DEROGADO_POR: 'Ley 2297'] con field en mayúsculas.",
  });
  const verifier = new VerifierSpecialist(stub);
  const node: LLMNode = {
    id: "n1", type: "llm", model: "robusto",
    userPrompt: "x",
    input: { from: { template: "y" } },
    output: { to: { path: "z" } },
  };
  // El state tiene "derogado_por" en lowercase (convención).
  const result = await verifier.execute({
    node,
    task: {} as never,
    state: { input: "y", derogado_por: "Ley 2297" } as never,
  });
  const out = (result as { output: { verified: boolean; citations: Array<{ type: string; target: string; valid: boolean }> } }).output;
  assert.equal(out.verified, true, "el verifier debe normalizar el field a lowercase para matchear state");
  assert.equal(out.citations[0]?.type, "metadata");
  // El target del citation debe estar normalizado a lowercase.
  assert.equal(out.citations[0]?.target, "Doc 1.derogado_por");
  assert.equal(out.citations[0]?.valid, true);
});

await test("verifier: VERIFIER_OUTPUT_SCHEMA define el shape del output (verified, confidence, notes)", () => {
  assert.equal(VERIFIER_OUTPUT_SCHEMA["type"], "object");
  const required = VERIFIER_OUTPUT_SCHEMA["required"] as string[];
  assert.ok(required.includes("verified"));
  assert.ok(required.includes("confidence"));
  assert.ok(required.includes("notes"));
});

await test("verifier: el system prompt del verifier es DISTINTO del system prompt del nodo productor", async () => {
  let verifierSystemPrompt: string | undefined;
  const capturingStub: LLMInvoker = {
    async invoke(p: LLMInvokeParams): Promise<LLMInvokeResult> {
      verifierSystemPrompt = p.systemPrompt;
      return { output: { verified: true, confidence: 0.9, notes: "ok" }, tokensUsed: { input: 1, output: 1 }, modelUsed: "stub" };
    },
  };
  const v = new VerifierSpecialist(capturingStub);
  // El nodo productor tiene un system prompt único (marcador).
  const node: LLMNode = {
    id: "n1", type: "llm", model: "robusto",
    systemPrompt: "MARCADOR-UNICO-PRODUCTOR-12345",
    userPrompt: "input",
    input: { from: { template: "y" } },
    output: { to: { path: "z" } },
  };
  await v.execute({ node, task: {} as never, state: { input: "y" } as never });
  assert.ok(verifierSystemPrompt !== undefined);
  assert.ok(
    !verifierSystemPrompt!.includes("MARCADOR-UNICO-PRODUCTOR-12345"),
    "el system prompt del verifier NO contiene el del productor (sub-sesión aislada)",
  );
  assert.ok(verifierSystemPrompt!.includes("verificador"));
});

// ============================================================
// §6.8. Backward-compat (2 tests)
// ============================================================

console.log("\n── Backward-compat ──");

await test("backward-compat: specialists pueden recibir MockDeepSeekFlashInvoker o OpenRouterLLMInvoker indistintamente", async () => {
  // MockDeepSeekFlashInvoker (D2b.1).
  const mockInvoker = new MockDeepSeekFlashInvoker();
  const intake1 = new IntakeSpecialist(mockInvoker);
  const node: LLMNode = {
    id: "n1", type: "llm", model: "liviano",
    userPrompt: "x",
    input: { from: { template: "y" } },
    output: { to: { path: "z" } },
  };
  const r1 = await intake1.execute({ node, task: {} as never, state: { input: "y" } as never });
  assert.equal(r1.status, "completed");

  // OpenRouterLLMInvoker (D2b.2) sobre un cliente mockeado.
  // El intake NO pasa outputSchema por default, así que el invoker
  // retorna el output del LLM como string (no parsea). Por eso
  // el mock retorna un JSON string y validamos el contenido.
  const { client } = makeMockClient({
    status: 200,
    body: { model: "m", choices: [{ message: { content: '{"category":"contrato","confidence":0.9}' } }] },
  });
  const openrouterInvoker = new OpenRouterLLMInvoker(client);
  const intake2 = new IntakeSpecialist(openrouterInvoker);
  const r2 = await intake2.execute({ node, task: {} as never, state: { input: "y" } as never });
  assert.equal(r2.status, "completed");
  // El output es el JSON string crudo (parseo posterior es del motor/state).
  const out = (r2 as { output: unknown }).output;
  assert.ok(typeof out === "string");
  assert.ok((out as string).includes('"category":"contrato"'));
  assert.ok((out as string).includes('"confidence":0.9'));
});

await test("backward-compat: el SpecialistRegistry se construye igual con cualquier LLMInvoker", () => {
  // Con mocks D2b.1.
  const registry1 = SpecialistRegistry.create({
    tierResolver: new DefaultTierResolver(new MockDeepSeekFlashInvoker(), new MockM3ThinkingInvoker()),
    factories: [
      // MAY-7: proveemos preferredModel para evitar la doble construcción.
      { agentId: "intake_specialist_v1", preferredModel: "liviano", factory: (inv) => new IntakeSpecialist(inv) },
      { agentId: "clause_reviewer_specialist_v1", preferredModel: "robusto", factory: (inv) => new ClauseReviewerSpecialist(inv) },
      { agentId: "verifier_specialist_v1", preferredModel: "robusto", factory: (inv) => new VerifierSpecialist(inv) },
    ],
  });
  assert.equal(registry1.listAgentIds().length, 3);
  assert.ok(registry1.get("intake_specialist_v1")?.agentCard.name === "Intake Specialist");

  // Con OpenRouterLLMInvoker (D2b.2).
  const { client } = makeMockClient({ status: 200, body: { model: "m", choices: [{ message: { content: "{}" } }] } });
  const oInv = new OpenRouterLLMInvoker(client);
  const registry2 = SpecialistRegistry.create({
    tierResolver: new DefaultTierResolver(oInv, oInv),
    factories: [
      { agentId: "intake_specialist_v1", preferredModel: "liviano", factory: (inv) => new IntakeSpecialist(inv) },
    ],
  });
  assert.equal(registry2.listAgentIds().length, 1);
});

// MIN-7: SpecialistRegistry tira error si agentId está duplicado.
await test("SpecialistRegistry: tira error si dos factories declaran el mismo agentId", () => {
  assert.throws(
    () => SpecialistRegistry.create({
      tierResolver: new DefaultTierResolver(new MockDeepSeekFlashInvoker(), new MockM3ThinkingInvoker()),
      factories: [
        { agentId: "intake_specialist_v1", preferredModel: "liviano", factory: (inv) => new IntakeSpecialist(inv) },
        { agentId: "intake_specialist_v1", preferredModel: "liviano", factory: (inv) => new IntakeSpecialist(inv) },
      ],
    }),
    (e: unknown) => e instanceof Error && e.message.includes('agentId "intake_specialist_v1" declarado en más de una factory'),
  );
});

// MAY-7 (audit D2 2026-06-12 cleanup #2): cuando el factory provee
// `preferredModel`, el registry NO invoca la factory 2 veces. El
// counter `buildCount` lo verifica.
await test("SpecialistRegistry: con preferredModel, factory se invoca UNA sola vez (no 2)", () => {
  let buildCount = 0;
  const factory = (inv: import("./src/agent/workflow-engine/executor/types.js").LLMInvoker): Specialist => {
    buildCount++;
    return new IntakeSpecialist(inv);
  };
  const registry = SpecialistRegistry.create({
    tierResolver: new DefaultTierResolver(new MockDeepSeekFlashInvoker(), new MockM3ThinkingInvoker()),
    factories: [
      // Con preferredModel: el registry evita la doble construcción.
      { agentId: "intake_specialist_v1", preferredModel: "liviano", factory },
    ],
  });
  assert.equal(buildCount, 1, `factory debería invocarse 1 sola vez, fue ${buildCount}`);
  assert.equal(registry.listAgentIds().length, 1);
});

await test("SpecialistRegistry: SIN preferredModel, factory se invoca 2 veces (patrón viejo, backward-compat)", () => {
  let buildCount = 0;
  const factory = (inv: import("./src/agent/workflow-engine/executor/types.js").LLMInvoker): Specialist => {
    buildCount++;
    return new IntakeSpecialist(inv);
  };
  const registry = SpecialistRegistry.create({
    tierResolver: new DefaultTierResolver(new MockDeepSeekFlashInvoker(), new MockM3ThinkingInvoker()),
    factories: [
      // Sin preferredModel: cae al fallback del stub.
      { agentId: "intake_specialist_v1", factory },
    ],
  });
  assert.equal(buildCount, 2, `factory debería invocarse 2 veces (stub + real), fue ${buildCount}`);
  assert.equal(registry.listAgentIds().length, 1);
});

// ============================================================
// §6.9. Smoke E2E con OpenRouter real (1 test, opcional)
// ============================================================

console.log("\n── Smoke E2E con OpenRouter real (opcional) ──");

await test("smoke E2E: si OPENROUTER_API_KEY está, 1 llamada real a deepseek/deepseek-chat funciona", async () => {
  const key = getOpenRouterKey();
  if (key === null) {
    console.log("    (skipped: OPENROUTER_API_KEY no está en env — test opcional)");
    return;
  }
  const client = new OpenRouterClient({ apiKey: key, timeoutMs: 30_000 });
  const response = await client.chat({
    model: "deepseek/deepseek-chat",
    messages: [{ role: "user", content: "Di 'hola' y nada más." }],
  });
  assert.ok(response.output.length > 0, "OpenRouter retornó output no vacío");
  // El `modelUsed` puede ser un alias de OpenRouter (ej: "deepseek/deepseek-chat-v3").
  // Verificamos que empieza con "deepseek/" (familia de modelos correcta).
  assert.ok(response.modelUsed.startsWith("deepseek/"), `modelUsed=${response.modelUsed} empieza con deepseek/`);
  assert.ok(response.tokensUsed.input > 0, "tokens de input > 0");
  // El cost puede ser 0 si el modelo no devuelve usage.cost, pero
  // los tokens sí están siempre.
  console.log(`    (smoke E2E: modelUsed=${response.modelUsed}, costUsd=${response.costUsd})`);
});

// ============================================================
// Resumen
// ============================================================

console.log(`\n${passed} tests pasaron, ${failed} fallaron`);
if (failed > 0) process.exit(1);
