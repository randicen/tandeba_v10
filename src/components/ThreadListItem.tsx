import { MessageSquare } from 'lucide-react';
import { formatRelativeTime } from './Breadcrumb';

interface ThreadListItemProps {
  id: string;
  name: string;
  updatedAt: number;
  preview?: string;
  onClick: () => void;
}

export function ThreadListItem({ name, preview, updatedAt, onClick }: ThreadListItemProps) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-start gap-3 px-4 py-3 hover:bg-gray-50 active:bg-gray-100 transition-colors text-left border-b border-gray-100 last:border-b-0"
    >
      <MessageSquare className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="font-medium text-gray-900 truncate flex-1">{name}</span>
          <span className="text-xs text-gray-500 shrink-0">• {formatRelativeTime(updatedAt)}</span>
        </div>
        {preview && (
          <p className="text-sm text-gray-500 truncate mt-0.5">{preview}</p>
        )}
      </div>
    </button>
  );
}
