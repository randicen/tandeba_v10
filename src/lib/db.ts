import { Pool } from 'pg';

const dbUrl = process.env.XATA_BRANCH_URL;
if (!dbUrl) {
  throw new Error("XATA_BRANCH_URL environment variable is required. Please set it in your .env file.");
}

export const pool = new Pool({
  connectionString: dbUrl,
  max: 20
});

async function initDB() {
  try {
    const client = await pool.connect();
    try {
      await client.query(`
      CREATE EXTENSION IF NOT EXISTS vector;

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        name TEXT,
        status TEXT,
        space_id TEXT,
        created_at BIGINT,
        updated_at BIGINT
      );

      -- Migration: add space_id to existing sessions table
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS space_id TEXT;
      -- Migration: add instructions to spaces table
      ALTER TABLE spaces ADD COLUMN IF NOT EXISTS instructions TEXT DEFAULT '';

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

      -- Tier 2: Core Memory (Entity/Fact storage)
      CREATE TABLE IF NOT EXISTS core_memory (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at BIGINT
      );

      -- Tier 3: Episodic Memory (Vector DB Semantic Search)
      CREATE TABLE IF NOT EXISTS episodic_memory_v2 (
        id SERIAL PRIMARY KEY,
        content TEXT,
        embedding vector,
        created_at BIGINT
      );
    `);
    } catch(e) {
      console.error("Failed to initialize Xata Postres table schema:", e);
    } finally {
      client.release();
    }
  } catch {
    console.warn("Database not available. Running without persistence. Set XATA_BRANCH_URL in .env to enable session storage.");
  }
}

initDB();
