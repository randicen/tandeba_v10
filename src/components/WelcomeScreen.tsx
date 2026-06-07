import React, { useState, useRef } from 'react';
import {
  Plus, Bot, Mic, Send, ChevronDown, ChevronRight, Sparkles, HelpCircle, Calendar,
  Image as ImageIcon, Folder, Camera, FileUp, Zap, Briefcase,
  Monitor, Newspaper, Settings, X, Terminal, Plug
} from 'lucide-react';
import { cn } from '../lib/utils';
import { PromptComposer, type AgentMode } from './PromptComposer';

interface WelcomeScreenProps {
  userName?: string;
  onSubmit: (message: string, mode: AgentMode) => void;
  onAttachFile: (file: File) => void;
  onOpenCustomize: () => void;
  onOpenMonitors: (tab: 'internal' | 'external') => void;
  onOpenScheduled: () => void;
  onOpenGuides: () => void;
}

export default function WelcomeScreen({
  userName = 'doctor Juan',
  onSubmit,
  onAttachFile,
  onOpenCustomize,
  onOpenMonitors,
  onOpenScheduled,
  onOpenGuides
}: WelcomeScreenProps) {
  const [activeMonitor, setActiveMonitor] = useState<'internal' | 'external' | null>(null);

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return 'Buenos días';
    if (h < 19) return 'Buenas tardes';
    return 'Buenas noches';
  })();

  return (
    <main className="flex-1 flex flex-col min-w-0 bg-white relative z-10 w-full">
      <div className="flex items-center justify-between px-6 sm:px-10 pt-6 pb-2">
        <div className="flex items-center gap-6">
          <button
            onClick={() => { setActiveMonitor('internal'); onOpenMonitors('internal'); }}
            className="flex items-center gap-2 text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors"
          >
            <Monitor className="w-4 h-4" />
            <span>Monitor interno</span>
            <span className="ml-1 w-2 h-2 rounded-full bg-blue-500" />
          </button>
          <button
            onClick={() => { setActiveMonitor('external'); onOpenMonitors('external'); }}
            className="flex items-center gap-2 text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors"
          >
            <Newspaper className="w-4 h-4" />
            <span>Monitor externo</span>
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onOpenGuides}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <HelpCircle className="w-4 h-4" />
            <span>Guías</span>
          </button>
          <button
            onClick={onOpenScheduled}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 rounded-lg transition-colors"
          >
            <Calendar className="w-4 h-4" />
            <span>Programadas</span>
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-6 sm:px-10 pb-12">
        <h1 className="text-3xl sm:text-4xl font-semibold text-gray-900 mb-8">
          {greeting}, {userName}
        </h1>

        <PromptComposer
          variant="standalone"
          onSubmit={onSubmit}
          onAttachFile={onAttachFile}
          onOpenCustomize={onOpenCustomize}
          placeholder="Escribe @ para ver conectores y fuentes"
        />
      </div>

      {activeMonitor && (
        <div className="absolute inset-0 bg-white z-20 overflow-y-auto animate-fade-in">
          <div className="flex items-center justify-between px-6 sm:px-10 py-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">
              {activeMonitor === 'internal' ? 'Monitor interno' : 'Monitor externo'}
            </h2>
            <button
              onClick={() => setActiveMonitor(null)}
              className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-500"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="p-6 sm:p-10 max-w-4xl mx-auto">
            {activeMonitor === 'internal' ? (
              <div className="text-center py-20 text-gray-400">
                <Monitor className="w-12 h-12 mx-auto mb-4 text-gray-300" />
                <p className="text-lg font-medium text-gray-700">Monitor interno</p>
                <p className="text-sm mt-2">Actividad de la firma, uso de IA por empleados, productividad del equipo.</p>
                <p className="text-xs mt-4 text-gray-400">Sin datos aún. Configura tu firma para empezar a medir.</p>
              </div>
            ) : (
              <div className="text-center py-20 text-gray-400">
                <Newspaper className="w-12 h-12 mx-auto mb-4 text-gray-300" />
                <p className="text-lg font-medium text-gray-700">Monitor externo</p>
                <p className="text-sm mt-2">Cambios normativos, tendencias del mercado, noticias del sector.</p>
                <p className="text-xs mt-4 text-gray-400">Sin datos aún. Configura las fuentes que te interesan.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
