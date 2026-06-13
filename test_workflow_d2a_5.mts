/**
 * D2a.5 — Workflow Ejemplo End-to-End: Smoke Tests.
 *
 * Este archivo prueba que el motor (D2a.2 + D2a.2.2 + D2a.2.3 + D2a.4)
 * corre un workflow NO-TRIVIAL de inicio a fin, ejercitando TODAS las
 * primitivas no negociables en un solo flujo:
 * - State schema validation (input + post-output, ajv draft-07).
 * - Prompt snapshot persistence (nodos LLM, D2a.2.3).
 * - Time travel / replay (D2a.2.3).
 * - Schema versioning lazy (D2a.2.3).
 * - Circuit breaker (D2a.2.3).
 * - HITL pause/resume + immediateResponse (D2a.4).
 * - Confidence gating (D2a.2).
 *
 * Patrón: igual que `test_workflow_d2a_4.mts`. Counter de passed/failed
 * con `assert` (Node built-in). No usa libs externas.
 *
 * Workflow bajo prueba: `tests/fixtures/revision-generica.workflow.json`
 * (4 nodos: classify → extract → summarize → approve con HITL real).
 *
 * 7 tests:
 * 1. smoke happy path con immediateResponse
 * 2. smoke con pause/resume explícito
 * 3. state validation rechaza input con tipo incorrecto
 * 4. state validation rechaza output de nodo LLM con tipo incorrecto
 * 5. prompt snapshot se persiste en al menos 2 nodos LLM
 * 6. replay del workflow completo con input distinto
 * 7. confidence gating lee el campo confidence del output
 *
 * Ver `AGENT_D2A_5_SPEC.md` para decisiones de diseño.
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
  HITLResponse,
  HITLInitiateParams,
  HITLInitiateResult,
  WorkflowDefinition,
  WorkflowFunction,
  Task,
  TaskError,
  NodeResult,
} from "./src/agent/workflow-engine/executor/index.js";
import {
  DefaultTierResolver,
  IntakeSpecialist,
  ClauseReviewerSpecialist,
  VerifierSpecialist,
  SpecialistRegistry,
} from "./src/agent/specialists/index.js";
import assert from "node:assert/strict";

// ============================================================
// Mocks específicos al workflow `revision-generica`
// ============================================================

/**
 * `LLMInvoker` que reconoce qué nodo lo llama por el `userPrompt` o
 * `systemPrompt` (NO por el campo `model`, que es compartido entre nodos).
 * Retorna outputs específicos por nodo para que el workflow complete y el
 * state se escriba correctamente.
 *
 * Para el test 4, se puede configurar el output de `classify` para que
 * rompa el schema (category como número en vez de string).
 */
class RevisionGenericaLLM implements LLMInvoker {
  public calls: Array<{ nodeHint: string; systemPrompt?: string; userPrompt?: string }> = [];
  /** Output override para el nodo classify (test 4 fuerza SCHEMA_VIOLATION). */
  public classifyOverride: unknown = { category: "contrato", confidence: 0.95 };

  async invoke(params: LLMInvokeParams): Promise<LLMInvokeResult> {
    const nodeHint = this.detectNode(params);
    this.calls.push({ nodeHint, systemPrompt: params.systemPrompt, userPrompt: params.userPrompt });

    if (nodeHint === "classify") {
      return {
        output: this.classifyOverride,
        tokensUsed: { input: 100, output: 50 },
        modelUsed: params.model === "liviano" ? "deepseek-flash" : "m3-thinking",
      };
    }
    if (nodeHint === "extract") {
      return {
        output: [
          { id: 1, text: "Cláusula 1: El arrendatario paga $X mensualmente" },
          { id: 2, text: "Cláusula 2: Renovación tácita por 12 meses" },
        ],
        tokensUsed: { input: 200, output: 150 },
        modelUsed: "m3-thinking",
      };
    }
    if (nodeHint === "summarize") {
      // El motor escribe el output completo en state.summary (no interpola
      // templates de output.to). El workflow del fixture define
      // `summary: { type: "string" }` en el stateSchema, así que el output
      // debe ser un string directo, no un objeto.
      return {
        output: "Contrato de arrendamiento con 2 cláusulas principales.",
        tokensUsed: { input: 250, output: 80 },
        modelUsed: "m3-thinking",
      };
    }
    throw new Error(`RevisionGenericaLLM: nodo no reconocido (systemPrompt=${params.systemPrompt?.slice(0, 50)}, userPrompt=${params.userPrompt?.slice(0, 50)})`);
  }

  /**
   * Detecta qué nodo nos llama por substring del prompt.
   * El workflow del fixture tiene prompts únicos por nodo:
   * - classify: systemPrompt menciona "clasificador" + userPrompt tiene "{{state.documentContent}}" directo.
   * - extract: userPrompt tiene "{{state.documentContent}}" directo (sin prefijo "DOCUMENTO:").
   * - summarize: userPrompt tiene prefijo "DOCUMENTO:" + "CLÁUSULAS EXTRAÍDAS:".
   */
  private detectNode(params: LLMInvokeParams): string {
    const sys = params.systemPrompt ?? "";
    const usr = params.userPrompt ?? "";
    if (sys.includes("clasificador") || usr.includes("categoría")) return "classify";
    if (usr.startsWith("DOCUMENTO:") || usr.includes("CLÁUSULAS EXTRAÍDAS:")) return "summarize";
    return "extract"; // extract tiene solo documentContent
  }
}

/**
 * `HITLHandler` con dos modos:
 * - `interactive` (default): retorna `immediateResponse` con approved.
 * - `paused`: retorna solo `requestId` (pausa real). El test llama `resumeTask`.
 */
class RevisionGenericaHITL implements HITLHandler {
  public mode: "interactive" | "paused" = "interactive";
  public calls: Array<{ taskId: string; nodeId: string }> = [];
  private nextRequestId = 1;

  async initiate(params: HITLInitiateParams): Promise<HITLInitiateResult> {
    this.calls.push({ taskId: params.taskId, nodeId: params.nodeId });
    const requestId = `test-req-${this.nextRequestId++}`;
    if (this.mode === "interactive") {
      return {
        requestId,
        immediateResponse: {
          type: "approved",
          output: { approved: true, feedback: "Aprobado por el mock" },
        },
      };
    }
    return { requestId };
  }
}

// ============================================================
// Helpers
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

interface Setup {
  workflow: WorkflowDefinition;
  executor: WorkflowExecutor;
  llm: RevisionGenericaLLM;
  hitl: RevisionGenericaHITL;
}

function setupRevisionGenerica(overrides: Partial<{ hitl: RevisionGenericaHITL; llm: RevisionGenericaLLM }> = {}): Setup {
  const workflow = JSON.parse(
    readFileSync("tests/fixtures/revision-generica.workflow.json", "utf-8"),
  ) as WorkflowDefinition;
  const llm = overrides.llm ?? new RevisionGenericaLLM();
  const hitl = overrides.hitl ?? new RevisionGenericaHITL();

  // D2b.1: el fixture declara `assignedSpecialist: "intake_specialist_v1"`
  // en el nodo `classify` (los demás nodos LLM siguen sin specialist
  // porque los specialists de D2b.1 no encajan con extract/summarize
  // del fixture — `clause_reviewer_specialist_v1` espera `{clauseId, risk, reason}`
  // y el mock de extract retorna `{id, text}`). El test D2a.5 sigue
  // funcionando porque proveemos un `SpecialistRegistry` con un
  // `IntakeSpecialist` cuyo invocador es el MISMO `RevisionGenericaLLM`
  // (en lugar del `MockDeepSeekFlashInvoker` por default). Así, el mock
  // del test sigue detectando el nodo por substring del system prompt.
  const tierResolver = new DefaultTierResolver(llm, llm); // ambos invocadores apuntan al mock del test.
  const specialistRegistry = SpecialistRegistry.create({
    tierResolver,
    factories: [
      // MAY-7: proveemos preferredModel para evitar la doble construcción.
      { agentId: "intake_specialist_v1", preferredModel: "liviano", factory: (inv) => new IntakeSpecialist(inv) },
      { agentId: "clause_reviewer_specialist_v1", preferredModel: "robusto", factory: (inv) => new ClauseReviewerSpecialist(inv) },
      { agentId: "verifier_specialist_v1", preferredModel: "robusto", factory: (inv) => new VerifierSpecialist(inv) },
    ],
  });

  const executor = new WorkflowExecutor({
    functionRegistry: new FunctionRegistry() as unknown as Map<string, WorkflowFunction>,
    llmInvoker: llm,
    hitlHandler: hitl,
    circuitBreaker: new NoopCircuitBreaker(),
    tierResolver,
    specialistRegistry,
  });
  return { workflow, executor, llm, hitl };
}

const VALID_INPUT = {
  documentId: "doc-001",
  documentContent: "CONTRATO DE ARRENDAMIENTO DE VIVIENDA entre Arrendador Juan y Arrendatario Pedro...",
};

// ============================================================
// Tests
// ============================================================

console.log("D2a.5 — Workflow Ejemplo End-to-End: Smoke Tests\n");

// ─── Test 1: smoke happy path con immediateResponse ─────────

await test("smoke: workflow revision-generica corre end-to-end con immediateResponse (caso feliz)", async () => {
  const { workflow, executor, llm, hitl } = setupRevisionGenerica();
  hitl.mode = "interactive";

  const task = executor.startTask(workflow, VALID_INPUT);
  const result = await executor.run(task.taskId);

  assert.equal(result.status, "completed", "task completed");
  assert.equal(result.nodeResults.classify.status, "completed", "classify completed");
  assert.equal(result.nodeResults.extract.status, "completed", "extract completed");
  assert.equal(result.nodeResults.summarize.status, "completed", "summarize completed");
  assert.equal(result.nodeResults.approve.status, "completed", "approve completed");

  // State final poblado. El motor inicializa state = { input }, así que
  // documentId y documentContent están en state.input.
  assert.equal(result.state.input.documentId, "doc-001");
  assert.equal(result.state.input.documentContent, "CONTRATO DE ARRENDAMIENTO DE VIVIENDA entre Arrendador Juan y Arrendatario Pedro...");
  assert.deepEqual(result.state.classification, { category: "contrato", confidence: 0.95 });
  assert.ok(Array.isArray(result.state.extractedClauses), "extractedClauses es array");
  assert.equal(result.state.extractedClauses.length, 2, "2 cláusulas extraídas");
  assert.equal(result.state.summary, "Contrato de arrendamiento con 2 cláusulas principales.");
  assert.deepEqual(result.state.approval, { approved: true, feedback: "Aprobado por el mock" });

  // El motor consultó cada nodo.
  assert.equal(llm.calls.length, 3, "3 invocaciones LLM (classify, extract, summarize)");
  assert.equal(llm.calls[0].nodeHint, "classify");
  assert.equal(llm.calls[1].nodeHint, "extract");
  assert.equal(llm.calls[2].nodeHint, "summarize");
  assert.equal(hitl.calls.length, 1, "1 invocación HITL (approve)");
});

// ─── Test 2: smoke con pause/resume explícito ────────────────

await test("smoke: workflow revision-generica con pause/resume explícito (modo paused_hitl)", async () => {
  const { workflow, executor, hitl } = setupRevisionGenerica();
  hitl.mode = "paused";

  const task = executor.startTask(workflow, VALID_INPUT);
  const initialResult = await executor.run(task.taskId);

  // Después del run, la task está paused_hitl esperando respuesta humana.
  assert.equal(initialResult.status, "paused_hitl", "task queda paused_hitl");
  const pausedTask = executor.getTask(task.taskId);
  assert.ok(pausedTask!.pendingDecision, "pendingDecision persistido");
  assert.equal(pausedTask!.pendingDecision!.nodeId, "approve");
  assert.equal(pausedTask!.pendingDecision!.approvers[0], "role:abogado_senior");
  assert.ok(pausedTask!.pendingDecision!.requestId.startsWith("test-req-"), "requestId del handler");

  // Resumir la task con una respuesta approved.
  const resumed = await executor.resumeTask(task.taskId, {
    type: "approved",
    output: { approved: true, feedback: "Aprobado via resumeTask" },
  });

  assert.equal(resumed.status, "completed", "task completed después de resumeTask");
  assert.equal(resumed.nodeResults.approve.status, "completed", "approve completed");
  assert.deepEqual(resumed.state.approval, { approved: true, feedback: "Aprobado via resumeTask" });
});

// ─── Test 3: state validation rechaza input con tipo incorrecto ─

await test("smoke: state validation rechaza input con tipo incorrecto", async () => {
  const { workflow, executor } = setupRevisionGenerica();

  // Input con una propiedad EXTRA (no está en el stateSchema).
  // El stateSchema del fixture tiene additionalProperties: false, así que
  // cualquier prop no declarada rompe la validación. Esto es la forma
  // más confiable de forzar SCHEMA_VIOLATION en el input.
  const badInput = {
    documentId: "doc-002",
    documentContent: "contenido válido",
    unknownProperty: "violación", // prop extra, no está en el schema
  };

  let caught: unknown = undefined;
  try {
    executor.startTask(workflow, badInput);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, "startTask debería haber tirado");
  const msg = caught instanceof Error ? caught.message : String(caught);
  // El motor pone el código "SCHEMA_VIOLATION" como propiedad `code` del error.
  // El mensaje solo describe el problema ("Input inicial no cumple stateSchema...").
  // Verificamos que sea ExecutorError con código SCHEMA_VIOLATION.
  if (caught instanceof ExecutorError) {
    assert.equal(caught.code, "SCHEMA_VIOLATION", "ExecutorError.code debe ser SCHEMA_VIOLATION");
  } else {
    assert.fail(`se esperaba ExecutorError, got: ${caught?.constructor?.name}: ${msg}`);
  }
});

// ─── Test 4: state validation rechaza output de nodo LLM ─────

await test("smoke: state validation rechaza output de nodo LLM que rompe el schema", async () => {
  const { workflow, executor, llm } = setupRevisionGenerica();
  // Forzar que el output de classify tenga category como número (debería ser string).
  // El stateSchema requiere classification.category como string.
  llm.classifyOverride = { category: 123, confidence: 0.95 };

  const task = executor.startTask(workflow, VALID_INPUT);
  const result = await executor.run(task.taskId);

  assert.equal(result.status, "failed", "task failed");
  assert.equal(result.error?.code, "SCHEMA_VIOLATION", "código SCHEMA_VIOLATION");
  assert.equal(result.nodeResults.classify.status, "failed", "NodeResult de classify = failed");
  assert.ok(result.nodeResults.classify.error?.message.includes("classification"), `mensaje debería mencionar classification: ${result.nodeResults.classify.error?.message}`);
});

// ─── Test 5: prompt snapshot se persiste en al menos 2 nodos LLM

await test("smoke: prompt snapshot se persiste en al menos 2 nodos LLM (classify y summarize)", async () => {
  const { workflow, executor, llm } = setupRevisionGenerica();
  const task = executor.startTask(workflow, VALID_INPUT);
  const result = await executor.run(task.taskId);

  assert.equal(result.status, "completed");

  // classify debe tener promptSnapshot con system (clasificador) y user (documentContent interpolado).
  const classifySnapshot = result.nodeResults.classify.promptSnapshot;
  assert.ok(classifySnapshot, "classify tiene promptSnapshot");
  assert.ok(classifySnapshot!.system, "system prompt presente");
  assert.ok(classifySnapshot!.system!.includes("clasificador"), `system prompt debería incluir 'clasificador': ${classifySnapshot!.system!.slice(0, 100)}`);
  assert.ok(classifySnapshot!.user, "user prompt presente");
  assert.ok(classifySnapshot!.user!.includes("CONTRATO DE ARRENDAMIENTO"), `user prompt debería tener documentContent interpolado: ${classifySnapshot!.user!.slice(0, 100)}`);

  // summarize debe tener promptSnapshot con system (vacío en este caso) y user (DOCUMENTO: + CLÁUSULAS EXTRAÍDAS:).
  const summarizeSnapshot = result.nodeResults.summarize.promptSnapshot;
  assert.ok(summarizeSnapshot, "summarize tiene promptSnapshot");
  assert.ok(summarizeSnapshot!.user, "user prompt de summarize presente");
  assert.ok(summarizeSnapshot!.user!.includes("DOCUMENTO:"), `user prompt de summarize debería empezar con 'DOCUMENTO:': ${summarizeSnapshot!.user!.slice(0, 50)}`);
  assert.ok(summarizeSnapshot!.user!.includes("CLÁUSULAS EXTRAÍDAS:"), "user prompt tiene las cláusulas interpoladas");
  assert.ok(summarizeSnapshot!.user!.includes("Cláusula 1"), "cláusula 1 interpolada en el prompt de summarize");
});

// ─── Test 6: replay del workflow completo con input distinto ──

await test("smoke: replay del workflow completo con input distinto", async () => {
  const { workflow, executor, hitl } = setupRevisionGenerica();
  hitl.mode = "interactive";

  // Primera ejecución.
  const task1 = executor.startTask(workflow, VALID_INPUT);
  const result1 = await executor.run(task1.taskId);
  assert.equal(result1.status, "completed");
  assert.equal(result1.state.input.documentId, "doc-001");
  assert.equal(result1.state.summary, "Contrato de arrendamiento con 2 cláusulas principales.");

  // Replay con input distinto.
  const newInput = {
    documentId: "doc-002",
    documentContent: "DEMANDA LABORAL entre Pedro y Empresa XYZ por despido injustificado...",
  };
  const replay = executor.replayTask(task1.taskId, { input: newInput });
  const result2 = await executor.run(replay.taskId);

  assert.equal(result2.status, "completed", "replay completed");
  assert.equal(result2.state.input.documentId, "doc-002", "replay usa el nuevo input");
  // El mock retorna el mismo summary fijo, pero el documentContent interpolado
  // en el prompt de classify es el del nuevo input. Verificamos que el input
  // nuevo se usó.
  assert.ok(result2.nodeResults.classify.promptSnapshot!.user!.includes("DEMANDA LABORAL"), "el nuevo documentContent se interpoló en el prompt de classify");
  assert.ok(result2.nodeResults.classify.promptSnapshot!.user!.includes("DEMANDA LABORAL"), "el nuevo documentContent se interpoló en el prompt de classify");
});

// ─── Test 7: confidence gating lee el campo confidence ──────

await test("smoke: confidence gating lee el campo confidence del output", async () => {
  const { workflow, executor } = setupRevisionGenerica();
  // El mock retorna confidence: 0.95, el workflow tiene highThreshold: 0.8.
  // El motor debería etiquetar HIGH.

  const task = executor.startTask(workflow, VALID_INPUT);
  const result = await executor.run(task.taskId);

  assert.equal(result.status, "completed");
  const classifyResult = result.nodeResults.classify;
  assert.equal(classifyResult.confidence, "HIGH", "confidence label = HIGH (0.95 >= highThreshold 0.8)");
  assert.equal(classifyResult.confidenceValue, 0.95, "confidenceValue persistido");
});

// ============================================================
// Resumen
// ============================================================

console.log(`\n✓ ${passed} tests pasaron, ✗ ${failed} fallaron`);
if (failed > 0) {
  process.exit(1);
}
