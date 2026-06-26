/**
 * Worgena — Email provider interface (P0 #5 jobs).
 *
 * Capa de abstracción sobre el servicio de email transaccional.
 * v1 usa Resend (decisión del founder 2026-06-25). El interface
 * permite swap a SendGrid/SES sin tocar los handlers.
 *
 * Spec: AGENT_JOBS_V1_SPEC.md §2.O4.
 */

export interface SendEmailInput {
  /** Destinatario. Single recipient por ahora. */
  to: string;
  /** Asunto. */
  subject: string;
  /** Body HTML (preferido). */
  html: string;
  /** Body text plain alternativo (forward-compat para clientes sin HTML). */
  text?: string;
  /** Reply-To opcional. */
  replyTo?: string;
  /** Tags para tracking. */
  tags?: ReadonlyArray<{ name: string; value: string }>;
}

export interface SendEmailResult {
  /** Provider-side ID del email enviado. */
  id: string;
}

export interface EmailProvider {
  sendEmail(input: SendEmailInput): Promise<SendEmailResult>;
}

// ============================================================
// Error
// ============================================================

export type EmailProviderErrorCode =
  | "EMAIL_PROVIDER_BAD_REQUEST" // 400
  | "EMAIL_PROVIDER_UNAUTHORIZED" // 401
  | "EMAIL_PROVIDER_NOT_FOUND" // 404
  | "EMAIL_PROVIDER_RATE_LIMIT" // 429
  | "EMAIL_PROVIDER_PROVIDER_ERROR" // 5xx
  | "EMAIL_PROVIDER_NETWORK_ERROR" // fetch failed
  | "EMAIL_PROVIDER_INVALID_RESPONSE"; // 200 con shape mal

export class EmailProviderError extends Error {
  readonly code: EmailProviderErrorCode;
  readonly httpStatus: number;
  readonly retriable: boolean;

  constructor(args: {
    message: string;
    code: EmailProviderErrorCode;
    httpStatus: number;
    retriable: boolean;
  }) {
    super(args.message);
    this.name = "EmailProviderError";
    this.code = args.code;
    this.httpStatus = args.httpStatus;
    this.retriable = args.retriable;
  }
}
