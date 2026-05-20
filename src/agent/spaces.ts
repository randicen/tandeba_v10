import { pool } from '../lib/db.js';
import { v4 as uuidv4 } from 'uuid';

export interface Space {
  id: string;
  name: string;
  instructions: string;
  createdAt: number;
  updatedAt: number;
}

export async function createSpace(name: string): Promise<Space> {
  const id = uuidv4();
  const now = Date.now();
  await pool.query(
    'INSERT INTO spaces (id, name, instructions, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)',
    [id, name, '', now, now]
  );
  return { id, name, instructions: '', createdAt: now, updatedAt: now };
}

export async function getSpaces(): Promise<Space[]> {
  const { rows } = await pool.query(
    'SELECT id, name, COALESCE(instructions, \'\') as instructions, created_at, updated_at FROM spaces ORDER BY updated_at DESC'
  );
  return rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    instructions: r.instructions || '',
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  }));
}

export async function getSpace(id: string): Promise<Space | null> {
  const { rows } = await pool.query(
    'SELECT id, name, COALESCE(instructions, \'\') as instructions, created_at, updated_at FROM spaces WHERE id = $1',
    [id]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    name: r.name,
    instructions: r.instructions || '',
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export async function updateSpaceInstructions(id: string, instructions: string): Promise<void> {
  await pool.query('UPDATE spaces SET instructions = $1, updated_at = $2 WHERE id = $3', [instructions, Date.now(), id]);
}

export async function renameSpace(id: string, name: string): Promise<void> {
  await pool.query('UPDATE spaces SET name = $1, updated_at = $2 WHERE id = $3', [name, Date.now(), id]);
}

export async function deleteSpace(id: string): Promise<void> {
  await pool.query('DELETE FROM spaces WHERE id = $1', [id]);
}

export async function getOrCreateDefaultSpace(): Promise<Space> {
  const spaces = await getSpaces();
  if (spaces.length > 0) return spaces[0];
  return createSpace('General');
}
