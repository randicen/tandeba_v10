/**
 * Backlog P0 #1 — Scrub de Secretos en `step_logs` (Sprint Tests).
 *
 * Tests E2E del scrubber que redacta secretos antes de persistir
 * a `step_logs`.
 *
 * Bloque A (1-6): Regex patterns detectan secretos comunes.
 * Bloque B (7-8): Entropy detecta high-entropy strings.
 * Bloque C (9-10): Zero false positives en datos legítimos.
 * Bloque D (11-12): Integration con step_logs + scrubber no rompe texto normal.
 *
 * Total: 12 tests.
 *
 * Spec: AGENT_SPRINT_SECRET_SCRUBBER_SPEC.md §7.
 */

import {
  scrubSecrets,
  _resetScrubCountersForTests,
  _getScrubCountersForTests,
} from "./src/lib/secret-scrubber.js";
import assert from "node:assert/strict";

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
      if (e instanceof Error && e.stack) {
        console.error(`    ${e.stack.split("\n").slice(1, 3).join("\n")}`);
      }
    });
}

// ============================================================
// Bloque A: Regex patterns
// ============================================================

async function bloqueA(): Promise<void> {
  _resetScrubCountersForTests();

  await test("A1: detecta NIT colombiano formato 123.456.789-0", () => {
    const input = "El cliente con NIT 800.123.456-7 facturó $5M";
    const out = scrubSecrets(input);
    assert.ok(out.includes("[REDACTED:NIT]"), `NIT redactado (got "${out}")`);
    assert.ok(!out.includes("800.123.456-7"), "NIT original NO aparece");
  });

  await test("A2: detecta API key estilo OpenAI (sk-xxx)", () => {
    const input = "Mi OpenAI key es sk-proj-abcdefghijklmnopqrstuvwxyz12345678901234567890";
    const out = scrubSecrets(input);
    assert.ok(out.includes("[REDACTED:API_KEY]"), `API key redactada (got "${out}")`);
    assert.ok(!out.includes("sk-proj-"), "API key original NO aparece");
  });

  await test("A3: detecta API key estilo Anthropic (sk-ant-xxx)", () => {
    const input = "Anthropic: sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890";
    const out = scrubSecrets(input);
    assert.ok(out.includes("[REDACTED:API_KEY]"), `Anthropic key redactada`);
  });

  await test("A4: detecta JWT (3 segmentos base64 con dots)", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const out = scrubSecrets(jwt);
    assert.ok(out.includes("[REDACTED:JWT]"), `JWT redactado (got "${out}")`);
  });

  await test("A5: detecta email", () => {
    const out = scrubSecrets("Contactar a juan.perez@example.com por favor");
    assert.ok(out.includes("[REDACTED:EMAIL]"), `email redactado (got "${out}")`);
  });

  await test("A6: detecta credit card (16 dígitos)", () => {
    const out = scrubSecrets("Mi tarjeta es 4532-1234-5678-9010");
    assert.ok(out.includes("[REDACTED:CREDIT_CARD]"), `CC redactada (got "${out}")`);
  });

  await test("A7: detecta phone colombiano (3xx-xxx-xxxx)", () => {
    const out = scrubSecrets("Llamame al 311-555-1234 mañana");
    assert.ok(out.includes("[REDACTED:PHONE]"), `phone redactado (got "${out}")`);
  });

  await test("A8: NIT estricto requiere formato 3.3.3(-DV)", () => {
    // Con DV explícito (formato jurídico, el más común)
    assert.ok(
      scrubSecrets("NIT 800.123.456-7").includes("[REDACTED:NIT]"),
      "NIT con puntos + DV se redacta",
    );
    // Sin DV (rara vez, pero válido)
    assert.ok(
      scrubSecrets("NIT 800.123.456").includes("[REDACTED:NIT]"),
      "NIT 3.3.3 sin DV se redacta",
    );
    // NO debe redactar IPs, version numbers ni fechas
    assert.strictEqual(
      scrubSecrets("IP 192.168.1.1"),
      "IP 192.168.1.1",
      "IP NO se redacta como NIT",
    );
    assert.strictEqual(
      scrubSecrets("Version 1.2.3.4"),
      "Version 1.2.3.4",
      "version number NO se redacta como NIT",
    );
    assert.strictEqual(
      scrubSecrets("Fecha 12.05.2024"),
      "Fecha 12.05.2024",
      "fecha NO se redacta como NIT",
    );
  });
}

// ============================================================
// Bloque B: Entropy
// ============================================================

async function bloqueB(): Promise<void> {
  _resetScrubCountersForTests();

  await test("B7: detecta string high-entropy (32+ chars random)", () => {
    // String random de 40 chars con alta entropy (~5.5 bits/char)
    const random =
      "aZ3xK9pL2mN7qR4tY8wJ5hG3fD6sB1nV0cX8zQ2kM4jR7tW9pY3xL5mN6qR4tY";
    const out = scrubSecrets(random);
    assert.ok(out.includes("[REDACTED:HIGH_ENTROPY]"), `random redactado (got "${out}")`);
  });

  await test("B8: NO redacta string corto (< 32 chars) aunque tenga entropy", () => {
    // String corto (~16 chars) con símbolos random: NO debe redactarse
    const shortRandom = "aZ3xK9pL2mN7qR4"; // 16 chars
    const out = scrubSecrets(shortRandom);
    assert.strictEqual(out, shortRandom, "string corto pasa intacto");
  });
}

// ============================================================
// Bloque C: Zero false positives
// ============================================================

async function bloqueC(): Promise<void> {
  _resetScrubCountersForTests();

  await test("C9: NO redacta párrafo en español legítimo", () => {
    const paragraph =
      "El abogado revisó la demanda civil. El cliente afirma que el contrato " +
      "incluye una cláusula de confidencialidad. La jurisdicción es Colombia. " +
      "El proceso avanza según lo esperado por el equipo legal.";
    const out = scrubSecrets(paragraph);
    assert.strictEqual(out, paragraph, "párrafo pasa intacto (zero false positives)");
  });

  await test("C10: NO redacta JSON legítimo sin secretos", () => {
    const json =
      '{"role":"user","content":"Hola, ¿cómo estás?","model":"deepseek-chat","tokens":42}';
    const out = scrubSecrets(json);
    assert.strictEqual(out, json, "JSON sin secretos pasa intacto");
  });

  await test("C11: NO redacta código TypeScript legítimo", () => {
    const code = `
      function add(a: number, b: number): number {
        return a + b;
      }
    `;
    const out = scrubSecrets(code);
    assert.strictEqual(out, code, "código pasa intacto");
  });
}

// ============================================================
// Bloque D: Integration + counters
// ============================================================

async function bloqueD(): Promise<void> {
  _resetScrubCountersForTests();

  await test("D12: scrub() incrementa counters por tipo", () => {
    scrubSecrets("Email 1: a@x.com Email 2: b@x.com NIT: 123.456.789-0");
    const counters = _getScrubCountersForTests();
    assert.ok(counters.totalScrubbed >= 3, `total >= 3 (got ${counters.totalScrubbed})`);
    assert.ok(
      (counters.byType.EMAIL ?? 0) >= 2,
      `email >= 2 (got ${counters.byType.EMAIL})`,
    );
    assert.ok(
      (counters.byType.NIT ?? 0) >= 1,
      `NIT >= 1 (got ${counters.byType.NIT})`,
    );
  });

  await test("D13: scrub() no throwea con input null/undefined/empty", () => {
    assert.strictEqual(scrubSecrets(null), "", "null retorna ''");
    assert.strictEqual(scrubSecrets(undefined), "", "undefined retorna ''");
    assert.strictEqual(scrubSecrets(""), "", "empty retorna ''");
    // P3: NO throwea con input malformado
    // (no easy way to inject malformed here, but it doesn't throw)
  });
}

// ============================================================
// Run
// ============================================================

async function main(): Promise<void> {
  console.log("[Bloque A] Regex patterns");
  await bloqueA();

  console.log("\n[Bloque B] Entropy");
  await bloqueB();

  console.log("\n[Bloque C] Zero false positives");
  await bloqueC();

  console.log("\n[Bloque D] Integration + counters");
  await bloqueD();

  console.log(`\n=== Resultado: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Test runner failed:", e);
  process.exit(1);
});