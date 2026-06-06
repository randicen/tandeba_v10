import { useState, useRef, useEffect } from 'react';
import { MoreVertical, Edit2, Archive, ArchiveRestore, FolderInput, Trash2 } from 'lucide-react';

interface SpaceRowMenuProps {
  onRename: () => void;
  onArchive: () => void;
  onMove: () => void;
  onDelete: () => void;
  isArchived: boolean;
}

export function SpaceRowMenu({ onRename, onArchive, onMove, onDelete, isArchived }: SpaceRowMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        className="p-1 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors"
        title="Más opciones"
      >
        <MoreVertical className="w-4 h-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-44 bg-white border border-gray-200 rounded-lg shadow-lg z-20 py-1">
          <button
            onClick={(e) => { e.stopPropagation(); setOpen(false); onRename(); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 text-left"
          >
            <Edit2 className="w-3.5 h-3.5" /> Renombrar
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setOpen(false); onArchive(); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 text-left"
          >
            {isArchived ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
            {isArchived ? 'Desarchivar' : 'Archivar'}
          </button>
          {!isArchived && (
            <button
              onClick={(e) => { e.stopPropagation(); setOpen(false); onMove(); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 text-left"
            >
              <FolderInput className="w-3.5 h-3.5" /> Mover a...
            </button>
          )}
          <div className="border-t border-gray-100 my-1" />
          <button
            onClick={(e) => { e.stopPropagation(); setOpen(false); onDelete(); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 text-left"
          >
            <Trash2 className="w-3.5 h-3.5" /> Eliminar
          </button>
        </div>
      )}
    </div>
  );
}
