/**
 * Tests del DSL del motor de workflows (D2a.1).
 *
 * Cubre:
 *   - El workflow de ejemplo `revision-generica` valida completamente.
 *   - JSON Schema rechaza workflows malformados (campos requeridos, tipos, etc.).
 *   - Cross-validation detecta:
 *     - entryNode inexistente
 *     - edges que referencian nodos inexistentes
 *     - IDs de nodos duplicados
 *     - Ciclos en el grafo
 *     - confidenceGating sin outputSchema.confidence
 *     - confidenceGating con outputSchema.confidence.type != "number"
 *     - confidenceGating con mediumThreshold >= highThreshold
 *
 * Se ejecuta con: npx tsx test_workflow_dsl_schema.mts
 *
 * Prereq: npm install (agregamos `ajv` a package.json).
 */

import assert from "node:assert/strict";

const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const pass = (name: string) => console.log(`  ✓ ${name}`);
const fail = (name: string, e: unknown) => {
  console.error(`  ✗ ${name}`);
  console.error(`    ${(e as Error)?.message ?? String(e)}`);
  process.exitCode = 1;
};

// ────────────────────────────────────────────────────────────────────────────
// Workflow de ejemplo: revision-generica
// (Tomado literal del spec §5, debe validar)
// ────────────────────────────────────────────────────────────────────────────

const revisionGenerica = {
  id: "revision-generica",
  name: "Revisión Genérica de Documentos",
  description: "Workflow de prueba v1 del motor.",
  workflowVersion: "1.0.0",
  schemaVersion: 1,
  stateSchema: {
    type: "object",
    properties: {
      documentId: { type: "string" },
      documentContent: { type: "string" },
      classification: {
        type: "object",
        properties: {
          category: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
      extractedClauses: { type: "array", items: { type: "object" } },
      summary: { type: "string" },
      approval: {
        type: "object",
        properties: {
          approved: { type: "boolean" },
          feedback: { type: "string" },
        },
      },
    },
  },
  config: {
    defaultTimeoutMs: 60000,
    defaultRetries: 0,
  },
  nodes: [
    {
      id: "classify",
      type: "llm",
      name: "Clasificar documento",
      model: "liviano",
      systemPrompt:
        "Sos un clasificador de documentos legales. Devolvés categoría y confianza 0-1.",
      input: { from: { template: "{{state.documentContent}}" } },
      output: { to: { path: "classification" } },
      outputSchema: {
        type: "object",
        required: ["category", "confidence"],
        properties: {
          category: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
      confidenceGating: {
        highThreshold: 0.8,
        mediumThreshold: 0.5,
        onMedium: "continue",
        onLow: "ask_user",
      },
    },
    {
      id: "extract",
      type: "llm",
      name: "Extraer cláusulas",
      model: "robusto",
      skills: ["clause-extractor-v1"],
      input: { from: { template: "{{state.documentContent}}" } },
      output: { to: { path: "extractedClauses" } },
      retries: { max: 2, on: ["RATE_LIMIT", "TIMEOUT"] },
    },
    {
      id: "summarize",
      type: "llm",
      name: "Resumir documento",
      model: "robusto",
      input: {
        from: {
          template:
            "DOCUMENTO:\n{{state.documentContent}}\n\nCLÁUSULAS EXTRAÍDAS:\n{{state.extractedClauses}}",
        },
      },
      output: { to: { template: "{{result.summary}}", path: "summary" } },
    },
    {
      id: "approve",
      type: "hitl",
      name: "Aprobación humana",
      approvers: ["role:abogado_senior"],
      question: { from: { template: "¿Aprobás este resumen?\n\n{{state.summary}}" } },
      context: {
        from: {
          template:
            "Documento ID: {{state.documentId}}\nCategoría: {{state.classification.category}}",
        },
      },
      output: { to: { path: "approval" } },
      outputSchema: {
        type: "object",
        required: ["approved"],
        properties: {
          approved: { type: "boolean" },
          feedback: { type: "string" },
        },
      },
      approvalMode: "any",
      allowDecline: true,
      declineReasons: ["conflict_of_interest", "needs_revision", "other"],
      timeoutMs: 86400000,
      onTimeout: "fail",
    },
  ],
  edges: [
    { from: "classify", to: "extract" },
    { from: "extract", to: "summarize" },
    { from: "summarize", to: "approve" },
  ],
  entryNode: "classify",
};

// ────────────────────────────────────────────────────────────────────────────
// Test: el workflow de ejemplo valida
// ────────────────────────────────────────────────────────────────────────────

async function testExampleWorkflowValidates() {
  const name = "revision-generica: el workflow de ejemplo valida completamente";
  try {
    const { validateWorkflow } = await import(
      "./src/agent/workflow-engine/dsl/index.js"
    );
    const result = validateWorkflow(revisionGenerica);
    if (!result.valid) {
      const allErrors = [
        ...(result.schemaErrors ?? []).map((e) => `  schema: ${e.instancePath} ${e.message}`),
        ...result.crossErrors.map((e) => `  cross[${e.code}]: ${e.message}`),
      ].join("\n");
      throw new Error(`expected valid, got:\n${allErrors}`);
    }
    pass(name);
  } catch (e) {
    fail(name, e);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Tests: JSON Schema rechaza workflows malformados
// ────────────────────────────────────────────────────────────────────────────

async function testRejectsMissingRequired() {
  const name = "rechaza workflow sin campo requerido (id)";
  try {
    const { validateWorkflow } = await import(
      "./src/agent/workflow-engine/dsl/index.js"
    );
    const broken: any = { ...revisionGenerica };
    // borramos un campo requerido a propósito
    delete broken.id;
    const result = validateWorkflow(broken);
    assert.equal(result.valid, false, "debe rechazar");
    assert.ok(
      result.schemaErrors && result.schemaErrors.length > 0,
      "debe tener errores de schema",
    );
    pass(name);
  } catch (e) {
    fail(name, e);
  }
}

async function testRejectsBadWorkflowVersion() {
  const name = "rechaza workflowVersion que no es semver";
  try {
    const { validateWorkflow } = await import(
      "./src/agent/workflow-engine/dsl/index.js"
    );
    const broken = { ...revisionGenerica, workflowVersion: "1.0" }; // falta patch
    const result = validateWorkflow(broken);
    assert.equal(result.valid, false, "debe rechazar");
    pass(name);
  } catch (e) {
    fail(name, e);
  }
}

async function testRejectsBadSchemaVersion() {
  const name = "rechaza schemaVersion que no es 1";
  try {
    const { validateWorkflow } = await import(
      "./src/agent/workflow-engine/dsl/index.js"
    );
    // schemaVersion incorrecta a propósito
    const broken: any = { ...revisionGenerica, schemaVersion: 2 };
    const result = validateWorkflow(broken);
    assert.equal(result.valid, false, "debe rechazar");
    pass(name);
  } catch (e) {
    fail(name, e);
  }
}

async function testRejectsEmptyNodes() {
  const name = "rechaza workflow con nodes vacío";
  try {
    const { validateWorkflow } = await import(
      "./src/agent/workflow-engine/dsl/index.js"
    );
    const broken = { ...revisionGenerica, nodes: [], entryNode: "x" };
    const result = validateWorkflow(broken);
    assert.equal(result.valid, false, "debe rechazar");
    pass(name);
  } catch (e) {
    fail(name, e);
  }
}

async function testRejectsInvalidNodeType() {
  const name = "rechaza nodo con type desconocido";
  try {
    const { validateWorkflow } = await import(
      "./src/agent/workflow-engine/dsl/index.js"
    );
    const broken: any = {
      ...revisionGenerica,
      nodes: [
        // type inválido a propósito
        { ...revisionGenerica.nodes[0], type: "banana" },
      ],
    };
    const result = validateWorkflow(broken);
    assert.equal(result.valid, false, "debe rechazar");
    pass(name);
  } catch (e) {
    fail(name, e);
  }
}

async function testRejectsNodeMissingRequired() {
  const name = "rechaza nodo LLM sin model (requerido)";
  try {
    const { validateWorkflow } = await import(
      "./src/agent/workflow-engine/dsl/index.js"
    );
    // Tomamos el nodo classify (llm) y le sacamos `model` de verdad.
    const classifyNode = revisionGenerica.nodes[0];
    const { model: _model, ...brokenClassify } = classifyNode;
    const broken: any = {
      ...revisionGenerica,
      nodes: [
        // falta model a propósito
        brokenClassify,
        ...revisionGenerica.nodes.slice(1),
      ],
    };
    const result = validateWorkflow(broken);
    assert.equal(result.valid, false, "debe rechazar");
    assert.ok(
      result.schemaErrors && result.schemaErrors.length > 0,
      "debe tener errores de schema",
    );
    assert.ok(
      result.schemaErrors!.some((e) =>
        e.message?.toLowerCase().includes("model") ||
        e.instancePath?.includes("nodes") ||
        e.params?.missingProperty === "model",
      ),
      `debe mencionar 'model' faltante. Errores: ${JSON.stringify(result.schemaErrors)}`,
    );
    pass(name);
  } catch (e) {
    fail(name, e);
  }
}

async function testRejectsUnknownPropertyInNode() {
  const name = "rechaza propiedad desconocida en nodo (additionalProperties: false)";
  try {
    const { validateWorkflow } = await import(
      "./src/agent/workflow-engine/dsl/index.js"
    );
    const broken: any = {
      ...revisionGenerica,
      nodes: [
        {
          ...revisionGenerica.nodes[0],
          // propiedad inválida a propósito
          banana: true,
        },
      ],
    };
    const result = validateWorkflow(broken);
    assert.equal(result.valid, false, "debe rechazar");
    pass(name);
  } catch (e) {
    fail(name, e);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Tests: cross-validation
// ────────────────────────────────────────────────────────────────────────────

async function testCrossEntryNodeMissing() {
  const name = "cross: entryNode no existe en nodes";
  try {
    const { validateWorkflow } = await import(
      "./src/agent/workflow-engine/dsl/index.js"
    );
    const broken = { ...revisionGenerica, entryNode: "ghost" };
    const result = validateWorkflow(broken);
    assert.equal(result.valid, false, "debe rechazar");
    assert.ok(
      result.crossErrors.some((e) => e.path === "entryNode"),
      "debe tener error en entryNode",
    );
    pass(name);
  } catch (e) {
    fail(name, e);
  }
}

async function testCrossEdgeToMissing() {
  const name = "cross: edge.to referencia nodo inexistente";
  try {
    const { validateWorkflow } = await import(
      "./src/agent/workflow-engine/dsl/index.js"
    );
    const broken = {
      ...revisionGenerica,
      edges: [...revisionGenerica.edges, { from: "classify", to: "ghost" }],
    };
    const result = validateWorkflow(broken);
    assert.equal(result.valid, false, "debe rechazar");
    assert.ok(
      result.crossErrors.some((e) => e.path?.startsWith("edges[3].to")),
      "debe tener error en edges[3].to",
    );
    pass(name);
  } catch (e) {
    fail(name, e);
  }
}

async function testCrossDuplicateNodeIds() {
  const name = "cross: IDs de nodos duplicados";
  try {
    const { validateWorkflow } = await import(
      "./src/agent/workflow-engine/dsl/index.js"
    );
    const broken = {
      ...revisionGenerica,
      nodes: [...revisionGenerica.nodes, { ...revisionGenerica.nodes[0] }],
    };
    const result = validateWorkflow(broken);
    assert.equal(result.valid, false, "debe rechazar");
    assert.ok(
      result.crossErrors.some((e) => e.message.includes("duplicado")),
      "debe reportar duplicado",
    );
    pass(name);
  } catch (e) {
    fail(name, e);
  }
}

async function testCrossCycle() {
  const name = "cross: detecta ciclo en el grafo";
  try {
    const { validateWorkflow } = await import(
      "./src/agent/workflow-engine/dsl/index.js"
    );
    // Construimos un workflow mínimo con ciclo: A -> B -> A
    const cyclic = {
      id: "cyclic-test",
      name: "Test con ciclo",
      workflowVersion: "1.0.0",
      schemaVersion: 1 as const,
      stateSchema: { type: "object" },
      nodes: [
        {
          id: "a",
          type: "function" as const,
          functionRef: "noop",
          input: { from: {} },
          output: { to: {} },
        },
        {
          id: "b",
          type: "function" as const,
          functionRef: "noop",
          input: { from: {} },
          output: { to: {} },
        },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
      entryNode: "a",
    };
    const result = validateWorkflow(cyclic);
    assert.equal(result.valid, false, "debe rechazar");
    assert.ok(
      result.crossErrors.some((e) => e.code === "WORKFLOW_HAS_CYCLE"),
      "debe reportar WORKFLOW_HAS_CYCLE",
    );
    pass(name);
  } catch (e) {
    fail(name, e);
  }
}

async function testCrossConfidenceGatingNoOutputSchema() {
  const name = "cross: confidenceGating sin outputSchema → INVALID_OUTPUT";
  try {
    const { validateWorkflow } = await import(
      "./src/agent/workflow-engine/dsl/index.js"
    );
    const broken: any = {
      ...revisionGenerica,
      nodes: [
        {
          ...revisionGenerica.nodes[0],
          // borramos outputSchema a propósito
          outputSchema: undefined,
        },
        ...revisionGenerica.nodes.slice(1),
      ],
    };
    const result = validateWorkflow(broken);
    assert.equal(result.valid, false, "debe rechazar");
    assert.ok(
      result.crossErrors.some(
        (e) => e.code === "INVALID_OUTPUT" && e.message.includes("outputSchema"),
      ),
      "debe reportar falta de outputSchema",
    );
    pass(name);
  } catch (e) {
    fail(name, e);
  }
}

async function testCrossConfidenceGatingWrongType() {
  const name = "cross: confidenceGating con outputSchema.confidence.type != number → INVALID_OUTPUT";
  try {
    const { validateWorkflow } = await import(
      "./src/agent/workflow-engine/dsl/index.js"
    );
    const broken = {
      ...revisionGenerica,
      nodes: [
        {
          ...revisionGenerica.nodes[0],
          outputSchema: {
            type: "object",
            properties: {
              category: { type: "string" },
              // @ts-expect-error type incorrecto a propósito
              confidence: { type: "string", enum: ["HIGH", "LOW"] },
            },
          },
        },
        ...revisionGenerica.nodes.slice(1),
      ],
    };
    const result = validateWorkflow(broken);
    assert.equal(result.valid, false, "debe rechazar");
    assert.ok(
      result.crossErrors.some(
        (e) => e.code === "INVALID_OUTPUT" && e.message.includes('"number"'),
      ),
    );
    pass(name);
  } catch (e) {
    fail(name, e);
  }
}

async function testCrossConfidenceGatingBadThresholds() {
  const name = "cross: confidenceGating con mediumThreshold >= highThreshold → INVALID_OUTPUT";
  try {
    const { validateWorkflow } = await import(
      "./src/agent/workflow-engine/dsl/index.js"
    );
    const broken = {
      ...revisionGenerica,
      nodes: [
        {
          ...revisionGenerica.nodes[0],
          confidenceGating: {
            highThreshold: 0.5,
            mediumThreshold: 0.8, // mayor que high — inválido
            onMedium: "continue" as const,
            onLow: "ask_user" as const,
          },
        },
        ...revisionGenerica.nodes.slice(1),
      ],
    };
    const result = validateWorkflow(broken);
    assert.equal(result.valid, false, "debe rechazar");
    assert.ok(
      result.crossErrors.some((e) => e.message.includes("mediumThreshold")),
    );
    pass(name);
  } catch (e) {
    fail(name, e);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Tests adicionales D2a.1 (post-auditoría)
// ────────────────────────────────────────────────────────────────────────────

async function testCrossSelfLoop() {
  const name = "cross: detecta self-loop (A → A)";
  try {
    const { validateWorkflow } = await import(
      "./src/agent/workflow-engine/dsl/index.js"
    );
    const selfLoop = {
      id: "self-loop-test",
      name: "Self loop",
      workflowVersion: "1.0.0",
      schemaVersion: 1 as const,
      stateSchema: { type: "object" },
      nodes: [
        {
          id: "a",
          type: "function" as const,
          functionRef: "noop",
          input: { from: {} },
          output: { to: {} },
        },
      ],
      edges: [{ from: "a", to: "a" }],
      entryNode: "a",
    };
    const result = validateWorkflow(selfLoop);
    assert.equal(result.valid, false, "debe rechazar");
    assert.ok(
      result.crossErrors.some((e) => e.code === "WORKFLOW_HAS_CYCLE"),
      "debe reportar WORKFLOW_HAS_CYCLE en self-loop",
    );
    pass(name);
  } catch (e) {
    fail(name, e);
  }
}

async function testCrossLongCycle() {
  const name = "cross: detecta ciclo largo (A → B → C → D → A)";
  try {
    const { validateWorkflow } = await import(
      "./src/agent/workflow-engine/dsl/index.js"
    );
    const cyclic = {
      id: "long-cycle-test",
      name: "Ciclo largo",
      workflowVersion: "1.0.0",
      schemaVersion: 1 as const,
      stateSchema: { type: "object" },
      nodes: ["a", "b", "c", "d"].map((id) => ({
        id,
        type: "function" as const,
        functionRef: "noop",
        input: { from: {} },
        output: { to: {} },
      })),
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: "d" },
        { from: "d", to: "a" },
      ],
      entryNode: "a",
    };
    const result = validateWorkflow(cyclic);
    assert.equal(result.valid, false, "debe rechazar");
    const cycleError = result.crossErrors.find(
      (e) => e.code === "WORKFLOW_HAS_CYCLE",
    );
    assert.ok(cycleError, "debe reportar WORKFLOW_HAS_CYCLE");
    // El mensaje debe incluir el camino del ciclo.
    assert.ok(
      cycleError?.message.includes("a") &&
        cycleError?.message.includes("b") &&
        cycleError?.message.includes("c") &&
        cycleError?.message.includes("d"),
      `el mensaje debe incluir el camino del ciclo: ${cycleError?.message}`,
    );
    pass(name);
  } catch (e) {
    fail(name, e);
  }
}

async function testCrossParallelEdges() {
  const name = "cross: edges paralelos (A → B, A → B) son válidos";
  try {
    const { validateWorkflow } = await import(
      "./src/agent/workflow-engine/dsl/index.js"
    );
    // Dos edges idénticos deberían ser válidos (no es un bug). El motor puede
    // deduplicar o procesarlos en paralelo — eso es decisión de runtime.
    const parallel = {
      id: "parallel-edges-test",
      name: "Edges paralelos",
      workflowVersion: "1.0.0",
      schemaVersion: 1 as const,
      stateSchema: { type: "object" },
      nodes: [
        {
          id: "a",
          type: "function" as const,
          functionRef: "noop",
          input: { from: {} },
          output: { to: {} },
        },
        {
          id: "b",
          type: "function" as const,
          functionRef: "noop",
          input: { from: {} },
          output: { to: {} },
        },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "b" }, // duplicado intencional
      ],
      entryNode: "a",
    };
    const result = validateWorkflow(parallel);
    assert.equal(result.valid, true, "debe aceptar edges paralelos");
    pass(name);
  } catch (e) {
    fail(name, e);
  }
}

async function testIterativeCycleStress() {
  const name = "cross: cycle detection iterativo aguanta 1000 nodos sin stack overflow";
  try {
    const { validateWorkflow } = await import(
      "./src/agent/workflow-engine/dsl/index.js"
    );
    // Workflow lineal de 1000 nodos. Con DFS recursivo, depth 1000 podría
    // ser OK pero con workflows más complejos explotaba. Iterativo debe pasar.
    const N = 1000;
    const nodes = Array.from({ length: N }, (_, i) => ({
      id: `n${i}`,
      type: "function" as const,
      functionRef: "noop",
      input: { from: {} },
      output: { to: {} },
    }));
    const edges = Array.from({ length: N - 1 }, (_, i) => ({
      from: `n${i}`,
      to: `n${i + 1}`,
    }));
    const linear = {
      id: "linear-stress",
      name: "Workflow lineal de 1000 nodos",
      workflowVersion: "1.0.0",
      schemaVersion: 1 as const,
      stateSchema: { type: "object" },
      nodes,
      edges,
      entryNode: "n0",
    };
    const result = validateWorkflow(linear);
    assert.equal(result.valid, true, "workflow lineal debe ser válido");
    assert.equal(result.crossErrors.length, 0, "sin cross errors");
    pass(name);
  } catch (e) {
    fail(name, e);
  }
}

async function testDefensiveCrossValidationWithBadSchema() {
  const name = "cross: corre cross-validation aunque schema esté mal (no corta early)";
  try {
    const { validateWorkflow } = await import(
      "./src/agent/workflow-engine/dsl/index.js"
    );
    // Workflow con schema mal (falta 'name') Y cross error (entryNode inexistente).
    // El comportamiento nuevo es reportar ambos, no cortar en el primero.
    const broken: any = {
      ...revisionGenerica,
      name: undefined, // schema error: falta campo requerido
      entryNode: "ghost", // cross error: no existe en nodes
    };
    const result = validateWorkflow(broken);
    assert.equal(result.valid, false, "debe rechazar");
    assert.ok(
      result.schemaErrors && result.schemaErrors.length > 0,
      "debe reportar schema errors",
    );
    assert.ok(
      result.crossErrors.some((e) => e.path === "entryNode"),
      "debe reportar cross error de entryNode aunque schema esté mal",
    );
    pass(name);
  } catch (e) {
    fail(name, e);
  }
}

async function testDefensiveCrossValidationMissingNodes() {
  const name = "cross: si falta 'nodes' en el input, no emite cross errors (defensiva)";
  try {
    const { validateWorkflow } = await import(
      "./src/agent/workflow-engine/dsl/index.js"
    );
    // Objeto que no es workflow — schema errors sí, cross errors no (defensiva).
    const broken = { foo: "bar" };
    const result = validateWorkflow(broken);
    assert.equal(result.valid, false, "debe rechazar");
    assert.ok(
      result.schemaErrors && result.schemaErrors.length > 0,
      "debe reportar schema errors",
    );
    assert.equal(
      result.crossErrors.length,
      0,
      "cross-validation defensiva: no emite cross errors sin estructura mínima",
    );
    pass(name);
  } catch (e) {
    fail(name, e);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Tests: tipos exportados
// ────────────────────────────────────────────────────────────────────────────

async function testExports() {
  const name = "exports: tipos y funciones públicas están exportados";
  try {
    const mod = await import("./src/agent/workflow-engine/dsl/index.js");
    assert.equal(typeof mod.validateWorkflow, "function");
    assert.equal(typeof mod.validateWorkflowSchema, "function");
    assert.equal(typeof mod.workflowSchemaJson, "object");
    assert.equal(mod.DSL_SCHEMA_VERSION, 1);
    assert.equal(typeof mod.ENGINE_VERSION, "string");
    pass(name);
  } catch (e) {
    fail(name, e);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Runner
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  log("D2a.1 — Workflow DSL tests");
  log("");

  await testExports();
  await testExampleWorkflowValidates();

  log("");
  log("JSON Schema — rechazos");
  await testRejectsMissingRequired();
  await testRejectsBadWorkflowVersion();
  await testRejectsBadSchemaVersion();
  await testRejectsEmptyNodes();
  await testRejectsInvalidNodeType();
  await testRejectsNodeMissingRequired();
  await testRejectsUnknownPropertyInNode();

  log("");
  log("Cross-validation — rechazos");
  await testCrossEntryNodeMissing();
  await testCrossEdgeToMissing();
  await testCrossDuplicateNodeIds();
  await testCrossCycle();
  await testCrossSelfLoop();
  await testCrossLongCycle();
  await testCrossParallelEdges();
  await testCrossConfidenceGatingNoOutputSchema();
  await testCrossConfidenceGatingWrongType();
  await testCrossConfidenceGatingBadThresholds();

  log("");
  log("Cross-validation — defensiva (post-auditoría)");
  await testDefensiveCrossValidationWithBadSchema();
  await testDefensiveCrossValidationMissingNodes();

  log("");
  log("Cross-validation — stress (iterativo, post-auditoría)");
  await testIterativeCycleStress();

  log("");
  if (process.exitCode) {
    log("✗ Algunos tests fallaron");
  } else {
    log("✓ Todos los tests pasaron");
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
