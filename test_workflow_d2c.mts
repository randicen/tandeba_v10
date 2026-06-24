/**
 * Tests de D2c — Skills v1.
 *
 * Cubre:
 *   - parseSkillFile: front matter válido, body separado, errores de validación
 *   - SkillRegistry.create (in-memory): listSkills, get, size
 *   - SkillRegistry.loadFromDir: carga real del filesystem, errores
 *   - discover: por topic, por jurisdicción, por keywords, sin match
 *   - Integración mínima: el specialist carga la skill jurídica cuando topic === "jurisprudencia"
 *
 * Se ejecuta con: npx tsx test_workflow_d2c.mts
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  parseSkillFile,
  SkillRegistry,
  formatSkillsForPrompt,
  type Skill,
} from "./src/agent/skills/index.js";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${(e as Error).message}`);
  }
}

// =====================================================================
// parseSkillFile
// =====================================================================

await test("parseSkillFile: front matter válido + body separado", () => {
  const content = `---
name: juridica-colombia
version: 1.0.0
description: Principios jurídicos CO
domain: legal
topics:
  - jurisprudencia
  - tributario
trigger_keywords:
  - ley
  - código
author: Mavis
created: 2026-06-13
---

# Cuerpo

Texto del cuerpo en markdown.
`;
  const skill = parseSkillFile(content);
  assert.equal(skill.name, "juridica-colombia");
  assert.equal(skill.version, "1.0.0");
  assert.equal(skill.domain, "legal");
  assert.deepEqual(skill.topics, ["jurisprudencia", "tributario"]);
  assert.deepEqual(skill.triggerKeywords, ["ley", "código"]);
  assert.ok(skill.body.includes("# Cuerpo"), "body debe incluir el heading");
  assert.ok(skill.body.includes("Texto del cuerpo"), "body debe incluir el texto");
  assert.equal(skill.assets.size, 0);
});

await test("parseSkillFile: jurisdiction opcional", () => {
  const content = `---
name: foo
version: 1.0.0
description: Test sin jurisdiction
domain: foo
topics: [general]
trigger_keywords: []
author: test
created: 2026-01-01
---

body`;
  const skill = parseSkillFile(content);
  assert.equal(skill.jurisdiction, undefined);
});

await test("parseSkillFile: jurisdiction presente se mantiene", () => {
  const content = `---
name: foo
version: 1.0.0
description: Con jurisdiction
domain: legal
jurisdiction: CO
topics: [general]
trigger_keywords: []
author: test
created: 2026-01-01
---

body`;
  const skill = parseSkillFile(content);
  assert.equal(skill.jurisdiction, "CO");
});

await test("parseSkillFile: sin front matter tira error", () => {
  const content = "# Solo markdown sin front matter\n\nbody";
  assert.throws(() => parseSkillFile(content), /debe empezar con '---'/);
});

await test("parseSkillFile: sin cierre de front matter tira error", () => {
  const content = `---
name: foo
version: 1.0.0

body sin cierre`;
  assert.throws(() => parseSkillFile(content), /cierre de front matter/);
});

await test("parseSkillFile: YAML inválido tira error", () => {
  // El parser YAML puede ser permisivo, pero tarde o temprano el
  // validador de campos obligatorios va a tirar. Aceptamos cualquier error.
  const content = `---
name: foo
  : bad indent
version: 1.0.0
---
body`;
  assert.throws(() => parseSkillFile(content));
});

await test("parseSkillFile: campo obligatorio faltante tira error", () => {
  const content = `---
name: foo
version: 1.0.0
description: Falta domain
topics: [general]
trigger_keywords: []
author: test
created: 2026-01-01
---
body`;
  assert.throws(() => parseSkillFile(content), /domain/);
});

await test("parseSkillFile: topics vacío tira error", () => {
  const content = `---
name: foo
version: 1.0.0
description: topics vacío
domain: legal
topics: []
trigger_keywords: []
author: test
created: 2026-01-01
---
body`;
  assert.throws(() => parseSkillFile(content), /topics/);
});

// =====================================================================
// SkillRegistry.create (in-memory)
// =====================================================================

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: "test-skill",
    version: "1.0.0",
    description: "Skill de prueba",
    domain: "legal",
    topics: ["jurisprudencia"],
    triggerKeywords: ["ley"],
    jurisdiction: "CO",
    author: "test",
    created: "2026-01-01",
    body: "# body de prueba",
    assets: new Map(),
    ...overrides,
  };
}

await test("SkillRegistry.create: listSkills alfabético", () => {
  const map = new Map<string, Skill>();
  map.set("zeta", makeSkill({ name: "zeta" }));
  map.set("alpha", makeSkill({ name: "alpha" }));
  map.set("mu", makeSkill({ name: "mu" }));
  const reg = SkillRegistry.create(map);
  assert.deepEqual(reg.listSkills(), ["alpha", "mu", "zeta"]);
});

await test("SkillRegistry.create: get retorna la skill o null", () => {
  const reg = SkillRegistry.create(new Map([["foo", makeSkill({ name: "foo" })]]));
  assert.ok(reg.get("foo"));
  assert.equal(reg.get("nope"), null);
});

await test("SkillRegistry.create: size correcto", () => {
  const reg = SkillRegistry.create(new Map([
    ["a", makeSkill({ name: "a" })],
    ["b", makeSkill({ name: "b" })],
  ]));
  assert.equal(reg.size(), 2);
});

// =====================================================================
// SkillRegistry.loadFromDir (filesystem real)
// =====================================================================

let tmpDir: string;

function setupTmpSkillsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "skills-d2c-"));
  // Skill 1
  mkdirSync(join(dir, "skill-a"), { recursive: true });
  writeFileSync(join(dir, "skill-a", "SKILL.md"), `---
name: skill-a
version: 1.0.0
description: Primera skill
domain: legal
topics: [jurisprudencia, tributario]
trigger_keywords: [ley, código]
author: test
created: 2026-01-01
---

# Skill A
`);
  // Skill 2
  mkdirSync(join(dir, "skill-b"), { recursive: true });
  writeFileSync(join(dir, "skill-b", "SKILL.md"), `---
name: skill-b
version: 2.0.0
description: Segunda skill
domain: contable
topics: [general]
trigger_keywords: [factura]
author: test
created: 2026-01-01
---

# Skill B
`);
  // Asset de skill-a
  mkdirSync(join(dir, "skill-a", "assets"), { recursive: true });
  writeFileSync(join(dir, "skill-a", "assets", "glosario.json"), '{"termino": "test"}');
  // Subdirectorio SIN SKILL.md (se ignora silenciosamente)
  mkdirSync(join(dir, "no-es-skill"), { recursive: true });
  writeFileSync(join(dir, "no-es-skill", "README.md"), "no es skill");
  return dir;
}

await test("loadFromDir: carga 2 skills, ignora subdir sin SKILL.md", () => {
  tmpDir = setupTmpSkillsDir();
  const reg = SkillRegistry.loadFromDir(tmpDir);
  assert.equal(reg.size(), 2);
  assert.deepEqual(reg.listSkills(), ["skill-a", "skill-b"]);
  // Verifica que cargó el asset.
  const a = reg.get("skill-a");
  assert.ok(a);
  assert.equal(a!.assets.size, 1);
  assert.equal(a!.assets.get("glosario.json"), '{"termino": "test"}');
});

await test("loadFromDir: directorio inexistente tira error", () => {
  assert.throws(
    () => SkillRegistry.loadFromDir("/path/que/no/existe/seguro"),
    /no existe/,
  );
});

await test("loadFromDir: SKILL.md malformado tira error", () => {
  const dir = mkdtempSync(join(tmpdir(), "skills-d2c-bad-"));
  mkdirSync(join(dir, "bad-skill"));
  writeFileSync(join(dir, "bad-skill", "SKILL.md"), "# Sin front matter");
  assert.throws(
    () => SkillRegistry.loadFromDir(dir),
    /debe empezar con '---'/,
  );
});

await test("loadFromDir: dos skills con mismo name tira error", () => {
  const dir = mkdtempSync(join(tmpdir(), "skills-d2c-dup-"));
  mkdirSync(join(dir, "dup-1"));
  mkdirSync(join(dir, "dup-2"));
  const content = `---
name: mismo-name
version: 1.0.0
description: dup
domain: foo
topics: [general]
trigger_keywords: []
author: test
created: 2026-01-01
---
body`;
  writeFileSync(join(dir, "dup-1", "SKILL.md"), content);
  writeFileSync(join(dir, "dup-2", "SKILL.md"), content);
  assert.throws(
    () => SkillRegistry.loadFromDir(dir),
    /declarada en más de un directorio/,
  );
});

// =====================================================================
// discover
// =====================================================================

await test("discover: match exacto por topic", () => {
  const reg = SkillRegistry.create(new Map([
    ["legal", makeSkill({ name: "legal", topics: ["jurisprudencia"] })],
    ["otra", makeSkill({ name: "otra", topics: ["general"] })],
  ]));
  const matches = reg.discover({ topic: "jurisprudencia" });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].skill.name, "legal");
  assert.equal(matches[0].score, 10);
  assert.equal(matches[0].matchedOn.topic, true);
  assert.equal(matches[0].matchedOn.jurisdiction, false);
  assert.deepEqual(matches[0].matchedOn.keywordMatches, []);
});

await test("discover: match por jurisdicción + keyword", () => {
  const reg = SkillRegistry.create(new Map([
    ["co-skill", makeSkill({
      name: "co-skill",
      topics: ["general"],
      jurisdiction: "CO",
      triggerKeywords: ["ley", "contrato"],
    })],
  ]));
  const matches = reg.discover({
    topic: "foo",
    jurisdiction: "CO",
    userMessage: "Necesito revisar este contrato",
  });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].score, 5 + 1); // 5 jurisdiction + 1 keyword "contrato"
  assert.equal(matches[0].matchedOn.jurisdiction, true);
  assert.deepEqual(matches[0].matchedOn.keywordMatches, ["contrato"]);
});

await test("discover: keywords case-insensitive", () => {
  const reg = SkillRegistry.create(new Map([
    ["kw", makeSkill({
      name: "kw",
      topics: ["general"],
      triggerKeywords: ["LEY", "Codigo"],
    })],
  ]));
  const matches = reg.discover({ userMessage: "mi LEY y mi Codigo Civil" });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].score, 2);
  assert.deepEqual(matches[0].matchedOn.keywordMatches, ["LEY", "Codigo"]);
});

await test("discover: sin match retorna []", () => {
  const reg = SkillRegistry.create(new Map([
    ["a", makeSkill({ name: "a", topics: ["jurisprudencia"] })],
  ]));
  assert.deepEqual(reg.discover({ topic: "otro-topic" }), []);
  assert.deepEqual(reg.discover({}), []);
});

await test("discover: múltiples matches, ordenados por score desc", () => {
  const reg = SkillRegistry.create(new Map([
    ["exacta", makeSkill({
      name: "exacta",
      topics: ["tributario"],
      jurisdiction: "CO",
      triggerKeywords: ["ley"],
    })],
    ["parcial", makeSkill({
      name: "parcial",
      topics: ["general"],
      jurisdiction: "CO",
      triggerKeywords: ["impuesto"],
    })],
  ]));
  const matches = reg.discover({
    topic: "tributario",
    jurisdiction: "CO",
    userMessage: "impuesto y ley",
  });
  assert.equal(matches.length, 2);
  // exacta: topic(10) + jurisdiction(5) + 1 keyword("ley") = 16
  // parcial: jurisdiction(5) + 1 keyword("impuesto") = 6
  assert.equal(matches[0].skill.name, "exacta");
  assert.equal(matches[0].score, 16);
  assert.equal(matches[1].skill.name, "parcial");
  assert.equal(matches[1].score, 6);
});

await test("discover: tiebreak alfabético", () => {
  const reg = SkillRegistry.create(new Map([
    ["zulu", makeSkill({ name: "zulu", topics: ["x"] })],
    ["alpha", makeSkill({ name: "alpha", topics: ["x"] })],
  ]));
  const matches = reg.discover({ topic: "x" });
  assert.equal(matches.length, 2);
  assert.equal(matches[0].skill.name, "alpha"); // alfabético
  assert.equal(matches[1].skill.name, "zulu");
});

await test("discover: tokenización con puntuación en español", () => {
  const reg = SkillRegistry.create(new Map([
    ["kw", makeSkill({
      name: "kw",
      topics: ["general"],
      triggerKeywords: ["demanda"],
    })],
  ]));
  const matches = reg.discover({
    userMessage: "¿Cuál es la demanda contra la empresa?",
  });
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0].matchedOn.keywordMatches, ["demanda"]);
});

// =====================================================================
// Integración: cargar la skill jurídica real
// =====================================================================

await test("loadFromDir: skills/ del proyecto carga juridica-colombia", () => {
  // MIN-4 (audit D2c 2026-06-13): si la skill no está commiteada, el test
  // falla con mensaje claro (no "directorio no existe" confuso).
  const skillPath = join("./skills", "juridica-colombia", "SKILL.md");
  if (!existsSync(skillPath)) {
    throw new Error(
      `Skill real no encontrada: ${skillPath}. ` +
        `La skill 'juridica-colombia' debería estar commiteada en skills/. ` +
        `Si la borraste intencionalmente, este test es el recordatorio para restaurarla.`,
    );
  }
  const reg = SkillRegistry.loadFromDir("./skills");
  assert.ok(reg.get("juridica-colombia"), "debe existir juridica-colombia");
  const j = reg.get("juridica-colombia")!;
  assert.equal(j.jurisdiction, "CO");
  assert.ok(j.topics.includes("jurisprudencia"));
  assert.ok(j.topics.includes("tributario"));
  assert.ok(j.body.includes("Ley posterior"));
  assert.ok(j.body.includes("ultraactividad"));
});

await test("discover: juridica-colombia matchea jurisprudencia + CO", () => {
  const reg = SkillRegistry.loadFromDir("./skills");
  const matches = reg.discover({
    topic: "jurisprudencia",
    jurisdiction: "CO",
    userMessage: "Analiza esta sentencia de la Corte Constitucional sobre una tutela y una ley",
  });
  assert.ok(matches.length >= 1);
  const juridica = matches.find((m) => m.skill.name === "juridica-colombia");
  assert.ok(juridica);
  // topic(10) + jurisdiction(5) + 3 keywords (sentencia, tutela, ley) = 18
  assert.ok(juridica!.score >= 18, `score esperado >= 18, fue ${juridica!.score}`);
});

// =====================================================================
// formatSkillsForPrompt (MIN-1, audit D2c 2026-06-13)
// =====================================================================

await test("formatSkillsForPrompt: con discover() que retorna [] retorna string vacío", () => {
  const reg = SkillRegistry.create(new Map([
    ["foo", makeSkill({ name: "foo", topics: ["otro-topic"] })],
  ]));
  // discover() con topic que no matchea → []
  const result = formatSkillsForPrompt(reg, { topic: "jurisprudencia" });
  assert.equal(result, "");
});

await test("formatSkillsForPrompt: con registry vacío retorna string vacío", () => {
  const reg = SkillRegistry.create(new Map());
  const result = formatSkillsForPrompt(reg, { topic: "jurisprudencia", jurisdiction: "CO" });
  assert.equal(result, "");
});

await test("formatSkillsForPrompt: con matches inyecta sección # Skills cargadas", () => {
  const reg = SkillRegistry.create(new Map([
    ["test", makeSkill({ name: "test", topics: ["x"], body: "# Mi body" })],
  ]));
  const result = formatSkillsForPrompt(reg, { topic: "x" });
  assert.ok(result.includes("# Skills cargadas"));
  assert.ok(result.includes('<skill name="test"'));
  assert.ok(result.includes("# Mi body"));
});

// =====================================================================
// Resumen
// =====================================================================

console.log(`\n${passed} tests pasaron, ${failed} fallaron`);
if (failed > 0) process.exit(1);
