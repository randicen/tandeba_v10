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

    console.log('SQLite database ready at', DB_PATH);
  } catch (e: any) {
    console.error('Failed to initialize SQLite schema:', e.message);
  }
}

initDB();
