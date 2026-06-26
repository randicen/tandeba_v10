/**
 * Worgena — Billing v1 barrel (P0 #4).
 *
 * Source of truth: `AGENT_BILLING_V1_SPEC.md`.
 *
 * Server importa de acá. Tests importan de los archivos individuales
 * para no acoplarse al barrel.
 */

export {
  // Read
  getCreditBalance,
  getCreditHistory,
  hasActivePlan,
  getCurrentPlan,
  listActivePlans,
  getFirmSubscription,
  // Write
  ensureFreePlanGrant,
  consumeCredit,
  grantCredit,
  upsertFirmSubscription,
  cancelFirmSubscription,
  // Types
  InsufficientCreditsError,
  type Plan,
  type FirmSubscription,
  type CreditLedgerEntry,
  type FirmSubscriptionStatus,
  type CreditReason,
} from "./billing.js";

export {
  usdToCredits,
  creditsToUsd,
  CREDIT_USD_RATE,
} from "./conversion.js";

export { setDefaultDb, getDb, type DbInstance } from "./db-instance.js";

export {
  EpaycoClient,
  EpaycoError,
  type EpaycoClientOptions,
  type EpaycoTransport,
  type CreateCustomerInput,
  type EpaycoCustomer,
  type CreatePlanInput,
  type EpaycoPlan,
  type CreateSubscriptionInput,
  type EpaycoSubscription,
  type CreateChargeInput,
  type EpaycoCharge,
  type EpaycoErrorCode,
} from "./epayco-client.js";

export {
  EpaycoWebhookHandler,
  type EpaycoWebhookEvent,
  type WebhookProcessResult,
} from "./epayco-webhook.js";
