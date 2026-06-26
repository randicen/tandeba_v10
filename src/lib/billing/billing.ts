/**
 * Worgena — Servicio de billing local (P0 #4 billing v1).
 *
 * Lógica de negocio para planes, créditos, y suscripciones. NO
 * expone endpoints (esos viven en `server.ts`). NO llama a ePayco
 * directamente (eso es `epayco-client.ts`). Esta capa es:
 *
 * 1. Source of truth del balance vía `credit_ledger` (append-only).
 * 2. Enforcement de planes: `hasActivePlan`, `getCurrentPlan`.
 * 3. Mutaciones atómicas: `consumeCredit`, `grantCredit`.
 *
 * Spec: `AGENT_BILLING_V1_SPEC.md` §2.O2, §4.P2, §4.P3, §4.P7, §4.P8.
 *
 * Patrón de DB opcional: cada función acepta `dbInstance?` opcional.
 * Default = el DB global (`./db.js`). Tests pueden pasar `:memory:`.
 * Razón: forward-compat con tests aislados y migración futura a
 * per-tenant DB en Postgres.
 */

import type Database from "better-sqlite3";
import { getDb, type DbInstance } from "./db-instance.js";

// ============================================================
// Types
// ============================================================

export type FirmSubscriptionStatus =
  | "pending"
  | "active"
  | "past_due"
  | "cancelled"
  | "expired";

export type CreditReason =
  | "plan_grant"
  | "wallet_purchase"
  | "auto_recharge"
  | "llm_call"
  | "refund"
  | "manual_adjustment"
  | "expiry";

export interface Plan {
  id: string;
  name: string;
  monthlyCredits: number;
  maxUsersPerFirm: number;
  monthlyPriceCop: number;
  currency: string;
  featuresJson: string | null;
  isActive: number;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface FirmSubscription {
  id: string;
  firmId: string;
  planId: string;
  status: FirmSubscriptionStatus;
  epaycoCustomerId: string | null;
  epaycoSubscriptionId: string | null;
  currentPeriodStart: number | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: number;
  cancelledAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreditLedgerEntry {
  id: string;
  firmId: string;
  delta: number;
  reason: CreditReason;
  metadataJson: string | null;
  createdAt: number;
}

/**
 * Custom error para insuficiencia de créditos. El LLM invoker lo
 * mapea a `OpenRouterError` con `code: "INSUFFICIENT_CREDITS"`.
 */
export class InsufficientCreditsError extends Error {
  readonly code = "INSUFFICIENT_CREDITS";
  readonly retriable = false;
  readonly firmId: string;
  readonly balanceCredits: number;
  readonly requiredCredits: number;

  constructor(
    firmId: string,
    balanceCredits: number,
    requiredCredits: number,
    reason: string = "Insufficient credits",
  ) {
    super(
      `${reason}: firm=${firmId} balance=${balanceCredits} required=${requiredCredits}. ` +
        `Buy credits at /api/billing/wallet or upgrade plan at /api/billing/me.`,
    );
    this.name = "InsufficientCreditsError";
    this.firmId = firmId;
    this.balanceCredits = balanceCredits;
    this.requiredCredits = requiredCredits;
  }
}

// ============================================================
// Helpers privados
// ============================================================

/**
 * Resuelve la DB instance: explícita si se pasa, sino default global.
 */
function resolveDb(dbInstance?: DbInstance): Database.Database {
  return dbInstance ?? getDb();
}

/**
 * Genera un ID único. crypto.randomUUID() si está disponible.
 */
function newId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function rowToPlan(row: Record<string, unknown>): Plan {
  return {
    id: row.id as string,
    name: row.name as string,
    monthlyCredits: row.monthly_credits as number,
    maxUsersPerFirm: row.max_users_per_firm as number,
    monthlyPriceCop: row.monthly_price_cop as number,
    currency: (row.currency as string) ?? "COP",
    featuresJson: (row.features_json as string | null) ?? null,
    isActive: row.is_active as number,
    sortOrder: row.sort_order as number,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function rowToFirmSub(row: Record<string, unknown>): FirmSubscription {
  return {
    id: row.id as string,
    firmId: row.firm_id as string,
    planId: row.plan_id as string,
    status: row.status as FirmSubscriptionStatus,
    epaycoCustomerId: (row.epayco_customer_id as string | null) ?? null,
    epaycoSubscriptionId:
      (row.epayco_subscription_id as string | null) ?? null,
    currentPeriodStart:
      (row.current_period_start as number | null) ?? null,
    currentPeriodEnd: (row.current_period_end as number | null) ?? null,
    cancelAtPeriodEnd: row.cancel_at_period_end as number,
    cancelledAt: (row.cancelled_at as number | null) ?? null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

// ============================================================
// Read operations (no mutan estado)
// ============================================================

/**
 * Lee el balance de créditos de un firm. Source of truth = `credit_ledger`.
 * Si no tiene rows, retorna 0.
 *
 * **Importante**: NO incluye el `plan_grant` implícito del plan free.
 * Eso se grant explícitamente vía `ensureFreePlanGrant()` (idempotente).
 * Esta función es un READ puro.
 */
export function getCreditBalance(
  firmId: string,
  dbInstance?: DbInstance,
): number {
  const db = resolveDb(dbInstance);
  const row = db
    .prepare("SELECT COALESCE(SUM(delta), 0) AS balance FROM credit_ledger WHERE firm_id = ?")
    .get(firmId) as { balance: number } | undefined;
  return row?.balance ?? 0;
}

/**
 * Lee el historial de movimientos de un firm (último N, descending).
 */
export function getCreditHistory(
  firmId: string,
  limit: number = 50,
  dbInstance?: DbInstance,
): CreditLedgerEntry[] {
  const db = resolveDb(dbInstance);
  // ORDER BY rowid DESC: `rowid` es la columna implícita de SQLite,
  // monotónicamente creciente en el orden de INSERT. Usamos rowid en
  // vez de `id` (UUID) porque da un orden cronológico determinístico
  // incluso cuando `created_at` tiene el mismo valor (mismo ms).
  // Forward-compat a Postgres: agregar columna `BIGSERIAL seq` o usar
  // `ctid` (no-portable) → migrar a `created_at` con clock de mayor
  // resolución (`hrtime`).
  const rows = db
    .prepare(
      "SELECT id, firm_id, delta, reason, metadata_json, created_at FROM credit_ledger WHERE firm_id = ? ORDER BY rowid DESC LIMIT ?",
    )
    .all(firmId, limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    firmId: r.firm_id as string,
    delta: r.delta as number,
    reason: r.reason as CreditReason,
    metadataJson: (r.metadata_json as string | null) ?? null,
    createdAt: r.created_at as number,
  }));
}

/**
 * Verifica si un firm tiene plan activo. Side effect: si el firm no
 * tiene subscription, otorga el grant implícito de plan_free
 * (idempotente via `ensureFreePlanGrant`). Razón: queremos que un
 * firm nuevo tenga créditos desde el primer check, sin requerir
 * un "bootstrapping" explícito.
 *
 * Reglas:
 * - Si el firm tiene `firm_subscriptions.status='active'` Y
 *   `current_period_end > now` → true.
 * - Si el firm tiene subscription pero está past_due/cancelled/expired
 *   → false (treat como sin plan, LLM bloqueado).
 * - Si el firm NO tiene subscription → true (assume plan_free implícito,
 *   con grant automático).
 *
 * Forward-compat: el `plan_free` siempre está disponible (seed al
 * initDB), así que un firm sin subscription siempre tiene al menos
 * plan_free.
 */
export function hasActivePlan(
  firmId: string,
  dbInstance?: DbInstance,
): boolean {
  const db = resolveDb(dbInstance);
  const row = db
    .prepare(
      "SELECT status, current_period_end FROM firm_subscriptions WHERE firm_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(firmId) as
    | { status: FirmSubscriptionStatus; current_period_end: number | null }
    | undefined;
  if (!row) {
    // Plan free implícito. Grant idempotente.
    ensureFreePlanGrant(firmId, dbInstance);
    return true;
  }
  if (row.status !== "active") return false;
  if (row.current_period_end !== null && row.current_period_end < Date.now()) {
    return false; // periodo terminado
  }
  return true;
}

/**
 * Lee el plan actual del firm. Si no tiene subscription, retorna el
 * plan_free (id 'plan_free'). Si tiene subscription activa, retorna
 * el plan asociado. Si la subscription está past_due/cancelled, retorna
 * null (caller decide qué hacer — usualmente bloquear LLM).
 */
export function getCurrentPlan(
  firmId: string,
  dbInstance?: DbInstance,
): Plan | null {
  const db = resolveDb(dbInstance);
  const sub = db
    .prepare(
      "SELECT plan_id, status, current_period_end FROM firm_subscriptions WHERE firm_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(firmId) as
    | { plan_id: string; status: FirmSubscriptionStatus; current_period_end: number | null }
    | undefined;

  if (sub) {
    if (sub.status === "active" && (sub.current_period_end === null || sub.current_period_end > Date.now())) {
      const planRow = db
        .prepare("SELECT * FROM plans WHERE id = ?")
        .get(sub.plan_id) as Record<string, unknown> | undefined;
      return planRow ? rowToPlan(planRow) : null;
    }
    // subscription no activa
    return null;
  }

  // sin subscription: plan_free implícito
  const freeRow = db
    .prepare("SELECT * FROM plans WHERE id = ?")
    .get("plan_free") as Record<string, unknown> | undefined;
  return freeRow ? rowToPlan(freeRow) : null;
}

/**
 * Lee todos los planes activos (catálogo público).
 */
export function listActivePlans(dbInstance?: DbInstance): Plan[] {
  const db = resolveDb(dbInstance);
  const rows = db
    .prepare(
      "SELECT * FROM plans WHERE is_active = 1 ORDER BY sort_order ASC, monthly_price_cop ASC",
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map(rowToPlan);
}

/**
 * Lee la subscription actual del firm (raw row, no derivado).
 * Retorna null si no hay.
 */
export function getFirmSubscription(
  firmId: string,
  dbInstance?: DbInstance,
): FirmSubscription | null {
  const db = resolveDb(dbInstance);
  const row = db
    .prepare("SELECT * FROM firm_subscriptions WHERE firm_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(firmId) as Record<string, unknown> | undefined;
  return row ? rowToFirmSub(row) : null;
}

// ============================================================
// Write operations (mutan estado, atómicas, append-only ledger)
// ============================================================

/**
 * Asegura que un firm tenga al menos el grant inicial de plan_free.
 * Idempotente: si ya tiene cualquier grant `reason='plan_grant'` con
 * `metadata.planId='plan_free'`, no hace nada.
 *
 * Se llama desde `getCurrentPlan` o desde el LLM invoker antes de
 * la primera llamada.
 */
export function ensureFreePlanGrant(
  firmId: string,
  dbInstance?: DbInstance,
): void {
  const db = resolveDb(dbInstance);
  const now = Date.now();
  // Check si ya tiene grant de plan_free
  const existing = db
    .prepare(
      "SELECT 1 FROM credit_ledger WHERE firm_id = ? AND reason = 'plan_grant' AND metadata_json LIKE '%plan_free%' LIMIT 1",
    )
    .get(firmId);
  if (existing) return;

  const plan = getCurrentPlan(firmId, dbInstance);
  if (!plan) return;

  const insert = db.prepare(`
    INSERT INTO credit_ledger (id, firm_id, delta, reason, metadata_json, created_at)
    VALUES (?, ?, ?, 'plan_grant', ?, ?)
  `);
  insert.run(
    newId("cl"),
    firmId,
    plan.monthlyCredits,
    JSON.stringify({ planId: plan.id, source: "ensure_free_plan_grant" }),
    now,
  );
}

/**
 * Consume créditos de un firm. Atómico via transacción.
 *
 * @param firmId - firm que consume
 * @param amountCredits - cantidad a consumir (positivo). Negativo se ignora.
 * @param reason - por qué se consume (típicamente 'llm_call')
 * @param metadata - opcional, JSON-serializable
 * @throws InsufficientCreditsError si el balance no alcanza
 *
 * **Idempotencia**: NO es idempotente por diseño. Cada llamada consume
 * créditos. Para reintentos usar el patrón de "task ledger" del motor
 * (ya tiene idempotency-key en nodos D2a.4).
 *
 * **Caller responsibility**: el caller debe garantizar que el firm
 * tiene plan activo ANTES de llamar. Para el flujo de LLM, eso lo
 * hace `OpenRouterLLMInvoker` llamando `hasActivePlan` antes (que
 * además otorga el grant implícito de plan_free si corresponde).
 */
export function consumeCredit(
  firmId: string,
  amountCredits: number,
  reason: CreditReason = "llm_call",
  metadata: Record<string, unknown> | null = null,
  dbInstance?: DbInstance,
): void {
  if (amountCredits <= 0) return;
  const db = resolveDb(dbInstance);

  const txn = db.transaction(() => {
    const current = (
      db
        .prepare(
          "SELECT COALESCE(SUM(delta), 0) AS balance FROM credit_ledger WHERE firm_id = ?",
        )
        .get(firmId) as { balance: number }
    ).balance;

    if (current < amountCredits) {
      throw new InsufficientCreditsError(
        firmId,
        current,
        amountCredits,
        `consumeCredit: balance insuficiente para ${reason}`,
      );
    }

    const insert = db.prepare(`
      INSERT INTO credit_ledger (id, firm_id, delta, reason, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      newId("cl"),
      firmId,
      -amountCredits,
      reason,
      metadata === null ? null : JSON.stringify(metadata),
      Date.now(),
    );
  });
  txn();

  // P0 #5 jobs: encolar warning si el balance cayó por debajo del
  // 20% del plan. Idempotente via `idempotencyKey` por día: no
  // spameamos al admin con un email por cada LLM call. Si el sistema
  // de jobs no está disponible (e.g. test aislado), swallow.
  try {
    const plan = getCurrentPlan(firmId, db);
    if (plan && plan.monthlyCredits > 0) {
      const balance = getCreditBalance(firmId, db);
      const ratio = balance / plan.monthlyCredits;
      if (ratio < 0.2) {
        // Dynamic import para evitar circular deps
        import("../jobs/repository.js").then(({ enqueueJob }) => {
          const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
          enqueueJob(
            "enforce_credit_warning",
            { firmId, thresholdFraction: 0.2 },
            {
              idempotencyKey: `credit-warning-${firmId}-${today}`,
            },
            db,
          );
        }).catch((e) => {
          console.warn(
            `[consumeCredit] failed to enqueue credit warning for firm=${firmId}: ${(e as Error).message}`,
          );
        });
      }
    }
  } catch (e) {
    // swallow — el credit consumption ya se hizo, no fallar el flow
    // principal.
    console.warn(
      `[consumeCredit] failed to check credit warning threshold: ${(e as Error).message}`,
    );
  }
}

/**
 * Otorga créditos a un firm. Atómico, append-only.
 *
 * Usado por: webhook de ePayco (plan_grant al activar subscripción,
 * wallet_purchase al cobrar pack), admin manual (manual_adjustment).
 */
export function grantCredit(
  firmId: string,
  amountCredits: number,
  reason: CreditReason = "manual_adjustment",
  metadata: Record<string, unknown> | null = null,
  dbInstance?: DbInstance,
): void {
  if (amountCredits <= 0) return;
  const db = resolveDb(dbInstance);
  const insert = db.prepare(`
    INSERT INTO credit_ledger (id, firm_id, delta, reason, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insert.run(
    newId("cl"),
    firmId,
    amountCredits,
    reason,
    metadata === null ? null : JSON.stringify(metadata),
    Date.now(),
  );
}

/**
 * Crea o reemplaza la subscription de un firm. Usado por:
 * - `POST /api/billing/subscribe` (después de confirmar con ePayco).
 * - `epayco-webhook` cuando llega `subscription.approved` o `subscription.charged`.
 *
 * Reglas: un firm tiene máximo 1 subscription activa. Si ya tiene una
 * activa, se reemplaza (atomic UPDATE o INSERT).
 */
export function upsertFirmSubscription(
  firmId: string,
  planId: string,
  status: FirmSubscriptionStatus,
  epaycoCustomerId: string | null,
  epaycoSubscriptionId: string | null,
  currentPeriodStart: number | null,
  currentPeriodEnd: number | null,
  dbInstance?: DbInstance,
): FirmSubscription {
  const db = resolveDb(dbInstance);
  const now = Date.now();
  const existing = getFirmSubscription(firmId, dbInstance);
  if (existing) {
    db.prepare(
      `UPDATE firm_subscriptions
       SET plan_id = ?, status = ?, epayco_customer_id = ?, epayco_subscription_id = ?,
           current_period_start = ?, current_period_end = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      planId, status, epaycoCustomerId, epaycoSubscriptionId,
      currentPeriodStart, currentPeriodEnd, now, existing.id,
    );
    const updated = getFirmSubscription(firmId, dbInstance);
    if (!updated) throw new Error("upsertFirmSubscription: row missing post-update");
    return updated;
  } else {
    const id = newId("fs");
    db.prepare(
      `INSERT INTO firm_subscriptions
         (id, firm_id, plan_id, status, epayco_customer_id, epayco_subscription_id,
          current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      id, firmId, planId, status, epaycoCustomerId, epaycoSubscriptionId,
      currentPeriodStart, currentPeriodEnd, now, now,
    );
    const inserted = getFirmSubscription(firmId, dbInstance);
    if (!inserted) throw new Error("upsertFirmSubscription: row missing post-insert");
    return inserted;
  }
}

/**
 * Marca una subscription como cancelada (al final del periodo).
 * NO consume créditos — el cliente sigue usando hasta `current_period_end`.
 */
export function cancelFirmSubscription(
  firmId: string,
  dbInstance?: DbInstance,
): FirmSubscription {
  const db = resolveDb(dbInstance);
  const now = Date.now();
  const sub = getFirmSubscription(firmId, dbInstance);
  if (!sub) throw new Error(`cancelFirmSubscription: no subscription for firm=${firmId}`);
  db.prepare(
    `UPDATE firm_subscriptions
     SET cancel_at_period_end = 1, cancelled_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(now, now, sub.id);
  const updated = getFirmSubscription(firmId, dbInstance);
  if (!updated) throw new Error("cancelFirmSubscription: row missing post-update");
  return updated;
}
