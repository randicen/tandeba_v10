/**
 * Worgena — ePayco webhook handler (P0 #4 billing v1).
 *
 * Procesa webhooks de ePayco. Tres responsabilidades:
 *
 * 1. **Verificación de firma HMAC** (P4). Si la firma no valida,
 *    NO se procesa el evento, se retorna 401.
 * 2. **Idempotencia** (P1). Cada evento se registra en `webhook_events`
 *    con UNIQUE `(provider, external_event_id)`. Re-entrega = no-op.
 * 3. **Side effects** según tipo de evento:
 *    - `subscription.approved` → INSERT/UPDATE `firm_subscriptions`
 *      con status=active, grant `monthly_credits` via `grantCredit`.
 *    - `subscription.charged` (recurrente OK) → UPDATE
 *      `current_period_end`, grant credits del nuevo periodo.
 *    - `subscription.failed` → UPDATE status=past_due.
 *    - `subscription.cancelled` → UPDATE status=cancelled.
 *    - `subscription.expired` → UPDATE status=expired.
 *    - `payment.completed` (one-time) → UPDATE `wallet_purchases`
 *      status=completed, grant credits del pack.
 *    - `payment.failed` → UPDATE `wallet_purchases` status=failed.
 *
 * Spec: `AGENT_BILLING_V1_SPEC.md` §2.O6, §4.P1, §4.P4.
 *
 * **In-process queue v1**: el handler procesa el evento en el mismo
 * turn. ePayco requiere HTTP 200 en <30s. Si el processing es lento,
 * migrar a jobs system (P0 #5). Ver D3 en spec §11.
 */

import type Database from "better-sqlite3";
import type { EpaycoClient } from "./epayco-client.js";
import {
  grantCredit,
  upsertFirmSubscription,
  type FirmSubscriptionStatus,
  type CreditReason,
} from "./billing.js";

// ============================================================
// Types
// ============================================================

/**
 * Evento de webhook parseado. El shape es aproximado — ePayco
 * evoluciona su schema. Mantenemos campos opcionales para
 * forward-compat.
 */
export interface EpaycoWebhookEvent {
  /** ID único del evento (de `x-event-id` header o del body). */
  id: string;
  /** Tipo de evento. */
  type: string;
  /** Subscription (si aplica). */
  subscription?: {
    id: string;
    customerId: string;
    planId: string;
    status: string;
    periodStart?: number;
    periodEnd?: number;
  };
  /** Customer (si aplica). */
  customer?: {
    id: string;
  };
  /** One-time payment (si aplica). */
  payment?: {
    id: string;
    customerId: string;
    amount: number;
    currency: string;
    status: string;
    reference: string;
    /** Pack ID en metadata. Worgena lo pasa en la descripción. */
    creditPackId?: string;
  };
  /** Firma HMAC del body (header `x-signature`). */
  signature: string;
}

export interface WebhookProcessResult {
  /** Status HTTP a retornar al caller. */
  status: 200 | 401;
  /** Body a retornar. */
  body: { received: boolean; eventId?: string; error?: string };
  /** Indica si el evento fue procesado (true) o no-op (false). */
  processed: boolean;
}

// ============================================================
// Handler
// ============================================================

export class EpaycoWebhookHandler {
  private readonly db: Database.Database;
  private readonly client: EpaycoClient;
  /** Plan que da el firm_id por ePayco customer_id. Lo persistimos en
   *  `firm_subscriptions.epayco_customer_id`, así que para resolver el
   *  firm_id consultamos esa tabla. */
  private readonly planIdToCreditsCop: Map<string, { credits: number; reason: CreditReason }>;

  constructor(args: {
    db: Database.Database;
    client: EpaycoClient;
    /** Map plan_id_ePayco → { credits, reason } para grants. Si el plan
     *  no está en el map, usa defaults razonables. */
    planIdToCreditsCop?: Map<string, { credits: number; reason: CreditReason }>;
  }) {
    this.db = args.db;
    this.client = args.client;
    this.planIdToCreditsCop = args.planIdToCreditsCop ?? new Map();
  }

  /**
   * Procesa un webhook. Punto de entrada principal.
   *
   * @param rawBody - body crudo (string), NO parseado. Necesario para
   *   verificar la firma HMAC.
   * @param signature - valor del header `x-signature`.
   * @param externalEventId - ID único del evento (header `x-event-id`
   *   o del body).
   */
  async process(
    rawBody: string,
    signature: string,
    externalEventId: string,
  ): Promise<WebhookProcessResult> {
    // P4: verifica firma ANTES de cualquier side-effect.
    if (!this.client.verifyWebhookSignature(rawBody, signature)) {
      return {
        status: 401,
        body: { received: false, error: "Invalid signature" },
        processed: false,
      };
    }

    // P1: idempotencia. INSERT OR IGNORE en webhook_events.
    // Si ya existe, no reprocesamos.
    const now = Date.now();
    const eventRow = db_insertWebhookEvent(this.db, {
      id: `evt-${crypto.randomUUID()}`,
      provider: "epayco",
      externalEventId,
      eventType: "(pending parse)",
      payloadJson: rawBody,
      status: "received",
      receivedAt: now,
    });
    if (!eventRow) {
      // Ya procesado. Return 200, no-op.
      return {
        status: 200,
        body: { received: true, eventId: externalEventId },
        processed: false,
      };
    }

    // Parsear el body
    let event: EpaycoWebhookEvent;
    try {
      const parsed = JSON.parse(rawBody) as Record<string, unknown>;
      event = {
        id: externalEventId,
        type: (parsed.type as string) ?? (parsed.event as string) ?? "unknown",
        subscription: parsed.subscription as EpaycoWebhookEvent["subscription"],
        customer: parsed.customer as EpaycoWebhookEvent["customer"],
        payment: parsed.payment as EpaycoWebhookEvent["payment"],
        signature,
      };
    } catch {
      this.markFailed(eventRow, "Invalid JSON body");
      return {
        status: 200,
        body: { received: true, eventId: externalEventId },
        processed: false,
      };
    }

    // Update event type
    this.db
      .prepare("UPDATE webhook_events SET event_type = ? WHERE id = ?")
      .run(event.type, eventRow.id);

    // Switch por tipo
    try {
      switch (event.type) {
        case "subscription.approved":
        case "subscription.created":
          await this.handleSubscriptionApproved(event);
          break;
        case "subscription.charged":
        case "subscription.payment_succeeded":
          await this.handleSubscriptionCharged(event);
          break;
        case "subscription.failed":
        case "subscription.payment_failed":
          await this.handleSubscriptionFailed(event);
          break;
        case "subscription.cancelled":
        case "subscription.canceled":
          await this.handleSubscriptionCancelled(event);
          break;
        case "subscription.expired":
          await this.handleSubscriptionExpired(event);
          break;
        case "payment.completed":
        case "payment.succeeded":
          await this.handlePaymentCompleted(event);
          break;
        case "payment.failed":
          await this.handlePaymentFailed(event);
          break;
        default:
          // Unknown event type. Mark processed pero no side-effect.
          // Log para que ops lo investigue.
          console.warn(`[epayco-webhook] unknown event type: ${event.type}`);
      }
      this.markProcessed(eventRow);
      return {
        status: 200,
        body: { received: true, eventId: externalEventId },
        processed: true,
      };
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.markFailed(eventRow, errMsg);
      console.error(`[epayco-webhook] error processing ${event.type}:`, errMsg);
      // 200 con error: ePayco ya tiene el evento. Si tiramos 5xx, ePayco
      // re-manda. Si devolvemos 200, no re-manda. Por ahora 200 con
      // processed=false para no perder visibilidad pero cortar el ciclo.
      return {
        status: 200,
        body: { received: true, eventId: externalEventId, error: errMsg },
        processed: false,
      };
    }
  }

  // ─── Event handlers ─────────────────────────────────

  private async handleSubscriptionApproved(event: EpaycoWebhookEvent): Promise<void> {
    if (!event.subscription) {
      throw new Error("subscription.approved: missing subscription");
    }
    const sub = event.subscription;
    // Resolver firm_id por epayco_customer_id
    const firmId = this.findFirmIdByEpaycoCustomer(sub.customerId);
    if (!firmId) {
      throw new Error(
        `subscription.approved: no firm found for epayco_customer_id=${sub.customerId}`,
      );
    }
    // Upsert subscription
    upsertFirmSubscription(
      firmId,
      sub.planId, // ePayco plan_id — guardamos como string, mapeamos a nuestro plan via planIdToCredits
      this.normalizeStatus(sub.status),
      sub.customerId,
      sub.id,
      sub.periodStart ?? Date.now(),
      sub.periodEnd ?? Date.now() + 30 * 24 * 60 * 60 * 1000,
      this.db,
    );
    // Grant credits si hay un plan conocido
    this.grantForPlan(firmId, sub.planId, sub.id);
  }

  private async handleSubscriptionCharged(event: EpaycoWebhookEvent): Promise<void> {
    // Recurrente: ePayco cobró con éxito. Update period + grant credits del nuevo periodo.
    if (!event.subscription) {
      throw new Error("subscription.charged: missing subscription");
    }
    const sub = event.subscription;
    const firmId = this.findFirmIdByEpaycoCustomer(sub.customerId);
    if (!firmId) {
      throw new Error(
        `subscription.charged: no firm for customer=${sub.customerId}`,
      );
    }
    upsertFirmSubscription(
      firmId,
      sub.planId,
      "active",
      sub.customerId,
      sub.id,
      sub.periodStart ?? Date.now(),
      sub.periodEnd ?? Date.now() + 30 * 24 * 60 * 60 * 1000,
      this.db,
    );
    this.grantForPlan(firmId, sub.planId, sub.id);
  }

  private async handleSubscriptionFailed(event: EpaycoWebhookEvent): Promise<void> {
    if (!event.subscription) return;
    const firmId = this.findFirmIdByEpaycoCustomer(event.subscription.customerId);
    if (!firmId) return;
    upsertFirmSubscription(
      firmId,
      event.subscription.planId,
      "past_due",
      event.subscription.customerId,
      event.subscription.id,
      event.subscription.periodStart ?? null,
      event.subscription.periodEnd ?? null,
      this.db,
    );
  }

  private async handleSubscriptionCancelled(event: EpaycoWebhookEvent): Promise<void> {
    if (!event.subscription) return;
    const firmId = this.findFirmIdByEpaycoCustomer(event.subscription.customerId);
    if (!firmId) return;
    upsertFirmSubscription(
      firmId,
      event.subscription.planId,
      "cancelled",
      event.subscription.customerId,
      event.subscription.id,
      event.subscription.periodStart ?? null,
      event.subscription.periodEnd ?? null,
      this.db,
    );
  }

  private async handleSubscriptionExpired(event: EpaycoWebhookEvent): Promise<void> {
    if (!event.subscription) return;
    const firmId = this.findFirmIdByEpaycoCustomer(event.subscription.customerId);
    if (!firmId) return;
    upsertFirmSubscription(
      firmId,
      event.subscription.planId,
      "expired",
      event.subscription.customerId,
      event.subscription.id,
      event.subscription.periodStart ?? null,
      event.subscription.periodEnd ?? null,
      this.db,
    );
  }

  private async handlePaymentCompleted(event: EpaycoWebhookEvent): Promise<void> {
    // One-time wallet purchase. Update wallet_purchases status + grant credits.
    if (!event.payment) return;
    const p = event.payment;
    // Resolver firm_id por epayco customer_id
    const firmId = this.findFirmIdByEpaycoCustomer(p.customerId);
    if (!firmId) {
      throw new Error(
        `payment.completed: no firm for customer=${p.customerId}`,
      );
    }
    // Find the wallet_purchase by epayco_charge_id
    const wp = this.db
      .prepare("SELECT id, credit_pack_id, credits_granted, status FROM wallet_purchases WHERE epayco_charge_id = ?")
      .get(p.id) as
      | { id: string; credit_pack_id: string; credits_granted: number; status: string }
      | undefined;
    if (!wp) {
      throw new Error(
        `payment.completed: no wallet_purchase for charge_id=${p.id}`,
      );
    }
    if (wp.status === "completed") {
      // Already processed
      return;
    }
    this.db
      .prepare(
        "UPDATE wallet_purchases SET status = 'completed', completed_at = ? WHERE id = ?",
      )
      .run(Date.now(), wp.id);
    grantCredit(
      firmId,
      wp.credits_granted,
      "wallet_purchase",
      { walletPurchaseId: wp.id, creditPackId: wp.credit_pack_id, epaycoChargeId: p.id },
      this.db,
    );
  }

  private async handlePaymentFailed(event: EpaycoWebhookEvent): Promise<void> {
    if (!event.payment) return;
    const p = event.payment;
    this.db
      .prepare(
        "UPDATE wallet_purchases SET status = 'failed', failure_reason = ? WHERE epayco_charge_id = ? AND status = 'pending'",
      )
      .run(`payment_failed: ${p.status}`, p.id);
  }

  // ─── Helpers ─────────────────────────────────────────

  private findFirmIdByEpaycoCustomer(epaycoCustomerId: string): string | null {
    const row = this.db
      .prepare(
        "SELECT firm_id FROM firm_subscriptions WHERE epayco_customer_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(epaycoCustomerId) as { firm_id: string } | undefined;
    return row?.firm_id ?? null;
  }

  private grantForPlan(firmId: string, planId: string, subId: string): void {
    const cfg = this.planIdToCreditsCop.get(planId);
    if (!cfg) {
      // Plan desconocido. Log pero no throw (forward-compat con planes
      // custom que no estén en el map).
      console.warn(`[epayco-webhook] unknown planId ${planId}, no credits granted`);
      return;
    }
    grantCredit(
      firmId,
      cfg.credits,
      cfg.reason,
      { planId, epaycoSubscriptionId: subId, source: "epayco_webhook" },
      this.db,
    );
  }

  private normalizeStatus(s: string): FirmSubscriptionStatus {
    switch (s) {
      case "active":
        return "active";
      case "past_due":
      case "past-due":
      case "pastDue":
        return "past_due";
      case "cancelled":
      case "canceled":
        return "cancelled";
      case "expired":
        return "expired";
      default:
        return "pending";
    }
  }

  private markProcessed(eventRow: { id: string }): void {
    this.db
      .prepare(
        "UPDATE webhook_events SET status = 'processed', processed_at = ? WHERE id = ?",
      )
      .run(Date.now(), eventRow.id);
  }

  private markFailed(eventRow: { id: string }, errMsg: string): void {
    this.db
      .prepare(
        "UPDATE webhook_events SET status = 'failed', error_message = ? WHERE id = ?",
      )
      .run(errMsg, eventRow.id);
  }
}

// ============================================================
// Internal: idempotent insert helper
// ============================================================

function db_insertWebhookEvent(
  db: Database.Database,
  args: {
    id: string;
    provider: string;
    externalEventId: string;
    eventType: string;
    payloadJson: string;
    status: "received" | "processed" | "failed";
    receivedAt: number;
  },
): { id: string; status: string } | null {
  // INSERT OR IGNORE: si (provider, external_event_id) ya existe, no
  // hace nada. `changes` retorna 0 en ese caso.
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO webhook_events
         (id, provider, external_event_id, event_type, payload_json, status, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.id, args.provider, args.externalEventId, args.eventType,
      args.payloadJson, args.status, args.receivedAt,
    );
  if (result.changes === 0) {
    // Ya existe. Return null para que el caller haga no-op.
    return null;
  }
  return { id: args.id, status: args.status };
}
