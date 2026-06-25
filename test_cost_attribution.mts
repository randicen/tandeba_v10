/**
 * Backlog P0 #3 — Cost Attribution por Tenant (Sprint Tests).
 *
 * Tests E2E del cableado entre OpenRouterLLMInvoker y WorkflowAudit
 * para registrar eventos `llm_call` con tenantId/taskId/nodeId/costUsd.
 *
 * Bloque A (1-2): Happy path — invoker con audit registra eventos.
 * Bloque B (3-4): Backward-compat — invoker sin audit es no-op.
 * Bloque C (5-6): Multi-node attribution + priority de cost source.
 *
 * Total: 6 tests.
 *
 * Spec: AGENT_SPRINT_COST_ATTRIBUTION_SPEC.md §7.
 */

import { OpenRouterLLMInvoker } from "./src/agent/llm/openrouter-invoker.js";
import {
  OpenRouterClient,
  type ChatResponse,
} from "./src/agent/llm/openrouter-client.js";
import { PricingCatalog } from "./src/agent/llm/pricing-catalog.js";
import { InMemoryWorkflowAudit } from "./src/agent/workflow-engine/persistence/in-memory-workflow-audit.js";
import type { LLMCallAuditEvent } from "./src/agent/workflow-engine/persistence/workflow-audit.js";
import type { LLMInvokeParams } from "./src/agent/workflow-engine/executor/types.js";
import assert from "node:assert/strict";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((e) => {
      failed++;
      console.error(`  ✗ ${name}`);
      console.error(`    ${e instanceof Error ? e.message : String(e)}`);
      if (e instanceof Error && e.stack) {
        console.error(`    ${e.stack.split("\n").slice(1, 3).join("\n")}`);
      }
    });
}

// ============================================================
// Helpers
// ============================================================

/**
 * Crea un OpenRouterClient con un transport mockeado que retorna
 * respuestas deterministas. El mock respeta `usage.cost` si se pasa.
 */
function createMockClient(opts: {
  costUsd?: number;
  failOnChat?: boolean;
}): OpenRouterClient {
  const cost = opts.costUsd ?? 0.001;
  const transport = async (
    _url: string,
    _init: RequestInit,
  ): Promise<Response> => {
    if (opts.failOnChat) {
      return new Response(JSON.stringify({ error: "mocked failure" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    const body = {
      id: "chatcmpl-mock",
      model: "anthropic/claude-3.5-sonnet",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: '{"result": "ok"}' },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        cost,
      },
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return new OpenRouterClient({
    apiKey: "mock-key",
    transport,
    logger: {
      // Logger silencioso para tests
      debug: () => {},
      warn: () => {},
      error: () => {},
    },
  });
}

function makeInvokeParams(
  overrides: Partial<LLMInvokeParams> = {},
): LLMInvokeParams {
  return {
    model: "robusto",
    systemPrompt: "Eres un asistente",
    userPrompt: "Hola",
    ...overrides,
  };
}

// ============================================================
// Bloque A: Happy path
// ============================================================

async function bloqueA(): Promise<void> {
  await test("A1: invoker con audit: cada chat() registra 1 row con cost + tokens", async () => {
    const audit = new InMemoryWorkflowAudit();
    const client = createMockClient({ costUsd: 0.05 });
    const invoker = new OpenRouterLLMInvoker(client, {
      audit,
      catalog: new PricingCatalog(),
    });

    await invoker.invoke(
      makeInvokeParams({
        tenantId: "tenant-abc",
        taskId: "task-001",
        nodeId: "node-1",
      }),
    );

    const llmCalls = audit.query({ eventType: "llm_call" });
    assert.strictEqual(llmCalls.length, 1, "1 evento registrado");
    const evt = llmCalls[0] as LLMCallAuditEvent;
    assert.strictEqual(evt.tenantId, "tenant-abc");
    assert.strictEqual(evt.taskId, "task-001");
    assert.strictEqual(evt.nodeId, "node-1");
    assert.strictEqual(evt.costUsd, 0.05);
    assert.strictEqual(evt.inputTokens, 100);
    assert.strictEqual(evt.outputTokens, 50);
    assert.ok(evt.model.includes("claude"), `model es ${evt.model}`);
    assert.ok(evt.durationMs > 0, "durationMs > 0");
  });

  await test("A2: 5 nodos consecutivos: 5 rows con costUsd consistente", async () => {
    const audit = new InMemoryWorkflowAudit();
    const client = createMockClient({ costUsd: 0.02 });
    const invoker = new OpenRouterLLMInvoker(client, {
      audit,
      catalog: new PricingCatalog(),
    });

    for (let i = 1; i <= 5; i++) {
      await invoker.invoke(
        makeInvokeParams({
          tenantId: "tenant-xyz",
          taskId: "task-5nodos",
          nodeId: `node-${i}`,
        }),
      );
    }

    const llmCalls = audit.query({
      eventType: "llm_call",
      taskId: "task-5nodos",
    });
    assert.strictEqual(llmCalls.length, 5, "5 eventos");
    const totalCost = llmCalls.reduce(
      (sum, e) => sum + (e as LLMCallAuditEvent).costUsd,
      0,
    );
    assert.strictEqual(totalCost, 0.1, "5 * 0.02 = 0.10 USD total");
    const totalInput = llmCalls.reduce(
      (sum, e) => sum + (e as LLMCallAuditEvent).inputTokens,
      0,
    );
    assert.strictEqual(totalInput, 500, "5 * 100 = 500 input tokens");
  });
}

// ============================================================
// Bloque B: Backward-compat
// ============================================================

async function bloqueB(): Promise<void> {
  await test("B3: invoker sin audit: NO registra nada (no-op)", async () => {
    const client = createMockClient({ costUsd: 0.05 });
    const invoker = new OpenRouterLLMInvoker(client, {
      // Sin `audit` field
      catalog: new PricingCatalog(),
    });

    const result = await invoker.invoke(
      makeInvokeParams({
        tenantId: "tenant-abc",
        taskId: "task-001",
        nodeId: "node-1",
      }),
    );

    // El LLM call retorna OK con cost
    assert.strictEqual(result.costUsd, 0.05);
    // Pero no hay audit donde persistir (test passes if no error)
  });

  await test("B4: invoker con audit + sin tenantId/taskId: NO registra", async () => {
    const audit = new InMemoryWorkflowAudit();
    const client = createMockClient({ costUsd: 0.05 });
    const invoker = new OpenRouterLLMInvoker(client, {
      audit,
      catalog: new PricingCatalog(),
    });

    // Solo model + prompts, sin el context de cost attribution
    await invoker.invoke(makeInvokeParams({}));

    const llmCalls = audit.query({ eventType: "llm_call" });
    assert.strictEqual(
      llmCalls.length,
      0,
      "NO registra evento sin tenantId/taskId/nodeId",
    );
  });
}

// ============================================================
// Bloque C: Failure path + priority
// ============================================================

async function bloqueC(): Promise<void> {
  await test("C5: failure path (API error): NO registra cost=0", async () => {
    const audit = new InMemoryWorkflowAudit();
    const client = createMockClient({ failOnChat: true });
    const invoker = new OpenRouterLLMInvoker(client, {
      audit,
      catalog: new PricingCatalog(),
    });

    let threw = false;
    try {
      await invoker.invoke(
        makeInvokeParams({
          tenantId: "tenant-abc",
          taskId: "task-001",
          nodeId: "node-1",
        }),
      );
    } catch {
      threw = true;
    }
    assert.ok(threw, "el LLM call falló y debe throwear");

    const llmCalls = audit.query({ eventType: "llm_call" });
    assert.strictEqual(
      llmCalls.length,
      0,
      "NO registra cost=0 cuando el call falló",
    );
  });

  await test("C6: costUsd usa usage.cost de OpenRouter (priority sobre fallback)", async () => {
    // Mock retorna usage.cost = 0.123 (específico)
    const audit = new InMemoryWorkflowAudit();
    const client = createMockClient({ costUsd: 0.123 });
    // Catálogo daría un valor distinto
    const catalog = new PricingCatalog();
    const invoker = new OpenRouterLLMInvoker(client, {
      audit,
      catalog,
    });

    const result = await invoker.invoke(
      makeInvokeParams({
        tenantId: "tenant-abc",
        taskId: "task-001",
        nodeId: "node-1",
      }),
    );

    // OpenRouter usage.cost pisa la estimación
    assert.strictEqual(result.costUsd, 0.123);
    const evt = audit.query({ eventType: "llm_call" })[0] as LLMCallAuditEvent;
    assert.strictEqual(evt.costUsd, 0.123, "audit registra el mismo cost que el call");
  });
}

// ============================================================
// Run
// ============================================================

async function main(): Promise<void> {
  console.log("[Bloque A] Happy path");
  await bloqueA();

  console.log("\n[Bloque B] Backward-compat");
  await bloqueB();

  console.log("\n[Bloque C] Failure path + priority");
  await bloqueC();

  console.log(`\n=== Resultado: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Test runner failed:", e);
  process.exit(1);
});