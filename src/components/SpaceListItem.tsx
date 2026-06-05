import { Folder } from 'lucide-react';
import { formatRelativeTime } from './Breadcrumb';

interface SpaceListItemProps {
  id: string;
  name: string;
  updatedAt: number;
  onClick: () => void;
}

export function SpaceListItem({ name, updatedAt, onClick }: SpaceListItemProps) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 active:bg-gray-100 transition-colors text-left group border-b border-gray-100 last:border-b-0"
    >
      <Folder className="w-4 h-4 text-amber-500 shrink-0" />
      <span className="font-medium text-gray-900 truncate flex-1">{name}</span>
      <span className="text-xs text-gray-500 shrink-0">Act. {formatRelativeTime(updatedAt)}</span>
    </button>
  );
}
