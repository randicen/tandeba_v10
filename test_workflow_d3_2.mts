/**
 * D3.2 — Multi-Tenant Schema + Enforcement en TaskStore.
 *
 * Tests del sprint que activa el tenantId estricto en TaskStore y agrega
 * la columna tenant_id a sessions/spaces.
 *
 * Bloque A (1-8): TaskStore strict — tenantId OBLIGATORIO.
 * Bloque B (9-16): Multi-tenant isolation (InMemory).
 * Bloque C (17-20): Multi-tenant isolation (SQLite).
 * Bloque D (21-25): Migración de sessions y spaces.
 * Bloque E (26-30): Integración con el motor.
 *
 * Total: 30 tests.
 *
 * Spec: `AGENT_D3_2_MULTI_TENANT_SPEC.md` §5.4.
 *
 * Patrón: igual que `test_workflow_d2a_4.mts`. Counter de passed/failed
 * con `assert` (Node built-in). No usa libs externas.
 */

import {
  WorkflowExecutor,
  InMemoryTaskStore,
  SqliteTaskStore,
  MissingTenantIdError,
  runPersistenceMigrations,
} from "./src/agent/workflow-engine/executor/index.js";
import type {
  Task,
  WorkflowDefinition,
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

function freshSqliteDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  return db;
}

/**
 * Mock config para tests de integración con el motor. Usado en Bloque E.
 * Helper introducido en audit D3.2 (W-3) para evitar duplicación de
 * 5 copias del mismo cfg en E26-E30.
 */
function makeMockConfig() {
  return {
    functionRegistry: new Map<string, (input: unknown) => Promise<unknown> | unknown>(),
    llmInvoker: { async invoke() { throw new Error("nope"); } },
    hitlHandler: { async initiate() { return { requestId: "x" }; } },
  };
}

// ============================================================
// BLOQUE A — TaskStore strict (tenantId OBLIGATORIO)
// ============================================================

async function blockA() {
  console.log("\n[Bloque A] TaskStore strict");

  await test("A1: InMemoryTaskStore.save sin tenantId throws MissingTenantIdError", () => {
    const store = new InMemoryTaskStore();
    const t = makeTask();
    assert.throws(() => store.save(t, undefined as any), MissingTenantIdError);
  });

  await test("A2: InMemoryTaskStore.load sin tenantId throws", () => {
    const store = new InMemoryTaskStore();
    assert.throws(() => store.load("t1", undefined as any), MissingTenantIdError);
  });

  await test("A3: InMemoryTaskStore.loadActive sin tenantId throws", () => {
    const store = new InMemoryTaskStore();
    assert.throws(() => store.loadActive(undefined as any), MissingTenantIdError);
  });

  await test("A4: InMemoryTaskStore.delete sin tenantId throws", () => {
    const store = new InMemoryTaskStore();
    assert.throws(() => store.delete("t1", undefined as any), MissingTenantIdError);
  });

  await test("A5: SqliteTaskStore.save sin tenantId throws MissingTenantIdError", () => {
    const store = new SqliteTaskStore(freshSqliteDb());
    const t = makeTask();
    assert.throws(() => store.save(t, undefined as any), MissingTenantIdError);
  });

  await test("A6: SqliteTaskStore.load sin tenantId throws", () => {
    const store = new SqliteTaskStore(freshSqliteDb());
    assert.throws(() => store.load("t1", undefined as any), MissingTenantIdError);
  });

  await test("A7: SqliteTaskStore.loadActive sin tenantId throws", () => {
    const store = new SqliteTaskStore(freshSqliteDb());
    assert.throws(() => store.loadActive(undefined as any), MissingTenantIdError);
  });

  await test("A8: SqliteTaskStore.delete sin tenantId throws", () => {
    const store = new SqliteTaskStore(freshSqliteDb());
    assert.throws(() => store.delete("t1", undefined as any), MissingTenantIdError);
  });

  await test("A9: tenantId string vacío también throws", () => {
    const store = new InMemoryTaskStore();
    assert.throws(() => store.save(makeTask(), ""), MissingTenantIdError);
  });

  await test("A10: MissingTenantIdError mensaje menciona D3.3 admin", () => {
    const err = new MissingTenantIdError("save");
    assert.ok(err.message.includes("D3.3"));
    assert.ok(err.message.includes("loadCrossTenant") || err.message.includes("admin"));
  });
}

// ============================================================
// BLOQUE B — Multi-tenant isolation (InMemory)
// ============================================================

async function blockB() {
  console.log("\n[Bloque B] Multi-tenant isolation (InMemory)");

  await test("B11: loadActive filtra por tenant", () => {
    const store = new InMemoryTaskStore();
    store.save(makeTask({ taskId: "t1", tenantId: "tenantA" }), "tenantA");
    store.save(makeTask({ taskId: "t2", tenantId: "tenantA" }), "tenantA");
    store.save(makeTask({ taskId: "t3", tenantId: "tenantB" }), "tenantB");
    const a = store.loadActive("tenantA");
    const b = store.loadActive("tenantB");
    assert.equal(a.length, 2);
    assert.equal(b.length, 1);
    assert.equal(b[0].taskId, "t3");
  });

  await test("B12: load cross-tenant retorna null (no leak de existencia)", () => {
    const store = new InMemoryTaskStore();
    store.save(makeTask({ taskId: "t1", tenantId: "tenantA" }), "tenantA");
    assert.equal(store.load("t1", "tenantB"), null);
  });

  await test("B13: delete cross-tenant es idempotente (no-op)", () => {
    const store = new InMemoryTaskStore();
    store.save(makeTask({ taskId: "t1", tenantId: "tenantA" }), "tenantA");
    // tenantB intenta borrar: no-op, no lanza
    store.delete("t1", "tenantB");
    // tenantA sigue viendo la task
    assert.ok(store.load("t1", "tenantA"));
  });

  await test("B14: save con tenantId distinto al de la task: gana el param", () => {
    const store = new InMemoryTaskStore();
    const t = makeTask({ taskId: "t1", tenantId: "tenantA" });
    // Caller pasa tenantB, gana tenantB (override intencional)
    store.save(t, "tenantB");
    assert.equal(store.load("t1", "tenantB")?.tenantId, "tenantB");
    assert.equal(store.load("t1", "tenantA"), null);
  });

  await test("B15: dos tenants con mismo taskId coexisten (PK compuesto)", () => {
    // Audit D3.2 fix (I-1): el PK de paused_tasks es compuesto
    // (task_id, tenant_id). Dos tenants con el mismo taskId NO colisionan.
    // Cada uno ve su propia versión. Forward-compat: si en el futuro
    // queremos que el motor rechace taskIds duplicados cross-tenant,
    // se valida a nivel de la capa que genera los IDs.
    const store = new InMemoryTaskStore();
    store.save(makeTask({ taskId: "shared", tenantId: "tenantA", state: { input: { x: 1 } } }), "tenantA");
    store.save(makeTask({ taskId: "shared", tenantId: "tenantB", state: { input: { x: 2 } } }), "tenantB");
    // tenantA ve SU versión (x=1).
    const a = store.load("shared", "tenantA");
    assert.ok(a);
    assert.equal(a?.tenantId, "tenantA");
    assert.deepEqual((a?.state as any).input, { x: 1 });
    // tenantB ve SU versión (x=2).
    const b = store.load("shared", "tenantB");
    assert.ok(b);
    assert.equal(b?.tenantId, "tenantB");
    assert.deepEqual((b?.state as any).input, { x: 2 });
  });

  await test("B16: loadActive con 0 tasks retorna []", () => {
    const store = new InMemoryTaskStore();
    assert.deepEqual(store.loadActive("anyTenant"), []);
  });

  await test("B17: save preserva el campo tenantId del task original", () => {
    const store = new InMemoryTaskStore();
    const t = makeTask({ taskId: "t1", tenantId: "acme-corp" });
    store.save(t, "acme-corp");
    const loaded = store.load("t1", "acme-corp");
    assert.equal(loaded?.tenantId, "acme-corp");
  });
}

// ============================================================
// BLOQUE C — Multi-tenant isolation (SQLite)
// ============================================================

async function blockC() {
  console.log("\n[Bloque C] Multi-tenant isolation (SQLite)");

  await test("C18: SqliteTaskStore roundtrip preserva tenantId", () => {
    const store = new SqliteTaskStore(freshSqliteDb());
    const t = makeTask({ taskId: "t1", tenantId: "acme-corp" });
    store.save(t, "acme-corp");
    const loaded = store.load("t1", "acme-corp");
    assert.ok(loaded);
    assert.equal(loaded.tenantId, "acme-corp");
  });

  await test("C19: SqliteTaskStore loadActive filtra por tenant con índices", () => {
    const store = new SqliteTaskStore(freshSqliteDb());
    for (let i = 0; i < 5; i++) {
      store.save(makeTask({ taskId: `a-${i}`, tenantId: "A" }), "A");
      store.save(makeTask({ taskId: `b-${i}`, tenantId: "B" }), "B");
    }
    assert.equal(store.loadActive("A").length, 5);
    assert.equal(store.loadActive("B").length, 5);
  });

  await test("C20: SqliteTaskStore delete cross-tenant es no-op", () => {
    const store = new SqliteTaskStore(freshSqliteDb());
    store.save(makeTask({ taskId: "t1", tenantId: "A" }), "A");
    store.delete("t1", "B");
    assert.ok(store.load("t1", "A"));
  });

  await test("C21: SqliteTaskStore save terminal purga cross-tenant correctamente", () => {
    // D3.2: si llega una save con status terminal, purga solo si la task
    // es del mismo tenant. Si es de otro tenant, no toca.
    const store = new SqliteTaskStore(freshSqliteDb());
    store.save(makeTask({ taskId: "t1", status: "pending", tenantId: "A" }), "A");
    // tenantB intenta "completar" la task de tenantA: no debe tocarla.
    store.save({ ...makeTask({ taskId: "t1", tenantId: "A", status: "pending" }), status: "completed" }, "B");
    // La task de tenantA sigue existiendo
    assert.ok(store.load("t1", "A"));
  });
}

// ============================================================
// BLOQUE D — Migración de sessions y spaces
// ============================================================

async function blockD() {
  console.log("\n[Bloque D] Migración de sessions y spaces");

  await test("D22: runPersistenceMigrations crea columna tenant_id en sessions si no existe", () => {
    const db = freshSqliteDb();
    // Pre-crear tabla sessions SIN tenant_id (simula estado legacy)
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        name TEXT,
        status TEXT
      );
    `);
    runPersistenceMigrations(db);
    const cols = db
      .prepare("PRAGMA table_info(sessions)")
      .all() as Array<{ name: string }>;
    assert.ok(cols.some((c) => c.name === "tenant_id"));
  });

  await test("D23: runPersistenceMigrations crea columna tenant_id en spaces si no existe", () => {
    const db = freshSqliteDb();
    db.exec(`
      CREATE TABLE spaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );
    `);
    runPersistenceMigrations(db);
    const cols = db
      .prepare("PRAGMA table_info(spaces)")
      .all() as Array<{ name: string }>;
    assert.ok(cols.some((c) => c.name === "tenant_id"));
  });

  await test("D24: runPersistenceMigrations no falla si tabla no existe (skip silencioso)", () => {
    // D3.2 fix: tests con :memory: no tienen sessions/spaces. Skip silencioso.
    const db = freshSqliteDb();
    // NO crear tablas. La migration debe ser no-op.
    assert.doesNotThrow(() => runPersistenceMigrations(db));
  });

  await test("D25: columna tenant_id tiene DEFAULT 'default'", () => {
    const db = freshSqliteDb();
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        name TEXT
      );
    `);
    runPersistenceMigrations(db);
    // Insertar fila sin tenant_id: debe tener 'default' automático
    db.exec(`INSERT INTO sessions (id, name) VALUES ('s1', 'Test')`);
    const row = db.prepare("SELECT tenant_id FROM sessions WHERE id = 's1'").get() as { tenant_id: string };
    assert.equal(row.tenant_id, "default");
  });
}

// ============================================================
// BLOQUE E — Integración con el motor
// ============================================================

async function blockE() {
  console.log("\n[Bloque E] Integración con el motor");

  await test("E26: persistCheckpoint lee task.tenantId y lo pasa al store", () => {
    const store = new InMemoryTaskStore();
    const cfg = makeMockConfig();
    const exec = new WorkflowExecutor({ ...cfg, enablePersistence: true }, store);
    const wf = makeSimpleWorkflow();
    const t = exec.startTask(wf, { x: 1 });
    // El motor persistió con tenantId 'default'
    assert.equal(store.load(t.taskId, "default")?.tenantId, "default");
  });

  await test("E27: task con tenantId custom: motor respeta", () => {
    // No hay API para setear tenantId en startTask todavía (D3.3 lo enchufa).
    // Pero el motor lee de task.tenantId, así que si la mutamos manualmente
    // antes del save, debe respetarlo.
    const store = new InMemoryTaskStore();
    const cfg = makeMockConfig();
    const exec = new WorkflowExecutor({ ...cfg, enablePersistence: true }, store);
    const wf = makeSimpleWorkflow();
    const t = exec.startTask(wf, { x: 1 });
    // Forzar un nuevo save con tenantId custom
    t.tenantId = "acme";
    store.save(t, "acme");
    assert.equal(store.load(t.taskId, "acme")?.tenantId, "acme");
  });

  await test("E28: recovery carga tasks de múltiples tenants", () => {
    // El motor acepta un tercer param recoveryTenantIds (D3.2).
    const store = new InMemoryTaskStore();
    store.save(makeTask({ taskId: "t1", tenantId: "A" }), "A");
    store.save(makeTask({ taskId: "t2", tenantId: "B" }), "B");
    const cfg = makeMockConfig();
    // Pasar lista de tenants a recuperar
    const exec = new WorkflowExecutor(
      { ...cfg, enablePersistence: true },
      store,
      ["A", "B"],
    );
    assert.ok(exec.getTask("t1"));
    assert.ok(exec.getTask("t2"));
  });

  await test("E29: recoveryTenantIds = [] no recupera nada", () => {
    const store = new InMemoryTaskStore();
    store.save(makeTask({ taskId: "t1", tenantId: "A" }), "A");
    const cfg = makeMockConfig();
    const exec = new WorkflowExecutor(
      { ...cfg, enablePersistence: true },
      store,
      [], // sin tenants → no recovery
    );
    assert.equal(exec.getTask("t1"), undefined);
  });

  await test("E30: backward-compat — sin recoveryTenantIds, default = ['default']", () => {
    const store = new InMemoryTaskStore();
    store.save(makeTask({ taskId: "t1", tenantId: "default" }), "default");
    store.save(makeTask({ taskId: "t2", tenantId: "other" }), "other");
    const cfg = makeMockConfig();
    // Sin tercer param: solo recupera 'default'
    const exec = new WorkflowExecutor({ ...cfg, enablePersistence: true }, store);
    assert.ok(exec.getTask("t1"));
    assert.equal(exec.getTask("t2"), undefined);
  });
}

// ============================================================
// Run all
// ============================================================

async function main() {
  console.log("=== D3.2 — Multi-Tenant Tests ===\n");
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
