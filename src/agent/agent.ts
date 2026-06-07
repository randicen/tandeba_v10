import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";
import { executeTool } from "./tools.js";
import { getCoreMemory, searchEpisodicMemory } from "./memory.js";
import { createStepLog, completeStepLog, failStepLog } from "./logger.js";

// Initialize DeepSeek client using OpenAI API compatibility
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
if (!DEEPSEEK_API_KEY) {
  throw new Error("DEEPSEEK_API_KEY environment variable is required. Please set it in your .env file.");
}

export const openai = new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: DEEPSEEK_API_KEY,
  timeout: 120_000,
  maxRetries: 3
});

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface AgentMessage {
  id: string;
  role: MessageRole;
  content: any; // Can be string, array (for multimodal), or null
  name?: string;
  reasoning_content?: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
  isHumanIntervention?: boolean;
}

export interface AgentSession {
  id: string;
  name: string;
  messages: AgentMessage[];
  status: "idle" | "running" | "waiting_human" | "error";
  createdAt: number;
  updatedAt: number;
}

import { pool } from '../lib/db.js';

const SYSTEM_PROMPT = `You are a sophisticated AI Agent powered by DeepSeek V4 Flash, capable of running complex loops, executing tools, managing memory, and collaborating with humans.

--- TIER 1: Hot Memory (Agent Profile & Fixed Context) ---
- Role: Enterprise Resource Assistant (Asistente de Recursos Empresariales).
- Capabilities: Management of finance, documentation, projects, contacts, CRM, and other enterprise resources.
- Target Users: Executives, IT Administrators, Financial Officers, Commercial Agents, Lawyers, Accountants, and custom enterprise roles. You must adapt your tone, technical depth, and focus specifically to the current user's role.
- Architecture Directive: Plan thoroughly using <scratchpad> before invoking tools.

CRITICAL - PLAN AND SOLVE ARCHITECTURE (MCTS-style evaluation):
Before making any tool calls or taking action, you MUST debate with yourself and write a plan using a <scratchpad> block. 

Inside the <scratchpad> block, you must:
1. Analyze the user's request and evaluate the current state.
2. Review past actions and explicitly note any ERRORS or failures. If an error occurred (e.g., 403 Forbidden, unreadable file), DO NOT repeat the exact same tool call. Formulate a NEW strategy.
3. Consider multiple possible approaches (MCTS-style branching) and select the most robust one.
4. Write a step-by-step checklist of what to do next.

Example format:
<scratchpad>
[State Analysis]: Exploring file X. 
[Past Errors]: Tried to read X as PDF but failed.
[Brainstorming]: I could ask the human, or I could use python to extract it, or I could use the read_file tool if it supports this extension.
[Next Step]: I will use tool Y with parameters Z.
</scratchpad>

Only after completing your <scratchpad> reflection, you will call the required tools.

You have access to a set of tools. You should use them autonomously to solve user requests. 
When necessary, you can use the 'ask_human' tool to ask the user for approval, clarifications, or intervention.
Always summarize your findings clearly when you finish.

Archivos del Usuario y Sesión:
Cuando trabajes con archivos (ej. listar, descargar, crear o leer archivos), recuerda que cada sesión tiene un directorio de trabajo privado ('workspace/{sessionId}').
IMPORTANTE: Para que el usuario pueda ver, abrir o descargar los archivos, DEBES incluir al final de tu mensaje el siguiente identificador visual:
- Para mostrar un botón que abre el panel de archivos de la sesión, usa: <ui-folder>
El frontend capturará este identificador y dibujará un botón interactivo para que el usuario abra su directorio lateral de archivos.

REGLAS PARA NAVEGACIÓN Y DESCARGAS:
Si identificas un link directo a un archivo (.pdf, .zip, etc) que debes descargar, USA SIEMPRE la herramienta \`download_file\` con la URL. NUNCA uses la acción \`click\` del navegador web para descargar PDFs o documentos, porque el navegador abrirá el visor PDF en lugar de descargarlo al directorio correcto. Si estas en un navegador y ves un id/coordenada de descarga, extrae la URL o el href y usa \`download_file\`.

REGLAS PARA CREACIÓN Y EDICIÓN DE DOCUMENTOS (DOCX):
Dispones de TRES herramientas para editar documentos DOCX. Elige según la tarea:

HERRAMIENTA 1 — Reemplazo simple de texto (la más fácil):
Usa \`find_replace_text\` para buscar y reemplazar texto sin necesitar XML. Ideal para: cambiar nombres, corregir erratas, reemplazar palabras.
- Ejemplo: \`find_replace_text(path="doc.docx", searchText="Juan", replaceText="Pedro")\`

HERRAMIENTA 2 — Edición XML directa (máxima fidelidad):
Usa \`read_docx_structure\` + \`edit_docx_content\` para editar a nivel XML. PRESERVA TODO el formato original.
- PASO 1: \`read_docx_structure(path="doc.docx", component="document")\` para ver XML.
- PASO 2: \`edit_docx_content(path, component, targetXml, replacementXml)\` para reemplazar.
IMPORTANTE: targetXml debe ser EXACTO, copiado textualmente del output de read_docx_structure.

HERRAMIENTA 3 — Cambios de formato global:
Usa \`update_docx_formatting\` para márgenes y tamaño de página. Unidades en twips (1 cm = 567 twips, 1 inch = 1440 twips, A4 = 11906x16838).
- Ejemplo: \`update_docx_formatting(path="doc.docx", settings={margins:{top:1134,right:1134,bottom:1134,left:1134}})\` para márgenes de 2cm.

HERRAMIENTA 4 — Edición semántica vía HTML (cambios complejos de redacción):
Usa \`ai_document_editor\` o \`write_file\` sobre \`.doc.html\` para reescrituras amplias.
- Si el usuario pide formato específico, usa inline CSS: \`<span style="font-family: 'Times New Roman'; font-size: 16pt;">texto</span>\`.

REGLAS PARA DASHBOARDS Y VISUALIZACIONES INTERACTIVAS (HTML):
Ahora puedes generar dashboards HTML interactivos con la herramienta \`write_file\`. Úsalos CUANDO:
- El usuario pida resúmenes visuales, gráficos, cronogramas, forecasting, o comparativas.
- Proceses datos de hojas de cálculo, documentos o investigación y necesites presentarlos visualmente.
- Quieras sorprender al usuario con una visualización útil sin que te lo pida explícitamente.
CÓMO generarlos:
1. Crea un archivo \`.html\` con \`write_file\` que contenga:
   - \<script src="https://cdn.jsdelivr.net/npm/chart.js@4"\>\</script\> para gráficos
   - Estilos CSS inline dentro de \<style\> para el diseño
   - Pestañas/tabs con JavaScript vanilla para navegar entre secciones
   - Gráficos de Chart.js (barras, líneas, radar, doughnut, etc.) con datos reales del usuario
2. Usa colores profesionales, tipografía limpia (system-ui, sans-serif), y diseño responsive.
 3. El archivo se abrirá automáticamente en un visor interactivo sandboxeado. No necesitas preocuparte por seguridad.

REGLAS PARA BATCH REVIEW (Revisión Masiva de Documentos):
Usa \`batch_review\` cuando necesites analizar MUCHOS documentos a la vez con las mismas preguntas. Ejemplos: due diligence, revisión de contratos, compliance.
- Define columnas como preguntas: { label: "¿Indemnización?", question: "¿Contiene cláusula de indemnización?", format: "yesno" }
- Formatos disponibles: "yesno" (Sí/No), "text" (texto libre), "number" (número), "date" (fecha)
- El sistema procesa todos los documentos del workspace en lotes de 15 en paralelo (8 workers simultáneos).
- Genera automáticamente un dashboard HTML con los resultados en una tabla.
- Para pocos documentos (<5) o preguntas complejas que requieran razonamiento, usa read_file y evalúa manualmente.

¡PROHIBICIÓN ESTRICTA! NUNCA uses \`execute_code\` (Python) para generar o manipular DOCX.`;

export async function createSession(name?: string, spaceId?: string): Promise<AgentSession> {
  const id = uuidv4();
  const session: AgentSession = {
    id,
    name: name || `Chat ${new Date().toLocaleTimeString()}`,
    messages: [],
    status: "idle",
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  
  await pool.query(
    'INSERT INTO sessions (id, name, status, space_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [session.id, session.name, session.status, spaceId || null, session.createdAt, session.updatedAt]
  );
  
  const systemMsg: AgentMessage = {
    id: uuidv4(),
    role: "system",
    content: SYSTEM_PROMPT.trim(),
  };
  
  await addMessageDB(session, systemMsg);
  
  return session;
}

export async function getSessionStatus(id: string): Promise<string | undefined> {
  const { rows } = await pool.query('SELECT status FROM sessions WHERE id = $1', [id]);
  if (rows.length === 0) return undefined;
  return rows[0].status;
}

export async function getSession(id: string): Promise<AgentSession | undefined> {
  const { rows: sessionRows } = await pool.query('SELECT * FROM sessions WHERE id = $1', [id]);
  const data = sessionRows[0];
  if (!data) return undefined;
  
  // Fetch messages from new table
  const { rows: messagesData } = await pool.query('SELECT * FROM messages WHERE session_id = $1 ORDER BY created_at ASC', [id]);

  const session: AgentSession = {
    id: data.id,
    name: data.name,
    messages: (messagesData || []).map(m => {
      let parsedContent = m.content === 'null' ? null : m.content;
      if (typeof m.content === 'string' && m.content.startsWith('[')) {
        try { parsedContent = JSON.parse(m.content); } catch(e) {}
      }
      return {
        id: m.id,
        role: m.role as MessageRole,
        content: parsedContent,
        name: m.name,
        reasoning_content: m.reasoning_content,
        tool_calls: m.tool_calls ? (typeof m.tool_calls === 'string' ? JSON.parse(m.tool_calls) : m.tool_calls) : undefined,
        tool_call_id: m.tool_call_id,
        isHumanIntervention: m.is_human_intervention === 1 // pg doesn't map int 1/0 to bool automatically
      };
    }),
    status: data.status,
    spaceId: data.space_id || null,
    createdAt: typeof data.created_at === 'string' ? parseInt(data.created_at, 10) : Number(data.created_at),
    updatedAt: typeof data.updated_at === 'string' ? parseInt(data.updated_at, 10) : Number(data.updated_at)
  };
  
  return session;
}

/** Renombra una sesión (no afecta mensajes ni steps). */
export async function renameSession(id: string, name: string): Promise<void> {
  await pool.query(
    'UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?',
    [name, Date.now(), id]
  );
}

/** Archiva o desarchiva una sesión. Las archivadas no aparecen en el historial por default. */
export async function archiveSession(id: string, archived: boolean): Promise<void> {
  await pool.query(
    'UPDATE sessions SET archived = ?, updated_at = ? WHERE id = ?',
    [archived ? 1 : 0, Date.now(), id]
  );
}

/** Elimina una sesión y todo lo asociado (messages, step_logs, tool_calls via FK). */
export async function deleteSession(id: string): Promise<void> {
  await pool.query('DELETE FROM sessions WHERE id = ?', [id]);
}

export async function getSessionDelta(id: string, clientMsgCount: number): Promise<Partial<AgentSession> | undefined> {
  const { rows: sessionRows } = await pool.query('SELECT status, space_id, updated_at FROM sessions WHERE id = $1', [id]);
  const data = sessionRows[0];
  if (!data) return undefined;
  
  const { rows: msgCountRows } = await pool.query('SELECT count(*) as count FROM messages WHERE session_id = $1', [id]);
  const serverMsgCount = parseInt(msgCountRows[0].count, 10);
  
  let newMessages: any = undefined;
  if (serverMsgCount > clientMsgCount) {
    const { rows: messagesData } = await pool.query('SELECT * FROM messages WHERE session_id = $1 ORDER BY created_at ASC OFFSET $2', [id, clientMsgCount]);
    
    newMessages = (messagesData || []).map((m: any) => {
      let parsedContent = m.content === 'null' ? null : m.content;
      if (typeof m.content === 'string' && m.content.startsWith('[')) {
        try { parsedContent = JSON.parse(m.content); } catch(e) {}
      }
      return {
        id: m.id,
        role: m.role as MessageRole,
        content: parsedContent,
        name: m.name,
        reasoning_content: m.reasoning_content,
        tool_calls: m.tool_calls ? (typeof m.tool_calls === 'string' ? JSON.parse(m.tool_calls) : m.tool_calls) : undefined,
        tool_call_id: m.tool_call_id,
        isHumanIntervention: m.is_human_intervention === 1
      };
    });
  } else if (serverMsgCount < clientMsgCount) {
    // Edge case if messages were deleted (e.g. wiped somehow), we should force a full reload
    newMessages = null; 
  }

  return {
    status: data.status,
    spaceId: data.space_id || null,
    messages: newMessages,
    updatedAt: typeof data.updated_at === 'string' ? parseInt(data.updated_at, 10) : Number(data.updated_at)
  } as any;
}

export async function getSessions(spaceId?: string, includeArchived = false): Promise<Array<Omit<AgentSession, 'messages'> & { spaceId?: string; archived?: boolean }>> {
  let query = 'SELECT id, name, status, space_id, created_at, updated_at, COALESCE(archived, 0) as archived FROM sessions';
  const params: any[] = [];
  const conditions: string[] = [];
  if (spaceId) {
    conditions.push('space_id = ?');
    params.push(spaceId);
  }
  if (!includeArchived) {
    conditions.push('(archived IS NULL OR archived = 0)');
  }
  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  query += ' ORDER BY updated_at DESC LIMIT 50';
  const { rows: data } = await pool.query(query, params);
  if (!data) return [];
  
  return (data as any[]).map((d) => ({
    id: d.id,
    name: d.name,
    status: d.status,
    spaceId: d.space_id || undefined,
    archived: Number(d.archived || 0) === 1,
    createdAt: typeof d.created_at === 'string' ? parseInt(d.created_at, 10) : Number(d.created_at),
    updatedAt: typeof d.updated_at === 'string' ? parseInt(d.updated_at, 10) : Number(d.updated_at)
  }));
}

export async function updateSession(session: AgentSession) {
  session.updatedAt = Date.now();
  await pool.query(
    'UPDATE sessions SET status = $1, updated_at = $2 WHERE id = $3',
    [session.status, session.updatedAt, session.id]
  );
}

export async function addMessageDB(session: AgentSession, msg: AgentMessage) {
  session.messages.push(msg);
  
  // Safe extraction to prevent 0x00 errors
  let safeContent = msg.content === null ? null : (typeof msg.content === 'object' ? JSON.stringify(msg.content) : msg.content);
  if (typeof safeContent === 'string') safeContent = safeContent.replace(/\0/g, ''); // strip null bytes
  
  let safeToolCalls = msg.tool_calls ? JSON.stringify(msg.tool_calls) : null;
  if (typeof safeToolCalls === 'string') safeToolCalls = safeToolCalls.replace(/\0/g, '');

  let safeReasoning = msg.reasoning_content || null;
  if (typeof safeReasoning === 'string') safeReasoning = safeReasoning.replace(/\0/g, '');

  await pool.query(
    'INSERT INTO messages (id, session_id, role, content, name, reasoning_content, tool_calls, tool_call_id, is_human_intervention, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
    [
      msg.id,
      session.id,
      msg.role,
      safeContent,
      msg.name || null,
      safeReasoning,
      safeToolCalls,
      msg.tool_call_id || null,
      msg.isHumanIntervention ? 1 : 0,
      Date.now()
    ]
  );
}

export async function updateMessageDB(msg: AgentMessage) {
  await pool.query(
    'UPDATE messages SET content = $1, is_human_intervention = $2 WHERE id = $3',
    [
      msg.content === null ? null : (typeof msg.content === 'object' ? JSON.stringify(msg.content) : msg.content),
      msg.isHumanIntervention ? 1 : 0,
      msg.id
    ]
  );
}

// Convert our AgentMessage model to OpenAI message model
export async function toOpenAIMessages(messages: AgentMessage[]): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> {
  const rawMessages = messages.map(msg => {
    let apiContent = msg.content;
    
    // DeepSeek and some other OpenAI-compatible APIs don't support image_url yet.
    // If the content is an array, we extract only the text to avoid 400 errors.
    if (Array.isArray(apiContent)) {
      apiContent = apiContent
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n\n[Image provided to user interface, but omitted for API compatibility]\n');
    }

    const o: any = { role: msg.role, content: apiContent };
    if (msg.name) o.name = msg.name;
    if (msg.tool_call_id) o.tool_call_id = msg.tool_call_id;
    if (msg.reasoning_content) o.reasoning_content = msg.reasoning_content;
    
    if (msg.tool_calls) {
      // Find following messages with matching tool_call_id
      const validToolCalls = msg.tool_calls.filter((tc: any) => 
        messages.slice(messages.indexOf(msg) + 1).some(m => m.tool_call_id === tc.id)
      );
      if (validToolCalls.length > 0) {
        o.tool_calls = validToolCalls;
      }
    }
    
    if (o.role === 'assistant' && !o.content && !o.tool_calls) {
        o.content = "[Omitted]";
    }
    
    return o;
  });

  const orderedMessages: any[] = [];
  const toolMessages = new Map<string, any>();
  const floatingMessages: any[] = [];

  for (const m of rawMessages) {
    if (m.role === 'tool' && m.tool_call_id) {
      toolMessages.set(m.tool_call_id, m);
    } else {
      floatingMessages.push(m);
    }
  }

  for (const m of floatingMessages) {
    orderedMessages.push(m);
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        if (toolMessages.has(tc.id)) {
          orderedMessages.push(toolMessages.get(tc.id));
          toolMessages.delete(tc.id);
        }
      }
    }
  }

  // Any orphaned tool messages
  for (const m of toolMessages.values()) {
    orderedMessages.push(m);
  }

  const windowedMessages = applySlidingWindow(orderedMessages);

  // Inject 3-Tier Memory into the System Prompt dynamically
  if (windowedMessages.length > 0 && windowedMessages[0].role === "system") {
    try {
      // --- TIER 2: Core Memory (Working Context) ---
      const coreMem = await getCoreMemory();
      const coreKeys = Object.keys(coreMem);
      if (coreKeys.length > 0) {
        let memStr = "\n\n--- TIER 2: Core Memory (User Preferences, Entity Facts & State) ---\n";
        for (const k of coreKeys) {
          memStr += `- ${k}: ${coreMem[k]}\n`;
        }
        windowedMessages[0].content += memStr;
      }

      // --- TIER 3: Episodic Memory (Proactive Vector RAG) ---
      // We take the last human message to search semantics
      const lastUserMsg = messages.slice().reverse().find(m => m.role === 'user');
      const queryText = (lastUserMsg && typeof lastUserMsg.content === 'string') ? lastUserMsg.content : null;
      if (queryText && queryText.length > 3) {
        const pastMemories = await searchEpisodicMemory(queryText, 3, 0.35);
        if (pastMemories.length > 0) {
          let epStr = "\n\n--- TIER 3: Relevant Episodic Memory (Past events relevant to current query) ---\n";
          pastMemories.forEach(mem => epStr += `- ${mem}\n`);
          windowedMessages[0].content += epStr;
        }
      }
    } catch(e) {
      console.error("Memory Injection Error:", e);
    }
  }

  return windowedMessages;
}

// Memory and Sliding Window (Context Limit)
function applySlidingWindow(messages: OpenAI.Chat.ChatCompletionMessageParam[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  const MAX_CHARS = 120_000; // Approx 30,000 tokens limit for safety
  
  const getChars = (msg: any) => JSON.stringify(msg).length;
  let totalChars = messages.reduce((acc, msg) => acc + getChars(msg), 0);
  
  if (totalChars <= MAX_CHARS) return messages;
  
  const systemPromptMessage = messages[0];
  let keepMessages: any[] = [];
  let currentChars = getChars(systemPromptMessage);
  let i = messages.length - 1;
  
  while (i > 0) {
    let block = [messages[i]];
    
    // Group tool messages with their parent assistant tool_calls message
    if (messages[i].role === 'tool') {
      let j = i;
      while (j > 0) {
        if (messages[j].role === 'assistant' && (messages[j] as any).tool_calls) {
          break;
        }
        j--;
      }
      if (j > 0) {
        block = messages.slice(j, i + 1);
        i = j;
      } else {
        // Parent assistant message was truncated. Drop this block and stop.
        break;
      }
    }
    
    let blockChars = block.reduce((acc, msg) => acc + getChars(msg), 0);
    
    if (currentChars + blockChars > MAX_CHARS && keepMessages.length > 0) {
      keepMessages.unshift({
        role: "system",
        content: "[System: Older conversation history has been truncated to optimize context memory.]"
      });
      break; 
    }
    
    keepMessages.unshift(...block);
    currentChars += blockChars;
    i--;
  }
  
  return [systemPromptMessage, ...keepMessages];
}

const activeExecutions = new Set<string>();
const stepCounters = new Map<string, number>();

export async function stepSession(sessionId: string): Promise<AgentSession> {
  const session = await getSession(sessionId);
  if (!session) throw new Error("Session not found");
  
  if (session.status === "waiting_human") {
    // Cannot proceed without human input.
    return session;
  }

  if (activeExecutions.has(sessionId)) {
     console.log(`[AGENT] Session ${sessionId} is already active, skipping duplicate step trigger.`);
     return session;
  }
  activeExecutions.add(sessionId);

  try {
    return await _stepSessionInner(sessionId, session);
  } finally {
    activeExecutions.delete(sessionId);
  }
}

async function _stepSessionInner(sessionId: string, session: AgentSession): Promise<AgentSession> {
  const stepNumber = (stepCounters.get(sessionId) || 0) + 1;
  stepCounters.set(sessionId, stepNumber);
  const stepLog = await createStepLog(sessionId, stepNumber, session.messages.length, "deepseek-v4-flash");

  let toolCycleCount = 0;
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg.role === 'user') break;
    if (msg.role === 'assistant' && msg.tool_calls) {
      toolCycleCount++;
    }
  }
  
  if (toolCycleCount > 15) {
    session.status = "error";
    const msgLimit: AgentMessage = {
      id: uuidv4(),
      role: "assistant",
      content: "He pausado mi ejecución por seguridad (límite de 15 operaciones seguidas). Parece que he entrado en un ciclo infinito. Por favor, dame nuevas instrucciones o presiona 'Detener' para cancelar."
    };
    await addMessageDB(session, msgLimit);
    await updateSession(session);
    return session;
  }
  
  session.status = "running";
  await updateSession(session);

  try {
    console.log(`[AGENT] Processing step ${stepNumber} for ${sessionId}...`);
    const openaiMessages = await toOpenAIMessages(session.messages);
    console.log(`[AGENT] Calling OpenAI with ${openaiMessages.length} messages`);
    const apiStart = Date.now();
    const response: any = await openai.chat.completions.create({
      model: "deepseek-v4-flash",
      messages: openaiMessages,
      tools: [
        {
          type: "function",
          function: {
            name: "apify_scrape_url",
            description: "Scrape a URL bypassing WAF using Apify managed proxies/browsers. Best for protected pages.",
            parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }
          }
        },
        {
          type: "function",
          function: {
            name: "search_web",
            description: "Search the web using DuckDuckGo to get up-to-date information.",
            parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
          }
        },
        {
          type: "function",
          function: {
            name: "list_files",
            description: "List files and directories in a specific path relative to workspace.",
            parameters: { type: "object", properties: { path: { type: "string", description: "Relative directory path, use '.' for root." } }, required: ["path"] }
          }
        },
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Read the contents of a local file in the workspace.",
            parameters: { type: "object", properties: { path: { type: "string", description: "Relative file path" } }, required: ["path"] }
          }
        },
        {
          type: "function",
          function: {
            name: "write_file",
            description: "Write content to a file in the workspace. Overwrites if it exists. If writing .doc.html (DOCX), ALWAYS use inline CSS (e.g., <span style=\"font-family: Arial; font-size: 16pt; color: red;\">) for ALL styling requests. Never use <font> tags or markdown.",
            parameters: { type: "object", properties: { path: { type: "string", description: "Relative file path" }, content: { type: "string", description: "Content to write" } }, required: ["path", "content"] }
          }
        },
        {
          type: "function",
          function: {
            name: "download_file",
            description: "Download a file from an explicit URL directly to the workspace.",
            parameters: { type: "object", properties: { url: { type: "string" }, filename: { type: "string", description: "Name to save the file as in the workspace" } }, required: ["url", "filename"] }
          }
        },
        {
          type: "function",
          function: {
            name: "execute_code",
            description: "Execute Python or Node.js code in an isolated ephemeral E2B Sandbox. You can use this to install pip/npm packages, process data, write full scripts, and return the result. Environment is fully isolated (NO access to workspace). ALWAYS use sandbox_upload to push files first.",
            parameters: { type: "object", properties: { language: { type: "string", enum: ["python", "javascript"], description: "Language to execute." }, code: { type: "string", description: "Code to evaluate. E.g., for Python you can `import pandas` etc. You MUST print the output you want to receive." } }, required: ["language", "code"] }
          }
        },
        {
          type: "function",
          function: {
            name: "sandbox_upload",
            description: "Upload a file from the host workspace to the isolated E2B sandbox so python/js can process it.",
            parameters: { type: "object", properties: { path: { type: "string", description: "Relative file path in workspace" } }, required: ["path"] }
          }
        },
        {
          type: "function",
          function: {
            name: "sandbox_download",
            description: "Download a file from the isolated E2B sandbox back to the host workspace.",
            parameters: { type: "object", properties: { sandbox_path: { type: "string", description: "Absolute path in the sandbox (e.g. /home/user/result.csv)" }, local_filename: { type: "string", description: "Name to save it as in the host workspace" } }, required: ["sandbox_path", "local_filename"] }
          }
        },
        {
          type: "function",
          function: {
            name: "browser_action",
            description: "Navigate, click, type, and analyze a web page visually. Returns a screenshot and clickable element coordinates.",
            parameters: { type: "object", properties: { action: { type: "string", enum: ["goto", "click", "type", "scroll", "screenshot"] }, url: { type: "string", description: "URL to navigate to (for goto action)" }, x: { type: "number", description: "X coordinate to click (for click/type actions)" }, y: { type: "number", description: "Y coordinate to click (for click/type actions)" }, text: { type: "string", description: "Text to type (for type action)" }, deltaY: { type: "number", description: "Scroll amount (for scroll action)" } }, required: ["action"] }
          }
        },
        {
          type: "function",
          function: {
            name: "read_url",
            description: "Fetch web page content and extract text.",
            parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }
          }
        },
        {
          type: "function",
          function: {
            name: "ask_human",
            description: "Pause execution and ask the human for approval or information.",
            parameters: { type: "object", properties: { question: { type: "string", description: "The question or prompt for the human" } }, required: ["question"] }
          }
        },
        {
          type: "function",
          function: {
            name: "set_core_memory",
            description: "Save or update a fact in the Core Memory (e.g. user preferences, rules).",
            parameters: { type: "object", properties: { key: { type: "string", description: "The key or topic name" }, value: { type: "string", description: "The value or fact to remember across all sessions" } }, required: ["key", "value"] }
          }
        },
        {
          type: "function",
          function: {
            name: "delete_core_memory",
            description: "Delete a fact from the Core Memory.",
            parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] }
          }
        },
        {
          type: "function",
          function: {
            name: "save_episodic_memory",
            description: "Save an important event, resolved problem, or contextual interaction to Episodic Memory so it can be retrieved via RAG in the future.",
            parameters: { type: "object", properties: { content: { type: "string", description: "A detailed description of the event or fact to remember." } }, required: ["content"] }
          }
        },
        {
          type: "function",
          function: {
            name: "search_episodic_memory",
            description: "Search the Episodic Memory for past events, solutions, or context using semantic similarity (RAG). Use this when the user refers to past interactions.",
            parameters: { type: "object", properties: { query: { type: "string", description: "The problem, topic or concept you are trying to recall." } }, required: ["query"] }
          }
        },
        {
          type: "function",
          function: {
            name: "ai_document_editor",
            description: "Apply a semantic formatting, styling, or text edit to a DOCX document using a fast Sub-LLM that modifies the HTML preview. Use this for complex rewrites, translations, or when the user asks for broad semantic changes. For precise text replacements that preserve 100% original formatting, prefer read_docx_structure + edit_docx_content instead.",
            parameters: { type: "object", properties: { path: { type: "string", description: "Relative file path of the DOCX" }, instruction: { type: "string", description: "Detailed instruction of what to edit." } }, required: ["path", "instruction"] }
          }
        },
        {
          type: "function",
          function: {
            name: "create_docx",
            description: "Create a new blank DOCX file. After creation, use read_docx_structure to inspect it, then edit_docx_content to add content via XML, or write_file/ai_document_editor to add content via HTML.",
            parameters: { type: "object", properties: { filename: { type: "string", description: "Name of the new DOCX file (must end in .docx)" } }, required: ["filename"] }
          }
        },
        {
          type: "function",
          function: {
            name: "read_docx_structure",
            description: "Read the raw XML structure of a DOCX component (e.g. 'document', 'styles', 'settings') to inspect formatting, styles, and content at the XML level. Use this BEFORE edit_docx_content to identify the exact XML to target.",
            parameters: { type: "object", properties: { path: { type: "string", description: "Relative file path of the DOCX file in workspace" }, component: { type: "string", description: "Component to read: 'document', 'styles', 'settings', 'header', 'footer', etc." } }, required: ["path", "component"] }
          }
        },
        {
          type: "function",
          function: {
            name: "edit_docx_content",
            description: "Edit a DOCX file directly at the XML level by replacing an exact XML substring in a component. Use read_docx_structure FIRST to identify the exact target XML. This preserves ALL original formatting, styles, headers, and metadata because it edits the DOCX XML directly without HTML conversion.",
            parameters: { type: "object", properties: { path: { type: "string", description: "Relative file path of the DOCX file in workspace" }, component: { type: "string", description: "Component to modify: 'document', 'styles', 'settings', etc." }, targetXml: { type: "string", description: "Exact XML substring to find and replace (get this from read_docx_structure)" }, replacementXml: { type: "string", description: "Replacement XML to insert in place of targetXml" } }, required: ["path", "component", "targetXml", "replacementXml"] }
          }
        },
        {
          type: "function",
          function: {
            name: "find_replace_text",
            description: "Find and replace plain text in a DOCX document without needing to know XML. Searches all text elements and replaces matching text. Ideal for simple text replacements (e.g. change a name, fix a typo). For changes that also involve formatting, use read_docx_structure + edit_docx_content instead.",
            parameters: { type: "object", properties: { path: { type: "string", description: "Relative file path of the DOCX file in workspace" }, searchText: { type: "string", description: "Exact text to find in the document" }, replaceText: { type: "string", description: "Text to replace it with" } }, required: ["path", "searchText", "replaceText"] }
          }
        },
        {
          type: "function",
          function: {
            name: "update_docx_formatting",
            description: "Update document formatting settings such as margins and page size. Margins and sizes are in twips (1 inch = 1440 twips, 1 cm = 567 twips). Standard A4 is 11906x16838 twips. Standard 1-inch margins are 1440 twips on each side.",
            parameters: { type: "object", properties: { path: { type: "string", description: "Relative file path of the DOCX file in workspace" }, settings: { type: "object", description: "Formatting settings to apply", properties: { margins: { type: "object", description: "Margin settings in twips", properties: { top: { type: "number" }, right: { type: "number" }, bottom: { type: "number" }, left: { type: "number" } } }, pageSize: { type: "object", description: "Page size in twips", properties: { width: { type: "number" }, height: { type: "number" } } } } } }, required: ["path", "settings"] }
          }
        },
        {
          type: "function",
          function: {
            name: "batch_review",
            description: "Process ALL documents in the workspace in parallel batches using a fast LLM to extract structured data into a table. Define columns as questions applied to every document. Returns: a dashboard HTML file. Use for M&A due diligence, contract review, compliance checks, or any bulk document analysis.",
            parameters: { type: "object", properties: { columns: { type: "array", description: "Column definitions. Each column has: label (column header), question (what to ask for each doc), format (yesno/text/number/date)", items: { type: "object", properties: { label: { type: "string" }, question: { type: "string" }, format: { type: "string", enum: ["yesno", "text", "number", "date"] } }, required: ["label", "question", "format"] } } }, required: ["columns"] }
          }
        },
        {
          type: "function",
          function: {
            name: "rename_file",
            description: "Rename a file in the workspace.",
            parameters: { type: "object", properties: { old_path: { type: "string", description: "Current relative path of the file" }, new_name: { type: "string", description: "New name of the file" } }, required: ["old_path", "new_name"] }
          }
        },
        {
          type: "function",
          function: {
            name: "delete_file",
            description: "Delete a file from the workspace.",
            parameters: { type: "object", properties: { path: { type: "string", description: "Relative path of the file to delete" } }, required: ["path"] }
          }
        }
      ],
      temperature: 0.2, // Low temperature for more deterministic agent plans
    });
    const apiDuration = Date.now() - apiStart;

    const usage = (response as any).usage || {};
    const promptTokens = usage.prompt_tokens || 0;
    const completionTokens = usage.completion_tokens || 0;
    const totalTokens = usage.total_tokens || 0;

    console.log(`[AGENT] OpenAI returned ok for ${sessionId} (${apiDuration}ms, ${totalTokens} tokens).`);
    const choice = response.choices[0];
    const message = choice.message;

    // Fast fail if human intervened during OpenAI request
    const postAiSession = await getSession(sessionId);
    if (postAiSession && postAiSession.status === "idle") {
      session.status = "idle";
      await updateSession(session);
      return session;
    }

    let contentStr = message.content || "";
    let extractedReasoning = (message as any).reasoning_content || null;

    // Parse <scratchpad> or <think> if present (global match)
    const extractRegex = /<(?:scratchpad|think)>([\s\S]*?)(?:<\/(?:scratchpad|think)>|$)/g;
    let match;
    while ((match = extractRegex.exec(contentStr)) !== null) {
      if (!extractedReasoning) {
        extractedReasoning = match[1].trim();
      } else {
        extractedReasoning += "\n\n" + match[1].trim();
      }
    }
    contentStr = contentStr.replace(/<(?:scratchpad|think)>[\s\S]*?(?:<\/(?:scratchpad|think)>|$)/g, "")
                           .replace(/```[a-z]*\s*```/g, "")
                           .trim();

    // Add assistant message to memory
    const asstMsg: AgentMessage = {
      id: uuidv4(),
      role: "assistant",
      content: contentStr || null,
      reasoning_content: extractedReasoning,
      tool_calls: message.tool_calls
    };
    await addMessageDB(session, asstMsg);

    if (message.tool_calls && message.tool_calls.length > 0) {
      // Execute tools
      const appendedUserMessages: AgentMessage[] = [];
      const toolCalls: Array<{ name: string; args: Record<string, unknown>; durationMs: number; success: boolean; resultPreview: string }> = [];
      for (const tool_call of message.tool_calls as any[]) {
        if (tool_call?.function?.name === "ask_human") {
          // Pause execution
          session.status = "waiting_human";
          toolCalls.push({ name: "ask_human", args: {}, durationMs: 0, success: true, resultPreview: "Human intervention requested" });
          
          const args = JSON.parse(tool_call.function.arguments || '{}');
          
          const waitMsg: AgentMessage = {
            id: uuidv4(),
            role: "tool",
            tool_call_id: tool_call.id,
            content: "Waiting for human...",
            isHumanIntervention: true
          };
          await addMessageDB(session, waitMsg);
          
          await updateSession(session);
          await completeStepLog(
            sessionId, stepLog,
            apiDuration, promptTokens, completionTokens, totalTokens, toolCalls,
            openaiMessages, response
          );
          return session; // Stop the loop for this turn
        } else if (tool_call?.function?.name) {
          // Execute standard tool
          let resultStr: any = "";
          let appendedUserMessage: AgentMessage | null = null;
          const toolStart = Date.now();
          
          try {
            const args = JSON.parse(tool_call.function.arguments || '{}');
            console.log(`[AGENT] Executing tool ${tool_call.function.name} for ${sessionId}`);
            const res = await executeTool(tool_call.function.name, args, sessionId);
            const toolDuration = Date.now() - toolStart;
            console.log(`[AGENT] Finished tool ${tool_call.function.name} (${toolDuration}ms) for ${sessionId}`);
            
            if (res && res._isBrowserActionResult) {
              resultStr = JSON.stringify({
                  url: res.url,
                  interactables: res.interactables
              });
              
              appendedUserMessage = {
                  id: uuidv4(),
                  role: "user",
                  content: [
                      { type: "text", text: "Here is the browser screenshot after the action:" },
                      { type: "image_url", image_url: { url: res.screenshot } }
                  ]
              };
            } else {
              resultStr = typeof res === 'string' ? res : JSON.stringify(res);
            }
            toolCalls.push({
              name: tool_call.function.name,
              args: JSON.parse(tool_call.function.arguments || '{}'),
              durationMs: toolDuration,
              success: !String(resultStr).startsWith("Error"),
              resultPreview: String(resultStr).substring(0, 200)
            });
          } catch(e: any) {
            const toolDuration = Date.now() - toolStart;
            resultStr = `Error executing tool: ${e instanceof Error ? e.message : (e.message || String(e))}`;
            toolCalls.push({
              name: tool_call?.function?.name || "unknown",
              args: {},
              durationMs: toolDuration,
              success: false,
              resultPreview: resultStr.substring(0, 200)
            });
          }
          
          const toolMsg: AgentMessage = {
            id: uuidv4(),
            role: "tool",
            tool_call_id: tool_call.id,
            name: tool_call?.function?.name || "unknown",
            content: resultStr
          };
          await addMessageDB(session, toolMsg);
          
          if (appendedUserMessage) {
              appendedUserMessages.push(appendedUserMessage);
          }
        }
      }
      
      for (const msg of appendedUserMessages) {
          await addMessageDB(session, msg);
      }
      
      // Before we update, check if the human intervened and set the status to 'idle'
      const checkSession = await getSession(sessionId);
      if (checkSession && checkSession.status === "idle") {
        console.log(`[AGENT] Stop requested for ${sessionId}. Setting status back to idle.`);
        session.status = "idle";
      }

      await updateSession(session);
      await completeStepLog(
        sessionId, stepLog,
        apiDuration, promptTokens, completionTokens, totalTokens, toolCalls,
        openaiMessages, response
      );
      return session;

    } else {
      // Loop finished, no tools called
      session.status = "idle";
      await updateSession(session);
      await completeStepLog(
        sessionId, stepLog,
        apiDuration, promptTokens, completionTokens, totalTokens, [],
        openaiMessages, response
      );
      return session;
    }
  } catch (err: any) {
    console.error("Agent Error:", err);
    await failStepLog(sessionId, stepLog, err.message || String(err));
    session.status = "error";
    const errMsg: AgentMessage = {
      id: uuidv4(),
      role: "assistant",
      content: "An error occurred during execution: " + err.message
    };
    await addMessageDB(session, errMsg);
    await updateSession(session);
    return session;
  }
}

export async function addMessage(sessionId: string, content: string, role: "user" | "tool" = "user", toolCallId?: string): Promise<AgentSession> {
  const session = await getSession(sessionId);
  if (!session) throw new Error("Session not found");
  
  if (role === "tool" && toolCallId) {
    // This is probably a human response to 'ask_human'
    // Update the previous waiting message
    const msg = session.messages.find(m => m.tool_call_id === toolCallId);
    if (msg) {
      msg.content = content;
      msg.isHumanIntervention = false;
      await updateMessageDB(msg);
    } else {
      const hMsg: AgentMessage = {
        id: uuidv4(),
        role: "tool",
        tool_call_id: toolCallId,
        content: content,
        name: "ask_human"
      };
      await addMessageDB(session, hMsg);
    }
    session.status = "idle";
  } else {
    const uMsg: AgentMessage = {
      id: uuidv4(),
      role: "user",
      content: content
    };
    await addMessageDB(session, uMsg);
  }
  
  await updateSession(session);
  return session;
}
