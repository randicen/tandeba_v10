import 'dotenv/config';
import express from "express";
const { raw: rawBodyParser } = express;
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

// P0 #4 Billing: imports para endpoints REST.
import {
  listActivePlans,
  getCurrentPlan,
  getCreditBalance,
  getCreditHistory,
  getFirmSubscription,
  cancelFirmSubscription,
  InsufficientCreditsError,
  EpaycoClient,
  EpaycoWebhookHandler,
  EpaycoError,
} from "./src/lib/billing/index.js";

// D3.4: Auth stack
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import {
  authHandler,
  authMiddleware,
  AUTH_ROUTE_PATTERN,
  runBetterAuthMigrations,
  createFirm as createFirmOp,
  joinFirmViaInvite as joinFirmViaInviteOp,
  createInvitation as createInvitationOp,
  revokeInvitation as revokeInvitationOp,
  getUserFirms,
  getSingleActiveFirmId,
  getFirm as getFirmOp,
  listMembers as listMembersOp,
  logAuthEvent,
} from "./src/lib/auth/index.js";
import { db } from "./src/lib/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  // D3.4: aplicar migraciones de Better Auth ANTES de cualquier I/O
  // de red. Las migraciones son DB-only y forward-compat.
  //
  // FIX HIGH-1 (audit D3.4, 2026-06-24): en producción, fallar loud
  // si las migraciones fallan — el operador debe enterarse. En dev,
  // warn loud para no bloquear el ciclo de iteración.
  try {
    await runBetterAuthMigrations();
  } catch (e) {
    if (process.env.NODE_ENV === "production") {
      console.error("[startServer] FATAL: Better Auth migrations failed in prod:", e);
      throw e;
    } else {
      console.warn(
        "[startServer] Better Auth migrations failed (dev mode, continuing):",
        (e as Error).message,
      );
    }
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
  // 0. HTTPS enforcement (solo prod)
  // 1. helmet() PRIMERO — security headers aplican a TODAS las responses
  // 2. rateLimit en /api/auth/* — antes del handler para bloquear brute force
  // 3. authHandler en /api/auth/* — Better Auth ANTES de express.json() para
  //    que pueda parsear los bodies de OAuth callbacks
  // 4. express.json() — para todo lo demás
  // 5. authMiddleware en /api/* — valida session y rechaza con 401
  // 6. (rutas existentes)
  // ============================================================================

  // 0. FIX HIGH-2 (audit D3.4, 2026-06-24): HTTPS enforcement en prod.
  // Rechaza requests HTTP en producción. Detecta HTTPS vía:
  // - req.secure (nativo Express si hay TLS termination local)
  // - X-Forwarded-Proto (reverse proxy como Railway/Render)
  // En dev (localhost sobre HTTP) se acepta todo.
  app.use((req, res, next) => {
    if (process.env.NODE_ENV !== "production") return next();
    const forwardedProto = req.headers["x-forwarded-proto"];
    const isHttps =
      req.secure ||
      (typeof forwardedProto === "string" && forwardedProto.startsWith("https"));
    if (!isHttps) {
      res.status(403).json({ error: "HTTPS_REQUIRED" });
      return;
    }
    next();
  });

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

  // ============================================================
  // D3.4 redesign: Multi-tenant firm membership endpoints.
  // Todos requieren auth (montados después de app.use("/api", authMiddleware)).
  // ============================================================

  // Helper: extrae el userId del req (seteado por authMiddleware).
  const requireUserId = (req: express.Request): string => {
    const user = (req as express.Request & { user?: { id?: string } }).user;
    if (!user?.id) {
      throw new Error("requireUserId: req.user.id missing");
    }
    return user.id;
  };

  // GET /api/firms/me — lista firms del user actual.
  app.get("/api/firms/me", (req, res) => {
    try {
      const userId = requireUserId(req);
      const firms = getUserFirms(userId);
      res.json({ firms });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/firms — crea firm. El user actual se vuelve owner.
  // Body: { name: string, nit?: string }
  app.post("/api/firms", (req, res) => {
    try {
      const userId = requireUserId(req);
      const { name, nit } = req.body ?? {};
      if (typeof name !== "string" || name.trim().length === 0) {
        res.status(400).json({ error: "name is required" });
        return;
      }
      const firm = createFirmOp(name, userId, nit);
      logAuthEvent({
        event: "firm_created",
        userId,
        metadata: { firmId: firm.id, name: firm.name, nit: firm.nit },
      });
      // Auto-set activeFirmId: actualizamos auth_session con la nueva firm.
      // Se hace via Better Auth API. Para el MVP, simplemente lo seteamos
      // en la sesión activa via la API de Better Auth (updateSession).
      // Si Better Auth 1.6 no soporta additionalFields en updateSession,
      // fallback: query + update directo.
      // (Implementación completa en la versión 2: persistir activeFirmId
      // en la sesión via Better Auth API.)
      // Por ahora retornamos el firmId para que el frontend sepa qué firm
      // acaba de crear. El siguiente request tendrá que refrescar la sesión
      // para que activeFirmId se setee (lo hace el frontend via GET /api/firms/me
      // o via refresh de sesión).
      res.json({ firmId: firm.id, role: "owner" });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/firms/join — une con invite token.
  // Body: { token: string }
  app.post("/api/firms/join", (req, res) => {
    try {
      const userId = requireUserId(req);
      const { token } = req.body ?? {};
      if (typeof token !== "string" || token.trim().length === 0) {
        res.status(400).json({ error: "token is required" });
        return;
      }
      const result = joinFirmViaInviteOp(userId, token);
      logAuthEvent({
        event: "joined_firm",
        userId,
        metadata: { firmId: result.firm.id, role: result.role, via: "invite" },
      });
      res.json({ firmId: result.firm.id, role: result.role });
    } catch (e: any) {
      const msg = e.message ?? "error";
      if (msg.includes("invalid") || msg.includes("expired")) {
        res.status(410).json({ error: msg });
      } else {
        res.status(500).json({ error: msg });
      }
    }
  });

  // POST /api/firms/:id/invitations — crea invitación. Solo owner/admin.
  // Body: { email?: string, role?: "admin" | "member" }
  app.post("/api/firms/:id/invitations", (req, res) => {
    try {
      const userId = requireUserId(req);
      const firmId = req.params.id;
      const { email, role } = req.body ?? {};
      const r = (role === "admin" || role === "member") ? role : "member";
      const inv = createInvitationOp(firmId, userId, email, r);
      logAuthEvent({
        event: "invitation_created",
        userId,
        metadata: { firmId, invitationId: inv.id, email: email ?? null, role: r },
      });
      res.json({
        invitationId: inv.id,
        token: inv.token,
        expiresAt: inv.expiresAt,
        url: `/onboarding?token=${inv.token}`, // Frontend usa este URL
      });
    } catch (e: any) {
      const msg = e.message ?? "error";
      if (msg.includes("only owner/admin")) {
        res.status(403).json({ error: msg });
      } else {
        res.status(500).json({ error: msg });
      }
    }
  });

  // DELETE /api/firms/:id/invitations/:invitationId — revoca invitación.
  app.delete("/api/firms/:id/invitations/:invitationId", (req, res) => {
    try {
      const userId = requireUserId(req);
      revokeInvitationOp(req.params.invitationId, userId);
      logAuthEvent({
        event: "invitation_revoked",
        userId,
        metadata: { firmId: req.params.id, invitationId: req.params.invitationId },
      });
      res.json({ ok: true });
    } catch (e: any) {
      const msg = e.message ?? "error";
      if (msg.includes("only owner/admin")) {
        res.status(403).json({ error: msg });
      } else if (msg.includes("not found") || msg.includes("already used")) {
        res.status(404).json({ error: msg });
      } else {
        res.status(500).json({ error: msg });
      }
    }
  });

  // GET /api/firms/:id/members — lista miembros. Solo members del firm.
  app.get("/api/firms/:id/members", (req, res) => {
    try {
      const userId = requireUserId(req);
      const members = listMembersOp(req.params.id, userId);
      res.json({ members });
    } catch (e: any) {
      const msg = e.message ?? "error";
      if (msg.includes("not a member")) {
        res.status(403).json({ error: msg });
      } else {
        res.status(500).json({ error: msg });
      }
    }
  });

  // GET /api/firms/:id — get firm por id. Requiere membership.
  app.get("/api/firms/:id", async (req, res) => {
    try {
      const userId = requireUserId(req);
      const firm = getFirmOp(req.params.id);
      if (!firm) {
        res.status(404).json({ error: "firm not found" });
        return;
      }
      // Verificar que el user es member (cualquier rol).
      const { isMember } = (await import("./src/lib/auth/firm.js"))
        .isMemberOf(userId, req.params.id);
      if (!isMember) {
        res.status(403).json({ error: "not a member of this firm" });
        return;
      }
      res.json({ firm });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/firms/auto-set-active — auto-setear activeFirmId en la sesión
  // si el user tiene exactamente 1 firm. Forward-compat: para multi-firm
  // (D6) se reemplaza por un selector de firm en la UI.
  //
  // El frontend llama este endpoint después de login para que el authMiddleware
  // no rechace con 403 X-Onboarding-Required.
  app.post("/api/firms/auto-set-active", async (req, res) => {
    try {
      const userId = requireUserId(req);
      const singleFirmId = getSingleActiveFirmId(userId);
      if (!singleFirmId) {
        // 0 firms → onboarding required. N>1 firms → D6 selector.
        res
          .status(400)
          .json({ error: "ONBOARDING_REQUIRED", reason: "0_or_multiple_firms" });
        return;
      }
      // Actualizar activeFirmId en auth_session via Better Auth API.
      // Para MVP, lo hacemos via SQL directo. Forward-compat: cuando BA
      // exponga updateSession, usamos la API.
      db.prepare(
        "UPDATE auth_session SET activeFirmId = ? WHERE userId = ?",
      ).run(singleFirmId, userId);
      res.json({ activeFirmId: singleFirmId });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ============================================================
  // P0 #4 Billing endpoints (ePayco + plans + wallet).
  // 7 endpoints REST + 1 webhook público.
  // Spec: AGENT_BILLING_V1_SPEC.md §2.O5.
  // ============================================================

  // Helper: extrae el firmId del req (seteado por authMiddleware).
  const requireFirmId = (req: express.Request): string => {
    const firmId = (req as express.Request & { activeFirmId?: string }).activeFirmId;
    if (!firmId) {
      throw new Error("requireFirmId: req.activeFirmId missing (authMiddleware not run?)");
    }
    return firmId;
  };

  // Plan ID de ePayco (Worgena mapea nuestro plan_id → ePayco plan_id).
  // Default para v1: usamos nuestro plan_id como ePayco plan_id (1:1).
  // Forward-compat: si ePayco requiere IDs distintos, agregar map acá.
  const EPAYCO_PLAN_IDS: Record<string, string> = {
    plan_pro: "worgena_pro_monthly",
    plan_enterprise: "worgena_enterprise_monthly",
  };

  // Map ePayco plan_id → Worgena plan_id para grants de créditos
  // (usado por el webhook handler).
  const EPAYCO_PLAN_TO_CREDITS: Map<string, { credits: number; reason: "plan_grant" }> = new Map([
    ["worgena_pro_monthly", { credits: 2000, reason: "plan_grant" }],
    ["worgena_enterprise_monthly", { credits: 20000, reason: "plan_grant" }],
  ]);

  // Constructor lazy del ePayco client (lee env al primer uso).
  const getEpaycoClient = (): EpaycoClient => {
    const publicKey = process.env.EPAYCO_PUBLIC_KEY ?? "";
    const privateKey = process.env.EPAYCO_PRIVATE_KEY ?? "";
    const testMode = (process.env.EPAYCO_TEST_MODE ?? "true") === "true";
    if (!publicKey || !privateKey) {
      throw new Error(
        "EPAYCO_PUBLIC_KEY y EPAYCO_PRIVATE_KEY son requeridos. Config en .env.",
      );
    }
    return new EpaycoClient({ publicKey, privateKey, testMode });
  };

  // GET /api/billing/plans — PÚBLICO (catálogo de marketing).
  // Skipea authMiddleware (ver handlers.ts skip list).
  app.get("/api/billing/plans", (_req, res) => {
    try {
      const plans = listActivePlans();
      res.json({ plans });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/billing/me — autenticado, retorna plan + balance + period.
  app.get("/api/billing/me", (req, res) => {
    try {
      const firmId = requireFirmId(req);
      const plan = getCurrentPlan(firmId);
      const balance = getCreditBalance(firmId);
      const sub = getFirmSubscription(firmId);
      res.json({
        plan,
        balance,
        subscription: sub,
        currentPeriodEnd: sub?.currentPeriodEnd ?? null,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/billing/subscribe — autenticado, body { planId, paymentMethodToken? }.
  // Crea customer + subscription en ePayco, persiste firm_subscriptions con
  // status='pending', retorna checkoutUrl si requiere acción del cliente.
  app.post("/api/billing/subscribe", async (req, res) => {
    try {
      const firmId = requireFirmId(req);
      const userId = requireUserId(req);
      const { planId, paymentMethodToken } = req.body ?? {};
      if (typeof planId !== "string") {
        res.status(400).json({ error: "planId is required" });
        return;
      }
      // Validar que el plan existe y es subscriptible
      const plan = listActivePlans().find((p) => p.id === planId);
      if (!plan) {
        res.status(404).json({ error: "PLAN_NOT_FOUND" });
        return;
      }
      if (planId === "plan_free") {
        res.status(400).json({ error: "PLAN_FREE_NO_SUBSCRIBE" });
        return;
      }
      const epaycoPlanId = EPAYCO_PLAN_IDS[planId];
      if (!epaycoPlanId) {
        res.status(400).json({ error: "PLAN_NOT_IN_EPAYCO_MAP" });
        return;
      }
      // Si no hay paymentMethodToken, retornar error (el frontend debe
      // tokenizar vía checkout de ePayco primero).
      if (typeof paymentMethodToken !== "string") {
        res.status(400).json({ error: "PAYMENT_METHOD_REQUIRED" });
        return;
      }

      const client = getEpaycoClient();
      // Crear customer (o reusar si ya hay)
      const userEmail = (req as express.Request & { user?: { email?: string } }).user?.email ?? "";
      const userName = (req as express.Request & { user?: { name?: string } }).user?.name ?? userEmail;
      let customer;
      try {
        customer = await client.createCustomer({ email: userEmail, name: userName });
      } catch (e) {
        if (e instanceof EpaycoError && e.code === "EPAYCO_CONFLICT") {
          // Customer ya existe, buscar por email
          const existing = await client.getCustomerByEmail(userEmail);
          if (!existing) throw e;
          customer = existing;
        } else {
          throw e;
        }
      }
      // Crear subscription en ePayco
      const sub = await client.createSubscription({
        customerId: customer.id,
        planId: epaycoPlanId,
        paymentMethodToken,
        urlConfirmation: `${process.env.PUBLIC_URL ?? "http://localhost:3000"}/api/webhooks/epayco`,
      });
      // Persistir firm_subscriptions con status pending (ePayco confirmará vía webhook)
      const { upsertFirmSubscription } = await import("./src/lib/billing/billing.js");
      upsertFirmSubscription(
        firmId,
        planId,
        sub.status,
        customer.id,
        sub.id,
        sub.currentPeriodStart,
        sub.currentPeriodEnd,
      );
      res.json({
        subscriptionId: sub.id,
        status: sub.status,
        checkoutUrl: sub.checkoutUrl,
      });
    } catch (e: any) {
      if (e instanceof EpaycoError) {
        res.status(e.httpStatus || 502).json({ error: e.code, message: e.message });
        return;
      }
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/billing/cancel — autenticado, owner only. Marca cancel_at_period_end.
  app.post("/api/billing/cancel", (req, res) => {
    try {
      const firmId = requireFirmId(req);
      // TODO: validar que el user es owner del firm. Por ahora: cualquier
      // member puede cancelar su propia subscription (forward-compat D6
      // agrega roles granulares).
      const sub = getFirmSubscription(firmId);
      if (!sub) {
        res.status(404).json({ error: "NO_SUBSCRIPTION" });
        return;
      }
      const cancelled = cancelFirmSubscription(firmId);
      res.json({ subscription: cancelled });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/billing/usage?from=&to= — autenticado. Lee de credit_ledger.
  app.get("/api/billing/usage", (req, res) => {
    try {
      const firmId = requireFirmId(req);
      const history = getCreditHistory(firmId, 100);
      res.json({ history });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/billing/wallet — autenticado. Balance + packs + historial.
  app.get("/api/billing/wallet", async (req, res) => {
    try {
      const firmId = requireFirmId(req);
      const balance = getCreditBalance(firmId);
      const { listActivePacks } = await import("./src/lib/billing/billing.js").then(
        (m) => ({ listActivePacks: (m as never)["listActivePacks"] }),
      ).catch(() => ({ listActivePacks: null } as { listActivePacks: unknown }));
      // Listar packs via query directa (más simple)
      const packs = pool.query(
        "SELECT id, name, credits_amount, price_cop FROM credit_packs WHERE is_active = 1 ORDER BY sort_order",
      );
      res.json({ balance, packs: packs.rows });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/billing/wallet/purchase — autenticado, body { creditPackId }.
  // Crea wallet_purchases con status pending, llama ePayco para cobrar,
  // retorna checkoutUrl si requiere acción del cliente.
  app.post("/api/billing/wallet/purchase", async (req, res) => {
    try {
      const firmId = requireFirmId(req);
      const userId = requireUserId(req);
      const { creditPackId } = req.body ?? {};
      if (typeof creditPackId !== "string") {
        res.status(400).json({ error: "creditPackId is required" });
        return;
      }
      // Buscar pack
      const packRow = pool.query(
        "SELECT id, credits_amount, price_cop FROM credit_packs WHERE id = ? AND is_active = 1",
        [creditPackId],
      );
      if (packRow.rows.length === 0) {
        res.status(404).json({ error: "PACK_NOT_FOUND" });
        return;
      }
      const pack = packRow.rows[0] as { id: string; credits_amount: number; price_cop: number };
      // Crear wallet_purchases con status pending
      const purchaseId = `wp-${crypto.randomUUID()}`;
      const now = Date.now();
      pool.query(
        `INSERT INTO wallet_purchases
           (id, firm_id, credit_pack_id, amount_cop, credits_granted, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
        [purchaseId, firmId, pack.id, pack.price_cop, pack.credits_amount, now],
      );
      // Llamar ePayco para crear el cargo
      const client = getEpaycoClient();
      const userEmail = (req as express.Request & { user?: { email?: string } }).user?.email ?? "";
      // Crear o reusar customer
      let customer;
      try {
        customer = await client.createCustomer({
          email: userEmail,
          name: userEmail.split("@")[0] ?? "User",
        });
      } catch (e) {
        if (e instanceof EpaycoError && e.code === "EPAYCO_CONFLICT") {
          const existing = await client.getCustomerByEmail(userEmail);
          if (!existing) throw e;
          customer = existing;
        } else {
          throw e;
        }
      }
      // Resolve existing epayco_customer_id to update firm_subscriptions.
      // For wallet-only purchase, we don't need a subscription, but
      // we record customer_id so the webhook can resolve firm_id.
      const sub = getFirmSubscription(firmId);
      if (sub && !sub.epaycoCustomerId) {
        // Update the existing subscription record with customer_id.
        pool.query(
          "UPDATE firm_subscriptions SET epayco_customer_id = ?, updated_at = ? WHERE id = ?",
          [customer.id, now, sub.id],
        );
      }
      const charge = await client.createCharge({
        customerId: customer.id,
        paymentMethodToken: "use-checkout", // placeholder; el frontend completa via checkout URL
        amount: pack.price_cop,
        currency: "COP",
        description: `Worgena ${pack.credits_amount} credit pack`,
        reference: purchaseId,
        urlConfirmation: `${process.env.PUBLIC_URL ?? "http://localhost:3000"}/api/webhooks/epayco`,
        urlResponse: `${process.env.PUBLIC_URL ?? "http://localhost:3000"}/billing/wallet/complete`,
      });
      // Update wallet_purchases con el epayco charge id
      pool.query(
        "UPDATE wallet_purchases SET epayco_charge_id = ? WHERE id = ?",
        [charge.id, purchaseId],
      );
      res.json({
        purchaseId,
        chargeId: charge.id,
        checkoutUrl: charge.checkoutUrl,
        status: charge.status,
      });
    } catch (e: any) {
      if (e instanceof EpaycoError) {
        res.status(e.httpStatus || 502).json({ error: e.code, message: e.message });
        return;
      }
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/webhooks/epayco — PÚBLICO, autenticado por HMAC signature.
  // Skipea authMiddleware (ver handlers.ts skip list). Lee raw body para
  // verificar firma, luego parsea y procesa.
  app.post(
    "/api/webhooks/epayco",
    rawBodyParser({ type: "*/*" }),
    async (req, res) => {
      try {
        const rawBody = (req as express.Request & { body?: unknown }).body;
        if (typeof rawBody !== "string") {
          res.status(400).json({ error: "Raw body required for webhook" });
          return;
        }
        const signature =
          (req.headers["x-signature"] as string | undefined) ?? "";
        const externalEventId =
          (req.headers["x-event-id"] as string | undefined) ??
          (req.headers["x-id"] as string | undefined) ??
          `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const client = getEpaycoClient();
        const handler = new EpaycoWebhookHandler({
          db: (await import("./src/lib/db.js")).db,
          client,
          planIdToCreditsCop: EPAYCO_PLAN_TO_CREDITS,
        });
        const result = await handler.process(rawBody, signature, externalEventId);
        res.status(result.status).json(result.body);
      } catch (e: any) {
        if (e instanceof EpaycoError) {
          res.status(e.httpStatus || 401).json({ error: e.code, message: e.message });
          return;
        }
        res.status(500).json({ error: e.message });
      }
    },
  );

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

  // D3.4 redesign: Onboarding page estática en /onboarding.
  // El frontend la usa cuando authMiddleware retorna 403 con
  // X-Onboarding-Required: true. Mismo patrón que /login.
  app.use("/onboarding", (_req, res) => {
    res.sendFile(path.join(publicPath, "onboarding.html"));
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

  // P0 #5 jobs: arrancar el worker si está configurado.
  // Si falta RESEND_API_KEY, skip (dev mode sin email).
  if (process.env.RESEND_API_KEY) {
    try {
      const { startJobsWorker } = await import("./src/lib/jobs/worker.js");
      const { ResendProvider } = await import("./src/lib/email/index.js");
      const email = new ResendProvider({
        apiKey: process.env.RESEND_API_KEY,
        fromEmail: process.env.RESEND_FROM_EMAIL ?? "noreply@worgena.com",
        fromName: process.env.RESEND_FROM_NAME ?? "Worgena",
      });
      const jobsWorker = await startJobsWorker({
        db: (await import("./src/lib/db.js")).db,
        email,
        publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${PORT}`,
      });
      console.log("[jobs-worker] started");
      // Graceful shutdown
      const shutdown = async (signal: string) => {
        console.log(`[${signal}] received, shutting down...`);
        await jobsWorker.stop(signal);
        server.close();
        process.exit(0);
      };
      process.on("SIGTERM", () => void shutdown("SIGTERM"));
      process.on("SIGINT", () => void shutdown("SIGINT"));
    } catch (e) {
      console.error("[jobs-worker] failed to start:", e);
    }
  } else {
    console.log(
      "[jobs-worker] RESEND_API_KEY not set, worker NOT started (email jobs will be enqueued but never processed)",
    );
  }
}

startServer();
