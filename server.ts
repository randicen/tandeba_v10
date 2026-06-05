import 'dotenv/config';
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { pool } from "./src/lib/db.js";
import { fileURLToPath } from "url";
import multer from "multer";

export async function preprocessHtmlForDocx(html: string): Promise<string> {
  let exportHtml = html;
  exportHtml = exportHtml.replace(/<font([^>]*) face="([^"]+)"([^>]*)>/gi, '<span style="font-family: $2;"$1$3>');
  exportHtml = exportHtml.replace(/<font([^>]*) size="([^"]+)"([^>]*)>/gi, (match, prefix, size, suffix) => {
    const sizeMap: Record<string, string> = { '1': '10pt', '2': '11pt', '3': '12pt', '4': '14pt', '5': '18pt', '6': '24pt', '7': '36pt' };
    return `<span style="font-size: ${sizeMap[size] || '12pt'};"${prefix}${suffix}>`;
  });
  exportHtml = exportHtml.replace(/<font([^>]*) color="([^"]+)"([^>]*)>/gi, '<span style="color: $2;"$1$3>');
  exportHtml = exportHtml.replace(/<\/font>/gi, '</span>');
  exportHtml = exportHtml.replace(/<mark([^>]*)>/gi, '<span style="background-color: yellow;"$1>');
  exportHtml = exportHtml.replace(/<\/mark>/gi, '</span>');

  const cheerio = await import("cheerio");
  const $ = cheerio.load(exportHtml, { decodeEntities: false });

  // Fix generic font sizes inside style attributes (e.g., styleWithCSS browser output)
  $('*[style]').each((_, el) => {
    let style = $(el).attr('style');
    if (!style) return;
    
    // Map browser semantic font sizes to exact pt values so html-to-docx parses them correctly
    const sizeMap = {
       'xx-small': '8pt',
       'x-small': '10pt',
       'small': '11pt',
       'medium': '12pt',
       'large': '14pt',
       'x-large': '18pt',
       'xx-large': '24pt',
       // standard sizes mapping matching Jodit dropdown if generated
       '1': '10pt', '2': '11pt', '3': '12pt', '4': '14pt', '5': '18pt', '6': '24pt', '7': '36pt'
    };
    
    let updatedStyle = style.replace(/font-size:\s*([^;]+);?/gi, (match, sizeValue) => {
       const cleanSize = sizeValue.trim().toLowerCase();
       if (sizeMap[cleanSize]) {
          return `font-size: ${sizeMap[cleanSize]};`;
       }
       return match;
    });

    if (updatedStyle !== style) {
       $(el).attr('style', updatedStyle);
       style = updatedStyle;
    }

    const tagName = (el as any).tagName ? (el as any).tagName.toLowerCase() : '';
    const isBlock = ['p', 'div', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'tbody', 'tr', 'td', 'th'].includes(tagName);

    if (isBlock) {
      if (/italic/i.test(style)) { $(el).html(`<i>${$(el).html()}</i>`); }
      if (/underline/i.test(style)) { $(el).html(`<u>${$(el).html()}</u>`); }
      if (/line-through/i.test(style)) { $(el).html(`<s>${$(el).html()}</s>`); }
      if (/(700|800|900|bold)/i.test(style)) { $(el).html(`<b>${$(el).html()}</b>`); }
    } else {
      if (/italic/i.test(style) && tagName !== 'i' && tagName !== 'em') { $(el).wrap('<i></i>'); }
      if (/underline/i.test(style) && tagName !== 'u') { $(el).wrap('<u></u>'); }
      if (/line-through/i.test(style) && tagName !== 's' && tagName !== 'strike') { $(el).wrap('<s></s>'); }
      if (/(700|800|900|bold)/i.test(style) && tagName !== 'b' && tagName !== 'strong') { $(el).wrap('<b></b>'); }
    }
  });

  // Pull ul/ol out of any inline tags like span, font, b, i, etc.
  // This solves lists disappearing or not rendering bullets when wrapped by browser's execCommand
  const inlineTags = ['span', 'font', 'b', 'i', 'u', 's', 'strong', 'em', 'mark'];
  let listsReparented = true;
  while (listsReparented) {
    listsReparented = false;
    $('ul, ol').each((_, el) => {
      const parent = $(el).parent();
      if (parent.length && parent[0]) {
        const tagName = ((parent[0] as any).name || (parent[0] as any).tagName || '').toLowerCase();
        if (tagName && inlineTags.includes(tagName)) {
           parent.replaceWith(parent.contents());
           listsReparented = true;
        }
      }
    });
  }

  // Convert em/strong to i/b as html-to-docx sometimes fails on em/strong depending on nesting
  $('em').each((_, el) => { (el as any).tagName = 'i'; });
  $('strong').each((_, el) => { (el as any).tagName = 'b'; });

  // Convert <s>, <strike>, <del> to <span style="text-decoration:line-through">
  // so html-to-docx handles them without requiring patched node_modules.
  $('s, strike, del').each((_, el) => {
    const $el = $(el);
    const existingStyle = $el.attr('style') || '';
    const mergedStyle = existingStyle ? `${existingStyle}; text-decoration: line-through` : 'text-decoration: line-through';
    $el.replaceWith($(`<span style="${mergedStyle}">${$el.html()}</span>`));
  });

  // Convert CSS font/size/color spans to <font> tags that html-to-docx understands natively.
  // Done inside cheerio DOM to handle nesting correctly (no regex on raw HTML).
  const SIZE_TO_HTML: Record<string, string> = {
    '8pt': '1', '10pt': '2', '11pt': '2', '12pt': '3', '14pt': '4',
    '16pt': '4', '18pt': '5', '20pt': '5', '22pt': '6', '24pt': '6',
    '28pt': '7', '36pt': '7'
  };

  $('span[style]').each((_, el) => {
    const $el = $(el);
    const style = ($el.attr('style') || '').toLowerCase().replace(/&quot;/g, '"');
    if (!style) return;

    // Extract font-family
    const ffMatch = style.match(/font-family:\s*([^;"]+)/i);
    // Extract font-size  
    const fsMatch = style.match(/font-size:\s*(\d+pt)/i);
    // Extract text color
    const colorMatch = style.match(/(?:^|[^-])color:\s*([^;]+)/i);
    // Extract background-color
    const bgMatch = style.match(/background-color:\s*([^;]+)/i);
    // Extract text-decoration
    const tdMatch = style.match(/text-decoration:\s*line-through/i);

    let innerContent = $el.html() || '';

    if (ffMatch) {
      innerContent = `<font face="${ffMatch[1].trim()}">${innerContent}</font>`;
    }
    if (fsMatch && SIZE_TO_HTML[fsMatch[1]]) {
      innerContent = `<font size="${SIZE_TO_HTML[fsMatch[1]]}">${innerContent}</font>`;
    }
    if (colorMatch) {
      innerContent = `<font color="${colorMatch[1].trim()}">${innerContent}</font>`;
    }
    if (bgMatch) {
      innerContent = `<font style="background-color: ${bgMatch[1].trim()};">${innerContent}</font>`;
    }

    // Build remaining style (anything not handled above)
    let remaining = style
      .replace(/font-family:\s*[^;]+;?/gi, '')
      .replace(/font-size:\s*\d+pt;?/gi, '')
      .replace(/(?:^|[^-])color:\s*[^;]+;?/gi, '')
      .replace(/background-color:\s*[^;]+;?/gi, '')
      .replace(/text-decoration:\s*line-through;?/gi, '')
      .replace(/&quot;/g, '')
      .replace(/;{2,}/g, ';')
      .replace(/^\s*;\s*/, '')
      .replace(/;\s*$/, '')
      .trim();

    if (tdMatch) {
      innerContent = `<s>${innerContent}</s>`;
    }

    if (remaining) {
      $el.attr('style', remaining);
      $el.html(innerContent);
    } else {
      $el.replaceWith($(innerContent));
    }
  });

  // Inject ZWSP to prevent html-to-docx nesting drop bug
  const formatTags = ['b', 'i', 'u'];
  for (const tag of formatTags) {
    $(tag).prepend('&#8203;');
  }

  let resultHtml = $.html();

  // Fix cheerio re-encoding: decode &quot; back to " inside style attributes
  resultHtml = resultHtml.replace(/style="([^"]*&quot;[^"]*)"/g, (_, content) => {
    return `style="${content.replace(/&quot;/g, '"')}"`;
  });

  return resultHtml;
}

// Agent imports
import { v4 as uuidv4 } from "uuid";
// Initialize agent logic later

import { createSession, getSession, getSessions, stepSession, addMessage, updateSession } from "./src/agent/agent.js";
import { getWorkspaceFiles, syncWorkspaceFromR2, ensureFileLocal } from "./src/agent/tools.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  await syncWorkspaceFromR2();

  // Migrate orphan sessions without space_id into a default space
  try {
    const { pool } = await import("./src/lib/db.js");
    const { getOrCreateDefaultSpace } = await import("./src/agent/spaces.js");
    const space = await getOrCreateDefaultSpace();
    await pool.query('UPDATE sessions SET space_id = $1 WHERE space_id IS NULL', [space.id]);
  } catch { /* DB might not be available */ }

  const app = express();
  const PORT = 3000;

  app.use(express.json());
  
  const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB per file
  const MAX_WORKSPACE_SIZE = 500 * 1024 * 1024; // 500MB total
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_SIZE } });

  async function getWorkspaceSize(dir: string): Promise<number> {
    try {
      const fs = await import("fs/promises");
      const entries = await fs.readdir(dir, { withFileTypes: true });
      let total = 0;
      for (const e of entries) {
        if (e.isDirectory()) { total += await getWorkspaceSize(path.join(dir, e.name)); }
        else { const s = await fs.stat(path.join(dir, e.name)); total += s.size; }
      }
      return total;
    } catch { return 0; }
  }

  app.post("/api/sessions/:id/workspace/files/upload", upload.single("file"), async (req, res) => {
    try {
      if (!req.file) throw new Error("No file uploaded");
      const { syncToR2 } = await import("./src/agent/tools.js");
      const fs = await import("fs/promises");
      const base = path.join(process.cwd(), 'workspace', req.params.id);
      await fs.mkdir(base, { recursive: true });

      // Enforce workspace size limit
      const currentSize = await getWorkspaceSize(base);
      if (currentSize + req.file.size > MAX_WORKSPACE_SIZE) {
        return res.status(413).json({ error: `Has alcanzado el límite de 500MB del espacio de trabajo. Elimina algunos archivos para liberar espacio.` });
      }
      if (req.file.size > MAX_FILE_SIZE) {
        return res.status(413).json({ error: "Cada archivo debe pesar máximo 20MB." });
      }
      
      let filename = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
      let fileBuffer = req.file.buffer;

      // Intercept .docx and convert to .doc.html using mammoth
      if (filename.toLowerCase().endsWith('.docx')) {
        const mammoth = await import("mammoth");
        const mammothResult = await mammoth.convertToHtml({ buffer: fileBuffer });
        const htmlBuffer = Buffer.from(mammothResult.value, "utf8");
        const htmlFilename = filename.replace(/\.docx$/i, '.doc.html');
        
        const fullPathOriginal = path.join(base, filename);
        await fs.writeFile(fullPathOriginal, fileBuffer);
        await syncToR2(filename, fileBuffer, req.params.id);
        
        const fullPathHtml = path.join(base, htmlFilename);
        await fs.writeFile(fullPathHtml, htmlBuffer);
        await syncToR2(htmlFilename, htmlBuffer, req.params.id);
        
        res.json({ status: "ok", name: filename });
        return;
      }

      const fullPath = path.join(base, filename);
      if (!fullPath.startsWith(base)) {
        return res.status(403).json({ error: "Access denied" });
      }
      
      await fs.writeFile(fullPath, fileBuffer);
      await syncToR2(filename, fileBuffer, req.params.id);
      
      res.json({ status: "ok", name: filename });
    } catch(e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/ai/chat", async (req, res) => {
    try {
      const { history, docType } = req.body;
      const { openai } = await import("./src/agent/agent.js");
      
      let systemPrompt = "You are an AI assistant integrated into a document editor. Your job is to converse with the user and potentially modify the document.\n\nYou MUST return EXACTLY a JSON object with:\n1. \"reply\": A conversational string to reply to the user (use Markdown).\n2. \"edits\": An optional array of objects representing document changes. Each object must have:\n   - \"original\": The EXACT HTML substring from the document to be replaced. MUST strictly match the document's HTML. If adding to the start or end, include a few words of anchor context in 'original' and the anchor + new text in 'new'.\n   - \"new\": The new HTML to replace it with.\n\nIf no changes are needed, omit the \"edits\" array. Keep edits precise to avoid replacing unintended parts of the document.";

      if (docType === 'excel') {
        systemPrompt = "You are an AI assistant integrated into an Excel spreadsheet editor. Your job is to converse with the user and potentially modify the spreadsheet.\n\nYou MUST return EXACTLY a JSON object with:\n1. \"reply\": A conversational string to reply to the user (use Markdown).\n2. \"edits\": An optional array of objects representing spreadsheet changes. Each object must have:\n   - \"sheet\": The name of the sheet to modify (string).\n   - \"row\": The row index (number, 1-indexed).\n   - \"col\": The column index (number, 1-indexed).\n   - \"value\": The new value for the cell (string, number, or boolean).\n\nIf no changes are needed, omit the \"edits\" array. Keep edits precise.";
      }
      
      const response = await openai.chat.completions.create({
        model: "deepseek-v4-flash",
        response_format: { type: "json_object" },
        messages: [
          { 
            role: "system", 
            content: systemPrompt
          },
          ...history
        ]
      });

      const parsed = JSON.parse(response.choices[0].message.content || "{}");
      res.json(parsed);
    } catch(e: any) {
      res.status(500).json({ error: e.message });
    }
  });
  app.post("/api/ai/edit-fragment", async (req, res) => {
    try {
      const { text, prompt, context } = req.body;
      const { openai } = await import("./src/agent/agent.js");
      
      const response = await openai.chat.completions.create({
        model: "deepseek-v4-flash",
        messages: [
          { role: "system", content: "You are an expert ghostwriter and copyeditor. Your task is to rewrite or edit the user's specific text fragment exactly as requested. \n\nRETURN ONLY THE NEW REWRITTEN TEXT, WITHOUT ANY CONVERSATIONAL FLUFF, EXPLANATIONS, OR QUOTES unless explicitly asked. The rewritten text must integrate seamlessly into a document." },
          { role: "user", content: `Context of the entire document:\n---\n${context || 'No context provided'}\n---\n\nText to edit: ${text}\n\nTask: ${prompt}` }
        ]
      });

      res.json({ result: response.choices[0].message.content });
    } catch(e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Space API Routes
  const { createSpace, getSpaces, renameSpace, deleteSpace } = await import("./src/agent/spaces.js");

  app.get("/api/spaces", async (req, res) => {
    try {
      const { getAllSpacesFlat, getSpaces } = await import("./src/agent/spaces.js");
      if (req.query.flat === 'true') {
        res.json(await getAllSpacesFlat());
      } else if (req.query.parentId !== undefined) {
        const parentId = req.query.parentId === 'null' || req.query.parentId === '' ? null : String(req.query.parentId);
        res.json(await getSpaces(parentId));
      } else {
        res.json(await getAllSpacesFlat());
      }
    } catch(e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/spaces", async (req, res) => {
    try {
      const { createSpace } = await import("./src/agent/spaces.js");
      const parentId = req.body.parentId === undefined || req.body.parentId === null || req.body.parentId === '' ? null : String(req.body.parentId);
      const space = await createSpace(req.body.name || "Nuevo Espacio", parentId);
      res.json(space);
    } catch(e: any) { res.status(500).json({ error: e.message }); }
  });

  app.put("/api/spaces/:id", async (req, res) => {
    try {
      await renameSpace(req.params.id, req.body.name);
      res.json({ status: "ok" });
    } catch(e: any) { res.status(500).json({ error: e.message }); }
  });

  app.delete("/api/spaces/:id", async (req, res) => {
    try {
      await deleteSpace(req.params.id);
      res.json({ status: "ok" });
    } catch(e: any) { res.status(500).json({ error: e.message }); }
  });

  app.put("/api/spaces/:id/instructions", async (req, res) => {
    try {
      const { updateSpaceInstructions, getSpace } = await import("./src/agent/spaces.js");
      await updateSpaceInstructions(req.params.id, req.body.instructions || '');
      const space = await getSpace(req.params.id);
      res.json(space);
    } catch(e: any) { res.status(500).json({ error: e.message }); }
  });

  // Space workspace files (shared across all threads in a space)
  app.get("/api/spaces/:id/files", async (req, res) => {
    try {
      const fs = await import("fs/promises");
      const dir = path.join(process.cwd(), 'workspace', 'spaces', req.params.id);
      await fs.mkdir(dir, { recursive: true });
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const files = entries
        .filter(e => !e.name.endsWith('.doc.html') && !e.name.endsWith('.meta.html'))
        .map(e => ({ name: e.name, isDirectory: e.isDirectory() }));
      res.json(files);
    } catch(e: any) { res.json([]); }
  });

  app.post("/api/spaces/:id/files/upload", upload.single("file"), async (req, res) => {
    try {
      if (!req.file) throw new Error("No file uploaded");
      const fs = await import("fs/promises");
      const dir = path.join(process.cwd(), 'workspace', 'spaces', req.params.id);
      await fs.mkdir(dir, { recursive: true });
      const currentSize = await getWorkspaceSize(dir);
      if (currentSize + (req.file?.size || 0) > MAX_WORKSPACE_SIZE) {
        return res.status(413).json({ error: "Has alcanzado el límite de 500MB del espacio de trabajo." });
      }
      const filename = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
      await fs.writeFile(path.join(dir, filename), req.file.buffer);
      res.json({ status: "ok", name: filename });
    } catch(e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/spaces/:id/files/:name", async (req, res) => {
    try {
      const fullPath = path.join(process.cwd(), 'workspace', 'spaces', req.params.id, req.params.name);
      res.download(fullPath);
    } catch(e: any) { res.status(500).json({ error: e.message }); }
  });

  app.delete("/api/spaces/:id/files/:name", async (req, res) => {
    try {
      const fs = await import("fs/promises");
      await fs.unlink(path.join(process.cwd(), 'workspace', 'spaces', req.params.id, req.params.name));
      res.json({ status: "ok" });
    } catch(e: any) { res.status(500).json({ error: e.message }); }
  });

  // Agent API Routes
  app.post("/api/sessions", async (req, res) => {
    try {
      const session = await createSession(req.body.name, req.body.spaceId);
      res.json(session);
    } catch(e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/sessions", async (req, res) => {
    try {
      const spaceId = req.query.spaceId as string | undefined;
      res.json(await getSessions(spaceId || undefined));
    } catch(e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/sessions/:id", async (req, res) => {
    try {
      const session = await getSession(req.params.id);
      if (!session) return res.status(404).json({error: "Not found"});
      res.json(session);
    } catch(e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/sessions/:id/sync", async (req, res) => {
    try {
      const msgCount = parseInt(req.query.msgCount as string || "0");
      const { getSessionDelta } = await import("./src/agent/agent.js");
      const session = await getSessionDelta(req.params.id, msgCount);
      if (!session) return res.status(404).json({error: "Not found"});
      res.json(session);
    } catch(e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/sessions/:id/workspace/files", async (req, res) => {
    try {
      const files = await getWorkspaceFiles(req.params.id);
      res.json(files);
    } catch(e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/sessions/:id/workspace/files/:path/view", async (req, res) => {
    try {
      const base = path.join(process.cwd(), 'workspace', req.params.id);
      const fullPath = await ensureFileLocal(req.params.id, req.params.path);
      if (!fullPath.startsWith(base)) {
        return res.status(403).json({ error: "Access denied" });
      }
      res.sendFile(fullPath);
    } catch(e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/sessions/:id/export-docx", async (req, res) => {
    try {
      const { path: filePath, lineSpacing = "1.5" } = req.query;
      if (!filePath || typeof filePath !== 'string') return res.status(400).json({error: "Missing path"});
      
      const { ensureFileLocal } = await import("./src/agent/tools.js");
      const base = path.join(process.cwd(), 'workspace', req.params.id);
      const fullPath = await ensureFileLocal(req.params.id, filePath);
      
      if (!fullPath.startsWith(base)) {
        return res.status(403).json({ error: "Access denied" });
      }

      const fs = await import("fs/promises");
      const htmlContent = await fs.readFile(fullPath, "utf8");
      
      const buffer = await (await import("./src/lib/html-to-docx-custom.js")).customHtmlToDocx(htmlContent);

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      res.setHeader("Content-Disposition", `attachment; filename="${filePath.replace('.doc.html', '.docx')}"`);
      res.send(buffer);
    } catch(e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/sessions/:id/workspace/files/:path", async (req, res) => {
    try {
      const base = path.join(process.cwd(), 'workspace', req.params.id);
      const fullPath = await ensureFileLocal(req.params.id, req.params.path);
      if (!fullPath.startsWith(base)) {
        return res.status(403).json({ error: "Access denied" });
      }
      res.download(fullPath);
    } catch(e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/sessions/:id/workspace/files", async (req, res) => {
    try {
      let { name } = req.body;
      const { syncToR2 } = await import("./src/agent/tools.js");
      const base = path.join(process.cwd(), 'workspace', req.params.id);
      const fs = await import("fs/promises");
      await fs.mkdir(base, { recursive: true });

      if (name.endsWith('.docx')) {
        const htmlName = name.replace('.docx', '.doc.html');
        
        // 1. Create .doc.html
        const bufferHtml = Buffer.from("<p>Documento nuevo</p>", "utf8");
        await fs.writeFile(path.join(base, htmlName), bufferHtml);
        await syncToR2(htmlName, bufferHtml, req.params.id);
        
        // 2. Create .docx
        const docxBuffer = await (await import("./src/lib/html-to-docx-custom.js")).customHtmlToDocx("<p>Documento nuevo</p>");
        await fs.writeFile(path.join(base, name), docxBuffer);
        await syncToR2(name, docxBuffer, req.params.id);
        
      } else {
        const fullPath = path.join(base, name);
        if (!fullPath.startsWith(base)) {
          return res.status(403).json({ error: "Access denied" });
        }
        
        const buffer = Buffer.from("<p>Documento nuevo</p>", "utf8");
        await fs.writeFile(fullPath, buffer);
        await syncToR2(name, buffer, req.params.id);
      }
      
      res.json({ status: "ok", name });
    } catch(e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/sessions/:id/workspace/files/:path", async (req, res) => {
    try {
      const base = path.join(process.cwd(), 'workspace', req.params.id);
      const { deleteWorkspaceFile } = await import("./src/agent/tools.js");
      await deleteWorkspaceFile(req.params.id, req.params.path);
      res.json({ status: "ok" });
    } catch(e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put("/api/sessions/:id/workspace/files/:path/rename", async (req, res) => {
    try {
      const { newName } = req.body;
      const { renameWorkspaceFile } = await import("./src/agent/tools.js");
      await renameWorkspaceFile(req.params.id, req.params.path, newName);
      res.json({ status: "ok" });
    } catch(e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put("/api/sessions/:id/workspace/files/:path/content", async (req, res) => {
    try {
      const { rawHtml, contentHtml } = req.body;
      const { syncToR2 } = await import("./src/agent/tools.js");
      const base = path.join(process.cwd(), 'workspace', req.params.id);
      let filename = req.params.path;
      if (!filename) return res.status(400).json({error: "Missing filename"});

      let fullPath = path.join(base, filename);
      if (!fullPath.startsWith(base)) {
        return res.status(403).json({ error: "Access denied" });
      }
      
      const fs = await import("fs/promises");

      if (filename.toLowerCase().endsWith('.docx')) {
        // It's a .docx file being saved from the UI as HTML text.
        // We need to save the HTML to the .doc.html cache file, AND convert it to real .docx
        const htmlFilename = filename.replace(/\.docx$/i, '.doc.html');
        const fileBufferHtml = Buffer.from(rawHtml, 'utf8');
        
        // 1. Save .doc.html
        await fs.writeFile(path.join(base, htmlFilename), fileBufferHtml);
        await syncToR2(htmlFilename, fileBufferHtml, req.params.id);
        
        // Preprocess html to ensure better conversion for html-to-docx
        // Use contentHtml if provided to wrap the text in the default editor styles
        const docxBuffer = await (await import("./src/lib/html-to-docx-custom.js")).customHtmlToDocx(rawHtml);
        
        // Save real .docx
        await fs.writeFile(fullPath, docxBuffer);
        await syncToR2(filename, docxBuffer, req.params.id);

      } else {
        const fileBuffer = Buffer.from(rawHtml, 'utf8');
        await fs.writeFile(fullPath, fileBuffer);
        await syncToR2(req.params.path, fileBuffer, req.params.id);
      }

      res.json({ status: "ok" });
    } catch(e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/sessions/:id/message", async (req, res) => {
    const { content, role, toolCallId } = req.body;
    try {
      await addMessage(req.params.id, content, role, toolCallId);
      res.json({ status: "ok" });
    } catch(e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post("/api/sessions/:id/stop", async (req, res) => {
    try {
      const session = await getSession(req.params.id);
      if (session) {
        session.status = "idle";
        await updateSession(session);
      }
      res.json(session || { error: "Not found" });
    } catch(e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/querydb", async (req, res) => {
    try {
      const { rows } = await pool.query("SELECT role, name, tool_calls, content, created_at, is_human_intervention FROM messages ORDER BY created_at DESC LIMIT 10");
      res.json(rows);
    } catch(e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/sessions/:id/step", async (req, res) => {
    try {
      console.log(`[API] stepSession start for ${req.params.id}`);
      const session = await stepSession(req.params.id);
      console.log(`[API] stepSession end for ${req.params.id}`);
      res.json(session);
    } catch(e: any) {
      console.error(`[API] stepSession error for ${req.params.id}:`, e);
      res.status(500).json({ error: e.message });
    }
  });

  // Debug: agent performance metrics
  app.get("/api/sessions/:id/metrics", async (req, res) => {
    try {
      const { getSessionMetrics } = await import("./src/agent/logger.js");
      const metrics = await getSessionMetrics(req.params.id);
      if (!metrics) return res.status(404).json({ error: "No metrics found for this session" });
      res.json(metrics);
    } catch(e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Vite middlewware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR === 'true' ? false : { port: (24678 + Math.floor(Math.random() * 10000)) }
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
  server.on('error', (e: any) => {
    if (e.code === 'EADDRINUSE') {
      console.log('Address in use, retrying...');
      setTimeout(() => {
        server.close();
        server.listen(PORT, "0.0.0.0");
      }, 1000);
    }
  });
}

startServer();
