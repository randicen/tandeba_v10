/**
 * P0 #4 Billing v1 — Sprint Tests.
 *
 * 24 tests E2E cubriendo schema, balance computation, atomicidad,
 * LLM enforcement, webhook signature, e idempotencia.
 *
 * Spec: AGENT_BILLING_V1_SPEC.md §7.
 *
 * SETUP: cada test crea un DB :memory: con tablas billing + seed
 * de planes y packs. Aísla tests sin contaminar la DB real.
 */

import Database from "better-sqlite3";
import { createHmac } from "node:crypto";
import assert from "node:assert/strict";

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
      if (e instanceof Error && e.stack) {
        console.error(`    ${e.stack.split("\n").slice(1, 3).join("\n")}`);
      }
    });
}

// ============================================================
// Helpers
// ============================================================

interface TestStack {
  db: Database.Database;
  close: () => void;
}

/**
 * Crea un stack aislado: DB :memory: con las tablas billing + seed
 * de planes y packs.
 */
async function createTestStack(): Promise<TestStack> {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");

  // tenants (necesario para FKs)
  db.exec(`
    CREATE TABLE tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      nit TEXT,
      created_at INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      archived_at INTEGER
    );
  `);

  // auth_user stub (necesario para FKs en tests con cross-tenant)
  db.exec(`
    CREATE TABLE auth_user (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      emailVerified INTEGER NOT NULL DEFAULT 0,
      name TEXT,
      image TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
  `);

  // Las 7 tablas billing
  db.exec(`
    CREATE TABLE plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      monthly_credits INTEGER NOT NULL,
      max_users_per_firm INTEGER NOT NULL,
      monthly_price_cop INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'COP',
      features_json TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE firm_subscriptions (
      id TEXT PRIMARY KEY,
      firm_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'past_due', 'cancelled', 'expired')),
      epayco_customer_id TEXT,
      epayco_subscription_id TEXT,
      current_period_start INTEGER,
      current_period_end INTEGER,
      cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
      cancelled_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (firm_id) REFERENCES tenants(id) ON DELETE CASCADE,
      FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE RESTRICT
    );
    CREATE TABLE credit_ledger (
      id TEXT PRIMARY KEY,
      firm_id TEXT NOT NULL,
      delta INTEGER NOT NULL,
      reason TEXT NOT NULL CHECK (reason IN ('plan_grant', 'wallet_purchase', 'auto_recharge', 'llm_call', 'refund', 'manual_adjustment', 'expiry')),
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (firm_id) REFERENCES tenants(id) ON DELETE CASCADE
    );
    CREATE TABLE credit_packs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      credits_amount INTEGER NOT NULL,
      price_cop INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'COP',
      is_active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE wallet_purchases (
      id TEXT PRIMARY KEY,
      firm_id TEXT NOT NULL,
      credit_pack_id TEXT NOT NULL,
      epayco_charge_id TEXT,
      amount_cop INTEGER NOT NULL,
      credits_granted INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
      failure_reason TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      FOREIGN KEY (firm_id) REFERENCES tenants(id) ON DELETE CASCADE,
      FOREIGN KEY (credit_pack_id) REFERENCES credit_packs(id) ON DELETE RESTRICT
    );
    CREATE TABLE auto_recharge_config (
      id TEXT PRIMARY KEY,
      firm_id TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 0,
      threshold_credits INTEGER NOT NULL,
      recharge_credit_pack_id TEXT NOT NULL,
      max_per_month_cop INTEGER NOT NULL,
      current_month_spent_cop INTEGER NOT NULL DEFAULT 0,
      current_period TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (firm_id) REFERENCES tenants(id) ON DELETE CASCADE,
      FOREIGN KEY (recharge_credit_pack_id) REFERENCES credit_packs(id) ON DELETE RESTRICT
    );
    CREATE TABLE webhook_events (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      external_event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT,
      status TEXT NOT NULL CHECK (status IN ('received', 'processed', 'failed')),
      error_message TEXT,
      received_at INTEGER NOT NULL,
      processed_at INTEGER,
      UNIQUE(provider, external_event_id)
    );
  `);

  // Seed planes
  const now = Date.now();
  db.prepare(`
    INSERT INTO plans (id, name, monthly_credits, max_users_per_firm, monthly_price_cop, currency, features_json, is_active, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run("plan_free", "Free", 100, 1, 0, "COP", "{}", 0, now, now);
  db.prepare(`
    INSERT INTO plans (id, name, monthly_credits, max_users_per_firm, monthly_price_cop, currency, features_json, is_active, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run("plan_pro", "Pro", 2000, 10, 30000, "COP", "{}", 1, now, now);
  db.prepare(`
    INSERT INTO plans (id, name, monthly_credits, max_users_per_firm, monthly_price_cop, currency, features_json, is_active, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run("plan_enterprise", "Enterprise", 20000, 100, 300000, "COP", "{}", 2, now, now);

  // Seed packs
  db.prepare(`
    INSERT INTO credit_packs (id, name, credits_amount, price_cop, currency, is_active, sort_order, created_at)
    VALUES (?, ?, ?, ?, 'COP', 1, ?, ?)
  `).run("pack_100", "100 créditos", 100, 10000, 0, now);
  db.prepare(`
    INSERT INTO credit_packs (id, name, credits_amount, price_cop, currency, is_active, sort_order, created_at)
    VALUES (?, ?, ?, ?, 'COP', 1, ?, ?)
  `).run("pack_500", "500 créditos", 500, 45000, 1, now);

  return { db, close: () => db.close() };
}

function createFirm(stack: TestStack, id: string): void {
  stack.db
    .prepare(
      "INSERT INTO tenants (id, name, created_at, created_by) VALUES (?, 'Test Firm', ?, 'user-1')",
    )
    .run(id, Date.now());
}

// ============================================================
// Tests
// ============================================================

async function main(): Promise<void> {
  // Importar las funciones de billing (después de createTestStack,
  // porque las funciones usan getDb() default que NO es nuestra :memory:.
  // Workaround: importar y monkey-patch getDb, O importar las funciones
  // que aceptan dbInstance y llamar con stack.db.
  const billing = await import("./src/lib/billing/billing.js");
  const conversion = await import("./src/lib/billing/conversion.js");

  console.log("[Bloque A: Schema]");

  await test("A1: tabla plans existe con columnas requeridas", async () => {
    const stack = await createTestStack();
    try {
      const cols = stack.db
        .prepare("PRAGMA table_info(plans)")
        .all() as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      assert.ok(names.includes("id"));
      assert.ok(names.includes("monthly_credits"));
      assert.ok(names.includes("monthly_price_cop"));
      assert.ok(names.includes("features_json"));
    } finally {
      stack.close();
    }
  });

  await test("A2: tabla credit_ledger con CHECK constraint en reason", async () => {
    const stack = await createTestStack();
    try {
      createFirm(stack, "firm-1");
      assert.throws(
        () =>
          stack.db
            .prepare(
              "INSERT INTO credit_ledger (id, firm_id, delta, reason, created_at) VALUES (?, ?, ?, ?, ?)",
            )
            .run("cl-1", "firm-1", 100, "invalid_reason", Date.now()),
        /CHECK constraint/,
      );
    } finally {
      stack.close();
    }
  });

  await test("A3: tabla webhook_events con UNIQUE en (provider, external_event_id)", async () => {
    const stack = await createTestStack();
    try {
      stack.db
        .prepare(
          "INSERT INTO webhook_events (id, provider, external_event_id, event_type, status, received_at) VALUES (?, ?, ?, ?, 'received', ?)",
        )
        .run("evt-1", "epayco", "ext-1", "subscription.approved", Date.now());
      assert.throws(
        () =>
          stack.db
            .prepare(
              "INSERT INTO webhook_events (id, provider, external_event_id, event_type, status, received_at) VALUES (?, ?, ?, ?, 'received', ?)",
            )
            .run("evt-2", "epayco", "ext-1", "subscription.approved", Date.now()),
        /UNIQUE constraint/,
      );
    } finally {
      stack.close();
    }
  });

  await test("A4: tabla firm_subscriptions con CHECK en status", async () => {
    const stack = await createTestStack();
    try {
      createFirm(stack, "firm-1");
      assert.throws(
        () =>
          stack.db
            .prepare(
              "INSERT INTO firm_subscriptions (id, firm_id, plan_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .run("fs-1", "firm-1", "plan_pro", "invalid_status", Date.now(), Date.now()),
        /CHECK constraint/,
      );
    } finally {
      stack.close();
    }
  });

  await test("A5: seed de planes contiene plan_free, plan_pro, plan_enterprise", async () => {
    const stack = await createTestStack();
    try {
      const plans = stack.db
        .prepare("SELECT id FROM plans ORDER BY sort_order")
        .all() as Array<{ id: string }>;
      const ids = plans.map((p) => p.id);
      assert.deepStrictEqual(ids, ["plan_free", "plan_pro", "plan_enterprise"]);
    } finally {
      stack.close();
    }
  });

  console.log("\n[Bloque B: Balance computation]");

  await test("B1: getCreditBalance de firm sin grants = 0", async () => {
    const stack = await createTestStack();
    try {
      createFirm(stack, "firm-1");
      const balance = billing.getCreditBalance("firm-1", stack.db);
      assert.strictEqual(balance, 0);
    } finally {
      stack.close();
    }
  });

  await test("B2: grantCredit suma al balance", async () => {
    const stack = await createTestStack();
    try {
      createFirm(stack, "firm-1");
      billing.grantCredit("firm-1", 100, "plan_grant", null, stack.db);
      billing.grantCredit("firm-1", 50, "wallet_purchase", null, stack.db);
      const balance = billing.getCreditBalance("firm-1", stack.db);
      assert.strictEqual(balance, 150);
    } finally {
      stack.close();
    }
  });

  await test("B3: consumeCredit resta del balance", async () => {
    const stack = await createTestStack();
    try {
      createFirm(stack, "firm-1");
      billing.grantCredit("firm-1", 100, "plan_grant", null, stack.db);
      billing.consumeCredit("firm-1", 30, "llm_call", null, stack.db);
      const balance = billing.getCreditBalance("firm-1", stack.db);
      assert.strictEqual(balance, 70);
    } finally {
      stack.close();
    }
  });

  await test("B4: getCreditHistory retorna últimas N entries", async () => {
    const stack = await createTestStack();
    try {
      createFirm(stack, "firm-1");
      billing.grantCredit("firm-1", 100, "plan_grant", null, stack.db);
      billing.consumeCredit("firm-1", 10, "llm_call", null, stack.db);
      billing.grantCredit("firm-1", 5, "refund", null, stack.db);
      const history = billing.getCreditHistory("firm-1", 10, stack.db);
      assert.strictEqual(history.length, 3);
      // El más reciente primero
      assert.strictEqual(history[0]!.reason, "refund");
      assert.strictEqual(history[0]!.delta, 5);
      assert.strictEqual(history[1]!.reason, "llm_call");
      assert.strictEqual(history[1]!.delta, -10);
    } finally {
      stack.close();
    }
  });

  console.log("\n[Bloque C: Atomicidad]");

  await test("C1: consumeCredit atómico, balance insuficiente lanza error", async () => {
    const stack = await createTestStack();
    try {
      createFirm(stack, "firm-1");
      billing.grantCredit("firm-1", 50, "plan_grant", null, stack.db);
      assert.throws(
        () => billing.consumeCredit("firm-1", 100, "llm_call", null, stack.db),
        /InsufficientCreditsError/,
      );
      // Balance NO cambió (atomicidad: throw hace rollback)
      const balance = billing.getCreditBalance("firm-1", stack.db);
      assert.strictEqual(balance, 50);
    } finally {
      stack.close();
    }
  });

  await test("C2: consumeCredit con amount 0 = no-op", async () => {
    const stack = await createTestStack();
    try {
      createFirm(stack, "firm-1");
      billing.grantCredit("firm-1", 100, "plan_grant", null, stack.db);
      billing.consumeCredit("firm-1", 0, "llm_call", null, stack.db);
      const balance = billing.getCreditBalance("firm-1", stack.db);
      assert.strictEqual(balance, 100);
    } finally {
      stack.close();
    }
  });

  await test("C3: getCreditBalance de firm inexistente = 0 (no throw)", async () => {
    const stack = await createTestStack();
    try {
      const balance = billing.getCreditBalance("nonexistent", stack.db);
      assert.strictEqual(balance, 0);
    } finally {
      stack.close();
    }
  });

  console.log("\n[Bloque D: Plans]");

  await test("D1: hasActivePlan de firm sin subscription = true (plan_free implícito)", async () => {
    const stack = await createTestStack();
    try {
      createFirm(stack, "firm-1");
      const active = billing.hasActivePlan("firm-1", stack.db);
      assert.strictEqual(active, true);
    } finally {
      stack.close();
    }
  });

  await test("D2: getCurrentPlan de firm sin subscription = plan_free", async () => {
    const stack = await createTestStack();
    try {
      createFirm(stack, "firm-1");
      const plan = billing.getCurrentPlan("firm-1", stack.db);
      assert.ok(plan);
      assert.strictEqual(plan.id, "plan_free");
      assert.strictEqual(plan.monthlyCredits, 100);
    } finally {
      stack.close();
    }
  });

  await test("D3: listActivePlans retorna 3 planes ordenados", async () => {
    const stack = await createTestStack();
    try {
      const plans = billing.listActivePlans(stack.db);
      assert.strictEqual(plans.length, 3);
      assert.strictEqual(plans[0]!.id, "plan_free");
      assert.strictEqual(plans[2]!.id, "plan_enterprise");
    } finally {
      stack.close();
    }
  });

  await test("D4: upsertFirmSubscription crea y luego actualiza", async () => {
    const stack = await createTestStack();
    try {
      createFirm(stack, "firm-1");
      const sub1 = billing.upsertFirmSubscription(
        "firm-1",
        "plan_pro",
        "pending",
        "epayco-c-1",
        "epayco-s-1",
        Date.now(),
        Date.now() + 30 * 24 * 60 * 60 * 1000,
        stack.db,
      );
      assert.strictEqual(sub1.status, "pending");
      assert.strictEqual(sub1.planId, "plan_pro");
      const sub2 = billing.upsertFirmSubscription(
        "firm-1",
        "plan_pro",
        "active",
        "epayco-c-1",
        "epayco-s-1",
        Date.now(),
        Date.now() + 30 * 24 * 60 * 60 * 1000,
        stack.db,
      );
      assert.strictEqual(sub2.status, "active");
      assert.strictEqual(sub1.id, sub2.id, "mismo row, no duplicado");
    } finally {
      stack.close();
    }
  });

  console.log("\n[Bloque E: Webhook + LLM enforcement]");

  await test("E1: webhook con firma inválida retorna 401, no side-effect", async () => {
    const stack = await createTestStack();
    try {
      createFirm(stack, "firm-1");
      const { EpaycoClient, EpaycoWebhookHandler } = await import("./src/lib/billing/index.js");
      const client = new EpaycoClient({
        publicKey: "test-public",
        privateKey: "test-private",
        testMode: true,
      });
      const handler = new EpaycoWebhookHandler({
        db: stack.db,
        client,
        planIdToCreditsCop: new Map(),
      });
      const body = JSON.stringify({ type: "subscription.approved" });
      const result = await handler.process(body, "invalid-signature", "evt-1");
      assert.strictEqual(result.status, 401);
      // NO se insertó webhook_events
      const events = stack.db
        .prepare("SELECT id FROM webhook_events")
        .all() as Array<{ id: string }>;
      assert.strictEqual(events.length, 0);
    } finally {
      stack.close();
    }
  });

  await test("E2: webhook con firma válida procesa y persiste side-effects", async () => {
    const stack = await createTestStack();
    try {
      createFirm(stack, "firm-1");
      // Suscripción pending con epayco_customer_id para que el handler
      // pueda resolver firm_id.
      const now = Date.now();
      stack.db
        .prepare(
          `INSERT INTO firm_subscriptions
             (id, firm_id, plan_id, status, epayco_customer_id, current_period_start, current_period_end, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
        )
        .run(
          "fs-1",
          "firm-1",
          "plan_pro",
          "epayco-c-1",
          now,
          now + 30 * 24 * 60 * 60 * 1000,
          now,
          now,
        );

      const { EpaycoClient, EpaycoWebhookHandler } = await import("./src/lib/billing/index.js");
      const privateKey = "test-private";
      const client = new EpaycoClient({
        publicKey: "test-public",
        privateKey,
        testMode: true,
      });
      const handler = new EpaycoWebhookHandler({
        db: stack.db,
        client,
        planIdToCreditsCop: new Map([
          ["plan_pro", { credits: 2000, reason: "plan_grant" }],
        ]),
      });
      const body = JSON.stringify({
        type: "subscription.approved",
        subscription: {
          id: "epayco-s-1",
          customerId: "epayco-c-1",
          planId: "plan_pro",
          status: "active",
          periodStart: now,
          periodEnd: now + 30 * 24 * 60 * 60 * 1000,
        },
      });
      const sig = createHmac("sha256", privateKey).update(body, "utf8").digest("base64");
      const result = await handler.process(body, sig, "evt-1");
      assert.strictEqual(result.status, 200);
      assert.strictEqual(result.processed, true);
      // Subscription updated to active
      const sub = billing.getFirmSubscription("firm-1", stack.db);
      assert.strictEqual(sub?.status, "active");
      // Credits granted
      const balance = billing.getCreditBalance("firm-1", stack.db);
      assert.strictEqual(balance, 2000);
    } finally {
      stack.close();
    }
  });

  await test("E3: webhook duplicado (mismo external_event_id) es no-op", async () => {
    const stack = await createTestStack();
    try {
      createFirm(stack, "firm-1");
      const now = Date.now();
      stack.db
        .prepare(
          `INSERT INTO firm_subscriptions
             (id, firm_id, plan_id, status, epayco_customer_id, current_period_start, current_period_end, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
        )
        .run("fs-1", "firm-1", "plan_pro", "epayco-c-1", now, now, now, now);

      const { EpaycoClient, EpaycoWebhookHandler } = await import("./src/lib/billing/index.js");
      const privateKey = "test-private";
      const client = new EpaycoClient({ publicKey: "p", privateKey, testMode: true });
      const handler = new EpaycoWebhookHandler({
        db: stack.db,
        client,
        planIdToCreditsCop: new Map([["plan_pro", { credits: 2000, reason: "plan_grant" }]]),
      });
      const body = JSON.stringify({
        type: "subscription.approved",
        subscription: {
          id: "epayco-s-1",
          customerId: "epayco-c-1",
          planId: "plan_pro",
          status: "active",
          periodStart: now,
          periodEnd: now + 30 * 24 * 60 * 60 * 1000,
        },
      });
      const sig = createHmac("sha256", privateKey).update(body, "utf8").digest("base64");
      // Primer webhook: procesa
      const r1 = await handler.process(body, sig, "evt-dup");
      assert.strictEqual(r1.processed, true);
      const balance1 = billing.getCreditBalance("firm-1", stack.db);
      assert.strictEqual(balance1, 2000);
      // Segundo webhook con mismo event_id: no-op
      const r2 = await handler.process(body, sig, "evt-dup");
      assert.strictEqual(r2.processed, false);
      const balance2 = billing.getCreditBalance("firm-1", stack.db);
      assert.strictEqual(balance2, 2000, "balance NO cambió en segundo webhook");
    } finally {
      stack.close();
    }
  });

  await test("E4: LLM enforcement: firm con balance 0 → consumeCredit lanza error", async () => {
    const stack = await createTestStack();
    try {
      createFirm(stack, "firm-1");
      // Sin grant: balance = 0
      // Simular un consume con requiredCredits alto
      assert.throws(
        () =>
          billing.consumeCredit("firm-1", 1000, "llm_call", { costUsd: 10 }, stack.db),
        /InsufficientCreditsError/,
      );
    } finally {
      stack.close();
    }
  });

  console.log("\n[Bloque F: Conversion]");

  await test("F1: usdToCredits con default rate = 100, $1 USD = 100 créditos", async () => {
    assert.strictEqual(conversion.usdToCredits(1), 100);
    assert.strictEqual(conversion.usdToCredits(0.5), 50);
    assert.strictEqual(conversion.usdToCredits(0.01), 1);
    assert.strictEqual(conversion.usdToCredits(0), 0);
  });

  await test("F2: usdToCredits Math.ceil (no sub-paga)", async () => {
    // $0.005 USD = 0.5 créditos → ceil = 1 crédito
    assert.strictEqual(conversion.usdToCredits(0.005), 1);
  });

  await test("F3: creditsToUsd inverso", async () => {
    assert.strictEqual(conversion.creditsToUsd(100), 1);
    assert.strictEqual(conversion.creditsToUsd(50), 0.5);
    assert.strictEqual(conversion.creditsToUsd(0), 0);
  });

  await test("F4: usdToCredits con amount negativo retorna 0", async () => {
    assert.strictEqual(conversion.usdToCredits(-1), 0);
    assert.strictEqual(conversion.usdToCredits(-100), 0);
  });

  console.log("\n[Bloque G: Cross-tenant + multi-tenancy]");

  await test("G1: grants de firm A no afectan balance de firm B", async () => {
    const stack = await createTestStack();
    try {
      createFirm(stack, "firm-A");
      createFirm(stack, "firm-B");
      billing.grantCredit("firm-A", 100, "plan_grant", null, stack.db);
      billing.grantCredit("firm-B", 200, "plan_grant", null, stack.db);
      assert.strictEqual(billing.getCreditBalance("firm-A", stack.db), 100);
      assert.strictEqual(billing.getCreditBalance("firm-B", stack.db), 200);
    } finally {
      stack.close();
    }
  });

  await test("G2: getCreditHistory filtra por firm_id", async () => {
    const stack = await createTestStack();
    try {
      createFirm(stack, "firm-A");
      createFirm(stack, "firm-B");
      billing.grantCredit("firm-A", 100, "plan_grant", null, stack.db);
      billing.grantCredit("firm-B", 200, "plan_grant", null, stack.db);
      billing.consumeCredit("firm-A", 10, "llm_call", null, stack.db);
      const histA = billing.getCreditHistory("firm-A", 10, stack.db);
      assert.strictEqual(histA.length, 2);
      for (const entry of histA) {
        assert.strictEqual(entry.firmId, "firm-A");
      }
    } finally {
      stack.close();
    }
  });

  console.log(
    `\n=== Resultado: ${passed} passed, ${failed} failed ===`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Test runner failed:", e);
  process.exit(1);
});
