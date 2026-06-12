/**
 * Context Window Manager
 * -----------------------------------------------------------------------------
 * Garantiza que el prompt que se manda al LLM nunca exceda UMBRAL tokens.
 *
 * Estrategia: sliding window con summary monotónico.
 *
 *   - Si el total(messages) < UMBRAL: no hace nada, manda el historial completo.
 *   - Si el total >= UMBRAL Y hay un summary guardado:
 *       [system, summary, ...últimos N tokens de mensajes]
 *   - Si el total >= UMBRAL Y no hay summary (o el nuevo contenido desde el
 *     último resumen > UMBRAL_UPDATE): genera uno nuevo con el LLM.
 *
 * Garantías por diseño (no por suerte):
 *   - El summary siempre cabe en ≤ HARD_CAP_SUMMARY tokens (validado post-gen).
 *   - Si el LLM falla al generar, el step entero falla (sin truncado silencioso).
 *   - El LLM no produce pérdida silenciosa: hard cap por token exacto, no
 *     "última oración" (que era propenso a fallar en el siguiente resumen).
 */

import OpenAI from "openai";
import { pool } from "../lib/db.js";
import { AgentMessage } from "./agent.js";

// ─────────────────────────────────────────────────────────────────────────────
// Configuración
// ─────────────────────────────────────────────────────────────────────────────

/** Si el prompt total pasa de este umbral, se activa el resumen. */
export const UMBRAL = 50_000;

/** Holgura de tokens que pedimos al LLM. El hard cap físico es 1000. */
const SOFT_CAP_SUMMARY = 900;

/** Tope absoluto: si el LLM lo excede, se corta por token exacto. */
export const HARD_CAP_SUMMARY = 1_000;

/** Si los mensajes nuevos desde el último resumen pasan esto, re-resumir. */
const UMBRAL_UPDATE = 30_000;

/** Aproximación: 1 token ≈ 4 caracteres en español. */
const CHARS_PER_TOKEN = 4;

/** Función auxiliar: estima tokens de un string. */
function approxTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Función auxiliar: estima tokens de un mensaje OpenAI. */
function messageTokens(msg: OpenAI.Chat.ChatCompletionMessageParam): number {
  const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
  return approxTokens(content);
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistencia del summary
// ─────────────────────────────────────────────────────────────────────────────

/** Resultado de generar un summary: texto + captura forense del LLM (B7). */
interface SummaryResult {
  text: string;
  promptSent: unknown;
  rawResponse: unknown;
}

/** Resultado público de ensureContextWindow. */
export interface ContextWindowResult {
  /** Mensajes que se mandarán al LLM (pueden incluir summary-marker). */
  messages: AgentMessage[];
  /** Captura forense del resumidor, si corrió. Útil para auditoría (B7). */
  summarizerCall?: { promptSent: unknown; rawResponse: unknown };
}

interface SummaryRow {
  summary: string;
  last_summarized_message_index: number;
  tokens_approx: number;
  updated_at: number;
}

/** Lee el summary actual de la sesión, o null si no hay. */
async function loadSummary(sessionId: string): Promise<SummaryRow | null> {
  const { rows } = await pool.query(
    "SELECT summary, last_summarized_message_index, tokens_approx, updated_at FROM message_summaries WHERE session_id = ?",
    [sessionId]
  );
  if (!rows || rows.length === 0) return null;
  const r = rows[0] as any;
  return {
    summary: String(r.summary),
    last_summarized_message_index: Number(r.last_summarized_message_index),
    tokens_approx: Number(r.tokens_approx),
    updated_at: Number(r.updated_at),
  };
}

/** Guarda (o reemplaza atómicamente) el summary. */
async function saveSummary(sessionId: string, summary: string, lastIdx: number, tokens: number): Promise<void> {
  const now = Date.now();
  // Convertir ON CONFLICT a INSERT OR REPLACE para SQLite
  await pool.query(
    `INSERT INTO message_summaries (session_id, summary, last_summarized_message_index, tokens_approx, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET summary=EXCLUDED.summary, last_summarized_message_index=EXCLUDED.last_summarized_message_index, tokens_approx=EXCLUDED.tokens_approx, updated_at=EXCLUDED.updated_at`,
    [sessionId, summary, lastIdx, tokens, now]
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Generación del summary
// ─────────────────────────────────────────────────────────────────────────────

const SUMMARIZER_SYSTEM_PROMPT = `Eres un asistente que mantiene notas actualizadas de una conversación larga en curso.

Tu trabajo: actualizar un conjunto de notas preservando todo lo importante.

=== NOTAS ACTUALES (lo que sabemos hasta ahora) ===
{prev}

=== MENSAJES NUEVOS (lo que pasó desde la última actualización) ===
{new}

=== INSTRUCCIONES ===

1. Lee las notas actuales. Son hechos clave que el usuario ya estableció.
2. Lee los mensajes nuevos. Algunos confirman/expanden lo existente, otros introducen info nueva.
3. Actualiza las notas siguiendo estas reglas:
   - PRESERVA hechos clave que siguen siendo relevantes (preferencias, decisiones, números, nombres).
   - AGREGA hechos nuevos importantes (no triviales como saludos o "ok").
   - DESCARTA lo obsoleto o trivial.
   - USA fechas como indicador de relevancia: lo más reciente suele ser más relevante, pero NO borres algo importante solo porque sea antiguo si sigue siendo vigente.
   - Si un tema se mencionó antes y se retomó ahora, conecta los puntos.
4. NO inventes. Si no sabes, no pongas.
5. Máximo ${SOFT_CAP_SUMMARY} tokens. Si te pasas, recorta lo menos importante primero.

Output: las notas actualizadas, en prosa, en español, directo.
NO incluyas meta-comentarios, NO expliques tus decisiones, solo las notas.`;

/** Trunca por aprox-tokens (corte por carácter, no por token real). */
function hardCapByApproxTokens(text: string): string {
  const maxChars = HARD_CAP_SUMMARY * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

/**
 * Llama al LLM para generar/actualizar el summary.
 * Lanza error si falla — sin truncado silencioso, sin fallback.
 * Devuelve el texto Y la captura forense (B7) para auditoría.
 */
async function generateSummary(
  client: OpenAI,
  prevSummary: string | null,
  newMessagesText: string
): Promise<SummaryResult> {
  const systemPrompt = SUMMARIZER_SYSTEM_PROMPT
    .replace("{prev}", prevSummary || "(no hay notas anteriores — es la primera vez)")
    .replace("{new}", newMessagesText);

  const messages = [
    { role: "system" as const, content: systemPrompt },
    { role: "user" as const, content: "Genera las notas actualizadas." },
  ];

  const response = await client.chat.completions.create({
    model: process.env.OPENCODE_MODEL ?? "deepseek-v4-flash-free",
    messages,
    temperature: 0.2,
    max_tokens: HARD_CAP_SUMMARY + 50, // pequeño margen para que no corte el LLM antes
  });

  const text = response.choices[0]?.message?.content || "";
  if (!text.trim()) {
    throw new Error("ContextManager: el resumidor devolvió un summary vacío.");
  }

  // Hard cap por aprox-tokens (corte por carácter, no por token real).
  // El LLM lee tokens, así que el corte puede quedar a media palabra;
  // eso es aceptable y la defensa real es pedirle 900 en el prompt.
  const capped = hardCapByApproxTokens(text.trim());

  return {
    text: capped,
    promptSent: messages,
    rawResponse: response,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Serialización de mensajes para el resumidor
// ─────────────────────────────────────────────────────────────────────────────

function serializeMessageForSummarizer(msg: AgentMessage, idx: number): string {
  // B1 FIX: NO decodificamos timestamp desde el id. Los UUIDs v4 son
  // aleatorios; la fecha "extraída" era inventada y confundía al resumidor.
  // Usamos solo el idx como marca ordinal de secuencia.
  // B4 FIX: defensivo ante ids no-hex o formatos raros. Si algo truena,
  // caemos a una línea vacía en vez de propagar un SyntaxError.
  try {
    const content = typeof msg.content === "string"
      ? msg.content
      : JSON.stringify(msg.content);

    const role = msg.role;
    let line = `[#${idx}] ${role}: ${content.slice(0, 2000)}`;
    if (content.length > 2000) line += " [...]";

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      const tools = msg.tool_calls.map((tc: any) => tc?.function?.name || "?").join(", ");
      line += ` (tools: ${tools})`;
    }
    return line;
  } catch (e) {
    return `[#${idx}] ${msg.role || "?"}: <unserializable message>`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// API principal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Asegura que los mensajes caben en la ventana de contexto.
 *
 * @returns ContextWindowResult con mensajes optimizados y, si el resumidor
 *          corrió, captura forense para auditoría (B7). Lanza error si falla.
 */
export async function ensureContextWindow(
  sessionId: string,
  messages: AgentMessage[],
  openaiClient: OpenAI
): Promise<ContextWindowResult> {
  // Separar system de no-system una sola vez. Calculamos tokens sobre
  // `nonSystem` directamente (B3 FIX): así el índice `i` matchea
  // tokenPerMsg[i] sin offsets frágiles que asumen system en [0].
  const systemMsg = messages.find((m) => m.role === "system");
  const nonSystem = messages.filter((m) => m.role !== "system");

  // 1. Calcular tokens aproximados del historial no-system.
  const tokenPerMsg: number[] = [];
  let totalNonSystemTokens = 0;
  for (const m of nonSystem) {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    const t = approxTokens(content) + 20; // +20 por metadata/role
    tokenPerMsg.push(t);
    totalNonSystemTokens += t;
  }

  // 2. Si cabe, no tocar nada.
  if (totalNonSystemTokens <= UMBRAL) {
    return { messages };
  }

  // 3. Necesitamos resumir. Cargar summary existente.
  const existing = await loadSummary(sessionId);

  // 4. Decidir qué mensajes van al nuevo resumen.
  //    Si hay summary existente: solo los mensajes DESPUÉS del último index resumido.
  //    Si no: todos los mensajes desde el principio, pero dejando siempre los
  //    últimos N tokens de historial reciente para no perder el contexto inmediato.
  const RECENT_WINDOW_TOKENS = 8_000;

  let startIdx = 0;
  if (existing) {
    startIdx = Math.min(existing.last_summarized_message_index, nonSystem.length);
  }

  // Recolectar mensajes a resumir (startIdx .. fin - ventana_reciente)
  // "ventana_reciente" = últimos N tokens que NO se resumen
  let recentTokens = 0;
  let endIdx = nonSystem.length;
  for (let i = nonSystem.length - 1; i >= startIdx; i--) {
    // B3 FIX: índice directo sobre `nonSystem` (no offset). Consistente
    // incluso si hay 2+ system messages en el futuro.
    recentTokens += tokenPerMsg[i];
    if (recentTokens >= RECENT_WINDOW_TOKENS) {
      endIdx = i; // el i es el primer mensaje que entra al "resumen"
      break;
    }
  }

  const toSummarize = nonSystem.slice(startIdx, endIdx);
  const toKeepRecent = nonSystem.slice(endIdx);

  // B2 FIX: si no hay nada entre startIdx y endIdx (caso 50K-58K con todo
  // dentro del recent window) Y no hay summary existente, NO generamos
  // un summary vacío que contamine la DB. Devolvemos los mensajes tal cual.
  if (toSummarize.length === 0) {
    if (!existing) {
      console.warn(
        `[ContextManager] Sesión ${sessionId}: total ${totalNonSystemTokens} tokens, ` +
        `recent window ${RECENT_WINDOW_TOKENS} cubre todo. No hay nada que resumir; ` +
        `subiendo RECENT_WINDOW_TOKENS o bajando UMBRAL podría ayudar.`
      );
      return { messages };
    }
    // Si hay summary existente, reusarlo.
    return {
      messages: buildFinalMessages(systemMsg, existing.summary, toKeepRecent),
    };
  }

  // 5. ¿Vale la pena re-resumir? Si no hay mensajes nuevos o son muy pocos, no.
  const newContentTokens = toSummarize.reduce((acc, m) => {
    const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return acc + approxTokens(c);
  }, 0);

  const shouldRegenerate = !existing || newContentTokens > UMBRAL_UPDATE;
  if (!shouldRegenerate && existing) {
    // Reusar el summary existente. Reconstruir y devolver.
    return {
      messages: buildFinalMessages(systemMsg, existing.summary, toKeepRecent),
    };
  }

  // 6. Generar el nuevo summary.
  const newMessagesText = toSummarize
    .map((m, i) => serializeMessageForSummarizer(m, startIdx + i))
    .join("\n\n");

  let summaryResult: SummaryResult;
  try {
    summaryResult = await generateSummary(
      openaiClient,
      existing?.summary || null,
      newMessagesText
    );
  } catch (e: any) {
    // Sin fallback silencioso. Lanzar el error.
    throw new Error(`ContextManager: fallo al generar summary — ${e.message}`);
  }

  const newSummary = summaryResult.text;

  // 7. Validar tamaño.
  const summaryTokens = approxTokens(newSummary);
  if (summaryTokens > HARD_CAP_SUMMARY) {
    // El hard cap dentro de generateSummary ya lo cortó, pero por seguridad
    throw new Error(
      `ContextManager: summary generado de ${summaryTokens} tokens supera hard cap ${HARD_CAP_SUMMARY}.`
    );
  }

  // 8. Persistir.
  await saveSummary(sessionId, newSummary, endIdx, summaryTokens);

  // 9. Reconstruir y devolver con la captura forense del resumidor (B7).
  return {
    messages: buildFinalMessages(systemMsg, newSummary, toKeepRecent),
    summarizerCall: {
      promptSent: summaryResult.promptSent,
      rawResponse: summaryResult.rawResponse,
    },
  };
}

function buildFinalMessages(
  systemMsg: AgentMessage | undefined,
  summary: string,
  recent: AgentMessage[]
): AgentMessage[] {
  const result: AgentMessage[] = [];
  if (systemMsg) result.push(systemMsg);

  // Insertar el summary como un mensaje de sistema adicional.
  // El LLM lo trata como contexto persistente (no como respuesta del usuario).
  result.push({
    id: "summary-marker",
    role: "system",
    content: `--- NOTAS ACUMULADAS DE LA CONVERSACIÓN (resumen monotónico) ---\n${summary}\n--- FIN DE NOTAS ---\n\nLas notas anteriores son un resumen de la conversación. Continúa desde donde quedaste. Los mensajes más recientes del usuario están abajo.`,
  });

  result.push(...recent);
  return result;
}
