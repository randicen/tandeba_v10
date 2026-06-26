/**
 * Worgena — Credit-to-USD conversion (P0 #4 billing v1).
 *
 * 1 crédito = $0.01 USD. Configurable vía `CREDIT_USD_RATE` env var
 * (forward-compat si la economía de la unidad se revalúa).
 *
 * Default: 100. Razón: LLM plans chicos (Pro 2000 credits/mes) × $0.01 =
 * $20 USD/mes, alineado con planes SaaS legales. Permite granularidad
 * fina sin saturar la columna `delta` (que es INTEGER, no REAL).
 *
 * Forward-compat: si en el futuro queremos sub-cent precision (e.g.
 * Claude 3.5 Sonnet a $3/1M tokens output = $0.000003 por call corto,
 * redondeado a 1 crédito = $0.01 está bien para billing; para
 * tracking fino se usa el campo `costUsd` real de OpenRouter).
 */

import type Database from "better-sqlite3";

/**
 * Ratio: 1 USD = N créditos. Default 100. Override via `CREDIT_USD_RATE`.
 */
export const CREDIT_USD_RATE: number = (() => {
  const raw = process.env.CREDIT_USD_RATE;
  const parsed = raw === undefined || raw === "" ? 100 : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[billing] CREDIT_USD_RATE inválido ("${raw}"), usando default 100`,
    );
    return 100;
  }
  return parsed;
})();

/**
 * USD → créditos. Math.ceil para no sub-pagar (cliente no recibe
 * créditos "gratis" por redondeo).
 */
export function usdToCredits(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) return 0;
  return Math.ceil(usd * CREDIT_USD_RATE);
}

/**
 * Créditos → USD. Para mostrar al usuario.
 */
export function creditsToUsd(credits: number): number {
  if (!Number.isFinite(credits) || credits < 0) return 0;
  return credits / CREDIT_USD_RATE;
}
