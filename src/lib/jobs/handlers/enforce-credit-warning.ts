/**
 * Worgena — `enforce_credit_warning` handler (P0 #5 jobs).
 *
 * Cuando un firm tiene < 20% del plan, manda email al admin
 * avisando. Idempotente: el caller usa `idempotencyKey =
 * 'credit-warning-{firmId}-{YYYY-MM-DD}'` para evitar 2 emails el
 * mismo día.
 *
 * Payload: `{firmId: string, thresholdFraction?: number}` (default 0.2).
 */

import type { JobHandler } from "../handlers/index.js";
import { getDb } from "../../billing/db-instance.js";
import { getCreditBalance, getCurrentPlan } from "../../billing/billing.js";

export const handleEnforceCreditWarning: JobHandler = async (payload, deps) => {
  const firmId = payload.firmId;
  if (typeof firmId !== "string") {
    throw new Error("enforce_credit_warning: payload.firmId is required");
  }
  const thresholdFraction =
    typeof payload.thresholdFraction === "number"
      ? payload.thresholdFraction
      : 0.2;

  const db = deps.db ?? getDb();
  const plan = getCurrentPlan(firmId, db);
  if (!plan) {
    // Firm sin plan activo. No hay a qué avisar.
    return;
  }
  const balance = getCreditBalance(firmId, db);
  const monthly = plan.monthlyCredits;
  const ratio = monthly > 0 ? balance / monthly : 0;
  if (ratio >= thresholdFraction) {
    // Aún tiene más del 20% del plan. No avisa.
    return;
  }

  // Resolver email del admin del firm (el primer owner).
  const admin = db
    .prepare(
      `SELECT au.email FROM tenant_members tm
       JOIN auth_user au ON au.id = tm.user_id
       WHERE tm.tenant_id = ? AND tm.role = 'owner'
       ORDER BY tm.joined_at ASC LIMIT 1`,
    )
    .get(firmId) as { email: string } | undefined;
  if (!admin?.email) {
    console.warn(
      `[enforce_credit_warning] firm id=${firmId} no owner email, skipping`,
    );
    return;
  }

  const subject = `Worgena: tu plan ${plan.name} tiene ${Math.round(ratio * 100)}% de créditos`;
  const html = `
    <p>Hola,</p>
    <p>Tu firm en Worgena (plan <strong>${plan.name}</strong>) tiene <strong>${balance} créditos</strong> de ${monthly} del periodo (${Math.round(ratio * 100)}%).</p>
    <p>Para evitar interrupciones, podés:</p>
    <ul>
      <li>Comprar un paquete extra en <a href="${process.env.PUBLIC_URL ?? "http://localhost:3000"}/billing/wallet">tu wallet</a>.</li>
      <li>O actualizar a un plan con más créditos.</li>
    </ul>
    <p>— Equipo Worgena</p>
  `.trim();

  await deps.email.sendEmail({
    to: admin.email,
    subject,
    html,
    tags: [
      { name: "type", value: "credit_warning" },
      { name: "firm_id", value: firmId },
    ],
  });
};
