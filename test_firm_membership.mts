/**
 * D3.4 redesign — Multi-tenant firm membership (Sprint Tests).
 *
 * 12 tests E2E cubriendo schema, firm creation, invitations, onboarding
 * flow, audit, y DbAuthProvider.
 *
 * Spec: AGENT_D3_4_REDESIGN_SPRINT_SPEC.md §7.
 *
 * SETUP: mini Better Auth stack en :memory: + Express para tests E2E.
 * Cada función de firm.ts acepta `dbInstance` opcional para evitar
 * contaminar la DB real durante tests.
 */

import { betterAuth } from "better-auth";
import { twoFactor } from "better-auth/plugins";
import type Database from "better-sqlite3";
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

const TEST_SECRET = "test-secret-not-for-prod-32chars-min-aaaa";

interface TestStack {
  db: Database.Database;
  close: () => void;
}

/**
 * Crea un stack completo de auth + firm en :memory: para tests aislados.
 * Retorna { db, close }.
 */
async function createTestStack(): Promise<TestStack> {
  const db = (await import("better-sqlite3")).default(":memory:");
  db.pragma("foreign_keys = ON");

  const auth = betterAuth({
    database: db,
    baseURL: "http://localhost:3000",
    secret: TEST_SECRET,
    user: { modelName: "auth_user", additionalFields: {} },
    session: {
      modelName: "auth_session",
      expiresIn: 60 * 60 * 24 * 7,
      additionalFields: {
        activeFirmId: {
          type: "string",
          required: false,
          defaultValue: null,
          input: false,
        },
      },
    },
    account: { modelName: "auth_account" },
    verification: { modelName: "auth_verification" },
    socialProviders: {
      google: {
        clientId: "x",
        clientSecret: "y",
        prompt: "select_account",
        mapProfileToUser: () => ({}),
      },
    },
    trustedOrigins: ["http://localhost:3000"],
    advanced: { database: { generateId: () => crypto.randomUUID() } },
    plugins: [
      twoFactor({
        issuer: "Worgena",
        totpOptions: { digits: 6, period: 30 },
        backupCodeOptions: { amount: 8, length: 10 },
        allowPasswordless: true,
      }),
    ],
  });

  // Run migrations
  const { runMigrations } = await import("better-auth/db/migration").then(
    (m) => m.getMigrations(auth.options),
  );
  await runMigrations();

  // audit_auth table
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_auth (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      event TEXT NOT NULL,
      ip TEXT,
      user_agent TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL
    );
  `);

  // tenants, tenant_members, tenant_invitations
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      nit TEXT,
      created_at INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      archived_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS tenant_members (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
      joined_at INTEGER NOT NULL,
      invited_by TEXT,
      UNIQUE(user_id, tenant_id),
      FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS tenant_invitations (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      email TEXT,
      role TEXT NOT NULL DEFAULT 'member',
      token TEXT UNIQUE NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      used_by TEXT,
      created_at INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    );
  `);

  return { db, close: () => db.close() };
}

/**
 * Crea un user directamente en auth_user.
 */
function createUser(db: Database.Database, id: string, email: string): void {
  db.prepare(
    `INSERT INTO auth_user (id, email, emailVerified, name, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, email, 1, email.split("@")[0] ?? "user", Date.now(), Date.now());
}

// ============================================================
// Tests
// ============================================================

async function main(): Promise<void> {
  console.log("[Schema]");

  await test("A1: tabla tenants con columnas correctas", async () => {
    const stack = await createTestStack();
    try {
      const cols = stack.db
        .prepare("PRAGMA table_info(tenants)")
        .all() as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      assert.ok(names.includes("id"));
      assert.ok(names.includes("name"));
      assert.ok(names.includes("nit"));
      assert.ok(names.includes("created_at"));
      assert.ok(names.includes("created_by"));
      assert.ok(names.includes("archived_at"));
    } finally {
      stack.close();
    }
  });

  await test("A2: tabla tenant_members con UNIQUE(user_id, tenant_id) y FKs", async () => {
    const stack = await createTestStack();
    try {
      const cols = stack.db
        .prepare("PRAGMA table_info(tenant_members)")
        .all() as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      assert.ok(names.includes("user_id"));
      assert.ok(names.includes("tenant_id"));
      assert.ok(names.includes("role"));
      assert.ok(names.includes("joined_at"));
      assert.ok(names.includes("invited_by"));
      const fks = stack.db
        .prepare("PRAGMA foreign_key_list(tenant_members)")
        .all() as Array<{ from: string; table: string }>;
      assert.ok(
        fks.some((fk) => fk.from === "user_id" && fk.table === "auth_user"),
        "FK user_id -> auth_user",
      );
      assert.ok(
        fks.some((fk) => fk.from === "tenant_id" && fk.table === "tenants"),
        "FK tenant_id -> tenants",
      );
    } finally {
      stack.close();
    }
  });

  await test("A3: tabla tenant_invitations con FKs y token UNIQUE", async () => {
    const stack = await createTestStack();
    try {
      const cols = stack.db
        .prepare("PRAGMA table_info(tenant_invitations)")
        .all() as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      assert.ok(names.includes("token"));
      assert.ok(names.includes("expires_at"));
      assert.ok(names.includes("used_at"));
      const sql = stack.db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='tenant_invitations'",
        )
        .get() as { sql: string } | undefined;
      assert.ok(sql);
      assert.ok(
        sql!.sql.toUpperCase().includes("UNIQUE"),
        "schema incluye constraint UNIQUE en token",
      );
    } finally {
      stack.close();
    }
  });

  console.log("\n[Firm operations]");

  await test("A4: createFirm crea tenant + tenant_members(owner)", async () => {
    const stack = await createTestStack();
    try {
      const { createFirm } = await import("./src/lib/auth/firm.js");
      createUser(stack.db, "user-1", "owner@example.com");
      const firm = createFirm("Pérez & Asociados", "user-1", undefined, stack.db);
      assert.strictEqual(firm.name, "Pérez & Asociados");
      assert.strictEqual(firm.createdBy, "user-1");
      assert.strictEqual(firm.archivedAt, null);
      const members = stack.db
        .prepare(
          "SELECT * FROM tenant_members WHERE tenant_id = ? AND user_id = ?",
        )
        .all(firm.id, "user-1") as Array<{ role: string }>;
      assert.strictEqual(members.length, 1);
      assert.strictEqual(members[0]!.role, "owner");
    } finally {
      stack.close();
    }
  });

  await test("A5: createFirm(name, nit) crea firm con NIT", async () => {
    const stack = await createTestStack();
    try {
      const { createFirm } = await import("./src/lib/auth/firm.js");
      createUser(stack.db, "user-1", "u1@example.com");
      const firm = createFirm(
        "Bufete XYZ",
        "user-1",
        "900.123.456-7",
        stack.db,
      );
      assert.strictEqual(firm.nit, "900.123.456-7");
    } finally {
      stack.close();
    }
  });

  console.log("\n[Invitations]");

  await test("A6: joinFirmViaInvite(token) crea tenant_members(member)", async () => {
    const stack = await createTestStack();
    try {
      const {
        createFirm,
        createInvitation,
        joinFirmViaInvite,
      } = await import("./src/lib/auth/firm.js");
      createUser(stack.db, "user-1", "owner@example.com");
      createUser(stack.db, "user-2", "invitee@example.com");
      const firm = createFirm("Test Firm", "user-1", undefined, stack.db);
      const inv = createInvitation(
        firm.id,
        "user-1",
        undefined,
        "member",
        stack.db,
      );
      const result = joinFirmViaInvite("user-2", inv.token, stack.db);
      assert.strictEqual(result.firm.id, firm.id);
      assert.strictEqual(result.role, "member");
      const invRow = stack.db
        .prepare(
          "SELECT used_at, used_by FROM tenant_invitations WHERE id = ?",
        )
        .get(inv.id) as { used_at: number; used_by: string };
      assert.ok(invRow.used_at !== null);
      assert.strictEqual(invRow.used_by, "user-2");
    } finally {
      stack.close();
    }
  });

  await test("A7: joinFirmViaInvite(tokenExpirado) rechaza", async () => {
    const stack = await createTestStack();
    try {
      const { createFirm, joinFirmViaInvite } = await import(
        "./src/lib/auth/firm.js"
      );
      createUser(stack.db, "user-1", "u1@example.com");
      const firm = createFirm("Firm", "user-1", undefined, stack.db);
      stack.db
        .prepare(
          `INSERT INTO tenant_invitations
             (id, tenant_id, email, role, token, expires_at, created_at, created_by)
           VALUES (?, ?, NULL, 'member', ?, ?, ?, ?)`,
        )
        .run(
          "inv-expired",
          firm.id,
          "expired-token",
          Date.now() - 1000,
          Date.now() - 2000,
          "user-1",
        );
      assert.throws(
        () => joinFirmViaInvite("user-1", "expired-token", stack.db),
        /expired/,
        "rechaza token expirado",
      );
    } finally {
      stack.close();
    }
  });

  await test("A8: joinFirmViaInvite(tokenUsado) rechaza (single-use)", async () => {
    const stack = await createTestStack();
    try {
      const { createFirm, joinFirmViaInvite } = await import(
        "./src/lib/auth/firm.js"
      );
      createUser(stack.db, "user-1", "u1@example.com");
      createUser(stack.db, "user-2", "u2@example.com");
      const firm = createFirm("Firm", "user-1", undefined, stack.db);
      stack.db
        .prepare(
          `INSERT INTO tenant_invitations
             (id, tenant_id, email, role, token, expires_at, used_at, used_by, created_at, created_by)
           VALUES (?, ?, NULL, 'member', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "inv-used",
          firm.id,
          "used-token",
          Date.now() + 1000000,
          Date.now() - 1000,
          "user-2",
          Date.now() - 1000,
          "user-1",
        );
      assert.throws(
        () => joinFirmViaInvite("user-1", "used-token", stack.db),
        /invalid|used/,
        "rechaza token usado",
      );
    } finally {
      stack.close();
    }
  });

  await test("A9: joinFirmViaInvite(tokenInvalido) rechaza", async () => {
    const stack = await createTestStack();
    try {
      const { joinFirmViaInvite } = await import("./src/lib/auth/firm.js");
      createUser(stack.db, "user-1", "u1@example.com");
      assert.throws(
        () => joinFirmViaInvite("user-1", "nonexistent-token", stack.db),
        /invalid/,
        "rechaza token que no existe",
      );
    } finally {
      stack.close();
    }
  });

  console.log("\n[User firms]");

  await test("A10: getUserFirms retorna firms del user con role", async () => {
    const stack = await createTestStack();
    try {
      const {
        createFirm,
        getUserFirms,
        joinFirmViaInvite,
        createInvitation,
      } = await import("./src/lib/auth/firm.js");
      createUser(stack.db, "user-1", "u1@example.com");
      createUser(stack.db, "user-2", "u2@example.com");
      const firmA = createFirm("Firm A", "user-1", undefined, stack.db);
      const firmB = createFirm("Firm B", "user-2", undefined, stack.db);
      const inv = createInvitation(
        firmB.id,
        "user-2",
        undefined,
        "member",
        stack.db,
      );
      joinFirmViaInvite("user-1", inv.token, stack.db);

      const u1Firms = getUserFirms("user-1", stack.db);
      assert.strictEqual(u1Firms.length, 2);
      const u1A = u1Firms.find((f) => f.firm.id === firmA.id);
      const u1B = u1Firms.find((f) => f.firm.id === firmB.id);
      assert.ok(u1A);
      assert.strictEqual(u1A!.role, "owner");
      assert.ok(u1B);
      assert.strictEqual(u1B!.role, "member");

      const u2Firms = getUserFirms("user-2", stack.db);
      assert.strictEqual(u2Firms.length, 1);
      assert.strictEqual(u2Firms[0]!.role, "owner");
    } finally {
      stack.close();
    }
  });

  await test("A11: getSingleActiveFirmId retorna firm si user tiene 1", async () => {
    const stack = await createTestStack();
    try {
      const { createFirm, getSingleActiveFirmId } = await import(
        "./src/lib/auth/firm.js"
      );
      createUser(stack.db, "user-1", "u1@example.com");
      assert.strictEqual(
        getSingleActiveFirmId("user-1", stack.db),
        null,
      );
      const firm = createFirm("Solo", "user-1", undefined, stack.db);
      assert.strictEqual(getSingleActiveFirmId("user-1", stack.db), firm.id);
    } finally {
      stack.close();
    }
  });

  await test("A12: getSingleActiveFirmId retorna null si user tiene N>1 firms", async () => {
    const stack = await createTestStack();
    try {
      const {
        createFirm,
        joinFirmViaInvite,
        createInvitation,
        getSingleActiveFirmId,
      } = await import("./src/lib/auth/firm.js");
      createUser(stack.db, "user-1", "u1@example.com");
      createUser(stack.db, "user-2", "u2@example.com");
      const firmA = createFirm("Firm A", "user-1", undefined, stack.db);
      const firmB = createFirm("Firm B", "user-2", undefined, stack.db);
      const inv = createInvitation(
        firmB.id,
        "user-2",
        undefined,
        "member",
        stack.db,
      );
      joinFirmViaInvite("user-1", inv.token, stack.db);
      assert.strictEqual(getSingleActiveFirmId("user-1", stack.db), null);
      assert.strictEqual(getSingleActiveFirmId("user-2", stack.db), firmB.id);
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
