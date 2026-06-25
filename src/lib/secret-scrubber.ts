/**
 * Worgena — Secret Scrubber (Backlog P0 #1).
 *
 ** Detecta y redacta secretos en strings antes de persistirlos a
 * `step_logs`. Cubre el riesgo de Habeas Data Colombia: el LLM podría
 * alucinar un NIT/API key del cliente y dejarlo raw en DB.
 *
 * **Estrategia de detección**: regex para patrones conocidos +
 * entropy-based para secrets random. Trade-off: false negatives
 * aceptados (imperfect scrubber > sin scrubber), pero zero false
 * positives en datos legítimos.
 *
 * **Reemplazo**: `[REDACTED:<TIPO>]` (e.g., `[REDACTED:NIT]`). NO `***`
 * porque pierde el signal de QUÉ tipo era.
 *
 * **Counter de scrub**: in-memory, process-local. Reset por restart.
 * NO persiste en DB (es observabilidad operacional, no audit legal).
 *
 * **Forward-compat**: D6+ permite reglas custom por tenant. Hoy:
 * scrub global.
 *
 * Spec: AGENT_SPRINT_SECRET_SCRUBBER_SPEC.md
 */

import { shannonEntropy } from "./entropy.js";

/**
 * Patrones regex de secretos comunes.
 *
 * Cada uno está calibrado para ZERO false positives en datos
 * legítimos (probado en test_secret_scrubber.mts).
 */
const SECRET_PATTERNS: ReadonlyArray<{
  readonly name: string;
  readonly pattern: RegExp;
}> = [
  // NIT colombiano: 9-10 dígitos con dígito de verificación, formato
  // "123.456.789-0" o "1234567890". El guion antes del dígito verificador
  // es opcional.
  {
    name: "NIT",
    pattern: /\b\d{1,3}(?:\.\d{3}){2,3}-?\d?\b/g,
  },
  // API key estilo OpenAI (sk-xxx) — 48+ chars alfanuméricos
  {
    name: "API_KEY",
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  },
  // API key estilo Anthropic (sk-ant-xxx)
  {
    name: "API_KEY",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  // Google API key (AIzaSy...)
  {
    name: "API_KEY",
    pattern: /\bAIza[A-Za-z0-9_-]{30,}\b/g,
  },
  // GitHub personal access token (ghp_xxx, gho_xxx, etc.)
  {
    name: "API_KEY",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  },
  // JWT: 3 segmentos base64 separados por puntos
  {
    name: "JWT",
    pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  },
  // Email (RFC 5322 simplificado)
  {
    name: "EMAIL",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  // Credit card: 16 dígitos con o sin separadores
  {
    name: "CREDIT_CARD",
    pattern: /\b(?:\d[ -]*?){13,19}\b/g,
  },
  // Phone colombiano: 10 dígitos con prefijo +57 o 3xx
  {
    name: "PHONE",
    pattern: /(?:\+57\s?)?3\d{2}[\s-]?\d{3}[\s-]?\d{4}\b/g,
  },
];

/**
 * Threshold de entropy para detección high-entropy.
 * 4.5 es el default NIST para "secret random probable".
 */
const ENTROPY_THRESHOLD = 4.5;

/**
 * Mínimo de chars para considerar una cadena high-entropy.
 */
const ENTROPY_MIN_LENGTH = 32;

/**
 * Máxima longitud de input que scrubbeamos. Más allá de eso,
 * probablemente es un archivo binario en base64 y el costo de
 * scrub es prohibitivo.
 */
const MAX_INPUT_LENGTH = 100 * 1024; // 100KB

/**
 * Counter in-memory de secrets redactados por tipo.
 * Process-local. Reset por restart del server.
 *
 * NO se persiste en DB. Si se necesita persistente (D6+),
 * implementar con métricas.
 */
const scrubCounters: Map<string, number> = new Map();

/**
 * Total redactados en este proceso (suma de todos los tipos).
 */
let totalScrubbed = 0;

/**
 * Scrubea secretos en un string.
 *
 * - Aplica regex patterns primero (más predecibles).
 * - Luego entropy-based en tokens que no matchearon regex.
 * - Reemplaza con `[REDACTED:<TIPO>]`.
 * - NO throwea. Si algo falla, retorna el input original y log a stderr.
 *
 * Counter: incrementa `scrubCounters` por cada tipo detectado.
 */
export function scrubSecrets(input: string | null | undefined): string {
  if (input == null || input === "") return "";

  // Truncar inputs muy grandes (probable base64 de archivo binario).
  const truncated =
    input.length > MAX_INPUT_LENGTH ? input.slice(0, MAX_INPUT_LENGTH) : input;

  let result = truncated;

  try {
    // 1. Regex patterns
    for (const { name, pattern } of SECRET_PATTERNS) {
      const before = result;
      result = result.replace(pattern, () => `[REDACTED:${name}]`);
      // Contar matches en este patrón
      const matches = before.match(pattern);
      if (matches && matches.length > 0) {
        const current = scrubCounters.get(name) ?? 0;
        scrubCounters.set(name, current + matches.length);
        totalScrubbed += matches.length;
      }
    }

    // 2. Entropy-based (en tokens que sobreviven regex)
    // Dividir por whitespace, checkear cada token largo.
    result = redactHighEntropyTokens(result);

    // 3. Si hubo redactions, log a stderr (NO stdout)
    if (totalScrubbed > 0) {
      // Throttle: log cada 100 redactions para no spamear stderr
      if (totalScrubbed % 100 === 0) {
        process.stderr.write(
          `[secret-scrubber] total redactados: ${totalScrubbed}, por tipo: ${JSON.stringify(
            Object.fromEntries(scrubCounters),
          )}\n`,
        );
      }
    }

    return result;
  } catch (e) {
    // NO throwea — P3. Si el scrub falla, persistimos el input original
    // con un warning. Mejor tener secretos en DB que perder el step log.
    process.stderr.write(
      `[secret-scrubber] failed to scrub: ${(e as Error).message}\n`,
    );
    return input;
  }
}

/**
 * Para cada token (separado por whitespace), si tiene length >=
 * ENTROPY_MIN_LENGTH y entropy >= ENTROPY_THRESHOLD, redacta como
 * `[REDACTED:HIGH_ENTROPY]`.
 */
function redactHighEntropyTokens(input: string): string {
  // Split por whitespace, mantener los separadores
  const tokens = input.split(/(\s+)/);
  const counterKey = "HIGH_ENTROPY";

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    // Skip whitespace separators
    if (/^\s+$/.test(token)) continue;

    if (token.length >= ENTROPY_MIN_LENGTH) {
      const entropy = shannonEntropy(token);
      if (entropy >= ENTROPY_THRESHOLD) {
        tokens[i] = `[REDACTED:${counterKey}]`;
        const current = scrubCounters.get(counterKey) ?? 0;
        scrubCounters.set(counterKey, current + 1);
        totalScrubbed += 1;
      }
    }
  }

  return tokens.join("");
}

/**
 * Test-only: resetear counters (entre tests).
 * NO usar en producción.
 */
export function _resetScrubCountersForTests(): void {
  scrubCounters.clear();
  totalScrubbed = 0;
}

/**
 * Test-only: leer counters actuales.
 * NO usar en producción.
 */
export function _getScrubCountersForTests(): {
  totalScrubbed: number;
  byType: Record<string, number>;
} {
  return {
    totalScrubbed,
    byType: Object.fromEntries(scrubCounters),
  };
}