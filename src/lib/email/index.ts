/**
 * Worgena — Email barrel (P0 #5 jobs).
 */

export {
  type EmailProvider,
  type SendEmailInput,
  type SendEmailResult,
  EmailProviderError,
  type EmailProviderErrorCode,
} from "./provider.js";

export {
  ResendProvider,
  type ResendProviderOptions,
  type ResendTransport,
} from "./resend-client.js";
