/**
 * D3.1 � Storage Persistence (Cross-Restart del Motor).
 *
 * Tests del sprint que cierra CRIT-1/MAYR-LEGAL. La task `paused_hitl`
 * sobrevive un restart del server. Cubre:
 * - Bloque A (1-10): InMemoryTaskStore roundtrip.
 * - Bloque B (11-18): SqliteTaskStore con DB en memoria.
 * - Bloque C (19-26): Recovery del WorkflowExecutor al startup.
 * - Bloque D (27-34): Persistencia en checkpoints del motor.
 * - Bloque E (35-38): HITLHandler.onResumeFromRestart.
 *
 * Total: 38 tests.
 *
 * Ver `AGENT_D3_1_STORAGE_PERSISTENCE_SPEC.md` �7.
 *
 * Patr�n: igual que `test_workflow_d2a_4.mts`. Counter de passed/failed
 * con `assert` (Node built-in). No usa libs externas.
 */

import {
  WorkflowExecutor,
  FunctionRegistry,
  InMemoryTaskStore,
  SqliteTaskStore,
  runPersistenceMigrations,
} from "./src/agent/workflow-engine/executor/index.js";
import type {
  LLMInvoker,
  HITLHandler,
  HITLResponse,
  WorkflowFunction,
  HITLInitiateResult,
  HITLInitiateParams,
  ExecutorConfig,
} from "./src/agent/workflow-engine/executor/types.js";
import type {
  Task,
  PendingHITLDecision,
  WorkflowDefinition,
  Node as WorkflowNode,
} from "./src/agent/workflow-engine/dsl/types.js";
import type { TaskStore } from "./src/agent/workflow-engine/persistence/task-store.js";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

// ============================================================
// Test runner
// ============================================================

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  \u2713 ${name}`);
    })
    .catch((e) => {
      failed++;
      console.error(`  \u2717 ${name}`);
      console.error(`    ${e instanceof Error ? e.message : String(e)}`);
    });
}

// ============================================================
// Helpers / fixtures
// ============================================================

function makeTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    taskId: "task-1",
    workflowId: "wf-1",
    workflowVersion: "1.0.0",
    state: { input: { x: 1 }, step: 0 },
    status: "pending",
    currentNode: "start",
    nodeResults: {},
    createdAt: now,
    updatedAt: now,
    tenantId: "default",
    input: { x: 1 },
    ...overrides,
  };
}

function makePendingDecision(
  overrides: Partial<PendingHITLDecision> = {},
): PendingHITLDecision {
  return {
    nodeId: "review",
    requestId: "req-abc",
    approvers: ["role:lawyer"],
    question: "�Aprobar?",
    outputSchema: { type: "object" },
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSimpleWorkflow(): WorkflowDefinition {
  return {
    id: "wf-test",
    name: "Test WF",
    workflowVersion: "1.0.0",
    schemaVersion: 1,
    stateSchema: {
      type: "object",
      properties: { input: { type: "object" } },
      required: ["input"],
      additionalProperties: false,
    },
    nodes: [
      {
        id: "start",
        type: "function",
        functionRef: "noop",
        input: { from: { path: "input" } },
        output: { to: { path: "start" } },
      },
    ],
    edges: [],
    entryNode: "start",
  };
}

class NoopLLM implements LLMInvoker {
  async invoke(): Promise<never> {
    throw new Error("LLM no deber�a invocarse");
  }
}

class MockHITL implements HITLHandler {
  public initiateCalls = 0;
  public onResumeCalls: Array<{ taskId: string; pending: PendingHITLDecision }> = [];
  public onResumeThrow: Error | null = null;
  useImmediateResponse = true;
  immediateResponse: HITLResponse = { type: "approved", output: { ok: true } };

  async initiate(_params: HITLInitiateParams): Promise<HITLInitiateResult> {
    this.initiateCalls++;
    if (this.useImmediateResponse) {
      return { requestId: "mock-req-1", immediateResponse: this.immediateResponse };
    }
    return { requestId: "mock-req-1" };
  }

  onResumeFromRestart(taskId: string, pending: PendingHITLDecision): void {
    this.onResumeCalls.push({ taskId, pending });
    if (this.onResumeThrow) throw this.onResumeThrow;
  }
}

function makeConfig(hitl: HITLHandler): ExecutorConfig {
  const noop: WorkflowFunction = () => ({ ok: true });
  return {
    functionRegistry: new Map([["noop", noop]]),
    llmInvoker: new NoopLLM(),
    hitlHandler: hitl,
  };
}

// ============================================================
// BLOQUE A � InMemoryTaskStore
// ============================================================

async function blockA() {
  console.log("\n[Bloque A] InMemoryTaskStore");

  await test("A1: save + load roundtrip preserva todos los campos", () => {
    const store = new InMemoryTaskStore();
    const task = makeTask({
      state: { input: { complex: { nested: [1, 2, 3] } } },
      nodeResults: { n1: { nodeId: "n1", status: "completed", costUsd: 0.01, startedAt: "2026-01-01T00:00:00Z" } },
    });
    store.save(task, "default");
    const loaded = store.load(task.taskId, "default");
    assert.ok(loaded);
    assert.equal(loaded.taskId, task.taskId);
    assert.equal(loaded.status, task.status);
    assert.deepEqual(loaded.state, task.state);
    assert.equal(loaded.nodeResults.n1.costUsd, 0.01);
  });

  await test("A2: save de la misma taskId hace UPDATE (no INSERT duplicado)", () => {
    const store = new InMemoryTaskStore();
    const t1 = makeTask({ status: "pending" });
    const t2 = { ...t1, status: "running" as const };
    store.save(t1, "default");
    store.save(t2, "default");
    assert.equal(store.load(t1.taskId, "default")?.status, "running");
  });

  await test("A3: load de task inexistente retorna null", () => {
    const store = new InMemoryTaskStore();
    assert.equal(store.load("nope", "default"), null);
  });

  await test("A4: loadActive retorna solo no-terminales", () => {
    const store = new InMemoryTaskStore();
    store.save(makeTask({ taskId: "t1", status: "pending" }), "default");
    store.save(makeTask({ taskId: "t2", status: "running" }), "default");
    store.save(makeTask({ taskId: "t3", status: "paused_hitl" }), "default");
    store.save(makeTask({ taskId: "t4", status: "paused_error" }), "default");
    const active = store.loadActive("default");
    assert.equal(active.length, 4);
    assert.deepEqual(active.map(t => t.taskId).sort(), ["t1", "t2", "t3", "t4"]);
  });

  await test("A5: loadActive excluye completed, failed, cancelled", () => {
    const store = new InMemoryTaskStore();
    store.save(makeTask({ taskId: "t1", status: "pending" }), "default");
    store.save(makeTask({ taskId: "t2", status: "completed" }), "default");
    store.save(makeTask({ taskId: "t3", status: "failed" }), "default");
    store.save(makeTask({ taskId: "t4", status: "cancelled" }), "default");
    const active = store.loadActive("default");
    assert.equal(active.length, 1);
    assert.equal(active[0].taskId, "t1");
  });

  await test("A6: save con status terminal BORRA la task (no se persiste)", () => {
    const store = new InMemoryTaskStore();
    const t1 = makeTask({ taskId: "t1", status: "pending" });
    store.save(t1, "default");
    store.save({ ...t1, status: "completed" }, "default");
    assert.equal(store.load("t1", "default"), null);
  });

  await test("A7: delete elimina la task", () => {
    const store = new InMemoryTaskStore();
    store.save(makeTask({ taskId: "t1" }), "default");
    store.delete("t1", "default");
    assert.equal(store.load("t1", "default"), null);
  });

  await test("A8: delete de task inexistente no lanza (idempotente)", () => {
    const store = new InMemoryTaskStore();
    // No debe lanzar
    store.delete("nope", "default");
  });

  await test("A9: save con tenantId pisa el de la task", () => {
    const store = new InMemoryTaskStore();
    const t = makeTask({ taskId: "t1", tenantId: "default" });
    store.save(t, "tenantA");
    const loaded = store.load("t1", "tenantA");
    assert.ok(loaded);
    assert.equal(loaded.tenantId, "tenantA");
  });

  await test("A10: load con tenantId distinto retorna null", () => {
    const store = new InMemoryTaskStore();
    store.save(makeTask({ taskId: "t1", tenantId: "tenantA" }), "default");
    const loaded = store.load("t1", "tenantB");
    assert.equal(loaded, null);
  });
}

// ============================================================
// BLOQUE B � SqliteTaskStore
// ============================================================

function freshSqliteDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  return db;
}

async function blockB() {
  console.log("\n[Bloque B] SqliteTaskStore");

  await test("B11: inicializaci�n crea la tabla idempotentemente", () => {
    const db = freshSqliteDb();
    runPersistenceMigrations(db);
    runPersistenceMigrations(db); // 2da vez no debe fallar
    runPersistenceMigrations(db); // 3ra vez tampoco
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='paused_tasks'")
      .all() as Array<{ name: string }>;
    assert.equal(tables.length, 1);
  });

  await test("B12: roundtrip preserva state complejo (nested objects + arrays)", () => {
    const db = freshSqliteDb();
    const store = new SqliteTaskStore(db);
    const complex = {
      input: { x: 1 },
      clauses: [{ id: "c1", text: "Lorem ipsum" }, { id: "c2", text: "Dolor" }],
      meta: { nested: { deep: [true, false, null] } },
    };
    const t = makeTask({ state: complex, taskId: "t1" });
    store.save(t, "default");
    const loaded = store.load("t1", "default");
    assert.ok(loaded);
    assert.deepEqual(loaded.state, complex);
  });

  await test("B13: roundtrip preserva pendingDecision con requestId y outputSchema", () => {
    const db = freshSqliteDb();
    const store = new SqliteTaskStore(db);
    const t = makeTask({
      status: "paused_hitl",
      taskId: "t1",
      pendingDecision: makePendingDecision({
        requestId: "req-xyz",
        approvers: ["role:senior_partner", "user:abc"],
        outputSchema: {
          type: "object",
          properties: { approved: { type: "boolean" }, reason: { type: "string" } },
          required: ["approved"],
        },
      }),
    });
    store.save(t, "default");
    const loaded = store.load("t1", "default");
    assert.ok(loaded);
    assert.ok(loaded.pendingDecision);
    assert.equal(loaded.pendingDecision.requestId, "req-xyz");
    assert.equal(loaded.pendingDecision.approvers.length, 2);
    assert.ok(loaded.pendingDecision.outputSchema);
  });

  await test("B14: 100 tasks en store, loadActive respeta orden por updatedAt ASC", () => {
    const db = freshSqliteDb();
    const store = new SqliteTaskStore(db);
    const now = new Date("2026-01-01T00:00:00Z").getTime();
    for (let i = 0; i < 100; i++) {
      const ts = new Date(now + i * 1000).toISOString();
      store.save(makeTask({ taskId: `t${i.toString().padStart(3, "0")}`, updatedAt: ts }), "default");
    }
    const active = store.loadActive("default");
    assert.equal(active.length, 100);
    // El primero en updatedAt ASC debe ser t000 (el m�s viejo).
    assert.equal(active[0].taskId, "t000");
    // El �ltimo debe ser t099.
    assert.equal(active[99].taskId, "t099");
  });

  await test("B15: save preserva migratedWorkflow y appliedMigrations", () => {
    const db = freshSqliteDb();
    const store = new SqliteTaskStore(db);
    const wf = makeSimpleWorkflow();
    const t = makeTask({
      taskId: "t1",
      migratedWorkflow: wf,
      appliedMigrations: ["1->2", "2->3"],
    });
    store.save(t, "default");
    const loaded = store.load("t1", "default");
    assert.ok(loaded);
    assert.ok(loaded.migratedWorkflow);
    assert.equal(loaded.migratedWorkflow?.id, "wf-test");
    assert.deepEqual(loaded.appliedMigrations, ["1->2", "2->3"]);
  });

  await test("B16: indices existen despu�s de la migraci�n", () => {
    const db = freshSqliteDb();
    runPersistenceMigrations(db);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'paused_tasks_%'")
      .all() as Array<{ name: string }>;
    const names = indexes.map(i => i.name);
    assert.ok(names.includes("paused_tasks_tenant_idx"));
    assert.ok(names.includes("paused_tasks_status_idx"));
  });

  await test("B17: delete elimina la fila f�sicamente", () => {
    const db = freshSqliteDb();
    const store = new SqliteTaskStore(db);
    store.save(makeTask({ taskId: "t1" }), "default");
    assert.ok(store.load("t1", "default"));
    store.delete("t1", "default");
    assert.equal(store.load("t1", "default"), null);
    // Y la fila no est� en la DB
    const count = (db.prepare("SELECT COUNT(*) as c FROM paused_tasks").get() as { c: number }).c;
    assert.equal(count, 0);
  });

  await test("B18: terminal status en save NO se persiste (purga)", () => {
    const db = freshSqliteDb();
    const store = new SqliteTaskStore(db);
    const t = makeTask({ status: "completed" });
    store.save(t, "default");
    assert.equal(store.load("t1", "default"), null);
    const count = (db.prepare("SELECT COUNT(*) as c FROM paused_tasks").get() as { c: number }).c;
    assert.equal(count, 0);
  });
}

// ============================================================
// BLOQUE C � Recovery del WorkflowExecutor
// ============================================================

async function blockC() {
  console.log("\n[Bloque C] Recovery del WorkflowExecutor");

  await test("C19: constructor con taskStore re-hidrata tasks paused_hitl", () => {
    const store = new InMemoryTaskStore();
    const persisted = makeTask({
      taskId: "t1",
      status: "paused_hitl",
      pendingDecision: makePendingDecision({ requestId: "req-original" }),
    });
    store.save(persisted, "default");

    const cfg = makeConfig(new MockHITL());
    const exec = new WorkflowExecutor({ ...cfg, enablePersistence: true }, store);
    const rehydrated = exec.getTask("t1");
    assert.ok(rehydrated);
    assert.equal(rehydrated.status, "paused_hitl");
    assert.equal(rehydrated.pendingDecision?.requestId, "req-original");
  });

  await test("C20: constructor sin taskStore no intenta recovery (modo legacy)", () => {
    const cfg = makeConfig(new MockHITL());
    const exec = new WorkflowExecutor(cfg);
    // Crear task normal
    const wf = makeSimpleWorkflow();
    const t = exec.startTask(wf, { x: 1 });
    assert.equal(exec.getTask(t.taskId).status, "pending");
  });

  await test("C21: task 'running' al crash se re-hidrata como 'paused_hitl' sintetica", () => {
    const store = new InMemoryTaskStore();
    store.save(
      makeTask({
        taskId: "t1",
        status: "running",
        currentNode: "middle-step",
      }),
      "default",
    );

    const cfg = makeConfig(new MockHITL());
    const exec = new WorkflowExecutor({ ...cfg, enablePersistence: true }, store);
    const rehydrated = exec.getTask("t1");
    assert.ok(rehydrated);
    assert.equal(rehydrated.status, "paused_hitl");
    assert.ok(rehydrated.pendingDecision);
    assert.equal(rehydrated.pendingDecision?.requestId, "synthetic-from-restart");
  });

  await test("C21b: rehidratacion persiste la mutacion de vuelta al store (FIX I-1)", () => {
    // FIX I-1 (audit D3.1 2026-06-13): el store debe reflejar la mutacion
    // de running a paused_hitl. Si no, queda mintiendo y un segundo restart
    // re-aplicaria la mutacion.
    const store = new InMemoryTaskStore();
    store.save(
      makeTask({
        taskId: "t1",
        status: "running",
        currentNode: "middle-step",
      }),
      "default",
    );

    const cfg = makeConfig(new MockHITL());
    new WorkflowExecutor({ ...cfg, enablePersistence: true }, store);
    // Despues del recovery, el store DEBE tener la version mutada.
    const persisted = store.load("t1", "default");
    assert.ok(persisted);
    assert.equal(persisted.status, "paused_hitl");
    assert.ok(persisted.pendingDecision);
    assert.equal(persisted.pendingDecision?.requestId, "synthetic-from-restart");
  });

  await test("C22: task paused_hitl re-hidratada llama handler.onResumeFromRestart", () => {
    const store = new InMemoryTaskStore();
    store.save(makeTask({ taskId: "t1", status: "paused_hitl", pendingDecision: makePendingDecision() }), "default");
    const handler = new MockHITL();
    const cfg = makeConfig(handler);
    new WorkflowExecutor({ ...cfg, enablePersistence: true }, store);
    assert.equal(handler.onResumeCalls.length, 1);
    assert.equal(handler.onResumeCalls[0].taskId, "t1");
  });

  await test("C23: handler sin onResumeFromRestart: recovery funciona, no se llama nada", () => {
    // MockHITL SIN implementar el m�todo (lo borramos con cast).
    // El interface permite no implementarlo. Probamos que no rompe.
    const store = new InMemoryTaskStore();
    store.save(makeTask({ taskId: "t1", status: "paused_hitl" }), "default");
    const minimalHandler: HITLHandler = {
      async initiate() {
        return { requestId: "x" };
      },
    };
    const cfg = makeConfig(minimalHandler);
    const exec = new WorkflowExecutor({ ...cfg, enablePersistence: true }, store);
    assert.ok(exec.getTask("t1"));
  });

  await test("C24: handler.onResumeFromRestart lanza: el recovery no se rompe", () => {
    const store = new InMemoryTaskStore();
    store.save(makeTask({ taskId: "t1", status: "paused_hitl", pendingDecision: makePendingDecision() }), "default");
    store.save(makeTask({ taskId: "t2", status: "paused_hitl", pendingDecision: makePendingDecision() }), "default");
    const handler = new MockHITL();
    handler.onResumeThrow = new Error("handler bug");
    const cfg = makeConfig(handler);
    // No debe lanzar. La 2da task se re-hidrata tambi�n.
    new WorkflowExecutor({ ...cfg, enablePersistence: true }, store);
    // El handler fue llamado para ambas (a pesar de throw en la primera).
    // El push a onResumeCalls ocurre ANTES del throw en el MockHITL.
    assert.equal(handler.onResumeCalls.length, 2);
  });

  await test("C25: recovery preserva pendingDecision.startedAt (no se resetea)", () => {
    const original = "2026-01-01T10:00:00Z";
    const store = new InMemoryTaskStore();
    store.save(
      makeTask({
        taskId: "t1",
        status: "paused_hitl",
        pendingDecision: makePendingDecision({ startedAt: original }),
      }),
      "default",
    );
    const cfg = makeConfig(new MockHITL());
    const exec = new WorkflowExecutor({ ...cfg, enablePersistence: true }, store);
    const rehydrated = exec.getTask("t1");
    assert.equal(rehydrated?.pendingDecision?.startedAt, original);
  });

  await test("C26: enablePersistence=false NO recovery aunque haya taskStore", () => {
    const store = new InMemoryTaskStore();
    store.save(makeTask({ taskId: "t1", status: "paused_hitl" }), "default");
    const cfg = makeConfig(new MockHITL());
    // enablePersistence omitido ? false
    const exec = new WorkflowExecutor(cfg, store);
    // t1 NO est� en el executor (no se re-hidrat� porque no hay enable)
    assert.equal(exec.getTask("t1"), undefined);
  });
}

// ============================================================
// BLOQUE D � Persistencia en checkpoints
// ============================================================

async function blockD() {
  console.log("\n[Bloque D] Persistencia en checkpoints");

  await test("D27: startTask con enablePersistence persiste la task al store", () => {
    const store = new InMemoryTaskStore();
    const cfg = makeConfig(new MockHITL());
    const exec = new WorkflowExecutor({ ...cfg, enablePersistence: true }, store);
    const wf = makeSimpleWorkflow();
    const t = exec.startTask(wf, { x: 1 });
    const loaded = store.load(t.taskId, "default");
    assert.ok(loaded);
    assert.equal(loaded.taskId, t.taskId);
    assert.equal(loaded.status, "pending");
  });

  await test("D28: run() que entra a paused_hitl persiste con pendingDecision", async () => {
    const store = new InMemoryTaskStore();
    const handler = new MockHITL();
    handler.useImmediateResponse = false; // pausa real
    const cfg = makeConfig(handler);
    const exec = new WorkflowExecutor({ ...cfg, enablePersistence: true }, store);

    const wf: WorkflowDefinition = {
      id: "wf-hitl",
      name: "HITL WF",
      workflowVersion: "1.0.0",
      schemaVersion: 1,
      stateSchema: { type: "object", properties: { input: { type: "object" } }, required: ["input"], additionalProperties: false },
      nodes: [
        { id: "review", type: "hitl", approvers: ["role:lawyer"], question: { from: { template: "�OK?" } }, output: { to: { path: "review" } } },
        { id: "end", type: "function", functionRef: "noop", input: { from: { path: "input" } }, output: { to: { path: "end" } } },
      ],
      edges: [{ from: "review", to: "end" }],
      entryNode: "review",
    };
    const t = exec.startTask(wf, { x: 1 });
    await exec.run(t.taskId);

    const loaded = store.load(t.taskId, "default");
    assert.ok(loaded);
    assert.equal(loaded.status, "paused_hitl");
    assert.ok(loaded.pendingDecision);
  });

  await test("D29: resumeTask con respuesta exitosa elimina del store (completed se purga)", async () => {
    const store = new InMemoryTaskStore();
    const handler = new MockHITL();
    handler.useImmediateResponse = false;
    const cfg = makeConfig(handler);
    const exec = new WorkflowExecutor({ ...cfg, enablePersistence: true }, store);

    const wf: WorkflowDefinition = {
      id: "wf-hitl-2",
      name: "HITL WF 2",
      workflowVersion: "1.0.0",
      schemaVersion: 1,
      stateSchema: { type: "object", properties: { input: { type: "object" } }, required: ["input"], additionalProperties: false },
      nodes: [
        { id: "review", type: "hitl", approvers: ["role:lawyer"], question: { from: { template: "�OK?" } }, output: { to: { path: "review" } } },
        { id: "end", type: "function", functionRef: "noop", input: { from: { path: "input" } }, output: { to: { path: "end" } } },
      ],
      edges: [{ from: "review", to: "end" }],
      entryNode: "review",
    };
    const t = exec.startTask(wf, { x: 1 });
    await exec.run(t.taskId);
    assert.ok(store.load(t.taskId, "default"));

    await exec.resumeTask(t.taskId, { type: "approved", output: { ok: true } });

    // Despu�s de resume + complete, la task se purg� del store.
    assert.equal(store.load(t.taskId, "default"), null);
  });

  await test("D30: cancelTask persiste con status='cancelled'", () => {
    const store = new InMemoryTaskStore();
    const cfg = makeConfig(new MockHITL());
    const exec = new WorkflowExecutor({ ...cfg, enablePersistence: true }, store);
    const wf = makeSimpleWorkflow();
    const t = exec.startTask(wf, { x: 1 });
    exec.cancelTask(t.taskId);
    // cancelled es terminal ? purga (D3.1, �2.1)
    assert.equal(store.load(t.taskId, "default"), null);
  });

  await test("D31: cleanup(taskId) NO elimina del store", () => {
    const store = new InMemoryTaskStore();
    const cfg = makeConfig(new MockHITL());
    const exec = new WorkflowExecutor({ ...cfg, enablePersistence: true }, store);
    const wf = makeSimpleWorkflow();
    const t = exec.startTask(wf, { x: 1 });
    exec.cleanup(t.taskId);
    // La task SIGUE en el store.
    const loaded = store.load(t.taskId, "default");
    assert.ok(loaded);
  });

  await test("D32: purgeTask(taskId) elimina del store", () => {
    const store = new InMemoryTaskStore();
    const cfg = makeConfig(new MockHITL());
    const exec = new WorkflowExecutor({ ...cfg, enablePersistence: true }, store);
    const wf = makeSimpleWorkflow();
    const t = exec.startTask(wf, { x: 1 });
    assert.ok(store.load(t.taskId, "default"));
    exec.purgeTask(t.taskId);
    assert.equal(store.load(t.taskId, "default"), null);
  });

  await test("D33: sin enablePersistence, el motor no toca el store", () => {
    const store = new InMemoryTaskStore();
    const cfg = makeConfig(new MockHITL());
    // enablePersistence omitido
    const exec = new WorkflowExecutor(cfg, store);
    const wf = makeSimpleWorkflow();
    exec.startTask(wf, { x: 1 });
    // Store vac�o: nada se persisti�.
    assert.equal(store.loadActive("default").length, 0);
  });

  await test("D34: enablePersistence=true + store.save lanza: error se propaga al caller", () => {
    // Mock de store que lanza en save (simula DB lock).
    class ThrowingStore implements TaskStore {
      save(_task: Task, _tenantId: string): void {
        throw new Error("DB locked");
      }
      load(_taskId: string, _tenantId: string): Task | null {
        return null;
      }
      loadActive(_tenantId: string): readonly Task[] {
        return [];
      }
      delete(_taskId: string, _tenantId: string): void {}
    }
    const store = new ThrowingStore();
    const cfg = makeConfig(new MockHITL());
    const exec = new WorkflowExecutor({ ...cfg, enablePersistence: true }, store);
    const wf = makeSimpleWorkflow();
    // startTask llama a save, debe lanzar.
    assert.throws(() => exec.startTask(wf, { x: 1 }), /DB locked/);
  });
}

// ============================================================
// BLOQUE E � HITLHandler.onResumeFromRestart
// ============================================================

async function blockE() {
  console.log("\n[Bloque E] HITLHandler.onResumeFromRestart");

  await test("E35: handler sin el m�todo: recovery funciona, no se llama nada", () => {
    const store = new InMemoryTaskStore();
    store.save(makeTask({ taskId: "t1", status: "paused_hitl" }), "default");
    const handler: HITLHandler = {
      async initiate() {
        return { requestId: "x" };
      },
    };
    const cfg = makeConfig(handler);
    // No debe lanzar.
    new WorkflowExecutor({ ...cfg, enablePersistence: true }, store);
  });

  await test("E36: handler con el m�todo: se llama una vez por task paused_hitl", () => {
    const store = new InMemoryTaskStore();
    store.save(makeTask({ taskId: "t1", status: "paused_hitl", pendingDecision: makePendingDecision() }), "default");
    store.save(makeTask({ taskId: "t2", status: "paused_hitl", pendingDecision: makePendingDecision({ requestId: "req-2" }) }), "default");
    store.save(makeTask({ taskId: "t3", status: "pending" }), "default"); // no se notifica
    const handler = new MockHITL();
    const cfg = makeConfig(handler);
    new WorkflowExecutor({ ...cfg, enablePersistence: true }, store);
    assert.equal(handler.onResumeCalls.length, 2);
  });

  await test("E37: handler recibe el pendingDecision completo", () => {
    const store = new InMemoryTaskStore();
    const pd = makePendingDecision({ requestId: "req-detailed", approvers: ["role:abc", "user:xyz"] });
    store.save(makeTask({ taskId: "t1", status: "paused_hitl", pendingDecision: pd }), "default");
    const handler = new MockHITL();
    const cfg = makeConfig(handler);
    new WorkflowExecutor({ ...cfg, enablePersistence: true }, store);
    assert.equal(handler.onResumeCalls.length, 1);
    const received = handler.onResumeCalls[0].pending;
    assert.equal(received.requestId, "req-detailed");
    assert.equal(received.approvers.length, 2);
  });

  await test("E38: recovery llama al handler con la task 'running' re-mapeada (synthetic)", () => {
    const store = new InMemoryTaskStore();
    store.save(makeTask({ taskId: "t1", status: "running" }), "default");
    const handler = new MockHITL();
    const cfg = makeConfig(handler);
    new WorkflowExecutor({ ...cfg, enablePersistence: true }, store);
    // La task fue re-mapeada a paused_hitl sint�tica ? handler fue notificado.
    assert.equal(handler.onResumeCalls.length, 1);
    assert.equal(handler.onResumeCalls[0].pending.requestId, "synthetic-from-restart");
  });
}

// ============================================================
// Run all
// ============================================================

async function main() {
  console.log("=== D3.1 � Storage Persistence Tests ===\n");
  await blockA();
  await blockB();
  await blockC();
  await blockD();
  await blockE();
  console.log(`\n=== Resultado: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
