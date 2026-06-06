import { useMemo, useState, useEffect, useRef } from 'react';
import { Search, Folder, MessageSquare, ChevronRight } from 'lucide-react';

interface Space {
  id: string;
  name: string;
  parentId: string | null;
  updatedAt: number;
}

interface Session {
  id: string;
  name: string;
  spaceId: string;
  updatedAt: number;
}

interface SearchResultsProps {
  query: string;
  spaces: Space[];
  sessions: Session[];
  onClose: () => void;
  onSelectSpace: (id: string) => void;
  onSelectThread: (sessionId: string, spaceId: string) => void;
}

interface SpaceResult {
  type: 'space';
  id: string;
  name: string;
  path: Space[];
  updatedAt: number;
}

interface ThreadResult {
  type: 'thread';
  id: string;
  name: string;
  spaceId: string;
  path: Space[];
  updatedAt: number;
}

type Result = SpaceResult | ThreadResult;

function buildPaths(spaces: Space[]): Map<string, Space[]> {
  const byId = new Map(spaces.map(s => [s.id, s]));
  const cache = new Map<string, Space[]>();
  const visiting = new Set<string>();

  const pathOf = (id: string): Space[] => {
    if (cache.has(id)) return cache.get(id)!;
    if (visiting.has(id)) return []; // cycle guard
    visiting.add(id);
    const space = byId.get(id);
    if (!space) {
      visiting.delete(id);
      return [];
    }
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

function pathToString(path: Space[]): string {
  return path.map(s => s.name).join(' › ');
}

export function SearchResults({ query, spaces, sessions, onClose, onSelectSpace, onSelectThread }: SearchResultsProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const results: Result[] = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    const paths = buildPaths(spaces);
    const out: Result[] = [];

    // Espacios
    for (const space of spaces) {
      if (space.name.toLowerCase().includes(q)) {
        out.push({
          type: 'space',
          id: space.id,
          name: space.name,
          path: paths.get(space.id) || [space],
          updatedAt: space.updatedAt,
        });
      }
    }

    // Hilos (sesiones)
    for (const thread of sessions) {
      if (thread.name.toLowerCase().includes(q)) {
        out.push({
          type: 'thread',
          id: thread.id,
          name: thread.name,
          spaceId: thread.spaceId,
          path: paths.get(thread.spaceId) || [],
          updatedAt: thread.updatedAt,
        });
      }
    }

    return out.slice(0, 30);
  }, [query, spaces, sessions]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (results.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex(i => Math.min(i + 1, results.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex(i => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const r = results[activeIndex];
        if (!r) return;
        if (r.type === 'space') onSelectSpace(r.id);
        else onSelectThread(r.id, r.spaceId);
        onClose();
      } else if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [results, activeIndex, onSelectSpace, onSelectThread, onClose]);

  if (!query.trim() || results.length === 0) {
    if (query.trim() && results.length === 0) {
      return (
        <div ref={containerRef} className="absolute top-full mt-1 right-0 w-96 bg-white border border-gray-200 rounded-lg shadow-lg z-30 p-4 text-center text-sm text-gray-500">
          Sin resultados para "{query}"
        </div>
      );
    }
    return null;
  }

  const spaceResults = results.filter((r): r is SpaceResult => r.type === 'space');
  const threadResults = results.filter((r): r is ThreadResult => r.type === 'thread');

  const handleClick = (r: Result) => {
    if (r.type === 'space') onSelectSpace(r.id);
    else onSelectThread(r.id, r.spaceId);
    onClose();
  };

  return (
    <div ref={containerRef} className="absolute top-full mt-1 right-0 w-[28rem] bg-white border border-gray-200 rounded-lg shadow-lg z-30 overflow-hidden">
      <div className="max-h-96 overflow-y-auto">
        {spaceResults.length > 0 && (
          <div>
            <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider bg-gray-50 border-b border-gray-100">
              Espacios ({spaceResults.length})
            </div>
            {spaceResults.map((r) => {
              const idx = results.indexOf(r);
              return (
                <button
                  key={`s-${r.id}`}
                  onClick={() => handleClick(r)}
                  onMouseEnter={() => setActiveIndex(idx)}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors ${idx === activeIndex ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                >
                  <Folder className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{r.name}</div>
                    {r.path.length > 1 && (
                      <div className="text-xs text-gray-500 truncate flex items-center gap-0.5">
                        {r.path.slice(0, -1).map((p, i) => (
                          <span key={p.id} className="flex items-center gap-0.5">
                            {i > 0 && <ChevronRight className="w-2.5 h-2.5 text-gray-300" />}
                            {p.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {threadResults.length > 0 && (
          <div>
            <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider bg-gray-50 border-b border-gray-100 border-t">
              Hilos ({threadResults.length})
            </div>
            {threadResults.map((r) => {
              const idx = results.indexOf(r);
              return (
                <button
                  key={`t-${r.id}`}
                  onClick={() => handleClick(r)}
                  onMouseEnter={() => setActiveIndex(idx)}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors ${idx === activeIndex ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                >
                  <MessageSquare className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{r.name}</div>
                    {r.path.length > 0 && (
                      <div className="text-xs text-gray-500 truncate flex items-center gap-0.5">
                        {r.path.map((p, i) => (
                          <span key={p.id} className="flex items-center gap-0.5">
                            {i > 0 && <ChevronRight className="w-2.5 h-2.5 text-gray-300" />}
                            {p.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="px-3 py-1.5 text-[10px] text-gray-400 bg-gray-50 border-t border-gray-100 flex items-center gap-2">
        <span>↑↓ navegar</span>
        <span>↵ abrir</span>
        <span>Esc cerrar</span>
      </div>
    </div>
  );
}
