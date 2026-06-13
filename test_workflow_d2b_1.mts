/**
 * D2b.1 — Multi-Model Router + 3 Specialists: Tests.
 *
 * Fuente de verdad: `AGENT_D2B_1_SPEC.md`.
 *
 * Cubre:
 * - TierResolver: 3 tests (liviano, robusto, fallback).
 * - 3 specialists con mocks: 3 tests (Intake, ClauseReviewer, Verifier).
 * - Routing del motor: 3 tests (con/sin specialist, end-to-end).
 * - Audit/metadata: 2 tests (executedBy, cost).
 * - Compatibilidad con primitivas D2a.4: 3 tests (confidence gating,
 *   prompt snapshot, circuit breaker).
 * - Error handling: 1 test (specialist tira, nodo failed).
 *
 * Patrón: igual que `test_workflow_d2a_5.mts`. Counter de passed/failed
 * con `assert` (Node built-in). No usa libs externas.
 *
 * Total: 15 tests.
 */

import { readFileSync } from "node:fs";
import {
  WorkflowExecutor,
  FunctionRegistry,
  ExecutorError,
  NoopCircuitBreaker,
} from "./src/agent/workflow-engine/executor/index.js";
import type {
  LLMInvoker,
  LLMInvokeParams,
  LLMInvokeResult,
  HITLHandler,
  HITLInitiateParams,
  HITLInitiateResult,
  WorkflowFunction,
} from "./src/agent/workflow-engine/executor/index.js";
import type { WorkflowDefinition } from "./src/agent/workflow-engine/dsl/types.js";
import type { CircuitBreaker } from "./src/agent/workflow-engine/executor/circuit-breaker.js";
import {
  DefaultTierResolver,
  IntakeSpecialist,
  ClauseReviewerSpecialist,
  VerifierSpecialist,
  SpecialistRegistry,
  MockDeepSeekFlashInvoker,
  MockM3ThinkingInvoker,
} from "./src/agent/specialists/index.js";
import type { TierResolver } from "./src/agent/specialists/tier-resolver.js";
import assert from "node:assert/strict";

// ============================================================
// HITL handler mock (necesario para ejecutar el workflow completo)
// ============================================================

class InteractiveHITL implements HITLHandler {
  async initiate(_params: HITLInitiateParams): Promise<HITLInitiateResult> {
    return {
      requestId: "test-req-1",
      immediateResponse: {
        type: "approved",
        output: { approved: true, feedback: "Aprobado" },
      },
    };
  }
}

// ============================================================
// LLM invocador de fallback (cuando un nodo NO tiene specialist)
// ============================================================

class FallbackLLM implements LLMInvoker {
  async invoke(_params: LLMInvokeParams): Promise<LLMInvokeResult> {
    return {
      output: { fallback: true },
      tokensUsed: { input: 10, output: 5 },
      modelUsed: "fallback",
    };
  }
}

/**
 * `LLMInvoker` que retorna shapes específicos por nodo, para que el
 * workflow `revision-generica` corra end-to-end sin necesidad de
 * specialist en `extract` y `summarize`. Detecta el nodo por substring
 * del user prompt (mismo patrón que `RevisionGenericaLLM` en D2a.5).
 *
 * Se usa solo en tests que ejercen el workflow completo y donde los
 * nodos sin specialist (extract, summarize) deben retornar shapes
 * válidos para el stateSchema.
 */
class RevisionGenericaHelperLLM implements LLMInvoker {
  async invoke(params: LLMInvokeParams): Promise<LLMInvokeResult> {
    const usr = params.userPrompt ?? "";
    if (usr.startsWith("DOCUMENTO:") || usr.includes("CLÁUSULAS EXTRAÍDAS:")) {
      return {
        output: "Resumen del documento (test).",
        tokensUsed: { input: 250, output: 80 },
        modelUsed: "m3-thinking",
      };
    }
    // extract (cualquier otro user prompt sin "DOCUMENTO:" prefix)
    return {
      output: [
        { id: 1, text: "Cláusula 1" },
        { id: 2, text: "Cláusula 2" },
      ],
      tokensUsed: { input: 200, output: 150 },
      modelUsed: "m3-thinking",
    };
  }
}

// ============================================================
// Circuit breaker que podemos inspeccionar (para tests de circuit breaker)
// ============================================================

class InspectableCircuitBreaker implements CircuitBreaker {
  public successes: string[] = [];
  public failures: string[] = [];
  public openIds = new Set<string>();

  recordSuccess(specialistId: string): void {
    this.successes.push(specialistId);
    this.openIds.delete(specialistId);
  }
  recordFailure(specialistId: string): void {
    this.failures.push(specialistId);
  }
  isOpen(specialistId: string): boolean {
    return this.openIds.has(specialistId);
  }
  /** Forzar apertura (test de circuit breaker). */
  forceOpen(specialistId: string): void {
    this.openIds.add(specialistId);
  }
}

// ============================================================
// Setup helpers
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

interface D2b1Setup {
  livianoInvoker: MockDeepSeekFlashInvoker;
  robustoInvoker: MockM3ThinkingInvoker;
  fallbackLLM: FallbackLLM;
  /** TierResolver para construir el registry (resuelve a mocks especializados). */
  tierResolverForRegistry: TierResolver;
  /** TierResolver para nodos sin specialist (resuelve a fallbackLLM). */
  tierResolverForExecutor: TierResolver;
  specialistRegistry: SpecialistRegistry;
}

function setupSpecialists(): D2b1Setup {
  const livianoInvoker = new MockDeepSeekFlashInvoker();
  const robustoInvoker = new MockM3ThinkingInvoker();
  const fallbackLLM = new FallbackLLM();
  // tierResolver para construir el registry: especialistas reciben el
  // mock especializado (DeepSeek para liviano, M3 Thinking para robusto).
  const tierResolverForRegistry = new DefaultTierResolver(livianoInvoker, robustoInvoker);
  // tierResolver para el ExecutorConfig: nodos sin specialist caen al
  // fallbackLLM (no a los mocks especializados, que requieren system
  // prompts específicos).
  const tierResolverForExecutor = new DefaultTierResolver(fallbackLLM, fallbackLLM);
  const specialistRegistry = SpecialistRegistry.create({
    tierResolver: tierResolverForRegistry,
    factories: [
      // MAY-7: proveemos preferredModel para evitar la doble construcción.
      { agentId: "intake_specialist_v1", preferredModel: "liviano", factory: (inv) => new IntakeSpecialist(inv) },
      { agentId: "clause_reviewer_specialist_v1", preferredModel: "robusto", factory: (inv) => new ClauseReviewerSpecialist(inv) },
      { agentId: "verifier_specialist_v1", preferredModel: "robusto", factory: (inv) => new VerifierSpecialist(inv) },
    ],
  });
  return { livianoInvoker, robustoInvoker, fallbackLLM, tierResolverForRegistry, tierResolverForExecutor, specialistRegistry };
}

function loadRevisionGenerica(): WorkflowDefinition {
  return JSON.parse(
    readFileSync("tests/fixtures/revision-generica.workflow.json", "utf-8"),
  ) as WorkflowDefinition;
}

function makeExecutor(opts: {
  tierResolver: TierResolver;
  specialistRegistry: SpecialistRegistry;
  fallbackLLM: FallbackLLM;
  circuitBreaker?: CircuitBreaker;
}): WorkflowExecutor {
  return new WorkflowExecutor({
    functionRegistry: new FunctionRegistry() as unknown as Map<string, WorkflowFunction>,
    llmInvoker: opts.fallbackLLM,
    hitlHandler: new InteractiveHITL(),
    tierResolver: opts.tierResolver,
    specialistRegistry: opts.specialistRegistry,
    circuitBreaker: opts.circuitBreaker ?? new NoopCircuitBreaker(),
  });
}

/**
 * Helper que arma el setup con tierResolver para el executor que
 * resuelve todo a fallbackLLM (para nodos sin specialist).
 */
function makeExecutorFromSetup(setup: D2b1Setup, circuitBreaker?: CircuitBreaker): WorkflowExecutor {
  return makeExecutor({
    tierResolver: setup.tierResolverForExecutor,
    specialistRegistry: setup.specialistRegistry,
    fallbackLLM: setup.fallbackLLM,
    circuitBreaker,
  });
}

/**
 * Helper que arma el executor con un LLM helper que retorna shapes
 * específicos para el workflow `revision-generica`. Para tests que
 * ejercitan el workflow completo.
 *
 * El `tierResolverForExecutor` se reemplaza por uno que resuelve a
 * `RevisionGenericaHelperLLM` (en lugar de fallbackLLM), para que
 * los nodos sin specialist del fixture (`extract`, `summarize`)
 * puedan completar.
 */
function makeExecutorForRevisionGenerica(setup: D2b1Setup, circuitBreaker?: CircuitBreaker): WorkflowExecutor {
  const helper = new RevisionGenericaHelperLLM();
  const tierResolver = new DefaultTierResolver(helper, helper);
  return new WorkflowExecutor({
    functionRegistry: new FunctionRegistry() as unknown as Map<string, WorkflowFunction>,
    llmInvoker: helper,
    hitlHandler: new InteractiveHITL(),
    tierResolver,
    specialistRegistry: setup.specialistRegistry,
    circuitBreaker: circuitBreaker ?? new NoopCircuitBreaker(),
  });
}

// ============================================================
// Tests
// ============================================================

console.log("D2b.1 — Multi-Model Router + 3 Specialists: Tests\n");

// ─── TierResolver (3 tests) ─────────────────────────────────

await test("tier-resolver: liviano → DeepSeek Flash mock", () => {
  const { livianoInvoker, robustoInvoker, tierResolverForRegistry } = setupSpecialists();
  const resolved = tierResolverForRegistry.resolve("liviano");
  assert.equal(resolved.tier, "liviano");
  assert.equal(resolved.model, "deepseek-flash");
  assert.strictEqual(resolved.invoker, livianoInvoker);
  void robustoInvoker;
});

await test("tier-resolver: robusto → M3 Thinking mock", () => {
  const { livianoInvoker, robustoInvoker, tierResolverForRegistry } = setupSpecialists();
  const resolved = tierResolverForRegistry.resolve("robusto");
  assert.equal(resolved.tier, "robusto");
  assert.equal(resolved.model, "m3-thinking");
  assert.strictEqual(resolved.invoker, robustoInvoker);
  void livianoInvoker;
});

await test("tier-resolver: modelRef desconocido → robusto (default seguro)", () => {
  const { livianoInvoker, robustoInvoker, tierResolverForRegistry } = setupSpecialists();
  const resolved = tierResolverForRegistry.resolve("gpt-4o");
  assert.equal(resolved.tier, "robusto");
  assert.equal(resolved.model, "gpt-4o", "model específico se preserva");
  assert.strictEqual(resolved.invoker, robustoInvoker, "fallback a robusto");
  void livianoInvoker;
});

// ─── Specialists (3 tests) ──────────────────────────────────

await test("specialist: IntakeSpecialist clasifica un documento (mock liviano)", async () => {
  const setup = setupSpecialists();
  const intake = setup.specialistRegistry.get("intake_specialist_v1");
  assert.ok(intake, "intake_specialist_v1 registrado");
  const workflow = loadRevisionGenerica();
  const executor = makeExecutorForRevisionGenerica(setup);
  const task = executor.startTask(workflow, {
    documentId: "doc-001",
    documentContent: "CONTRATO de arrendamiento entre A y B",
  });
  const result = await executor.run(task.taskId);
  assert.equal(result.status, "completed");
  assert.equal(result.nodeResults.classify.status, "completed");
  assert.equal(setup.livianoInvoker.callCount, 1, "MockDeepSeekFlash invocado 1 vez");
  assert.deepEqual(result.state.classification, { category: "contrato", confidence: 0.9 });
});

await test("specialist: ClauseReviewerSpecialist analiza cláusulas (mock robusto)", async () => {
  const setup = setupSpecialists();
  const workflow: WorkflowDefinition = {
    id: "test-clause",
    name: "Test Clause",
    workflowVersion: "1.0.0",
    schemaVersion: 1,
    stateSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        input: { type: "object", additionalProperties: false, properties: { documentContent: { type: "string" } } },
        review: { type: "array", items: { type: "object" } },
      },
    },
    nodes: [
      {
        id: "review",
        type: "llm",
        model: "robusto",
        assignedSpecialist: "clause_reviewer_specialist_v1",
        userPrompt: "Revisa",
        input: { from: { template: "Revisa" } },
        output: { to: { path: "review" } },
      },
    ],
    edges: [],
    entryNode: "review",
  };
  const executor = makeExecutorFromSetup(setup);
  const task = executor.startTask(workflow, { documentContent: "dummy" });
  const result = await executor.run(task.taskId);
  assert.equal(result.status, "completed");
  assert.equal(setup.robustoInvoker.callCount, 1, "MockM3Thinking invocado 1 vez");
  assert.ok(Array.isArray(result.state.review));
  assert.equal((result.state.review as unknown[]).length, 2);
});

await test("specialist: VerifierSpecialist verifica output (mock robusto)", async () => {
  const setup = setupSpecialists();
  const workflow: WorkflowDefinition = {
    id: "test-verify",
    name: "Test Verify",
    workflowVersion: "1.0.0",
    schemaVersion: 1,
    stateSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        input: { type: "object", additionalProperties: false, properties: { documentContent: { type: "string" } } },
        verdict: { type: "object" },
      },
    },
    nodes: [
      {
        id: "verify",
        type: "llm",
        model: "robusto",
        assignedSpecialist: "verifier_specialist_v1",
        userPrompt: "Verifica",
        input: { from: { template: "Verifica" } },
        output: { to: { path: "verdict" } },
      },
    ],
    edges: [],
    entryNode: "verify",
  };
  const executor = makeExecutorFromSetup(setup);
  const task = executor.startTask(workflow, { documentContent: "dummy" });
  const result = await executor.run(task.taskId);
  assert.equal(result.status, "completed");
  assert.equal(setup.robustoInvoker.callCount, 1);
  assert.deepEqual(result.state.verdict, {
    verified: true,
    confidence: 0.85,
    notes: "El output es consistente con el contexto. Sin issues detectados.",
    // D2b.2: Citation Grounding v2 + audit metadata. Ver AGENT_D2B_2_SPEC.md §5.7.
    issues: [],
    citations: [],
    verifierSessionId: result.state.verdict.verifierSessionId, // UUID, no lo hardcodeamos
    verifiedAt: result.state.verdict.verifiedAt, // ISO timestamp, no lo hardcodeamos
  });
  // Validaciones explícitas de los nuevos campos.
  assert.ok(typeof result.state.verdict.verifierSessionId === "string");
  assert.ok(result.state.verdict.verifierSessionId.length >= 32, "verifierSessionId es un UUID");
  assert.ok(typeof result.state.verdict.verifiedAt === "string");
  assert.ok(!isNaN(Date.parse(result.state.verdict.verifiedAt)), "verifiedAt es ISO válido");
});

// ─── Routing del motor (3 tests) ───────────────────────────

await test("workflow: nodo con assignedSpecialist se delega al specialist correcto", async () => {
  const setup = setupSpecialists();
  const workflow = loadRevisionGenerica();
  const executor = makeExecutorFromSetup(setup);
  const task = executor.startTask(workflow, {
    documentId: "doc-001",
    documentContent: "CONTRATO de prueba",
  });
  await executor.run(task.taskId);
  assert.equal(setup.livianoInvoker.callCount, 1, "classify (assignedSpecialist=intake) llamó a DeepSeek");
});

await test("workflow: nodo SIN assignedSpecialist usa el llmInvoker default (backward-compat)", async () => {
  const setup = setupSpecialists();
  const workflow: WorkflowDefinition = {
    id: "test-backcompat",
    name: "Test Backward Compat",
    workflowVersion: "1.0.0",
    schemaVersion: 1,
    stateSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        input: { type: "object", additionalProperties: false, properties: { x: { type: "string" } } },
        result: { type: "object" },
      },
    },
    nodes: [
      {
        id: "nodo-sin-specialist",
        type: "llm",
        model: "liviano",
        // SIN assignedSpecialist
        userPrompt: "x",
        input: { from: { template: "x" } },
        output: { to: { path: "result" } },
      },
    ],
    edges: [],
    entryNode: "nodo-sin-specialist",
  };
  const executor = makeExecutorFromSetup(setup);
  const task = executor.startTask(workflow, { x: "hello" });
  const result = await executor.run(task.taskId);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.state.result, { fallback: true }, "fallbackLLM fue invocado");
});

await test("workflow: revision-generica con assignedSpecialist corre end-to-end", async () => {
  const setup = setupSpecialists();
  const workflow = loadRevisionGenerica();
  const executor = makeExecutorForRevisionGenerica(setup);
  const task = executor.startTask(workflow, {
    documentId: "doc-001",
    documentContent: "CONTRATO de prueba",
  });
  const result = await executor.run(task.taskId);
  assert.equal(result.status, "completed");
  assert.equal(result.nodeResults.classify.status, "completed");
  assert.equal(result.nodeResults.extract.status, "completed");
  assert.equal(result.nodeResults.summarize.status, "completed");
  assert.equal(result.nodeResults.approve.status, "completed");
});

// ─── Audit / metadata (2 tests) ────────────────────────────

await test("audit: NodeResult.metadata.executedBy tiene agentId, agentVersion, tier, model", async () => {
  const setup = setupSpecialists();
  const workflow = loadRevisionGenerica();
  const executor = makeExecutorFromSetup(setup);
  const task = executor.startTask(workflow, {
    documentId: "doc-001",
    documentContent: "CONTRATO de prueba",
  });
  const result = await executor.run(task.taskId);
  const classify = result.nodeResults.classify;
  assert.ok(classify.metadata, "classify tiene metadata");
  assert.ok(classify.metadata!.executedBy, "classify.metadata.executedBy presente");
  assert.equal(classify.metadata!.executedBy!.agentId, "intake_specialist_v1");
  // D2b.2: agentVersion ahora viene del agentCard (semver limpio "1.0.0",
  // no más "1.0.0-d2b.1"). Ver AGENT_D2B_2_SPEC.md §8.8.
  assert.equal(classify.metadata!.executedBy!.agentVersion, "1.0.0");
  assert.ok(typeof classify.metadata!.executedBy!.tier === "string");
  assert.ok(typeof classify.metadata!.executedBy!.model === "string");
});

await test("audit: cost attribution básico (costUsd del invocador se preserva)", async () => {
  const setup = setupSpecialists();
  setup.livianoInvoker.classificationOverride = { category: "demanda", confidence: 0.7 };
  const workflow = loadRevisionGenerica();
  const executor = makeExecutorFromSetup(setup);
  const task = executor.startTask(workflow, {
    documentId: "doc-001",
    documentContent: "DEMANDA laboral",
  });
  const result = await executor.run(task.taskId);
  const classify = result.nodeResults.classify;
  assert.equal(classify.costUsd, 0.001, "costUsd del MockDeepSeekFlash se preserva");
  assert.deepEqual(classify.tokensUsed, { input: 100, output: 50 });
});

// ─── Compatibilidad con primitivas D2a.4 (3 tests) ────────

await test("workflow: confidence gating sigue funcionando con specialist", async () => {
  const setup = setupSpecialists();
  setup.livianoInvoker.classificationOverride = { category: "contrato", confidence: 0.3 };
  const workflow = loadRevisionGenerica();
  const executor = makeExecutorForRevisionGenerica(setup);
  const task = executor.startTask(workflow, {
    documentId: "doc-001",
    documentContent: "CONTRATO",
  });
  const result = await executor.run(task.taskId);
  assert.equal(result.status, "completed");
  assert.equal(result.nodeResults.classify.confidence, "LOW", "confidence=LOW (0.3 < mediumThreshold 0.5)");
  assert.equal(result.nodeResults.classify.confidenceValue, 0.3);
});

await test("workflow: prompt snapshot se persiste con specialist (system del specialist)", async () => {
  const setup = setupSpecialists();
  const workflow = loadRevisionGenerica();
  const executor = makeExecutorFromSetup(setup);
  const task = executor.startTask(workflow, {
    documentId: "doc-001",
    documentContent: "CONTRATO",
  });
  const result = await executor.run(task.taskId);
  const snapshot = result.nodeResults.classify.promptSnapshot;
  assert.ok(snapshot, "classify tiene promptSnapshot");
  assert.ok(snapshot!.system!.includes("clasificador"), "system prompt del IntakeSpecialist");
  assert.ok(snapshot!.user!.includes("CONTRATO"), "user prompt con documentContent interpolado");
});

await test("workflow: circuit breaker recibe recordSuccess/recordFailure al ejecutar specialist", async () => {
  const setup = setupSpecialists();
  const breaker = new InspectableCircuitBreaker();
  const workflow = loadRevisionGenerica();
  const executor = makeExecutorFromSetup(setup, breaker);
  const task = executor.startTask(workflow, {
    documentId: "doc-001",
    documentContent: "CONTRATO",
  });
  await executor.run(task.taskId);
  assert.ok(breaker.successes.includes("liviano"), "breaker recibe success para 'liviano'");
});

// ─── Error handling (1 test) ───────────────────────────────

await test("error: si el invocador del specialist tira, el nodo se marca como failed", async () => {
  const setup = setupSpecialists();
  // Forzar throw genérico en el invocador.
  setup.livianoInvoker.invoke = async () => {
    throw new Error("Mock invocador tiró error simulado");
  };
  const workflow = loadRevisionGenerica();
  const executor = makeExecutorFromSetup(setup);
  const task = executor.startTask(workflow, {
    documentId: "doc-001",
    documentContent: "CONTRATO",
  });
  const result = await executor.run(task.taskId);
  assert.equal(result.status, "failed", "task failed");
  assert.equal(result.nodeResults.classify.status, "failed", "classify failed");
  assert.ok(
    result.nodeResults.classify.error?.message.includes("Mock invocador"),
    `mensaje debería incluir 'Mock invocador': ${result.nodeResults.classify.error?.message}`,
  );
});

// ─── Bonus: validación de assignedSpecialist desconocido ───

await test("validación: assignedSpecialist que no existe en el registry → NODE_NOT_FOUND en startTask", () => {
  const setup = setupSpecialists();
  const workflow: WorkflowDefinition = {
    id: "test-bad-specialist",
    name: "Test Bad Specialist",
    workflowVersion: "1.0.0",
    schemaVersion: 1,
    stateSchema: {
      type: "object",
      additionalProperties: false,
      properties: { input: { type: "object" } },
    },
    nodes: [
      {
        id: "nodo",
        type: "llm",
        model: "liviano",
        assignedSpecialist: "specialist_que_no_existe",
        userPrompt: "x",
        input: { from: { template: "x" } },
        output: { to: { path: "result" } },
      },
    ],
    edges: [],
    entryNode: "nodo",
  };
  const executor = makeExecutorFromSetup(setup);
  let caught: unknown = undefined;
  try {
    executor.startTask(workflow, {});
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, "startTask debería haber tirado");
  if (caught instanceof ExecutorError) {
    assert.equal(caught.code, "NODE_NOT_FOUND", "ExecutorError.code debe ser NODE_NOT_FOUND");
    assert.ok(caught.message.includes("specialist_que_no_existe"));
  } else {
    assert.fail(`se esperaba ExecutorError, got: ${caught?.constructor?.name}`);
  }
});

// ============================================================
// Resumen
// ============================================================

console.log(`\n✓ ${passed} tests pasaron, ✗ ${failed} fallaron`);
if (failed > 0) {
  process.exit(1);
}
