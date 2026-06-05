import { useState, useEffect, useRef } from 'react';
import { X, Loader2 } from 'lucide-react';

interface CreateSpaceModalProps {
  isOpen: boolean;
  parentId: string | null;
  parentName?: string;
  onClose: () => void;
  onCreated: (spaceId: string) => void;
}

export function CreateSpaceModal({ isOpen, parentId, parentName, onClose, onCreated }: CreateSpaceModalProps) {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setName('');
      setError(null);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('El nombre no puede estar vacío');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const res = await fetch('/api/spaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, parentId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const space = await res.json();
      onCreated(space.id);
      onClose();
    } catch (e: any) {
      setError(e.message || 'Error al crear');
    } finally {
      setCreating(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleCreate();
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  if (!isOpen) return null;

  const title = parentId ? 'Nuevo subespacio' : 'Nuevo espacio';
  const subtitle = parentId && parentName
    ? `Se creará dentro de "${parentName}"`
    : 'Se creará en la raíz de tus espacios';

  return (
    <div className="fixed inset-0 bg-gray-900/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-100">
          <div>
            <h2 className="text-base font-semibold text-gray-900">{title}</h2>
            <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>
          </div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 rounded">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4">
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Nombre</label>
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ej. Clientes, Litigios, Caso XYZ..."
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
            maxLength={100}
          />
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
            onClick={handleCreate}
            disabled={creating}
            className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1.5"
          >
            {creating && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Crear
          </button>
        </div>
      </div>
    </div>
  );
}
