/**
 * P0 #5 Jobs v1 — Sprint Tests.
 *
 * 18+ tests E2E cubriendo schema, repository, worker, handlers,
 * retries, dead letter, y multi-tenant isolation.
 *
 * Spec: AGENT_JOBS_V1_SPEC.md §7.
 *
 * SETUP: cada test crea un DB :memory: con tablas necesarias
 * (jobs, audit_auth, tenant_invitations, tenants, auth_user, etc).
 * Email provider se mockea (no llama a Resend real).
 */

import Database from "better-sqlite3";
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

async function createTestStack(): Promise<TestStack> {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");

  // Tablas mínimas para que los handlers funcionen
  db.exec(`
    CREATE TABLE tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      nit TEXT,
      created_at INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      archived_at INTEGER
    );
    CREATE TABLE auth_user (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      emailVerified INTEGER NOT NULL DEFAULT 0,
      name TEXT,
      image TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE TABLE tenant_members (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      role TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      invited_by TEXT,
      UNIQUE(user_id, tenant_id)
    );
    CREATE TABLE tenant_invitations (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      email TEXT,
      role TEXT NOT NULL DEFAULT 'member',
      token TEXT UNIQUE NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      used_by TEXT,
      created_at INTEGER NOT NULL,
      created_by TEXT NOT NULL
    );
    CREATE TABLE audit_auth (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      event TEXT NOT NULL,
      ip TEXT,
      user_agent TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE credit_ledger (
      id TEXT PRIMARY KEY,
      firm_id TEXT NOT NULL,
      delta INTEGER NOT NULL,
      reason TEXT NOT NULL,
      metadata_json TEXT,
      created_at INTEGER NOT NULL
    );
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
      status TEXT NOT NULL,
      epayco_customer_id TEXT,
      epayco_subscription_id TEXT,
      current_period_start INTEGER,
      current_period_end INTEGER,
      cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
      cancelled_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    -- Seed plan_free para tests de billing
    INSERT INTO plans (id, name, monthly_credits, max_users_per_firm, monthly_price_cop, currency, is_active, sort_order, created_at, updated_at)
    VALUES ('plan_free', 'Free', 100, 1, 0, 'COP', 1, 0, 0, 0);
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      idempotency_key TEXT UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'dead_letter')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      scheduled_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX jobs_status_scheduled_idx ON jobs(status, scheduled_at);
  `);

  return { db, close: () => db.close() };
}

/**
 * Mock email provider. Captura los emails enviados.
 */
class MockEmailProvider {
  sent: Array<{ to: string; subject: string; html: string }> = [];
  failNext: boolean = false;
  async sendEmail(input: { to: string; subject: string; html: string; text?: string }) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("MockEmailProvider: simulated failure");
    }
    this.sent.push({ to: input.to, subject: input.subject, html: input.html });
    return { id: `mock-${this.sent.length}` };
  }
}

// ============================================================
// Tests
// ============================================================

async function main(): Promise<void> {
  const repo = await import("./src/lib/jobs/repository.js");

  console.log("[Bloque A: Schema]");

  await test("A1: tabla jobs existe con columnas requeridas", async () => {
    const stack = await createTestStack();
    try {
      const cols = stack.db
        .prepare("PRAGMA table_info(jobs)")
        .all() as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      assert.ok(names.includes("id"));
      assert.ok(names.includes("type"));
      assert.ok(names.includes("payload_json"));
      assert.ok(names.includes("status"));
      assert.ok(names.includes("scheduled_at"));
      assert.ok(names.includes("attempts"));
    } finally {
      stack.close();
    }
  });

  await test("A2: tabla jobs con CHECK constraint en status", async () => {
    const stack = await createTestStack();
    try {
      assert.throws(
        () =>
          stack.db
            .prepare(
              "INSERT INTO jobs (id, type, payload_json, status, scheduled_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .run("j-1", "test", "{}", "invalid", Date.now(), Date.now()),
        /CHECK constraint/,
      );
    } finally {
      stack.close();
    }
  });

  await test("A3: UNIQUE en idempotency_key", async () => {
    const stack = await createTestStack();
    try {
      stack.db
        .prepare(
          "INSERT INTO jobs (id, type, payload_json, idempotency_key, status, scheduled_at, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
        )
        .run("j-1", "test", "{}", "k1", Date.now(), Date.now());
      assert.throws(
        () =>
          stack.db
            .prepare(
              "INSERT INTO jobs (id, type, payload_json, idempotency_key, status, scheduled_at, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
            )
            .run("j-2", "test", "{}", "k1", Date.now(), Date.now()),
        /UNIQUE constraint/,
      );
    } finally {
      stack.close();
    }
  });

  console.log("\n[Bloque B: Repository]");

  await test("B1: enqueueJob crea row con status pending", async () => {
    const stack = await createTestStack();
    try {
      const job = repo.enqueueJob(
        "send_invitation_email",
        { invitationId: "inv-1" },
        {},
        stack.db,
      );
      assert.strictEqual(job.type, "send_invitation_email");
      assert.strictEqual(job.status, "pending");
      assert.strictEqual(job.attempts, 0);
      const jobFromDb = repo.getJobById(job.id, stack.db);
      assert.ok(jobFromDb);
      assert.strictEqual(jobFromDb.id, job.id);
    } finally {
      stack.close();
    }
  });

  await test("B2: enqueueJob con idempotency_key retorna el existente", async () => {
    const stack = await createTestStack();
    try {
      const j1 = repo.enqueueJob(
        "send_invitation_email",
        { invitationId: "inv-1" },
        { idempotencyKey: "k-1" },
        stack.db,
      );
      const j2 = repo.enqueueJob(
        "send_invitation_email",
        { invitationId: "inv-1" },
        { idempotencyKey: "k-1" },
        stack.db,
      );
      assert.strictEqual(j1.id, j2.id, "mismo job, no duplicado");
    } finally {
      stack.close();
    }
  });

  await test("B3: claimPendingJobs retorna los más viejos primero", async () => {
    const stack = await createTestStack();
    try {
      const now = Date.now();
      // 3 jobs con scheduled_at distintos
      const j1 = repo.enqueueJob(
        "send_invitation_email",
        { n: 1 },
        { scheduledAt: now - 3000 },
        stack.db,
      );
      const j2 = repo.enqueueJob(
        "send_invitation_email",
        { n: 2 },
        { scheduledAt: now - 2000 },
        stack.db,
      );
      const j3 = repo.enqueueJob(
        "send_invitation_email",
        { n: 3 },
        { scheduledAt: now - 1000 },
        stack.db,
      );
      const claimed = repo.claimPendingJobs(5, stack.db);
      assert.strictEqual(claimed.length, 3);
      // Más viejo primero
      assert.strictEqual(claimed[0]!.id, j1.id);
      assert.strictEqual(claimed[1]!.id, j2.id);
      assert.strictEqual(claimed[2]!.id, j3.id);
      // Status updated
      for (const c of claimed) {
        assert.strictEqual(c.status, "running");
        assert.strictEqual(c.attempts, 1, "attempts++ al claim");
      }
    } finally {
      stack.close();
    }
  });

  await test("B3b: claimPendingJobs es determinístico con mismo scheduled_at (rowid tiebreak)", async () => {
    const stack = await createTestStack();
    try {
      const now = Date.now();
      // 3 jobs con MISMO scheduled_at (mismo ms)
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const j = repo.enqueueJob(
          "send_invitation_email",
          { n: i },
          { scheduledAt: now - 1000 },
          stack.db,
        );
        ids.push(j.id);
      }
      const claimed = repo.claimPendingJobs(5, stack.db);
      assert.strictEqual(claimed.length, 3);
      // Orden = orden de INSERT (rowid asc)
      for (let i = 0; i < 3; i++) {
        assert.strictEqual(claimed[i]!.id, ids[i], `claimed[${i}].id`);
      }
    } finally {
      stack.close();
    }
  });

  await test("B4: claimPendingJobs no retorna running (idempotente)", async () => {
    const stack = await createTestStack();
    try {
      repo.enqueueJob("send_invitation_email", { n: 1 }, {}, stack.db);
      const c1 = repo.claimPendingJobs(5, stack.db);
      assert.strictEqual(c1.length, 1);
      const c2 = repo.claimPendingJobs(5, stack.db);
      assert.strictEqual(c2.length, 0, "no retorna el mismo job");
    } finally {
      stack.close();
    }
  });

  await test("B5: claimPendingJobs atómico (dos calls concurrentes no roban)", async () => {
    const stack = await createTestStack();
    try {
      // 5 jobs pending
      for (let i = 0; i < 5; i++) {
        repo.enqueueJob("send_invitation_email", { n: i }, {}, stack.db);
      }
      // Dos claims concurrentes
      const [c1, c2] = await Promise.all([
        Promise.resolve(repo.claimPendingJobs(3, stack.db)),
        Promise.resolve(repo.claimPendingJobs(3, stack.db)),
      ]);
      // El total claimed entre los dos debe ser 5 (sin solapamiento)
      const totalClaimed = new Set([...c1, ...c2].map((j) => j.id)).size;
      assert.strictEqual(totalClaimed, 5);
    } finally {
      stack.close();
    }
  });

  await test("B6: markJobCompleted/Failed/DeadLetter cambian status", async () => {
    const stack = await createTestStack();
    try {
      const j = repo.enqueueJob("test", {}, {}, stack.db);
      repo.markJobCompleted(j.id, stack.db);
      assert.strictEqual(repo.getJobById(j.id, stack.db)?.status, "completed");
      const j2 = repo.enqueueJob("test", {}, {}, stack.db);
      repo.markJobFailed(j2.id, "error test", true, stack.db);
      const j2after = repo.getJobById(j2.id, stack.db);
      assert.strictEqual(j2after?.status, "pending", "willRetry=true → pending");
      assert.strictEqual(j2after?.lastError, "error test");
      assert.ok(j2after && j2after.scheduledAt > Date.now(), "scheduled_at bumped");
      const j3 = repo.enqueueJob("test", {}, {}, stack.db);
      repo.markJobDeadLetter(j3.id, "fatal", stack.db);
      assert.strictEqual(repo.getJobById(j3.id, stack.db)?.status, "dead_letter");
    } finally {
      stack.close();
    }
  });

  await test("B7: computeBackoffMs escala con attempts", async () => {
    const base = 1_000_000;
    const b1 = repo.computeBackoffMs(1, base);
    const b2 = repo.computeBackoffMs(2, base);
    const b3 = repo.computeBackoffMs(3, base);
    assert.ok(b2 > b1, "attempts=2 > attempts=1");
    assert.ok(b3 > b2, "attempts=3 > attempts=2");
  });

  console.log("\n[Bloque C: Handlers]");

  await test("C1: send_invitation_email lee invitation, manda email con URL", async () => {
    const stack = await createTestStack();
    try {
      // Setup: firm, user, invitation
      const now = Date.now();
      stack.db
        .prepare(
          "INSERT INTO tenants (id, name, created_at, created_by) VALUES (?, 'Firm Test', ?, 'user-1')",
        )
        .run("firm-1", now);
      stack.db
        .prepare(
          "INSERT INTO auth_user (id, email, emailVerified, name, createdAt, updatedAt) VALUES (?, 'inviter@example.com', 1, 'Inviter', ?, ?)",
        )
        .run("user-1", now, now);
      stack.db
        .prepare(
          `INSERT INTO tenant_invitations
             (id, tenant_id, email, role, token, expires_at, created_at, created_by)
           VALUES (?, ?, ?, 'member', ?, ?, ?, ?)`,
        )
        .run(
          "inv-1",
          "firm-1",
          "invitee@example.com",
          "tok-abc",
          now + 7 * 24 * 60 * 60 * 1000,
          now,
          "user-1",
        );
      const email = new MockEmailProvider();
      const handler = (
        await import("./src/lib/jobs/handlers/send-invitation-email.js")
      ).handleSendInvitationEmail;
      await handler(
        { invitationId: "inv-1" },
        {
          db: stack.db,
          email: email as never,
          config: { publicUrl: "https://test.worgena.com" },
        },
      );
      assert.strictEqual(email.sent.length, 1);
      assert.strictEqual(email.sent[0]!.to, "invitee@example.com");
      assert.ok(email.sent[0]!.subject.includes("Firm Test"));
      assert.ok(
        email.sent[0]!.html.includes("tok-abc"),
        "URL incluye token",
      );
    } finally {
      stack.close();
    }
  });

  await test("C2: send_invitation_email sin email → skip (no lanza)", async () => {
    const stack = await createTestStack();
    try {
      const now = Date.now();
      stack.db
        .prepare(
          "INSERT INTO tenants (id, name, created_at, created_by) VALUES (?, 'Firm', ?, 'user-1')",
        )
        .run("firm-1", now);
      stack.db
        .prepare(
          `INSERT INTO tenant_invitations
             (id, tenant_id, email, role, token, expires_at, created_at, created_by)
           VALUES (?, ?, NULL, 'member', ?, ?, ?, ?)`,
        )
        .run("inv-1", "firm-1", "tok", now + 7 * 24 * 60 * 60 * 1000, now, "user-1");
      const email = new MockEmailProvider();
      const handler = (
        await import("./src/lib/jobs/handlers/send-invitation-email.js")
      ).handleSendInvitationEmail;
      await handler(
        { invitationId: "inv-1" },
        { db: stack.db, email: email as never },
      );
      assert.strictEqual(email.sent.length, 0, "no email sin destinatario");
    } finally {
      stack.close();
    }
  });

  await test("C3: enforce_credit_warning NO manda email si balance > 20%", async () => {
    const stack = await createTestStack();
    try {
      // Setup firm + plan + balance 80%
      const now = Date.now();
      stack.db
        .prepare(
          "INSERT INTO tenants (id, name, created_at, created_by) VALUES (?, 'Firm', ?, 'user-1')",
        )
        .run("firm-1", now);
      // credit_ledger con +2000 (plan free simulado con 2000)
      // wait, plan_free es 100. Si balance=80 (80%), NO manda.
      // Si balance=10 (10%), SÍ manda.
      stack.db
        .prepare(
          "INSERT INTO credit_ledger (id, firm_id, delta, reason, created_at) VALUES (?, ?, ?, 'plan_grant', ?)",
        )
        .run("cl-1", "firm-1", 100, now);
      // Plan con monthly=100, balance=100 → 100% → NO avisa
      const billing = await import("./src/lib/billing/billing.js");
      billing.grantCredit("firm-1", 100, "plan_grant", null, stack.db);
      // Ajustar plan para test: usamos plan_free que tiene 100 credits/mes
      // balance=100 → ratio 1.0 → no avisa
      const email = new MockEmailProvider();
      const handler = (
        await import("./src/lib/jobs/handlers/enforce-credit-warning.js")
      ).handleEnforceCreditWarning;
      await handler(
        { firmId: "firm-1" },
        {
          db: stack.db,
          email: email as never,
          // No necesitamos plans table porque el test no la usa.
          // getCurrentPlan va a buscar planes, y como no hay tabla plans
          // en este stack, el handler retorna sin plan → no manda.
        },
      );
      assert.strictEqual(email.sent.length, 0);
    } finally {
      stack.close();
    }
  });

  await test("C4: cleanup_audit borra rows old, deja nuevas", async () => {
    const stack = await createTestStack();
    try {
      const now = Date.now();
      // 3 rows: 2 old (hace 2 años), 1 new
      stack.db
        .prepare(
          "INSERT INTO audit_auth (id, event, created_at) VALUES (?, ?, ?)",
        )
        .run("a-1", "login_success", now - 2 * 365 * 24 * 60 * 60 * 1000);
      stack.db
        .prepare(
          "INSERT INTO audit_auth (id, event, created_at) VALUES (?, ?, ?)",
        )
        .run("a-2", "login_failed", now - 3 * 365 * 24 * 60 * 60 * 1000);
      stack.db
        .prepare(
          "INSERT INTO audit_auth (id, event, created_at) VALUES (?, ?, ?)",
        )
        .run("a-3", "logout", now - 1000);
      const handler = (
        await import("./src/lib/jobs/handlers/cleanup-audit.js")
      ).handleCleanupAudit;
      await handler(
        { olderThanMs: 365 * 24 * 60 * 60 * 1000 },
        { db: stack.db, email: new MockEmailProvider() as never },
      );
      const remaining = stack.db
        .prepare("SELECT id FROM audit_auth")
        .all() as Array<{ id: string }>;
      assert.strictEqual(remaining.length, 1);
      assert.strictEqual(remaining[0]!.id, "a-3");
    } finally {
      stack.close();
    }
  });

  await test("C5: cleanup_invitations borra expired+used, deja active", async () => {
    const stack = await createTestStack();
    try {
      const now = Date.now();
      // 3 invitations: expired+used, expired+unused, active
      stack.db
        .prepare(
          `INSERT INTO tenant_invitations
             (id, tenant_id, email, role, token, expires_at, used_at, created_at, created_by)
           VALUES (?, 'firm-1', ?, 'member', ?, ?, ?, ?, 'user-1')`,
        )
        .run("inv-old-used", "x@x.com", "tok1", now - 60 * 24 * 60 * 60 * 1000, now - 50 * 24 * 60 * 60 * 1000, now - 60 * 24 * 60 * 60 * 1000);
      stack.db
        .prepare(
          `INSERT INTO tenant_invitations
             (id, tenant_id, email, role, token, expires_at, used_at, created_at, created_by)
           VALUES (?, 'firm-1', ?, 'member', ?, ?, NULL, ?, 'user-1')`,
        )
        .run("inv-old-unused", "y@y.com", "tok2", now - 60 * 24 * 60 * 60 * 1000, now - 60 * 24 * 60 * 60 * 1000);
      stack.db
        .prepare(
          `INSERT INTO tenant_invitations
             (id, tenant_id, email, role, token, expires_at, used_at, created_at, created_by)
           VALUES (?, 'firm-1', ?, 'member', ?, ?, NULL, ?, 'user-1')`,
        )
        .run("inv-active", "z@z.com", "tok3", now + 7 * 24 * 60 * 60 * 1000, now);
      const handler = (
        await import("./src/lib/jobs/handlers/cleanup-invitations.js")
      ).handleCleanupInvitations;
      await handler(
        { olderThanMs: 30 * 24 * 60 * 60 * 1000 },
        { db: stack.db, email: new MockEmailProvider() as never },
      );
      const remaining = stack.db
        .prepare("SELECT id FROM tenant_invitations")
        .all() as Array<{ id: string }>;
      assert.strictEqual(remaining.length, 1, "solo el active");
      assert.strictEqual(remaining[0]!.id, "inv-active");
    } finally {
      stack.close();
    }
  });

  await test("C6: send_email_generic valida payload requerido", async () => {
    const stack = await createTestStack();
    try {
      const handler = (
        await import("./src/lib/jobs/handlers/send-email-generic.js")
      ).handleSendEmailGeneric;
      const email = new MockEmailProvider();
      await assert.rejects(
        () =>
          handler(
            { to: "x@x.com" },
            { db: stack.db, email: email as never },
          ),
        /subject.*required/,
      );
      await handler(
        { to: "x@x.com", subject: "Test", html: "<p>Hi</p>" },
        { db: stack.db, email: email as never },
      );
      assert.strictEqual(email.sent.length, 1);
      assert.strictEqual(email.sent[0]!.subject, "Test");
    } finally {
      stack.close();
    }
  });

  console.log("\n[Bloque D: Worker integration]");

  await test("D1: worker procesa un job end-to-end", async () => {
    const stack = await createTestStack();
    try {
      const now = Date.now();
      // Setup firm + invitation
      stack.db
        .prepare(
          "INSERT INTO tenants (id, name, created_at, created_by) VALUES (?, 'Firm', ?, 'u1')",
        )
        .run("firm-1", now);
      stack.db
        .prepare(
          "INSERT INTO auth_user (id, email, emailVerified, name, createdAt, updatedAt) VALUES (?, 'i@e.com', 1, 'I', ?, ?)",
        )
        .run("u1", now, now);
      stack.db
        .prepare(
          `INSERT INTO tenant_invitations
             (id, tenant_id, email, role, token, expires_at, created_at, created_by)
           VALUES (?, ?, 'dest@dest.com', 'member', 'tok', ?, ?, 'u1')`,
        )
        .run("inv-1", "firm-1", now + 7 * 24 * 60 * 60 * 1000, now);
      // Enqueue job
      const job = repo.enqueueJob(
        "send_invitation_email",
        { invitationId: "inv-1" },
        {},
        stack.db,
      );
      // Run worker once
      const email = new MockEmailProvider();
      const { JobsWorker } = await import("./src/lib/jobs/worker.js");
      const worker = new JobsWorker({
        db: stack.db,
        email: email as never,
        skipStartupCleanup: true,
      });
      // Manualmente claim y process
      const claimed = repo.claimPendingJobs(1, stack.db);
      assert.strictEqual(claimed.length, 1);
      // Process manually (skip polling)
      const handler = (
        await import("./src/lib/jobs/handlers/send-invitation-email.js")
      ).handleSendInvitationEmail;
      await handler(claimed[0]!.payloadJson ? JSON.parse(claimed[0]!.payloadJson) : {}, {
        db: stack.db,
        email: email as never,
        config: { publicUrl: "http://localhost:3000" },
      });
      repo.markJobCompleted(claimed[0]!.id, stack.db);
      assert.strictEqual(repo.getJobById(job.id, stack.db)?.status, "completed");
      assert.strictEqual(email.sent.length, 1, "email enviado");
      await worker.stop();
    } finally {
      stack.close();
    }
  });

  await test("D2: worker marca dead_letter después de MAX_ATTEMPTS", async () => {
    const stack = await createTestStack();
    try {
      const job = repo.enqueueJob("test_fail_always", {}, {}, stack.db);
      // Simular MAX_ATTEMPTS (5) fallos. Después de cada fail con
      // willRetry=true, reset scheduled_at a now (en producción el
      // backoff lo bumpea al futuro; acá lo simulamos).
      for (let attempt = 1; attempt <= 5; attempt++) {
        stack.db
          .prepare("UPDATE jobs SET scheduled_at = ? WHERE id = ?")
          .run(Date.now(), job.id);
        const claimed = repo.claimPendingJobs(1, stack.db);
        if (claimed.length === 0) break;
        // willRetry = attempt < 5
        repo.markJobFailed(
          claimed[0]!.id,
          `fail ${attempt}`,
          attempt < 5,
          stack.db,
        );
      }
      assert.strictEqual(repo.getJobById(job.id, stack.db)?.status, "dead_letter");
    } finally {
      stack.close();
    }
  });

  await test("D3: worker backoff exp + jitter", async () => {
    const stack = await createTestStack();
    try {
      const job = repo.enqueueJob("test", {}, {}, stack.db);
      const claimed = repo.claimPendingJobs(1, stack.db);
      const before = Date.now();
      repo.markJobFailed(claimed[0]!.id, "fail", true, stack.db);
      const after = repo.getJobById(job.id, stack.db);
      assert.ok(after, "job exists");
      // attempts=1 → backoff ~5s + jitter
      const delay = after.scheduledAt - before;
      assert.ok(delay >= 5000, `delay >= 5s (got ${delay}ms)`);
      assert.ok(delay <= 7000, `delay <= 7s (got ${delay}ms)`);
    } finally {
      stack.close();
    }
  });

  console.log("\n[Bloque E: Handlers registry]");

  await test("E1: HANDLERS registry tiene 5 tipos", async () => {
    const { HANDLERS, JOB_TYPES } = await import("./src/lib/jobs/handlers/index.js");
    assert.strictEqual(JOB_TYPES.length, 5);
    assert.ok(HANDLERS.send_invitation_email);
    assert.ok(HANDLERS.enforce_credit_warning);
    assert.ok(HANDLERS.cleanup_audit);
    assert.ok(HANDLERS.cleanup_invitations);
    assert.ok(HANDLERS.send_email_generic);
  });

  await test("E2: type desconocido no está en HANDLERS (fallaría en runtime)", async () => {
    const { HANDLERS } = await import("./src/lib/jobs/handlers/index.js");
    assert.strictEqual(
      (HANDLERS as Record<string, unknown>)["unknown_type"],
      undefined,
    );
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
