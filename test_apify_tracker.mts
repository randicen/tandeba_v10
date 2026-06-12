/**
 * Tests de Apify cost tracking (Dim 1 — extra: cost capture).
 *
 * Cubre:
 *   - logApifyUsage persiste el row con todos los campos
 *   - logApifyUsage no propaga error si la DB falla
 *   - getApifyUsageTotal agrega correctamente en un rango
 *   - getApifyUsageBySession agrega por sesión
 *   - Costo configurable via env APIFY_COST_PER_CALL_USD
 *   - default cost = $0.005 cuando env no está set
 *
 * Se ejecuta con: npx tsx test_apify_tracker.mts
 */

import assert from "node:assert/strict";
import Database from "better-sqlite3";
import path from "path";

const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const pass = (name: string) => console.log(`  ✓ ${name}`);
const fail = (name: string, e: any) => {
  console.error(`  ✗ ${name}`);
  console.error(`    ${e?.message ?? e}`);
  process.exitCode = 1;
};

const DB_PATH = path.join(process.cwd(), "worgena.db");

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function makeSession(): string {
  const db = new Database(DB_PATH);
  const id = `test-apify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  db.prepare(
    "INSERT INTO sessions (id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
  ).run(id, "test-apify", "idle", now, now);
  db.close();
  return id;
}

function deleteApifyUsageForSession(sessionId: string): void {
  const db = new Database(DB_PATH);
  db.prepare("DELETE FROM apify_usage WHERE session_id = ?").run(sessionId);
  db.close();
}

// ────────────────────────────────────────────────────────────────────────────
// logApifyUsage — inserción
// ────────────────────────────────────────────────────────────────────────────

async function testLog_Success() {
  const name = "logApifyUsage success: persiste row con todos los campos";
  try {
    const sessionId = makeSession();
    try {
      const { logApifyUsage } = await import("./src/lib/apify-tracker.js");
      await logApifyUsage({
        sessionId,
        targetUrl: "https://example.com/article",
        success: true,
        durationMs: 1234,
        resultSizeBytes: 5678,
        errorMessage: null,
      });

      const db = new Database(DB_PATH);
      const row: any = db
        .prepare("SELECT * FROM apify_usage WHERE session_id = ? ORDER BY id DESC LIMIT 1")
        .get(sessionId);
      db.close();

      assert.ok(row, "debe haber un row");
      assert.equal(row.target_url, "https://example.com/article");
      assert.equal(row.success, 1, "success debe ser 1");
      assert.equal(row.duration_ms, 1234);
      assert.equal(row.result_size_bytes, 5678);
      assert.equal(row.error_message, null);
      assert.equal(row.cost_estimate_usd, 0.005, "default cost es 0.005");
      assert.ok(row.called_at > 0, "called_at es timestamp");
    } finally {
      deleteApifyUsageForSession(sessionId);
    }
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testLog_Failure() {
  const name = "logApifyUsage failure: persiste con success=0 y error_message";
  try {
    const sessionId = makeSession();
    try {
      const { logApifyUsage } = await import("./src/lib/apify-tracker.js");
      await logApifyUsage({
        sessionId,
        targetUrl: "https://broken.example.com",
        success: false,
        durationMs: 5000,
        resultSizeBytes: null,
        errorMessage: "Timeout after 180s",
      });

      const db = new Database(DB_PATH);
      const row: any = db
        .prepare("SELECT * FROM apify_usage WHERE session_id = ? ORDER BY id DESC LIMIT 1")
        .get(sessionId);
      db.close();

      assert.equal(row.success, 0, "success debe ser 0");
      assert.equal(row.error_message, "Timeout after 180s");
      assert.equal(row.result_size_bytes, null);
    } finally {
      deleteApifyUsageForSession(sessionId);
    }
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testLog_DoesNotPropagateOnDBError() {
  const name = "logApifyUsage: NO propaga error si la DB falla (no rompe el flujo de scraping)";
  try {
    const { logApifyUsage } = await import("./src/lib/apify-tracker.js");
    // SessionId inexistente (FK constraint violation). El function debe
    // catchear internamente y no throw.
    await assert.doesNotThrow(async () => {
      await logApifyUsage({
        sessionId: "no-existe-esta-session",
        targetUrl: "https://example.com",
        success: true,
        durationMs: 100,
        resultSizeBytes: 100,
        errorMessage: null,
      });
    }, "logApifyUsage debe swallow el error de FK");
    pass(name);
  } catch (e: any) { fail(name, e); }
}

// ────────────────────────────────────────────────────────────────────────────
// Costo configurable
// ────────────────────────────────────────────────────────────────────────────

async function testCostPerCall_Default() {
  const name = "Costo default: $0.005 por call cuando APIFY_COST_PER_CALL_USD no está set";
  try {
    const sessionId = makeSession();
    try {
      await withEnv({ APIFY_COST_PER_CALL_USD: undefined }, async () => {
        const { logApifyUsage } = await import("./src/lib/apify-tracker.js");
        await logApifyUsage({
          sessionId,
          targetUrl: "https://x.com",
          success: true,
          durationMs: 1,
          resultSizeBytes: 0,
          errorMessage: null,
        });
      });
      const db = new Database(DB_PATH);
      const row: any = db
        .prepare("SELECT cost_estimate_usd FROM apify_usage WHERE session_id = ? ORDER BY id DESC LIMIT 1")
        .get(sessionId);
      db.close();
      assert.equal(row.cost_estimate_usd, 0.005, "default cost es 0.005");
    } finally {
      deleteApifyUsageForSession(sessionId);
    }
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testCostPerCall_Override() {
  const name = "Costo override: APIFY_COST_PER_CALL_USD respeta el env";
  try {
    const sessionId = makeSession();
    try {
      await withEnv({ APIFY_COST_PER_CALL_USD: "0.025" }, async () => {
        const { logApifyUsage } = await import("./src/lib/apify-tracker.js");
        await logApifyUsage({
          sessionId,
          targetUrl: "https://x.com",
          success: true,
          durationMs: 1,
          resultSizeBytes: 0,
          errorMessage: null,
        });
      });
      const db = new Database(DB_PATH);
      const row: any = db
        .prepare("SELECT cost_estimate_usd FROM apify_usage WHERE session_id = ? ORDER BY id DESC LIMIT 1")
        .get(sessionId);
      db.close();
      assert.equal(row.cost_estimate_usd, 0.025, "override respetado");
    } finally {
      deleteApifyUsageForSession(sessionId);
    }
    pass(name);
  } catch (e: any) { fail(name, e); }
}

// ────────────────────────────────────────────────────────────────────────────
// Agregaciones
// ────────────────────────────────────────────────────────────────────────────

async function testGetApifyUsageTotal() {
  const name = "getApifyUsageTotal: agrega calls y cost en un rango";
  try {
    const sessionId = makeSession();
    try {
      const { logApifyUsage, getApifyUsageTotal } = await import("./src/lib/apify-tracker.js");
      // 3 calls success + 2 fail
      for (let i = 0; i < 3; i++) {
        await logApifyUsage({
          sessionId,
          targetUrl: `https://x.com/${i}`,
          success: true,
          durationMs: 100,
          resultSizeBytes: 100,
          errorMessage: null,
        });
      }
      for (let i = 0; i < 2; i++) {
        await logApifyUsage({
          sessionId,
          targetUrl: `https://fail.com/${i}`,
          success: false,
          durationMs: 100,
          resultSizeBytes: null,
          errorMessage: "test fail",
        });
      }

      const sinceMs = Date.now() - 60 * 60 * 1000; // hace 1 hora
      const total = await getApifyUsageTotal(sinceMs);

      // El total incluye TODAS las sesiones (puede haber de tests anteriores).
      // Validamos que los 5 nuevos están contados, no que sean los únicos.
      assert.ok(total.calls >= 5, `calls >= 5. Got: ${total.calls}`);
      assert.ok(total.costUsd >= 5 * 0.005, `costUsd >= 0.025. Got: ${total.costUsd}`);
      assert.ok(total.successCount >= 3, `successCount >= 3. Got: ${total.successCount}`);
      assert.ok(total.errorCount >= 2, `errorCount >= 2. Got: ${total.errorCount}`);
    } finally {
      deleteApifyUsageForSession(sessionId);
    }
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testGetApifyUsageBySession() {
  const name = "getApifyUsageBySession: agrega solo por sesión específica";
  try {
    const session1 = makeSession();
    const session2 = makeSession();
    try {
      const { logApifyUsage, getApifyUsageBySession } = await import("./src/lib/apify-tracker.js");
      // 2 calls en session1
      await logApifyUsage({
        sessionId: session1, targetUrl: "https://a.com", success: true,
        durationMs: 1, resultSizeBytes: 0, errorMessage: null,
      });
      await logApifyUsage({
        sessionId: session1, targetUrl: "https://b.com", success: true,
        durationMs: 1, resultSizeBytes: 0, errorMessage: null,
      });
      // 1 call en session2
      await logApifyUsage({
        sessionId: session2, targetUrl: "https://c.com", success: true,
        durationMs: 1, resultSizeBytes: 0, errorMessage: null,
      });

      const s1 = await getApifyUsageBySession(session1);
      const s2 = await getApifyUsageBySession(session2);

      assert.equal(s1.calls, 2, `session1 calls = 2. Got: ${s1.calls}`);
      assert.equal(s1.costUsd, 2 * 0.005, `session1 cost = 0.010`);
      assert.equal(s2.calls, 1, `session2 calls = 1. Got: ${s2.calls}`);
      assert.equal(s2.costUsd, 0.005, `session2 cost = 0.005`);
    } finally {
      deleteApifyUsageForSession(session1);
      deleteApifyUsageForSession(session2);
    }
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testGetApifyUsageBySession_Empty() {
  const name = "getApifyUsageBySession: sesión sin calls devuelve 0/0";
  try {
    const sessionId = makeSession();
    const { getApifyUsageBySession } = await import("./src/lib/apify-tracker.js");
    const result = await getApifyUsageBySession(sessionId);
    assert.equal(result.calls, 0);
    assert.equal(result.costUsd, 0);
    pass(name);
  } catch (e: any) { fail(name, e); }
}

// ────────────────────────────────────────────────────────────────────────────
// Schema
// ────────────────────────────────────────────────────────────────────────────

async function testSchema_TableExists() {
  const name = "DB schema: tabla apify_usage existe con todas las columnas";
  try {
    const db = new Database(DB_PATH);
    const cols: any[] = db.prepare("PRAGMA table_info(apify_usage)").all();
    db.close();
    const colNames = cols.map((c) => c.name);
    for (const expected of [
      "id", "session_id", "target_url", "called_at", "success",
      "error_message", "duration_ms", "result_size_bytes", "cost_estimate_usd"
    ]) {
      assert.ok(colNames.includes(expected), `columna ${expected} debe existir. Got: ${colNames}`);
    }
    pass(name);
  } catch (e: any) { fail(name, e); }
}

// ────────────────────────────────────────────────────────────────────────────
// Runner
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  log("═══════════════════════════════════════════════════════════════════");
  log("  apify-tracker — tests (Dim 1, extra: cost capture)");
  log("═══════════════════════════════════════════════════════════════════");
  log("");

  // Forzar import del tracker ANTES del schema test: la migración de la tabla
  // `apify_usage` corre cuando se importa `./db.js` (vía `pool`), y eso
  // pasa cuando se importa el tracker. Sin este import, el schema test
  // corre antes de la migración.
  await import("./src/lib/apify-tracker.js");

  await testSchema_TableExists();
  await testLog_Success();
  await testLog_Failure();
  await testLog_DoesNotPropagateOnDBError();
  await testCostPerCall_Default();
  await testCostPerCall_Override();
  await testGetApifyUsageTotal();
  await testGetApifyUsageBySession();
  await testGetApifyUsageBySession_Empty();

  log("");
  if (process.exitCode === 1) {
    log("  ✗ ALGUNOS TESTS FALLARON");
  } else {
    log("  ✓ TODOS LOS TESTS PASARON");
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
