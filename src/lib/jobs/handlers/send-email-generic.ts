/**
 * Worgena — `send_email_generic` handler (P0 #5 jobs).
 *
 * Email ad-hoc. Usado para casos no cubiertos por los otros handlers
 * (forward-compat: magic links, password reset, etc).
 *
 * Payload: `{to, subject, html, text?, tags?}`.
 */

import type { JobHandler } from "../handlers/index.js";

export const handleSendEmailGeneric: JobHandler = async (payload, deps) => {
  const to = payload.to;
  const subject = payload.subject;
  const html = payload.html;
  if (typeof to !== "string" || typeof subject !== "string" || typeof html !== "string") {
    throw new Error(
      "send_email_generic: payload.to, subject, html are required and must be strings",
    );
  }

  const text = typeof payload.text === "string" ? payload.text : undefined;
  const tags = Array.isArray(payload.tags)
    ? (payload.tags as Array<{ name: string; value: string }>)
    : undefined;

  await deps.email.sendEmail({
    to,
    subject,
    html,
    ...(text !== undefined ? { text } : {}),
    ...(tags !== undefined ? { tags } : {}),
  });
};
