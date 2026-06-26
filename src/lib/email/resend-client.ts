/**
 * Worgena — Resend provider (P0 #5 jobs).
 *
 * Impl de EmailProvider usando Resend (https://resend.com/docs/api-reference).
 * HTTP via fetch directo, NO SDK oficial (mismo patrón que
 * EpayClient: type-safety, control de errores, transport inyectable).
 *
 * Spec: AGENT_JOBS_V1_SPEC.md §2.O4.
 *
 * Decisión D1: SDK vs fetch. Default: fetch. Si fricción en prod,
 * swappear a `resend` SDK oficial (~3KB).
 *
 * Sandbox: Resend provee API key de prueba (`re_test_...`). El
 * endpoint es el mismo que producción.
 */

import {
  type EmailProvider,
  type SendEmailInput,
  type SendEmailResult,
  EmailProviderError,
} from "./provider.js";

// ============================================================
// Types
// ============================================================

export type ResendTransport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; text: () => Promise<string> }>;

export interface ResendProviderOptions {
  /** API key de Resend. `re_xxxx` para producción, `re_test_xxxx` para sandbox. */
  apiKey: string;
  /** Email "From" default (debe estar verificado en Resend). */
  fromEmail: string;
  /** Nombre del sender. Default: "Worgena". */
  fromName?: string;
  /** Transport inyectable. Default: fetch global. */
  transport?: ResendTransport;
}

interface ResendApiResponse {
  id?: string;
}

// ============================================================
// Provider
// ============================================================

const RESEND_BASE = "https://api.resend.com";

export class ResendProvider implements EmailProvider {
  private readonly apiKey: string;
  private readonly fromEmail: string;
  private readonly fromName: string;
  private readonly transport: ResendTransport;

  constructor(options: ResendProviderOptions) {
    if (!options.apiKey) {
      throw new Error("ResendProvider: apiKey is required");
    }
    if (!options.fromEmail) {
      throw new Error("ResendProvider: fromEmail is required");
    }
    this.apiKey = options.apiKey;
    this.fromEmail = options.fromEmail;
    this.fromName = options.fromName ?? "Worgena";
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

  async sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
    const url = `${RESEND_BASE}/emails`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
    const body = JSON.stringify({
      from: `${this.fromName} <${this.fromEmail}>`,
      to: [input.to],
      subject: input.subject,
      html: input.html,
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.replyTo !== undefined ? { reply_to: input.replyTo } : {}),
      ...(input.tags !== undefined
        ? {
            tags: input.tags.map((t) => ({ name: t.name, value: t.value })),
          }
        : {}),
    });

    let response: { status: number; text: () => Promise<string> };
    try {
      response = await this.transport(url, {
        method: "POST",
        headers,
        body,
      });
    } catch (e) {
      throw new EmailProviderError({
        message: `ResendProvider: network error: ${(e as Error).message}`,
        code: "EMAIL_PROVIDER_NETWORK_ERROR",
        httpStatus: 0,
        retriable: true,
      });
    }

    const text = await response.text();
    if (response.status >= 500) {
      throw new EmailProviderError({
        message: `ResendProvider: server error ${response.status}: ${text.slice(0, 200)}`,
        code: "EMAIL_PROVIDER_PROVIDER_ERROR",
        httpStatus: response.status,
        retriable: true,
      });
    }
    if (response.status === 429) {
      throw new EmailProviderError({
        message: "ResendProvider: rate limit",
        code: "EMAIL_PROVIDER_RATE_LIMIT",
        httpStatus: 429,
        retriable: true,
      });
    }
    if (response.status === 401 || response.status === 403) {
      throw new EmailProviderError({
        message: `ResendProvider: unauthorized (check API key)`,
        code: "EMAIL_PROVIDER_UNAUTHORIZED",
        httpStatus: response.status,
        retriable: false,
      });
    }
    if (response.status === 404) {
      throw new EmailProviderError({
        message: `ResendProvider: not found`,
        code: "EMAIL_PROVIDER_NOT_FOUND",
        httpStatus: 404,
        retriable: false,
      });
    }
    if (response.status >= 400) {
      throw new EmailProviderError({
        message: `ResendProvider: bad request ${response.status}: ${text.slice(0, 200)}`,
        code: "EMAIL_PROVIDER_BAD_REQUEST",
        httpStatus: response.status,
        retriable: false,
      });
    }

    let parsed: ResendApiResponse;
    try {
      parsed = JSON.parse(text) as ResendApiResponse;
    } catch {
      throw new EmailProviderError({
        message: `ResendProvider: invalid JSON response: ${text.slice(0, 200)}`,
        code: "EMAIL_PROVIDER_INVALID_RESPONSE",
        httpStatus: response.status,
        retriable: false,
      });
    }

    if (!parsed.id) {
      throw new EmailProviderError({
        message: `ResendProvider: response missing id: ${text.slice(0, 200)}`,
        code: "EMAIL_PROVIDER_INVALID_RESPONSE",
        httpStatus: response.status,
        retriable: false,
      });
    }

    return { id: parsed.id };
  }
}
