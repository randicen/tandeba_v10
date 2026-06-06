import { useState, useEffect, useMemo, useRef } from 'react';
import { X, Loader2, Folder, ChevronRight } from 'lucide-react';

interface Space {
  id: string;
  name: string;
  parentId: string | null;
  archived: boolean;
}

interface MoveSpaceModalProps {
  isOpen: boolean;
  space: Space;
  allSpaces: Space[];
  onClose: () => void;
  onMoved: () => void;
}

function buildPaths(spaces: Space[]): Map<string, Space[]> {
  const byId = new Map(spaces.map(s => [s.id, s]));
  const cache = new Map<string, Space[]>();
  const visiting = new Set<string>();

  const pathOf = (id: string): Space[] => {
    if (cache.has(id)) return cache.get(id)!;
    if (visiting.has(id)) return [];
    visiting.add(id);
    const space = byId.get(id);
    if (!space) { visiting.delete(id); return []; }
    let path: Space[];
    if (space.parentId) {
      path = [...pathOf(space.parentId), space];
    } else {
      path = [space];
    }
    cache.set(id, path);
    visiting.delete(id);
    return path;
  };

  for (const s of spaces) pathOf(s.id);
  return cache;
}

function getDescendantIds(rootId: string, allSpaces: Space[]): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const s of allSpaces) {
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

export function MoveSpaceModal({ isOpen, space, allSpaces, onClose, onMoved }: MoveSpaceModalProps) {
  const [selectedParent, setSelectedParent] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const descendants = useMemo(() => getDescendantIds(space.id, allSpaces), [space.id, allSpaces]);
  const paths = useMemo(() => buildPaths(allSpaces), [allSpaces]);

  // Opciones: raíz (null) o cualquier espacio que no sea el actual ni sus descendientes, y que no esté archivado
  const options = useMemo(() => {
    const out: Array<{ id: string | null; label: string }> = [{ id: null, label: 'Raíz (sin padre)' }];
    for (const s of allSpaces) {
      if (s.archived) continue;
      if (s.id === space.id) continue;
      if (descendants.has(s.id)) continue;
      const path = paths.get(s.id) || [s];
      out.push({ id: s.id, label: path.map(p => p.name).join(' › ') });
    }
    return out;
  }, [allSpaces, descendants, paths, space.id]);

  useEffect(() => {
    setSelectedParent(space.parentId);
    setError(null);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [space.id, space.parentId]);

  const handleSave = async () => {
    if (selectedParent === space.parentId) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/spaces/${space.id}/move`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentId: selectedParent }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      onMoved();
      onClose();
    } catch (e: any) {
      setError(e.message || 'Error al mover');
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSave();
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 bg-gray-900/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-100">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Mover espacio</h2>
            <p className="text-xs text-gray-500 mt-0.5">"{space.name}" se moverá al nuevo padre</p>
          </div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 rounded">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 max-h-80 overflow-y-auto">
          <label className="block text-sm font-medium text-gray-700 mb-2">Nuevo padre</label>
          <div className="space-y-1">
            {options.map((opt) => {
              const isSelected = selectedParent === opt.id;
              return (
                <button
                  key={opt.id ?? 'root'}
                  ref={opt.id === selectedParent ? inputRef : undefined}
                  onClick={() => setSelectedParent(opt.id)}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-sm transition-colors ${isSelected ? 'bg-blue-50 border border-blue-300 text-blue-900' : 'border border-transparent hover:bg-gray-50 text-gray-700'}`}
                >
                  {opt.id === null ? (
                    <span className="w-4 h-4 rounded border-2 border-gray-300 shrink-0" />
                  ) : (
                    <Folder className="w-4 h-4 text-amber-500 shrink-0" />
                  )}
                  <span className="truncate">{opt.label}</span>
                </button>
              );
            })}
          </div>
          {options.length === 1 && (
            <p className="text-xs text-gray-400 mt-2 text-center">No hay otros espacios disponibles</p>
          )}
          {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 p-4 bg-gray-50 border-t border-gray-100">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-200 rounded-lg transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1.5"
          >
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Mover
          </button>
        </div>
      </div>
    </div>
  );
}
