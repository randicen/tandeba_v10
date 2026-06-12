/**
 * Tests de policy-engine (Dim 1, extra: topic-based policies).
 *
 * Cubre:
 *   - loadPolicies carga el JSON correctamente
 *   - getTopicPolicy retorna el policy correcto o null
 *   - listTopics lista los topics
 *   - generateSystemPromptSection incluye cada topic con sus sitios
 *   - checkUrlAgainstTopic:
 *     - URL en use_these_sites → inRecommended=true
 *     - URL en avoid_these_sites → inAvoided=true
 *     - URL en ninguna lista → false/false
 *     - URL inválida → false/false con reason
 *     - Topic inexistente → false/false
 *   - domainMatchesAny con bare domain y suffix
 *
 * Se ejecuta con: npx tsx test_policy_engine.mts
 */

import assert from "node:assert/strict";

const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const pass = (name: string) => console.log(`  ✓ ${name}`);
const fail = (name: string, e: any) => {
  console.error(`  ✗ ${name}`);
  console.error(`    ${e?.message ?? e}`);
  process.exitCode = 1;
};

// ────────────────────────────────────────────────────────────────────────────
// loadPolicies / getTopicPolicy / listTopics
// ────────────────────────────────────────────────────────────────────────────

async function testLoadPolicies() {
  const name = "loadPolicies: carga policies.json con topics válidos";
  try {
    const { loadPolicies } = await import("./src/lib/policy-engine.js");
    const policies = loadPolicies();
    assert.ok(policies.topics, "debe tener topics");
    assert.ok(typeof policies.topics === "object", "topics es objeto");
    assert.ok(policies.topics.tributario, "topic 'tributario' existe");
    assert.ok(policies.topics.jurisprudencia, "topic 'jurisprudencia' existe");
    assert.ok(policies.topics.general, "topic 'general' existe (fallback)");
    assert.ok(policies.instructions, "instructions existe");
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testGetTopicPolicy() {
  const name = "getTopicPolicy: retorna el policy correcto o null";
  try {
    const { getTopicPolicy } = await import("./src/lib/policy-engine.js");
    const t = getTopicPolicy("tributario");
    assert.ok(t, "topic tributario existe");
    assert.equal(typeof t!.use_these_sites, "object");
    assert.ok(Array.isArray(t!.use_these_sites));
    assert.ok(t!.use_these_sites.includes("dian.gov.co"), "dian.gov.co en use_these_sites");
    assert.ok(t!.avoid_these_sites.includes("facebook.com"), "facebook.com en avoid_these_sites");

    const missing = getTopicPolicy("topic-que-no-existe");
    assert.equal(missing, null, "topic inexistente devuelve null");
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testListTopics() {
  const name = "listTopics: lista los nombres de topics";
  try {
    const { listTopics } = await import("./src/lib/policy-engine.js");
    const topics = listTopics();
    assert.ok(Array.isArray(topics));
    assert.ok(topics.length >= 4, `al menos 4 topics. Got: ${topics.length}`);
    for (const expected of ["tributario", "jurisprudencia", "laboral", "comercial", "general"]) {
      assert.ok(topics.includes(expected), `topic ${expected} debe estar. Got: ${topics}`);
    }
    pass(name);
  } catch (e: any) { fail(name, e); }
}

// ────────────────────────────────────────────────────────────────────────────
// generateSystemPromptSection
// ────────────────────────────────────────────────────────────────────────────

async function testSystemPromptSection_IncludesAllTopics() {
  const name = "generateSystemPromptSection: incluye todos los topics con sus sitios";
  try {
    const { generateSystemPromptSection } = await import("./src/lib/policy-engine.js");
    const section = generateSystemPromptSection();
    assert.ok(typeof section === "string", "es string");
    assert.ok(section.length > 100, "sección tiene contenido sustancial");
    // Cada topic debe aparecer con sus sitios principales
    assert.ok(section.includes("tributario"), "menciona tributario");
    assert.ok(section.includes("dian.gov.co"), "menciona dian.gov.co");
    assert.ok(section.includes("jurisprudencia"), "menciona jurisprudencia");
    assert.ok(section.includes("corteconstitucional.gov.co"), "menciona corte constitucional");
    assert.ok(section.includes("facebook.com"), "menciona facebook (en avoid)");
    // Las instrucciones
    assert.ok(section.toLowerCase().includes("how_to_use") || section.toLowerCase().includes("antes de"), "incluye instrucciones");
    pass(name);
  } catch (e: any) { fail(name, e); }
}

// ────────────────────────────────────────────────────────────────────────────
// domainMatchesAny
// ────────────────────────────────────────────────────────────────────────────

async function testDomainMatchesAny() {
  const name = "domainMatchesAny: bare domain + suffix match";
  try {
    const { domainMatchesAny } = await import("./src/lib/policy-engine.js");
    // Bare domain match
    assert.equal(domainMatchesAny("dian.gov.co", ["dian.gov.co"]), true);
    assert.equal(domainMatchesAny("DIAN.GOV.CO", ["dian.gov.co"]), true, "case-insensitive");
    // Subdomain
    assert.equal(domainMatchesAny("sub.dian.gov.co", ["dian.gov.co"]), true);
    assert.equal(domainMatchesAny("a.b.dian.gov.co", ["dian.gov.co"]), true);
    // No match
    assert.equal(domainMatchesAny("evil.com", ["dian.gov.co"]), false);
    // Suffix attack
    assert.equal(domainMatchesAny("dian.gov.co.evil.com", ["dian.gov.co"]), false, "suffix attack prevention");
    // Suffix con punto
    assert.equal(domainMatchesAny("x.gov.co", [".gov.co"]), true);
    assert.equal(domainMatchesAny("y.x.gov.co", [".gov.co"]), true);
    assert.equal(domainMatchesAny("example.com", [".gov.co"]), false);
    // Multiple patterns
    assert.equal(domainMatchesAny("facebook.com", ["twitter.com", "facebook.com"]), true);
    assert.equal(domainMatchesAny("reddit.com", ["twitter.com", "facebook.com"]), false);
    pass(name);
  } catch (e: any) { fail(name, e); }
}

// ────────────────────────────────────────────────────────────────────────────
// checkUrlAgainstTopic
// ────────────────────────────────────────────────────────────────────────────

async function testCheckUrl_InRecommended() {
  const name = "checkUrlAgainstTopic: URL en use_these_sites → inRecommended=true";
  try {
    const { checkUrlAgainstTopic } = await import("./src/lib/policy-engine.js");
    const result = checkUrlAgainstTopic("https://dian.gov.co/normativa/2024", "tributario");
    assert.equal(result.inRecommended, true);
    assert.equal(result.inAvoided, false);
    assert.ok(result.reason.includes("recomendado"), `reason: ${result.reason}`);
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testCheckUrl_InAvoided() {
  const name = "checkUrlAgainstTopic: URL en avoid_these_sites → inAvoided=true";
  try {
    const { checkUrlAgainstTopic } = await import("./src/lib/policy-engine.js");
    const result = checkUrlAgainstTopic("https://facebook.com/post/123", "tributario");
    assert.equal(result.inRecommended, false);
    assert.equal(result.inAvoided, true);
    assert.ok(result.reason.includes("evitar"), `reason: ${result.reason}`);
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testCheckUrl_NeutralSite() {
  const name = "checkUrlAgainstTopic: URL no está ni en recomendada ni en evitada";
  try {
    const { checkUrlAgainstTopic } = await import("./src/lib/policy-engine.js");
    const result = checkUrlAgainstTopic("https://example.com/article", "tributario");
    assert.equal(result.inRecommended, false);
    assert.equal(result.inAvoided, false);
    assert.ok(result.reason.toLowerCase().includes("decisión") || result.reason.toLowerCase().includes("decidir"), `reason: ${result.reason}`);
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testCheckUrl_InvalidURL() {
  const name = "checkUrlAgainstTopic: URL inválida → false/false con reason";
  try {
    const { checkUrlAgainstTopic } = await import("./src/lib/policy-engine.js");
    const result = checkUrlAgainstTopic("not a url", "tributario");
    assert.equal(result.inRecommended, false);
    assert.equal(result.inAvoided, false);
    assert.ok(result.reason.toLowerCase().includes("inválida") || result.reason.toLowerCase().includes("url"), `reason: ${result.reason}`);
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testCheckUrl_UnknownTopic() {
  const name = "checkUrlAgainstTopic: topic inexistente → false/false con reason";
  try {
    const { checkUrlAgainstTopic } = await import("./src/lib/policy-engine.js");
    const result = checkUrlAgainstTopic("https://dian.gov.co", "topic-fake");
    assert.equal(result.inRecommended, false);
    assert.equal(result.inAvoided, false);
    assert.ok(result.reason.includes("topic-fake"), `reason debe mencionar el topic. Got: ${result.reason}`);
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testCheckUrl_SuffixMatchInAvoided() {
  const name = "checkUrlAgainstTopic: subdominio de avoid_these_sites también bloquea";
  try {
    const { checkUrlAgainstTopic } = await import("./src/lib/policy-engine.js");
    // El topic 'general' tiene facebook.com en avoid
    const result = checkUrlAgainstTopic("https://es-la.facebook.com/post", "general");
    assert.equal(result.inAvoided, true, "subdominio de facebook también evita");
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testCheckUrl_EmptyTopic() {
  const name = "checkUrlAgainstTopic: topic vacío → false/false";
  try {
    const { checkUrlAgainstTopic } = await import("./src/lib/policy-engine.js");
    const result = checkUrlAgainstTopic("https://dian.gov.co", "");
    assert.equal(result.inRecommended, false);
    assert.equal(result.inAvoided, false);
    pass(name);
  } catch (e: any) { fail(name, e); }
}

// ────────────────────────────────────────────────────────────────────────────
// Runner
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  log("═══════════════════════════════════════════════════════════════════");
  log("  policy-engine — tests (Dim 1, extra: topic-based policies)");
  log("═══════════════════════════════════════════════════════════════════");
  log("");

  await testLoadPolicies();
  await testGetTopicPolicy();
  await testListTopics();
  await testSystemPromptSection_IncludesAllTopics();
  await testDomainMatchesAny();
  await testCheckUrl_InRecommended();
  await testCheckUrl_InAvoided();
  await testCheckUrl_NeutralSite();
  await testCheckUrl_InvalidURL();
  await testCheckUrl_UnknownTopic();
  await testCheckUrl_SuffixMatchInAvoided();
  await testCheckUrl_EmptyTopic();

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
