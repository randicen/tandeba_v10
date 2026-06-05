import { pool } from '../lib/db.js';
import { v4 as uuidv4 } from 'uuid';

export interface Space {
  id: string;
  name: string;
  instructions: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
}

function rowToSpace(r: any): Space {
  return {
    id: r.id,
    name: r.name,
    instructions: r.instructions || '',
    parentId: r.parent_id || null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export async function createSpace(name: string, parentId: string | null = null): Promise<Space> {
  const id = uuidv4();
  const now = Date.now();
  await pool.query(
    'INSERT INTO spaces (id, name, instructions, parent_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [id, name, '', parentId, now, now]
  );
  return { id, name, instructions: '', parentId, createdAt: now, updatedAt: now };
}

export async function getSpaces(parentId?: string | null): Promise<Space[]> {
  let sql = 'SELECT id, name, COALESCE(instructions, \'\') as instructions, COALESCE(parent_id, \'\') as parent_id, created_at, updated_at FROM spaces';
  const params: any[] = [];
  if (parentId !== undefined) {
    if (parentId === null) {
      sql += ' WHERE parent_id IS NULL OR parent_id = \'\'';
    } else {
      sql += ' WHERE parent_id = $1';
      params.push(parentId);
    }
  }
  sql += ' ORDER BY updated_at DESC';
  const { rows } = await pool.query(sql, params.length > 0 ? params : undefined);
  return rows.map(rowToSpace);
}

export async function getAllSpacesFlat(): Promise<Space[]> {
  const { rows } = await pool.query(
    'SELECT id, name, COALESCE(instructions, \'\') as instructions, COALESCE(parent_id, \'\') as parent_id, created_at, updated_at FROM spaces ORDER BY updated_at DESC'
  );
  return rows.map(rowToSpace);
}

export async function getSpace(id: string): Promise<Space | null> {
  const { rows } = await pool.query(
    'SELECT id, name, COALESCE(instructions, \'\') as instructions, COALESCE(parent_id, \'\') as parent_id, created_at, updated_at FROM spaces WHERE id = $1',
    [id]
  );
  if (rows.length === 0) return null;
  return rowToSpace(rows[0]);
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

/**
 * Devuelve la cadena de ancestros (path) para un espacio dado.
 * Ej: si id = idDeJuan, y Juan está dentro de Clientes, devuelve [Clientes, Juan].
 */
export async function getSpacePath(id: string): Promise<Space[]> {
  const path: Space[] = [];
  let currentId: string | null = id;
  const visited = new Set<string>();
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const space = await getSpace(currentId);
    if (!space) break;
    path.unshift(space);
    currentId = space.parentId;
  }
  return path;
}

export async function getOrCreateDefaultSpace(): Promise<Space> {
  const spaces = await getSpaces();
  if (spaces.length > 0) return spaces[0];
  return createSpace('General');
}
