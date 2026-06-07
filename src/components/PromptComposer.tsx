import React, { useEffect, useRef, useState } from 'react';
import {
  Plus, Send, Mic, ChevronDown, ChevronRight, Sparkles, Image as ImageIcon,
  Folder, Camera, FileUp, Briefcase, Settings, Plug, Zap, Paperclip, X, AtSign,
  Library, Globe, BookOpen
} from 'lucide-react';
import { cn } from '../lib/utils';

export type AgentMode = 'fast' | 'pro';

export interface PromptComposerProps {
  /** Callback al enviar. `mode` se persiste y más adelante controla qué LLM se usa. */
  onSubmit: (message: string, mode: AgentMode) => void;
  /** Callback al adjuntar un archivo desde el input nativo. */
  onAttachFile?: (file: File) => void;
  /** Abre la página de Personalización (Habilidades/Conectores/Plugins). */
  onOpenCustomize?: () => void;
  /** Abre la Bóveda (placeholder por ahora, bóvedas no funcionales). */
  onOpenVault?: () => void;
  /** Variante visual: 'standalone' (welcome, input grande) o 'compact' (dentro del chat). */
  variant?: 'standalone' | 'compact';
  /** Deshabilita el input (modo running, esperando humano, etc). */
  disabled?: boolean;
  /** Placeholder del textarea. */
  placeholder?: string;
  /** Etiquetas a mostrar. */
  labels?: {
    send?: string;
    voice?: string;
    attach?: string;
    personalize?: string;
    mode?: string;
    fast?: string;
    pro?: string;
  };
}

const DEFAULT_LABELS = {
  send: 'Enviar',
  voice: 'Entrada de voz',
  attach: 'Adjuntar',
  personalize: 'Personalización',
  mode: 'Modo',
  fast: 'Fast',
  pro: 'Pro',
};

/** Catálogo placeholder de fuentes/conectores que aparecen al escribir `@`. */
const AT_SOURCES = [
  { id: 'vault-jurisprudencia', icon: Library, label: 'Jurisprudencia', detail: 'Bóveda de sentencias' },
  { id: 'vault-contratos', icon: FileUp, label: 'Contratos', detail: 'Bóveda de plantillas' },
  { id: 'web', icon: Globe, label: 'Web', detail: 'Búsqueda en vivo con DuckDuckGo' },
  { id: 'episodic', icon: BookOpen, label: 'Memoria de la firma', detail: 'Eventos pasados relevantes' },
];

/** Catálogo placeholder de plugins para el dropdown de Personalización. */
const PLUGINS = [
  { id: 'p1', name: 'Abogado Litigante', active: true },
  { id: 'p2', name: 'Contador Público', active: false },
  { id: 'p3', name: 'Consultor Empresarial', active: false },
];

/**
 * PromptComposer
 * -----------------------------------------------------------------------------
 * Caja de entrada rica, reutilizable. La usan tanto el `WelcomeScreen` (variant
 * "standalone") como el `ChatArea` (variant "compact") para que la experiencia
 * sea idéntica en cualquier punto de entrada al agente.
 *
 * Comportamiento:
 *  - Enter envía, Shift+Enter inserta salto de línea.
 *  - Escribir `@` abre un popover con fuentes/conectores disponibles.
 *  - Dropdown de adjuntar: fotos, bóveda, captura, proyectos.
 *  - Dropdown de Personalización: Habilidades, Conectores, Plugins.
 *  - Toggle Fast/Pro (selector de modo). Por ahora solo se persiste; cuando
 *    haya varios modelos disponibles, este flag decide cuál usar.
 *  - Micrófono usa Web Speech API (webkitSpeechRecognition) si está disponible.
 *  - Sin botón "Computer" (legacy): el navegador interactivo se invoca por tool
 *    del agente, no desde el composer.
 */
export function PromptComposer({
  onSubmit,
  onAttachFile,
  onOpenCustomize,
  onOpenVault,
  variant = 'compact',
  disabled = false,
  placeholder = 'Escribe @ para ver conectores y fuentes',
  labels: rawLabels,
}: PromptComposerProps) {
  const labels = { ...DEFAULT_LABELS, ...rawLabels };
  const [text, setText] = useState('');
  const [mode, setMode] = useState<AgentMode>('fast');
  const [showAttach, setShowAttach] = useState(false);
  const [showPersonalize, setShowPersonalize] = useState(false);
  const [showMode, setShowMode] = useState(false);
  const [showPlugins, setShowPlugins] = useState(false);
  const [showProyectos, setShowProyectos] = useState(false);
  const [showAtMenu, setShowAtMenu] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<any>(null);

  // Cerrar popovers al hacer click fuera
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setShowAttach(false);
        setShowPersonalize(false);
        setShowMode(false);
        setShowAtMenu(false);
        setShowPlugins(false);
        setShowProyectos(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  // Auto-resize del textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, variant === 'standalone' ? 160 : 192) + 'px';
  }, [text, variant]);

  // Mostrar/ocultar el menú de @ en función del texto
  useEffect(() => {
    const atActive = /@$/.test(text) || /@\S*$/.test(text);
    setShowAtMenu(atActive);
  }, [text]);

  const handleSend = () => {
    const value = text.trim();
    if (!value || disabled) return;
    onSubmit(value, mode);
    setText('');
    setShowAtMenu(false);
    // Re-focus para que el usuario pueda continuar escribiendo
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    } else if (e.key === 'Escape') {
      setShowAtMenu(false);
    }
  };

  const insertAtSource = (label: string) => {
    // Reemplaza el último @... por @Label
    const newText = text.replace(/@\S*$/, `@${label} `);
    setText(newText);
    setShowAtMenu(false);
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && onAttachFile) onAttachFile(file);
    e.target.value = '';
  };

  const toggleVoice = () => {
    setVoiceError(null);
    const Ctor: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Ctor) {
      setVoiceError('Tu navegador no soporta entrada de voz.');
      return;
    }
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const rec = new Ctor();
    rec.lang = 'es-CO';
    rec.interimResults = false;
    rec.continuous = false;
    rec.onresult = (ev: any) => {
      const transcript = ev.results?.[0]?.[0]?.transcript;
      if (transcript) setText((t) => (t ? t + ' ' : '') + transcript);
    };
    rec.onerror = (ev: any) => setVoiceError(`Error de voz: ${ev.error || 'desconocido'}`);
    rec.onend = () => setListening(false);
    rec.onstart = () => setListening(true);
    recognitionRef.current = rec;
    rec.start();
  };

  const isStandalone = variant === 'standalone';
  const shellClass = isStandalone
    ? 'bg-white border border-gray-200 rounded-2xl shadow-sm hover:border-gray-300 focus-within:border-blue-500 focus-within:shadow-md transition-all p-4 relative'
    : 'bg-white border border-gray-200 rounded-2xl shadow-sm hover:border-gray-300 focus-within:border-blue-500 focus-within:shadow-md transition-all p-2 sm:p-3 relative';
  const textareaClass = isStandalone
    ? 'w-full resize-none outline-none text-gray-900 placeholder:text-gray-400 text-[15px] min-h-[44px] max-h-40'
    : 'w-full bg-transparent text-gray-900 text-[14px] sm:text-[15px] min-h-[40px] max-h-40 outline-none resize-none placeholder:text-gray-400';

  return (
    <div ref={containerRef} className={cn('w-full', isStandalone ? 'max-w-2xl mx-auto' : 'max-w-3xl mx-auto')}>
      <div className={shellClass}>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={1}
          disabled={disabled}
          className={textareaClass}
        />

        {/* Menú @ (fuentes) */}
        {showAtMenu && !disabled && (
          <div className="absolute bottom-full left-0 mb-2 w-80 bg-white border border-gray-200 rounded-xl shadow-lg z-30 py-2 animate-fade-in">
            <div className="px-3 pt-1 pb-2 text-[11px] font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
              <AtSign className="w-3 h-3" /> Conectores y fuentes
            </div>
            {AT_SOURCES.map((s) => {
              const Icon = s.icon;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => insertAtSource(s.label)}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex items-center gap-3"
                >
                  <Icon className="w-4 h-4 text-gray-500" />
                  <div className="flex-1 min-w-0">
                    <div className="text-gray-900">{s.label}</div>
                    <div className="text-[11px] text-gray-500 truncate">{s.detail}</div>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        <div className="flex items-center justify-between gap-2 mt-2 relative">
          {/* Lado izquierdo: adjuntar + personalizar */}
          <div className="flex items-center gap-1 relative">
            <button
              type="button"
              onClick={() => { setShowAttach(!showAttach); setShowPersonalize(false); setShowMode(false); setShowAtMenu(false); }}
              className={cn(
                'rounded-xl text-gray-500 hover:text-gray-700 hover:bg-gray-100 flex items-center justify-center transition-colors',
                isStandalone ? 'w-9 h-9' : 'w-9 h-9'
              )}
              title={labels.attach}
              disabled={disabled}
            >
              {isStandalone ? <Plus className="w-5 h-5" /> : <Paperclip className="w-5 h-5" />}
            </button>

            {showAttach && (
              <div className="absolute top-full left-0 mt-2 w-72 bg-white border border-gray-200 rounded-xl shadow-lg z-30 py-2 animate-fade-in">
                <button
                  type="button"
                  onClick={() => { fileInputRef.current?.click(); setShowAttach(false); }}
                  className="w-full text-left px-4 py-2.5 text-sm hover:bg-gray-50 flex items-center gap-3"
                >
                  <ImageIcon className="w-4 h-4 text-gray-500" />
                  <span>Agregar fotos y archivos</span>
                </button>
                <button
                  type="button"
                  onClick={() => { setShowAttach(false); onOpenVault?.(); }}
                  className="w-full text-left px-4 py-2.5 text-sm hover:bg-gray-50 flex items-center gap-3"
                >
                  <Folder className="w-4 h-4 text-gray-500" />
                  <span>Agregar desde Bóveda</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowAttach(false);
                    if (navigator.mediaDevices?.getDisplayMedia) {
                      navigator.mediaDevices.getDisplayMedia({ video: true }).then((stream) => {
                        stream.getTracks().forEach((t) => t.stop());
                        alert('Captura iniciada: en cuanto el agente la reciba, te avisará.');
                      }).catch(() => {});
                    } else {
                      alert('Tu navegador no soporta captura de pantalla.');
                    }
                  }}
                  className="w-full text-left px-4 py-2.5 text-sm hover:bg-gray-50 flex items-center gap-3"
                >
                  <Camera className="w-4 h-4 text-gray-500" />
                  <span>Tomar captura de pantalla</span>
                </button>
                <div className="border-t border-gray-100 my-1" />
                <button
                  type="button"
                  onClick={() => setShowProyectos(!showProyectos)}
                  className="w-full text-left px-4 py-2.5 text-sm hover:bg-gray-50 flex items-center gap-3"
                >
                  <Briefcase className="w-4 h-4 text-gray-500" />
                  <span>Proyectos</span>
                  <ChevronRight className={cn('w-3.5 h-3.5 text-gray-400 ml-auto transition-transform', showProyectos && 'rotate-90')} />
                </button>
                {showProyectos && (
                  <div className="bg-gray-50/50 px-2 py-1">
                    <button
                      type="button"
                      onClick={() => { setShowAttach(false); setShowProyectos(false); onOpenVault?.(); }}
                      className="w-full text-left pl-10 pr-4 py-2 text-sm hover:bg-white rounded-lg flex items-center gap-3"
                    >
                      <FileUp className="w-4 h-4 text-gray-500" />
                      <span>Agregar a proyecto</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => { setShowAttach(false); setShowProyectos(false); }}
                      className="w-full text-left pl-10 pr-4 py-2 text-sm hover:bg-white rounded-lg flex items-center gap-3"
                    >
                      <Folder className="w-4 h-4 text-gray-500" />
                      <span>Contextualizar en proyecto</span>
                    </button>
                  </div>
                )}
                <div className="border-t border-gray-100 my-1" />
                <button
                  type="button"
                  onClick={() => { setShowAttach(false); onOpenCustomize?.(); }}
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
              onChange={handleFilePick}
            />

            <button
              type="button"
              onClick={() => { setShowPersonalize(!showPersonalize); setShowAttach(false); setShowMode(false); setShowAtMenu(false); }}
              className={cn(
                'rounded-xl text-gray-500 hover:text-gray-700 hover:bg-gray-100 flex items-center gap-1.5 text-sm transition-colors',
                isStandalone ? 'px-3 h-9' : 'px-2.5 h-9 text-[13px]'
              )}
              disabled={disabled}
            >
              <Sparkles className="w-4 h-4" />
              <span>{labels.personalize}</span>
              <ChevronDown className="w-3.5 h-3.5" />
            </button>

            {showPersonalize && (
              <div className={cn(
                'absolute top-full mt-2 w-64 bg-white border border-gray-200 rounded-xl shadow-lg z-30 py-2 animate-fade-in',
                isStandalone ? 'left-32' : 'left-12'
              )}>
                <button
                  type="button"
                  onClick={() => { setShowPersonalize(false); onOpenCustomize?.(); }}
                  className="w-full text-left px-4 py-2.5 text-sm hover:bg-gray-50 flex items-center gap-3"
                >
                  <Briefcase className="w-4 h-4 text-gray-500" />
                  <span>Habilidades</span>
                  <ChevronDown className="w-3.5 h-3.5 text-gray-400 ml-auto" />
                </button>
                <button
                  type="button"
                  onClick={() => { setShowPersonalize(false); onOpenCustomize?.(); }}
                  className="w-full text-left px-4 py-2.5 text-sm hover:bg-gray-50 flex items-center gap-3"
                >
                  <Folder className="w-4 h-4 text-gray-500" />
                  <span>Conectores</span>
                  <ChevronDown className="w-3.5 h-3.5 text-gray-400 ml-auto" />
                </button>
                <button
                  type="button"
                  onClick={() => setShowPlugins(!showPlugins)}
                  className="w-full text-left px-4 py-2.5 text-sm hover:bg-gray-50 flex items-center gap-3"
                >
                  <Plug className="w-4 h-4 text-gray-500" />
                  <span>Plugins</span>
                  <ChevronRight className={cn('w-3.5 h-3.5 text-gray-400 ml-auto transition-transform', showPlugins && 'rotate-90')} />
                </button>
                {showPlugins && (
                  <div className="bg-gray-50/50 px-2 py-1">
                    {PLUGINS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => { setShowPlugins(false); setShowPersonalize(false); onOpenCustomize?.(); }}
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
                      type="button"
                      onClick={() => { setShowPlugins(false); setShowPersonalize(false); onOpenCustomize?.(); }}
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

          {/* Lado derecho: modo + mic + enviar */}
          <div className="flex items-center gap-1">
            <div className="relative">
              <button
                type="button"
                onClick={() => { setShowMode(!showMode); setShowAttach(false); setShowPersonalize(false); setShowAtMenu(false); }}
                className="px-3 h-9 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-100 flex items-center gap-1.5 transition-colors"
                disabled={disabled}
              >
                <Zap className="w-4 h-4" />
                <span>{mode === 'fast' ? labels.fast : labels.pro}</span>
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
              {showMode && (
                <div className="absolute bottom-full right-0 mb-2 w-64 bg-white border border-gray-200 rounded-xl shadow-lg z-30 py-2 animate-fade-in">
                  <button
                    type="button"
                    onClick={() => { setMode('fast'); setShowMode(false); }}
                    className={cn('w-full text-left px-4 py-2.5 hover:bg-gray-50', mode === 'fast' && 'bg-blue-50/40')}
                  >
                    <div className="text-sm font-semibold text-gray-900">{labels.fast}</div>
                    <div className="text-xs text-gray-500">Responde rápidamente a bajo costo.</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setMode('pro'); setShowMode(false); }}
                    className={cn('w-full text-left px-4 py-2.5 hover:bg-gray-50', mode === 'pro' && 'bg-blue-50/40')}
                  >
                    <div className="text-sm font-semibold text-gray-900">{labels.pro}</div>
                    <div className="text-xs text-gray-500">Resuelve problemas complejos con mayor profundidad.</div>
                  </button>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={toggleVoice}
              className={cn(
                'w-9 h-9 rounded-xl flex items-center justify-center transition-colors',
                listening
                  ? 'bg-red-100 text-red-600 hover:bg-red-200'
                  : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
              )}
              title={listening ? 'Detener grabación' : labels.voice}
              disabled={disabled}
            >
              {listening ? <X className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </button>

            <button
              type="button"
              onClick={handleSend}
              disabled={!text.trim() || disabled}
              className={cn(
                'rounded-full flex items-center justify-center transition-colors',
                isStandalone
                  ? 'w-10 h-10 bg-gray-900 hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed text-white'
                  : 'w-10 h-10 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:bg-gray-300 text-white shadow-sm'
              )}
              title={labels.send}
            >
              <Send className="w-4 h-4 ml-0.5" />
            </button>
          </div>
        </div>
      </div>

      {voiceError && (
        <p className="text-xs text-red-600 mt-2 text-center">{voiceError}</p>
      )}
      {listening && (
        <p className="text-xs text-red-600 mt-2 text-center animate-pulse">
          🎙️ Escuchando... pulsa el micrófono para detener.
        </p>
      )}
    </div>
  );
}
