import { useEffect, useState, useCallback } from 'react';
import { Plus, MoreVertical, Search, ArrowLeft, Trash2, Edit2 } from 'lucide-react';
import { Breadcrumb, formatRelativeTime, BreadcrumbItem } from './Breadcrumb';
import { SpaceListItem } from './SpaceListItem';
import { ThreadListItem } from './ThreadListItem';
import { SpaceSidebar } from './SpaceSidebar';
import { SpaceChatInput } from './SpaceChatInput';
import { CreateSpaceModal } from './CreateSpaceModal';

interface Space {
  id: string;
  name: string;
  instructions: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
}

interface Session {
  id: string;
  name: string;
  spaceId: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  messages?: Array<{ role: string; content: string }>;
}

interface SpacesMainViewProps {
  activeSpaceId: string | null;
  onSelectSpace: (id: string | null) => void;
  onSelectThread: (sessionId: string, spaceId: string | null) => void;
}

const PAGE_SIZE = 5;

export function SpacesMainView({ activeSpaceId, onSelectSpace, onSelectThread }: SpacesMainViewProps) {
  const [allSpaces, setAllSpaces] = useState<Space[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [subspacesShown, setSubspacesShown] = useState(PAGE_SIZE);
  const [threadsShown, setThreadsShown] = useState(PAGE_SIZE);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);

  const activeSpace = activeSpaceId ? allSpaces.find(s => s.id === activeSpaceId) || null : null;

  // Cargar todos los espacios
  const loadSpaces = useCallback(async () => {
    try {
      const res = await fetch('/api/spaces?flat=true');
      const data = await res.json();
      setAllSpaces(data);
    } catch (e) {
      console.error('Error loading spaces:', e);
    }
  }, []);

  // Cargar sesiones (de un espacio o todas si estamos en raíz)
  const loadSessions = useCallback(async () => {
    try {
      const url = activeSpaceId ? `/api/sessions?spaceId=${activeSpaceId}` : '/api/sessions';
      const res = await fetch(url);
      const data = await res.json();
      setSessions(data);
    } catch (e) {
      console.error('Error loading sessions:', e);
    }
  }, [activeSpaceId]);

  useEffect(() => {
    setLoading(true);
    Promise.all([loadSpaces(), loadSessions()]).finally(() => setLoading(false));
  }, [loadSpaces, loadSessions]);

  useEffect(() => {
    setSubspacesShown(PAGE_SIZE);
    setThreadsShown(PAGE_SIZE);
    setSearch('');
    setMenuOpen(false);
    setEditingName(false);
  }, [activeSpaceId]);

  // Subespacios: hijos del espacio activo, ordenados por última actividad
  const subspaces = activeSpaceId
    ? allSpaces
        .filter(s => s.parentId === activeSpaceId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
    : [];

  // Hilos: sesiones del espacio activo, ordenadas por última actividad
  const threads = activeSpaceId
    ? sessions
        .filter(s => s.spaceId === activeSpaceId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
    : [];

  // Espacios de raíz (vista raíz): ordenados por última actividad
  const rootSpaces = allSpaces
    .filter(s => s.parentId === null || s.parentId === '')
    .sort((a, b) => b.updatedAt - a.updatedAt);

  // Filtrado por búsqueda
  const filteredRootSpaces = search
    ? rootSpaces.filter(s => s.name.toLowerCase().includes(search.toLowerCase()))
    : rootSpaces;

  // Breadcrumb path
  const breadcrumbItems: BreadcrumbItem[] = [{ id: null, name: 'Espacios' }];
  if (activeSpace) {
    const path: Space[] = [];
    let cur: Space | undefined = activeSpace;
    const visited = new Set<string>();
    while (cur && !visited.has(cur.id)) {
      visited.add(cur.id);
      path.unshift(cur);
      cur = allSpaces.find(s => s.id === cur!.parentId);
    }
    path.forEach(s => breadcrumbItems.push({ id: s.id, name: s.name }));
  }

  const handleRename = async () => {
    if (!activeSpace || !nameDraft.trim() || nameDraft === activeSpace.name) {
      setEditingName(false);
      return;
    }
    try {
      await fetch(`/api/spaces/${activeSpace.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nameDraft.trim() }),
      });
      await loadSpaces();
    } catch (e) {
      console.error('Error renaming:', e);
    } finally {
      setEditingName(false);
    }
  };

  const handleDelete = async () => {
    if (!activeSpace) return;
    if (!confirm(`¿Eliminar el espacio "${activeSpace.name}" y todos sus subespacios?`)) return;
    try {
      await fetch(`/api/spaces/${activeSpace.id}`, { method: 'DELETE' });
      onSelectSpace(null);
    } catch (e) {
      console.error('Error deleting:', e);
    }
  };

  const handleInstructionsUpdate = (newInstructions: string) => {
    setAllSpaces(prev => prev.map(s => s.id === activeSpaceId ? { ...s, instructions: newInstructions } : s));
  };

  if (loading && allSpaces.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500">
        Cargando espacios...
      </div>
    );
  }

  // ====== VISTA RAÍZ (sin activeSpaceId) ======
  if (!activeSpaceId) {
    return (
      <div className="flex-1 flex flex-col bg-white overflow-hidden">
        <div className="border-b border-gray-200 px-6 py-5 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Espacios</h1>
            <p className="text-sm text-gray-500 mt-0.5">Gestiona tus proyectos y sus chats</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar espacios..."
                className="pl-9 pr-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 w-64"
              />
            </div>
            <button
              onClick={() => setCreateModalOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
            >
              <Plus className="w-4 h-4" /> Nuevo espacio
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {filteredRootSpaces.length === 0 ? (
            <div className="text-center py-16">
              <p className="text-gray-500 mb-3">
                {search ? 'No se encontraron espacios' : 'Aún no tienes espacios'}
              </p>
              {!search && (
                <button
                  onClick={() => setCreateModalOpen(true)}
                  className="text-sm text-blue-600 hover:underline"
                >
                  Crear el primero
                </button>
              )}
            </div>
          ) : (
            <div className="border border-gray-200 rounded-lg overflow-hidden bg-white max-w-4xl">
              {filteredRootSpaces.map(space => (
                <SpaceListItem
                  key={space.id}
                  id={space.id}
                  name={space.name}
                  updatedAt={space.updatedAt}
                  onClick={() => onSelectSpace(space.id)}
                />
              ))}
            </div>
          )}
        </div>

        <CreateSpaceModal
          isOpen={createModalOpen}
          parentId={null}
          onClose={() => setCreateModalOpen(false)}
          onCreated={(id) => {
            loadSpaces();
            onSelectSpace(id);
          }}
        />
      </div>
    );
  }

  // ====== VISTA DETALLE (con activeSpaceId) ======
  if (!activeSpace) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-gray-500">
        <p>Espacio no encontrado</p>
        <button onClick={() => onSelectSpace(null)} className="mt-3 text-sm text-blue-600 hover:underline">
          Volver a Espacios
        </button>
      </div>
    );
  }

  const visibleSubspaces = subspaces.slice(0, subspacesShown);
  const visibleThreads = threads.slice(0, threadsShown);
  const hasMoreSubspaces = subspaces.length > subspacesShown;
  const hasMoreThreads = threads.length > threadsShown;

  return (
    <div className="flex-1 flex bg-white overflow-hidden">
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header con breadcrumb y acciones */}
        <div className="border-b border-gray-200 px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => onSelectSpace(null)}
              className="p-1.5 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-md transition-colors"
              title="Volver a Espacios"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <Breadcrumb items={breadcrumbItems} onNavigate={onSelectSpace} />
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar..."
                className="pl-9 pr-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 w-48"
              />
            </div>
            <div className="relative">
              <button
                onClick={() => setMenuOpen(!menuOpen)}
                className="p-1.5 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-md transition-colors"
              >
                <MoreVertical className="w-4 h-4" />
              </button>
              {menuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                  <div className="absolute right-0 top-full mt-1 w-44 bg-white border border-gray-200 rounded-lg shadow-lg z-20 py-1">
                    <button
                      onClick={() => { setMenuOpen(false); setNameDraft(activeSpace.name); setEditingName(true); }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 text-left"
                    >
                      <Edit2 className="w-3.5 h-3.5" /> Renombrar
                    </button>
                    <button
                      onClick={() => { setMenuOpen(false); handleDelete(); }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 text-left"
                    >
                      <Trash2 className="w-3.5 h-3.5" /> Eliminar
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Título del espacio */}
        <div className="px-6 py-4 border-b border-gray-100">
          {editingName ? (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRename();
                  if (e.key === 'Escape') setEditingName(false);
                }}
                onBlur={handleRename}
                autoFocus
                className="text-2xl font-bold text-gray-900 px-2 py-1 border border-blue-500 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500/20 w-full max-w-md"
              />
            </div>
          ) : (
            <h1
              className="text-2xl font-bold text-gray-900 cursor-pointer hover:bg-gray-50 px-1 -mx-1 rounded transition-colors inline-block"
              onDoubleClick={() => { setNameDraft(activeSpace.name); setEditingName(true); }}
              title="Doble-click para renombrar"
            >
              {activeSpace.name}
            </h1>
          )}
        </div>

        {/* Contenido scrolleable */}
        <div className="flex-1 overflow-y-auto">
          {/* Subespacios */}
          <section className="px-6 py-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-gray-700">
                Subespacios {subspaces.length > 0 && <span className="text-gray-400">({subspaces.length})</span>}
              </h2>
              <button
                onClick={() => setCreateModalOpen(true)}
                className="flex items-center gap-1 text-xs text-blue-600 hover:bg-blue-50 px-2 py-1 rounded transition-colors"
              >
                <Plus className="w-3.5 h-3.5" /> Nuevo subespacio
              </button>
            </div>
            {subspaces.length === 0 ? (
              <p className="text-sm text-gray-400 py-4 text-center border border-dashed border-gray-200 rounded-lg">
                Sin subespacios. Crea uno con el botón de arriba.
              </p>
            ) : (
              <>
                <div className="border border-gray-200 rounded-lg overflow-hidden bg-white">
                  {visibleSubspaces.map(s => (
                    <SpaceListItem
                      key={s.id}
                      id={s.id}
                      name={s.name}
                      updatedAt={s.updatedAt}
                      onClick={() => onSelectSpace(s.id)}
                    />
                  ))}
                </div>
                {hasMoreSubspaces && (
                  <button
                    onClick={() => setSubspacesShown(prev => prev + PAGE_SIZE)}
                    className="mt-2 text-sm text-blue-600 hover:underline"
                  >
                    Mostrar más subespacios ({subspaces.length - subspacesShown} ocultos)
                  </button>
                )}
              </>
            )}
          </section>

          {/* Hilos */}
          <section className="px-6 py-5 border-t border-gray-100">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">
              Hilos {threads.length > 0 && <span className="text-gray-400">({threads.length})</span>}
            </h2>
            {threads.length === 0 ? (
              <p className="text-sm text-gray-400 py-4 text-center border border-dashed border-gray-200 rounded-lg">
                Sin hilos aún. Escribe abajo para iniciar uno.
              </p>
            ) : (
              <>
                <div className="border border-gray-200 rounded-lg overflow-hidden bg-white">
                  {visibleThreads.map(t => {
                    const preview = t.messages?.find(m => m.role === 'user')?.content;
                    return (
                      <ThreadListItem
                        key={t.id}
                        id={t.id}
                        name={t.name || 'Hilo sin título'}
                        preview={preview}
                        updatedAt={t.updatedAt}
                        onClick={() => onSelectThread(t.id, activeSpaceId)}
                      />
                    );
                  })}
                </div>
                {hasMoreThreads && (
                  <button
                    onClick={() => setThreadsShown(prev => prev + PAGE_SIZE)}
                    className="mt-2 text-sm text-blue-600 hover:underline"
                  >
                    Mostrar más hilos ({threads.length - threadsShown} ocultos)
                  </button>
                )}
              </>
            )}
          </section>
        </div>

        {/* Input fijo inferior */}
        <SpaceChatInput
          spaceId={activeSpaceId}
          onThreadCreated={(sessionId) => onSelectThread(sessionId, activeSpaceId)}
        />
      </div>

      {/* Panel derecho fijo */}
      <SpaceSidebar
        spaceId={activeSpaceId}
        instructions={activeSpace.instructions}
        onInstructionsChange={handleInstructionsUpdate}
      />

      <CreateSpaceModal
        isOpen={createModalOpen}
        parentId={activeSpaceId}
        parentName={activeSpace.name}
        onClose={() => setCreateModalOpen(false)}
        onCreated={() => loadSpaces()}
      />
    </div>
  );
}
