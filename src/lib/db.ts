import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(process.cwd(), 'worgena.db');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Convertir $1, $2, ... → ? para SQLite
function convertParams(sql: string): string {
  let result = sql.replace(/\$\d+/g, '?');
  // Convertir ON CONFLICT DO UPDATE a INSERT OR REPLACE (SQLite)
  result = result.replace(
    /INSERT\s+INTO\s+(\w+)\s+\(([^)]+)\)\s+VALUES\s+\(([^)]+)\)\s+ON\s+CONFLICT\s*\(([^)]+)\)\s+DO\s+UPDATE\s+SET.*$/is,
    'INSERT OR REPLACE INTO $1 ($2) VALUES ($3)'
  );
  return result;
}

// Determinar si es SELECT (devuelve rows) o INSERT/UPDATE/DELETE (devuelve changes)
function isReadQuery(sql: string): boolean {
  const trimmed = sql.trim().toUpperCase();
  return trimmed.startsWith('SELECT') || trimmed.startsWith('WITH') || trimmed.startsWith('PRAGMA');
}

// Interfaz compatible con la API de pg pool.query(sql, params) → { rows }
export const pool = {
  query: async (sql: string, params?: any[]): Promise<{ rows: any[] }> => {
    try {
      const safeSql = convertParams(sql);
      
      if (isReadQuery(sql)) {
        const stmt = db.prepare(safeSql);
        const rows = params && params.length > 0 ? stmt.all(...params) : stmt.all();
        return { rows: rows as any[] };
      } else {
        // Para INSERT/UPDATE/DELETE
        const stmt = db.prepare(safeSql);
        const result = params && params.length > 0 ? stmt.run(...params) : stmt.run();
        // Convertir changes → rows vacías para compatibilidad
        return { rows: [] };
      }
    } catch (e: any) {
      console.error('DB query error:', e.message, 'SQL:', sql.substring(0, 200));
      throw e;
    }
  }
};

// Inicializar esquema
function initDB() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        name TEXT,
        status TEXT,
        space_id TEXT,
        created_at BIGINT,
        updated_at BIGINT,
        archived INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS spaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        instructions TEXT DEFAULT '',
        parent_id TEXT,
        archived INTEGER DEFAULT 0,
        created_at BIGINT,
        updated_at BIGINT
      );

      CREATE INDEX IF NOT EXISTS sessions_space_id_idx ON sessions(space_id);
      CREATE INDEX IF NOT EXISTS spaces_parent_id_idx ON spaces(parent_id);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT,
        content TEXT,
        name TEXT,
        reasoning_content TEXT,
        tool_calls TEXT,
        tool_call_id TEXT,
        is_human_intervention INTEGER,
        created_at BIGINT
      );

      CREATE INDEX IF NOT EXISTS messages_session_id_idx ON messages(session_id, created_at);

      CREATE TABLE IF NOT EXISTS core_memory (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at BIGINT
      );

      CREATE TABLE IF NOT EXISTS episodic_memory_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT,
        embedding TEXT,
        created_at BIGINT
      );

      -- ============================================================================
      -- Auditoría de runs del agente (Worgena)
      -- ----------------------------------------------------------------------------
      -- Cada fila en step_logs es una llamada al LLM. Cada fila en tool_calls es
      -- una herramienta ejecutada durante ese step. prompt_sent y raw_response
      -- guardan el JSON completo para análisis forense y tuning de workflows.
      -- ============================================================================
      CREATE TABLE IF NOT EXISTS step_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        step_number INTEGER NOT NULL,
        start_time BIGINT NOT NULL,
        end_time BIGINT,
        duration_ms INTEGER,
        model TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        error_message TEXT,
        messages_count INTEGER NOT NULL DEFAULT 0,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        api_call_duration_ms INTEGER,
        prompt_sent TEXT,
        raw_response TEXT,
        created_at BIGINT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        step_log_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        args TEXT,
        duration_ms INTEGER,
        success INTEGER NOT NULL DEFAULT 1,
        result_preview TEXT,
        FOREIGN KEY (step_log_id) REFERENCES step_logs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS step_logs_session_id_idx ON step_logs(session_id, start_time);
      CREATE INDEX IF NOT EXISTS step_logs_status_idx ON step_logs(status, start_time);
      CREATE INDEX IF NOT EXISTS step_logs_created_at_idx ON step_logs(created_at);
      CREATE INDEX IF NOT EXISTS tool_calls_step_log_id_idx ON tool_calls(step_log_id);
      CREATE INDEX IF NOT EXISTS tool_calls_name_idx ON tool_calls(name);

      -- ============================================================================
      -- Context window summaries (Worgena)
      -- ----------------------------------------------------------------------------
      -- Un summary por sesión que reemplaza los mensajes antiguos cuando el prompt
      -- pasa de UMBRAL tokens. Se actualiza de forma monotónica (nunca decrece el
      -- contenido preservado; el LLM solo agrega/edita, no descarta sin razón).
      -- ============================================================================
      CREATE TABLE IF NOT EXISTS message_summaries (
        session_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        last_summarized_message_index INTEGER NOT NULL DEFAULT 0,
        tokens_approx INTEGER NOT NULL DEFAULT 0,
        updated_at BIGINT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
    `);

    // Migraciones seguras (JS, no SQL): agregan columnas si la tabla ya existía
    const spaceColumns = db.prepare("PRAGMA table_info(spaces)").all() as any[];
    const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all() as any[];
    const stepLogColumns = db.prepare("PRAGMA table_info(step_logs)").all() as any[];

    // B6: cuenta de mensajes optimizados (después del context-manager) para
    // distinguir entre "tamaño del historial" y "lo que se mandó al LLM".
    if (!stepLogColumns.some((c: any) => c.name === 'optimized_messages_count')) {
      try {
        db.exec('ALTER TABLE step_logs ADD COLUMN optimized_messages_count INTEGER');
        console.log('Migration: added optimized_messages_count column to step_logs');
      } catch (e: any) {
        console.error('Migration step_logs.optimized_messages_count failed:', e.message);
      }
    }

    // B7: captura forense de la llamada al resumidor. Permite auditar "qué vio
    // el resumidor" vs "qué produjo", crítico para detectar alucinaciones.
    if (!stepLogColumns.some((c: any) => c.name === 'summarizer_prompt_sent')) {
      try {
        db.exec('ALTER TABLE step_logs ADD COLUMN summarizer_prompt_sent TEXT');
        console.log('Migration: added summarizer_prompt_sent column to step_logs');
      } catch (e: any) {
        console.error('Migration step_logs.summarizer_prompt_sent failed:', e.message);
      }
    }
    if (!stepLogColumns.some((c: any) => c.name === 'summarizer_raw_response')) {
      try {
        db.exec('ALTER TABLE step_logs ADD COLUMN summarizer_raw_response TEXT');
        console.log('Migration: added summarizer_raw_response column to step_logs');
      } catch (e: any) {
        console.error('Migration step_logs.summarizer_raw_response failed:', e.message);
      }
    }

    if (!sessionColumns.some((c: any) => c.name === 'archived')) {
      try {
        db.exec('ALTER TABLE sessions ADD COLUMN archived INTEGER DEFAULT 0');
        db.exec('CREATE INDEX IF NOT EXISTS sessions_archived_idx ON sessions(archived)');
        console.log('Migration: added archived column to sessions');
      } catch (e: any) {
        console.error('Migration sessions.archived failed:', e.message);
      }
    }

    // Apify usage tracking (Dim 1, Item extra — Apify cost capture).
    // Una fila por llamada a `apifyScrapeUrl`. Permite agregar costo por
    // sesión/usuario/periodo sin depender del dashboard de Apify.
    const apifyUsageExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='apify_usage'")
      .get();
    if (!apifyUsageExists) {
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS apify_usage (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            target_url TEXT NOT NULL,
            called_at BIGINT NOT NULL,
            success INTEGER NOT NULL DEFAULT 1,
            error_message TEXT,
            duration_ms INTEGER,
            result_size_bytes INTEGER,
            cost_estimate_usd REAL,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS apify_usage_session_idx ON apify_usage(session_id, called_at);
          CREATE INDEX IF NOT EXISTS apify_usage_called_at_idx ON apify_usage(called_at);
        `);
        console.log('Migration: created apify_usage table');
      } catch (e: any) {
        console.error('Migration apify_usage failed:', e.message);
      }
    }
    if (!spaceColumns.some((c: any) => c.name === 'parent_id')) {
      try {
        db.exec('ALTER TABLE spaces ADD COLUMN parent_id TEXT');
        db.exec('CREATE INDEX IF NOT EXISTS spaces_parent_id_idx ON spaces(parent_id)');
        console.log('Migration: added parent_id column to spaces');
      } catch (e: any) {
        console.error('Migration parent_id failed:', e.message);
      }
    }
    if (!spaceColumns.some((c: any) => c.name === 'archived')) {
      try {
        db.exec('ALTER TABLE spaces ADD COLUMN archived INTEGER DEFAULT 0');
        console.log('Migration: added archived column to spaces');
      } catch (e: any) {
        console.error('Migration archived failed:', e.message);
      }
    }

    // D3.4 redesign: multi-tenant multi-user firm.
    // Tablas: tenants, tenant_members, tenant_invitations.
    // Mismo code path para todos los users (ver AGENT_D3_4_REDESIGN_SPRINT_SPEC.md):
    // - Primer user hace click "Crear firm" → owner
    // - N-ésimo user hace click "Unirse con invite" → member
    // No auto-asumimos firm para nadie.

    // Tabla tenants: la firma misma
    const tenantsExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tenants'")
      .get();
    if (!tenantsExists) {
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS tenants (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            nit TEXT,
            created_at INTEGER NOT NULL,
            created_by TEXT NOT NULL,
            archived_at INTEGER
          );
        `);
        console.log('Migration: created tenants table');
      } catch (e: any) {
        console.error('Migration tenants failed:', e.message);
      }
    }

    // Tabla tenant_members: many-to-many users <-> firms, con roles
    const tenantMembersExists = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='tenant_members'",
      )
      .get();
    if (!tenantMembersExists) {
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS tenant_members (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            tenant_id TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
            joined_at INTEGER NOT NULL,
            invited_by TEXT,
            UNIQUE(user_id, tenant_id),
            FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE,
            FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS tenant_members_user_id_idx ON tenant_members(user_id);
          CREATE INDEX IF NOT EXISTS tenant_members_tenant_id_idx ON tenant_members(tenant_id);
        `);
        console.log('Migration: created tenant_members table');
      } catch (e: any) {
        console.error('Migration tenant_members failed:', e.message);
      }
    }

    // Tabla tenant_invitations: tokens one-time, expirable
    const tenantInvitationsExists = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='tenant_invitations'",
      )
      .get();
    if (!tenantInvitationsExists) {
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS tenant_invitations (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            email TEXT,
            role TEXT NOT NULL DEFAULT 'member',
            token TEXT UNIQUE NOT NULL,
            expires_at INTEGER NOT NULL,
            used_at INTEGER,
            used_by TEXT,
            created_at INTEGER NOT NULL,
            created_by TEXT NOT NULL,
            FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS tenant_invitations_token_idx ON tenant_invitations(token);
          CREATE INDEX IF NOT EXISTS tenant_invitations_email_idx ON tenant_invitations(email);
          CREATE INDEX IF NOT EXISTS tenant_invitations_tenant_id_idx ON tenant_invitations(tenant_id);
        `);
        console.log('Migration: created tenant_invitations table');
      } catch (e: any) {
        console.error('Migration tenant_invitations failed:', e.message);
      }
    }

    // P0 #4 Billing: planes, subscriptions, credit_ledger, credit_packs,
    // wallet_purchases, auto_recharge_config, webhook_events.
    // Schema Postgres-compatible: TEXT, INTEGER, sin AUTOINCREMENT, sin
    // JSONB. credit_ledger es append-only (source of truth del balance).

    // plans: catálogo de planes disponibles. Seeded al final de initDB.
    const plansExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='plans'")
      .get();
    if (!plansExists) {
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS plans (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            monthly_credits INTEGER NOT NULL,
            max_users_per_firm INTEGER NOT NULL,
            monthly_price_cop INTEGER NOT NULL,
            currency TEXT NOT NULL DEFAULT 'COP',
            features_json TEXT,
            is_active INTEGER NOT NULL DEFAULT 1,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS plans_active_idx ON plans(is_active, sort_order);
        `);
        console.log('Migration: created plans table');
      } catch (e: any) {
        console.error('Migration plans failed:', e.message);
      }
    }

    // firm_subscriptions: la suscripción activa de cada firm. Un firm
    // debería tener máximo 1 activa a la vez. Webhook de ePayco crea
    // y actualiza.
    const firmSubscriptionsExists = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='firm_subscriptions'",
      )
      .get();
    if (!firmSubscriptionsExists) {
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS firm_subscriptions (
            id TEXT PRIMARY KEY,
            firm_id TEXT NOT NULL,
            plan_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'past_due', 'cancelled', 'expired')),
            epayco_customer_id TEXT,
            epayco_subscription_id TEXT,
            current_period_start INTEGER,
            current_period_end INTEGER,
            cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
            cancelled_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (firm_id) REFERENCES tenants(id) ON DELETE CASCADE,
            FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE RESTRICT
          );
          CREATE INDEX IF NOT EXISTS firm_subscriptions_firm_id_idx ON firm_subscriptions(firm_id);
          CREATE INDEX IF NOT EXISTS firm_subscriptions_status_idx ON firm_subscriptions(status);
          CREATE INDEX IF NOT EXISTS firm_subscriptions_epayco_sub_idx ON firm_subscriptions(epayco_subscription_id);
        `);
        console.log('Migration: created firm_subscriptions table');
      } catch (e: any) {
        console.error('Migration firm_subscriptions failed:', e.message);
      }
    }

    // credit_ledger: append-only. delta INTEGER (positivo = grant, negativo
    // = consume). SUM(delta) WHERE firm_id = ? = balance. Source of truth.
    const creditLedgerExists = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='credit_ledger'",
      )
      .get();
    if (!creditLedgerExists) {
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS credit_ledger (
            id TEXT PRIMARY KEY,
            firm_id TEXT NOT NULL,
            delta INTEGER NOT NULL,
            reason TEXT NOT NULL CHECK (reason IN ('plan_grant', 'wallet_purchase', 'auto_recharge', 'llm_call', 'refund', 'manual_adjustment', 'expiry')),
            metadata_json TEXT,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (firm_id) REFERENCES tenants(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS credit_ledger_firm_id_idx ON credit_ledger(firm_id, created_at);
          CREATE INDEX IF NOT EXISTS credit_ledger_reason_idx ON credit_ledger(reason);
        `);
        console.log('Migration: created credit_ledger table');
      } catch (e: any) {
        console.error('Migration credit_ledger failed:', e.message);
      }
    }

    // credit_packs: paquetes de compra one-time para wallet.
    const creditPacksExists = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='credit_packs'",
      )
      .get();
    if (!creditPacksExists) {
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS credit_packs (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            credits_amount INTEGER NOT NULL,
            price_cop INTEGER NOT NULL,
            currency TEXT NOT NULL DEFAULT 'COP',
            is_active INTEGER NOT NULL DEFAULT 1,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS credit_packs_active_idx ON credit_packs(is_active, sort_order);
        `);
        console.log('Migration: created credit_packs table');
      } catch (e: any) {
        console.error('Migration credit_packs failed:', e.message);
      }
    }

    // wallet_purchases: compras one-time de packs. status pending → completed
    // cuando ePayco webhook confirma.
    const walletPurchasesExists = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='wallet_purchases'",
      )
      .get();
    if (!walletPurchasesExists) {
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS wallet_purchases (
            id TEXT PRIMARY KEY,
            firm_id TEXT NOT NULL,
            credit_pack_id TEXT NOT NULL,
            epayco_charge_id TEXT,
            amount_cop INTEGER NOT NULL,
            credits_granted INTEGER NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
            failure_reason TEXT,
            created_at INTEGER NOT NULL,
            completed_at INTEGER,
            FOREIGN KEY (firm_id) REFERENCES tenants(id) ON DELETE CASCADE,
            FOREIGN KEY (credit_pack_id) REFERENCES credit_packs(id) ON DELETE RESTRICT
          );
          CREATE INDEX IF NOT EXISTS wallet_purchases_firm_id_idx ON wallet_purchases(firm_id, created_at);
          CREATE INDEX IF NOT EXISTS wallet_purchases_status_idx ON wallet_purchases(status);
          CREATE INDEX IF NOT EXISTS wallet_purchases_epayco_charge_idx ON wallet_purchases(epayco_charge_id);
        `);
        console.log('Migration: created wallet_purchases table');
      } catch (e: any) {
        console.error('Migration wallet_purchases failed:', e.message);
      }
    }

    // auto_recharge_config: configuración opcional por firm. UNIQUE por firm.
    const autoRechargeConfigExists = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='auto_recharge_config'",
      )
      .get();
    if (!autoRechargeConfigExists) {
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS auto_recharge_config (
            id TEXT PRIMARY KEY,
            firm_id TEXT NOT NULL UNIQUE,
            enabled INTEGER NOT NULL DEFAULT 0,
            threshold_credits INTEGER NOT NULL,
            recharge_credit_pack_id TEXT NOT NULL,
            max_per_month_cop INTEGER NOT NULL,
            current_month_spent_cop INTEGER NOT NULL DEFAULT 0,
            current_period TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (firm_id) REFERENCES tenants(id) ON DELETE CASCADE,
            FOREIGN KEY (recharge_credit_pack_id) REFERENCES credit_packs(id) ON DELETE RESTRICT
          );
        `);
        console.log('Migration: created auto_recharge_config table');
      } catch (e: any) {
        console.error('Migration auto_recharge_config failed:', e.message);
      }
    }

    // webhook_events: idempotencia de webhooks. UNIQUE (provider, external_event_id).
    // Status: 'received' (INSERTed, enqueued), 'processed' (side-effects done),
    // 'failed' (ePayco will retry).
    const webhookEventsExists = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='webhook_events'",
      )
      .get();
    if (!webhookEventsExists) {
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS webhook_events (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            external_event_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            payload_json TEXT,
            status TEXT NOT NULL CHECK (status IN ('received', 'processed', 'failed')),
            error_message TEXT,
            received_at INTEGER NOT NULL,
            processed_at INTEGER,
            UNIQUE(provider, external_event_id)
          );
          CREATE INDEX IF NOT EXISTS webhook_events_status_idx ON webhook_events(status, received_at);
        `);
        console.log('Migration: created webhook_events table');
      } catch (e: any) {
        console.error('Migration webhook_events failed:', e.message);
      }
    }

    // P0 #5 Jobs: cola persistente para work async (emails, cleanup, etc).
    // Schema Postgres-compatible: TEXT, INTEGER, sin AUTOINCREMENT.
    // idempotency_key opcional con UNIQUE para deduplicación.
    const jobsExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'")
      .get();
    if (!jobsExists) {
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            idempotency_key TEXT UNIQUE,
            status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'dead_letter')),
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            scheduled_at INTEGER NOT NULL,
            started_at INTEGER,
            completed_at INTEGER,
            created_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS jobs_status_scheduled_idx ON jobs(status, scheduled_at);
          CREATE INDEX IF NOT EXISTS jobs_type_idx ON jobs(type);
          CREATE INDEX IF NOT EXISTS jobs_idempotency_key_idx ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
        `);
        console.log('Migration: created jobs table');
      } catch (e: any) {
        console.error('Migration jobs failed:', e.message);
      }
    }

    // Seed de planes (idempotente: INSERT OR IGNORE). Si la tabla
    // acaba de ser creada, los planes no existen. Si ya existía y los
    // planes también, no duplicamos.
    const seedPlans = [
      {
        id: 'plan_free',
        name: 'Free',
        monthly_credits: 100,
        max_users_per_firm: 1,
        monthly_price_cop: 0,
        currency: 'COP',
        features_json: JSON.stringify({ support: 'community', sla: 'none' }),
        sort_order: 0,
      },
      {
        id: 'plan_pro',
        name: 'Pro',
        monthly_credits: 2000,
        max_users_per_firm: 10,
        monthly_price_cop: 30000,
        currency: 'COP',
        features_json: JSON.stringify({ support: 'email', sla: '99%' }),
        sort_order: 1,
      },
      {
        id: 'plan_enterprise',
        name: 'Enterprise',
        monthly_credits: 20000,
        max_users_per_firm: 100,
        monthly_price_cop: 300000,
        currency: 'COP',
        features_json: JSON.stringify({ support: 'dedicated', sla: '99.9%' }),
        sort_order: 2,
      },
    ];
    const now = Date.now();
    const insertPlan = db.prepare(`
      INSERT OR IGNORE INTO plans
        (id, name, monthly_credits, max_users_per_firm, monthly_price_cop, currency, features_json, is_active, sort_order, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `);
    for (const p of seedPlans) {
      insertPlan.run(
        p.id, p.name, p.monthly_credits, p.max_users_per_firm,
        p.monthly_price_cop, p.currency, p.features_json, p.sort_order, now, now,
      );
    }

    // Seed de credit packs (idempotente).
    const seedPacks = [
      { id: 'pack_100', name: '100 créditos extra', credits_amount: 100, price_cop: 10000, sort_order: 0 },
      { id: 'pack_500', name: '500 créditos extra', credits_amount: 500, price_cop: 45000, sort_order: 1 },
      { id: 'pack_2000', name: '2000 créditos extra', credits_amount: 2000, price_cop: 160000, sort_order: 2 },
    ];
    const insertPack = db.prepare(`
      INSERT OR IGNORE INTO credit_packs
        (id, name, credits_amount, price_cop, currency, is_active, sort_order, created_at)
      VALUES
        (?, ?, ?, ?, 'COP', 1, ?, ?)
    `);
    for (const p of seedPacks) {
      insertPack.run(p.id, p.name, p.credits_amount, p.price_cop, p.sort_order, now);
    }

    console.log('SQLite database ready at', DB_PATH);
  } catch (e: any) {
    console.error('Failed to initialize SQLite schema:', e.message);
  }
}

initDB();
