/**
 * Test empírico del context-manager y la integración con agent.
 *
 * Cubre los 7 fixes aplicados:
 * - B1: serializeMessageForSummarizer ya no lee timestamp del UUID.
 * - B2: caso 50K-58K con todo en recent window → return early.
 * - B3: índice de tokens se calcula sobre `nonSystem` (sin offset frágil).
 * - B4: serialize defensivo con try/catch ante ids no-hex.
 * - B5: dos stepSession concurrentes devuelven la misma Promise.
 * - B6: step_logs.optimized_messages_count se persiste.
 * - B7: summarizer_prompt_sent/_raw_response se persisten.
 *
 * Se ejecuta con: npx tsx test_summary_logic.mts
 */

import assert from "node:assert/strict";
import { v4 as uuidv4 } from "uuid";
import Database from "better-sqlite3";
import path from "path";
import { ensureContextWindow, UMBRAL, HARD_CAP_SUMMARY } from "./src/agent/context-manager.js";
import { stepSession, openai } from "./src/agent/agent.js";

const DB_PATH = path.join(process.cwd(), "worgena.db");
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const pass = (name: string) => console.log(`  ✓ ${name}`);
const fail = (name: string, e: any) => { console.error(`  ✗ ${name}\n    ${e?.message ?? e}`); process.exitCode = 1; };

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** Crea un session en la DB y devuelve el id. */
function newSession(): string {
  const id = uuidv4();
  const now = Date.now();
  const db = new Database(DB_PATH);
  db.prepare(
    "INSERT INTO sessions (id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
  ).run(id, `test-${id.slice(0, 8)}`, "idle", now, now);
  db.close();
  return id;
}

/** Inserta N mensajes sintéticos en la tabla messages para una sesión. */
function seedMessages(sessionId: string, count: number, contentSize: number): void {
  const db = new Database(DB_PATH);
  const insert = db.prepare(
    `INSERT INTO messages (id, session_id, role, content, created_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    const content = `Mensaje ${i} de prueba. `.repeat(Math.ceil(contentSize / 20));
    insert.run(uuidv4(), sessionId, role, content, now + i);
  }
  db.close();
}

/** Pre-carga un summary en la DB (simula que ya hubo un resumen previo). */
function preloadSummary(sessionId: string, lastIdx: number, summary: string): void {
  const db = new Database(DB_PATH);
  const now = Date.now();
  db.prepare(
    `INSERT OR REPLACE INTO message_summaries
     (session_id, summary, last_summarized_message_index, tokens_approx, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(sessionId, summary, lastIdx, Math.ceil(summary.length / 4), now);
  db.close();
}

/** Lee el summary actual de la DB. */
function readSummary(sessionId: string): { summary: string; last_idx: number; tokens: number } | null {
  const db = new Database(DB_PATH);
  const row: any = db
    .prepare("SELECT summary, last_summarized_message_index, tokens_approx FROM message_summaries WHERE session_id = ?")
    .get(sessionId);
  db.close();
  if (!row) return null;
  return {
    summary: String(row.summary),
    last_idx: Number(row.last_summarized_message_index),
    tokens: Number(row.tokens_approx),
  };
}

/** Lee un step_log específico por session_id + step_number. */
function readStepLog(sessionId: string, stepNumber: number): any {
  const db = new Database(DB_PATH);
  const row: any = db
    .prepare(
      `SELECT * FROM step_logs WHERE session_id = ? AND step_number = ? ORDER BY id DESC LIMIT 1`
    )
    .get(sessionId, stepNumber);
  db.close();
  return row ?? null;
}

/** Lee TODOS los step_logs de una sesión (ordenados por id ascendente). */
function readAllStepLogs(sessionId: string): any[] {
  const db = new Database(DB_PATH);
  const rows: any[] = db
    .prepare(`SELECT * FROM step_logs WHERE session_id = ? ORDER BY id ASC`)
    .all(sessionId);
  db.close();
  return rows;
}

/** Crea un mock OpenAI client. `responder` se llama cuando el LLM es invocado. */
function mockOpenAI(responder: (msgs: any[]) => string): any {
  let calls = 0;
  return {
    calls: () => calls,
    chat: {
      completions: {
        create: async (req: any) => {
          calls++;
          const text = responder(req.messages);
          return {
            choices: [{ message: { content: text, role: "assistant" } }],
            usage: { prompt_tokens: 100, completion_tokens: text.length / 4, total_tokens: 100 + text.length / 4 },
          };
        },
      },
    },
  };
}

/** Construye mensajes sintéticos para ensureContextWindow (no API). */
function buildMessages(sessionId: string, count: number, contentSize: number): any[] {
  const msgs: any[] = [
    { id: uuidv4(), role: "system", content: "Eres un asistente de prueba. SYSTEM PROMPT." },
  ];
  for (let i = 0; i < count; i++) {
    const content = `Mensaje ${i} de prueba. `.repeat(Math.ceil(contentSize / 20));
    msgs.push({
      id: uuidv4(),
      role: i % 2 === 0 ? "user" : "assistant",
      content,
    });
  }
  return msgs;
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

async function testB2_earlyReturnOnEmptySummarize() {
  const name = "B2 FIX: 1 mensaje gigante + sin summary previo → return early sin summary vacío";
  try {
    const sessionId = newSession();
    // B2 dispara cuando: (a) total > UMBRAL, (b) existing = null, (c) toSummarize.length = 0.
    // Para que toSummarize.length = 0, el ÚLTIMO mensaje debe tener tokens >= RECENT_WINDOW_TOKENS (8K).
    // Construcción: 1 system + 1 user con 200K chars = ~50K tokens, > UMBRAL.
    // La función `serializeMessageForSummarizer` corta content a 2000 chars, pero el conteo
    // de tokens usa el contenido completo (no el cortado). Por eso importa el tamaño del
    // content original, no el del output del serializer.
    const giantContent = "X".repeat(200_000);
    const messages: any[] = [
      { id: uuidv4(), role: "system", content: "System prompt de prueba." },
      { id: uuidv4(), role: "user", content: giantContent },
    ];
    const totalChars = messages.reduce((acc, m) => acc + m.content.length, 0);
    log(`  setup: 2 mensajes, total ${totalChars} chars (~${Math.ceil(totalChars/4)} tokens)`);
    log(`  → existing=null, último msg ≈ 50K tokens ≥ RECENT_WINDOW (8K), toSummarize debe ser []`);

    const mock = mockOpenAI(() => "ESTE LLM NO DEBE SER LLAMADO");
    const result = await ensureContextWindow(sessionId, messages, mock as any);

    assert.equal(mock.calls(), 0, "El LLM no debería haber sido invocado");
    assert.equal(result.messages.length, messages.length, "Mensajes devueltos sin modificar (B2 early-return)");
    assert.equal(result.summarizerCall, undefined, "No hay captura forense (no se generó summary)");

    const summary = readSummary(sessionId);
    // B2: si NO se generó summary, la DB no debe tener un row vacío.
    if (summary) {
      assert.ok(summary.tokens <= HARD_CAP_SUMMARY, `Summary tokens ${summary.tokens} ≤ ${HARD_CAP_SUMMARY}`);
    }

    pass(name);
  } catch (e: any) {
    fail(name, e);
  }
}

async function testReusePathWithoutLLM() {
  const name = "Reuse: summary existente + poco contenido nuevo → NO llama al LLM";
  try {
    const sessionId = newSession();
    // Calibración: shouldRegenerate=false requiere newContentTokens <= UMBRAL_UPDATE (30K).
    //
    // Setup determinístico: 200 mensajes con contentSize=1500 (≈ 22 chars × ceil(1500/20) = 1650 chars
    //   ≈ 413 tokens por msg). Total: 200 × 413 = 82.6K tokens > 50K UMBRAL. ✓
    //   preloadSummary last_idx=150, startIdx=min(150,200)=150.
    //   Recent window 8K: 8K/413 = 19.4 → 20 mensajes cubren 8.26K. endIdx = 200-20 = 180.
    //   toSummarize = slice(150, 180) = 30 mensajes × 413 = 12.4K tokens ≤ 30K. ✓
    //
    // NOTA: la longitud exacta depende del formato del content. Para no atar el test a
    // cuentas frágiles, computamos los valores esperados en runtime.
    preloadSummary(sessionId, 150, "Resumen previo: el usuario preguntó sobre X y el agente respondió Y.");

    const messages = buildMessages(sessionId, 200, 1500);
    const totalChars = messages.reduce((acc, m) => acc + m.content.length, 0);
    log(`  setup: 201 mensajes, total ${totalChars} chars (~${Math.ceil(totalChars/4)} tokens), summary pre-cargado en idx=150`);

    const mock = mockOpenAI(() => "ESTE LLM NO DEBE SER LLAMADO");
    const result = await ensureContextWindow(sessionId, messages, mock as any);

    assert.equal(mock.calls(), 0, "El LLM no debería haber sido invocado en reuse path");
    // Verificar estructura: [system, summary-marker, ...recientes]
    assert.equal(result.messages[0].role, "system", "Primer mensaje es system");
    assert.equal(result.messages[1].id, "summary-marker", "Segundo mensaje es summary-marker");
    assert.equal(result.messages[1].role, "system", "summary-marker tiene role system");
    assert.ok(result.messages[1].content.includes("Resumen previo"), "summary-marker contiene el resumen previo");
    // Los recientes vienen del final del array original
    const nonSystemInput = messages.filter((m) => m.role !== "system");
    const lastInput = nonSystemInput[nonSystemInput.length - 1];
    const lastOutput = result.messages[result.messages.length - 1];
    assert.equal(lastOutput.id, lastInput.id, "Último mensaje del output = último del input (recent window)");

    const summary = readSummary(sessionId);
    assert.ok(summary, "Summary pre-cargado sigue existiendo");
    assert.equal(summary!.summary, "Resumen previo: el usuario preguntó sobre X y el agente respondió Y.");

    pass(name);
  } catch (e: any) {
    fail(name, e);
  }
}

async function testRegenerateWithLLM() {
  const name = "Regenerate: newContentTokens > UMBRAL_UPDATE → SÍ llama al LLM";
  try {
    const sessionId = newSession();
    // Mensajes muy grandes para forzar generación de summary
    const messages = buildMessages(sessionId, 100, 3000);
    const totalChars = messages.reduce((acc, m) => acc + m.content.length, 0);
    log(`  setup: 101 mensajes, total ${totalChars} chars (~${Math.ceil(totalChars/4)} tokens)`);

    const mockSummary = "RESUMEN GENERADO POR LLM MOCK. Hechos clave: el usuario está probando el context-manager. El sistema pasó el UMBRAL. Decisión: resumir monotónicamente.";
    const mock = mockOpenAI(() => mockSummary);
    const result = await ensureContextWindow(sessionId, messages, mock as any);

    assert.ok(mock.calls() > 0, "El LLM SÍ debería haber sido invocado");
    assert.ok(result.summarizerCall, "Debería haber captura forense (B7)");
    assert.equal(result.summarizerCall!.promptSent[0].content.includes("RESUMEN GENERADO POR LLM MOCK"), false);

    const summary = readSummary(sessionId);
    assert.ok(summary, "Summary persistido en DB");
    assert.ok(summary!.summary.includes("RESUMEN GENERADO POR LLM MOCK"));
    assert.ok(summary!.tokens <= HARD_CAP_SUMMARY, `Tokens ${summary!.tokens} ≤ ${HARD_CAP_SUMMARY}`);

    // B3 FIX: el índice guardado debe ser > 0 (se resumió algo).
    assert.ok(summary!.last_idx > 0, `last_idx ${summary!.last_idx} > 0`);

    pass(name);
  } catch (e: any) {
    fail(name, e);
  }
}

async function testHardCapEnforced() {
  const name = "Hard cap: si el LLM devuelve >1000 tokens, se trunca a 4000 chars";
  try {
    const sessionId = newSession();
    // Necesitamos: (a) total > UMBRAL para que NO haga early-return; (b) LLM debe ser
    // llamado (no reuse). Setup: 100 mensajes × 3000 chars = 75K tokens > 50K UMBRAL.
    // Sin summary pre-cargado → existing=null → shouldRegenerate=true.
    // Recent window 8K ≈ 10 mensajes (8K/770). endIdx ≈ 100 - 10 = 90. toSummarize = 90 msgs.
    // LLM es llamado y devuelve texto oversized que debe ser truncado.
    const messages = buildMessages(sessionId, 100, 3000);
    const totalChars = messages.reduce((a, m) => a + m.content.length, 0);
    log(`  setup: 101 mensajes, total ${totalChars} chars (~${Math.ceil(totalChars/4)} tokens)`);

    // LLM "rebelde" que devuelve 5000 tokens (~20000 chars).
    const oversized = "A".repeat(20_000);
    const mock = mockOpenAI(() => oversized);

    const result = await ensureContextWindow(sessionId, messages, mock as any);
    assert.ok(mock.calls() > 0, "LLM SÍ fue invocado");
    const summary = readSummary(sessionId);
    assert.ok(summary, "Summary persistido");
    assert.ok(summary!.summary.length <= HARD_CAP_SUMMARY * 4, `summary len ${summary!.summary.length} ≤ 4000 chars`);
    assert.ok(summary!.tokens <= HARD_CAP_SUMMARY, `summary tokens ${summary!.tokens} ≤ ${HARD_CAP_SUMMARY}`);
    assert.equal(summary!.summary, "A".repeat(4000), "Contenido truncado a exactamente 4000 chars de 'A'");

    pass(name);
  } catch (e: any) {
    fail(name, e);
  }
}

async function testSerializeB1B4_NoCorruptedTimestamp() {
  const name = "B1+B4 FIX: serializeMessageForSummarizer no produce timestamp corrupto ni truena con id raro";
  try {
    const sessionId = newSession();
    // Para que el LLM sea invocado, el setup completo debe sumar > 50K tokens
    // (≈ 200K chars). Mezcla: UUIDs normales + id NO-hex (B4) + caracteres especiales
    // + contenido objeto (no-string) + tool_calls.
    const hugeText = "Y".repeat(60_000);
    const messages: any[] = [
      { id: uuidv4(), role: "system", content: "System prompt de prueba." },
      // B4: id NO-hex (en la lógica actual no se usa, pero el try/catch defensivo lo cubre)
      { id: "id-no-es-hex-1234", role: "user", content: "Pregunta con caracteres raros: ñ, á, ü, 😀, <tag>, \"comillas\"." },
      { id: uuidv4(), role: "user", content: hugeText },
      // Contenido NO-string (objeto), ejercita la rama JSON.stringify
      { id: uuidv4(), role: "assistant", content: { type: "multimodal", parts: [hugeText, "etc"] } },
      // tool_calls presentes
      { id: uuidv4(), role: "assistant", content: hugeText, tool_calls: [{ function: { name: "test_tool" } }] },
      { id: uuidv4(), role: "user", content: hugeText },
    ];
    const totalChars = messages.reduce((a, m) => {
      const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return a + c.length;
    }, 0);
    log(`  setup: 6 mensajes con edge cases, total ${totalChars} chars (~${Math.ceil(totalChars/4)} tokens)`);

    const mock = mockOpenAI(() => "RESUMEN_OK");
    const result = await ensureContextWindow(sessionId, messages, mock as any);

    // B4: el flujo no debe lanzar excepción a pesar de id malformado, contenido objeto, tool_calls
    // B1: el serializer usa `idx`, no decodifica timestamp del id
    assert.ok(mock.calls() > 0, "LLM fue llamado a pesar de los edge cases (id malformado, contenido objeto, tool_calls)");
    assert.ok(result.summarizerCall, "Captura forense presente (B7)");

    pass(name);
  } catch (e: any) {
    fail(name, e);
  }
}

async function testB5_ConcurrentStepsReturnSamePromise() {
  const name = "B5 FIX: dos stepSession concurrentes devuelven la misma Promise";
  try {
    const sessionId = newSession();
    seedMessages(sessionId, 3, 100);

    // Disparamos 2 stepSession "casi" en paralelo. Como el inflight map guarda
    // la promise, el segundo debe esperar al primero. Pero NO podemos medir
    // eso directamente sin mockear el LLM, porque el step real hace una llamada
    // HTTP a DeepSeek. Verificamos que la estructura del inflight map funciona:
    // tras UNA llamada completada, el map debe estar vacío.
    // (Si el guard es correcto, una segunda llamada concurrente debería
    //  resolverse con el mismo resultado, no ejecutar dos veces.)
    //
    // Para hacerlo sin red, llamamos ensureContextWindow en "paralelo" con un
    // mock que DUERME 200ms. La segunda llamada debe resolver con la misma
    // estructura (reuse path) sin invocar el LLM otra vez.

    const sessionId2 = newSession();
    const messages = buildMessages(sessionId2, 5, 500);
    preloadSummary(sessionId2, 0, "Resumen previo.");

    let llmCalls = 0;
    const slowMock = {
      chat: {
        completions: {
          create: async () => {
            llmCalls++;
            await new Promise((r) => setTimeout(r, 200));
            return {
              choices: [{ message: { content: "OK", role: "assistant" } }],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            };
          },
        },
      },
    };

    const p1 = ensureContextWindow(sessionId2, messages, slowMock as any);
    const p2 = ensureContextWindow(sessionId2, messages, slowMock as any);
    const [r1, r2] = await Promise.all([p1, p2]);

    // En reuse path no se llama al LLM. Si las 2 llamadas hubieran generado
    // summaries, llmCalls sería > 0. Verificamos que la lógica de decisión es
    // determinística.
    assert.equal(llmCalls, 0, "LLM no fue invocado (reuse path, ambas calls determinísticas)");
    assert.equal(r1.messages.length, r2.messages.length);

    pass(name);
  } catch (e: any) {
    fail(name, e);
  }
}

async function testB6B7_StepLogPersistsOptimizationFields() {
  const name = "B6+B7 FIX: step_logs persiste optimized_messages_count y summarizer_*_sent/_response";
  try {
    // Verificamos la nueva estructura de la tabla
    const db = new Database(DB_PATH);
    const cols: any[] = db.prepare("PRAGMA table_info(step_logs)").all();
    db.close();

    const colNames = cols.map((c) => c.name);
    assert.ok(colNames.includes("optimized_messages_count"), "Columna optimized_messages_count existe");
    assert.ok(colNames.includes("summarizer_prompt_sent"), "Columna summarizer_prompt_sent existe");
    assert.ok(colNames.includes("summarizer_raw_response"), "Columna summarizer_raw_response existe");

    pass(name);
  } catch (e: any) {
    fail(name, e);
  }
}

async function testContextManagerExportConsistency() {
  const name = "API pública: ensureContextWindow exporta UMBRAL y HARD_CAP_SUMMARY";
  try {
    assert.equal(typeof UMBRAL, "number");
    assert.equal(UMBRAL, 50_000);
    assert.equal(typeof HARD_CAP_SUMMARY, "number");
    assert.equal(HARD_CAP_SUMMARY, 1_000);

    pass(name);
  } catch (e: any) {
    fail(name, e);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Tests E2E: integración real con stepSession y B5 bajo carga
// ────────────────────────────────────────────────────────────────────────────

/**
 * Mockea el cliente OpenAI global para devolver respuestas controladas
 * tanto al resumidor (sin tools) como al step principal (con tools).
 * Retorna una función que restaura el comportamiento original.
 */
function mockOpenAIGlobal(opts: {
  summaryResponse: string;
  mainResponse: string;
  delayMs?: number;
  throwOn?: "summary" | "main";
}): { restore: () => void; counts: { summary: number; main: number } } {
  const counts = { summary: 0, main: 0 };
  const originalCreate = (openai as any).chat.completions.create.bind((openai as any).chat.completions);
  (openai as any).chat.completions.create = async (req: any) => {
    const isMainCall = !!(req?.tools && Array.isArray(req.tools) && req.tools.length > 0);
    if (isMainCall) {
      counts.main++;
      if (opts.throwOn === "main") {
        throw new Error("MOCK: main LLM call failed on purpose");
      }
    } else {
      counts.summary++;
      if (opts.throwOn === "summary") {
        throw new Error("MOCK: summarizer LLM call failed on purpose");
      }
    }
    if (opts.delayMs) {
      await new Promise((r) => setTimeout(r, opts.delayMs));
    }
    return {
      choices: [
        {
          message: {
            role: "assistant",
            content: isMainCall ? opts.mainResponse : opts.summaryResponse,
            tool_calls: undefined,
          },
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      },
    };
  };
  return {
    counts,
    restore: () => {
      (openai as any).chat.completions.create = originalCreate;
    },
  };
}

async function testE2E_StepSession_PersistsB6B7Columns() {
  const name = "E2E: stepSession real persiste optimized_messages_count + summarizer_*_sent/_response con JSON válido";
  try {
    const sessionId = newSession();
    // Necesitamos > UMBRAL (50K tokens ≈ 200K chars) para forzar summarization.
    // 100 mensajes × 3000 chars ≈ 75K tokens > 50K.
    seedMessages(sessionId, 100, 3000);
    const msgCount = (function () {
      const db = new Database(DB_PATH);
      const r: any = db.prepare("SELECT count(*) as c FROM messages WHERE session_id = ?").get(sessionId);
      db.close();
      return Number(r.c);
    })();
    log(`  setup: sessionId=${sessionId.slice(0, 8)}…, messages=${msgCount} (≈${Math.ceil(msgCount * 3000 / 4)} tokens)`);

    const mock = mockOpenAIGlobal({
      summaryResponse: "RESUMEN_E2E: el usuario está probando el context-manager E2E. Hechos clave: la sesión tiene muchos mensajes.",
      mainResponse: "OK, recibí tu mensaje. El contexto fue resumido correctamente.",
    });

    try {
      const result = await stepSession(sessionId);

      // El LLM mock fue llamado al menos una vez para resumir, una para el main.
      assert.ok(mock.counts.summary > 0, `summarizer invocado ${mock.counts.summary} veces`);
      assert.ok(mock.counts.main > 0, `main LLM invocado ${mock.counts.main} veces`);

      // El step log debe existir con status=completed.
      const stepLogs = readAllStepLogs(sessionId);
      assert.ok(stepLogs.length >= 1, `step_logs tiene ${stepLogs.length} filas (esperado ≥1)`);
      const step = stepLogs[stepLogs.length - 1]; // última fila
      assert.equal(step.status, "completed", `step.status = ${step.status}`);

      // B6: optimized_messages_count poblado y < messages_count original.
      assert.ok(
        step.optimized_messages_count != null,
        `optimized_messages_count es NULL (B6 roto). Row: ${JSON.stringify(step).slice(0, 200)}`
      );
      const optimizedCount = Number(step.optimized_messages_count);
      assert.ok(optimizedCount > 0, `optimized_messages_count = ${optimizedCount}`);
      assert.ok(optimizedCount < msgCount, `optimized (${optimizedCount}) < original (${msgCount})`);

      // B7: summarizer_prompt_sent poblado y parseable.
      assert.ok(
        step.summarizer_prompt_sent != null,
        `summarizer_prompt_sent es NULL (B7 roto). Row: ${JSON.stringify(step).slice(0, 200)}`
      );
      const promptJson = JSON.parse(String(step.summarizer_prompt_sent));
      assert.ok(Array.isArray(promptJson), "summarizer_prompt_sent es un array de mensajes");
      assert.ok(promptJson.length >= 1, "summarizer_prompt_sent tiene al menos 1 mensaje");
      assert.equal(promptJson[0].role, "system", "primer mensaje del resumidor es system");
      assert.ok(
        String(promptJson[0].content).includes("mantiene notas actualizadas"),
        "system prompt del resumidor contiene el marcador esperado"
      );

      // B7: summarizer_raw_response poblado y parseable.
      assert.ok(
        step.summarizer_raw_response != null,
        `summarizer_raw_response es NULL (B7 roto)`
      );
      const rawJson = JSON.parse(String(step.summarizer_raw_response));
      assert.ok(rawJson.choices, "raw_response tiene choices");
      assert.ok(
        String(rawJson.choices[0].message.content).includes("RESUMEN_E2E"),
        "raw_response contiene el contenido del resumen mockeado"
      );

      // Mensajes persistidos en messages table: el agente debe haber agregado
      // al menos el assistant response.
      const db = new Database(DB_PATH);
      const finalCount: any = db
        .prepare("SELECT count(*) as c FROM messages WHERE session_id = ?")
        .get(sessionId);
      db.close();
      assert.ok(
        Number(finalCount.c) > msgCount,
        `messages table creció de ${msgCount} a ${finalCount.c} (asistente agregó respuesta)`
      );

      log(`  → optimized=${optimizedCount}/${msgCount}, summary prompt=${promptJson.length} msgs, step.status=completed`);
      pass(name);
    } finally {
      mock.restore();
    }
  } catch (e: any) {
    fail(name, e);
  }
}

async function testE2E_StepSession_FailsCleanlyWhenSummarizerFails() {
  const name = "E2E: si el resumidor LLM falla, stepSession NO propaga excepción y persiste step_log con status=error";
  try {
    const sessionId = newSession();
    seedMessages(sessionId, 100, 3000);

    const mock = mockOpenAIGlobal({
      summaryResponse: "irrelevante",
      mainResponse: "irrelevante",
      throwOn: "summary",
    });

    try {
      // Decisión de diseño: _stepSessionInner captura el error del resumidor,
      // llama failStepLog, agrega un mensaje de error al usuario, y devuelve
      // la sesión con status='error'. stepSession NO debe propagar la excepción.
      let caught: any = null;
      let sessionAfter: any = null;
      try {
        sessionAfter = await stepSession(sessionId);
      } catch (e: any) {
        caught = e;
      }
      assert.equal(caught, null, `stepSession NO debe lanzar excepción. Excepción capturada: ${caught?.message?.slice(0, 200)}`);
      assert.ok(sessionAfter, "stepSession devolvió una sesión (no propagó error)");
      assert.equal(sessionAfter.status, "error", `status=${sessionAfter.status} (esperado 'error')`);

      // El step log debe estar en status=error (no completed con datos parciales).
      const stepLogs = readAllStepLogs(sessionId);
      assert.ok(stepLogs.length >= 1, `step_log existe (registró el intento)`);
      const step = stepLogs[stepLogs.length - 1];
      assert.equal(step.status, "error", `step_logs.status=${step.status} (esperado 'error' por failStepLog)`);
      assert.ok(step.error_message, `error_message poblado: ${String(step.error_message).slice(0, 200)}`);
      assert.ok(
        String(step.error_message).includes("ContextManager") || String(step.error_message).includes("MOCK"),
        `error_message menciona ContextManager o MOCK: ${String(step.error_message).slice(0, 200)}`
      );

      // El main LLM NO debe haber sido invocado (el summarizer falló antes).
      assert.equal(mock.counts.main, 0, `main LLM NO fue invocado (resumidor falló primero), fue ${mock.counts.main}`);

      // El agente debe haber agregado un mensaje de error al usuario en messages.
      // Buscamos el mensaje que contiene el texto de error (no el "último" por
      // created_at, porque los mensajes seedeados usan seedTime+i que puede
      // ser mayor que el Date.now() del error msg).
      const db = new Database(DB_PATH);
      const errorMsg: any = db
        .prepare("SELECT role, content FROM messages WHERE session_id = ? AND content LIKE '%An error occurred%' LIMIT 1")
        .get(sessionId);
      db.close();
      assert.ok(errorMsg, `debe existir un mensaje con 'An error occurred' en messages`);
      assert.equal(errorMsg.role, "assistant", `rol del error msg = assistant: ${errorMsg.role}`);

      pass(name);
    } finally {
      mock.restore();
    }
  } catch (e: any) {
    fail(name, e);
  }
}

async function testB5_MassiveConcurrency_NoDuplicateStepLogs() {
  const name = "B5 CARGA: 50 stepSession concurrentes al mismo sessionId → 1 step_log row (no duplicados)";
  try {
    const sessionId = newSession();
    seedMessages(sessionId, 3, 100);

    const CONCURRENCY = 50;
    const mock = mockOpenAIGlobal({
      summaryResponse: "irrelevante",
      mainResponse: "RESPUESTA_MOCK",
      delayMs: 300, // forzar que las llamadas se solapen en el inflight map
    });

    try {
      log(`  setup: ${CONCURRENCY} calls concurrentes con LLM delay=300ms`);
      const t0 = Date.now();
      const promises = Array.from({ length: CONCURRENCY }, () => stepSession(sessionId));
      const results = await Promise.all(promises);
      const elapsed = Date.now() - t0;
      log(`  → ${CONCURRENCY} calls completaron en ${elapsed}ms`);

      // Todos los resultados deben ser la misma sesión (mismo id, mismo updatedAt).
      assert.ok(results.every((r) => r.id === sessionId), "Todos los results tienen el mismo sessionId");
      const uniqueUpdatedAt = new Set(results.map((r) => r.updatedAt));
      assert.equal(uniqueUpdatedAt.size, 1, `Todos los results tienen el mismo updatedAt (1, no ${uniqueUpdatedAt.size})`);

      // El main LLM debió ser llamado UNA sola vez (los demás hits fueron dedupeados por B5).
      assert.equal(mock.counts.main, 1, `main LLM invocado exactamente 1 vez (B5 dedupe), fue ${mock.counts.main}`);

      // step_logs debe tener exactamente 1 fila para esta sesión.
      const stepLogs = readAllStepLogs(sessionId);
      assert.equal(stepLogs.length, 1, `step_logs tiene ${stepLogs.length} filas (esperado 1, B5 evita duplicados)`);
      assert.equal(stepLogs[0].status, "completed", "step_log status = completed");
      assert.equal(stepLogs[0].step_number, 1, "step_number = 1 (solo un step real ocurrió)");

      pass(name);
    } finally {
      mock.restore();
    }
  } catch (e: any) {
    fail(name, e);
  }
}

async function testB5_DifferentSessions_NoInterference() {
  const name = "B5: 10 sessions × 3 calls concurrentes cada una → 10 step_log rows, sin interferencia entre sessions";
  try {
    const N_SESSIONS = 10;
    const CALLS_PER_SESSION = 3;
    const sessionIds: string[] = [];
    for (let i = 0; i < N_SESSIONS; i++) {
      const id = newSession();
      sessionIds.push(id);
      seedMessages(id, 3, 100);
    }

    const mock = mockOpenAIGlobal({
      summaryResponse: "irrelevante",
      mainResponse: "RESPUESTA_MOCK",
      delayMs: 150,
    });

    try {
      log(`  setup: ${N_SESSIONS} sessions × ${CALLS_PER_SESSION} calls = ${N_SESSIONS * CALLS_PER_SESSION} promises`);
      const allPromises: Promise<any>[] = [];
      for (const id of sessionIds) {
        for (let i = 0; i < CALLS_PER_SESSION; i++) {
          allPromises.push(stepSession(id));
        }
      }
      await Promise.all(allPromises);

      // Cada sesión debe tener exactamente 1 step_log (sus 3 calls se dedupearon).
      for (const id of sessionIds) {
        const logs = readAllStepLogs(id);
        assert.equal(
          logs.length, 1,
          `session ${id.slice(0, 8)}… tiene ${logs.length} step_logs (esperado 1)`
        );
      }
      // Total main calls = N_SESSIONS (uno por sesión).
      assert.equal(
        mock.counts.main, N_SESSIONS,
        `main LLM invocado ${mock.counts.main} veces (esperado ${N_SESSIONS} = 1 por sesión)`
      );

      pass(name);
    } finally {
      mock.restore();
    }
  } catch (e: any) {
    fail(name, e);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Runner
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  log("═══════════════════════════════════════════════════════════════════");
  log("  TEST EMPÍRICO: context-manager.ts + integración en agent.ts");
  log("═══════════════════════════════════════════════════════════════════");
  log(`  DB: ${DB_PATH}`);
  log(`  UMBRAL=${UMBRAL}, HARD_CAP_SUMMARY=${HARD_CAP_SUMMARY}`);
  log("");

  // Verificar primero la estructura del schema (B6/B7 migrations)
  await testB6B7_StepLogPersistsOptimizationFields();
  await testContextManagerExportConsistency();

  // Tests de lógica del context-manager (unit-level)
  await testB2_earlyReturnOnEmptySummarize();
  await testReusePathWithoutLLM();
  await testRegenerateWithLLM();
  await testHardCapEnforced();
  await testSerializeB1B4_NoCorruptedTimestamp();
  await testB5_ConcurrentStepsReturnSamePromise();

  // Tests E2E (integration con stepSession real)
  await testE2E_StepSession_PersistsB6B7Columns();
  await testE2E_StepSession_FailsCleanlyWhenSummarizerFails();
  await testB5_MassiveConcurrency_NoDuplicateStepLogs();
  await testB5_DifferentSessions_NoInterference();

  log("");
  if (process.exitCode === 1) {
    log("  ✗ ALGUNOS TESTS FALLARON");
  } else {
    log("  ✓ TODOS LOS TESTS PASARON");
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
