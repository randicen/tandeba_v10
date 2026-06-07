import React, { useEffect, useRef, useState } from 'react';
import { MoreVertical, Edit2, Archive, ArchiveRestore, Trash2 } from 'lucide-react';
import { cn } from '../lib/utils';

export interface HistorySession {
  id: string;
  name: string | null;
  spaceId?: string | null;
  archived?: boolean;
  updatedAt: number;
  createdAt: number;
}

interface ChatHistoryListProps {
  sessions: HistorySession[];
  activeSessionId: string | null;
  onSelect: (sessionId: string, spaceId: string | null) => void;
  onRename: (sessionId: string, newName: string) => Promise<void> | void;
  onArchive: (sessionId: string, archived: boolean) => Promise<void> | void;
  onDelete: (sessionId: string) => Promise<void> | void;
  showArchived: boolean;
  onToggleShowArchived: () => void;
}

/**
 * Agrupa sesiones por fecha relativa (Hoy, Ayer, Esta semana, Este mes,
 * Más antiguo). Devuelve un array en orden de más reciente a más antiguo.
 */
function groupByDate(sessions: HistorySession[]): { label: string; items: HistorySession[] }[] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const startOfWeek = startOfToday - 7 * 24 * 60 * 60 * 1000;
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  const groups: Record<string, HistorySession[]> = {
    'Hoy': [],
    'Ayer': [],
    'Esta semana': [],
    'Este mes': [],
    'Más antiguo': [],
  };
  for (const s of sessions) {
    const t = s.updatedAt;
    if (t >= startOfToday) groups['Hoy'].push(s);
    else if (t >= startOfYesterday) groups['Ayer'].push(s);
    else if (t >= startOfWeek) groups['Esta semana'].push(s);
    else if (t >= startOfMonth) groups['Este mes'].push(s);
    else groups['Más antiguo'].push(s);
  }
  return Object.entries(groups)
    .filter(([, items]) => items.length > 0)
    .map(([label, items]) => ({ label, items }));
}

export function ChatHistoryList({
  sessions,
  activeSessionId,
  onSelect,
  onRename,
  onArchive,
  onDelete,
  showArchived,
  onToggleShowArchived,
}: ChatHistoryListProps) {
  const groups = groupByDate(sessions);
  const hasAny = sessions.length > 0;

  return (
    <div>
      <div className="flex items-center justify-between mb-2 px-1">
        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
          Historial
        </div>
        <button
          onClick={onToggleShowArchived}
          title={showArchived ? 'Ocultar archivados' : 'Mostrar archivados'}
          className={cn(
            'text-[10px] px-2 py-0.5 rounded-md transition-colors',
            showArchived
              ? 'bg-gray-800 text-white hover:bg-gray-700'
              : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
          )}
        >
          {showArchived ? 'Ocultar archivados' : 'Ver archivados'}
        </button>
      </div>

      {!hasAny && (
        <p className="text-[11px] text-gray-400 px-3 py-1">Sin historial</p>
      )}

      <div className="space-y-3">
        {groups.map((group) => (
          <div key={group.label}>
            <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1 px-3">
              {group.label}
            </div>
            <nav className="space-y-0.5">
              {group.items.map((s) => (
                <ChatHistoryItem
                  key={s.id}
                  session={s}
                  isActive={activeSessionId === s.id}
                  onSelect={() => onSelect(s.id, s.spaceId ?? null)}
                  onRename={onRename}
                  onArchive={onArchive}
                  onDelete={onDelete}
                />
              ))}
            </nav>
          </div>
        ))}
      </div>
    </div>
  );
}

interface ChatHistoryItemProps {
  session: HistorySession;
  isActive: boolean;
  onSelect: () => void;
  onRename: ChatHistoryListProps['onRename'];
  onArchive: ChatHistoryListProps['onArchive'];
  onDelete: ChatHistoryListProps['onDelete'];
}

function ChatHistoryItem({ session, isActive, onSelect, onRename, onArchive, onDelete }: ChatHistoryItemProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(session.name || '');
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menuOpen]);

  useEffect(() => {
    if (renaming) {
      setDraftName(session.name || '');
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [renaming, session.name]);

  const submitRename = async () => {
    const v = draftName.trim();
    if (v && v !== session.name) {
      await onRename(session.id, v);
    }
    setRenaming(false);
  };

  const handleDelete = () => {
    setMenuOpen(false);
    if (confirm(`¿Eliminar el chat "${session.name || 'sin nombre'}"? Esta acción no se puede deshacer.`)) {
      void onDelete(session.id);
    }
  };

  return (
    <div className="group relative">
      {renaming ? (
        <div className="px-2 py-1">
          <input
            ref={inputRef}
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); void submitRename(); }
              else if (e.key === 'Escape') { setRenaming(false); setDraftName(session.name || ''); }
            }}
            onBlur={() => void submitRename()}
            maxLength={200}
            className="w-full px-2 py-1.5 text-sm border border-blue-500 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          />
        </div>
      ) : (
        <button
          onClick={onSelect}
          className={cn(
            'w-full text-left block rounded-lg pl-3 pr-7 py-2 text-sm transition-colors relative',
            isActive
              ? 'bg-white border border-gray-200 shadow-sm text-gray-900 font-medium'
              : 'hover:bg-white/60 text-gray-600 border border-transparent',
            session.archived && 'opacity-60 italic'
          )}
          title={session.name || 'Chat sin nombre'}
        >
          <span className="truncate block">{session.name || 'Chat sin nombre'}</span>
        </button>
      )}

      {!renaming && (
        <button
          onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
          className={cn(
            'absolute right-1 top-1/2 -translate-y-1/2 w-6 h-6 rounded-md flex items-center justify-center text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors',
            menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          )}
          title="Opciones"
          aria-label="Opciones del chat"
        >
          <MoreVertical className="w-3.5 h-3.5" />
        </button>
      )}

      {menuOpen && (
        <div
          ref={menuRef}
          className="absolute right-0 top-full mt-1 w-48 bg-white border border-gray-200 rounded-lg shadow-lg z-50 py-1 animate-fade-in"
        >
          <button
            onClick={() => { setMenuOpen(false); setRenaming(true); }}
            className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex items-center gap-2.5"
          >
            <Edit2 className="w-3.5 h-3.5 text-gray-500" />
            Renombrar
          </button>
          <button
            onClick={() => { setMenuOpen(false); void onArchive(session.id, !session.archived); }}
            className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex items-center gap-2.5"
          >
            {session.archived ? (
              <>
                <ArchiveRestore className="w-3.5 h-3.5 text-gray-500" />
                Desarchivar
              </>
            ) : (
              <>
                <Archive className="w-3.5 h-3.5 text-gray-500" />
                Archivar
              </>
            )}
          </button>
          <div className="border-t border-gray-100 my-1" />
          <button
            onClick={handleDelete}
            className="w-full text-left px-3 py-2 text-sm hover:bg-red-50 text-red-600 flex items-center gap-2.5"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Eliminar
          </button>
        </div>
      )}
    </div>
  );
}
