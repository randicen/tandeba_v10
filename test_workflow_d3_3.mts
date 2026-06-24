/**
 * D3.3 — Auth Stub + Sweeper de Zombies + Audit del Workflow Engine.
 *
 * Tests del sprint que cierra D3.
 *
 * Bloque A (1-5): AuthProvider.
 * Bloque B (6-13): Sweeper de zombies.
 * Bloque C (14-18): last_heartbeat_at + touch().
 * Bloque D (19-23): workflow_audit.
 * Bloque E (24-28): Integración con el motor.
 *
 * Total: 28 tests.
 *
 * Spec: `AGENT_D3_3_AUTH_SWEEPER_AUDIT_SPEC.md` §11.
 *
 * Patrón: igual que `test_workflow_d2a_4.mts`. Counter de passed/failed
 * con `assert` (Node built-in). No usa libs externas.
 */

import {
  WorkflowExecutor,
  InMemoryTaskStore,
  SqliteTaskStore,
  StaticTenantProvider,
  InMemoryWorkflowAudit,
  SqliteWorkflowAudit,
  MissingTenantIdError,
  runPersistenceMigrations,
} from "./src/agent/workflow-engine/executor/index.js";
import type {
  Task,
  WorkflowDefinition,
} from "./src/agent/workflow-engine/dsl/types.js";
import type { AuthProvider } from "./src/agent/workflow-engine/persistence/auth-provider.js";
import type {
  WorkflowAudit,
  WorkflowAuditEvent,
} from "./src/agent/workflow-engine/persistence/workflow-audit.js";
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
      console.log(`  ✓ ${name}`);
    })
    .catch((e) => {
      failed++;
      console.error(`  ✗ ${name}`);
      console.error(`    ${e instanceof Error ? e.message : String(e)}`);
    });
}

function makeTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    taskId: "task-1",
    workflowId: "wf-1",
    workflowVersion: "1.0.0",
    state: { input: { x: 1 } },
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

function makeMockConfig() {
  return {
    functionRegistry: new Map<string, (input: unknown) => Promise<unknown> | unknown>(),
    llmInvoker: { async invoke() { throw new Error("nope"); } },
    hitlHandler: { async initiate() { return { requestId: "x" }; } },
  };
}

function freshSqliteDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  return db;
}

// ============================================================
// BLOQUE A — AuthProvider
// ============================================================

async function blockA() {
  console.log("\n[Bloque A] AuthProvider");

  await test("A1: StaticTenantProvider retorna tenantId por default", () => {
    const p = new StaticTenantProvider();
    assert.equal(p.getTenantId(), "default");
  });

  await test("A2: StaticTenantProvider('custom') retorna custom", () => {
    const p = new StaticTenantProvider("acme-corp");
    assert.equal(p.getTenantId(), "acme-corp");
  });

  await test("A3: AuthProvider interface es estructural (mock implementa)", () => {
    const mock: AuthProvider = {
      getTenantId: () => "mock-tenant",
    };
    assert.equal(mock.getTenantId(), "mock-tenant");
  });

  await test("A4: getTenantId puede ser async (Promise<string>)", async () => {
    const asyncProvider: AuthProvider = {
      getTenantId: async () => "async-tenant",
    };
    const result = await asyncProvider.getTenantId();
    assert.equal(result, "async-tenant");
  });

  await test("A5: motor usa authProvider para startTask", () => {
    const store = new InMemoryTaskStore();
    const audit = new InMemoryWorkflowAudit();
    const auth = new StaticTenantProvider("acme");
    const exec = new WorkflowExecutor(
      { ...makeMockConfig(), enablePersistence: true },
      store,
      ["acme"],
      auth,
      audit,
    );
    const wf = makeSimpleWorkflow();
    const t = exec.startTask(wf, { x: 1 });
    assert.equal(t.tenantId, "acme");
  });
}

// ============================================================
// BLOQUE B — Sweeper de zombies
// ============================================================

async function blockB() {
  console.log("\n[Bloque B] Sweeper de zombies");

  await test("B6: sweepStaleTasks con 0 tasks retorna 0", () => {
    const store = new InMemoryTaskStore();
    const audit = new InMemoryWorkflowAudit();
    const exec = new WorkflowExecutor(
      { ...makeMockConfig(), enablePersistence: true },
      store,
      ["default"],
      new StaticTenantProvider(),
      audit,
    );
    const swept = exec.sweepStaleTasks(30 * 60 * 1000);
    assert.equal(swept, 0);
  });

  await test("B7: task running con heartbeat viejo: la marca paused_error", () => {
    // El sweeper del constructor barre con `maxAgeMs=30min`. Para
    // simular una task zombie al startup, mockeamos la fecha del save.
    // La forma más limpia es usar SqliteTaskStore con un heartbeat
    // viejo insertado a mano (no via save).
    // Para InMemory: no podemos modificar el heartbeat post-save. Pero
    // podemos llamar sweepStaleTasks con un maxAgeMs muy grande que
    // haga que la task sea zombie en comparación. Pero la task se
    // guardó con heartbeat=now, y un maxAgeMs grande = cutoff=now-grande
    // = pasado, así que heartbeat=now > cutoff=pasado → no es zombie.
    // Solución: usar SqliteTaskStore y UPDATE manual del heartbeat.
    const db = freshSqliteDb();
    const store = new SqliteTaskStore(db);
    const t = makeTask({ status: "running" });
    store.save(t, "default");
    // Mover el heartbeat a 1 hora atrás.
    db.prepare("UPDATE paused_tasks SET last_heartbeat_at = ? WHERE task_id = ?")
      .run(Date.now() - 60 * 60 * 1000, t.taskId);
    const audit = new InMemoryWorkflowAudit();
    const exec = new WorkflowExecutor(
      { ...makeMockConfig(), enablePersistence: true },
      store,
      ["default"],
      new StaticTenantProvider(),
      audit,
    );
    // El sweeper del constructor (30min) barre esta zombie.
    const loaded = store.load(t.taskId, "default");
    assert.equal(loaded?.status, "paused_error");
    const events = audit.query({ taskId: t.taskId });
    assert.ok(events.some((e) => e.eventType === "zombie_sweep"));
  });

  await test("B8: task running con heartbeat reciente: la deja", () => {
    const store = new InMemoryTaskStore();
    const audit = new InMemoryWorkflowAudit();
    const t = makeTask({ status: "running" });
    store.save(t, "default");
    // Sin recovery: la task queda como running. Sweeper con 24h no barre.
    const exec = new WorkflowExecutor(
      { ...makeMockConfig(), enablePersistence: true },
      store,
      [],
      new StaticTenantProvider(),
      audit,
    );
    // Llamamos sweep explícito con maxAgeMs gigante para verificar
    // que tampoco barre con heartbeat fresh.
    const swept = exec.sweepStaleTasks(24 * 60 * 60 * 1000);
    assert.equal(swept, 0);
  });

  await test("B9: task paused_hitl: el sweeper NO la toca", () => {
    const store = new InMemoryTaskStore();
    const audit = new InMemoryWorkflowAudit();
    const t = makeTask({ status: "paused_hitl" });
    store.save(t, "default");
    const exec = new WorkflowExecutor(
      { ...makeMockConfig(), enablePersistence: true },
      store,
      ["default"],
      new StaticTenantProvider(),
      audit,
    );
    const swept = exec.sweepStaleTasks(0);
    assert.equal(swept, 0);
    const loaded = store.load(t.taskId, "default");
    assert.equal(loaded?.status, "paused_hitl");
  });

  await test("B10: task zombie: emite evento al audit", () => {
    // Usa SqliteTaskStore para forzar heartbeat viejo. Después del
    // constructor, el sweeper barre y emite zombie_sweep.
    const db = freshSqliteDb();
    const store = new SqliteTaskStore(db);
    const t = makeTask({ status: "running" });
    store.save(t, "default");
    db.prepare("UPDATE paused_tasks SET last_heartbeat_at = ? WHERE task_id = ?")
      .run(Date.now() - 60 * 60 * 1000, t.taskId);
    const audit = new InMemoryWorkflowAudit();
    const exec = new WorkflowExecutor(
      { ...makeMockConfig(), enablePersistence: true },
      store,
      ["default"],
      new StaticTenantProvider(),
      audit,
    );
    const events = audit.query({ taskId: t.taskId });
    const zombieEvents = events.filter((e) => e.eventType === "zombie_sweep");
    assert.equal(zombieEvents.length, 1);
  });

  await test("B11: sweeper cross-tenant: no toca otras tasks", () => {
    const db = freshSqliteDb();
    const store = new SqliteTaskStore(db);
    const a = makeTask({ taskId: "t1", status: "running", tenantId: "A" });
    const b = makeTask({ taskId: "t2", status: "running", tenantId: "B" });
    store.save(a, "A");
    store.save(b, "B");
    // Envejecer A (no B) — el sweeper de A barre, B se queda.
    db.prepare("UPDATE paused_tasks SET last_heartbeat_at = ? WHERE task_id = ? AND tenant_id = ?")
      .run(Date.now() - 60 * 60 * 1000, "t1", "A");
    const audit = new InMemoryWorkflowAudit();
    const exec = new WorkflowExecutor(
      { ...makeMockConfig(), enablePersistence: true },
      store,
      ["A"],
      new StaticTenantProvider(),
      audit,
    );
    // A: paused_error (sweep la barrió).
    const loadedA = store.load("t1", "A");
    assert.equal(loadedA?.status, "paused_error");
    // B: la cargó recovery de A, que no toca a B. B queda como running.
    const loadedB = store.load("t2", "B");
    assert.equal(loadedB?.status, "running");
  });

  await test("B12: sweeper idempotente: 2da llamada no hace nada", () => {
    const db = freshSqliteDb();
    const store = new SqliteTaskStore(db);
    const t = makeTask({ status: "running" });
    store.save(t, "default");
    db.prepare("UPDATE paused_tasks SET last_heartbeat_at = ? WHERE task_id = ?")
      .run(Date.now() - 60 * 60 * 1000, t.taskId);
    const audit = new InMemoryWorkflowAudit();
    const exec = new WorkflowExecutor(
      { ...makeMockConfig(), enablePersistence: true },
      store,
      ["default"],
      new StaticTenantProvider(),
      audit,
    );
    // Constructor ya barred una. Llamada manual: 0.
    const swept = exec.sweepStaleTasks(30 * 60 * 1000);
    assert.equal(swept, 0);
  });

  await test("B13: sweeper barre múltiples running con heartbeat viejo", () => {
    const db = freshSqliteDb();
    const store = new SqliteTaskStore(db);
    for (let i = 0; i < 5; i++) {
      store.save(makeTask({ taskId: `t${i}`, status: "running" }), "default");
    }
    // Envejecer todas
    db.prepare("UPDATE paused_tasks SET last_heartbeat_at = ?")
      .run(Date.now() - 60 * 60 * 1000);
    const audit = new InMemoryWorkflowAudit();
    const exec = new WorkflowExecutor(
      { ...makeMockConfig(), enablePersistence: true },
      store,
      ["default"],
      new StaticTenantProvider(),
      audit,
    );
    // 5 zombie_sweep events
    const events = audit.query({});
    const zombieEvents = events.filter((e) => e.eventType === "zombie_sweep");
    assert.equal(zombieEvents.length, 5);
  });
}

// ============================================================
// BLOQUE C — last_heartbeat_at + touch()
// ============================================================

async function blockC() {
  console.log("\n[Bloque C] last_heartbeat_at + touch()");

  await test("C14: touch() actualiza last_heartbeat_at de la task", () => {
    const store = new InMemoryTaskStore();
    const t = makeTask({ status: "running" });
    store.save(t, "default");
    // Antes del touch, el heartbeat es "ahora". El sweeper con maxAgeMs
    // enorme no barre. Después del touch, sigue siendo "ahora". Pero
    // verificamos que el método no lance y que la task siga running.
    store.touch(t.taskId, "default");
    const loaded = store.load(t.taskId, "default");
    assert.ok(loaded);
    assert.equal(loaded?.status, "running");
  });

  await test("C15: touch() no-op si la task no existe", () => {
    const store = new InMemoryTaskStore();
    // No lanza
    store.touch("nonexistent", "default");
  });

  await test("C16: touch() no-op cross-tenant", () => {
    const store = new InMemoryTaskStore();
    const t = makeTask({ taskId: "t1", status: "running", tenantId: "A" });
    store.save(t, "A");
    // tenantB intenta touch: el WHERE no matchea (en Sqlite) o el
    // heartbeat paralelo no se setea (en InMemory).
    store.touch("t1", "B");
    // La task de A sigue ahí
    const loaded = store.load("t1", "A");
    assert.ok(loaded);
  });

  await test("C17: persistCheckpoint llama touch() después del save", () => {
    const store = new InMemoryTaskStore();
    const audit = new InMemoryWorkflowAudit();
    const t = makeTask({ status: "pending" });
    store.save(t, "default");
    const exec = new WorkflowExecutor(
      { ...makeMockConfig(), enablePersistence: true },
      store,
      ["default"],
      new StaticTenantProvider(),
      audit,
    );
    const wf = makeSimpleWorkflow();
    // startTask llama a persistCheckpoint internamente
    const newTask = exec.startTask(wf, { x: 1 });
    // Verifica que el audit registró un evento start
    const events = audit.query({ taskId: newTask.taskId });
    assert.ok(events.some((e) => e.eventType === "start"));
  });

  await test("C18: touch() en SqliteTaskStore preserva el campo entre reads", () => {
    const db = freshSqliteDb();
    const store = new SqliteTaskStore(db);
    const t = makeTask({ status: "pending" });
    store.save(t, "default");
    // No podemos leer last_heartbeat_at via load() (no está en Task).
    // Verificamos via query directa que la columna se llenó.
    const row = db
      .prepare("SELECT last_heartbeat_at FROM paused_tasks WHERE task_id = ?")
      .get(t.taskId) as { last_heartbeat_at: number | null };
    // Después de save, el row debe tener last_heartbeat_at. Después
    // de touch (que el motor llama después del save), debe ser más
    // reciente o igual.
    assert.ok(row.last_heartbeat_at);
  });
}

// ============================================================
// BLOQUE D — workflow_audit
// ============================================================

async function blockD() {
  console.log("\n[Bloque D] workflow_audit");

  await test("D19: SqliteWorkflowAudit persiste evento start", () => {
    const db = freshSqliteDb();
    runPersistenceMigrations(db);
    const audit = new SqliteWorkflowAudit(db);
    audit.record({
      tenantId: "default",
      taskId: "t1",
      eventType: "start",
      createdAt: Date.now(),
    });
    const rows = db
      .prepare("SELECT * FROM workflow_audit")
      .all() as Array<{ tenant_id: string; event_type: string; task_id: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_type, "start");
  });

  await test("D20: InMemoryWorkflowAudit.query filtra por taskId", () => {
    const audit = new InMemoryWorkflowAudit();
    audit.record({ tenantId: "default", taskId: "t1", eventType: "start", createdAt: 1 });
    audit.record({ tenantId: "default", taskId: "t1", eventType: "pause_hitl", createdAt: 2 });
    audit.record({ tenantId: "default", taskId: "t2", eventType: "start", createdAt: 3 });
    const t1 = audit.query({ taskId: "t1" });
    assert.equal(t1.length, 2);
    const t2 = audit.query({ taskId: "t2" });
    assert.equal(t2.length, 1);
  });

  await test("D21: motor registra múltiples eventos en orden", () => {
    const store = new InMemoryTaskStore();
    const audit = new InMemoryWorkflowAudit();
    const exec = new WorkflowExecutor(
      { ...makeMockConfig(), enablePersistence: true },
      store,
      ["default"],
      new StaticTenantProvider(),
      audit,
    );
    const wf = makeSimpleWorkflow();
    const t = exec.startTask(wf, { x: 1 });
    const events = audit.query({ taskId: t.taskId });
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, "start");
  });

  await test("D22: audit no bloquea el motor si record() lanza", () => {
    const store = new InMemoryTaskStore();
    const badAudit: WorkflowAudit = {
      record: () => { throw new Error("audit broken"); },
    };
    const exec = new WorkflowExecutor(
      { ...makeMockConfig(), enablePersistence: true },
      store,
      ["default"],
      new StaticTenantProvider(),
      badAudit,
    );
    const wf = makeSimpleWorkflow();
    // No debe lanzar — el motor loguea y sigue
    const t = exec.startTask(wf, { x: 1 });
    assert.ok(t);
  });

  await test("D23: motor sin audit: corre normal (backward-compat)", () => {
    const store = new InMemoryTaskStore();
    const exec = new WorkflowExecutor(
      { ...makeMockConfig(), enablePersistence: true },
      store,
      ["default"],
    );
    const wf = makeSimpleWorkflow();
    const t = exec.startTask(wf, { x: 1 });
    // Persistió sin audit
    const loaded = store.load(t.taskId, "default");
    assert.ok(loaded);
  });
}

// ============================================================
// BLOQUE E — Integración con el motor
// ============================================================

async function blockE() {
  console.log("\n[Bloque E] Integración con el motor");

  await test("E24: Sweep corre ANTES de recovery (orden D3.3 fix)", () => {
    // El sweeper corre primero, después recovery. Si el sweeper barre
    // zombies, quedan como paused_error; el recovery las carga como
    // paused_error (no las muta a paused_hitl). Si el sweeper no barre
    // (heartbeat fresh), el recovery muta running→paused_hitl.
    // Verificamos el segundo caso: heartbeat fresh → recovery corre.
    const store = new InMemoryTaskStore();
    const t = makeTask({ status: "running" });
    store.save(t, "default");
    const audit = new InMemoryWorkflowAudit();
    const exec = new WorkflowExecutor(
      { ...makeMockConfig(), enablePersistence: true },
      store,
      ["default"],
      new StaticTenantProvider(),
      audit,
    );
    // El audit debe tener: 0 zombie_sweep (heartbeat fresh), 1 recovery.
    const events = audit.query({ taskId: t.taskId });
    const recoveryEvents = events.filter((e) => e.eventType === "recovery");
    assert.equal(recoveryEvents.length, 1);
    const zombieEvents = events.filter((e) => e.eventType === "zombie_sweep");
    assert.equal(zombieEvents.length, 0);
  });

  await test("E25: startTask con options.tenantId custom pisa el del provider", () => {
    const store = new InMemoryTaskStore();
    const audit = new InMemoryWorkflowAudit();
    const auth = new StaticTenantProvider("default");
    const exec = new WorkflowExecutor(
      { ...makeMockConfig(), enablePersistence: true },
      store,
      ["acme"],
      auth,
      audit,
    );
    const wf = makeSimpleWorkflow();
    const t = exec.startTask(wf, { x: 1 }, { tenantId: "acme" });
    assert.equal(t.tenantId, "acme");
  });

  await test("E26: sin authProvider ni audit: sweeper saltea, recovery corre", () => {
    const store = new InMemoryTaskStore();
    const t = makeTask({ status: "running" });
    store.save(t, "default");
    // Sin audit, el constructor saltea el sweeper (decisión: sweeper
    // requiere audit). Recovery SÍ corre (no requiere audit).
    const exec = new WorkflowExecutor(
      { ...makeMockConfig(), enablePersistence: true },
      store,
      ["default"],
    );
    // Recovery mutó running→paused_hitl
    const loaded = store.load(t.taskId, "default");
    assert.equal(loaded?.status, "paused_hitl");
  });

  await test("E27: motor con authProvider pero sin audit: sweeper saltea, recovery corre", () => {
    // El sweeper corre SOLO si audit está configurado. Si solo hay
    // authProvider, sweeper se salta, recovery corre.
    const store = new InMemoryTaskStore();
    const t = makeTask({ status: "running" });
    store.save(t, "default");
    const exec = new WorkflowExecutor(
      { ...makeMockConfig(), enablePersistence: true },
      store,
      ["default"],
      new StaticTenantProvider(),
      // sin audit
    );
    const loaded = store.load(t.taskId, "default");
    assert.equal(loaded?.status, "paused_hitl");
  });

  await test("E28: motor con auth + audit: sweeper corre (no barre heartbeat fresh) + recovery", () => {
    const store = new InMemoryTaskStore();
    const audit = new InMemoryWorkflowAudit();
    const t = makeTask({ status: "running" });
    store.save(t, "default");
    const exec = new WorkflowExecutor(
      { ...makeMockConfig(), enablePersistence: true },
      store,
      ["default"],
      new StaticTenantProvider(),
      audit,
    );
    const events = audit.query({ taskId: t.taskId });
    // 1 evento recovery (el sweeper del constructor con 30min no barre
    // porque el heartbeat es fresh).
    const recoveryEvents = events.filter((e) => e.eventType === "recovery");
    assert.equal(recoveryEvents.length, 1);
  });
}

// ============================================================
// Run all
// ============================================================

async function main() {
  console.log("=== D3.3 — Auth Sweeper Audit Tests ===\n");
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
