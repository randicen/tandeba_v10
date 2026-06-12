/**
 * D2a.4 — HITL Primitives: Pause/Resume Reales.
 *
 * 18 tests que cubren la separación de fases del HITL:
 * - Pause (3 tests): task entra en paused_hitl con pendingDecision, immediateResponse procesa inline, pendingDecision completo.
 * - Resume approved (3 tests): output válido, output inválido, siguiente nodo es otro HITL.
 * - Resume declined (2 tests): allowDecline=true falla con HITL_DECLINED, allowDecline=false (permisivo) procesa igual.
 * - Resume timeout (3 tests): onTimeout='fail'/'approve'/'reject'.
 * - Resume edge cases (2 tests): task no paused_hitl, task paused_hitl post-cleanup.
 * - Lifecycle (3 tests): cancelTask retiene pendingDecision, purgeTask elimina, replayTask falla en paused.
 * - immediateResponse (2 tests): approved procesa inline, declined procesa inline.
 *
 * Ver `AGENT_D2A_4_HITL_PRIMITIVES_SPEC.md` §9.
 *
 * Patrón: igual que `test_workflow_d2a_2_3.mts`. Counter de passed/failed
 * con `assert` (Node built-in). No usa libs externas.
 */

import {
  WorkflowExecutor,
  FunctionRegistry,
  ExecutorError,
} from "./src/agent/workflow-engine/executor/index.js";
import type {
  LLMInvoker,
  HITLHandler,
  HITLResponse,
  WorkflowFunction,
  WorkflowDefinition,
  HITLInitiateResult,
  HITLInitiateParams,
} from "./src/agent/workflow-engine/executor/types.js";
import type { Task } from "./src/agent/workflow-engine/dsl/types.js";
import assert from "node:assert/strict";

// ============================================================
// Mocks
// ============================================================

class NoopLLM implements LLMInvoker {
  async invoke(): Promise<never> {
    throw new Error("LLM no debería ser invocado en estos tests HITL");
  }
}

/**
 * HITL handler con dos modos:
 * - `useImmediateResponse: true` (default): retorna la respuesta pre-cargada
 *   vía `immediateResponse`. El motor procesa inline sin pausar.
 * - `useImmediateResponse: false`: retorna solo `requestId` (pausa real).
 *   El caller debe usar `executor.resumeTask(taskId, response)` después.
 */
class MockHITL implements HITLHandler {
  public calls: Array<{ taskId: string; nodeId: string; approvers: readonly string[] }> = [];
  public queue: HITLResponse[] = [];
  public defaultResponse: HITLResponse = { type: "approved", output: { approved: true } };
  public useImmediateResponse: boolean = true;
  private nextRequestId = 1;

  enqueue(response: HITLResponse): void {
    this.queue.push(response);
  }

  async initiate(params: HITLInitiateParams): Promise<HITLInitiateResult> {
    this.calls.push({ taskId: params.taskId, nodeId: params.nodeId, approvers: params.approvers });
    const requestId = `mock-req-${this.nextRequestId++}`;
    if (!this.useImmediateResponse) {
      return { requestId };
    }
    if (this.queue.length > 0) {
      return { requestId, immediateResponse: this.queue.shift()! };
    }
    return { requestId, immediateResponse: this.defaultResponse };
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

function makeExecutor(overrides: Partial<{
  hitl: MockHITL;
  functionRegistry: FunctionRegistry;
}> = {}): {
  executor: WorkflowExecutor;
  registry: FunctionRegistry;
  hitl: MockHITL;
} {
  const registry = overrides.functionRegistry ?? new FunctionRegistry();
  const hitl = overrides.hitl ?? new MockHITL();
  const executor = new WorkflowExecutor({
    functionRegistry: registry as unknown as Map<string, WorkflowFunction>,
    llmInvoker: new NoopLLM(),
    hitlHandler: hitl,
  });
  return { executor, registry, hitl };
}

/** Workflow con un solo nodo hitl. */
function singleHITLWorkflow(
  id: string,
  options: {
    outputSchema?: Record<string, unknown>;
    allowDecline?: boolean;
    onTimeout?: "fail" | "approve" | "reject";
  } = {},
): WorkflowDefinition {
  return {
    id,
    name: `HITL ${id}`,
    workflowVersion: "1.0.0",
    schemaVersion: 1,
    stateSchema: {},
    nodes: [
      {
        type: "hitl",
        id: "approve",
        approvers: ["role:senior"],
        question: { from: {} },
        output: { to: { path: "approval" } },
        ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
        ...(options.allowDecline !== undefined ? { allowDecline: options.allowDecline } : {}),
        ...(options.onTimeout ? { onTimeout: options.onTimeout } : {}),
      } as WorkflowDefinition["nodes"][number],
    ],
    edges: [],
    entryNode: "approve",
  };
}

// ============================================================
// Tests
// ============================================================

console.log("D2a.4 — HITL Primitives: Pause/Resume Reales\n");

// ─── 9.1. Pause (3 tests) ──────────────────────────────────

await test("pause: motor llega a nodo HITL sin immediateResponse → status='paused_hitl', pendingDecision persistido, run() retorna", async () => {
  const { executor, hitl } = makeExecutor();
  hitl.useImmediateResponse = false;
  const task = executor.startTask(singleHITLWorkflow("p-1"), null);
  const result = await executor.run(task.taskId);

  assert.equal(result.status, "paused_hitl", "status=paused_hitl");
  const finalTask = executor.getTask(task.taskId);
  assert.ok(finalTask, "task existe en el map");
  assert.equal(finalTask!.status, "paused_hitl", "task persiste en paused_hitl");
  assert.ok(finalTask!.pendingDecision, "pendingDecision persistido");
  assert.equal(finalTask!.pendingDecision!.nodeId, "approve", "pendingDecision.nodeId");
  assert.equal(finalTask!.pendingDecision!.approvers[0], "role:senior", "approvers persistidos");
  assert.ok(finalTask!.pendingDecision!.requestId.startsWith("mock-req-"), "requestId del handler");
  assert.ok(finalTask!.pendingDecision!.startedAt, "startedAt presente");
  assert.equal(hitl.calls.length, 1, "handler llamado 1 vez");
});

await test("pause: motor llega a nodo HITL con immediateResponse approved → status='completed', pendingDecision borrado, loop continúa", async () => {
  const { executor, hitl } = makeExecutor();
  hitl.useImmediateResponse = true;
  const task = executor.startTask(singleHITLWorkflow("p-2"), null);
  const result = await executor.run(task.taskId);

  assert.equal(result.status, "completed", "status=completed (nodo terminal sin edges salientes)");
  const finalTask = executor.getTask(task.taskId);
  assert.equal(finalTask!.status, "completed", "task completed");
  assert.equal(finalTask!.pendingDecision, undefined, "pendingDecision NO persistido (procesado inline)");
  assert.equal(hitl.calls.length, 1, "handler llamado 1 vez");
});

await test("pause: pendingDecision contiene nodeId, requestId, approvers, question, context, outputSchema, startedAt", async () => {
  const { executor, hitl } = makeExecutor();
  hitl.useImmediateResponse = false;
  const wf = singleHITLWorkflow("p-3", {
    outputSchema: { type: "object", required: ["approved"], properties: { approved: { type: "boolean" } } },
  });
  const task = executor.startTask(wf, null);
  await executor.run(task.taskId);

  const finalTask = executor.getTask(task.taskId);
  const pd = finalTask!.pendingDecision!;
  assert.equal(pd.nodeId, "approve");
  assert.ok(pd.requestId);
  assert.deepEqual([...pd.approvers], ["role:senior"]);
  assert.equal(pd.question, undefined, "question interpolada vacía (no hay state.question)");
  assert.equal(pd.context, undefined, "context no declarado");
  assert.ok(pd.outputSchema, "outputSchema persistido");
  assert.ok(pd.startedAt, "startedAt presente");
});

// ─── 9.2. Resume approved (3 tests) ───────────────────────

await test("resumeTask: response approved con output válido → output escrito al state, task completed", async () => {
  const { executor, hitl } = makeExecutor();
  hitl.useImmediateResponse = false;
  hitl.enqueue({ type: "approved", output: { approved: true, feedback: "OK" } });
  const wf = singleHITLWorkflow("r-1", {
    outputSchema: { type: "object", required: ["approved"], properties: { approved: { type: "boolean" }, feedback: { type: "string" } } },
  });
  const task = executor.startTask(wf, null);
  await executor.run(task.taskId); // task queda paused_hitl

  const result = await executor.resumeTask(task.taskId, { type: "approved", output: { approved: true, feedback: "OK" } });
  assert.equal(result.status, "completed", "status=completed");
  assert.deepEqual(result.state.approval, { approved: true, feedback: "OK" }, "output escrito al state");
  assert.equal(result.nodeResults.approve.status, "completed", "NodeResult=completed");
});

await test("resumeTask: response approved con output INVÁLIDO contra outputSchema → task FAILED con INVALID_OUTPUT", async () => {
  const { executor, hitl } = makeExecutor();
  hitl.useImmediateResponse = false;
  const wf = singleHITLWorkflow("r-2", {
    outputSchema: { type: "object", required: ["approved"], properties: { approved: { type: "boolean" } } },
  });
  const task = executor.startTask(wf, null);
  await executor.run(task.taskId); // paused

  const result = await executor.resumeTask(task.taskId, { type: "approved", output: { wrongField: "x" } } as unknown as HITLResponse);
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "INVALID_OUTPUT");
  assert.ok(result.error?.message.includes("outputSchema"), "mensaje menciona outputSchema");
  assert.equal(result.nodeResults.approve.status, "failed", "NodeResult=failed");
});

await test("resumeTask: response approved pero siguiente nodo es otro HITL → loop continúa, vuelve a pausar", async () => {
  const { executor, hitl } = makeExecutor();
  hitl.useImmediateResponse = false;
  hitl.enqueue({ type: "approved", output: { approved: true } });
  hitl.enqueue({ type: "approved", output: { approved: true } });
  // 2 nodos HITL en cadena. Resume el primero, debe pausar de nuevo en el segundo.
  const wf: WorkflowDefinition = {
    id: "r-3",
    name: "Two HITL",
    workflowVersion: "1.0.0",
    schemaVersion: 1,
    stateSchema: {},
    nodes: [
      { type: "hitl", id: "first", approvers: ["role:senior"], question: { from: {} }, output: { to: { path: "first" } } },
      { type: "hitl", id: "second", approvers: ["role:senior"], question: { from: {} }, output: { to: { path: "second" } } },
    ],
    edges: [{ from: "first", to: "second" }],
    entryNode: "first",
  };
  const task = executor.startTask(wf, null);
  await executor.run(task.taskId); // paused en "first"

  // Resumir el primer HITL → debe pausar en el segundo.
  const result = await executor.resumeTask(task.taskId, { type: "approved", output: { approved: true } });
  assert.equal(result.status, "paused_hitl", "vuelve a pausar en el segundo HITL");
  const finalTask = executor.getTask(task.taskId);
  assert.equal(finalTask!.pendingDecision!.nodeId, "second", "pendingDecision ahora en 'second'");
});

// ─── 9.3. Resume declined (2 tests) ───────────────────────

await test("resumeTask: response declined con allowDecline=true → task FAILED con HITL_DECLINED, declinedReason persistido", async () => {
  const { executor, hitl } = makeExecutor();
  hitl.useImmediateResponse = false;
  const wf = singleHITLWorkflow("d-1", { allowDecline: true });
  const task = executor.startTask(wf, null);
  await executor.run(task.taskId);

  const result = await executor.resumeTask(task.taskId, { type: "declined", reason: "conflict_of_interest" });
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "HITL_DECLINED");
  assert.ok(result.error?.message.includes("conflict_of_interest"));
  assert.equal(result.nodeResults.approve.declinedReason, "conflict_of_interest", "declinedReason persistido en NodeResult");
});

await test("resumeTask: response declined con allowDecline=false → motor procesa el decline igual (permisivo, backward-compat)", async () => {
  const { executor, hitl } = makeExecutor();
  hitl.useImmediateResponse = false;
  // Nodo SIN allowDecline (default false). El motor es permisivo (decisión
  // revisada post-tests preexistentes): procesa el decline igualmente.
  const wf = singleHITLWorkflow("d-2");
  const task = executor.startTask(wf, null);
  await executor.run(task.taskId);

  const result = await executor.resumeTask(task.taskId, { type: "declined", reason: "needs_revision" });
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "HITL_DECLINED", "HITL_DECLINED aunque allowDeclive=false (permisivo)");
  assert.equal(result.nodeResults.approve.declinedReason, "needs_revision");
});

// ─── 9.4. Resume timeout (3 tests) ────────────────────────

await test("resumeTask: response timeout con onTimeout='fail' (default) → task FAILED con HITL_TIMEOUT", async () => {
  const { executor, hitl } = makeExecutor();
  hitl.useImmediateResponse = false;
  const wf = singleHITLWorkflow("t-1"); // onTimeout no declarado → default 'fail'
  const task = executor.startTask(wf, null);
  await executor.run(task.taskId);

  const result = await executor.resumeTask(task.taskId, { type: "timeout" });
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "HITL_TIMEOUT");
});

await test("resumeTask: response timeout con onTimeout='approve' → output {approved:true} escrito, task completed", async () => {
  const { executor, hitl } = makeExecutor();
  hitl.useImmediateResponse = false;
  const wf = singleHITLWorkflow("t-2", { onTimeout: "approve" });
  const task = executor.startTask(wf, null);
  await executor.run(task.taskId);

  const result = await executor.resumeTask(task.taskId, { type: "timeout" });
  assert.equal(result.status, "completed", "task completed (nodo terminal)");
  assert.deepEqual(result.state.approval, { approved: true }, "output {approved:true} escrito");
});

await test("resumeTask: response timeout con onTimeout='reject' → output {approved:false, feedback:'timeout'} escrito, task completed", async () => {
  const { executor, hitl } = makeExecutor();
  hitl.useImmediateResponse = false;
  const wf = singleHITLWorkflow("t-3", { onTimeout: "reject" });
  const task = executor.startTask(wf, null);
  await executor.run(task.taskId);

  const result = await executor.resumeTask(task.taskId, { type: "timeout" });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.state.approval, { approved: false, feedback: "timeout" });
});

// ─── 9.5. Edge cases del resumeTask (2 tests) ────────────

await test("resumeTask: en task NO paused_hitl (status=completed) → ExecutorError INVALID_TASK_STATE", async () => {
  const { executor, hitl } = makeExecutor();
  hitl.useImmediateResponse = true;
  const task = executor.startTask(singleHITLWorkflow("e-1"), null);
  await executor.run(task.taskId); // completed (immediateResponse)

  let caught: unknown = undefined;
  try {
    await executor.resumeTask(task.taskId, { type: "approved", output: { approved: true } });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, "resumeTask debería haber tirado");
  const msg = caught instanceof Error ? caught.message : String(caught);
  assert.ok(msg.includes("INVALID_TASK_STATE") || msg.includes("no está en paused_hitl"), `mensaje: ${msg}`);
});

await test("resumeTask: en task paused_hitl después de cleanup → funciona (cleanup retiene la task)", async () => {
  const { executor, hitl } = makeExecutor();
  hitl.useImmediateResponse = false;
  hitl.enqueue({ type: "approved", output: { approved: true } });
  const task = executor.startTask(singleHITLWorkflow("e-2"), null);
  await executor.run(task.taskId); // paused

  executor.cleanup(task.taskId); // libera cache, retiene la task

  const result = await executor.resumeTask(task.taskId, { type: "approved", output: { approved: true } });
  assert.equal(result.status, "completed", "resumeTask funciona post-cleanup");
});

// ─── 9.6. Lifecycle interactions (3 tests) ────────────────

await test("cancelTask: en task paused_hitl → status='cancelled', pendingDecision RETENIDO para audit", async () => {
  const { executor, hitl } = makeExecutor();
  hitl.useImmediateResponse = false;
  const task = executor.startTask(singleHITLWorkflow("c-1"), null);
  await executor.run(task.taskId);

  executor.cancelTask(task.taskId);
  const final = executor.getTask(task.taskId);
  assert.equal(final!.status, "cancelled", "status=cancelled");
  assert.ok(final!.pendingDecision, "pendingDecision RETENIDO (no se borra en cancelTask)");
  assert.equal(final!.pendingDecision!.nodeId, "approve");
});

await test("purgeTask: en task paused_hitl → task eliminada del Map, irrecuperable", async () => {
  const { executor, hitl } = makeExecutor();
  hitl.useImmediateResponse = false;
  const task = executor.startTask(singleHITLWorkflow("c-2"), null);
  await executor.run(task.taskId);

  executor.purgeTask(task.taskId);
  assert.equal(executor.getTask(task.taskId), undefined, "task eliminada del Map");
  // resumeTask después de purgeTask debe fallar.
  let caught: unknown = undefined;
  try {
    await executor.resumeTask(task.taskId, { type: "approved", output: { approved: true } });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, "resumeTask debería haber tirado");
  const msg = caught instanceof Error ? caught.message : String(caught);
  assert.ok(msg.includes("TASK_NOT_FOUND") || msg.includes("no existe"), `mensaje: ${msg}`);
});

await test("replayTask: en task paused_hitl → ExecutorError INVALID_TASK_STATE (igual que running)", async () => {
  const { executor, hitl } = makeExecutor();
  hitl.useImmediateResponse = false;
  const task = executor.startTask(singleHITLWorkflow("c-3"), null);
  await executor.run(task.taskId); // paused

  // Usamos try/catch en lugar de assert.rejects para evitar el callback
  // que puede dar problemas con la verificación de la clase.
  let caught: unknown = undefined;
  try {
    await executor.replayTask(task.taskId);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, "replayTask debería haber tirado");
  const msg = caught instanceof Error ? caught.message : String(caught);
  assert.ok(msg.includes("INVALID_TASK_STATE") || msg.includes("no está en estado terminal"), `mensaje: ${msg}`);
});

// ─── 9.7. immediateResponse (2 tests) ─────────────────────

await test("immediate: handler retorna immediateResponse approved → motor nunca entra en paused_hitl, procesa inline, task completed", async () => {
  const { executor, hitl } = makeExecutor();
  hitl.useImmediateResponse = true;
  hitl.enqueue({ type: "approved", output: { approved: true, feedback: "OK" } });
  const wf = singleHITLWorkflow("i-1", {
    outputSchema: { type: "object", required: ["approved"], properties: { approved: { type: "boolean" }, feedback: { type: "string" } } },
  });
  const task = executor.startTask(wf, null);
  const result = await executor.run(task.taskId);

  assert.equal(result.status, "completed", "completed (nodo terminal sin edges salientes)");
  const final = executor.getTask(task.taskId);
  assert.equal(final!.status, "completed", "no pasó por paused_hitl");
  assert.equal(final!.pendingDecision, undefined, "nunca persistió pendingDecision");
  assert.deepEqual(result.state.approval, { approved: true, feedback: "OK" });
});

await test("immediate: handler retorna immediateResponse declined → motor nunca entra en paused_hitl, marca nodo como failed con HITL_DECLINED", async () => {
  const { executor, hitl } = makeExecutor();
  hitl.useImmediateResponse = true;
  hitl.enqueue({ type: "declined", reason: "other" });
  const wf = singleHITLWorkflow("i-2", { allowDecline: true });
  const task = executor.startTask(wf, null);
  const result = await executor.run(task.taskId);

  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "HITL_DECLINED");
  const final = executor.getTask(task.taskId);
  assert.equal(final!.pendingDecision, undefined, "nunca persistió pendingDecision (immediate)");
  assert.equal(result.nodeResults.approve.declinedReason, "other");
});

// ============================================================
// Resumen
// ============================================================

console.log(`\n✓ ${passed} tests pasaron, ✗ ${failed} fallaron`);
if (failed > 0) {
  process.exit(1);
}
