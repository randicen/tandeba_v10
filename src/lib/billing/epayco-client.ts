/**
 * Worgena — ePayco API client (P0 #4 billing v1).
 *
 * Cliente HTTP custom en TypeScript para la pasarela ePayco
 * (https://api.epayco.co). NO usa el SDK oficial
 * (`epayco-sdk-node` v1.4.4) por:
 *
 * 1. **Type safety**: el SDK no tiene tipos estrictos, devuelve
 *    `any`. Nuestro cliente tiene types explícitos.
 * 2. **Control de errores**: nosotros decidimos cómo mapear errores
 *    HTTP a `EpaycoError` con codes tipados.
 * 3. **Testabilidad**: el `transport` es inyectable (mismo patrón
 *    que `OpenRouterClient`). Los tests pueden simular responses
 *    sin tocar red.
 * 4. **Tamaño bundle**: SDK = ~150KB, fetch = 0.
 *
 * Trade-off: si el SDK agrega features que no son accesibles via
 * REST (ej: helpers de UI), reconsiderar. Por ahora, REST cubre
 * todo lo que necesitamos.
 *
 * **Decisión D1 del spec**: SDK vs fetch. Default: fetch. Re-evaluar
 * si se ve fricción durante implementación.
 *
 * **API key handling**: la `EPAYCO_PRIVATE_KEY` NUNCA se loguea,
 * NUNCA se incluye en mensajes de error. Verificable con grep.
 *
 * Spec: `AGENT_BILLING_V1_SPEC.md` §2.O3.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

// ============================================================
// Types
// ============================================================

/**
 * Transport inyectable. Default: fetch nativo. Tests pasan un
 * mock que programa responses FIFO.
 */
export type EpaycoTransport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; text: () => Promise<string> }>;

export interface EpaycoClientOptions {
  /** Public key (cliente). Seguro de exponer en frontend si fuera necesario. */
  publicKey: string;
  /** Private key (confidencial). NUNCA exponer. */
  privateKey: string;
  /** true = sandbox (https://api.secure.payco.co). false = production. */
  testMode: boolean;
  /** Transport inyectable. Default: fetch global. */
  transport?: EpaycoTransport;
}

export interface CreateCustomerInput {
  /** Email del customer (Better Auth user.email). */
  email: string;
  /** Nombre del customer. */
  name: string;
  /** Teléfono (opcional, ePayco requiere para algunos métodos). */
  phone?: string;
  /** Default: false. */
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
  /** URL de retorno post-pago. */
  urlConfirmation: string;
  /** URL de respuesta al cliente. */
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
  /** Customer de ePayco (creado antes). */
  customerId: string;
  /** Plan de ePayco (creado antes). */
  planId: string;
  /** Token de método de pago (de checkout/SDK frontend). */
  paymentMethodToken: string;
  /** URL de retorno post-pago. */
  urlConfirmation?: string;
}

export interface EpaycoSubscription {
  id: string;
  customerId: string;
  planId: string;
  status: "pending" | "active" | "past_due" | "cancelled" | "expired";
  /** URL de checkout si requiere acción del cliente. */
  checkoutUrl?: string;
  currentPeriodStart: number;
  currentPeriodEnd: number;
  createdAt: number;
}

export interface CreateChargeInput {
  /** Customer de ePayco (para one-time wallet purchase). */
  customerId: string;
  /** Token de método de pago. */
  paymentMethodToken: string;
  amount: number;
  currency: "COP" | "USD";
  description: string;
  /** URL de retorno post-pago. */
  urlConfirmation?: string;
  /** URL de respuesta al cliente. */
  urlResponse?: string;
  /** Reference único para idempotencia. */
  reference: string;
}

export interface EpaycoCharge {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "completed" | "failed" | "refunded";
  reference: string;
  /** URL de checkout si requiere acción del cliente. */
  checkoutUrl?: string;
  createdAt: number;
}

// ============================================================
// Error
// ============================================================

/**
 * Códigos de error tipados de ePayco. Mapean a `ErrorCode` del motor
 * cuando son propagados.
 */
export type EpaycoErrorCode =
  | "EPAYCO_BAD_REQUEST" // 400
  | "EPAYCO_UNAUTHORIZED" // 401 (credenciales mal)
  | "EPAYCO_NOT_FOUND" // 404
  | "EPAYCO_CONFLICT" // 409 (e.g., customer ya existe)
  | "EPAYCO_RATE_LIMIT" // 429
  | "EPAYCO_PROVIDER_ERROR" // 5xx
  | "EPAYCO_NETWORK_ERROR" // fetch failed
  | "EPAYCO_INVALID_RESPONSE" // 200 con JSON malformado
  | "EPAYCO_BAD_SIGNATURE"; // webhook signature no valida

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
// Client
// ============================================================

const PROD_BASE = "https://api.epayco.co";
const TEST_BASE = "https://api.secure.payco.co";

export class EpaycoClient {
  private readonly publicKey: string;
  private readonly privateKey: string;
  private readonly baseUrl: string;
  private readonly transport: EpaycoTransport;

  constructor(options: EpaycoClientOptions) {
    if (!options.publicKey) {
      throw new Error("EpaycoClient: publicKey is required");
    }
    if (!options.privateKey) {
      throw new Error("EpaycoClient: privateKey is required");
    }
    this.publicKey = options.publicKey;
    this.privateKey = options.privateKey;
    this.baseUrl = options.testMode ? TEST_BASE : PROD_BASE;
    this.transport =
      options.transport ??
      (async (url, init) => {
        const res = await fetch(url, init);
        return {
          status: res.status,
          text: () => res.text(),
        };
      });
  }

  // ─── Internal HTTP helper ──────────────────────────────

  private async request<T>(args: {
    method: string;
    path: string;
    body?: Record<string, unknown>;
  }): Promise<T> {
    const url = `${this.baseUrl}${args.path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${this.publicKey}`,
    };
    let bodyStr: string | undefined;
    if (args.body) bodyStr = JSON.stringify(args.body);

    let response: { status: number; text: () => Promise<string> };
    try {
      response = await this.transport(url, {
        method: args.method,
        headers,
        ...(bodyStr !== undefined ? { body: bodyStr } : {}),
      });
    } catch (e) {
      throw new EpaycoError({
        message: `EpaycoClient: network error calling ${args.path}: ${(e as Error).message}`,
        code: "EPAYCO_NETWORK_ERROR",
        httpStatus: 0,
        retriable: true,
      });
    }

    const text = await response.text();
    if (response.status >= 500) {
      throw new EpaycoError({
        message: `EpaycoClient: server error ${response.status} on ${args.path}: ${text.slice(0, 200)}`,
        code: "EPAYCO_PROVIDER_ERROR",
        httpStatus: response.status,
        retriable: true,
      });
    }
    if (response.status === 429) {
      throw new EpaycoError({
        message: `EpaycoClient: rate limit on ${args.path}`,
        code: "EPAYCO_RATE_LIMIT",
        httpStatus: 429,
        retriable: true,
      });
    }
    if (response.status === 401 || response.status === 403) {
      throw new EpaycoError({
        message: `EpaycoClient: unauthorized on ${args.path} (check keys)`,
        code: "EPAYCO_UNAUTHORIZED",
        httpStatus: response.status,
        retriable: false,
      });
    }
    if (response.status === 404) {
      throw new EpaycoError({
        message: `EpaycoClient: not found ${args.path}`,
        code: "EPAYCO_NOT_FOUND",
        httpStatus: 404,
        retriable: false,
      });
    }
    if (response.status === 409) {
      throw new EpaycoError({
        message: `EpaycoClient: conflict on ${args.path}: ${text.slice(0, 200)}`,
        code: "EPAYCO_CONFLICT",
        httpStatus: 409,
        retriable: false,
      });
    }
    if (response.status >= 400) {
      throw new EpaycoError({
        message: `EpaycoClient: bad request ${response.status} on ${args.path}: ${text.slice(0, 200)}`,
        code: "EPAYCO_BAD_REQUEST",
        httpStatus: response.status,
        retriable: false,
      });
    }

    let parsed: T;
    try {
      parsed = JSON.parse(text) as T;
    } catch {
      throw new EpaycoError({
        message: `EpaycoClient: invalid JSON response on ${args.path}: ${text.slice(0, 200)}`,
        code: "EPAYCO_INVALID_RESPONSE",
        httpStatus: response.status,
        retriable: false,
      });
    }
    return parsed;
  }

  // ─── Customers ────────────────────────────────────────

  /**
   * Crea un customer en ePayco. Si el email ya existe, ePayco retorna
   * 409 — caller puede usar `getCustomerByEmail` y reusar.
   */
  async createCustomer(input: CreateCustomerInput): Promise<EpaycoCustomer> {
    type Resp = {
      data?: { customerId: string; email: string; name: string; createdAt: number };
      status?: boolean;
    };
    const resp = await this.request<Resp>({
      method: "POST",
      path: "/v1/customers/create",
      body: {
        ...input,
        // ePayco a veces pide campos en español en sandbox
        ...(input.phone ? { phone: input.phone } : {}),
      },
    });
    if (!resp.data) {
      throw new EpaycoError({
        message: `EpaycoClient.createCustomer: missing data in response`,
        code: "EPAYCO_INVALID_RESPONSE",
        httpStatus: 200,
        retriable: false,
      });
    }
    return {
      id: resp.data.customerId,
      email: resp.data.email,
      name: resp.data.name,
      createdAt: resp.data.createdAt,
    };
  }

  /**
   * Busca un customer por email. Retorna null si no existe.
   */
  async getCustomerByEmail(email: string): Promise<EpaycoCustomer | null> {
    type Resp = {
      data?: { customerId: string; email: string; name: string; createdAt: number } | null;
    };
    const resp = await this.request<Resp>({
      method: "GET",
      path: `/v1/customers/email/${encodeURIComponent(email)}`,
    });
    if (!resp.data) return null;
    return {
      id: resp.data.customerId,
      email: resp.data.email,
      name: resp.data.name,
      createdAt: resp.data.createdAt,
    };
  }

  // ─── Plans ────────────────────────────────────────────

  /**
   * Crea un plan en ePayco. Idempotente si se pasa el mismo `id`
   * (ePayco lo trata como upsert).
   */
  async createPlan(input: CreatePlanInput): Promise<EpaycoPlan> {
    type Resp = {
      data?: { idPlan: string; name: string; amount: number; currency: string; interval: string };
    };
    const resp = await this.request<Resp>({
      method: "POST",
      path: "/v1/plans/create",
      body: {
        id_plan: input.id,
        name: input.name,
        amount: input.amount,
        currency: input.currency,
        interval: input.interval,
        interval_count: input.intervalCount,
        url_confirmation: input.urlConfirmation,
        url_response: input.urlResponse,
      },
    });
    if (!resp.data) {
      throw new EpaycoError({
        message: `EpaycoClient.createPlan: missing data`,
        code: "EPAYCO_INVALID_RESPONSE",
        httpStatus: 200,
        retriable: false,
      });
    }
    return {
      id: resp.data.idPlan,
      name: resp.data.name,
      amount: resp.data.amount,
      currency: resp.data.currency,
      interval: resp.data.interval,
    };
  }

  // ─── Subscriptions ────────────────────────────────────

  /**
   * Crea una subscription en ePayco. ePayco internamente agenda el
   * cobro recurrente (mensual según plan). Si el cliente tiene que
   * completar el pago inicial, retorna `checkoutUrl`.
   */
  async createSubscription(
    input: CreateSubscriptionInput,
  ): Promise<EpaycoSubscription> {
    type Resp = {
      data?: {
        id: string;
        customerId: string;
        planId: string;
        status: string;
        checkoutUrl?: string;
        periodStart: number;
        periodEnd: number;
        createdAt: number;
      };
    };
    const resp = await this.request<Resp>({
      method: "POST",
      path: "/v1/subscriptions/create",
      body: {
        id_customer: input.customerId,
        id_plan: input.planId,
        token_card: input.paymentMethodToken,
        ...(input.urlConfirmation ? { url_confirmation: input.urlConfirmation } : {}),
      },
    });
    if (!resp.data) {
      throw new EpaycoError({
        message: `EpaycoClient.createSubscription: missing data`,
        code: "EPAYCO_INVALID_RESPONSE",
        httpStatus: 200,
        retriable: false,
      });
    }
    return {
      id: resp.data.id,
      customerId: resp.data.customerId,
      planId: resp.data.planId,
      status: resp.data.status as EpaycoSubscription["status"],
      ...(resp.data.checkoutUrl ? { checkoutUrl: resp.data.checkoutUrl } : {}),
      currentPeriodStart: resp.data.periodStart,
      currentPeriodEnd: resp.data.periodEnd,
      createdAt: resp.data.createdAt,
    };
  }

  /**
   * Cancela una subscription. ePayco deja de cobrar al final del
   * periodo actual.
   */
  async cancelSubscription(subscriptionId: string): Promise<void> {
    type Resp = { status?: boolean };
    await this.request<Resp>({
      method: "POST",
      path: "/v1/subscriptions/cancel",
      body: { id: subscriptionId },
    });
  }

  // ─── One-time charges (wallet) ────────────────────────

  /**
   * Crea un cargo one-time. Usado para wallet purchases. Si el
   * cliente tiene que completar el pago, retorna `checkoutUrl`.
   */
  async createCharge(input: CreateChargeInput): Promise<EpaycoCharge> {
    type Resp = {
      data?: {
        refPayco: string;
        customerId: string;
        valor: number;
        moneda: string;
        estado: string;
        checkoutUrl?: string;
        createdAt: number;
      };
    };
    const resp = await this.request<Resp>({
      method: "POST",
      path: "/v1/charges/create",
      body: {
        token_card: input.paymentMethodToken,
        customer_id: input.customerId,
        doc_number: input.customerId, // fallback
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
      },
    });
    if (!resp.data) {
      throw new EpaycoError({
        message: `EpaycoClient.createCharge: missing data`,
        code: "EPAYCO_INVALID_RESPONSE",
        httpStatus: 200,
        retriable: false,
      });
    }
    return {
      id: resp.data.refPayco,
      customerId: resp.data.customerId,
      amount: resp.data.valor,
      currency: resp.data.moneda,
      status: resp.data.estado as EpaycoCharge["status"],
      reference: input.reference,
      ...(resp.data.checkoutUrl ? { checkoutUrl: resp.data.checkoutUrl } : {}),
      createdAt: resp.data.createdAt,
    };
  }

  // ─── Webhook signature verification ──────────────────

  /**
   * Verifica la firma HMAC-SHA256 de un webhook de ePayco.
   *
   * ePayco envía el header `x-signature` con un HMAC-SHA256 del
   * body crudo, usando `EPAYCO_PRIVATE_KEY` como secret. La firma
   * viene en base64.
   *
   * **Importante**: el body debe ser el raw string (NO parseado
   * a JSON antes de verificar).
   *
   * Spec: `AGENT_BILLING_V1_SPEC.md` §4.P4.
   */
  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    if (!signature) return false;
    try {
      const expected = createHmac("sha256", this.privateKey)
        .update(rawBody, "utf8")
        .digest("base64");
      // timingSafeEqual para evitar timing attacks
      const sigBuf = Buffer.from(signature, "base64");
      const expBuf = Buffer.from(expected, "base64");
      if (sigBuf.length !== expBuf.length) return false;
      return timingSafeEqual(sigBuf, expBuf);
    } catch {
      return false;
    }
  }
}
