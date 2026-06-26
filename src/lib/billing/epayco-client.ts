/**
 * Worgena — ePayco API client (P0 #4 billing v2 — refactor con SDK oficial).
 *
 * **Versión 2 (2026-06-25)**: Refactor para usar el SDK oficial
 * `epayco-sdk-node` v1.4.4. El custom fetch directo de la v1 matcheaba
 * los endpoints legacy `/v1/...` pero no la doc oficial actualizada
 * (Smart Checkout v2 con sesiones + JWT). Decisión: usar el SDK
 * oficial. Razones:
 *
 * 1. **Match con doc oficial**: el SDK usa los mismos endpoints que
 *    recomienda la doc oficial. Si ePayco actualiza la doc, ePayco
 *    actualiza el SDK. No rompemos nosotros.
 * 2. **Mantenimiento**: el vendor mantiene el SDK. No es código nuestro.
 * 3. **Forward-compat**: cuando salga v2 del SDK con Smart Checkout v2
 *    completo, swappear.
 *
 * **Lo que sigue siendo custom** (no en el SDK):
 * - `verifyWebhookSignature` (HMAC-SHA256 con privateKey): ePayco no
 *   expone esto en el SDK. Lo mantenemos.
 * - `EpaycoError` tipado con códigos del motor: re-export del SDK
 *   + mapping.
 *
 * **Limitaciones conocidas** (vs Smart Checkout v2 que recomienda la
 * doc oficial 2026-06-01): el SDK v1.4.4 todavía NO implementa
 * Smart Checkout v2 (sesiones con JWT). Usa el patrón legacy de
 * REST directo con Bearer. Funciona, pero es la "vieja forma".
 * Si ePayco deprecara la API legacy, swappear al SDK v2 (o Smart
 * Checkout custom).
 *
 * Spec: AGENT_BILLING_V1_SPEC.md §2.O3.
 */

import { createRequire } from "node:module";

// SDK es CommonJS; usamos createRequire para importarlo desde ESM.
const requireCJS = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const EpaycoSDK = requireCJS("epayco-sdk-node");

// ============================================================
// Types (exportados para compatibilidad con código existente)
// ============================================================

export type EpaycoTransport = unknown; // No se usa más, kept for API compat.

export interface EpaycoClientOptions {
  /** Public key (cliente). Seguro de exponer en frontend si fuera necesario. */
  publicKey: string;
  /** Private key (confidencial). NUNCA exponer. */
  privateKey: string;
  /** true = sandbox. false = production. */
  testMode: boolean;
}

export interface CreateCustomerInput {
  email: string;
  name: string;
  phone?: string;
  defaultCard?: boolean;
}

export interface EpaycoCustomer {
  id: string;
  email: string;
  name: string;
  createdAt: number;
}

export interface CreatePlanInput {
  id: string;
  name: string;
  amount: number;
  currency: "COP" | "USD";
  interval: "month" | "year";
  intervalCount: number;
  urlConfirmation: string;
  urlResponse: string;
}

export interface EpaycoPlan {
  id: string;
  name: string;
  amount: number;
  currency: string;
  interval: string;
}

export interface CreateSubscriptionInput {
  customerId: string;
  planId: string;
  paymentMethodToken: string;
  urlConfirmation?: string;
}

export interface EpaycoSubscription {
  id: string;
  customerId: string;
  planId: string;
  status: "pending" | "active" | "past_due" | "cancelled" | "expired";
  checkoutUrl?: string;
  currentPeriodStart: number;
  currentPeriodEnd: number;
  createdAt: number;
}

export interface CreateChargeInput {
  customerId: string;
  paymentMethodToken: string;
  amount: number;
  currency: "COP" | "USD";
  description: string;
  reference: string;
  urlConfirmation?: string;
  urlResponse?: string;
}

export interface EpaycoCharge {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "completed" | "failed" | "refunded";
  reference: string;
  checkoutUrl?: string;
  createdAt: number;
}

// ============================================================
// Error
// ============================================================

/**
 * Códigos de error de ePayco SDK + extras de Worgena.
 * El SDK tiene su propia jerarquía de errores; los mapeamos a
 * los códigos del motor para que el LLM invoker los entienda.
 */
export type EpaycoErrorCode =
  | "EPAYCO_BAD_REQUEST"
  | "EPAYCO_UNAUTHORIZED"
  | "EPAYCO_NOT_FOUND"
  | "EPAYCO_CONFLICT"
  | "EPAYCO_RATE_LIMIT"
  | "EPAYCO_PROVIDER_ERROR"
  | "EPAYCO_NETWORK_ERROR"
  | "EPAYCO_INVALID_RESPONSE"
  | "EPAYCO_BAD_SIGNATURE";

export class EpaycoError extends Error {
  readonly code: EpaycoErrorCode;
  readonly httpStatus: number;
  readonly retriable: boolean;

  constructor(args: {
    message: string;
    code: EpaycoErrorCode;
    httpStatus: number;
    retriable: boolean;
  }) {
    super(args.message);
    this.name = "EpaycoError";
    this.code = args.code;
    this.httpStatus = args.httpStatus;
    this.retriable = args.retriable;
  }
}

// ============================================================
// Client (wrapper sobre el SDK oficial)
// ============================================================

/**
 * Wrapper del SDK oficial `epayco-sdk-node` v1.4.4. Mantiene la
 * misma API pública que la v1 (custom fetch) para que `server.ts`
 * y `epayco-webhook.ts` no cambien.
 *
 * **Tests mockean esta clase** (no el SDK). En runtime, el SDK
 * hace fetch internamente. Si necesitamos mockear el SDK en tests,
 * swappear con un constructor de mock.
 */
export class EpaycoClient {
  private readonly publicKey: string;
  private readonly privateKey: string;
  private readonly testMode: boolean;
  /**
   * SDK instance (lazy: solo se crea al primer uso, para no
   * bloquear tests que mockean el cliente).
   */
  private readonly sdk: {
    customers: {
      create: (opts: Record<string, unknown>) => Promise<unknown>;
      get: (uid: string) => Promise<unknown>;
      getList: (id: string) => Promise<unknown>;
    };
    plans: {
      create: (opts: Record<string, unknown>) => Promise<unknown>;
    };
    subscriptions: {
      create: (opts: Record<string, unknown>) => Promise<unknown>;
      get: (uid: string) => Promise<unknown>;
      cancel: (uid: string) => Promise<unknown>;
    };
    charge: {
      create: (opts: Record<string, unknown>) => Promise<unknown>;
    };
  };

  constructor(options: EpaycoClientOptions) {
    if (!options.publicKey) {
      throw new Error("EpaycoClient: publicKey is required");
    }
    if (!options.privateKey) {
      throw new Error("EpaycoClient: privateKey is required");
    }
    this.publicKey = options.publicKey;
    this.privateKey = options.privateKey;
    this.testMode = options.testMode;

    // Init SDK. El SDK requiere apiKey, privateKey, test (boolean).
    // Forward-compat: el SDK también acepta `lang: 'ES'` (default).
    const sdkInstance = new EpaycoSDK({
      apiKey: options.publicKey,
      privateKey: options.privateKey,
      test: options.testMode,
      lang: "ES",
    });
    // El SDK expone: customers, plans, subscriptions, charge, etc.
    // Cada uno tiene métodos create/get/list/cancel.
    this.sdk = sdkInstance as typeof this.sdk;
  }

  // ─── Customers ──────────────────────────────────────────

  async createCustomer(input: CreateCustomerInput): Promise<EpaycoCustomer> {
    type Resp = { data?: { customerId?: string; email?: string; name?: string; createdAt?: string | number } };
    const resp = (await this.sdk.customers.create({
      ...input,
      ...(input.phone ? { phone: input.phone } : {}),
    } as Record<string, unknown>)) as Resp;
    if (!resp.data?.customerId) {
      throw new EpaycoError({
        message: "EpaycoClient.createCustomer: missing data in response",
        code: "EPAYCO_INVALID_RESPONSE",
        httpStatus: 200,
        retriable: false,
      });
    }
    return {
      id: resp.data.customerId,
      email: resp.data.email ?? input.email,
      name: resp.data.name ?? input.name,
      createdAt: typeof resp.data.createdAt === "number"
        ? resp.data.createdAt
        : Date.now(),
    };
  }

  async getCustomerByEmail(email: string): Promise<EpaycoCustomer | null> {
    // SDK: customers.getList(email) retorna lista filtrada.
    type Resp = { data?: Array<{ customerId?: string; email?: string; name?: string; createdAt?: string | number }> };
    try {
      const resp = (await this.sdk.customers.getList(email)) as Resp;
      const first = resp.data?.[0];
      if (!first) return null;
      return {
        id: first.customerId ?? "",
        email: first.email ?? email,
        name: first.name ?? "",
        createdAt: typeof first.createdAt === "number"
          ? first.createdAt
          : Date.now(),
      };
    } catch (e) {
      // Si el SDK no encuentra el customer, lo trata como null.
      if (e instanceof Error && /not found/i.test(e.message)) return null;
      throw this.mapSDKError(e);
    }
  }

  // ─── Plans ─────────────────────────────────────────────

  async createPlan(input: CreatePlanInput): Promise<EpaycoPlan> {
    type Resp = { data?: { idPlan?: string; name?: string; amount?: number; currency?: string; interval?: string } };
    const resp = (await this.sdk.plans.create({
      id_plan: input.id,
      name: input.name,
      amount: input.amount,
      currency: input.currency,
      interval: input.interval,
      interval_count: input.intervalCount,
      url_confirmation: input.urlConfirmation,
      url_response: input.urlResponse,
    } as Record<string, unknown>)) as Resp;
    if (!resp.data?.idPlan) {
      throw new EpaycoError({
        message: "EpaycoClient.createPlan: missing data",
        code: "EPAYCO_INVALID_RESPONSE",
        httpStatus: 200,
        retriable: false,
      });
    }
    return {
      id: resp.data.idPlan,
      name: resp.data.name ?? input.name,
      amount: resp.data.amount ?? input.amount,
      currency: resp.data.currency ?? input.currency,
      interval: resp.data.interval ?? input.interval,
    };
  }

  // ─── Subscriptions ──────────────────────────────────────

  async createSubscription(
    input: CreateSubscriptionInput,
  ): Promise<EpaycoSubscription> {
    type Resp = {
      data?: {
        id?: string;
        customerId?: string;
        planId?: string;
        status?: string;
        checkoutUrl?: string;
        periodStart?: number;
        periodEnd?: number;
        createdAt?: number;
      };
    };
    const resp = (await this.sdk.subscriptions.create({
      id_customer: input.customerId,
      id_plan: input.planId,
      token_card: input.paymentMethodToken,
      ...(input.urlConfirmation ? { url_confirmation: input.urlConfirmation } : {}),
    } as Record<string, unknown>)) as Resp;
    if (!resp.data?.id) {
      throw new EpaycoError({
        message: "EpaycoClient.createSubscription: missing data",
        code: "EPAYCO_INVALID_RESPONSE",
        httpStatus: 200,
        retriable: false,
      });
    }
    return {
      id: resp.data.id,
      customerId: resp.data.customerId ?? input.customerId,
      planId: resp.data.planId ?? input.planId,
      status: this.normalizeStatus(resp.data.status),
      ...(resp.data.checkoutUrl ? { checkoutUrl: resp.data.checkoutUrl } : {}),
      currentPeriodStart: resp.data.periodStart ?? Date.now(),
      currentPeriodEnd: resp.data.periodEnd ?? Date.now() + 30 * 24 * 60 * 60 * 1000,
      createdAt: resp.data.createdAt ?? Date.now(),
    };
  }

  async cancelSubscription(subscriptionId: string): Promise<void> {
    await this.sdk.subscriptions.cancel(subscriptionId);
  }

  // ─── One-time charges (wallet) ──────────────────────────

  async createCharge(input: CreateChargeInput): Promise<EpaycoCharge> {
    type Resp = {
      data?: {
        refPayco?: string;
        customerId?: string;
        valor?: number;
        moneda?: string;
        estado?: string;
        checkoutUrl?: string;
        createdAt?: number;
      };
    };
    const resp = (await this.sdk.charge.create({
      token_card: input.paymentMethodToken,
      customer_id: input.customerId,
      doc_number: input.customerId,
      name: "Worgena credit pack",
      last_name: "Purchase",
      email: "",
      country: "CO",
      city: "Bogota",
      address: "Online",
      phone: "",
      cell_phone: "",
      value: input.amount,
      tax: 0,
      tax_base: 0,
      currency: input.currency,
      description: input.description,
      reference: input.reference,
      ...(input.urlConfirmation ? { url_confirmation: input.urlConfirmation } : {}),
      ...(input.urlResponse ? { url_response: input.urlResponse } : {}),
    } as Record<string, unknown>)) as Resp;
    if (!resp.data?.refPayco) {
      throw new EpaycoError({
        message: "EpaycoClient.createCharge: missing data",
        code: "EPAYCO_INVALID_RESPONSE",
        httpStatus: 200,
        retriable: false,
      });
    }
    return {
      id: resp.data.refPayco,
      customerId: resp.data.customerId ?? input.customerId,
      amount: resp.data.valor ?? input.amount,
      currency: resp.data.moneda ?? input.currency,
      status: this.normalizeChargeStatus(resp.data.estado),
      reference: input.reference,
      ...(resp.data.checkoutUrl ? { checkoutUrl: resp.data.checkoutUrl } : {}),
      createdAt: resp.data.createdAt ?? Date.now(),
    };
  }

  // ─── Webhook signature verification (custom, SDK no lo cubre) ─

  /**
   * Verifica la firma HMAC-SHA256 de un webhook de ePayco.
   * El SDK no expone esta función. La mantenemos custom.
   */
  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    if (!signature) return false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { createHmac, timingSafeEqual } = requireCJS("node:crypto") as typeof import("node:crypto");
      const expected = createHmac("sha256", this.privateKey)
        .update(rawBody, "utf8")
        .digest("base64");
      const sigBuf = Buffer.from(signature, "base64");
      const expBuf = Buffer.from(expected, "base64");
      if (sigBuf.length !== expBuf.length) return false;
      return timingSafeEqual(sigBuf, expBuf);
    } catch {
      return false;
    }
  }

  // ─── Helpers ──────────────────────────────────────────

  private normalizeStatus(s: string | undefined): EpaycoSubscription["status"] {
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

  private normalizeChargeStatus(
    s: string | undefined,
  ): EpaycoCharge["status"] {
    switch (s) {
      case "completed":
      case "approved":
        return "completed";
      case "failed":
      case "rejected":
        return "failed";
      case "refunded":
        return "refunded";
      default:
        return "pending";
    }
  }

  private mapSDKError(e: unknown): EpaycoError {
    if (e instanceof EpaycoError) return e;
    const msg = e instanceof Error ? e.message : String(e);
    if (/network|ECONN|timeout/i.test(msg)) {
      return new EpaycoError({
        message: `Epayco SDK network error: ${msg}`,
        code: "EPAYCO_NETWORK_ERROR",
        httpStatus: 0,
        retriable: true,
      });
    }
    if (/unauthorized|401|403/i.test(msg)) {
      return new EpaycoError({
        message: `Epayco SDK unauthorized: ${msg}`,
        code: "EPAYCO_UNAUTHORIZED",
        httpStatus: 401,
        retriable: false,
      });
    }
    if (/not found|404/i.test(msg)) {
      return new EpaycoError({
        message: `Epayco SDK not found: ${msg}`,
        code: "EPAYCO_NOT_FOUND",
        httpStatus: 404,
        retriable: false,
      });
    }
    if (/rate limit|429/i.test(msg)) {
      return new EpaycoError({
        message: `Epayco SDK rate limit: ${msg}`,
        code: "EPAYCO_RATE_LIMIT",
        httpStatus: 429,
        retriable: true,
      });
    }
    return new EpaycoError({
      message: `Epayco SDK error: ${msg}`,
      code: "EPAYCO_PROVIDER_ERROR",
      httpStatus: 500,
      retriable: true,
    });
  }
}
