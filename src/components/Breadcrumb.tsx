import { ChevronRight } from 'lucide-react';

export interface BreadcrumbItem {
  id: string | null;
  name: string;
}

interface BreadcrumbProps {
  items: BreadcrumbItem[];
  onNavigate: (id: string | null) => void;
}

export function Breadcrumb({ items, onNavigate }: BreadcrumbProps) {
  return (
    <nav className="flex items-center gap-1 text-sm text-gray-600 flex-wrap">
      {items.map((item, idx) => {
        const isLast = idx === items.length - 1;
        return (
          <span key={item.id ?? 'root'} className="flex items-center gap-1">
            {idx > 0 && <ChevronRight className="w-3.5 h-3.5 text-gray-400 shrink-0" />}
            {isLast ? (
              <span className="font-semibold text-gray-900 px-1">{item.name}</span>
            ) : (
              <button
                onClick={() => onNavigate(item.id)}
                className="hover:text-blue-600 hover:underline px-1 py-0.5 rounded transition-colors"
              >
                {item.name}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);

  if (months > 0) return `hace ${months} mes${months > 1 ? 'es' : ''}`;
  if (weeks > 0) return `hace ${weeks} sem`;
  if (days > 0) return `hace ${days}d`;
  if (hours > 0) return `hace ${hours}h`;
  if (minutes > 0) return `hace ${minutes} min`;
  if (seconds > 5) return `hace ${seconds}s`;
  return 'recién';
}
