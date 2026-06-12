/**
 * Tests de getPuppeteerLaunchArgs (Dimensión 1, Item 1.1).
 *
 * Cubre:
 *   - Default (sin env var): args sin --no-sandbox, con --disable-dev-shm-usage
 *   - Con ALLOW_NO_SANDBOX=1: args con --no-sandbox, warn ruidoso en production
 *   - Con ALLOW_NO_SANDBOX=0 o no set: default
 *
 * Se ejecuta con: npx tsx test_puppeteer_args.mts
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
// Importar el helper DESPUÉS de los env vars de prueba, para que tome los
// valores seteados en main(). Como ESM, los imports se hoistean; por eso
// hacemos la importación con un await dinámico desde main().
// ────────────────────────────────────────────────────────────────────────────

type Getter = () => string[];

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

async function loadHelperFresh(): Promise<Getter> {
  // Dinámico: evita el cache de ES modules
  const mod = await import("./src/agent/tools.js");
  // Reset del warn flag para que cada test capture desde cero
  mod.__resetPuppeteerWarnForTesting?.();
  return mod.getPuppeteerLaunchArgs;
}

// Capturar console.warn para verificar el mensaje ruidoso
function captureWarn(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = console.warn;
  console.warn = (...args: any[]) => lines.push(args.join(" "));
  try { fn(); } finally { console.warn = orig; }
  return lines;
}

async function testDefault_NoSandbox() {
  const name = "Default: sin --no-sandbox, solo --disable-dev-shm-usage";
  try {
    await withEnv({ ALLOW_NO_SANDBOX: undefined, NODE_ENV: undefined }, async () => {
      const get = await loadHelperFresh();
      const args = get();
      assert.ok(!args.includes('--no-sandbox'), `default no debe incluir --no-sandbox. Got: ${args}`);
      assert.ok(!args.includes('--disable-setuid-sandbox'), `default no debe incluir --disable-setuid-sandbox. Got: ${args}`);
      assert.ok(args.includes('--disable-dev-shm-usage'), `default debe incluir --disable-dev-shm-usage. Got: ${args}`);
    });
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testDefault_ProductionNoWarn() {
  const name = "Default en production: NO emite warn (es el modo seguro)";
  try {
    await withEnv({ ALLOW_NO_SANDBOX: undefined, NODE_ENV: "production" }, async () => {
      const lines = captureWarn(() => {
        // recargar helper y llamarlo dentro del capture
      });
      const get = await loadHelperFresh();
      const _args = get();
      assert.equal(lines.length, 0, `production sin ALLOW_NO_SANDBOX no debe warnear. Got lines: ${lines}`);
    });
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testAllowNoSandbox_IncludesFlag() {
  const name = "ALLOW_NO_SANDBOX=1: incluye --no-sandbox + --disable-setuid-sandbox + --disable-dev-shm-usage";
  try {
    await withEnv({ ALLOW_NO_SANDBOX: "1", NODE_ENV: undefined }, async () => {
      const get = await loadHelperFresh();
      const args = get();
      assert.ok(args.includes('--no-sandbox'), `ALLOW_NO_SANDBOX=1 debe incluir --no-sandbox. Got: ${args}`);
      assert.ok(args.includes('--disable-setuid-sandbox'), `debe incluir --disable-setuid-sandbox. Got: ${args}`);
      assert.ok(args.includes('--disable-dev-shm-usage'), `debe incluir --disable-dev-shm-usage. Got: ${args}`);
    });
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testAllowNoSandbox_ProductionWarns() {
  const name = "ALLOW_NO_SANDBOX=1 en production: emite warn ruidoso mencionando PUPPETEER";
  try {
    await withEnv({ ALLOW_NO_SANDBOX: "1", NODE_ENV: "production" }, async () => {
      const lines: string[] = [];
      const orig = console.warn;
      console.warn = (...args: any[]) => lines.push(args.join(" "));
      try {
        const get = await loadHelperFresh();
        const _args = get();
      } finally {
        console.warn = orig;
      }
      assert.ok(lines.length > 0, `production con ALLOW_NO_SANDBOX debe warnear. Got: ${lines}`);
      const combined = lines.join(" ");
      assert.ok(
        combined.includes("PUPPETEER") && combined.includes("ALLOW_NO_SANDBOX"),
        `warn debe mencionar PUPPETEER y ALLOW_NO_SANDBOX. Got: ${combined}`
      );
    });
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testAllowNoSandbox_DevWarns() {
  const name = "ALLOW_NO_SANDBOX=1 en dev: SÍ emite warn (cualquier desactivación debe ser visible)";
  try {
    await withEnv({ ALLOW_NO_SANDBOX: "1", NODE_ENV: "development" }, async () => {
      const lines: string[] = [];
      const orig = console.warn;
      console.warn = (...args: any[]) => lines.push(args.join(" "));
      try {
        const get = await loadHelperFresh();
        const _args = get();
      } finally {
        console.warn = orig;
      }
      assert.ok(
        lines.length > 0,
        `ALLOW_NO_SANDBOX=1 debe warnear incluso en dev. Got: ${lines}`
      );
    });
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testAllowNoSandbox_ZeroValue() {
  const name = "ALLOW_NO_SANDBOX=0 (explícito): toma el default seguro";
  try {
    await withEnv({ ALLOW_NO_SANDBOX: "0", NODE_ENV: undefined }, async () => {
      const get = await loadHelperFresh();
      const args = get();
      assert.ok(!args.includes('--no-sandbox'), `ALLOW_NO_SANDBOX=0 debe ser default (no --no-sandbox). Got: ${args}`);
    });
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testAutoDetect_WindowsEnvIsSafe() {
  const name = "Auto-detect en Windows (este test env): sandbox nativo (no Docker, no root)";
  try {
    await withEnv(
      { ALLOW_NO_SANDBOX: undefined, ALLOW_SANDBOX: undefined, NODE_ENV: undefined },
      async () => {
        const get = await loadHelperFresh();
        const args = get();
        // En Windows, no hay /.dockerenv ni getuid()===0, así que el sandbox
        // nativo debe estar activo. Esta es la situación del dev local.
        if (process.platform === "win32") {
          assert.ok(
            !args.includes('--no-sandbox'),
            `Windows dev env debe usar sandbox nativo. Got: ${args}`
          );
        } else {
          // En Linux/macOS sin ser root, también
          assert.ok(
            !args.includes('--no-sandbox'),
            `Unix no-root debe usar sandbox nativo. Got: ${args}`
          );
        }
        assert.ok(
          args.includes('--disable-dev-shm-usage'),
          `--disable-dev-shm-usage siempre presente. Got: ${args}`
        );
      }
    );
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testAllowSandbox_ForcesSafe() {
  const name = "ALLOW_SANDBOX=1: fuerza sandbox seguro (override de auto-detect)";
  try {
    await withEnv(
      { ALLOW_NO_SANDBOX: undefined, ALLOW_SANDBOX: "1", NODE_ENV: undefined },
      async () => {
        const get = await loadHelperFresh();
        const args = get();
        assert.ok(
          !args.includes('--no-sandbox'),
          `ALLOW_SANDBOX=1 debe forzar sandbox seguro. Got: ${args}`
        );
      }
    );
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testAllowSandbox_OverridesNoSandbox() {
  const name = "ALLOW_SANDBOX=1 + ALLOW_NO_SANDBOX=1: ALLOW_SANDBOX gana (es el safe override)";
  try {
    await withEnv(
      { ALLOW_NO_SANDBOX: "1", ALLOW_SANDBOX: "1", NODE_ENV: undefined },
      async () => {
        const get = await loadHelperFresh();
        const args = get();
        // El override seguro tiene prioridad sobre el escape hatch
        assert.ok(
          !args.includes('--no-sandbox'),
          `ALLOW_SANDBOX debe ganar sobre ALLOW_NO_SANDBOX. Got: ${args}`
        );
      }
    );
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function testWarnMessage_MentionsSandbox() {
  const name = "Warn al desactivar sandbox: menciona PUPPETEER y da contexto";
  try {
    await withEnv({ ALLOW_NO_SANDBOX: "1", NODE_ENV: "production" }, async () => {
      const lines: string[] = [];
      const orig = console.warn;
      console.warn = (...args: any[]) => lines.push(args.join(" "));
      try {
        const get = await loadHelperFresh();
        const _args = get();
      } finally {
        console.warn = orig;
      }
      assert.ok(lines.length > 0, `debe warnear. Got: ${lines}`);
      const combined = lines.join(" ");
      assert.ok(
        combined.includes("PUPPETEER"),
        `warn debe mencionar PUPPETEER. Got: ${combined}`
      );
      assert.ok(
        combined.includes("ALLOW_NO_SANDBOX") || combined.includes("Docker") || combined.includes("root"),
        `warn debe dar razón. Got: ${combined}`
      );
    });
    pass(name);
  } catch (e: any) { fail(name, e); }
}

async function main() {
  log("═══════════════════════════════════════════════════════════════════");
  log("  getPuppeteerLaunchArgs — tests (Dim 1, Item 1.1)");
  log("═══════════════════════════════════════════════════════════════════");
  log("");

  await testDefault_NoSandbox();
  await testDefault_ProductionNoWarn();
  await testAllowNoSandbox_IncludesFlag();
  await testAllowNoSandbox_ProductionWarns();
  await testAllowNoSandbox_DevWarns();
  await testAllowNoSandbox_ZeroValue();
  await testAutoDetect_WindowsEnvIsSafe();
  await testAllowSandbox_ForcesSafe();
  await testAllowSandbox_OverridesNoSandbox();
  await testWarnMessage_MentionsSandbox();

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
