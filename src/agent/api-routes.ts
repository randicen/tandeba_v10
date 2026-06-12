/**
 * api-routes.ts
 * -----------------------------------------------------------------------------
 * Router de los endpoints AI que NO pasan por el context-manager.
 *
 * A diferencia de `stepSession` (que mantiene memoria conversacional, dispara
 * tools, hace resúmenes), estos 2 endpoints son stateless: cada request es
 * independiente, no hay sesión que resumir.
 *
 *   POST /api/ai/chat         → chat con el editor de documentos.
 *                                Devuelve { reply, edits? } donde edits son
 *                                modificaciones puntuales al HTML del documento.
 *
 *   POST /api/ai/edit-fragment → reescritura de un fragmento de texto aislado
 *                                (sin tocar el resto del documento). Útil para
 *                                "reescribe este párrafo en tono más formal".
 *
 * Razonamiento para vivir separado de server.ts:
 *   - server.ts ya es 33KB monolítico. Estos 2 endpoints no tienen nada que ver
 *     con spaces, sessions, workspace files, etc.
 *   - El código del agente vive en src/agent/. Estos endpoints sí son
 *     "agente" en el sentido amplio (llaman a DeepSeek con prompts del sistema
 *     específicos del editor), aunque no usen el loop del stepSession.
 *   - Si en el futuro se quiere pasarles context-manager (probablemente NO,
 *     porque son stateless), el refactor queda contenido a este archivo.
 *
 * Montaje en server.ts:
 *     import { aiRouter } from "./src/agent/api-routes.js";
 *     app.use("/api/ai", aiRouter);
 */

import { Router } from "express";
import { isInsufficientBalance, MAINTENANCE_MESSAGE, getUserMessage } from "../lib/llm-errors.js";
import { DEFAULT_LLM_MODEL } from "./agent.js";

export const aiRouter = Router();

const DOC_EDITOR_SYSTEM_PROMPT = `You are an AI assistant integrated into a document editor. Your job is to converse with the user and potentially modify the document.

You MUST return EXACTLY a JSON object with:
1. "reply": A conversational string to reply to the user (use Markdown).
2. "edits": An optional array of objects representing document changes. Each object must have:
   - "original": The EXACT HTML substring from the document to be replaced. MUST strictly match the document's HTML. If adding to the start or end, include a few words of anchor context in 'original' and the anchor + new text in 'new'.
   - "new": The new HTML to replace it with.

If no changes are needed, omit the "edits" array. Keep edits precise to avoid replacing unintended parts of the document.`;

const EXCEL_EDITOR_SYSTEM_PROMPT = `You are an AI assistant integrated into an Excel spreadsheet editor. Your job is to converse with the user and potentially modify the spreadsheet.

You MUST return EXACTLY a JSON object with:
1. "reply": A conversational string to reply to the user (use Markdown).
2. "edits": An optional array of objects representing spreadsheet changes. Each object must have:
   - "sheet": The name of the sheet to modify (string).
   - "row": The row index (number, 1-indexed).
   - "col": The column index (number, 1-indexed).
   - "value": The new value for the cell (string, number, or boolean).

If no changes are needed, omit the "edits" array. Keep edits precise.`;

const FRAGMENT_EDITOR_SYSTEM_PROMPT = `You are an expert ghostwriter and copyeditor. Your task is to rewrite or edit the user's specific text fragment exactly as requested.

RETURN ONLY THE NEW REWRITTEN TEXT, WITHOUT ANY CONVERSATIONAL FLUFF, EXPLANATIONS, OR QUOTES unless explicitly asked. The rewritten text must integrate seamlessly into a document.`;

/**
 * POST /chat
 * Body: { history: ChatMsg[], docType?: 'excel' }
 * Returns: { reply: string, edits?: Edit[] }
 *
 * Estado: stateless. NO usa context-manager (cada request es independiente).
 */
aiRouter.post("/chat", async (req, res) => {
  try {
    const { history, docType } = req.body;
    const { openai } = await import("./agent.js");

    const systemPrompt = docType === "excel"
      ? EXCEL_EDITOR_SYSTEM_PROMPT
      : DOC_EDITOR_SYSTEM_PROMPT;

    const response = await openai.chat.completions.create({
      model: DEFAULT_LLM_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        ...history,
      ],
    });

    const parsed = JSON.parse(response.choices[0].message.content || "{}");
    res.json(parsed);
  } catch (e: any) {
    if (isInsufficientBalance(e)) {
      console.error("[INTERNAL] /api/ai/chat: LLM 402 Insufficient Balance:", e);
      return res.status(503).json({
        error: MAINTENANCE_MESSAGE,
        code: "SERVICE_UNAVAILABLE",
      });
    }
    res.status(500).json({ error: getUserMessage(e) });
  }
});

/**
 * POST /edit-fragment
 * Body: { text: string, prompt: string, context?: string }
 * Returns: { result: string }
 *
 * Estado: stateless. Reescribe un fragmento de texto en aislamiento.
 */
aiRouter.post("/edit-fragment", async (req, res) => {
  try {
    const { text, prompt, context } = req.body;
    const { openai } = await import("./agent.js");

    const response = await openai.chat.completions.create({
      model: DEFAULT_LLM_MODEL,
      messages: [
        { role: "system", content: FRAGMENT_EDITOR_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Context of the entire document:\n---\n${context || "No context provided"}\n---\n\nText to edit: ${text}\n\nTask: ${prompt}`,
        },
      ],
    });

    res.json({ result: response.choices[0].message.content });
  } catch (e: any) {
    if (isInsufficientBalance(e)) {
      console.error("[INTERNAL] /api/ai/edit-fragment: LLM 402 Insufficient Balance:", e);
      return res.status(503).json({
        error: MAINTENANCE_MESSAGE,
        code: "SERVICE_UNAVAILABLE",
      });
    }
    res.status(500).json({ error: getUserMessage(e) });
  }
});
