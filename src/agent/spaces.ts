import { pool } from '../lib/db.js';
import { v4 as uuidv4 } from 'uuid';

export interface Space {
  id: string;
  name: string;
  instructions: string;
  parentId: string | null;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

function rowToSpace(r: any): Space {
  return {
    id: r.id,
    name: r.name,
    instructions: r.instructions || '',
    parentId: r.parent_id || null,
    archived: Number(r.archived || 0) === 1,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export async function createSpace(name: string, parentId: string | null = null): Promise<Space> {
  const id = uuidv4();
  const now = Date.now();
  await pool.query(
    'INSERT INTO spaces (id, name, instructions, parent_id, archived, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [id, name, '', parentId, 0, now, now]
  );
  return { id, name, instructions: '', parentId, archived: false, createdAt: now, updatedAt: now };
}

export async function getSpaces(parentId?: string | null, includeArchived = false): Promise<Space[]> {
  let sql = 'SELECT id, name, COALESCE(instructions, \'\') as instructions, COALESCE(parent_id, \'\') as parent_id, COALESCE(archived, 0) as archived, created_at, updated_at FROM spaces';
  const params: any[] = [];
  const conditions: string[] = [];
  if (parentId !== undefined) {
    if (parentId === null) {
      conditions.push('(parent_id IS NULL OR parent_id = \'\')');
    } else {
      conditions.push('parent_id = ?');
      params.push(parentId);
    }
  }
  if (!includeArchived) {
    conditions.push('(archived IS NULL OR archived = 0)');
  }
  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY updated_at DESC';
  const { rows } = await pool.query(sql, params.length > 0 ? params : undefined);
  return rows.map(rowToSpace);
}

export async function getAllSpacesFlat(): Promise<Space[]> {
  const { rows } = await pool.query(
    'SELECT id, name, COALESCE(instructions, \'\') as instructions, COALESCE(parent_id, \'\') as parent_id, COALESCE(archived, 0) as archived, created_at, updated_at FROM spaces ORDER BY updated_at DESC'
  );
  return rows.map(rowToSpace);
}

export async function getSpace(id: string): Promise<Space | null> {
  const { rows } = await pool.query(
    'SELECT id, name, COALESCE(instructions, \'\') as instructions, COALESCE(parent_id, \'\') as parent_id, COALESCE(archived, 0) as archived, created_at, updated_at FROM spaces WHERE id = $1',
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

export async function archiveSpace(id: string, archived: boolean): Promise<void> {
  await pool.query('UPDATE spaces SET archived = $1, updated_at = $2 WHERE id = $3', [archived ? 1 : 0, Date.now(), id]);
}

export async function moveSpace(id: string, newParentId: string | null): Promise<void> {
  await pool.query('UPDATE spaces SET parent_id = $1, updated_at = $2 WHERE id = $3', [newParentId, Date.now(), id]);
}

/**
 * Devuelve todos los IDs descendientes de un espacio (incluyendo el propio).
 * Se usa para evitar mover un espacio a uno de sus descendientes (lo que crearía un ciclo).
 */
export async function getDescendantIds(rootId: string): Promise<Set<string>> {
  const all = await getAllSpacesFlat();
  const childrenOf = new Map<string, string[]>();
  for (const s of all) {
    const key = s.parentId || '';
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key)!.push(s.id);
  }
  const result = new Set<string>([rootId]);
  const stack = [rootId];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const children = childrenOf.get(cur) || [];
    for (const c of children) {
      if (!result.has(c)) {
        result.add(c);
        stack.push(c);
      }
    }
  }
  return result;
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
