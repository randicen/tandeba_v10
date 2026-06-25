import 'dotenv/config';
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { pool } from "./src/lib/db.js";
import { fileURLToPath } from "url";
import multer from "multer";
// Re-export para mantener compatibilidad con imports externos (e.g. tests/manual).
// La implementación vive en src/lib/docx/preprocess-html.ts.
export { preprocessHtmlForDocx } from "./src/lib/docx/preprocess-html.js";
import { preprocessHtmlForDocx } from "./src/lib/docx/preprocess-html.js";

// Agent imports
import { v4 as uuidv4 } from "uuid";
// Initialize agent logic later

import { createSession, getSession, getSessions, stepSession, addMessage, updateSession } from "./src/agent/agent.js";
import { getWorkspaceFiles, syncWorkspaceFromR2, ensureFileLocal } from "./src/agent/tools.js";
import { isInsufficientBalance, MAINTENANCE_MESSAGE, getUserMessage } from "./src/lib/llm-errors.js";

// D3.4: Auth stack
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import {
  authHandler,
  authMiddleware,
  AUTH_ROUTE_PATTERN,
  runBetterAuthMigrations,
} from "./src/lib/auth/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  // D3.4: aplicar migraciones de Better Auth ANTES de cualquier I/O
  // de red. Las migraciones son DB-only y forward-compat. Si fallan
  // las logueamos pero no abortamos — el server puede seguir
  // corriendo aunque los endpoints /api/auth/* fallen hasta que se
  // resuelva.
  try {
    await runBetterAuthMigrations();
  } catch (e) {
    console.error("[startServer] Better Auth migrations failed:", e);
  }

  // Sync R2 — no bloquea si falla. En dev offline, no tenemos R2.
  try {
    await syncWorkspaceFromR2();
  } catch (e) {
    console.warn("[startServer] syncWorkspaceFromR2 failed (continuamos):", (e as Error).message);
  }

  // Migrate orphan sessions without space_id into a default space
  try {
    const { pool } = await import("./src/lib/db.js");
    const { getOrCreateDefaultSpace } = await import("./src/agent/spaces.js");
    const space = await getOrCreateDefaultSpace();
    await pool.query('UPDATE sessions SET space_id = $1 WHERE space_id IS NULL', [space.id]);
  } catch { /* DB might not be available */ }

  const app = express();
  const PORT = 3000;

  // ============================================================================
  // D3.4: Auth stack
  // ----------------------------------------------------------------------------
  // Orden importa (ver AGENT_D3_4_5_DB_AUTH_SPEC.md §4.6):
  // 1. helmet() PRIMERO — security headers aplican a TODAS las responses
  // 2. rateLimit en /api/auth/* — antes del handler para bloquear brute force
  // 3. authHandler en /api/auth/* — Better Auth ANTES de express.json() para
  //    que pueda parsear los bodies de OAuth callbacks
  // 4. express.json() — para todo lo demás
  // 5. authMiddleware en /api/* — valida session y rechaza con 401
  // 6. (rutas existentes)
  // ============================================================================

  // 1. Helmet — security headers globales. CSP estricta con allowlist para
  // accounts.google.com (necesario para OAuth redirect).
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "accounts.google.com"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'", "accounts.google.com"],
          frameSrc: ["accounts.google.com"],
          // HSTS solo en prod. En dev (localhost sobre HTTP) sería ruido.
        },
      },
      hsts:
        process.env.NODE_ENV === "production"
          ? { maxAge: 31536000, includeSubDomains: true, preload: true }
          : false,
    }),
  );

  // 2. Rate limit solo para /api/auth/* (sign-in, callback, sign-out).
  // 30 requests / 5 min por IP. Configurable por env var si hace falta.
  const authLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: parseInt(process.env.AUTH_RATE_LIMIT_MAX ?? "30", 10),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "RATE_LIMITED" },
  });

  // 3. Better Auth handler ANTES de express.json(). Ver docs:
  // https://www.better-auth.com/docs/installation#mount-handler
  app.use(AUTH_ROUTE_PATTERN, authLimiter, authHandler);

  // 4. express.json() para todos los demás endpoints.
  app.use(express.json());

  // 5. authMiddleware en /api/* — valida session, inyecta req.user.
  // authMiddleware internamente skip /api/auth/* (público) y /api/health.
  app.use("/api", authMiddleware);
  
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

  // AI stateless endpoints (chat con editor + ghostwriter). Definidos en
  // src/agent/api-routes.ts para reducir la superficie de server.ts.
  const { aiRouter } = await import("./src/agent/api-routes.js");
  app.use("/api/ai", aiRouter);

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

  app.put("/api/spaces/:id/archive", async (req, res) => {
    try {
      const { archiveSpace } = await import("./src/agent/spaces.js");
      const archived = req.body.archived === true;
      await archiveSpace(req.params.id, archived);
      res.json({ status: "ok", archived });
    } catch(e: any) { res.status(500).json({ error: e.message }); }
  });

  app.put("/api/spaces/:id/move", async (req, res) => {
    try {
      const { moveSpace, getDescendantIds, getSpace } = await import("./src/agent/spaces.js");
      const newParentId = req.body.parentId === undefined || req.body.parentId === null || req.body.parentId === '' ? null : String(req.body.parentId);
      // Prevenir mover a sí mismo o a un descendiente (ciclo)
      if (newParentId) {
        const descendants = await getDescendantIds(req.params.id);
        if (descendants.has(newParentId)) {
          return res.status(400).json({ error: "No puedes mover un espacio a uno de sus descendientes" });
        }
        const target = await getSpace(newParentId);
        if (!target) return res.status(404).json({ error: "Espacio destino no encontrado" });
      }
      await moveSpace(req.params.id, newParentId);
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
      const includeArchived = req.query.includeArchived === 'true' || req.query.includeArchived === '1';
      res.json(await getSessions(spaceId || undefined, includeArchived));
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

  app.put("/api/sessions/:id", async (req, res) => {
    try {
      const { renameSession } = await import("./src/agent/agent.js");
      const name = (req.body?.name || '').toString().trim();
      if (!name) return res.status(400).json({ error: "El nombre no puede estar vacío" });
      if (name.length > 200) return res.status(400).json({ error: "Nombre demasiado largo" });
      await renameSession(req.params.id, name);
      res.json({ status: "ok", name });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put("/api/sessions/:id/archive", async (req, res) => {
    try {
      const { archiveSession } = await import("./src/agent/agent.js");
      const archived = req.body?.archived === true;
      await archiveSession(req.params.id, archived);
      res.json({ status: "ok", archived });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/sessions/:id", async (req, res) => {
    try {
      const { deleteSession } = await import("./src/agent/agent.js");
      await deleteSession(req.params.id);
      res.json({ status: "ok" });
    } catch (e: any) {
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
      if (isInsufficientBalance(e)) {
        // Log interno con el error real (status, body, stack) para monitoría.
        // El usuario ve solo el mensaje genérico de mantenimiento.
        console.error(`[INTERNAL] stepSession 402 Insufficient Balance for ${req.params.id}:`, e);
        return res.status(503).json({
          error: MAINTENANCE_MESSAGE,
          code: "SERVICE_UNAVAILABLE",
        });
      }
      console.error(`[API] stepSession error for ${req.params.id}:`, e);
      res.status(500).json({ error: getUserMessage(e) });
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

  // Auditoría de runs del agente (Worgena)
  // Lista runs, detalle, exportación, estadísticas agregadas.
  const auditRouter = (await import("./src/audit/router.js")).default;
  app.use("/api/audit", auditRouter);

  // D3.4: Login page estática en /login. Se sirve desde public/login.html.
  // En dev, Vite middleware (más abajo) puede interceptar — agregamos
  // la ruta ANTES de Vite para que sirva el HTML estático primero.
  const publicPath = path.join(process.cwd(), "public");
  app.use("/login", (_req, res) => {
    res.sendFile(path.join(publicPath, "login.html"));
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
