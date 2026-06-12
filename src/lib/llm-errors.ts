/**
 * Worgena — Helpers para traducir errores del proveedor LLM a mensajes user-facing.
 *
 * Política actual (dev/test, 2026-06):
 * - 402 Insufficient Balance: el proveedor se quedó sin saldo. El usuario ve
 *   un mensaje genérico de mantenimiento. El error real (con status, body,
 *   stack) SÍ se loggea internamente para monitoría.
 * - Otros errores: se devuelven tal cual (mensaje técnico o el `e.message`).
 *
 * Pendiente (fase posterior, anotado en sesión): taxonomía más amplia de
 * errores UX — 4xx/5xx del LLM, timeouts, rate limits, context too long,
 * invalid output. Hoy solo 402 porque es el caso que ya nos pasó.
 *
 * Uso típico (en un route handler):
 *
 *   import { isInsufficientBalance, MAINTENANCE_MESSAGE, getUserMessage } from "../lib/llm-errors.js";
 *
 *   } catch (e) {
 *     if (isInsufficientBalance(e)) {
 *       console.error("[INTERNAL] LLM 402 Insufficient Balance:", e);
 *       return res.status(503).json({
 *         error: MAINTENANCE_MESSAGE,
 *         code: "SERVICE_UNAVAILABLE",
 *       });
 *     }
 *     res.status(500).json({ error: getUserMessage(e) });
 *   }
 */

/**
 * Mensaje que el usuario final (cliente) ve cuando el proveedor LLM se queda
 * sin saldo. NO incluye detalle técnico: el cliente no necesita (ni debe)
 * ver el código 402 ni el cuerpo de la respuesta.
 */
export const MAINTENANCE_MESSAGE =
  "Estamos en un breve mantenimiento para mejorar. Volveremos muy pronto.";

/**
 * Mensaje genérico para CUALQUIER error de runtime que se propague al cliente
 * final. Política del proyecto: el cliente nunca ve errores técnicos
 * (códigos HTTP, mensajes de SDK, stack traces). El detalle real va a los
 * logs del backend, donde el dev lo busca si necesita.
 */
export const GENERIC_ERROR_MESSAGE =
  "Hubo un problema al procesar tu solicitud. Por favor intenta de nuevo en un momento.";

/**
 * Detecta si un error del proveedor LLM es un 402 Insufficient Balance.
 *
 * El SDK de OpenAI (y la mayoría de los SDKs OpenAI-compatibles) expone el
 * status code HTTP en `e.status`. Si el error fue creado a mano por nuestro
 * propio wrapper (`InsufficientBalanceError` en agent.ts) el flag es
 * `__insufficientBalance = true`.
 */
export function isInsufficientBalance(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  // 1. Flag del wrapper (más explícito que parsear el status).
  const flag = (e as { __insufficientBalance?: unknown }).__insufficientBalance;
  if (flag === true) return true;
  // 2. Status code del SDK.
  const status = (e as { status?: unknown }).status;
  return status === 402;
}

/**
 * Mensaje user-facing (cliente final) para un error.
 *
 * Política del proyecto: el cliente NUNCA ve el detalle técnico. El dev
 * tiene que ir a los logs del backend (console.error en cada catch + el
 * audit log en DB) para entender qué pasó. Si vos estás leyendo esto
 * pensando "pero si es un 404 también debería ser genérico? y un timeout
 * también?": sí, todos. Sin excepciones. La lógica de "qué tipo de error
 * fue" es para el log, no para el cliente.
 */
export function getUserMessage(e: unknown): string {
  // 402 recibe un mensaje específico de mantenimiento (más útil para el
  // cliente que el genérico en este caso particular, porque el "quédate
  // tranquilo, sabemos del tema" comunica mejor). Cualquier otro error:
  // mensaje genérico. CERO detalle técnico al cliente.
  return isInsufficientBalance(e) ? MAINTENANCE_MESSAGE : GENERIC_ERROR_MESSAGE;
}
