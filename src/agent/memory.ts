import { pool } from '../lib/db.js';

// -------------------------------------------------------------------------------- //
// Tier 2: Core Memory (Entity / Working Memory) API 
// -------------------------------------------------------------------------------- //

export async function getCoreMemory(): Promise<Record<string, string>> {
  try {
    const { rows: data } = await pool.query('SELECT key, value FROM core_memory');
    const mem: Record<string, string> = {};
    for (const r of data || []) {
      mem[r.key] = r.value;
    }
    return mem;
  } catch (error) {
    console.error('Error fetching core_memory:', error);
    return {};
  }
}

export async function setCoreMemory(key: string, value: string) {
  try {
    await pool.query(
      'INSERT INTO core_memory (key, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=EXCLUDED.updated_at',
      [key, value, Date.now()]
    );
  } catch (error) {
    console.error('Error setting core_memory:', error);
  }
}

export async function deleteCoreMemory(key: string) {
  try {
    await pool.query('DELETE FROM core_memory WHERE key = $1', [key]);
  } catch (error) {
    console.error('Error deleting core_memory:', error);
  }
}

// -------------------------------------------------------------------------------- //
// Tier 3: Episodic Memory (Long-term RAG Semantic Search) API
// -------------------------------------------------------------------------------- //

async function generateEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENROUTER_API_KEY environment variable for embeddings.");
  }
  
  const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "qwen/qwen3-embedding-8b", 
      input: text
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenRouter Embedding Error: ${response.status} ${err}`);
  }

  const data = await response.json();
  if (data.data && data.data[0] && data.data[0].embedding) {
    return data.data[0].embedding;
  }
  throw new Error("Failed to extract embedding from response.");
}

export async function addEpisodicMemory(content: string) {
  try {
    const embedding = await generateEmbedding(content);
    const embeddingStr = JSON.stringify(embedding);

    await pool.query(
      'INSERT INTO episodic_memory_v2 (content, embedding, created_at) VALUES ($1, $2, $3)',
      [content, embeddingStr, Date.now()]
    );
  } catch (error) {
    console.error('Error inserting episodic memory:', error);
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function searchEpisodicMemory(query: string, limit: number = 3, threshold: number = 0.5): Promise<string[]> {
  try {
    const queryEmbedding = await generateEmbedding(query);

    const { rows } = await pool.query(
      'SELECT content, embedding FROM episodic_memory_v2 ORDER BY created_at DESC LIMIT 1000'
    );

    const scored = rows.map((r: any) => {
      let emb: number[] = [];
      try { emb = JSON.parse(r.embedding); } catch {}
      const score = emb.length > 0 ? cosineSimilarity(queryEmbedding, emb) : 0;
      return { content: r.content, score };
    });

    return scored
      .filter(s => s.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.content);
  } catch (error) {
    console.error('Error searching episodic memory:', error);
    return [];
  }
}

