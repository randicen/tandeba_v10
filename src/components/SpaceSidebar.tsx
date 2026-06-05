import { useEffect, useState } from 'react';
import { Paperclip, Clock, Loader2 } from 'lucide-react';

interface SpaceSidebarProps {
  spaceId: string;
  instructions: string;
  onInstructionsChange: (value: string) => void;
  filesCount?: number;
  scheduledTasksCount?: number;
}

export function SpaceSidebar({ spaceId, instructions, onInstructionsChange, filesCount = 0, scheduledTasksCount = 0 }: SpaceSidebarProps) {
  const [localInstructions, setLocalInstructions] = useState(instructions);
  const [savingInstructions, setSavingInstructions] = useState(false);

  useEffect(() => {
    setLocalInstructions(instructions);
  }, [instructions, spaceId]);

  const handleBlur = async () => {
    if (localInstructions === instructions) return;
    setSavingInstructions(true);
    try {
      await fetch(`/api/spaces/${spaceId}/instructions`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instructions: localInstructions }),
      });
      onInstructionsChange(localInstructions);
    } catch (e) {
      console.error('Error saving instructions:', e);
    } finally {
      setSavingInstructions(false);
    }
  };

  return (
    <aside className="w-full md:w-80 lg:w-96 shrink-0 border-l border-gray-200 bg-gray-50/50 p-5 overflow-y-auto hidden md:flex flex-col gap-6">
      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Instrucciones del Espacio</h3>
          {savingInstructions && <Loader2 className="w-3 h-3 animate-spin text-gray-400" />}
        </div>
        <textarea
          value={localInstructions}
          onChange={(e) => setLocalInstructions(e.target.value)}
          onBlur={handleBlur}
          placeholder="Edita aquí las instrucciones generales para este Espacio. El asistente las usará como contexto en todos los hilos."
          className="w-full min-h-[140px] p-3 text-sm border border-gray-200 rounded-lg bg-white resize-y focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
        />
      </section>

      <section>
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Archivos</h3>
        <div className="border border-dashed border-gray-300 rounded-lg p-4 bg-white text-center">
          <Paperclip className="w-5 h-5 text-gray-300 mx-auto mb-2" />
          <p className="text-sm text-gray-500 mb-1">Próximamente</p>
          <p className="text-xs text-gray-400">Sube y organiza archivos del espacio ({filesCount})</p>
        </div>
      </section>

      <section>
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Tareas programadas</h3>
        <div className="border border-dashed border-gray-300 rounded-lg p-4 bg-white text-center">
          <Clock className="w-5 h-5 text-gray-300 mx-auto mb-2" />
          <p className="text-sm text-gray-500 mb-1">Próximamente</p>
          <p className="text-xs text-gray-400">Programa recordatorios y tareas recurrentes ({scheduledTasksCount})</p>
        </div>
      </section>
    </aside>
  );
}
