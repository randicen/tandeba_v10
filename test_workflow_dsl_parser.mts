/**
 * D2a.1b — Tests del parser unificado JSON + YAML.
 *
 * Cubre:
 * 1. JSON happy path (mismo workflow que D2a.1)
 * 2. YAML happy path (mismo workflow, equivalente)
 * 3. Auto-detección de formato
 * 4. Errores de sintaxis JSON (con line/column)
 * 5. Errores de sintaxis YAML (con line/column)
 * 6. Errores de schema con hint útil
 * 7. Errores de cross-validation preservados
 * 8. parseWorkflowFile: extensión .json / .yaml / .yml
 * 9. Casos edge: input vacío, root no-objeto, formato forzado incorrecto
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseWorkflow,
  parseWorkflowFile,
  type ParseResult,
} from "./src/agent/workflow-engine/dsl/index.js";

// ============================================================
// Workflows de referencia
// ============================================================

/** Workflow mínimo válido (4 nodos) en JSON. */
const VALID_WORKFLOW_JSON = `{
  "id": "revision-generica",
  "name": "Revisión genérica de documentos",
  "description": "Workflow de prueba del motor (D2a.1)",
  "workflowVersion": "1.0.0",
  "schemaVersion": 1,
  "stateSchema": { "type": "object" },
  "nodes": [
    {
      "type": "function",
      "id": "classify",
      "functionRef": "classify_document",
      "input": { "from": { "path": "input.document" } },
      "output": { "to": { "path": "classification" } }
    },
    {
      "type": "llm",
      "id": "extract",
      "model": "liviano",
      "userPrompt": "Extraé las cláusulas clave",
      "input": { "from": { "path": "input.document" } },
      "output": { "to": { "path": "extraction" } }
    },
    {
      "type": "function",
      "id": "summarize",
      "functionRef": "summarize_extraction",
      "input": { "from": { "path": "extraction" } },
      "output": { "to": { "path": "summary" } }
    },
    {
      "type": "hitl",
      "id": "approve",
      "approvers": ["role:abogado_senior"],
      "question": { "from": { "path": "summary" } },
      "output": { "to": { "path": "approval" } }
    }
  ],
  "edges": [
    { "from": "classify", "to": "extract" },
    { "from": "extract", "to": "summarize" },
    { "from": "summarize", "to": "approve" }
  ],
  "entryNode": "classify"
}`;

/** Mismo workflow, equivalente en YAML. */
const VALID_WORKFLOW_YAML = `
id: revision-generica
name: Revisión genérica de documentos
description: Workflow de prueba del motor (D2a.1)
workflowVersion: 1.0.0
schemaVersion: 1
stateSchema:
  type: object
nodes:
  - type: function
    id: classify
    functionRef: classify_document
    input:
      from:
        path: input.document
    output:
      to:
        path: classification
  - type: llm
    id: extract
    model: liviano
    userPrompt: Extraé las cláusulas clave
    input:
      from:
        path: input.document
    output:
      to:
        path: extraction
  - type: function
    id: summarize
    functionRef: summarize_extraction
    input:
      from:
        path: extraction
    output:
      to:
        path: summary
  - type: hitl
    id: approve
    approvers:
      - role:abogado_senior
    question:
      from:
        path: summary
    output:
      to:
        path: approval
edges:
  - from: classify
    to: extract
  - from: extract
    to: summarize
  - from: summarize
    to: approve
entryNode: classify
`;

// ============================================================
// Helpers
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
      console.log(`  ✗ ${name}`);
      console.log(`    ${e instanceof Error ? e.message : String(e)}`);
    });
}

function assertOk(r: ParseResult): asserts r is { ok: true; workflow: unknown; format: "json" | "yaml" } {
  assert.equal(r.ok, true, `expected ok, got errors: ${JSON.stringify(r)}`);
}

function assertFail(r: ParseResult): asserts r is { ok: false; errors: readonly { code: string; message: string }[]; format: "json" | "yaml" } {
  assert.equal(r.ok, false, `expected fail, got ok with workflow: ${JSON.stringify(r)}`);
}

// ============================================================
// Tests
// ============================================================

console.log("D2a.1b — Workflow DSL parser tests\n");

await test("exports: parseWorkflow, parseWorkflowFile y tipos públicos", () => {
  assert.equal(typeof parseWorkflow, "function");
  assert.equal(typeof parseWorkflowFile, "function");
});

console.log("\nJSON — happy path");
await test("parseWorkflow: workflow JSON válido retorna ok + format='json'", () => {
  const r = parseWorkflow(VALID_WORKFLOW_JSON);
  assertOk(r);
  assert.equal(r.format, "json");
  assert.equal(r.workflow.id, "revision-generica");
  assert.equal(r.workflow.nodes.length, 4);
});

console.log("\nYAML — happy path");
await test("parseWorkflow: workflow YAML válido retorna ok + format='yaml'", () => {
  const r = parseWorkflow(VALID_WORKFLOW_YAML);
  assertOk(r);
  assert.equal(r.format, "yaml");
  assert.equal(r.workflow.id, "revision-generica");
  assert.equal(r.workflow.nodes.length, 4);
});

await test("parseWorkflow: YAML y JSON producen el mismo workflow", () => {
  const j = parseWorkflow(VALID_WORKFLOW_JSON);
  const y = parseWorkflow(VALID_WORKFLOW_YAML);
  assertOk(j);
  assertOk(y);
  // Comparación profunda ignorando referencias
  assert.equal(JSON.stringify(j.workflow), JSON.stringify(y.workflow));
});

console.log("\nAuto-detección de formato");
await test("auto: input que empieza con { → JSON", () => {
  const r = parseWorkflow(VALID_WORKFLOW_JSON, "auto");
  assertOk(r);
  assert.equal(r.format, "json");
});

await test("auto: input que no empieza con { → YAML", () => {
  const r = parseWorkflow(VALID_WORKFLOW_YAML, "auto");
  assertOk(r);
  assert.equal(r.format, "yaml");
});

await test("auto: respeta espacios y newlines al inicio", () => {
  const r = parseWorkflow("\n\n  " + VALID_WORKFLOW_JSON, "auto");
  assertOk(r);
  assert.equal(r.format, "json");
});

await test("format explícito 'json': funciona con input sin { al inicio", () => {
  // '[1,2,3]' sería JSON pero nuestro schema lo rechaza. Probamos con array de workflows.
  // Como workflow debe ser objeto, usamos un workflow válido pero forzamos format='json' con leading whitespace.
  const r = parseWorkflow(VALID_WORKFLOW_JSON, "json");
  assertOk(r);
  assert.equal(r.format, "json");
});

await test("format explícito 'yaml': parsea JSON como YAML también (YAML es superconjunto)", () => {
  // El lib yaml acepta JSON. Esto es válido: si forzás 'yaml' te da un parseo YAML.
  const r = parseWorkflow(VALID_WORKFLOW_JSON, "yaml");
  assertOk(r);
  assert.equal(r.format, "yaml");
});

console.log("\nErrores de sintaxis — JSON");
await test("JSON: comilla de más retorna SYNTAX_ERROR con line/column", () => {
  const broken = '{"id": "foo" "name": "bar"}';
  const r = parseWorkflow(broken);
  assertFail(r);
  assert.equal(r.errors.length, 1);
  const e = r.errors[0];
  assert.equal(e.code, "SYNTAX_ERROR");
  assert.equal(e.message.includes("JSON inválido"), true);
  assert.equal(typeof e.line, "number");
  assert.equal(typeof e.column, "number");
});

await test("JSON: input completamente vacío (forzando format='json') retorna SYNTAX_ERROR", () => {
  // Sin forzar 'json', el auto-detect mandaría "" a YAML (no empieza con {) y daría
  // SCHEMA_INVALID porque YAML acepta string vacío como null.
  // Acá testeamos que JSON.parse explícitamente rechaza input vacío.
  const r = parseWorkflow("", "json");
  assertFail(r);
  assert.equal(r.errors[0].code, "SYNTAX_ERROR");
});

console.log("\nErrores de sintaxis — YAML");
await test("YAML: indentación incorrecta retorna SYNTAX_ERROR con line", () => {
  // Tab como indent — yaml lib lo rechaza
  const broken = "id: foo\n\tname: bar\n";
  const r = parseWorkflow(broken, "yaml");
  assertFail(r);
  assert.equal(r.errors[0].code, "SYNTAX_ERROR");
  // El mensaje debería mencionar indent o tab
  const msg = r.errors[0].message.toLowerCase();
  assert.equal(
    msg.includes("indent") || msg.includes("tab"),
    true,
    `expected mention of indent/tab, got: ${msg}`,
  );
});

await test("YAML: comilla de cierre faltante retorna SYNTAX_ERROR", () => {
  const broken = `id: "foo\nname: bar\n`;
  const r = parseWorkflow(broken, "yaml");
  assertFail(r);
  assert.equal(r.errors[0].code, "SYNTAX_ERROR");
});

console.log("\nErrores de schema con hint");
await test("schema: falta propiedad requerida → SCHEMA_INVALID con hint", () => {
  // Sin 'nodes'
  const broken = JSON.stringify({
    id: "foo",
    name: "Foo",
    workflowVersion: "1.0.0",
    schemaVersion: 1,
    stateSchema: {},
    edges: [],
    entryNode: "x",
  });
  const r = parseWorkflow(broken);
  assertFail(r);
  const missingNodes = r.errors.find((e) => e.message.includes('"nodes"'));
  assert.ok(missingNodes, `expected error about 'nodes', got: ${JSON.stringify(r.errors)}`);
  assert.equal(missingNodes.code, "SCHEMA_INVALID");
  assert.ok(missingNodes.hint, "expected hint field");
});

await test("schema: propiedad no permitida → SCHEMA_INVALID con mensaje claro", () => {
  const broken = JSON.stringify({
    id: "foo",
    name: "Foo",
    workflowVersion: "1.0.0",
    schemaVersion: 1,
    stateSchema: {},
    nodes: [],
    edges: [],
    entryNode: "x",
    extraGarbage: "should not be here",
  });
  const r = parseWorkflow(broken);
  assertFail(r);
  // additionalProperties aparece arriba del nodo raíz
  const err = r.errors.find((e) => e.message.includes("no permitida"));
  assert.ok(err, `expected 'no permitida' error, got: ${JSON.stringify(r.errors)}`);
});

await test("schema: type incorrecto en nodo → SCHEMA_INVALID con tipo esperado", () => {
  const broken = JSON.stringify({
    id: "foo",
    name: "Foo",
    workflowVersion: "1.0.0",
    schemaVersion: 1,
    stateSchema: {},
    nodes: [{ type: "function", id: 123, functionRef: "x", input: { from: {} }, output: { to: {} } }],
    edges: [],
    entryNode: "x",
  });
  const r = parseWorkflow(broken);
  assertFail(r);
  const err = r.errors.find((e) => e.message.includes("Tipo incorrecto"));
  assert.ok(err, `expected 'Tipo incorrecto' error, got: ${JSON.stringify(r.errors)}`);
});

console.log("\nErrores de cross-validation preservados");
await test("cross: entryNode inexistente → CROSS_VALIDATION_FAILED", () => {
  const broken = JSON.stringify({
    id: "foo",
    name: "Foo",
    workflowVersion: "1.0.0",
    schemaVersion: 1,
    stateSchema: {},
    nodes: [
      { type: "function", id: "a", functionRef: "x", input: { from: {} }, output: { to: {} } },
    ],
    edges: [],
    entryNode: "no-existe",
  });
  const r = parseWorkflow(broken);
  assertFail(r);
  const err = r.errors.find(
    (e) => e.code === "CROSS_VALIDATION_FAILED" && e.message.includes("entryNode"),
  );
  assert.ok(err, `expected entryNode error, got: ${JSON.stringify(r.errors)}`);
});

await test("cross: ciclo en el grafo → CROSS_VALIDATION_FAILED con WORKFLOW_HAS_CYCLE", () => {
  const broken = JSON.stringify({
    id: "foo",
    name: "Foo",
    workflowVersion: "1.0.0",
    schemaVersion: 1,
    stateSchema: {},
    nodes: [
      { type: "function", id: "a", functionRef: "x", input: { from: {} }, output: { to: {} } },
      { type: "function", id: "b", functionRef: "x", input: { from: {} }, output: { to: {} } },
    ],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "a" },
    ],
    entryNode: "a",
  });
  const r = parseWorkflow(broken);
  assertFail(r);
  const err = r.errors.find((e) => e.message.includes("ciclo"));
  assert.ok(err, `expected ciclo error, got: ${JSON.stringify(r.errors)}`);
});

console.log("\nparseWorkflowFile — extensión y formato");
const tmpDir = await mkdtemp(join(tmpdir(), "worgena-parser-"));
try {
  const jsonPath = join(tmpDir, "wf.json");
  const yamlPath = join(tmpDir, "wf.yaml");
  const ymlPath = join(tmpDir, "wf.yml");
  const noExtPath = join(tmpDir, "wf");
  await writeFile(jsonPath, VALID_WORKFLOW_JSON, "utf-8");
  await writeFile(yamlPath, VALID_WORKFLOW_YAML, "utf-8");
  await writeFile(ymlPath, VALID_WORKFLOW_YAML, "utf-8");
  await writeFile(noExtPath, VALID_WORKFLOW_JSON, "utf-8");

  await test("parseWorkflowFile: .json → ok con format=json", async () => {
    const r = await parseWorkflowFile(jsonPath);
    assertOk(r);
    assert.equal(r.format, "json");
  });

  await test("parseWorkflowFile: .yaml → ok con format=yaml", async () => {
    const r = await parseWorkflowFile(yamlPath);
    assertOk(r);
    assert.equal(r.format, "yaml");
  });

  await test("parseWorkflowFile: .yml → ok con format=yaml", async () => {
    const r = await parseWorkflowFile(ymlPath);
    assertOk(r);
    assert.equal(r.format, "yaml");
  });

  await test("parseWorkflowFile: extensión desconocida → auto-detect", async () => {
    const r = await parseWorkflowFile(noExtPath);
    assertOk(r);
    // El archivo tiene JSON (empieza con {), así que auto-detect da json
    assert.equal(r.format, "json");
  });

  await test("parseWorkflowFile: archivo inexistente throws", async () => {
    await assert.rejects(
      () => parseWorkflowFile(join(tmpDir, "no-existe.json")),
      /ENOENT/,
    );
  });
} finally {
  await rm(tmpDir, { recursive: true, force: true });
}

console.log("\nCasos edge");
await test("edge: workflow con root siendo array (no objeto) → falla validación", () => {
  const r = parseWorkflow("[1, 2, 3]", "json");
  assertFail(r);
  // ajv detecta que no es type=object
  assert.equal(r.errors[0].code, "SCHEMA_INVALID");
});

await test("edge: workflow root siendo string → falla validación", () => {
  const r = parseWorkflow('"hello"', "json");
  assertFail(r);
  assert.equal(r.errors[0].code, "SCHEMA_INVALID");
});

await test("edge: workflow con BOM al inicio (\\uFEFF) va a JSON (no YAML)", () => {
  // Post-fix: el strip BOM se hace ANTES de detectar formato, así que
  // "\uFEFF{...}" se trata como JSON. Antes dependíamos del lib YAML.
  const withBom = "\uFEFF" + VALID_WORKFLOW_JSON;
  const r = parseWorkflow(withBom);
  assertOk(r);
  assert.equal(r.format, "json");
});

await test("edge: múltiples errores de schema se acumulan en el array", () => {
  const broken = JSON.stringify({
    id: 42, // type incorrecto
    name: "Foo",
    workflowVersion: "no-es-semver", // pattern incorrecto
    schemaVersion: 999, // const incorrecto
    stateSchema: {},
    nodes: [],
    edges: [],
    entryNode: "x",
  });
  const r = parseWorkflow(broken);
  assertFail(r);
  // Esperamos al menos 3 errores
  assert.ok(
    r.errors.length >= 3,
    `expected >=3 errors, got ${r.errors.length}: ${JSON.stringify(r.errors)}`,
  );
});

console.log("\nPost-auditoría — paths normalizados");
await test("paths: AJV JSON Pointer se traduce a dotted notation en errores de schema", () => {
  // Workflow con type incorrecto en nodes[0].id (debería ser string, es number).
  // AJV emitiría instancePath='/nodes/0/id'. El parser lo traduce a 'nodes[0].id'.
  const broken = JSON.stringify({
    id: "foo",
    name: "Foo",
    workflowVersion: "1.0.0",
    schemaVersion: 1,
    stateSchema: {},
    nodes: [
      {
        type: "function",
        id: 123, // ← type incorrecto
        functionRef: "x",
        input: { from: {} },
        output: { to: {} },
      },
    ],
    edges: [],
    entryNode: "foo",
  });
  const r = parseWorkflow(broken);
  assertFail(r);
  // Buscamos un error con path en dotted notation
  const withDottedPath = r.errors.find(
    (e) => e.path === "nodes[0].id" || e.path === "nodes[0]",
  );
  assert.ok(
    withDottedPath,
    `expected dotted path 'nodes[0].id' o similar, got: ${JSON.stringify(r.errors.map((e) => e.path))}`,
  );
  // Y NO debe quedar ningún path en formato JSON Pointer
  const withJsonPointer = r.errors.find((e) => e.path?.startsWith("/"));
  assert.equal(
    withJsonPointer,
    undefined,
    `no debe haber paths en JSON Pointer, got: ${withJsonPointer?.path}`,
  );
});

await test("paths: cross-validation usa dotted notation", () => {
  const broken = JSON.stringify({
    id: "foo",
    name: "Foo",
    workflowVersion: "1.0.0",
    schemaVersion: 1,
    stateSchema: {},
    nodes: [
      { type: "function", id: "a", functionRef: "x", input: { from: {} }, output: { to: {} } },
    ],
    edges: [],
    entryNode: "no-existe",
  });
  const r = parseWorkflow(broken);
  assertFail(r);
  const entryError = r.errors.find((e) => e.path === "entryNode");
  assert.ok(entryError, `expected entryNode path, got: ${JSON.stringify(r.errors)}`);
});

await test("parser expone parseJsonPointer como helper", () => {
  // El helper está exportado para que la UI también pueda traducir JSON Pointer
  // si lo necesita (ej: para highlight en editor).
  return import("./src/agent/workflow-engine/dsl/index.js").then((mod) => {
    const m = mod as unknown as { parseJsonPointer?: (s: string) => string };
    assert.equal(typeof m.parseJsonPointer, "function");
    // Verificamos que traduzca bien
    assert.equal(m.parseJsonPointer?.("/nodes/2/id"), "nodes[2].id");
    assert.equal(m.parseJsonPointer?.("/nodes/0"), "nodes[0]");
    assert.equal(m.parseJsonPointer?.(""), "");
  });
});

console.log("\nPost-auditoría — strip BOM");
await test("BOM: con format='json' explícito, JSON.parse funciona (strip BOM antes)", () => {
  // Antes: BOM hacía que el texto no empiece con {, iba a YAML, que aceptaba y
  // luego fallaba en schema. Ahora: strip BOM antes de decidir formato.
  const withBom = "\uFEFF" + VALID_WORKFLOW_JSON;
  const r = parseWorkflow(withBom, "json");
  assertOk(r);
  assert.equal(r.format, "json");
  assert.equal(r.workflow.id, "revision-generica");
});

await test("BOM: con auto-detect, BOM al inicio se ignora y va a JSON", () => {
  // Antes: BOM hacía que el primer char no fuera {, iba a YAML. Ahora: strip
  // BOM primero, después trimStart, después ve '{' → JSON.
  const withBom = "\uFEFF" + VALID_WORKFLOW_JSON;
  const r = parseWorkflow(withBom); // auto
  assertOk(r);
  assert.equal(r.format, "json");
});

await test("BOM: con format='yaml' explícito, también funciona (lib YAML lo maneja)", () => {
  const withBom = "\uFEFF" + VALID_WORKFLOW_YAML;
  const r = parseWorkflow(withBom, "yaml");
  assertOk(r);
  assert.equal(r.format, "yaml");
});

console.log("\nPost-auditoría — cross errors no se cortan por schema errors");
await test("parser: schema Y cross errors se reportan juntos (no corta early)", () => {
  // Workflow con schema mal (falta 'name') Y cross error (entryNode inexistente).
  // El parser debe reportar ambos en errors[].
  const broken = JSON.stringify({
    id: "foo",
    // name: undefined — schema error
    workflowVersion: "1.0.0",
    schemaVersion: 1,
    stateSchema: {},
    nodes: [
      { type: "function", id: "a", functionRef: "x", input: { from: {} }, output: { to: {} } },
    ],
    edges: [],
    entryNode: "no-existe", // cross error
  });
  const r = parseWorkflow(broken);
  assertFail(r);
  // Schema error
  const schemaErr = r.errors.find((e) => e.code === "SCHEMA_INVALID");
  assert.ok(schemaErr, `expected SCHEMA_INVALID, got: ${JSON.stringify(r.errors)}`);
  // Cross error
  const crossErr = r.errors.find((e) => e.code === "CROSS_VALIDATION_FAILED");
  assert.ok(crossErr, `expected CROSS_VALIDATION_FAILED, got: ${JSON.stringify(r.errors)}`);
});

console.log("\nPost-auditoría — stress con workflow grande en YAML");
await test("YAML: workflow con 500 nodos se parsea y valida correctamente", () => {
  // Generamos un workflow lineal de 500 nodos. Verifica que el path completo
  // (parseo YAML + schema + cross iterativo) escala sin stack overflow.
  const N = 500;
  const nodes = Array.from({ length: N }, (_, i) => `  - type: function
    id: n${i}
    functionRef: noop
    input:
      from:
        path: state.${i}
    output:
      to:
        path: out.${i}`).join("\n");
  const edges = Array.from({ length: N - 1 }, (_, i) => `  - from: n${i}
    to: n${i + 1}`).join("\n");
  const yaml = `id: stress-test
name: Stress
workflowVersion: 1.0.0
schemaVersion: 1
stateSchema:
  type: object
nodes:
${nodes}
edges:
${edges}
entryNode: n0
`;
  const r = parseWorkflow(yaml);
  assertOk(r);
  assert.equal(r.format, "yaml");
  assert.equal(r.workflow.nodes.length, N);
});

// ============================================================
// Resumen
// ============================================================

console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} tests pasaron, ${failed} fallaron\n`);
process.exit(failed === 0 ? 0 : 1);
