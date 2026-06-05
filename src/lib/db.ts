import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(process.cwd(), 'worgena.db');

const db = new Database(DB_PATH);
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
        updated_at BIGINT
      );

      CREATE TABLE IF NOT EXISTS spaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        instructions TEXT DEFAULT '',
        created_at BIGINT,
        updated_at BIGINT
      );

      CREATE INDEX IF NOT EXISTS sessions_space_id_idx ON sessions(space_id);

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
    `);
    console.log('SQLite database ready at', DB_PATH);
  } catch (e: any) {
    console.error('Failed to initialize SQLite schema:', e.message);
  }
}

initDB();
