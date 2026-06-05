import React, { useState, useRef } from 'react';
import { 
  Plus, Bot, Mic, Send, ChevronDown, ChevronRight, Sparkles, HelpCircle, Calendar, 
  Image as ImageIcon, Folder, Camera, FileUp, Zap, Briefcase,
  Monitor, Newspaper, Settings, X, Terminal, Plug
} from 'lucide-react';
import { cn } from '../lib/utils';

interface WelcomeScreenProps {
  userName?: string;
  onSubmit: (message: string, mode: 'fast' | 'pro') => void;
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
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<'fast' | 'pro'>('fast');
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [showPersonalizeMenu, setShowPersonalizeMenu] = useState(false);
  const [showModeMenu, setShowModeMenu] = useState(false);
  const [showPluginsSubmenu, setShowPluginsSubmenu] = useState(false);
  const [showProyectosSubmenu, setShowProyectosSubmenu] = useState(false);
  const [computerEnabled, setComputerEnabled] = useState(false);
  const [activeMonitor, setActiveMonitor] = useState<'internal' | 'external' | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return 'Buenos días';
    if (h < 19) return 'Buenas tardes';
    return 'Buenas noches';
  })();

  const handleSend = () => {
    if (!input.trim()) return;
    onSubmit(input, mode);
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const mockPlugins = [
    { id: 'p1', name: 'Abogado Litigante', active: true },
    { id: 'p2', name: 'Contador Público', active: false },
    { id: 'p3', name: 'Consultor Empresarial', active: false },
  ];

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

        <div className="w-full max-w-2xl">
          <div className="bg-white border border-gray-200 rounded-2xl shadow-sm hover:border-gray-300 focus-within:border-blue-500 focus-within:shadow-md transition-all p-4 relative">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Escribe @ para ver conectores y fuentes"
              className="w-full resize-none outline-none text-gray-900 placeholder:text-gray-400 text-[15px] min-h-[44px] max-h-32"
              rows={1}
            />
            <div className="flex items-center justify-between gap-2 mt-2">
              <div className="flex items-center gap-1 relative">
                {/* + Attach button */}
                <button
                  onClick={() => { setShowAttachMenu(!showAttachMenu); setShowPersonalizeMenu(false); setShowModeMenu(false); }}
                  className="w-9 h-9 rounded-xl text-gray-500 hover:text-gray-700 hover:bg-gray-100 flex items-center justify-center transition-colors"
                  title="Adjuntar"
                >
                  <Plus className="w-5 h-5" />
                </button>
                {showAttachMenu && (
                  <div className="absolute top-full left-0 mt-2 w-72 bg-white border border-gray-200 rounded-xl shadow-lg z-30 py-2 animate-fade-in">
                    <button
                      onClick={() => { fileInputRef.current?.click(); setShowAttachMenu(false); }}
                      className="w-full text-left px-4 py-2.5 text-sm hover:bg-gray-50 flex items-center gap-3"
                    >
                      <ImageIcon className="w-4 h-4 text-gray-500" />
                      <span>Agregar fotos y archivos</span>
                    </button>
                    <button
                      onClick={() => { setShowAttachMenu(false); }}
                      className="w-full text-left px-4 py-2.5 text-sm hover:bg-gray-50 flex items-center gap-3"
                    >
                      <Folder className="w-4 h-4 text-gray-500" />
                      <span>Agregar desde Bóveda</span>
                      <ChevronDown className="w-3.5 h-3.5 text-gray-400 ml-auto" />
                    </button>
                    <button
                      onClick={() => { setShowAttachMenu(false); }}
                      className="w-full text-left px-4 py-2.5 text-sm hover:bg-gray-50 flex items-center gap-3"
                    >
                      <Camera className="w-4 h-4 text-gray-500" />
                      <span>Tomar captura de pantalla</span>
                    </button>
                    <div className="border-t border-gray-100 my-1" />
                    {/* Proyectos submenu */}
                    <button
                      onClick={() => { setShowProyectosSubmenu(!showProyectosSubmenu); }}
                      className="w-full text-left px-4 py-2.5 text-sm hover:bg-gray-50 flex items-center gap-3"
                    >
                      <Briefcase className="w-4 h-4 text-gray-500" />
                      <span>Proyectos</span>
                      <ChevronRight className={cn("w-3.5 h-3.5 text-gray-400 ml-auto transition-transform", showProyectosSubmenu && "rotate-90")} />
                    </button>
                    {showProyectosSubmenu && (
                      <div className="bg-gray-50/50 px-2 py-1 animate-fade-in">
                        <button
                          onClick={() => { setShowAttachMenu(false); setShowProyectosSubmenu(false); }}
                          className="w-full text-left pl-10 pr-4 py-2 text-sm hover:bg-white rounded-lg flex items-center gap-3"
                        >
                          <FileUp className="w-4 h-4 text-gray-500" />
                          <span>Agregar a proyecto</span>
                        </button>
                        <button
                          onClick={() => { setShowAttachMenu(false); setShowProyectosSubmenu(false); }}
                          className="w-full text-left pl-10 pr-4 py-2 text-sm hover:bg-white rounded-lg flex items-center gap-3"
                        >
                          <Folder className="w-4 h-4 text-gray-500" />
                          <span>Contextualizar en proyecto</span>
                        </button>
                      </div>
                    )}
                    <div className="border-t border-gray-100 my-1" />
                    <button
                      onClick={() => { setShowAttachMenu(false); onOpenCustomize(); }}
                      className="w-full text-left px-4 py-2.5 text-sm hover:bg-gray-50 flex items-center gap-3"
                    >
                      <Settings className="w-4 h-4 text-gray-500" />
                      <span>Personalización</span>
                      <ChevronDown className="w-3.5 h-3.5 text-gray-400 ml-auto" />
                    </button>
                  </div>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  multiple
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) onAttachFile(file);
                    e.target.value = '';
                  }}
                />

                {/* Personalización button */}
                <button
                  onClick={() => { setShowPersonalizeMenu(!showPersonalizeMenu); setShowAttachMenu(false); setShowModeMenu(false); }}
                  className="px-3 h-9 rounded-xl text-gray-500 hover:text-gray-700 hover:bg-gray-100 flex items-center gap-1.5 text-sm transition-colors"
                >
                  <Sparkles className="w-4 h-4" />
                  <span>Personalización</span>
                  <ChevronDown className="w-3.5 h-3.5" />
                </button>
                {showPersonalizeMenu && (
                  <div className="absolute top-full left-32 mt-2 w-64 bg-white border border-gray-200 rounded-xl shadow-lg z-30 py-2 animate-fade-in">
                    <button
                      onClick={() => { setShowPersonalizeMenu(false); onOpenCustomize(); }}
                      className="w-full text-left px-4 py-2.5 text-sm hover:bg-gray-50 flex items-center gap-3"
                    >
                      <Briefcase className="w-4 h-4 text-gray-500" />
                      <span>Habilidades</span>
                      <ChevronDown className="w-3.5 h-3.5 text-gray-400 ml-auto" />
                    </button>
                    <button
                      onClick={() => { setShowPersonalizeMenu(false); onOpenCustomize(); }}
                      className="w-full text-left px-4 py-2.5 text-sm hover:bg-gray-50 flex items-center gap-3"
                    >
                      <Folder className="w-4 h-4 text-gray-500" />
                      <span>Conectores</span>
                      <ChevronDown className="w-3.5 h-3.5 text-gray-400 ml-auto" />
                    </button>
                    {/* Plugins with submenu */}
                    <button
                      onClick={() => { setShowPluginsSubmenu(!showPluginsSubmenu); }}
                      className="w-full text-left px-4 py-2.5 text-sm hover:bg-gray-50 flex items-center gap-3"
                    >
                      <Plug className="w-4 h-4 text-gray-500" />
                      <span>Plugins</span>
                      <ChevronRight className={cn("w-3.5 h-3.5 text-gray-400 ml-auto transition-transform", showPluginsSubmenu && "rotate-90")} />
                    </button>
                    {showPluginsSubmenu && (
                      <div className="bg-gray-50/50 px-2 py-1 animate-fade-in">
                        {mockPlugins.map((p) => (
                          <button
                            key={p.id}
                            onClick={() => { setShowPluginsSubmenu(false); setShowPersonalizeMenu(false); onOpenCustomize(); }}
                            className="w-full text-left pl-10 pr-4 py-2 text-sm hover:bg-white rounded-lg flex items-center justify-between"
                          >
                            <span className="text-gray-700">{p.name}</span>
                            {p.active && (
                              <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full font-medium">Activo</span>
                            )}
                          </button>
                        ))}
                        <div className="border-t border-gray-200 my-1" />
                        <button
                          onClick={() => { setShowPluginsSubmenu(false); setShowPersonalizeMenu(false); onOpenCustomize(); }}
                          className="w-full text-left pl-10 pr-4 py-2 text-sm hover:bg-white rounded-lg flex items-center gap-2 text-gray-500"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          <span>Agregar plugins</span>
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-1">
                {/* Computer toggle */}
                <button
                  onClick={() => setComputerEnabled(!computerEnabled)}
                  className={cn(
                    "px-3 h-9 rounded-xl text-sm font-medium flex items-center gap-1.5 transition-colors",
                    computerEnabled 
                      ? "bg-gray-900 text-white hover:bg-gray-800" 
                      : "text-gray-500 hover:text-gray-700 hover:bg-gray-100"
                  )}
                  title="Modo Computador"
                >
                  <Terminal className="w-4 h-4" />
                  <span className="hidden sm:inline">Computer</span>
                </button>

                {/* Fast/Pro selector */}
                <div className="relative">
                  <button
                    onClick={() => { setShowModeMenu(!showModeMenu); setShowAttachMenu(false); setShowPersonalizeMenu(false); }}
                    className="px-3 h-9 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-100 flex items-center gap-1.5 transition-colors"
                  >
                    <Zap className="w-4 h-4" />
                    <span>{mode === 'fast' ? 'Fast' : 'Pro'}</span>
                    <ChevronDown className="w-3.5 h-3.5" />
                  </button>
                  {showModeMenu && (
                    <div className="absolute bottom-full right-0 mb-2 w-64 bg-white border border-gray-200 rounded-xl shadow-lg z-30 py-2 animate-fade-in">
                      <button
                        onClick={() => { setMode('fast'); setShowModeMenu(false); }}
                        className={cn("w-full text-left px-4 py-2.5 hover:bg-gray-50", mode === 'fast' && 'bg-blue-50/40')}
                      >
                        <div className="text-sm font-semibold text-gray-900">Fast</div>
                        <div className="text-xs text-gray-500">Responde rápidamente a bajo costo.</div>
                      </button>
                      <button
                        onClick={() => { setMode('pro'); setShowModeMenu(false); }}
                        className={cn("w-full text-left px-4 py-2.5 hover:bg-gray-50", mode === 'pro' && 'bg-blue-50/40')}
                      >
                        <div className="text-sm font-semibold text-gray-900">Pro</div>
                        <div className="text-xs text-gray-500">Resuelve problemas complejos con mayor profundidad.</div>
                      </button>
                    </div>
                  )}
                </div>
                <button
                  className="w-9 h-9 rounded-xl text-gray-500 hover:text-gray-700 hover:bg-gray-100 flex items-center justify-center transition-colors"
                  title="Entrada de voz"
                >
                  <Mic className="w-4 h-4" />
                </button>
                <button
                  onClick={handleSend}
                  disabled={!input.trim()}
                  className="w-10 h-10 rounded-full bg-gray-900 hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed text-white flex items-center justify-center transition-colors"
                  title="Enviar"
                >
                  <Send className="w-4 h-4 ml-0.5" />
                </button>
              </div>
            </div>
          </div>
        </div>
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
