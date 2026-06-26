/**
 * Worgena — `send_invitation_email` handler (P0 #5 jobs).
 *
 * Cierra la mitad funcional de D3.4: cuando un owner crea una
 * invitación via `POST /api/firms/:id/invitations`, este handler
 * manda el email con el link al invitado.
 *
 * Payload: `{invitationId: string, publicUrl?: string}`.
 * Resuelve: tenant_invitations row, firm name, inviter email,
 * genera URL con token, manda email via EmailProvider.
 */

import type { JobHandler } from "../handlers/index.js";
import { getDb } from "../../billing/db-instance.js";

export const handleSendInvitationEmail: JobHandler = async (payload, deps) => {
  const invitationId = payload.invitationId;
  if (typeof invitationId !== "string") {
    throw new Error("send_invitation_email: payload.invitationId is required");
  }
  const publicUrl =
    (payload.publicUrl as string | undefined) ??
    deps.config?.publicUrl ??
    process.env.PUBLIC_URL ??
    "http://localhost:3000";

  // Read invitation row + firm + inviter via JOINs
  const db = deps.db ?? getDb();
  const row = db
    .prepare(
      `SELECT
         inv.id AS inv_id,
         inv.email AS inv_email,
         inv.role AS inv_role,
         inv.expires_at AS inv_expires_at,
         inv.token AS inv_token,
         t.name AS firm_name,
         au.email AS inviter_email
       FROM tenant_invitations inv
       JOIN tenants t ON t.id = inv.tenant_id
       LEFT JOIN auth_user au ON au.id = inv.created_by
       WHERE inv.id = ?`,
    )
    .get(invitationId) as
    | {
        inv_id: string;
        inv_email: string | null;
        inv_role: string;
        inv_expires_at: number;
        inv_token: string;
        firm_name: string;
        inviter_email: string | null;
      }
    | undefined;

  if (!row) {
    throw new Error(`send_invitation_email: invitation id=${invitationId} not found`);
  }
  if (!row.inv_email) {
    // Invitation sin email (puede pasar si el admin no lo pre-llenó).
    // No podemos mandar sin email. Log loud y skip.
    console.warn(
      `[send_invitation_email] invitation id=${invitationId} has no email, skipping`,
    );
    return;
  }
  if (row.inv_expires_at < Date.now()) {
    // Invitación expirada. No enviar.
    console.warn(
      `[send_invitation_email] invitation id=${invitationId} expired, skipping`,
    );
    return;
  }

  const acceptUrl = `${publicUrl.replace(/\/$/, "")}/onboarding?token=${encodeURIComponent(row.inv_token)}`;
  const subject = `Invitación a ${row.firm_name} en Worgena`;
  const html = `
    <p>Hola,</p>
    <p>${row.inviter_email ?? "Un miembro"} te invitó a unirte a <strong>${row.firm_name}</strong> en Worgena.</p>
    <p>Click acá para aceptar la invitación (rol: ${row.inv_role}):</p>
    <p><a href="${acceptUrl}">${acceptUrl}</a></p>
    <p>El link expira el ${new Date(row.inv_expires_at).toISOString()}.</p>
    <p>Si no esperabas este email, podés ignorarlo.</p>
    <p>— Equipo Worgena</p>
  `.trim();
  const text = `
Hola,

${row.inviter_email ?? "Un miembro"} te invitó a unirte a ${row.firm_name} en Worgena.

Click acá para aceptar la invitación (rol: ${row.inv_role}):
${acceptUrl}

El link expira el ${new Date(row.inv_expires_at).toISOString()}.

Si no esperabas este email, podés ignorarlo.

— Equipo Worgena
  `.trim();

  await deps.email.sendEmail({
    to: row.inv_email,
    subject,
    html,
    text,
    tags: [
      { name: "type", value: "invitation" },
      { name: "invitation_id", value: invitationId },
    ],
  });
};
