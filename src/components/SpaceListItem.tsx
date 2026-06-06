import { Folder } from 'lucide-react';
import { formatRelativeTime } from './Breadcrumb';
import { SpaceRowMenu } from './SpaceRowMenu';

interface SpaceListItemProps {
  id: string;
  name: string;
  updatedAt: number;
  archived?: boolean;
  onClick: () => void;
  onRename?: () => void;
  onArchive?: () => void;
  onMove?: () => void;
  onDelete?: () => void;
}

export function SpaceListItem({ name, updatedAt, archived, onClick, onRename, onArchive, onMove, onDelete }: SpaceListItemProps) {
  const hasMenu = !!(onRename || onArchive || onMove || onDelete);
  return (
    <div className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors group border-b border-gray-100 last:border-b-0">
      <button
        onClick={onClick}
        className="flex items-center gap-3 flex-1 min-w-0 text-left"
      >
        <Folder className={`w-4 h-4 shrink-0 ${archived ? 'text-gray-400' : 'text-amber-500'}`} />
        <span className={`font-medium truncate flex-1 ${archived ? 'text-gray-500' : 'text-gray-900'}`}>{name}</span>
        <span className="text-xs text-gray-500 shrink-0">Act. {formatRelativeTime(updatedAt)}</span>
        {archived && <span className="text-[10px] uppercase font-semibold text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">Archivado</span>}
      </button>
      {hasMenu && (
        <SpaceRowMenu
          isArchived={!!archived}
          onRename={onRename || (() => {})}
          onArchive={onArchive || (() => {})}
          onMove={onMove || (() => {})}
          onDelete={onDelete || (() => {})}
        />
      )}
    </div>
  );
}
