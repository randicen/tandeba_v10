/**
 * Tests de network-policy (Dim 1, Item 1.2).
 *
 * Cubre:
 *   - Default (sin env): allow all + warn en dev
 *   - Production con allowlist vacío: throw (fail-closed)
 *   - Bare domain match: example.com → matches example.com y sub.example.com
 *   - Suffix match: .gov.co → matches x.gov.co y y.x.gov.co
 *   - Suffix attack: example.com NO debe matchear example.com.evil.com
 *   - Subdomain de bare domain: subdomain.example.com matchea example.com
 *   - Denied: dominio no en allowlist
 *   - URL malformada
 *   - Protocolo no permitido (file://, ftp://, etc.)
 *   - extractUrlFromToolArgs: extrae correctamente de cada tool
 *   - executeTool integration: una tool bloqueada devuelve error, no crashea
 *
 * Se ejecuta con: npx tsx test_network_policy.mts
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
// Env management
// ────────────────────────────────────────────────────────────────────────────

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

async function loadPolicyFresh() {
  // Carga fresh cada vez (evita cache del módulo)
  const mod = await import("./src/lib/network-policy.js");
  return mod;
}

// ────────────────────────────────────────────────────────────────────────────
// assertUrlAllowed
// ────────────────────────────────────────────────────────────────────────────

async function testDefault_DevAllowsAll() {
  const name = "Default en dev (sin ALLOWED_DOMAINS): permite todo + warn";
  try {
    await withEnv({ ALLOWED_DOMAINS: undefined, NODE_ENV: undefined }, async () => {
      const lines: string[] = [];
      const orig = console.warn;
      console.warn = (...args: any[]) => lines.push(args.join(" "));
      try {
        const { assertUrlAllowed } = await loadPolicyFresh();
        assert.doesNotThrow(() => assertUrlAllowed("https://example.com"));
        assert.doesNotThrow(() => assertUrlAllowed("https://attacker.com/exfil"));
        assert.ok(lines.length > 0, `debe warnar al menos una vez. Got: ${lines}`);
        assert.ok(lines[0].includes("NETWORK-POLICY"), `warn debe mencionar NETWORK-POLICY. Got: ${lines[0]}`);
      } finally {
        console.warn = orig;
      }
    });
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testDefault_ProductionThrows() {
  const name = "Production sin ALLOWED_DOMAINS: throw (fail-closed)";
  try {
    await withEnv({ ALLOWED_DOMAINS: undefined, NODE_ENV: "production" }, async () => {
      const { assertUrlAllowed, NetworkPolicyError } = await loadPolicyFresh();
      assert.throws(
        () => assertUrlAllowed("https://example.com"),
        (e: any) => {
          assert.ok(e instanceof NetworkPolicyError, `debe ser NetworkPolicyError. Got: ${e?.constructor?.name}`);
          assert.ok(e.message.includes("ALLOWED_DOMAINS"), `mensaje debe mencionar ALLOWED_DOMAINS. Got: ${e.message}`);
          return true;
        }
      );
    });
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testBareDomain_ExactMatch() {
  const name = "Bare domain: example.com matchea example.com exacto";
  try {
    await withEnv({ ALLOWED_DOMAINS: "example.com", NODE_ENV: "production" }, async () => {
      const { assertUrlAllowed } = await loadPolicyFresh();
      assert.doesNotThrow(() => assertUrlAllowed("https://example.com"));
      assert.doesNotThrow(() => assertUrlAllowed("https://example.com/path?q=1"));
    });
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testBareDomain_SubdomainMatch() {
  const name = "Bare domain: example.com matchea sub.example.com (subdominio)";
  try {
    await withEnv({ ALLOWED_DOMAINS: "example.com", NODE_ENV: "production" }, async () => {
      const { assertUrlAllowed } = await loadPolicyFresh();
      assert.doesNotThrow(() => assertUrlAllowed("https://sub.example.com"));
      assert.doesNotThrow(() => assertUrlAllowed("https://a.b.c.example.com/x"));
    });
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testBareDomain_PreventsSuffixAttack() {
  const name = "Sufijo attack: example.com NO matchea example.com.evil.com";
  try {
    await withEnv({ ALLOWED_DOMAINS: "example.com", NODE_ENV: "production" }, async () => {
      const { assertUrlAllowed, NetworkPolicyError } = await loadPolicyFresh();
      assert.throws(
        () => assertUrlAllowed("https://example.com.evil.com"),
        NetworkPolicyError,
        "debe bloquear el sufijo attack"
      );
    });
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testSuffix_MultiLevel() {
  const name = "Sufijo .gov.co matchea x.gov.co y y.x.gov.co (multi-nivel)";
  try {
    await withEnv({ ALLOWED_DOMAINS: ".gov.co", NODE_ENV: "production" }, async () => {
      const { assertUrlAllowed } = await loadPolicyFresh();
      assert.doesNotThrow(() => assertUrlAllowed("https://x.gov.co"));
      assert.doesNotThrow(() => assertUrlAllowed("https://y.x.gov.co"));
      assert.doesNotThrow(() => assertUrlAllowed("https://a.b.c.x.gov.co"));
    });
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testSuffix_DeniesOther() {
  const name = "Sufijo .gov.co NO matchea example.com (otro TLD)";
  try {
    await withEnv({ ALLOWED_DOMAINS: ".gov.co", NODE_ENV: "production" }, async () => {
      const { assertUrlAllowed, NetworkPolicyError } = await loadPolicyFresh();
      assert.throws(
        () => assertUrlAllowed("https://example.com"),
        NetworkPolicyError
      );
    });
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testMultipleAllowlist() {
  const name = "Allowlist con múltiples dominios (comma-separated)";
  try {
    await withEnv({ ALLOWED_DOMAINS: "example.com,.gov.co,otro.com", NODE_ENV: "production" }, async () => {
      const { assertUrlAllowed } = await loadPolicyFresh();
      assert.doesNotThrow(() => assertUrlAllowed("https://example.com"));
      assert.doesNotThrow(() => assertUrlAllowed("https://x.gov.co"));
      assert.doesNotThrow(() => assertUrlAllowed("https://otro.com"));
      assert.throws(() => assertUrlAllowed("https://no-permitido.com"), "denegado");
    });
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testCaseInsensitive() {
  const name = "Hostname matching es case-insensitive (EXAMPLE.com == example.com)";
  try {
    await withEnv({ ALLOWED_DOMAINS: "EXAMPLE.COM", NODE_ENV: "production" }, async () => {
      const { assertUrlAllowed } = await loadPolicyFresh();
      assert.doesNotThrow(() => assertUrlAllowed("https://example.com"));
      assert.doesNotThrow(() => assertUrlAllowed("https://EXAMPLE.com"));
    });
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testMalformedURL() {
  const name = "URL malformada: throw con mensaje claro";
  try {
    await withEnv({ ALLOWED_DOMAINS: "example.com", NODE_ENV: "production" }, async () => {
      const { assertUrlAllowed, NetworkPolicyError } = await loadPolicyFresh();
      assert.throws(
        () => assertUrlAllowed("not a url"),
        (e: any) => {
          assert.ok(e instanceof NetworkPolicyError, "debe ser NetworkPolicyError");
          assert.ok(e.message.includes("malformada"), "mensaje debe decir 'malformada'");
          return true;
        }
      );
    });
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testEmptyURL() {
  const name = "URL vacía o no-string: throw";
  try {
    await withEnv({ ALLOWED_DOMAINS: "example.com", NODE_ENV: "production" }, async () => {
      const { assertUrlAllowed, NetworkPolicyError } = await loadPolicyFresh();
      assert.throws(() => assertUrlAllowed(""), NetworkPolicyError);
      assert.throws(() => assertUrlAllowed("   "), NetworkPolicyError);
      assert.throws(() => assertUrlAllowed(null as any), NetworkPolicyError);
      assert.throws(() => assertUrlAllowed(undefined as any), NetworkPolicyError);
    });
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testNonHttpProtocol() {
  const name = "Protocolos no http(s): throw (file://, ftp://, etc.)";
  try {
    await withEnv({ ALLOWED_DOMAINS: "", NODE_ENV: "development" }, async () => {
      const { assertUrlAllowed, NetworkPolicyError } = await loadPolicyFresh();
      // en dev allowlist vacío, pasa todo; necesitamos allowlist
    });
    await withEnv({ ALLOWED_DOMAINS: "example.com", NODE_ENV: "production" }, async () => {
      const { assertUrlAllowed, NetworkPolicyError } = await loadPolicyFresh();
      assert.throws(
        () => assertUrlAllowed("file:///etc/passwd"),
        (e: any) => {
          assert.ok(e.message.toLowerCase().includes("protocolo"), "debe mencionar 'protocolo'");
          return true;
        }
      );
      assert.throws(
        () => assertUrlAllowed("ftp://example.com/file"),
        NetworkPolicyError
      );
      assert.throws(
        () => assertUrlAllowed("javascript:alert(1)"),
        NetworkPolicyError
      );
      assert.throws(
        () => assertUrlAllowed("data:text/html,<script>"),
        NetworkPolicyError
      );
    });
    pass(name);
  } catch (e: any) { fail(name, e); }
}

// ────────────────────────────────────────────────────────────────────────────
// extractUrlFromToolArgs
// ────────────────────────────────────────────────────────────────────────────

async function testExtractUrl() {
  const name = "extractUrlFromToolArgs: extrae correctamente de cada tool";
  try {
    const { extractUrlFromToolArgs } = await loadPolicyFresh();
    assert.equal(extractUrlFromToolArgs("read_url", { url: "https://x.com" }), "https://x.com");
    assert.equal(extractUrlFromToolArgs("download_file", { url: "https://y.com", filename: "f.pdf" }), "https://y.com");
    assert.equal(extractUrlFromToolArgs("apify_scrape_url", { url: "https://z.com" }), "https://z.com");
    assert.equal(extractUrlFromToolArgs("browser_action", { action: "goto", url: "https://w.com" }), "https://w.com");
    // search_web no tiene URL saliente directa (es query a DDG via Puppeteer)
    assert.equal(extractUrlFromToolArgs("search_web", { query: "test" }), null);
    // browser_action sin goto o sin url → no es acceso a red
    assert.equal(extractUrlFromToolArgs("browser_action", { action: "screenshot" }), null);
    assert.equal(extractUrlFromToolArgs("browser_action", { action: "click", x: 1, y: 2 }), null);
    // args inválidos
    assert.equal(extractUrlFromToolArgs("read_url", null), null);
    assert.equal(extractUrlFromToolArgs("read_url", {}), null);
    assert.equal(extractUrlFromToolArgs("read_url", { url: 123 }), null);
    pass(name);
  } catch (e: any) { fail(name, e); }
}

// ────────────────────────────────────────────────────────────────────────────
// executeTool integration
// ────────────────────────────────────────────────────────────────────────────

async function testExecuteTool_BlockedURL() {
  const name = "executeTool: URL bloqueada devuelve error como tool result (no crashea)";
  try {
    // Crear session para el test
    const db = new Database(DB_PATH);
    const sessionId = `test-netpol-${Date.now()}`;
    const now = Date.now();
    db.prepare(
      "INSERT INTO sessions (id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run(sessionId, "test-netpol", "idle", now, now);
    db.close();

    await withEnv({ ALLOWED_DOMAINS: "example.com", NODE_ENV: "production" }, async () => {
      const { executeTool } = await import("./src/agent/tools.js");
      const result = await executeTool("read_url", { url: "https://attacker.com/exfil" }, sessionId);
      assert.ok(typeof result === "string", `result debe ser string (tool result). Got: ${typeof result}`);
      assert.ok(result.startsWith("Error:"), `result debe empezar con 'Error:'. Got: ${result.slice(0, 100)}`);
      assert.ok(result.includes("attacker.com"), `error debe mencionar el dominio. Got: ${result.slice(0, 200)}`);
    });
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testExecuteTool_AllowedURL_PassesCheck() {
  const name = "executeTool: URL permitida pasa el check (no devuelve error de policy)";
  try {
    const db = new Database(DB_PATH);
    const sessionId = `test-netpol-ok-${Date.now()}`;
    const now = Date.now();
    db.prepare(
      "INSERT INTO sessions (id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run(sessionId, "test-netpol-ok", "idle", now, now);
    db.close();

    await withEnv({ ALLOWED_DOMAINS: "example.com", NODE_ENV: "production" }, async () => {
      const { executeTool } = await import("./src/agent/tools.js");
      const result = await executeTool("read_url", { url: "https://example.com" }, sessionId);
      // No debe empezar con "Error: Network policy...". Puede fallar por otra
      // razón (red, parsing), pero la policy debe haber pasado.
      if (typeof result === "string" && result.startsWith("Error:")) {
        assert.ok(
          !result.includes("Network policy") && !result.includes("NetworkPolicy"),
          `NO debe ser error de policy. Got: ${result.slice(0, 200)}`
        );
      }
    });
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testExecuteTool_NonNetworkTool_NotChecked() {
  const name = "executeTool: tool sin red (write_file) NO se valida contra network policy";
  try {
    const db = new Database(DB_PATH);
    const sessionId = `test-netpol-write-${Date.now()}`;
    const now = Date.now();
    db.prepare(
      "INSERT INTO sessions (id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run(sessionId, "test-netpol-write", "idle", now, now);
    db.close();

    await withEnv({ ALLOWED_DOMAINS: "example.com", NODE_ENV: "production" }, async () => {
      const { executeTool } = await import("./src/agent/tools.js");
      // write_file no está en NETWORK_TOOLS → no debe validar URL
      const result = await executeTool("write_file", { path: "test.txt", content: "x" }, sessionId);
      // Si devuelve error, NO debe ser de network policy
      if (typeof result === "string" && result.startsWith("Error:")) {
        assert.ok(
          !result.includes("Network policy") && !result.includes("NetworkPolicy"),
          `write_file no debe triggear network policy. Got: ${result.slice(0, 200)}`
        );
      }
    });
    pass(name);
  } catch (e: any) { fail(name, e); }
}

// ────────────────────────────────────────────────────────────────────────────
// Runner
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  log("═══════════════════════════════════════════════════════════════════");
  log("  network-policy — tests (Dim 1, Item 1.2)");
  log("═══════════════════════════════════════════════════════════════════");
  log("");

  await testDefault_DevAllowsAll();
  await testDefault_ProductionThrows();
  await testBareDomain_ExactMatch();
  await testBareDomain_SubdomainMatch();
  await testBareDomain_PreventsSuffixAttack();
  await testSuffix_MultiLevel();
  await testSuffix_DeniesOther();
  await testMultipleAllowlist();
  await testCaseInsensitive();
  await testMalformedURL();
  await testEmptyURL();
  await testNonHttpProtocol();
  await testExtractUrl();
  await testExecuteTool_BlockedURL();
  await testExecuteTool_AllowedURL_PassesCheck();
  await testExecuteTool_NonNetworkTool_NotChecked();

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
