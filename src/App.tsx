import React, { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { 
  Plus, Settings, Send, Bot, Activity, Loader2, FileText, Download, User,
  Search, Globe, UploadCloud, DownloadCloud, Terminal, FolderSearch, Eye, Code, Folder,
  Maximize, Minimize, Minus, X, ChevronLeft, ChevronRight, FileSpreadsheet, Trash2, Edit2, Undo, Redo, Paperclip,
  Bold, Italic, Underline, Strikethrough, Highlighter, Palette, MessageSquarePlus, AlignLeft, AlignCenter, AlignRight,
  Indent, Outdent, Scissors, MoreHorizontal, ThumbsUp, Check, MessageSquare, CornerUpLeft, Link, List, ListOrdered, Heading1, Heading2, Heading3, PanelRightClose, Wrench
} from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';

import { cn } from './lib/utils';
import axios from 'axios';
import JoditEditor from 'jodit-react';
import { Workbook as FortuneSheetWorkbook } from "@fortune-sheet/react";
import "@fortune-sheet/react/dist/index.css";
import LuckyExcel from "luckyexcel";
import WelcomeScreen from './components/WelcomeScreen';
import CustomizePage from './components/CustomizePage';
import VaultsView from './components/VaultsView';
import { SpacesMainView } from './components/SpacesMainView';

// API Client
const api = axios.create({ baseURL: '/api' });

const getToolDisplay = (name?: string, argsStr?: string) => {
  if (!name) return { icon: Terminal, title: 'Terminado', detail: '' };

  let args: Record<string, string> = {};
  try { args = JSON.parse(argsStr || '{}'); } catch(e){}

  const a = (key: string) => String(args[key] || '');
  const fmtUrl = (u: string) => { try { return new URL(u).hostname; } catch { return u; } };

  const dispatch: Record<string, () => { icon: any; title: string; detail: string }> = {
    search_web:             () => ({ icon: Search, title: 'Explorador', detail: a('query') ? `Buscando: ${a('query')}` : 'Búsqueda completada' }),
    search_episodic_memory: () => ({ icon: Activity, title: 'Memoria', detail: 'Buscando recuerdos relevantes' }),
    apify_scrape_url:       () => ({ icon: Globe, title: 'Investigador Web', detail: 'Escaneando sitio web' }),
    read_url:               () => ({ icon: Globe, title: 'Investigador Web', detail: 'Analizando contenido' }),
    sandbox_upload:         () => ({ icon: UploadCloud, title: 'Gestor de Archivos', detail: 'Subiendo al entorno' }),
    sandbox_download:       () => ({ icon: DownloadCloud, title: 'Gestor de Archivos', detail: 'Descargando del sandbox' }),
    download_file:          () => ({ icon: DownloadCloud, title: 'Gestor de Archivos', detail: a('filename') ? `Descargando: ${a('filename')}` : 'Descargando' }),
    execute_code:           () => ({ icon: Terminal, title: 'Terminal', detail: 'Procesando operación...' }),
    list_files:             () => ({ icon: FolderSearch, title: 'Reconocimiento', detail: 'Explorando estructura' }),
    read_file:              () => ({ icon: FileText, title: 'Lectura de archivos', detail: 'Leyendo documento' }),
    set_core_memory:        () => ({ icon: Activity, title: 'Memoria Central', detail: 'Aprendiendo nuevo concepto' }),
    delete_core_memory:     () => ({ icon: Activity, title: 'Memoria Central', detail: 'Olvidando dato irrelevante' }),
    save_episodic_memory:   () => ({ icon: Activity, title: 'Memoria Episódica', detail: 'Guardando experiencia' }),
    write_file:             () => ({ icon: FileText, title: 'Creador de Archivos', detail: `Escribiendo: ${a('filename') || a('path') || 'documento'}` }),
    create_docx:            () => ({ icon: FileText, title: 'Creador de Archivos', detail: `Creando: ${a('filename') || 'documento'}` }),
    edit_docx_content:      () => ({ icon: FileText, title: 'Editor DOCX', detail: 'Editando documento vía XML' }),
    read_docx_structure:    () => ({ icon: Eye, title: 'Inspector DOCX', detail: 'Leyendo estructura XML' }),
    find_replace_text:      () => ({ icon: FileText, title: 'Editor DOCX', detail: 'Reemplazando texto' }),
    update_docx_formatting: () => ({ icon: FileText, title: 'Editor DOCX', detail: 'Ajustando formato del documento' }),
    ai_document_editor:     () => ({ icon: FileText, title: 'Editor IA', detail: 'Reescribiendo documento con IA' }),
    rename_file:            () => ({ icon: FileText, title: 'Organizador', detail: 'Renombrando archivo' }),
    delete_file:            () => ({ icon: Trash2, title: 'Limpieza', detail: `Eliminando: ${a('path') || 'archivo'}` }),
    ask_human:              () => ({ icon: User, title: 'Pausa Consultiva', detail: 'Esperando tu confirmación' }),
    browser_action:         () => {
      if (args.action === 'goto') return { icon: Globe, title: 'Navegador AI', detail: `Navegando hacia ${fmtUrl(args.url)}` };
      if (args.action === 'scroll') return { icon: Eye, title: 'Navegador AI', detail: 'Inspeccionando página web' };
      if (args.action === 'click') return { icon: Eye, title: 'Navegador AI', detail: 'Completando interacción' };
      return { icon: Globe, title: 'Navegador AI', detail: 'Interactuando con la vista' };
    },
  };

  if (dispatch[name]) return dispatch[name]();
  return { icon: Activity, title: 'Herramienta interna', detail: 'Completando tarea especializada' };
};

function SpacesView({ spaces, sessions, activeSpaceId, onSelectSpace, onCreateSpace, onCreateSession, onSelectSession, onBackToSpaces }: any) {
  // Wrapper que delega a SpacesMainView (vista raíz + detalle con jerarquía)
  return (
    <SpacesMainView
      activeSpaceId={activeSpaceId}
      onSelectSpace={onSelectSpace}
      onSelectThread={(sessionId: string) => onSelectSession(sessionId)}
    />
  );
}

export default function App() {
  const [sessions, setSessions] = useState<any[]>([]);
  const [spaces, setSpaces] = useState<any[]>([]);
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeSessionDetail, setActiveSessionDetail] = useState<any | null>(null);
  const [isWorkspaceSidebarOpen, setIsWorkspaceSidebarOpen] = useState(false);
  const [criticalError, setCriticalError] = useState<string | null>(null);
  const [isLeftSidebarOpen, setIsLeftSidebarOpen] = useState(true);
  const [navMode, setNavMode] = useState<'chats' | 'spaces'>('chats');
  const [showNewMenu, setShowNewMenu] = useState(false);
  const [activeView, setActiveView] = useState<'home' | 'computer' | 'vaults' | 'tools' | 'customize'>('home');

  useEffect(() => {
    loadSpaces();
    loadSessions(); // all sessions for historial
  }, []);

  useEffect(() => {
    if (activeSpaceId) {
      loadSessions(activeSpaceId);
    }
  }, [activeSpaceId]);

  useEffect(() => {
    if (activeSessionId) {
      loadActiveSession(activeSessionId);
    } else {
      setActiveSessionDetail(null);
    }
  }, [activeSessionId]);

  const loadSpaces = async () => {
    try {
      const res = await api.get('/spaces');
      if (Array.isArray(res.data)) setSpaces(res.data);
    } catch { /* ignore */ }
  };

  const loadSessions = async (spaceId?: string) => {
    try {
      const url = spaceId ? `/api/sessions?spaceId=${spaceId}` : '/api/sessions';
      const res = await api.get(url);
      if (Array.isArray(res.data)) {
        setSessions(res.data);
        if (!activeSessionId && res.data.length > 0) {
          setActiveSessionId(res.data[0].id);
        }
      }
      setCriticalError(null);
    } catch (e: any) {
      console.error("Failed to load sessions");
      setCriticalError(e.response?.data?.error || e.message || "Error al cargar las sesiones. Revisa la consola o configuración de Base de Datos.");
    }
  };

  const loadActiveSession = async (id: string) => {
    try {
      const res = await api.get(`/sessions/${id}`);
      setActiveSessionDetail(res.data);
      setCriticalError(null);
    } catch (e: any) {
      console.error("Failed to load session details", e);
      setCriticalError(e.response?.data?.error || e.message || "Error al cargar la sesión activa.");
    }
  };

  const isSyncingRef = useRef(false);

  const handleUpdate = async () => {
    if (activeSessionId) {
      if (activeSessionDetail && activeSessionDetail.id === activeSessionId) {
        if (isSyncingRef.current) return;
        isSyncingRef.current = true;
        try {
          const msgCount = activeSessionDetail.messages?.length || 0;
          const res = await api.get(`/sessions/${activeSessionId}/sync?msgCount=${msgCount}`);
          if (res.data) {
             const { status, messages, updatedAt } = res.data;
             let shouldReload = false;
             setActiveSessionDetail((prev: any) => {
                if (!prev) return prev;
                if (messages === null) {
                   shouldReload = true;
                   return prev;
                }
                const newArr = messages === undefined ? prev.messages : [...prev.messages, ...messages];
                return { ...prev, status, messages: newArr, updatedAt };
             });
             setSessions((prev: any) => prev.map((s: any) => s.id === activeSessionId ? { ...s, status, updatedAt } : s));
             if (shouldReload) await loadActiveSession(activeSessionId);
          }
        } catch(e) {
          await loadActiveSession(activeSessionId);
        } finally {
          isSyncingRef.current = false;
        }
      } else {
        await loadActiveSession(activeSessionId);
      }
    } else {
      await loadSessions();
    }
  };

  const createSession = async (spaceId?: string | null) => {
    try {
      const sid = spaceId === undefined ? activeSpaceId : spaceId;
      const res = await api.post('/sessions', { name: `Nuevo Chat`, spaceId: sid || null });
      setActiveSessionId(res.data.id);
      await loadSessions(sid || undefined);
      setCriticalError(null);
    } catch (e: any) {
      console.error("Failed to create session");
      setCriticalError(e.response?.data?.error || e.message || "Error al crear la sesión.");
    }
  };

  const createSpace = async () => {
    try {
      const res = await api.post('/spaces', { name: 'Nuevo Espacio' });
      const newId = res.data.id;
      setSpaces(prev => [...prev, res.data]);
      setActiveSpaceId(newId);
      setNavMode('spaces');
      setSessions([]);
      setActiveSessionId(null);
      setActiveSessionDetail(null);
    } catch (e: any) {
      setCriticalError(e.response?.data?.error || e.message || "Error al crear espacio.");
    }
  };

  const activeSession = sessions.find(s => s.id === activeSessionId);

  return (
    <div className="flex flex-col h-screen bg-white text-gray-900 font-sans selection:bg-blue-200 overflow-hidden">
      {criticalError && (
        <div className="bg-red-500 text-white p-3 text-center text-sm font-medium z-50">
          Error Crítico de DB: {criticalError}
        </div>
      )}
      <div className="flex flex-1 overflow-hidden relative">
        {/* Mobile backdrop for left sidebar */}
        {isLeftSidebarOpen && (
          <div className="fixed inset-0 bg-gray-900/50 z-30 md:hidden" onClick={() => setIsLeftSidebarOpen(false)} />
        )}
        {/* Global Sidebar */}
        <aside className={cn(
          "border-r border-gray-200 flex flex-col shrink-0 bg-gray-50 transition-all duration-300 absolute md:relative z-40 h-full", 
          isLeftSidebarOpen ? "w-[85vw] sm:w-[260px] translate-x-0 shadow-xl md:shadow-none" : "w-0 -translate-x-full md:translate-x-0 border-r-0 overflow-hidden opacity-0 shadow-none"
        )}>
        <div className="p-4">
          <div className="flex items-center justify-between mb-4 relative">
            <h1 className="text-base font-bold tracking-tight text-gray-800">Worgena</h1>
          </div>

          <div className="relative mb-5">
            <button onClick={() => setShowNewMenu(!showNewMenu)} className="w-full py-2.5 px-3 text-sm font-semibold bg-gray-900 text-white rounded-lg hover:bg-gray-800 transition-colors flex items-center gap-2 justify-center">
              <Plus className="w-4 h-4" /> Nuevo
            </button>
            {showNewMenu && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-xl shadow-lg z-50 py-1">
                <button onClick={() => { createSession(null); setShowNewMenu(false); }} className="w-full text-left px-4 py-2.5 text-sm hover:bg-gray-50 flex items-center gap-3">
                  <MessageSquarePlus className="w-4 h-4 text-gray-400" /> Nuevo chat
                </button>
                <button onClick={() => { createSpace(); setShowNewMenu(false); }} className="w-full text-left px-4 py-2.5 text-sm hover:bg-gray-50 flex items-center gap-3">
                  <Folder className="w-4 h-4 text-amber-500" /> Nuevo espacio
                </button>
              </div>
            )}
          </div>
          
          <nav className="space-y-1 mb-6">
            <button onClick={() => { setNavMode('chats'); setActiveSessionId(null); setActiveSessionDetail(null); setActiveSpaceId(null); setActiveView('home'); }} className={cn(
              "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors",
              navMode === 'chats' && activeView === 'home' ? "bg-white border border-gray-200 shadow-sm text-gray-900 font-medium" : "hover:bg-white/60 text-gray-600"
            )}>
              <Bot className="w-4 h-4 shrink-0" /> Chats
            </button>
            <button onClick={() => { setNavMode('spaces'); setActiveSessionId(null); setActiveSessionDetail(null); setActiveSpaceId(null); setActiveView('home'); }} className={cn(
              "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors",
              navMode === 'spaces' && activeView === 'home' ? "bg-white border border-gray-200 shadow-sm text-gray-900 font-medium" : "hover:bg-white/60 text-gray-600"
            )}>
              <Folder className="w-4 h-4 shrink-0" /> Espacios
            </button>
            <button onClick={() => setActiveView('vaults')} className={cn(
              "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors",
              activeView === 'vaults' ? "bg-white border border-gray-200 shadow-sm text-gray-900 font-medium" : "hover:bg-white/60 text-gray-600"
            )}>
              <Folder className="w-4 h-4 shrink-0 text-amber-500" /> Bóvedas
            </button>
            <button onClick={() => setActiveView('tools')} className={cn(
              "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors",
              activeView === 'tools' ? "bg-white border border-gray-200 shadow-sm text-gray-900 font-medium" : "hover:bg-white/60 text-gray-600"
            )}>
              <Wrench className="w-4 h-4 shrink-0" /> Herramientas
            </button>
            <button onClick={() => setActiveView('customize')} className={cn(
              "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors",
              activeView === 'customize' ? "bg-white border border-gray-200 shadow-sm text-gray-900 font-medium" : "hover:bg-white/60 text-gray-600"
            )}>
              <Settings className="w-4 h-4 shrink-0" /> Personalizar
            </button>
          </nav>

          <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2 px-1">Bóvedas recientes</div>
          <nav className="space-y-0.5 mb-6">
            <button className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors hover:bg-white/60 text-gray-600">
              <Folder className="w-4 h-4 shrink-0 text-amber-500" /> Jurisprudencia
            </button>
            <button className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors hover:bg-white/60 text-gray-600">
              <Folder className="w-4 h-4 shrink-0 text-amber-500" /> Contratos
            </button>
          </nav>
          
          <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2 px-1">Historial</div>
          <nav className="space-y-0.5">
            {sessions.slice(0, 10).map((s: any) => (
              <button key={s.id} onClick={() => { setActiveSessionId(s.id); if (s.spaceId) { setActiveSpaceId(s.spaceId); setNavMode('spaces'); } else { setNavMode('chats'); } }} className={cn(
                "w-full text-left block rounded-lg px-3 py-2 text-sm transition-colors",
                activeSessionId === s.id ? "bg-white border border-gray-200 shadow-sm text-gray-900 font-medium" : "hover:bg-white/60 text-gray-600"
              )}>
                <span className="truncate block">{s.name || 'Chat'}</span>
              </button>
            ))}
            {sessions.length === 0 && (
              <p className="text-[11px] text-gray-400 px-3 py-1">Sin historial</p>
            )}
          </nav>
        </div>
      </aside>

      {/* Main Content */}
      {activeSessionDetail ? (
        <main className="flex-1 flex flex-col min-w-0 bg-white relative shadow-sm z-10 w-full">
          <header className="flex items-center justify-between p-3 border-b border-gray-200 bg-white shrink-0 z-20">
            <div className="w-[100px]">
              <button onClick={() => setIsLeftSidebarOpen(!isLeftSidebarOpen)} className="p-1.5 hover:bg-gray-100 rounded-md text-gray-500 transition" title={isLeftSidebarOpen ? "Ocultar menú" : "Mostrar menú"}>
                {isLeftSidebarOpen ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              </button>
            </div>
            <div className="flex-1 flex justify-center overflow-hidden">
              <div className="flex items-center gap-2 text-sm font-semibold text-gray-800 truncate">
                <Bot className="w-4 h-4 text-blue-600" />
                <span className="truncate">{activeSessionDetail.name || 'Conversación'}</span>
              </div>
            </div>
            <div className="w-[100px] flex justify-end">
              {!isWorkspaceSidebarOpen && (
                <button onClick={() => setIsWorkspaceSidebarOpen(true)} className="p-1.5 hover:bg-gray-100 rounded-md text-gray-500 transition flex items-center gap-2" title="Bóveda">
                  <span className="text-xs font-semibold hidden sm:inline-block">Bóveda</span>
                  <Folder className="w-4 h-4" />
                </button>
              )}
            </div>
          </header>
          <ChatArea session={activeSessionDetail} onUpdate={handleUpdate} onToggleFiles={() => setIsWorkspaceSidebarOpen(true)} />
        </main>
      ) : activeView === 'customize' ? (
        <CustomizePage onBack={() => setActiveView('home')} />
      ) : activeView === 'computer' ? (
        <main className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-gray-50 min-w-0 w-full">
          <Terminal className="w-16 h-16 text-gray-200 mb-4" />
          <h2 className="text-2xl font-bold text-gray-400 mb-2">Computer</h2>
          <p className="text-gray-500 text-sm max-w-sm mb-6">Mini-aplicaciones HTML/JS y navegador interactivo.</p>
          <p className="text-xs text-gray-400">Activa Computer desde el toggle en la barra de input.</p>
        </main>
      ) : activeView === 'vaults' ? (
        <VaultsView />
      ) : activeView === 'tools' ? (
        <main className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-gray-50 min-w-0 w-full">
          <Wrench className="w-16 h-16 text-gray-200 mb-4" />
          <h2 className="text-2xl font-bold text-gray-400 mb-2">Herramientas</h2>
          <p className="text-gray-500 text-sm max-w-sm">Acceso rápido a las herramientas internas: tabular review, editor DOCX, dashboards, etc.</p>
        </main>
      ) : navMode === 'spaces' ? (
        <SpacesView 
          spaces={spaces}
          sessions={sessions}
          activeSpaceId={activeSpaceId}
          onSelectSpace={(id: string) => { setActiveSpaceId(id); }}
          onCreateSpace={createSpace}
          onCreateSession={(sid: string) => createSession(sid)}
          onSelectSession={setActiveSessionId}
          isLeftSidebarOpen={isLeftSidebarOpen}
          onToggleSidebar={() => setIsLeftSidebarOpen(!isLeftSidebarOpen)}
          onBackToSpaces={() => setActiveSpaceId(null)}
        />
      ) : (
        <WelcomeScreen
          userName="doctor Juan"
          onSubmit={async (message, m) => { await createSession(null); setTimeout(() => {
            const sid = sessions[sessions.length - 1]?.id || activeSessionId;
            if (sid) {
              api.post(`/sessions/${sid}/message`, { content: message }).catch(() => {});
            }
          }, 200); }}
          onAttachFile={async (file) => {
            const fd = new FormData();
            fd.append('file', file);
            try { await axios.post('/api/sessions/0/workspace/files/upload', fd); } catch {}
          }}
          onOpenCustomize={() => setActiveView('customize')}
          onOpenMonitors={(tab) => {}}
          onOpenScheduled={() => { alert('Tareas programadas: función en construcción. Configúralas desde el panel de Tareas recurrentes dentro de cada espacio.'); }}
          onOpenGuides={() => { alert('Guías: próximamente.'); }}
        />
      )}

      {activeSessionDetail && isWorkspaceSidebarOpen && (
        <WorkspaceSidebar 
          session={activeSessionDetail} 
          onClose={() => setIsWorkspaceSidebarOpen(false)}
          onUpdate={handleUpdate}
          onPreviewChange={(hasPreview) => { if (hasPreview) setIsLeftSidebarOpen(false); }}
        />
      )}
      </div>
    </div>
  );
}

const DashboardViewer = ({ url, updatedAt, fileName }: { url: string; updatedAt?: number; fileName: string }) => {
  const [htmlContent, setHtmlContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setError(null);

    const t = updatedAt || Date.now();
    const fetchUrl = url.includes('?') ? `${url}&t=${t}` : `${url}?t=${t}`;

    fetch(fetchUrl)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
      .then(html => { if (active) { setHtmlContent(html); setIsLoading(false); } })
      .catch(e => { if (active) { setError(e.message); setIsLoading(false); } });

    return () => { active = false; };
  }, [url, updatedAt]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-gray-500 bg-white">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Cargando dashboard...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-red-500 bg-white flex-col gap-2 p-4">
        <p className="font-semibold">Error al cargar</p>
        <p className="text-sm text-gray-500">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-white">
      <div className="bg-gray-100 border-b border-gray-200 px-4 py-1.5 flex items-center shrink-0">
        <span className="text-xs font-semibold text-gray-500">Dashboard</span>
        <span className="text-xs text-gray-400 ml-2 truncate">{fileName}</span>
      </div>
      <iframe
        srcDoc={htmlContent || ''}
        className="w-full flex-1 border-none"
        sandbox="allow-scripts allow-same-origin allow-forms"
        title={fileName}
      />
    </div>
  );
};

const ExcelViewer = ({ workbook, onSave, fileName }: { workbook: any, onSave?: () => void, fileName?: string }) => {
  const [fortuneData, setFortuneData] = useState<any[] | null>(null);

  useEffect(() => {
    let active = true;
    const loadFortune = async () => {
      try {
        const buffer = await workbook.xlsx.writeBuffer();
        const file = new File([buffer], fileName || "file.xlsx", {
           type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        });
        LuckyExcel.transformExcelToLucky(file, (exportJson: any) => {
           if (active && exportJson && exportJson.sheets) {
              setFortuneData(exportJson.sheets);
           }
        });
      } catch (err) {
        console.error("Error converting to luckysheet", err);
      }
    };
    if (workbook) {
       loadFortune();
    }
    return () => { active = false; };
  }, [workbook, fileName]);

  if (!fortuneData) {
     return (
       <div className="flex h-full items-center justify-center text-gray-500">
         <Loader2 className="w-5 h-5 animate-spin mr-2" /> Cargando interfaz de Excel...
       </div>
     );
  }

  return (
    <div className="absolute inset-0" style={{ zIndex: 0 }}>
       <FortuneSheetWorkbook data={fortuneData} />
    </div>
  );
};;

function WorkspaceSidebar({ session, onClose, onPreviewChange, onUpdate }: { session: any, onClose: () => void, onPreviewChange?: (hasPreview: boolean) => void, onUpdate: () => void }) {
  const [files, setFiles] = useState<any[]>([]);
  const [previewFile, setPreviewFile] = useState<{name: string, url: string, updatedAt?: number, isBlob?: boolean} | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showFullscreenChat, setShowFullscreenChat] = useState(false);
  
  useEffect(() => {
    onPreviewChange?.(!!previewFile);
  }, [previewFile, onPreviewChange]);
  
  const [docBuffer, setDocBuffer] = useState<ArrayBuffer | null>(null);
  const [docMetaHtml, setDocMetaHtml] = useState<string | null>(null);
  const [workbook, setWorkbook] = useState<any>(null);
  const [isLoadingDoc, setIsLoadingDoc] = useState(false);
  const [promptConfig, setPromptConfig] = useState<{type: 'create' | 'rename' | 'delete', target?: string, inputValue: string, isOpen: boolean} | null>(null);
  const [selectionBox, setSelectionBox] = useState<{top: number, left: number, text: string, range: Range, context?: string} | null>(null);
  const [aiPrompt, setAiPrompt] = useState("");
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [showAiToolbar, setShowAiToolbar] = useState(false);
  const [showAiChatPanel, setShowAiChatPanel] = useState(false);
  const [docChatHistory, setDocChatHistory] = useState<Array<{role: string, content: string}>>([]);
  const [isEditingDoc, setIsEditingDoc] = useState(false);
  const [lineSpacing, setLineSpacing] = useState("1.5");
  const [zoomLevel, setZoomLevel] = useState(100);
  const [docComments, setDocComments] = useState<Array<{id: string, text: string, replies: string[], author: string, timestamp: Date, resolved?: boolean, liked?: boolean}>>([]);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [newCommentText, setNewCommentText] = useState("");
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editingCommentText, setEditingCommentText] = useState("");
  const [commentPositions, setCommentPositions] = useState<Record<string, number>>({});
  const [joditTab, setJoditTab] = useState<'Home' | 'Insert' | 'Layout' | 'Review' | 'View' | 'Efficiency'>('Home');
  
  const signatureInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const editorInstanceRef = useRef<any>(null);
  const signatureFileUrlRef = useRef<string | null>(null);

  const handleSignatureUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !editorInstanceRef.current) return;
    const url = URL.createObjectURL(file);
    signatureFileUrlRef.current = url;
    
    const editor = editorInstanceRef.current;
    editor.selection.insertHTML(`<br/><img src="${url}" alt="Firma" style="max-height: 100px; width: auto;" /><br/>`);
    
    // update state
    const wysiwyg = docxContainerRef.current?.querySelector('.jodit-wysiwyg');
    if (wysiwyg) setDocMetaHtml(wysiwyg.innerHTML);
    e.target.value = '';
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !editorInstanceRef.current) return;
    const url = URL.createObjectURL(file);
    
    const editor = editorInstanceRef.current;
    editor.selection.insertHTML(`<img src="${url}" alt="Imagen" style="max-width: 100%; height: auto;" />`);
    
    // update state
    const wysiwyg = docxContainerRef.current?.querySelector('.jodit-wysiwyg');
    if (wysiwyg) setDocMetaHtml(wysiwyg.innerHTML);
    e.target.value = '';
  };

  const joditConfig = React.useMemo(() => {
    const buttonsInicio = [
      'bold', 'italic', 'underline', 'strikethrough', 'eraser', '|',
      'font', 'fontsize', 'textColor', 'paragraph', 'lineHeight', '|',
      'align', 'ul', 'ol', 'outdent', 'indent', '|',
      'link', 'hr', '|',
      'searchMenu', 'aiChat', '|',
      'signMenu', 'downloadMenu'
    ];
    
    const buttonsInsertar = [
      'insertLocalImage', 'table', 'addComment', 'pageBreak'
    ];

    return {
      readonly: !isEditingDoc,
      toolbar: false,
      activeButtonsInReadOnly: ['source', 'print', 'about'],
      toolbarButtonSize: 'middle' as const,
      theme: 'default',
      iframe: false,
      toolbarAdaptive: false,
      enableDragAndDropFileToEditor: true,
      showCharsCounter: false,
      showWordsCounter: false,
      showXPathInStatusbar: false,
      disablePlugins: 'add-new-line',
      style: {
        fontFamily: 'Arial',
        backgroundColor: '#ffffff',
        height: '100%',
        minHeight: '29.7cm',
        padding: '2.54cm',
        boxSizing: 'border-box'
      },
      lineHeight: lineSpacing,
      events: {
         afterInit: (editor: any) => {
           joditInstanceRef.current = editor;
         }
      },
      buttons: joditTab === 'Home' ? buttonsInicio : buttonsInsertar,
      controls: {
         textColor: {
            icon: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16"/><path d="m6 16 6-12 6 12"/><path d="M8 12h8"/></svg>',
            tooltip: 'Color de texto',
            popup: (editor: any, current: any, close: () => void) => {
               const div = document.createElement('div');
               div.className = 'grid grid-cols-5 p-1 gap-1 bg-white min-w-[120px]';
               const colors = ['#000000', '#EF4444', '#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#6B7280', '#ffffff', '#4B5563'];
               colors.forEach(c => {
                  const btn = document.createElement('button');
                  btn.className = 'w-5 h-5 rounded border border-gray-200 cursor-pointer hover:scale-110 transition-transform';
                  btn.style.backgroundColor = c;
                   btn.onclick = () => {
                      editor.execCommand('foreColor', false, c);
                      close();
                   };
                  div.appendChild(btn);
               });
               return div;
            }
         },
         aiChat: {
            icon: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>',
            tooltip: 'Chatbot IA (Documento)',
            exec: (editor: any) => {
               setIsFullscreen(true);
               setShowAiChatPanel(true);
            }
         },
         signMenu: {
            icon: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>',
            tooltip: 'Firmar',
            popup: (editor: any, current: any, close: () => void) => {
               const div = document.createElement('div');
               div.className = 'flex flex-col p-1 min-w-[150px] bg-white';
               
               const btnUse = document.createElement('button');
               btnUse.className = 'text-left px-3 py-1.5 hover:bg-gray-100 text-sm rounded cursor-pointer';
               btnUse.innerHTML = 'Usar firma actual';
               btnUse.onclick = () => {
                  close();
                  if (signatureFileUrlRef.current) {
                     editor.selection.insertHTML(`<br/><img src="${signatureFileUrlRef.current}" alt="Firma" style="max-height: 100px; width: auto;" /><br/>`);
                     const wysiwyg = docxContainerRef.current?.querySelector('.jodit-wysiwyg');
                     if (wysiwyg) setDocMetaHtml(wysiwyg.innerHTML);
                  } else {
                     editorInstanceRef.current = editor;
                     signatureInputRef.current?.click();
                  }
               };
               
               const btnUpload = document.createElement('button');
               btnUpload.className = 'text-left px-3 py-1.5 hover:bg-gray-100 text-sm rounded mt-1 cursor-pointer';
               btnUpload.innerHTML = 'Subir nueva firma';
               btnUpload.onclick = () => {
                  close();
                  editorInstanceRef.current = editor;
                  signatureInputRef.current?.click();
               };
               
               div.appendChild(btnUse);
               div.appendChild(btnUpload);
               return div;
            }
         },
         downloadMenu: {
            icon: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>',
            tooltip: 'Descargar',
            popup: (editor: any, current: any, close: () => void) => {
               const div = document.createElement('div');
               div.className = 'flex flex-col p-1 min-w-[170px] bg-white';
               
               const btnPdf = document.createElement('button');
               btnPdf.className = 'text-left px-3 py-1.5 hover:bg-gray-100 text-sm rounded cursor-pointer flex items-center gap-2';
               btnPdf.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg> Descargar como PDF';
               btnPdf.onclick = () => {
                  close();
                  if (docxContainerRef.current) {
                     const printWindow = window.open('', '_blank');
                     if (printWindow) {
                        printWindow.document.write('<html><head><title>Imprimir/PDF Documento</title>');
                        printWindow.document.write('<style>@page { margin: 2.54cm; } body { font-family: Arial, sans-serif; font-size: 11pt; line-height: 1.5; color: black; }</style>');
                        printWindow.document.write('</head><body>');
                        printWindow.document.write(docxContainerRef.current.innerHTML);
                        printWindow.document.write('</body></html>');
                        printWindow.document.close();
                        // Wait a bit for resources like images to load (if any) before printing
                        setTimeout(() => {
                           printWindow.focus();
                           printWindow.print();
                        }, 250);
                     }
                  } else {
                     editor.execCommand('print');
                  }
               };
               
               const btnWord = document.createElement('button');
               btnWord.className = 'text-left px-3 py-1.5 hover:bg-gray-100 text-sm rounded mt-1 cursor-pointer flex items-center gap-2';
               btnWord.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg> Descargar como WORD';
               btnWord.onclick = async () => {
                  close();
                  if (previewFile?.name) {
                     const link = document.createElement('a');
                     link.href = `/api/sessions/${session.id}/export-docx?path=${encodeURIComponent(previewFile.name)}&lineSpacing=${lineSpacing}`;
                     link.download = previewFile.name.replace('.doc.html', '.docx');
                     document.body.appendChild(link);
                     link.click();
                     link.remove();
                  }
               };
               
               div.appendChild(btnPdf);
               div.appendChild(btnWord);
               return div;
            }
         },
         searchMenu: {
            icon: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
            tooltip: 'Buscar / Reemplazar',
            popup: (editor: any, current: any, close: () => void) => {
               const div = document.createElement('div');
               div.className = 'flex flex-col p-1 min-w-[120px] bg-white';
               
               const btnFind = document.createElement('button');
               btnFind.className = 'text-left px-3 py-1.5 hover:bg-gray-100 text-sm rounded cursor-pointer';
               btnFind.innerHTML = 'Buscar';
               btnFind.onclick = () => {
                  close();
                  editor.execCommand('search');
               };
               
               const btnReplace = document.createElement('button');
               btnReplace.className = 'text-left px-3 py-1.5 hover:bg-gray-100 text-sm rounded mt-1 cursor-pointer';
               btnReplace.innerHTML = 'Reemplazar';
               btnReplace.onclick = () => {
                  close();
                  editor.execCommand('search'); 
               };
               
               div.appendChild(btnFind);
               div.appendChild(btnReplace);
               return div;
            }
         },
         pageBreak: {
            icon: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>',
            tooltip: 'Salto de página',
            exec: (editor: any) => {
               editor.selection.insertHTML('<div style="page-break-after:always; height: 1px; border-bottom: 2px dashed #9ca3af; margin: 20px 0; width: 100%;" class="page-break" title="Salto de página"></div><p><br/></p>');
               const wysiwyg = docxContainerRef.current?.querySelector('.jodit-wysiwyg');
               if (wysiwyg) setDocMetaHtml(wysiwyg.innerHTML);
            }
         },
         insertLocalImage: {
            icon: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>',
            tooltip: 'Insertar Imagen...',
            exec: (editor: any) => {
               editorInstanceRef.current = editor;
               imageInputRef.current?.click();
            }
         },
         addComment: {
            icon: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
            tooltip: 'Insertar Comentario',
            exec: (editor: any) => {
               const sel = editor.selection;
               if (!sel || sel.isCollapsed()) {
                 alert("Selecciona un texto para comentar.");
                 return;
               }
               
               const id = uuidv4();
               const selectedHtml = sel.getHTML();
               const wrapped = `<mark class="docx-comment" data-comment-id="${id}" style="background-color:#f3e8ff;color:inherit;">${selectedHtml}</mark>`;
               sel.remove();
               sel.insertHTML(wrapped);
               
               setDocComments(prev => [...prev, {
                  id,
                  text: "",
                  replies: [],
                  author: "Current User",
                  timestamp: new Date()
               }]);
               
               setActiveCommentId(id);
               setEditingCommentId(id);
               setEditingCommentText("");
               
               const wysiwyg = docxContainerRef.current?.querySelector('.jodit-wysiwyg');
               if (wysiwyg) setDocMetaHtml(wysiwyg.innerHTML);
            }
         }
      }
    };
  }, [isEditingDoc, lineSpacing, joditTab, previewFile, session]);
  
  const docxContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectionBoxRef = useRef<HTMLDivElement>(null);
  const joditInstanceRef = useRef<any>(null);
  const fontNameSelectRef = useRef<HTMLSelectElement>(null);
  const fontSizeSelectRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (selectionBoxRef.current && !selectionBoxRef.current.contains(e.target as Node)) {
        setSelectionBox(null);
        setShowAiToolbar(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const execFormat = (command: string, value: string | undefined = undefined) => {
     const editor = joditInstanceRef.current;
     if (!editor) return;
     editor.execCommand(command, false, value);
     if (!['undo', 'redo'].includes(command)) {
        setSelectionBox(null);
     }
  };

  const handleAddComment = () => {
     if (!selectionBox || !selectionBox.range || !joditInstanceRef.current) return;
     const id = uuidv4();
     const editor = joditInstanceRef.current;
     const sel = editor.selection;
     
     const selectedHtml = sel.getHTML();
     const wrapped = `<mark class="docx-comment" data-comment-id="${id}" style="background-color:#f3e8ff;color:inherit;">${selectedHtml}</mark>`;
     sel.remove();
     sel.insertHTML(wrapped);
     
     if (docxContainerRef.current) {
        const wysiwyg = docxContainerRef.current.querySelector('.jodit-wysiwyg');
        if (wysiwyg) {
           setDocMetaHtml(wysiwyg.innerHTML);
        }
     }
     
     setDocComments([...docComments, { id, text: "", replies: [], author: "Usuario", timestamp: new Date(), resolved: false, liked: false }]);
     handleActivateComment(id);
     setSelectionBox(null);
  };

  const handleActivateComment = (id: string | null) => {
    setActiveCommentId(id);
    if (id) {
       if (window.innerWidth < 1400) {
         setZoomLevel(prev => Math.min(prev, 80));
       } else {
         setZoomLevel(prev => Math.min(prev, 90));
       }
    }
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    // Sync font toolbar with current cursor position
    if (isEditingDoc && joditInstanceRef.current) {
       const sel = window.getSelection();
       if (sel && sel.anchorNode && sel.anchorNode.parentElement) {
          const node = sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode as HTMLElement;
          const computed = window.getComputedStyle(node);
          const ff = computed.fontFamily?.split(",")[0]?.replace(/["']/g, "").trim();
          if (ff && fontNameSelectRef.current) {
             const opts = fontNameSelectRef.current.options;
             for (let i = 0; i < opts.length; i++) {
                if (opts[i].value === ff) { fontNameSelectRef.current.value = ff; break; }
             }
          }
          // Walk up DOM to find inline font-size style (avoids px→pt mismatch on reload)
          let el: HTMLElement | null = node;
          let foundSize = "";
          while (el && el !== docxContainerRef.current) {
             const inline = el.getAttribute?.("style") || "";
             const m = inline.match(/font-size:\s*(\d+)\s*pt/i);
             if (m) { foundSize = m[1]; break; }
             el = el.parentElement;
          }
          if (foundSize && fontSizeSelectRef.current) {
             const opts = fontSizeSelectRef.current.options;
             for (let i = 0; i < opts.length; i++) {
                if (opts[i].value === foundSize + "pt") { fontSizeSelectRef.current.value = opts[i].value; break; }
             }
          }
       }
    }

    // If we click on a comment, open the comment view.
    let target = e.target as HTMLElement | null;
    let clickedComment = false;
    
    // Ignore clicks within the comments side panel or specific buttons to avoid clearing active comment
    if (target?.closest('.comments-side-panel')) return;

    while (target && target !== docxContainerRef.current) {
        if (target.classList.contains('docx-comment')) {
           const id = target.getAttribute('data-comment-id');
           if (id) {
              handleActivateComment(id);
              clickedComment = true;
              break;
           }
        }
        target = target.parentElement;
    }
    
    if (!clickedComment) {
       handleActivateComment(null);
    }

    setTimeout(() => {
      if (!isEditingDoc) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !docxContainerRef.current) return;
      
      if (!docxContainerRef.current.contains(selection.anchorNode)) return;

      const text = selection.toString().trim();
      if (!text) return;

      const range = selection.getRangeAt(0).cloneRange();
      const rect = range.getBoundingClientRect();

      // Pass the surrounding document text as context
      const fullDocumentText = docxContainerRef.current.innerText;

      let top = e.clientY + 15;
      let left = Math.max(10, e.clientX - 100);

      const estimatedBoxHeight = 60;

      if (top + estimatedBoxHeight > window.innerHeight) {
        top = Math.max(10, e.clientY - estimatedBoxHeight - 15);
      }
      
      const boxWidth = Math.min(400, window.innerWidth * 0.95);
      if (left + boxWidth > window.innerWidth) {
        left = Math.max(10, window.innerWidth - boxWidth - 10);
      }

      setSelectionBox({
        top,
        left,
        text,
        range,
        context: fullDocumentText
      });
      setShowAiToolbar(false);
    }, 10);
  };

  const handleAiEdit = async (overridePrompt?: string) => {
    const finalPrompt = overridePrompt || aiPrompt;
    if (!selectionBox || !finalPrompt.trim()) return;
    setIsAiLoading(true);
    try {
      const res = await axios.post("/api/ai/edit-fragment", {
        text: selectionBox.text,
        prompt: finalPrompt,
        context: selectionBox.context
      });
      const newText = res.data.result;
      
      const newTextString = typeof newText === 'string' ? newText : String(newText || "");
      const htmlContent = newTextString.replace(/\n/g, '<br>');

      if (joditInstanceRef.current) {
         const editor = joditInstanceRef.current;
         editor.selection.remove();
         editor.selection.insertHTML(htmlContent);
      }
      
      setSelectionBox(null);
      setAiPrompt("");
      
      if (docxContainerRef.current) {
        const wysiwyg = docxContainerRef.current.querySelector('.jodit-wysiwyg');
        if (wysiwyg) {
           setDocMetaHtml(wysiwyg.innerHTML);
           saveDocxContent(wysiwyg.innerHTML);
           return;
        }
      }
      
      // Auto-save the extracted text
      saveDocxContent();
    } catch(e: any) {
      alert("Error AI: " + (e.response?.data?.error || e.message));
    } finally {
      setIsAiLoading(false);
    }
  };

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    
    const validExtensions = ['.docx', '.txt', '.xlsx', '.pdf'];
    const lowerName = file.name.toLowerCase();
    if (!validExtensions.some(ext => lowerName.endsWith(ext))) {
       alert("Solo se admiten archivos .docx, .txt, .xlsx, .pdf");
       e.target.value = "";
       return;
    }
    
    try {
      const formData = new FormData();
      formData.append('file', file);
      
      await axios.post(`/api/sessions/${session.id}/workspace/files/upload`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      
      const res = await api.get(`/sessions/${session.id}/workspace/files`);
      if (Array.isArray(res.data)) {
        setFiles(res.data);
      }
    } catch(err: any) {
      alert("Error subiendo archivo: " + err.message);
    } finally {
      e.target.value = "";
    }
  };

  useEffect(() => {
    let timeoutId: NodeJS.Timeout;
    let delay = 2000;
    const maxDelay = 30000;

    const loadFiles = async () => {
      try {
        const res = await api.get(`/sessions/${session.id}/workspace/files`);
        if (Array.isArray(res.data)) {
          setFiles(res.data);
          
          // Auto-refresh preview if file was updated globally (e.g. by agent)
          setPreviewFile(prev => {
            if (!prev) return prev;
            const matchingFile = res.data.find((f: any) => f.name === prev.name);
            if (matchingFile && matchingFile.updatedAt && prev.updatedAt && matchingFile.updatedAt > prev.updatedAt) {
              // File was updated!
              // We clear buffers to force a re-fetch
              setDocBuffer(null);
              setDocMetaHtml(null);
              setWorkbook(null);
              return { ...prev, updatedAt: matchingFile.updatedAt, url: prev.url + "?t=" + Date.now() };
            }
            if (matchingFile && !prev.updatedAt) {
               return { ...prev, updatedAt: matchingFile.updatedAt };
            }
            return prev;
          });
        }
      } catch (e) {}

      // Exponential backoff or clamped polling
      if (session.status === 'running') {
         delay = 2000; // active work, poll quickly
      } else {
         delay = Math.min(delay * 1.5, maxDelay); // slow down when idle up to 30s
      }
      
      timeoutId = setTimeout(loadFiles, delay);
    };
    
    loadFiles();
    return () => clearTimeout(timeoutId);
  }, [session.id, session.status]);

  const viewFile = async (name: string) => {
    const url = `/api/sessions/${session.id}/workspace/files/${encodeURIComponent(name)}/view`;
    const fObj = files.find(f => f.name === name);
    setPreviewFile({ name, url, isBlob: false, updatedAt: fObj?.updatedAt });
    setDocBuffer(null);
    setDocMetaHtml(null);
    setWorkbook(null);
    setIsLoadingDoc(false);
    setIsEditingDoc(false);
    setShowAiChatPanel(false);
    setSelectionBox(null);
  }

  const createNewDocx = () => {
    setPromptConfig({ type: 'create', inputValue: 'Nuevo_Documento', isOpen: true });
  };

  const deleteFile = (name: string) => {
    setPromptConfig({ type: 'delete', target: name, inputValue: '', isOpen: true });
  };

  const renameFile = (name: string) => {
    setPromptConfig({ type: 'rename', target: name, inputValue: name, isOpen: true });
  };

  const handlePromptSubmit = async () => {
    if (!promptConfig) return;
    try {
      if (promptConfig.type === 'create') {
        let name = promptConfig.inputValue.trim();
        if (!name) return;
        const finalName = name.endsWith('.docx') ? name : name + '.docx';
        await api.post(`/sessions/${session.id}/workspace/files`, { name: finalName });
      } else if (promptConfig.type === 'delete' && promptConfig.target) {
        await api.delete(`/sessions/${session.id}/workspace/files/${promptConfig.target}`);
        if (previewFile?.name === promptConfig.target) setPreviewFile(null);
      } else if (promptConfig.type === 'rename' && promptConfig.target) {
        let newName = promptConfig.inputValue.trim();
        if (!newName || newName === promptConfig.target) return;
        await api.put(`/sessions/${session.id}/workspace/files/${promptConfig.target}/rename`, { newName });
        if (previewFile?.name === promptConfig.target) setPreviewFile(null);
      }
    } catch(e: any) {
      alert("Error: " + e.message);
    } finally {
      setPromptConfig(null);
    }
  };

  const downloadFile = async (name: string) => {
    try {
      if (name.endsWith('.doc.html') || name.endsWith('.docx')) {
        const link = document.createElement('a');
        link.href = `/api/sessions/${session.id}/export-docx?path=${encodeURIComponent(name)}&lineSpacing=${lineSpacing}`;
        link.download = name.endsWith('.doc.html') ? name.replace('.doc.html', '.docx') : name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        return;
      }
      
      const res = await api.get(`/sessions/${session.id}/workspace/files/${name}`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', name);
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch(e) {
      alert('Could not download file');
    }
  }

  const closePreview = () => {
    if (previewFile && previewFile.isBlob) {
      window.URL.revokeObjectURL(previewFile.url);
    }
    setPreviewFile(null);
    setIsFullscreen(false);
  }

  const isPDF = previewFile?.name.toLowerCase().endsWith('.pdf');
  const isDocx = previewFile?.name.toLowerCase().endsWith('.doc.html') || previewFile?.name.toLowerCase().endsWith('.docx');
  const isExcel = previewFile?.name.toLowerCase().match(/\.xlsx?$/);
  const isDashboard = previewFile?.name.toLowerCase().endsWith('.html') && !isDocx;

  const [isSaving, setIsSaving] = useState(false);

  const saveDocxContent = async (overrideHtml?: string) => {
    if (!previewFile) return;
    try {
      setIsSaving(true);
      
      let rawHtml = overrideHtml;
      if (rawHtml === undefined) {
         if (docxContainerRef.current) {
            const wysiwyg = docxContainerRef.current.querySelector('.jodit-wysiwyg');
            if (wysiwyg) {
               rawHtml = wysiwyg.innerHTML;
               setDocMetaHtml(rawHtml);
            } else {
               rawHtml = docMetaHtml || "";
            }
         } else {
            rawHtml = docMetaHtml || "";
         }
      }
      
      const contentHtml = `<div style="font-size: 11pt; line-height: ${lineSpacing}; text-align: inherit;">${rawHtml}</div>`;
      await api.put(`/sessions/${session.id}/workspace/files/${previewFile.name}/content`, { contentHtml, rawHtml });
      
      // Save comments
      if (docComments.length > 0) {
         try {
            const formData = new FormData();
            const blob = new Blob([JSON.stringify(docComments)], { type: "application/json" });
            const file = new File([blob], `${previewFile.name}.comments.json`, { type: "application/json" });
            formData.append("file", file);
            await api.post(`/sessions/${session.id}/workspace/files/upload`, formData);
         } catch (e) {
            console.error("Failed to save comments", e);
         }
      }

      alert("¡Cambios guardados exitosamente!");
    } catch(e: any) {
      const errorMessage = e.response?.data?.error || e.message;
      alert("Error al guardar: " + errorMessage);
      console.error(e);
    } finally {
      setIsSaving(false);
    }
  };

  useEffect(() => {
    if (docxContainerRef.current) {
      const editableDiv = docxContainerRef.current.querySelector('.docx-editor') as HTMLElement;
      if (editableDiv) {
        editableDiv.contentEditable = isEditingDoc ? "true" : "false";
      }
    }
  }, [isEditingDoc, docMetaHtml]);

  useEffect(() => {
    if (docxContainerRef.current) {
      const editableDiv = docxContainerRef.current.querySelector('.docx-editor') as HTMLElement;
      if (editableDiv) {
        editableDiv.style.lineHeight = lineSpacing;
      }
    }
  }, [lineSpacing, docMetaHtml]);

  useEffect(() => {
    if (!previewFile) return;
    const isLocalDocx = previewFile.name.toLowerCase().endsWith('.doc.html') || previewFile.name.toLowerCase().endsWith('.docx');
    const isLocalExcel = previewFile.name.toLowerCase().match(/\.xlsx?$/);
    if (!isLocalDocx && !isLocalExcel) return;
    
    let isMounted = true;
    const fetchDoc = async () => {
      setIsLoadingDoc(true);
      try {
        if (isLocalDocx) {
          try {
            const t = previewFile.updatedAt || Date.now();
            const commentsRes = await api.get(`/sessions/${session.id}/workspace/files/${previewFile.name}.comments.json/view?t=${t}`);
            if (isMounted && commentsRes.data && Array.isArray(commentsRes.data)) {
              setDocComments(commentsRes.data.map((c: any) => ({ ...c, timestamp: new Date(c.timestamp) })));
            }
          } catch (err) {
            console.log("No stored comments found.");
          }

          const t = previewFile.updatedAt || Date.now();
          const fetchUrl = previewFile.url.includes('?') ? `${previewFile.url}&t=${t}` : `${previewFile.url}?t=${t}`;
          const response = await fetch(fetchUrl);
          const text = await response.text();
          
          if (!isMounted) return;
          setDocMetaHtml(text);
          setDocBuffer(new ArrayBuffer(0)); // Dummy buffer so other hooks don't keep firing

        } else if (isLocalExcel) {
          const t = previewFile.updatedAt || Date.now();
          const fetchUrl = previewFile.url.includes('?') ? `${previewFile.url}&t=${t}` : `${previewFile.url}?t=${t}`;
          const response = await fetch(fetchUrl);
          const arrayBuffer = await response.arrayBuffer();
          if (!isMounted) return;
          const ExcelJS = await import('exceljs');
          const wb = new ExcelJS.Workbook();
          await wb.xlsx.load(arrayBuffer);
          if (isMounted) {
            setWorkbook(wb);
            setDocBuffer(arrayBuffer);
          }
        }
      } catch (err) {
        console.error("Error parsing document:", err);
      } finally {
        if (isMounted) setIsLoadingDoc(false);
      }
    };
    
    // We want to fetch if docMetaHtml is null, OR if our stored updatedAt doesn't match previewFile.updatedAt
    // But since docBuffer/docMetaHtml/workbook are cleared when previewFile changes entirely, 
    // we can just check if we have them. 
    // Wait, let's use a ref to track the last fetched updatedAt.
    fetchDoc();
    
    return () => { isMounted = false; };
  }, [previewFile?.name, previewFile?.updatedAt, previewFile?.url, session.id]);



  useEffect(() => {
    if (!docxContainerRef.current) return;
    
    // Update Highlights
    const marks = docxContainerRef.current.querySelectorAll('.docx-comment') as NodeListOf<HTMLElement>;
    Array.from(marks).forEach(mark => {
       const id = mark.getAttribute('data-comment-id');
       const c = docComments.find(x => x.id === id);
       if (!c) {
          const parent = mark.parentNode;
          if (parent) {
             while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
             parent.removeChild(mark);
          }
          return;
       }
       const isActive = activeCommentId === id;
       
       if (c.resolved && !isActive) {
          mark.style.backgroundColor = 'transparent';
       } else {
          mark.style.backgroundColor = '#f3e8ff';
       }
    });
    
    // Compute positions for icons
    const updatePositions = () => {
       if (!docxContainerRef.current) return;
       const containerRect = docxContainerRef.current.parentElement?.getBoundingClientRect();
       if (!containerRect) return;
       
       const newPos: Record<string, number> = {};
       
       Array.from(marks).forEach(mark => {
          const id = mark.getAttribute('data-comment-id');
          if (id) {
             const rect = mark.getBoundingClientRect();
             newPos[id] = rect.top - containerRect.top;
          }
       });
       setCommentPositions(newPos);
    };
    
    const t = setTimeout(updatePositions, 50);
    return () => clearTimeout(t);
  }, [docComments, activeCommentId, docMetaHtml, docBuffer, isFullscreen]);

  const renderPreviewContent = () => {
    if (!previewFile) return null;
    
    if (isDocx) {
      return (
         <div className="flex flex-col h-full bg-[#f3f2f1] overflow-hidden relative">
           <div className="bg-[#f0f0f0] border-b border-gray-300 flex flex-col w-full shrink-0">
             {/* TOP HEADER: File name, options, user */}
             <div className="flex flex-col sm:flex-row items-center justify-between px-2 sm:px-4 py-2 border-b border-gray-200 gap-2 sm:gap-0">
               <div className="flex items-center gap-4 w-full sm:w-auto overflow-hidden">
                 <button className="text-gray-600 hover:bg-gray-200 p-1.5 rounded shrink-0 hidden sm:block"><PanelRightClose className="w-5 h-5"/></button>
                 <div className="flex items-center gap-2 truncate">
                   <h1 className="text-[15px] font-semibold text-gray-800 truncate">{previewFile.name}</h1>
                   {!isEditingDoc ? (
                     <span className="bg-gray-200 text-gray-600 text-[10px] uppercase font-bold px-2 py-0.5 rounded shrink-0">Read-Only</span>
                   ) : (
                     <span className="bg-blue-100 text-blue-700 text-[10px] uppercase font-bold px-2 py-0.5 rounded shrink-0">Editing</span>
                   )}
                 </div>
               </div>
               
               <div className="flex items-center gap-2 w-full sm:w-auto shrink-0 justify-between sm:justify-end">
                 {/* Zoom controls and Save button */}
                 <div className="flex items-center gap-1 sm:gap-2 mr-0 sm:mr-2 shrink-0">
                   <button title="Reducir zoom" className="text-gray-500 hover:text-gray-800 transition p-1" onClick={() => setZoomLevel(z => Math.max(z - 10, 10))}><Minus className="w-4 h-4" /></button>
                   <input type="range" min="10" max="200" value={zoomLevel} onChange={e => setZoomLevel(Number(e.target.value))} className="w-16 h-1 bg-gray-300 rounded-lg appearance-none cursor-pointer accent-blue-600 hidden sm:block" />
                   <button title="Aumentar zoom" className="text-gray-500 hover:text-gray-800 transition p-1" onClick={() => setZoomLevel(z => Math.min(z + 10, 200))}><Plus className="w-4 h-4" /></button>
                   <span className="text-xs text-gray-600 w-8 text-right font-medium hidden sm:block">{zoomLevel}%</span>
                 </div>
                 
                 <div className="flex items-center gap-1 border-r border-gray-300 pr-2 mr-1 sm:mr-2 shrink-0">
                   {isEditingDoc && <button onClick={() => { setIsEditingDoc(true); setIsFullscreen(true); setShowAiChatPanel(true); }} className={cn("p-1.5 transition-colors rounded", showAiChatPanel ? "bg-indigo-100 text-indigo-700" : "text-gray-500 hover:text-gray-800 hover:bg-gray-200")} title="Asistente IA"><Bot className="w-4 h-4" /></button>}
                   <button onClick={() => setIsFullscreen(prev => !prev)} className={cn("p-1.5 transition-colors rounded", isFullscreen ? "bg-gray-200 text-gray-800" : "text-gray-500 hover:text-gray-800 hover:bg-gray-200")} title="Pantalla completa"><Maximize className="w-4 h-4" /></button>
                 </div>

                 <button onClick={() => saveDocxContent()} disabled={isSaving || !isEditingDoc} className="px-3 py-1.5 bg-blue-600 text-white text-xs font-semibold rounded hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center gap-2 shrink-0">
                   {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                   {isSaving ? "Guardando..." : "Guardar"}
                 </button>
               </div>
             </div>
             
             {/* TABS ROW */}
             <div className="flex flex-nowrap overflow-x-auto items-end px-2 sm:px-4 bg-[#f8f8f8] border-b border-gray-200 pt-1 scrollbar-hide shrink-0">
               {['File', 'Home', 'Insert', 'Layout', 'Review', 'View', 'Efficiency'].map((t, idx) => {
                 if (t === 'File') {
                   return <button key={t} className="px-4 py-1.5 text-[13px] font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-t mr-1 mb-px">File</button>;
                 }
                 return (
                 <button 
                   key={t}
                   onClick={() => setJoditTab(t as any)} 
                   className={cn(
                     "px-3 sm:px-4 py-1 sm:py-1.5 text-[13px] font-medium border-b-2 transition-colors whitespace-nowrap", 
                     joditTab === t ? "border-blue-600 text-blue-700 bg-white rounded-t" : "border-transparent text-gray-600 hover:text-gray-900 hover:bg-gray-200"
                   )}
                 >
                   {t}
                 </button>
               )})}
             </div>
             
             {/* RIBBON TOOLBAR */}
             {!isEditingDoc && (
                <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 flex items-center justify-between min-h-[36px]">
                  <span className="text-[13px] text-amber-800 font-medium flex items-center gap-2"><Eye className="w-4 h-4"/> El documento está en modo lectura. Habilita la edición para hacer cambios.</span>
                  <button onClick={() => setIsEditingDoc(true)} className="text-sm bg-white text-gray-800 font-medium hover:bg-gray-50 border border-gray-300 px-3 py-1 rounded-md flex items-center gap-2 transition-colors shadow-sm">
                     <Edit2 className="w-4 h-4" /> Habilitar Edición
                  </button>
                </div>
             )}
             <fieldset disabled={!isEditingDoc} className={cn("bg-white px-2 sm:px-4 py-1.5 flex flex-nowrap sm:flex-wrap items-center gap-x-2 sm:gap-x-4 gap-y-2 min-h-[44px] overflow-x-auto scrollbar-hide shrink-0 shadow-sm border-b border-gray-200 transition-opacity", !isEditingDoc && "opacity-60")}>
               {joditTab === 'Home' && (
                 <>
                   {/* Undo/Redo */}
                   <div className="flex items-center gap-0.5 border-r border-gray-200 pr-2 sm:pr-4 shrink-0">
                     <button onMouseDown={e => { e.preventDefault(); execFormat('undo'); }} className="p-1.5 text-gray-600 hover:bg-gray-100 rounded disabled:opacity-50" title="Deshacer"><Undo className="w-4 h-4" /></button>
                     <button onMouseDown={e => { e.preventDefault(); execFormat('redo'); }} className="p-1.5 text-gray-600 hover:bg-gray-100 rounded disabled:opacity-50" title="Rehacer"><Redo className="w-4 h-4" /></button>
                   </div>
                   {/* Font tools */}
                   <div className="flex items-center gap-1 border-r border-gray-200 pr-2 sm:pr-4 shrink-0">
                      <select ref={fontNameSelectRef} onChange={e => execFormat('fontName', e.target.value)} className="text-[13px] border border-gray-300 rounded px-2 py-1 outline-none hover:border-gray-400 focus:border-blue-500 bg-transparent w-20 sm:w-24 appearance-none cursor-pointer disabled:opacity-50">
                       <option value="Arial">Arial</option>
                       <option value="Calibri">Calibri</option>
                       <option value="Times New Roman">Times New Roman</option>
                       <option value="Georgia">Georgia</option>
                       <option value="Verdana">Verdana</option>
                     </select>
                      <select ref={fontSizeSelectRef} onChange={e => execFormat('fontSize', e.target.value)} className="text-[13px] border border-gray-300 rounded px-2 py-1 outline-none hover:border-gray-400 focus:border-blue-500 bg-transparent w-14 sm:w-16 appearance-none cursor-pointer disabled:opacity-50">
                        <option value="8pt">8</option><option value="10pt">10</option><option value="12pt">12</option><option value="14pt">14</option><option value="18pt">18</option><option value="24pt">24</option><option value="36pt">36</option>
                     </select>
                   </div>
                   {/* Format buttons */}
                   <div className="flex items-center gap-0.5 border-r border-gray-200 pr-2 sm:pr-4 shrink-0">
                     <button onMouseDown={e => { e.preventDefault(); execFormat('bold'); }} className="p-1 sm:p-1.5 text-gray-700 hover:bg-gray-100 rounded font-bold disabled:opacity-50" title="Negrita"><Bold className="w-4 h-4 stroke-[3]" /></button>
                     <button onMouseDown={e => { e.preventDefault(); execFormat('italic'); }} className="p-1 sm:p-1.5 text-gray-700 hover:bg-gray-100 rounded italic disabled:opacity-50" title="Cursiva"><Italic className="w-4 h-4" /></button>
                     <button onMouseDown={e => { e.preventDefault(); execFormat('underline'); }} className="p-1 sm:p-1.5 text-gray-700 hover:bg-gray-100 rounded underline disabled:opacity-50" title="Subrayado"><Underline className="w-4 h-4" /></button>
                     <button onMouseDown={e => { e.preventDefault(); execFormat('strikethrough'); }} className="p-1 sm:p-1.5 text-gray-700 hover:bg-gray-100 rounded line-through disabled:opacity-50" title="Tachado"><Strikethrough className="w-4 h-4" /></button>
                     
                     <button onMouseDown={e => { e.preventDefault(); execFormat('foreColor', '#2563eb'); }} className="p-1 sm:p-1.5 text-blue-700 hover:bg-gray-100 rounded ml-1 flex flex-col items-center justify-center border-b-[3px] border-blue-600 disabled:opacity-50" title="Color de Texto (Azul)">
                       <span className="font-serif font-bold text-sm leading-none">A</span>
                     </button>
                     <button onMouseDown={e => { e.preventDefault(); execFormat('hiliteColor', 'yellow'); }} className="p-1 sm:p-1.5 text-black hover:bg-gray-100 rounded flex flex-col items-center justify-center border-b-[3px] border-yellow-400 disabled:opacity-50" title="Resaltar (Amarillo)">
                       <Highlighter className="w-4 h-4" />
                     </button>
                   </div>
                   {/* Alignment */}
                   <div className="flex items-center gap-0.5 border-r border-gray-200 pr-2 sm:pr-4 shrink-0">
                     <button onMouseDown={e => { e.preventDefault(); execFormat('justifyLeft'); }} className="p-1.5 text-gray-700 hover:bg-gray-100 rounded disabled:opacity-50"><AlignLeft className="w-4 h-4" /></button>
                     <button onMouseDown={e => { e.preventDefault(); execFormat('justifyCenter'); }} className="p-1.5 text-gray-700 hover:bg-gray-100 rounded disabled:opacity-50"><AlignCenter className="w-4 h-4" /></button>
                     <button onMouseDown={e => { e.preventDefault(); execFormat('justifyRight'); }} className="p-1.5 text-gray-700 hover:bg-gray-100 rounded disabled:opacity-50"><AlignRight className="w-4 h-4" /></button>
                   </div>
                   {/* Lists */}
                   <div className="flex items-center gap-0.5 border-r border-gray-200 pr-2 sm:pr-4 shrink-0">
                     <button onMouseDown={e => { e.preventDefault(); execFormat('insertUnorderedList'); }} className="p-1.5 text-gray-700 hover:bg-gray-100 rounded disabled:opacity-50"><List className="w-4 h-4" /></button>
                     <button onMouseDown={e => { e.preventDefault(); execFormat('insertOrderedList'); }} className="p-1.5 text-gray-700 hover:bg-gray-100 rounded disabled:opacity-50"><ListOrdered className="w-4 h-4" /></button>
                   </div>
                   {/* AI Bot */}
                   <div className="flex items-center gap-0.5 shrink-0">
                     <button disabled={!isEditingDoc} onClick={(e) => { e.preventDefault(); setIsFullscreen(true); setShowAiChatPanel(true); }} className={cn("p-1.5 text-gray-700 hover:bg-indigo-50 hover:text-indigo-600 rounded disabled:opacity-50", showAiChatPanel && "bg-indigo-100 text-indigo-700")} title="Asistente IA"><Bot className="w-4 h-4" /></button>
                   </div>
                 </>
               )}
               {joditTab === 'Insert' && (
                 <div className="flex items-center gap-2">
                   <button disabled={!isEditingDoc} title="Insertar imagen" className="flex items-center gap-1.5 px-3 py-1.5 text-[13px] text-gray-700 hover:bg-gray-100 rounded border border-transparent hover:border-gray-200 disabled:opacity-50" onClick={() => imageInputRef.current?.click()}><Plus className="w-4 h-4" /> Imagen</button>
                   <button disabled={!isEditingDoc} title="Añadir comentario" className="flex items-center gap-1.5 px-3 py-1.5 text-[13px] text-gray-700 hover:bg-gray-100 rounded border border-transparent hover:border-gray-200 disabled:opacity-50" onClick={handleAddComment}><MessageSquarePlus className="w-4 h-4" /> Comentario</button>
                   <button disabled={!isEditingDoc} title="Insertar firma" className="flex items-center gap-1.5 px-3 py-1.5 text-[13px] text-gray-700 hover:bg-gray-100 rounded border border-transparent hover:border-gray-200 disabled:opacity-50" onClick={() => signatureInputRef.current?.click()}><Edit2 className="w-4 h-4" /> Firma</button>
                 </div>
               )}
             </fieldset>
           </div>
            
            {selectionBox && (
              <div 
                ref={selectionBoxRef}
                className="fixed z-[9999] bg-white border border-gray-200 shadow-xl rounded-lg w-max flex flex-col pointer-events-auto"
                style={{ top: selectionBox.top, left: selectionBox.left, boxShadow: '0 8px 16px -4px rgba(0, 0, 0, 0.15), 0 4px 6px -2px rgba(0, 0, 0, 0.05)' }}
                onMouseDown={e => e.stopPropagation()} 
              >
                {/* Floating Format Toolbar (Always visible) */}
                <div className="flex flex-col p-1.5 gap-1 bg-[#fdfdfd] rounded-t-lg">
                  <div className="flex items-center gap-1 border-b border-gray-100 pb-1">
                    <button onClick={() => execFormat('copy')} className="p-1 hover:bg-gray-100 rounded text-gray-700" title="Copiar"><div className="w-4 h-4 flex items-center justify-center font-serif text-[11px] font-bold">C</div></button>
                    <button onClick={() => execFormat('paste')} className="p-1 hover:bg-gray-100 rounded text-gray-700" title="Pegar"><div className="w-4 h-4 flex items-center justify-center font-serif text-[11px] font-bold">P</div></button>
                    <div className="w-px h-4 bg-gray-300 mx-0.5"></div>
                    <select onChange={e => execFormat('fontName', e.target.value)} className="text-[11px] border border-gray-300 rounded px-1.5 py-0.5 outline-none hover:border-gray-400 focus:border-blue-500 bg-transparent w-20 appearance-none cursor-pointer">
                      <option value="Arial">Arial</option>
                      <option value="Calibri">Calibri</option>
                      <option value="Times New Roman">Times New Roman</option>
                    </select>
                      <select onChange={e => execFormat('fontSize', e.target.value)} className="text-[11px] border border-gray-300 rounded px-1.5 py-0.5 outline-none hover:border-gray-400 focus:border-blue-500 bg-transparent w-12 appearance-none cursor-pointer">
                        <option value="8pt">8</option><option value="10pt">10</option><option value="12pt">12</option><option value="14pt">14</option><option value="18pt">18</option><option value="24pt">24</option><option value="36pt">36</option>
                    </select>
                  </div>
                  <div className="flex items-center gap-1 pt-0.5">
                    <button onMouseDown={e => { e.preventDefault(); execFormat('bold'); }} className="p-1 text-gray-700 hover:bg-gray-100 rounded font-bold" title="Negrita"><Bold className="w-3.5 h-3.5 stroke-[3]" /></button>
                    <button onMouseDown={e => { e.preventDefault(); execFormat('italic'); }} className="p-1 text-gray-700 hover:bg-gray-100 rounded italic" title="Cursiva"><Italic className="w-3.5 h-3.5" /></button>
                    <button onMouseDown={e => { e.preventDefault(); execFormat('underline'); }} className="p-1 text-gray-700 hover:bg-gray-100 rounded underline" title="Subrayado"><Underline className="w-3.5 h-3.5" /></button>
                    <div className="w-px h-4 bg-gray-300 mx-0.5"></div>
                    <button onMouseDown={e => { e.preventDefault(); execFormat('foreColor', '#2563eb'); }} className="p-1 pt-1 text-blue-700 hover:bg-gray-100 rounded flex flex-col items-center justify-center border-b-[2px] border-blue-600" title="Color de Texto (Azul)">
                      <span className="font-serif font-bold text-[11px] leading-none">A</span>
                    </button>
                    <button onMouseDown={e => { e.preventDefault(); execFormat('hiliteColor', 'yellow'); }} className="p-1 text-black hover:bg-gray-100 rounded flex flex-col items-center justify-center border-b-[2px] border-yellow-400" title="Color de Resalte (Amarillo)">
                      <Highlighter className="w-3.5 h-3.5" />
                    </button>
                    <div className="w-px h-4 bg-gray-300 mx-0.5"></div>
                    <button onClick={handleAddComment} className="p-1 hover:bg-gray-100 rounded text-gray-700" title="Añadir comentario"><MessageSquarePlus className="w-3.5 h-3.5" /></button>
                    <button onClick={() => setShowAiToolbar(!showAiToolbar)} className={cn("p-1 rounded text-indigo-600", showAiToolbar ? "bg-indigo-100" : "hover:bg-indigo-50")} title="Asistente IA"><Bot className="w-3.5 h-3.5" /></button>
                  </div>
                </div>

                {/* Extended AI Panel */}
                {showAiToolbar && (
                  <div className="p-3 w-[min(340px,95vw)] bg-gray-50 border-t border-gray-200 rounded-b-lg flex flex-col gap-2">
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-xs font-semibold text-gray-500 uppercase flex items-center gap-1"><Bot className="w-3 h-3" /> Asistente IA</span>
                      <button onClick={() => setShowAiToolbar(false)} className="text-gray-400 hover:text-gray-600 p-1"><X className="w-4 h-4"/></button>
                    </div>
                    <p className="text-xs text-gray-600 truncate border-l-2 border-blue-500 pl-2 py-0.5 bg-white shadow-sm italic">"{selectionBox.text}"</p>
                    <div className="flex gap-1 overflow-x-auto pb-1 mt-1 scrollbar-hide">
                       <button onClick={() => handleAiEdit("Haz esto más formal")} className="px-2 py-1 bg-white border border-gray-200 hover:border-blue-300 hover:bg-blue-50 text-gray-700 text-[11px] rounded-full whitespace-nowrap transition-colors">Más formal</button>
                       <button onClick={() => handleAiEdit("Resúmelo")} className="px-2 py-1 bg-white border border-gray-200 hover:border-blue-300 hover:bg-blue-50 text-gray-700 text-[11px] rounded-full whitespace-nowrap transition-colors">Resumir</button>
                       <button onClick={() => handleAiEdit("Corrige la redacción")} className="px-2 py-1 bg-white border border-gray-200 hover:border-blue-300 hover:bg-blue-50 text-gray-700 text-[11px] rounded-full whitespace-nowrap transition-colors">Corregir</button>
                    </div>
                    <textarea 
                      value={aiPrompt}
                      onChange={e => setAiPrompt(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          handleAiEdit();
                        }
                      }}
                      placeholder="Instrucción (ej. resúmelo)... (Enter para enviar)"
                      className="w-full text-xs p-2 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none bg-white shadow-inner"
                      rows={2}
                    />
                    <button 
                      onClick={() => handleAiEdit()}
                      disabled={isAiLoading || !aiPrompt.trim()}
                      className="w-full py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-xs font-medium flex items-center justify-center gap-2 disabled:opacity-50 transition-colors shadow-sm"
                      >
                       {isAiLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin"/> : <Send className="w-3.5 h-3.5"/>}
                       {isAiLoading ? 'Editando...' : 'Aplicar cambio'}
                    </button>
                  </div>
                )}
              </div>
            )}

            <div className="flex-1 overflow-hidden flex flex-row relative w-full">
             <div className="flex-1 overflow-auto bg-[#f3f2f1] flex flex-row items-start relative w-full" onMouseUp={handleMouseUp}>
               {isLoadingDoc ? (
                 <div className="flex w-full items-center justify-center gap-2 text-gray-500 mt-20"><Loader2 className="w-5 h-5 animate-spin" /> Procesando documento...</div>
              ) : (
                 <div className="flex flex-col lg:flex-row min-w-max sm:min-w-0 min-h-max py-4 sm:py-10 px-2 sm:px-4 mx-auto w-full sm:w-fit gap-6 lg:gap-10 items-start justify-center overflow-x-auto">
                   <div className="relative flex-shrink-0 transition-all bg-white shadow-md border border-gray-200 group box-border pointer-events-auto mx-auto origin-top" style={{ width: '100%', maxWidth: '21cm', minHeight: '29.7cm', zoom: zoomLevel / 100 }}>
                     <div ref={docxContainerRef} className="w-full h-full jodit-custom-container" style={{ padding: 0 }}>
                       <JoditEditor
                         value={docMetaHtml || ''}
                         config={joditConfig}
                         onBlur={newContent => setDocMetaHtml(newContent)}
                       />
                       <input type="file" ref={signatureInputRef} onChange={handleSignatureUpload} accept="image/*" className="hidden" aria-hidden="true" />
                       <input type="file" ref={imageInputRef} onChange={handleImageUpload} accept="image/*" className="hidden" aria-hidden="true" />
                     </div>
                     {docComments.map(c => {
                       const top = commentPositions[c.id];
                       if (top === undefined) return null;
                       const isActive = activeCommentId === c.id;
                       const unzoomedTop = top / (zoomLevel / 100);
                       return (
                         <div 
                           key={"icon-"+c.id} 
                           className="absolute cursor-pointer transition-all z-10 hover:scale-110" 
                           // Right offset calculation roughly aligned to margin
                           style={{ top: unzoomedTop + 8, right: '0.5cm', transform: 'translateY(-50%)' }} 
                           onClick={() => handleActivateComment(c.id)}
                         >
                           {c.resolved && !isActive ? (
                             <div className="relative text-green-600">
                               <MessageSquare className="w-5 h-5 opacity-80" />
                               <Check className="w-3 h-3 absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-[60%] stroke-[3]" />
                             </div>
                           ) : (
                             <MessageSquare className={cn("w-5 h-5", isActive ? "text-purple-600 fill-purple-100" : "text-gray-400 hover:text-purple-500 fill-white")} />
                           )}
                         </div>
                       );
                     })}
                   </div>
                   
                   {/* Comments Side Panel */}
                   {docComments.length > 0 && (() => {
                     const visibleComments = docComments.filter(c => !c.resolved || activeCommentId === c.id);
                     const sortedComments = [...visibleComments].sort((a,b) => (commentPositions[a.id] || 0) - (commentPositions[b.id] || 0));
                     let currentLayoutTop = 0;
                     const finalPositions: Record<string, number> = {};
                     
                     for (const c of sortedComments) {
                         const isActive = activeCommentId === c.id;
                         const isEditing = editingCommentId === c.id;
                         const estimatedHeight = isActive ? (isEditing ? 180 : 160) : 80;
                         const ideal = commentPositions[c.id] || 0;
                         const top = Math.max(ideal, currentLayoutTop);
                         finalPositions[c.id] = top;
                         currentLayoutTop = top + estimatedHeight + 16; // Add margin spacing
                     }
                     
                     return (
                         <div 
                           className="comments-side-panel relative w-full max-w-[280px] lg:w-72 flex-shrink-0 z-20 hidden lg:block"
                           onMouseUp={e => e.stopPropagation()}
                           onMouseDown={e => e.stopPropagation()}
                           onClick={e => e.stopPropagation()}
                         >
                            <div className="relative w-full h-full">
                               {visibleComments.map(c => {
                                  const isActive = activeCommentId === c.id;
                                  const top = finalPositions[c.id] || 0;
                                  
                                  return (
                                     <div 
                                        key={c.id} 
                                        style={{ position: 'absolute', top, left: 0, right: 0 }}
                                        className={cn("bg-white rounded border cursor-pointer transition-all flex flex-col items-center", isActive ? "border-purple-600 shadow-sm z-30" : "border-transparent bg-transparent z-10")} 
                                        onClick={() => handleActivateComment(c.id)}
                                     >
                               
                               {!isActive ? (
                                  <div className="w-full relative flex items-start gap-2 pt-2 px-1 hover:bg-gray-100 rounded group mt-1">
                                     <div className="w-6 h-6 rounded-full bg-gradient-to-tr from-purple-500 to-indigo-600 text-white flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5">
                                        {c.author.substring(0,2).toUpperCase()}
                                     </div>
                                     <div className="flex-1 w-full overflow-hidden">
                                        <div className="flex justify-between items-center w-full">
                                          <span className="font-semibold text-gray-800 text-sm">{c.author}</span>
                                          <MessageSquare className="w-3.5 h-3.5 text-gray-400 group-hover:text-gray-600 shrink-0" />
                                        </div>
                                        {c.text && <p className="text-gray-600 text-xs truncate mt-0.5">{c.text}</p>}
                                     </div>
                                  </div>
                               ) : c.resolved ? (
                                  <div className="p-3 w-full border border-gray-300 rounded bg-white shadow-sm text-gray-500">
                                    <div className="flex items-center justify-between border-b border-gray-200 pb-2 mb-2">
                                      <div className="flex items-center gap-1 text-gray-700">
                                        <Check className="w-4 h-4" />
                                        <span className="text-sm font-medium">Resuelto</span>
                                      </div>
                                      <div className="flex gap-2 items-center">
                                         <button 
                                            className="hover:bg-gray-100 rounded text-gray-600 p-0.5 transition" 
                                            title="Volver a abrir"
                                            onClick={(e) => {
                                               e.stopPropagation();
                                               setDocComments(docComments.map(dc => dc.id === c.id ? { ...dc, resolved: false } : dc));
                                            }}
                                         >
                                           <CornerUpLeft className="w-4 h-4" />
                                         </button>
                                         <button 
                                            className="hover:bg-gray-100 rounded text-gray-600 p-0.5 transition" 
                                            title="Eliminar"
                                            onClick={(e) => {
                                               e.stopPropagation();
                                               setDocComments(docComments.filter(dc => dc.id !== c.id));
                                               setActiveCommentId(null);
                                            }}
                                         >
                                           <Trash2 className="w-4 h-4" />
                                         </button>
                                      </div>
                                    </div>
                                    <div className="flex items-start gap-2 pt-1 opacity-80">
                                       <div className="w-6 h-6 rounded-full bg-gradient-to-tr from-gray-400 to-gray-500 text-white flex items-center justify-center text-[10px] font-bold shrink-0">
                                          {c.author.substring(0,2).toUpperCase()}
                                       </div>
                                       <div>
                                          <span className="font-semibold text-gray-800 text-sm block leading-tight">{c.author}</span>
                                          {c.text && <p className="text-sm text-gray-800 mt-1">{c.text}</p>}
                                       </div>
                                    </div>
                                    <span className="text-gray-500 text-[11px] block mt-1 ml-8 mb-1">{c.timestamp.toLocaleString('es', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                                    {c.replies.length > 0 && (
                                       <div className="ml-8 mt-2 space-y-2 pt-1 opacity-80">
                                          {c.replies.map((r, i) => (
                                              <div key={i}>
                                                 <div className="flex items-center gap-2 mb-0.5">
                                                    <span className="font-semibold text-gray-800 text-xs">Usuario</span>
                                                 </div>
                                                 <p className="text-[13px] text-gray-800">{r}</p>
                                              </div>
                                          ))}
                                       </div>
                                    )}
                                  </div>
                               ) : (
                                  <div className="p-3 w-full border border-purple-600 rounded bg-white shadow-sm">
                                    <div className="flex items-start justify-between gap-2 mb-1">
                                      <div className="flex items-center gap-2">
                                         <div className="w-6 h-6 rounded-full bg-gradient-to-tr from-purple-500 to-indigo-600 text-white flex items-center justify-center text-[10px] font-bold shrink-0">
                                            {c.author.substring(0,2).toUpperCase()}
                                         </div>
                                         <div>
                                            <span className="font-semibold text-gray-800 text-sm block leading-tight">{c.author}</span>
                                            {editingCommentId === c.id ? (
                                              <div className="mt-2 text-xs flex flex-col gap-2">
                                                <textarea
                                                  className="w-full p-2 border border-purple-500 rounded resize-none focus:outline-none"
                                                  rows={2}
                                                  value={editingCommentText}
                                                  onChange={e => setEditingCommentText(e.target.value)}
                                                  onClick={e => e.stopPropagation()}
                                                  autoFocus
                                                />
                                                <div className="flex gap-2 justify-end">
                                                  <button 
                                                    className="px-2 py-1 text-gray-500 hover:bg-gray-100 rounded"
                                                    onClick={(e) => { e.stopPropagation(); setEditingCommentId(null); }}
                                                  >
                                                    Cancelar
                                                  </button>
                                                  <button 
                                                    className="px-2 py-1 bg-purple-600 text-white rounded hover:bg-purple-700"
                                                    onClick={(e) => {
                                                       e.stopPropagation();
                                                       setDocComments(docComments.map(dc => dc.id === c.id ? { ...dc, text: editingCommentText } : dc));
                                                       setEditingCommentId(null);
                                                    }}
                                                  >
                                                    Guardar
                                                  </button>
                                                </div>
                                              </div>
                                            ) : (
                                              c.text && <p className="text-sm text-gray-800 mt-1">{c.text}</p>
                                            )}
                                         </div>
                                      </div>
                                      <div className="flex items-center gap-1 text-gray-500 mt-1">
                                         <div className="relative group">
                                           <button className="p-1 hover:bg-gray-100 rounded" title="Opciones"><MoreHorizontal className="w-4 h-4" /></button>
                                           <div className="absolute right-0 top-full hidden group-hover:block z-30">
                                             <div className="pt-1">
                                               <div className="bg-white border border-gray-200 shadow-md rounded w-32 py-1">
                                                  <button 
                                                    className="w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-100 flex items-center gap-2"
                                                    onClick={(e) => {
                                                       e.stopPropagation();
                                                       setDocComments(docComments.map(dc => dc.id === c.id ? { ...dc, resolved: true } : dc));
                                                       setActiveCommentId(null);
                                                    }}
                                                  >
                                                    <Check className="w-3.5 h-3.5" /> Resolver el hilo
                                                  </button>
                                                  <button 
                                                    className="w-full text-left px-3 py-1.5 text-xs text-red-600 hover:bg-gray-100 flex items-center gap-2"
                                                    onClick={(e) => {
                                                       e.stopPropagation();
                                                       setDocComments(docComments.filter(dc => dc.id !== c.id));
                                                    }}
                                                  >
                                                    <X className="w-3.5 h-3.5" /> Eliminar el hilo
                                                  </button>
                                               </div>
                                             </div>
                                           </div>
                                         </div>
                                         <button 
                                            className="p-1 hover:bg-gray-100 rounded" 
                                            title="Editar"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setEditingCommentText(c.text);
                                              setEditingCommentId(c.id);
                                            }}
                                         >
                                            <Edit2 className="w-4 h-4" />
                                         </button>
                                         <button 
                                            className={cn("p-1 rounded transition-colors", c.liked ? "bg-blue-50 text-blue-600" : "hover:bg-gray-100 text-gray-500")}
                                            title="Me gusta"
                                            onClick={(e) => {
                                               e.stopPropagation();
                                               setDocComments(docComments.map(dc => dc.id === c.id ? { ...dc, liked: !dc.liked } : dc));
                                            }}
                                         >
                                            <ThumbsUp className="w-4 h-4" />
                                         </button>
                                      </div>
                                    </div>
                                    
                                    <span className="text-gray-500 text-[11px] block mt-2 mb-3 ml-8">{c.timestamp.toLocaleString('es', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                                    
                                    {c.replies.map((r, i) => (
                                      <div key={i} className="mb-3 ml-8">
                                         <div className="flex items-center gap-2 mb-1">
                                            <span className="font-semibold text-gray-800 text-xs">Usuario</span>
                                         </div>
                                         <p className="text-sm text-gray-800">{r}</p>
                                      </div>
                                    ))}
                                    
                                    <div className="mt-2 text-xs ml-8 flex flex-col gap-2">
                                       <textarea
                                         className="w-full p-2 border border-gray-300 focus:outline-none focus:border-purple-600 transition-colors bg-white resize-none"
                                         rows={1}
                                         placeholder={c.text ? "Respuesta" : "Añadir un comentario"}
                                         value={newCommentText}
                                         onChange={e => setNewCommentText(e.target.value)}
                                         onClick={e => e.stopPropagation()}
                                         onKeyDown={e => {
                                            if (e.key === 'Enter' && !e.shiftKey) {
                                               e.preventDefault();
                                               if (!newCommentText.trim()) return;
                                               setDocComments(docComments.map(dc => {
                                                  if (dc.id === c.id) {
                                                     if (!dc.text) return { ...dc, text: newCommentText };
                                                     return { ...dc, replies: [...dc.replies, newCommentText] };
                                                  }
                                                  return dc;
                                               }));
                                               setNewCommentText("");
                                            }
                                         }}
                                       />
                                       <div className="flex justify-between items-center text-[10px] text-gray-500 w-full mt-1">
                                           <span>Sugerencia: Entrar para publicar.</span>
                                           <div className="flex gap-1 ml-auto">
                                             <button 
                                                onClick={(e) => {
                                                   e.stopPropagation();
                                                   if (!newCommentText.trim()) return;
                                                   setDocComments(docComments.map(dc => {
                                                      if (dc.id === c.id) {
                                                         if (!dc.text) return { ...dc, text: newCommentText };
                                                         return { ...dc, replies: [...dc.replies, newCommentText] };
                                                      }
                                                      return dc;
                                                   }));
                                                   setNewCommentText("");
                                                }}
                                                className="px-3 bg-blue-600 text-white rounded hover:bg-blue-700 shadow-sm flex items-center justify-center h-[24px]"
                                                title="Enviar"
                                             ><Send className="w-3 h-3 text-white" /></button>
                                             <button 
                                                onClick={(e) => {
                                                   e.stopPropagation();
                                                   if (!c.text) {
                                                      setDocComments(docComments.filter(dc => dc.id !== c.id));
                                                   } else {
                                                      setNewCommentText("");
                                                   }
                                                }}
                                                className="px-3 border border-gray-300 text-gray-600 rounded bg-white hover:bg-gray-100 shadow-sm flex items-center justify-center h-[24px]"
                                                title="Cancelar"
                                             ><X className="w-3.5 h-3.5" /></button>
                                           </div>
                                         </div>
                                    </div>
                                  </div>
                               )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                 })()}
                 </div>
              )}
           </div>

           {/* Chatbot Side Panel */}
           {showAiChatPanel && isEditingDoc && (
              <div className="w-full sm:w-[320px] flex-shrink-0 bg-white border-l shadow-[-4px_0_15px_-3px_rgba(0,0,0,0.1)] flex flex-col h-full absolute sm:sticky sm:top-0 right-0 z-50 transition-all">
                 <div className="bg-indigo-600 text-white p-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                       <Bot className="w-5 h-5 text-indigo-100" />
                       <span className="font-semibold text-sm">Asistente IA</span>
                    </div>
                    <button onClick={() => setShowAiChatPanel(false)} className="text-white hover:text-indigo-200"><X className="w-4 h-4"/></button>
                 </div>
                 <div className="flex-1 overflow-y-auto p-4 bg-gray-50 flex flex-col gap-3">
                    <div className="bg-white border text-sm text-gray-700 border-indigo-100 rounded-lg p-3 shadow-sm rounded-tl-none">
                       <p>Hola, ¿sobre qué parte del documento deseas hablar? Puedes preguntarme resúmenes, traducciones o pedirme cambios.</p>
                    </div>
                    {docChatHistory.map((msg, i) => (
                       <div key={i} className={cn("text-sm p-3 shadow-sm max-w-[95%]", 
                          msg.role === 'user' 
                            ? "bg-indigo-50 border border-indigo-100 text-indigo-900 rounded-lg rounded-tr-none self-end" 
                            : "bg-white border text-gray-800 border-gray-200 rounded-lg rounded-tl-none self-start"
                       )}>
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                       </div>
                    ))}
                    {isAiLoading && (
                       <div className="bg-white border border-gray-200 rounded-lg p-3 shadow-sm rounded-tl-none self-start flex items-center gap-2 text-sm text-gray-500">
                           <Loader2 className="w-4 h-4 animate-spin text-indigo-500" /> Escribiendo...
                       </div>
                    )}
                 </div>
                 <div className="p-3 bg-white border-t border-gray-200">
                     <div className="relative flex items-center">
                         <textarea
                            className="w-full pl-3 pr-10 py-2 bg-gray-50 border border-gray-300 rounded-xl text-sm outline-none focus:border-indigo-500 focus:bg-white transition-all resize-none h-[40px] overflow-hidden"
                            placeholder="Escribe tu mensaje..."
                            onKeyDown={async (e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    const text = e.currentTarget.value.trim();
                                    if (!text) return;
                                    e.currentTarget.value = "";
                                    
                                    const newUiHistory = [...docChatHistory, {role: 'user', content: text}];
                                    setDocChatHistory(newUiHistory);
                                    setIsAiLoading(true);
                                    
                                    try {
                                        let selectedText = "";
                                        if (docxContainerRef.current) {
                                           const wnd = window;
                                           if (wnd && wnd.getSelection) {
                                              selectedText = wnd.getSelection()?.toString() || "";
                                           }
                                        }

                                        const historyToSend = docChatHistory.map(m => ({role: m.role, content: m.content}));
                                        // The backend expects an array of messages of {role, content}.
                                        historyToSend.push({
                                            role: 'user',
                                            content: `Document HTML:\n---\n${docMetaHtml}\n---\nSelected Text: ${selectedText || 'None'}\n\nUser Message: ${text}`
                                        });

                                        const res = await axios.post("/api/ai/chat", {
                                            history: historyToSend
                                        });
                                        
                                        if (res.data.reply) {
                                            setDocChatHistory(prev => [...prev, {role: 'assistant', content: res.data.reply}]);
                                        }

                                        if (res.data.edits && Array.isArray(res.data.edits)) {
                                            let modifiedHtml = docMetaHtml;
                                            res.data.edits.forEach((edit: any) => {
                                                if (edit.original && edit.new !== undefined) {
                                                    modifiedHtml = modifiedHtml.split(edit.original).join(edit.new);
                                                }
                                            });
                                            if (modifiedHtml !== docMetaHtml) {
                                                setDocMetaHtml(modifiedHtml);
                                            }
                                        }
                                    } catch(err) {
                                        setDocChatHistory(prev => [...prev, {role: 'assistant', content: "Error al comunicarse con la IA."}]);
                                    } finally {
                                        setIsAiLoading(false);
                                    }
                                }
                            }}
                         />
                         <button title="Enviar" className="absolute right-2 text-indigo-600 hover:text-indigo-800 p-1 bg-indigo-50 rounded-full">
                            <MessageSquare className="w-3.5 h-3.5" />
                         </button>
                     </div>
                     <p className="text-[10px] text-gray-400 mt-2 text-center">Puedes seleccionar texto antes de preguntar o usar el ícono de Varita Mágica para editar el documento real.</p>
                 </div>
              </div>
           )}

           </div>
        </div>
      )
    }
    
    const handleExcelSave = async () => {
      if (!workbook || !previewFile) return;
      try {
        const buffer = await workbook.xlsx.writeBuffer();
        const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const file = new File([blob], previewFile.name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const formData = new FormData();
        formData.append("file", file);
        await api.post(`/sessions/${session.id}/workspace/files/upload`, formData);
        
        // No alert to make it transparent, or maybe a small toast or just nothing
      } catch (e) {
        console.error("Save excel failed", e);
      }
    };

    const getExcelContext = () => {
        if (!workbook) return '';
        let ctx = '';
        workbook.worksheets.forEach((ws: any) => {
            ctx += `Sheet: ${ws.name}\n`;
            const rowCount = ws.actualRowCount || 20;
            const colCount = ws.actualColumnCount || 10;
            for (let r=1; r<=rowCount; r++){
                let rowVals = [];
                const row = ws.getRow(r);
                for (let c=1; c<=colCount; c++){
                    const val = row.getCell(c).value;
                    rowVals.push(val !== null && val !== undefined ? String(val) : '');
                }
                if (rowVals.some(v => v !== '')) ctx += `Row ${r}: ` + rowVals.join(',') + '\n';
            }
            ctx += '\n';
        });
        return ctx;
    };

    if (isExcel) {
      return (
        <div className="flex flex-col h-full bg-gray-50 overflow-hidden relative">
          <div className="flex bg-white border-b border-gray-300 p-2 items-center justify-between shrink-0 h-10 shadow-sm relative z-20">
             <div className="flex items-center gap-2">
                 <span className="text-xs font-semibold text-gray-500">Editor Excel</span>
             </div>
             <div className="flex items-center gap-2">
               <button onClick={() => setShowAiChatPanel(prev => !prev)} className={cn("flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded transition-colors", showAiChatPanel ? "bg-indigo-100 text-indigo-700" : "bg-white border hover:bg-gray-50 text-gray-700")} title="Copiloto IA">
                   <Bot className="w-3.5 h-3.5" /> Copiloto IA
               </button>
               {!isFullscreen && (
                 <button onClick={() => setIsFullscreen(true)} className="p-1.5 transition-colors rounded text-gray-500 hover:text-gray-800 hover:bg-gray-200" title="Pantalla completa">
                     <Maximize className="w-4 h-4" />
                 </button>
               )}
             </div>
          </div>
          
           <div className="flex-1 flex overflow-hidden relative">
               <div className="flex-1 min-w-0 flex flex-col relative h-full">
                  {isLoadingDoc || !workbook ? (
                      <div className="flex items-center justify-center gap-2 text-gray-500 mt-20"><Loader2 className="w-5 h-5 animate-spin" /> Procesando hoja de cálculo...</div>
                  ) : (
                      <ExcelViewer workbook={workbook} onSave={handleExcelSave} fileName={previewFile.name} />
                  )}
               </div>

               {showAiChatPanel && (
                  <div className="w-full sm:w-[320px] flex-shrink-0 bg-white border-l shadow-[-4px_0_15px_-3px_rgba(0,0,0,0.1)] flex flex-col h-full right-0 z-50 transition-all z-[100]">
                      <div className="bg-indigo-600 text-white p-3 flex items-center justify-between">
                         <div className="flex items-center gap-2">
                            <Bot className="w-5 h-5 text-indigo-100" />
                            <span className="font-semibold text-sm">Copiloto IA Excel</span>
                         </div>
                         <button onClick={() => setShowAiChatPanel(false)} className="text-white hover:text-indigo-200"><X className="w-4 h-4"/></button>
                      </div>
                      <div className="flex-1 overflow-y-auto p-4 bg-gray-50 flex flex-col gap-3">
                         <div className="bg-white border text-sm text-gray-700 border-indigo-100 rounded-lg p-3 shadow-sm rounded-tl-none">
                            <p>¡Hola! Soy tu asistente de Excel. Puedo añadir filas, cambiar valores o estructurar tus hojas. ¡Pídeme lo que necesites!</p>
                         </div>
                         {docChatHistory.map((msg, i) => (
                            <div key={i} className={cn("text-sm p-3 shadow-sm max-w-[95%]", 
                               msg.role === 'user' 
                                 ? "bg-indigo-50 border border-indigo-100 text-indigo-900 rounded-lg rounded-tr-none self-end" 
                                 : "bg-white border text-gray-800 border-gray-200 rounded-lg rounded-tl-none self-start"
                            )}>
                               <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                            </div>
                         ))}
                         {isAiLoading && (
                            <div className="bg-white border border-gray-200 rounded-lg p-3 shadow-sm rounded-tl-none self-start flex items-center gap-2 text-sm text-gray-500">
                                <Loader2 className="w-4 h-4 animate-spin text-indigo-500" /> Calculando...
                            </div>
                         )}
                      </div>
                      <div className="p-3 bg-white border-t border-gray-200">
                          <div className="relative flex items-center">
                              <textarea
                                 className="w-full pl-3 pr-10 py-2 bg-gray-50 border border-gray-300 rounded-xl text-sm outline-none focus:border-indigo-500 focus:bg-white transition-all resize-none h-[40px] overflow-hidden"
                                 placeholder="E.g. Pon 'Total' en C1..."
                                 onKeyDown={async (e) => {
                                     if (e.key === 'Enter' && !e.shiftKey) {
                                         e.preventDefault();
                                         const text = e.currentTarget.value.trim();
                                         if (!text) return;
                                         e.currentTarget.value = "";
                                         
                                         const newUiHistory = [...docChatHistory, {role: 'user', content: text}];
                                         setDocChatHistory(newUiHistory);
                                         setIsAiLoading(true);
                                         
                                         try {
                                             const historyToSend = docChatHistory.map(m => ({role: m.role, content: m.content}));
                                             historyToSend.push({
                                                 role: 'user',
                                                 content: `Context:\n---\n${getExcelContext()}\n---\nUser Message: ${text}`
                                             });

                                             const res = await axios.post("/api/ai/chat", {
                                                 docType: "excel",
                                                 history: historyToSend
                                             });
                                             
                                             if (res.data.reply) {
                                                 setDocChatHistory(prev => [...prev, {role: 'assistant', content: res.data.reply}]);
                                             }

                                             if (res.data.edits && Array.isArray(res.data.edits)) {
                                                 let modified = false;
                                                 res.data.edits.forEach((edit: any) => {
                                                     if (edit.sheet && edit.row !== undefined && edit.col !== undefined && edit.value !== undefined) {
                                                         const ws = workbook.getWorksheet(edit.sheet);
                                                         if (ws) {
                                                             ws.getCell(edit.row, edit.col).value = edit.value;
                                                             modified = true;
}

function SpacesMainView({ spaces, sessions, activeSpaceId, onSelectSpace, onCreateSpace, onCreateSession, onSelectSession, isLeftSidebarOpen, onToggleSidebar }: any) {
  const [search, setSearch] = useState('');
  const selectedSpace = spaces.find((s: any) => s.id === activeSpaceId);
  const spaceThreads = sessions.filter((s: any) => s.spaceId === activeSpaceId);
  const [editingInstructions, setEditingInstructions] = useState<string | null>(null);
  const [instructionsText, setInstructionsText] = useState('');
  const [spaceInstructions, setSpaceInstructions] = useState<Record<string, string>>({});
  const [spaceFiles, setSpaceFiles] = useState<any[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (selectedSpace) {
      setInstructionsText(selectedSpace.instructions || spaceInstructions[selectedSpace.id] || '');
      loadSpaceFiles(selectedSpace.id);
    }
  }, [activeSpaceId, spaces]);

  const loadSpaceFiles = async (sid: string) => {
    try {
      const res = await axios.get(`/api/spaces/${sid}/files`);
      setSpaceFiles(Array.isArray(res.data) ? res.data : []);
    } catch { setSpaceFiles([]); }
  };

  const saveInstructions = async () => {
    if (!selectedSpace) return;
    try {
      const res = await axios.put(`/api/spaces/${selectedSpace.id}/instructions`, { instructions: instructionsText });
      const updated = res.data;
      setSpaceInstructions((prev: any) => ({ ...prev, [selectedSpace.id]: updated?.instructions || instructionsText }));
      setEditingInstructions(null);
    } catch(e: any) { alert("Error: " + (e.response?.data?.error || e.message)); }
  };

  const uploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedSpace) return;
    const fd = new FormData(); fd.append('file', file);
    try {
      await axios.post(`/api/spaces/${selectedSpace.id}/files/upload`, fd);
      loadSpaceFiles(selectedSpace.id);
    } catch(e: any) { alert("Error: " + e.message); }
    e.target.value = '';
  };

  const deleteFile = async (name: string) => {
    if (!selectedSpace) return;
    try {
      await axios.delete(`/api/spaces/${selectedSpace.id}/files/${name}`);
      loadSpaceFiles(selectedSpace.id);
    } catch(e: any) { alert("Error: " + e.message); }
  };

  if (!activeSpaceId) {
    // Spaces list view
    const filtered = spaces.filter((s: any) => !search || s.name.toLowerCase().includes(search.toLowerCase()));
    return (
      <main className="flex-1 flex flex-col min-w-0 bg-white z-10 w-full">
        <div className="p-6 md:p-10 max-w-4xl mx-auto w-full">
          <div className="flex items-center justify-between mb-8">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Espacios</h1>
              <p className="text-gray-500 text-sm mt-1">Gestiona tus proyectos y sus chats</p>
            </div>
            <div className="flex items-center gap-3">
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar espacios..." className="pl-9 pr-4 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-gray-400 w-56" />
              </div>
              <button onClick={onCreateSpace} className="px-4 py-2 bg-gray-900 text-white text-sm font-medium rounded-lg hover:bg-gray-800 transition-colors flex items-center gap-2">
                <Plus className="w-4 h-4" /> Nuevo espacio
              </button>
            </div>
          </div>
          
          {filtered.length === 0 ? (
            <div className="text-center py-20 text-gray-400">
              <Folder className="w-12 h-12 mx-auto mb-4 text-gray-200" />
              <p className="text-lg font-medium">No hay espacios aún</p>
              <p className="text-sm mt-1">Crea tu primer espacio para empezar</p>
            </div>
          ) : (
            <div className="border border-gray-200 rounded-xl overflow-hidden">
              <div className="grid grid-cols-12 gap-4 px-5 py-3 bg-gray-50 border-b border-gray-200 text-[11px] font-semibold text-gray-500 uppercase tracking-wider">
                <div className="col-span-5">Nombre</div>
                <div className="col-span-3">Visibilidad</div>
                <div className="col-span-4 text-right">Última modificación</div>
              </div>
              {filtered.map((s: any) => (
                <button key={s.id} onClick={() => onSelectSpace(s.id)} className="w-full grid grid-cols-12 gap-4 px-5 py-4 border-b border-gray-100 last:border-0 hover:bg-gray-50 transition-colors text-left">
                  <div className="col-span-5 flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-amber-50 flex items-center justify-center shrink-0">
                      <Folder className="w-4 h-4 text-amber-600" />
                    </div>
                    <span className="text-sm font-medium text-gray-800 truncate">{s.name}</span>
                  </div>
                  <div className="col-span-3 flex items-center gap-1.5 text-sm text-gray-500">
                    <span className="text-[10px]">🔒</span> Privado
                  </div>
                  <div className="col-span-4 text-right text-sm text-gray-400">
                    hace {Math.round((Date.now() - s.updatedAt) / 60000)} min
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </main>
    );
  }

  // Space detail view (threads + right panel)
  return (
    <main className="flex-1 flex flex-col min-w-0 bg-white z-10 w-full">
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 flex flex-col min-w-0">
          <div className="px-8 md:px-12 py-8 border-b border-gray-100">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center">
                <Folder className="w-5 h-5 text-amber-600" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-gray-900">{selectedSpace?.name || 'Espacio'}</h1>
                <p className="text-sm text-gray-500 mt-0.5">{selectedSpace?.instructions || 'Describe tu proyecto...'}</p>
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-8 md:px-12 py-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Threads</h2>
            </div>
            
            {spaceThreads.length === 0 ? (
              <div className="text-center py-20 text-gray-400">
                <p className="text-sm">Sin conversaciones aún</p>
              </div>
            ) : (
              <div className="space-y-2">
                {spaceThreads.map((t: any) => (
                  <button key={t.id} onClick={() => onSelectSession(t.id)} className="w-full text-left p-4 rounded-xl border border-gray-200 hover:border-gray-300 hover:bg-gray-50 transition-colors">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-gray-800">{t.name || 'Chat'}</span>
                      <span className="text-[10px] text-gray-400">{new Date(t.createdAt).toLocaleDateString()}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                      <div className={cn("w-1.5 h-1.5 rounded-full", t.status === 'running' ? 'bg-blue-500 animate-pulse' : 'bg-green-500')}></div>
                      <span className="text-[10px] uppercase text-gray-500">{t.status}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Floating input */}
          <div className="px-8 md:px-12 pb-6">
            <div className="relative border border-gray-200 rounded-2xl p-4 shadow-sm hover:border-gray-300 transition-colors">
              <button onClick={() => onCreateSession(activeSpaceId)} className="w-full text-left text-gray-400 text-sm">
                Inicia una tarea en {selectedSpace?.name || 'el espacio'}...
              </button>
              <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-2">
                <button onClick={() => fileInputRef.current?.click()} className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors">
                  <Plus className="w-4 h-4" />
                </button>
              </div>
              <input type="file" ref={fileInputRef} className="hidden" multiple onChange={uploadFile} />
            </div>
          </div>
        </div>

        {/* Right panel */}
        <div className="w-[300px] border-l border-gray-200 bg-gray-50/50 shrink-0 hidden lg:flex flex-col">
          <div className="p-4 border-b border-gray-200">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Instrucciones del espacio</h3>
            {editingInstructions !== null ? (
              <div className="space-y-2">
                <textarea value={instructionsText} onChange={e => setInstructionsText(e.target.value)} className="w-full p-3 border border-gray-300 rounded-lg text-sm resize-none focus:outline-none focus:border-gray-400 h-32" placeholder="Define cómo debe comportarse el agente en este espacio..." />
                <div className="flex gap-2">
                  <button onClick={saveInstructions} className="px-3 py-1.5 bg-gray-900 text-white text-xs rounded-lg hover:bg-gray-800">Guardar</button>
                  <button onClick={() => setEditingInstructions(null)} className="px-3 py-1.5 bg-white border text-xs rounded-lg hover:bg-gray-50">Cancelar</button>
                </div>
              </div>
            ) : (
              <div>
                <p className="text-sm text-gray-600 leading-relaxed">{instructionsText || 'Sin instrucciones definidas.'}</p>
                <button onClick={() => setEditingInstructions(activeSpaceId)} className="text-xs text-blue-600 hover:text-blue-800 mt-2">Editar instrucciones</button>
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Archivos</h3>
              <button onClick={() => fileInputRef.current?.click()} className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded">
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
            {spaceFiles.length === 0 ? (
              <p className="text-xs text-gray-400">Sin archivos compartidos</p>
            ) : (
              <div className="space-y-1">
                {spaceFiles.map((f: any) => (
                  <div key={f.name} className="flex items-center justify-between p-2 rounded-lg hover:bg-white group">
                    <span className="text-xs text-gray-700 truncate">{f.name}</span>
                    <button onClick={() => deleteFile(f.name)} className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 p-0.5">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
                                                     }
                                                 });
                                                 
                                                 if (modified) {
                                                     setWorkbook(Object.assign(Object.create(Object.getPrototypeOf(workbook)), workbook));
                                                     handleExcelSave();
                                                 }
                                             }
                                         } catch(err) {
                                             setDocChatHistory(prev => [...prev, {role: 'assistant', content: "Error de IA."}]);
                                         } finally {
                                             setIsAiLoading(false);
                                         }
                                     }
                                 }}
                              />
                              <button title="Enviar" className="absolute right-2 text-indigo-600 hover:text-indigo-800 p-1 bg-indigo-50 rounded-full">
                                 <MessageSquare className="w-3.5 h-3.5" />
                              </button>
                          </div>
                      </div>
                  </div>
               )}
           </div>
        </div>
      )
    }

    // For HTML dashboards (interactive, sandboxed)
    if (isDashboard) {
      return <DashboardViewer url={previewFile.url} updatedAt={previewFile.updatedAt} fileName={previewFile.name} />;
    }

    // For PDF and other formats (images, txt, etc.)
    return (
      <iframe src={previewFile.url} className="w-full h-full border-none bg-white" title={previewFile.name} />
    );
  };

  if (isFullscreen && previewFile) {
    return (
      <div className="fixed inset-0 z-50 bg-white flex flex-col">
        <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between bg-gray-50/80 backdrop-blur-sm shadow-sm z-30">
          <div className="flex items-center gap-3">
            <FileText className="w-5 h-5 text-blue-600" />
            <h2 className="text-lg font-semibold text-gray-800">{previewFile?.name?.endsWith('.doc.html') ? previewFile.name.replace('.doc.html', '.docx') : previewFile?.name}</h2>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => downloadFile(previewFile.name)} className="p-2 text-gray-500 hover:text-gray-800 hover:bg-gray-200 rounded-md transition-colors" title="Descargar">
              <Download className="w-5 h-5" />
            </button>
            {isEditingDoc && <button onClick={() => setShowFullscreenChat(!showFullscreenChat)} className={cn("p-2 rounded-md transition-colors flex items-center gap-2 text-sm font-medium", showFullscreenChat ? "bg-blue-100 text-blue-700" : "text-gray-500 hover:text-gray-800 hover:bg-gray-200")} title="Asistente IA">
              <Bot className="w-5 h-5" />
              <span className="hidden sm:inline">IA</span>
            </button>}
            <div className="w-px h-6 bg-gray-300 mx-1"></div>
            <button onClick={() => setIsFullscreen(false)} className="p-2 text-gray-500 hover:text-gray-800 hover:bg-gray-200 rounded-md transition-colors" title="Restaurar ventana">
              <Minimize className="w-5 h-5" />
            </button>
            <button onClick={closePreview} className="p-2 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors" title="Cerrar vista previa">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-hidden flex flex-row relative">
          <div className="flex-1 overflow-hidden relative">
            {renderPreviewContent()}
          </div>
          {showFullscreenChat && (
            <div className="w-[400px] flex-shrink-0 border-l border-gray-200 bg-white shadow-xl z-20 flex flex-col">
              <ChatArea session={session} onUpdate={onUpdate} onToggleFiles={() => {}} disablePolling={true} />
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
    {/* Mobile backdrop for right workspace sidebar */}
    <div className="fixed inset-0 bg-gray-900/50 z-30 md:hidden transition-opacity" onClick={onClose} />
    <aside className={cn("bg-gray-50 md:bg-gray-50/50 border-l border-gray-200 flex flex-col shrink-0 transition-all duration-300 absolute md:relative z-40 right-0 h-full", previewFile ? "w-full md:w-[45vw]" : "w-[85vw] sm:w-[280px] shadow-xl md:shadow-none")}>
      <div className="px-3 sm:px-5 py-4 border-b border-gray-200 flex items-center justify-between bg-white shadow-sm z-10">
        <div className="flex items-center gap-2 overflow-hidden">
          {previewFile ? (
             <div className="flex items-center gap-2 overflow-hidden">
                <button onClick={closePreview} className="p-1 -ml-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors shrink-0" title="Volver a la lista de archivos">
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-chevron-left"><path d="m15 18-6-6 6-6"/></svg>
                </button>
                <FileText className="w-4 h-4 text-blue-600 shrink-0" />
                <p className="text-sm font-semibold text-gray-800 truncate" title={previewFile.name.endsWith('.doc.html') ? previewFile.name.replace('.doc.html', '.docx') : previewFile.name}>{previewFile.name.endsWith('.doc.html') ? previewFile.name.replace('.doc.html', '.docx') : previewFile.name}</p>
             </div>
          ) : (
             <>
               <FileText className="w-4 h-4 text-blue-600 shrink-0" />
               <p className="text-sm font-semibold text-gray-800">Archivos</p>
             </>
          )}
        </div>
        
        <div className="flex items-center gap-1 shrink-0">
          {!previewFile && (
            <>
              <button onClick={() => fileInputRef.current?.click()} className="text-gray-400 hover:text-blue-600 p-1.5 hover:bg-blue-50 rounded-md transition-colors flex items-center gap-1" title="Subir archivo">
                <UploadCloud className="w-4 h-4" /> <span className="text-xs font-semibold hidden sm:inline-block">Subir</span>
              </button>
              <input type="file" ref={fileInputRef} className="hidden" accept=".docx,.txt,.xlsx,.pdf" onChange={handleFileUpload} />
              <button onClick={createNewDocx} className="text-gray-400 hover:text-green-600 p-1.5 hover:bg-green-50 rounded-md transition-colors flex items-center gap-1 mr-1" title="Nuevo documento DOCX">
                <Plus className="w-4 h-4" /> <span className="text-xs font-semibold hidden sm:inline-block">Nuevo Word</span>
              </button>
            </>
          )}
          {previewFile && (
            <button onClick={closePreview} className="text-gray-400 hover:text-red-600 p-1.5 hover:bg-red-50 rounded-md transition-colors ml-1" title="Cerrar Documento">
              <X className="w-4 h-4" />
            </button>
          )}
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1.5 hover:bg-gray-100 rounded-md transition-colors" title="Ocultar panel">
            <PanelRightClose className="w-4 h-4" />
          </button>
        </div>
      </div>
      
      {previewFile ? (
         <div className="flex-1 overflow-hidden relative bg-white">
           {renderPreviewContent()}
         </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-4 py-6">
          <div className="space-y-2">
            {!Array.isArray(files) || files.length === 0 ? (
              <div className="text-gray-400 text-sm text-center py-8">No hay archivos en el entorno.</div>
            ) : files.filter((f: any) => !f.name.endsWith('.comments.json') && !f.name.endsWith('.meta.html')).map((f: any, i) => {
              const displayName = f.name.endsWith('.doc.html') ? f.name.replace('.doc.html', '.docx') : f.name;
              return (
              <div key={i} className="flex items-center gap-3 p-3 bg-white border border-gray-200 rounded-lg shadow-sm text-sm group transition-all hover:shadow-md hover:border-blue-200">
                <div className={cn("w-8 h-8 rounded-md shrink-0 flex items-center justify-center", f.isDirectory ? "bg-amber-50 text-amber-600" : "bg-blue-50 text-blue-600")}>
                  <FileText className="w-4 h-4" />
                </div> 
                <span className="flex-1 truncate font-medium text-gray-700">{displayName}</span>
                {!f.isDirectory && (
                  <div className="flex gap-1 opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-all shrink-0">
                    <button 
                      onClick={() => viewFile(f.name)}
                      className="p-1.5 hover:bg-gray-100 rounded-md text-gray-500"
                      title={`Abrir ${displayName}`}
                    >
                      <Eye className="w-4 h-4" />
                    </button>
                    <button 
                      onClick={() => downloadFile(f.name)}
                      className="p-1.5 hover:bg-gray-100 rounded-md text-gray-500"
                      title={`Descargar ${displayName}`}
                    >
                      <Download className="w-4 h-4" />
                    </button>
                    <button 
                      onClick={() => renameFile(f.name)}
                      className="p-1.5 hover:bg-blue-50 rounded-md text-blue-500"
                      title={`Renombrar ${displayName}`}
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button 
                      onClick={() => deleteFile(f.name)}
                      className="p-1.5 hover:bg-red-50 rounded-md text-red-500"
                      title={`Eliminar ${displayName}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            )})}
          </div>
        </div>
      )}

      {promptConfig && promptConfig.isOpen && (
        <div className="fixed inset-0 bg-black/20 flex items-center justify-center z-[100]">
          <div className="bg-white rounded-xl shadow-xl w-80 p-5 space-y-4 border border-gray-200">
            <h3 className="text-lg font-semibold text-gray-800">
              {promptConfig.type === 'create' ? 'Nuevo archivo Word' : promptConfig.type === 'rename' ? 'Renombrar archivo' : 'Eliminar archivo'}
            </h3>
            {promptConfig.type !== 'delete' && (
              <input 
                type="text" 
                value={promptConfig.inputValue}
                onChange={e => setPromptConfig({...promptConfig, inputValue: e.target.value})}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoFocus
              />
            )}
            {promptConfig.type === 'delete' && (
              <p className="text-sm text-gray-600">¿Estás seguro que deseas eliminar {promptConfig.target}?</p>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setPromptConfig(null)} className="px-4 py-1.5 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 font-medium">Cancelar</button>
              <button onClick={handlePromptSubmit} className={cn("px-4 py-1.5 text-sm text-white rounded-lg font-medium", promptConfig.type === 'delete' ? 'bg-red-500 hover:bg-red-600' : 'bg-blue-600 hover:bg-blue-700')}>
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
    </>
  );
}

function ActionsPanel({ actions, isRunning, sessionStatus }: any) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (panelRef.current) {
      setTimeout(() => {
        if (panelRef.current) {
          panelRef.current.scrollTo({
            top: panelRef.current.scrollHeight,
            behavior: 'smooth'
          });
        }
      }, 50);
    }
  }, [actions.length, isRunning, actions]);

  return (
    <div ref={panelRef} className="bg-white border border-gray-100 rounded-2xl py-3 px-4 shadow-sm overflow-y-auto max-h-[400px] mt-1 space-y-2">
      <div className="relative pl-5 ml-2 border-l border-dashed border-gray-200 space-y-5 my-1">
          {actions.map((act: any) => {
          const info = getToolDisplay(act?.function?.name, act?.function?.arguments);
          const Icon = info.icon;
          
          return (
            <div key={act.id} className="flex flex-col gap-2 relative group mt-1 mb-1 opacity-75">
              <div className="absolute -left-[32px] bg-white py-1">
                  <div className="w-5 h-5 rounded-full border border-green-200 bg-green-50 flex items-center justify-center group-hover:border-green-300 transition-colors">
                    <Icon className="w-3 h-3 text-green-600 transition-colors" />
                  </div>
              </div>
              <div className="flex items-center gap-2 w-full pr-2">
                  <span className="text-[13px] font-semibold text-gray-700 whitespace-nowrap">{info.title}</span>
                  <span className="text-gray-300 shrink-0">|</span>
                  <span className="text-[13px] text-gray-500 truncate" title={info.detail}>{info.detail}</span>
              </div>
                {act.screenshotUrl && (
                <div className="mt-2 mb-3 rounded-lg border border-gray-200 overflow-hidden shadow-sm max-w-sm">
                  <img src={act.screenshotUrl} alt="Browser screenshot" className="w-full h-auto object-cover" />
                </div>
              )}
            </div>
          );
        })}

        {isRunning && sessionStatus !== 'waiting_human' && (
          <div className="flex gap-3 items-center relative">
              <div className="absolute -left-[32px] bg-white py-1">
                  <div className="w-5 h-5 rounded-full border border-blue-200 bg-blue-50 flex items-center justify-center">
                    <Loader2 className="w-3 h-3 text-blue-600 animate-spin" />
                  </div>
              </div>
              <span className="text-[13px] text-blue-600 font-medium animate-pulse">Trabajando...</span>
          </div>
        )}
      </div>
    </div>
  );
}

function ChatArea({ session, onUpdate, onToggleFiles, disablePolling }: { session: any, onUpdate: () => void, onToggleFiles?: () => void, disablePolling?: boolean }) {
  const [input, setInput] = useState('');
  const [isProcessingStep, setIsProcessingStep] = useState(false);
  const [optimisticMessage, setOptimisticMessage] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const isSubmittingRef = useRef(false);
  const chatFileInputRef = useRef<HTMLInputElement>(null);
  const genRef = useRef(0);

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    
    const validExtensions = ['.docx', '.txt', '.xlsx', '.pdf'];
    const lowerName = file.name.toLowerCase();
    if (!validExtensions.some(ext => lowerName.endsWith(ext))) {
       alert("Solo se admiten archivos .docx, .txt, .xlsx, .pdf");
       e.target.value = "";
       return;
    }
    
    try {
      const formData = new FormData();
      formData.append('file', file);
      
      await axios.post(`/api/sessions/${session.id}/workspace/files/upload`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      alert("Archivo adjuntado a la sesión con éxito.");
    } catch(err: any) {
      alert("Error subiendo archivo: " + err.message);
    } finally {
      e.target.value = "";
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [session.messages, isProcessingStep, optimisticMessage]);

  const sendMessage = async () => {
    if (!input.trim() || isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    const text = input;
    setInput('');
    
    // Quick optimistic visual
    setIsProcessingStep(true);
    setOptimisticMessage(text);
    const myGen = ++genRef.current;
    try {
      await api.post(`/sessions/${session.id}/message`, { content: text });
      await onUpdate();
      setOptimisticMessage('');
      
      isRequestingStepRef.current = true;
      api.post(`/sessions/${session.id}/step`)
      .catch(e => {
        alert("Error in step: " + (e.response?.data?.error || e.message));
      })
      .finally(() => {
         if (mountedRef.current && genRef.current === myGen) {
            isRequestingStepRef.current = false;
            setIsProcessingStep(false);
            isSubmittingRef.current = false;
            onUpdate();
         } else {
            isSubmittingRef.current = false;
         }
      });
      setTimeout(() => { if (mountedRef.current) onUpdate(); }, 500);
    } catch(e: any) {
      if (mountedRef.current) {
         setIsProcessingStep(false);
      }
      isSubmittingRef.current = false;
      alert("Error sending message: " + (e.response?.data?.error || e.message));
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleHumanResponse = async (toolCallId: string, response: string) => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setIsProcessingStep(true);
    const myGen = ++genRef.current;
    try {
      await api.post(`/sessions/${session.id}/message`, { 
        content: response,
        role: "tool",
        toolCallId
      });
      await onUpdate();

      isRequestingStepRef.current = true;
      api.post(`/sessions/${session.id}/step`)
      .catch((e: any) => {
        alert("Error in step: " + (e.response?.data?.error || e.message));
      })
      .finally(() => {
        if (mountedRef.current && genRef.current === myGen) {
          isRequestingStepRef.current = false;
          setIsProcessingStep(false);
          isSubmittingRef.current = false;
          onUpdate();
        } else {
          isSubmittingRef.current = false;
        }
      });
      setTimeout(() => { if (mountedRef.current) onUpdate(); }, 500);
    } catch (e: any) {
       if (mountedRef.current) setIsProcessingStep(false);
       isSubmittingRef.current = false;
       alert("Error sending human response: " + (e.response?.data?.error || e.message));
    }
  };

  const stopAgent = async () => {
    genRef.current++; // invalidate any pending step .finally() callbacks
    setIsProcessingStep(false);
    try {
      await api.post(`/sessions/${session.id}/stop`);
      await onUpdate();
    } catch (e: any) {}
  };

  const onUpdateRef = useRef(onUpdate);
  useEffect(() => {
    onUpdateRef.current = onUpdate;
  }, [onUpdate]);

  const isRequestingStepRef = useRef(false);

  useEffect(() => {
    if (disablePolling) return;
    
    if (session.status === 'running') {
      isRequestingStepRef.current = false;
    }
    let processInterval = setInterval(async () => {
      if (session.status === 'running') {
        onUpdateRef.current();
        // Automatically request the next step if we're running and not currently in a step
        if (!isRequestingStepRef.current) {
           isRequestingStepRef.current = true;
           try {
             const res = await api.post(`/sessions/${session.id}/step`);
             if (res.data && res.data.status === 'running') {
                isRequestingStepRef.current = false;
             }
             // If status is NOT running, we deliberately LEAVE isRequestingStepRef.current = true
             // to prevent any further intervals from firing until React re-renders and re-creates
             // this interval with the new session.status. This eliminates the infinite "de nada" loop.
           } catch(e: any) {
             isRequestingStepRef.current = false;
             console.error("Interval step execution failed:", e.response?.data?.error || e.message);
           }
           if (mountedRef.current) {
               onUpdateRef.current();
           }
        }
      }
    }, 5000); // Increased interval to 5 seconds to reduce load
    return () => clearInterval(processInterval);
  }, [session.status, session.id]);

  const stripReflection = (text: string) => {
    return text.replace(/<scratchpad>[\s\S]*?(?:<\/scratchpad>|$)/gi, '')
               .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
               .replace(/<Agent Reflection & Plan>[\s\S]*?(?:<\/Agent Reflection & Plan>|$)/gi, '')
               .replace(/```.*?<scratchpad>[\s\S]*?(?:<\/scratchpad>|$).*?```/gi, '')
               .replace(/Agent Reflection & Plan/gi, '')
               .replace(/```xml\s*```/gi, '')
               .trim();
  };

  const groupedTurns: any[] = [];
  let currentTurn: any = null;

  const uniqueMessages = React.useMemo(() => {
    const map = new Map();
    const result: any[] = [];
    let lastUserContent = null;
    
    (session.messages || []).forEach((msg: any) => {
      if (msg.id && !map.has(msg.id)) {
        map.set(msg.id, msg);
        
        // Skip exact duplicate consecutive user messages
        if (msg.role === 'user' && typeof msg.content === 'string') {
          if (msg.content === lastUserContent) {
            return; // skip
          }
          lastUserContent = msg.content;
        } else {
          lastUserContent = null;
        }
        
        result.push(msg);
      }
    });
    return result;
  }, [session.messages]);

  for (let i = 0; i < uniqueMessages.length; i++) {
    const msg = uniqueMessages[i];
    if (msg.role === 'system') continue;

    const isSystemScreenshotMsg = msg.role === 'user' && 
      Array.isArray(msg.content) && 
      msg.content.some((c: any) => c.text === "Here is the browser screenshot after the action:");

    if (msg.role === 'user' && !isSystemScreenshotMsg) {
      if (currentTurn) groupedTurns.push(currentTurn);
      currentTurn = { user: msg, actions: [], responses: [], interventions: [], tool_results: [] };
    } else if (msg.role === 'assistant') {
      if (!currentTurn) currentTurn = { user: null, actions: [], responses: [], interventions: [], tool_results: [] };
      
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        currentTurn.actions.push(...msg.tool_calls.map((tc: any) => ({ ...tc, screenshotUrl: null })));
      }
      
      if (msg.content && (!msg.tool_calls || msg.tool_calls.length === 0)) {
        if (typeof msg.content === 'string') {
          const stripped = stripReflection(msg.content);
          if (stripped) {
             currentTurn.responses.push({ ...msg, content: stripped });
          }
        } else if (Array.isArray(msg.content)) {
          const newContent = msg.content.map((c: any) => {
            if (c.type === 'text') return { ...c, text: stripReflection(c.text) };
            return c;
          }).filter((c: any) => c.type !== 'text' || c.text.length > 0);
          
          if (newContent.length > 0) {
            currentTurn.responses.push({ ...msg, content: newContent });
          }
        }
      }
    } else if (msg.role === 'tool') {
      if (!currentTurn) currentTurn = { user: null, actions: [], responses: [], interventions: [], tool_results: [] };
      if (msg.isHumanIntervention) {
         currentTurn.interventions.push(msg);
      }
      currentTurn.tool_results.push(msg);
    } else if (isSystemScreenshotMsg) {
      if (!currentTurn) currentTurn = { user: null, actions: [], responses: [], interventions: [], tool_results: [] };
      // Fallback: Just attach the screenshot to the last action in the current turn
      // regardless of whether the previous message was a tool message or not.
      if (currentTurn.actions.length > 0) {
        const action = currentTurn.actions[currentTurn.actions.length - 1];
        const imgProp = msg.content.find((c: any) => c.type === 'image_url');
        if (imgProp) {
          action.screenshotUrl = imgProp.image_url.url;
        }
      }
    }
  }
  if (currentTurn) groupedTurns.push(currentTurn);

  const isActuallyRunning = session.status === 'running' || isProcessingStep;

  return (
    <>
      <div className="flex-1 overflow-y-auto px-4 py-8 sm:px-8 bg-gray-50 flex flex-col items-center">
        <div className="w-full max-w-3xl flex flex-col space-y-8">
          
          {groupedTurns.length === 0 && !isActuallyRunning && (
             <div className="text-gray-400 text-sm text-center py-10">Envía un mensaje para comenzar la conversación.</div>
          )}
          
          {groupedTurns.length === 0 && isActuallyRunning && (
              <div className="flex w-full gap-4">
                <div className="w-8 h-8 mt-1 rounded-full bg-white border border-gray-200 flex items-center justify-center shrink-0 shadow-sm">
                  <Bot className="w-4 h-4 text-blue-600" />
                </div>
                <div className="flex flex-col gap-3 w-full max-w-[90%] sm:max-w-[85%] mt-2">
                   <div className="flex items-center gap-3 bg-white border border-gray-100 rounded-2xl py-3 px-5 shadow-sm w-fit">
                     <Loader2 className="w-4 h-4 text-blue-600 animate-spin" />
                     <span className="text-[14px] text-gray-600 font-medium animate-pulse">Iniciando agente...</span>
                   </div>
                </div>
               </div>
          )}

          {groupedTurns.map((turn, tIdx) => {
            return (
            <div key={tIdx} className="w-full space-y-6">
              {turn.user && (
                <div className="flex w-full gap-4 flex-row-reverse">
                  <div className="w-8 h-8 mt-1 rounded-full bg-blue-600 flex items-center justify-center shrink-0 shadow-sm">
                    <User className="w-4 h-4 text-white" />
                  </div>
                  <div className="flex flex-col gap-3 max-w-[90%] sm:max-w-[85%] items-end">
                    <div className="rounded-2xl rounded-tr-sm px-5 py-3 shadow-sm text-[15px] leading-relaxed bg-blue-600 text-white">
                      {typeof turn.user.content === 'string' ? (
                        turn.user.content
                      ) : (
                        <div className="flex flex-col gap-2">
                          {turn.user.content.map((c: any, i: number) => {
                            if (c.type === 'text') return <span key={i}>{c.text}</span>;
                            if (c.type === 'image_url') return <img key={i} src={c.image_url.url} alt="attachment" className="max-w-full rounded-md" />;
                            return null;
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Agent Actions & Responses */}
              {(turn.actions.length > 0 || turn.responses.length > 0 || turn.interventions.length > 0 || (isActuallyRunning && tIdx === groupedTurns.length - 1)) && (
                <div className="flex w-full gap-4">
                  <div className="w-8 h-8 mt-1 rounded-full bg-white border border-gray-200 flex items-center justify-center shrink-0 shadow-sm">
                    <Bot className="w-4 h-4 text-blue-600" />
                  </div>
                  <div className="flex flex-col gap-3 w-full max-w-[90%] sm:max-w-[85%]">
                     
                     {/* Actions Panel */}
                     { (turn.actions.length > 0 || (isActuallyRunning && tIdx === groupedTurns.length - 1 && session.status !== 'waiting_human')) && (
                       <ActionsPanel 
                          actions={turn.actions} 
                          isRunning={isActuallyRunning && tIdx === groupedTurns.length - 1} 
                          sessionStatus={session.status} 
                       />
                     )}

                     {/* Responses text */}
                     {turn.responses.map((msg: any) => {
                        // Extract UI tags for string contents
                        let textContent = '';
                        let hasFolder = false;
                        
                        if (typeof msg.content === 'string') {
                           textContent = msg.content;
                        } else if (Array.isArray(msg.content)) {
                           textContent = msg.content.map((c: any) => c.type === 'text' ? c.text : '').join('\n');
                        }

                        const folderRegex = /<ui-folder>/gi;
                        if (folderRegex.test(textContent)) {
                          hasFolder = true;
                          textContent = textContent.replace(folderRegex, '');
                        }

                        return (
                          <div key={msg.id} className="rounded-2xl rounded-tl-sm px-6 py-4 shadow-sm text-[15px] leading-relaxed bg-white border border-gray-200 text-gray-800 prose prose-sm max-w-none prose-p:my-1 prose-headings:font-bold prose-headings:text-gray-900 prose-a:text-blue-600 prose-pre:bg-gray-50 prose-pre:border prose-pre:border-gray-200 prose-pre:text-gray-800 break-words overflow-hidden [&_.markdown-body]:break-words [&_code]:break-all prose-table:w-full prose-table:border-collapse prose-th:border prose-th:border-gray-300 prose-th:bg-gray-50 prose-th:p-2 prose-td:border prose-td:border-gray-300 prose-td:p-2">
                              {typeof msg.content === 'string' ? (
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>{textContent}</ReactMarkdown>
                              ) : Array.isArray(msg.content) ? (
                                <div>
                                  {msg.content.map((c: any, idx: number) => {
                                    if (c.type === 'text') {
                                       let cText = c.text;
                                       cText = cText.replace(/<ui-folder>/gi, '');
                                       return <ReactMarkdown key={idx} remarkPlugins={[remarkGfm]}>{cText}</ReactMarkdown>;
                                    }
                                    if (c.type === 'image_url') return <img key={idx} src={c.image_url.url} alt="attachment" className="max-w-full my-2 rounded-xl border border-gray-200" />;
                                    return null;
                                  })}
                                </div>
                              ) : null}

                              {hasFolder && (
                                <div className="mt-4 flex flex-wrap gap-2 not-prose">
                                    <button 
                                      onClick={onToggleFiles} 
                                      className="flex items-center gap-2 px-3 py-1.5 bg-blue-50 text-blue-700 text-sm font-medium rounded-lg hover:bg-blue-100 transition-colors shadow-sm"
                                    >
                                      <Folder className="w-4 h-4"/> 
                                      Abrir Carpeta de Archivos
                                    </button>
                                </div>
                              )}
                          </div>
                        );
                     })}

                     {/* Interventions */}
                     {turn.interventions.map((msg: any) => (
                         <div key={msg.id} className="w-full bg-orange-50 border border-orange-200 rounded-2xl p-5 shadow-sm mt-2">
                            <div className="flex items-center gap-2 mb-4 text-orange-800 font-medium text-sm">
                              <Settings className="w-4 h-4" />
                              Acción requiere aprobación manual
                            </div>
                            <div className="flex gap-3">
                              <button 
                                onClick={() => handleHumanResponse(msg.tool_call_id, "Aprobar y continuar")}
                                className="flex-1 bg-orange-500 text-white font-medium text-sm py-2 px-4 rounded-xl hover:bg-orange-600 transition-colors shadow-sm"
                              >
                                Aprobar
                              </button>
                              <button 
                                onClick={() => handleHumanResponse(msg.tool_call_id, "Abortar")}
                                className="flex-1 bg-white text-gray-700 font-medium text-sm py-2 px-4 rounded-xl border border-gray-200 hover:bg-gray-50 transition-colors"
                              >
                                Cancelar
                              </button>
                            </div>
                        </div>
                     ))}
                  </div>
                </div>
              )}
            </div>
          );
          })}

          {/* First loading step fallback */}
          {isActuallyRunning && groupedTurns.length === 0 && session.status !== 'waiting_human' && (
            <div className="flex w-full gap-4">
              <div className="w-8 h-8 mt-1 rounded-full bg-white border border-gray-200 flex items-center justify-center shrink-0 shadow-sm">
                <Bot className="w-4 h-4 text-blue-600" />
              </div>
              <div className="flex flex-col gap-3 w-full max-w-[85%]">
                <div className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm overflow-y-auto max-h-[400px] mt-1 space-y-2">
                  <div className="relative pl-5 ml-2 border-l border-dashed border-gray-200 space-y-4">
                    <div className="flex gap-3 items-center relative">
                        <div className="absolute -left-[32px] bg-white py-1">
                            <div className="w-5 h-5 rounded-full border border-blue-200 bg-blue-50 flex items-center justify-center">
                              <Loader2 className="w-3 h-3 text-blue-600 animate-spin" />
                            </div>
                        </div>
                        <span className="text-[13px] text-blue-600 font-medium animate-pulse">Iniciando servicio...</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {optimisticMessage && (
            <div className="w-full space-y-6">
              <div className="flex w-full gap-4 flex-row-reverse opacity-70">
                <div className="w-8 h-8 mt-1 rounded-full bg-blue-600 flex items-center justify-center shrink-0 shadow-sm">
                  <User className="w-4 h-4 text-white" />
                </div>
                <div className="flex flex-col gap-3 max-w-[90%] sm:max-w-[85%] items-end">
                  <div className="rounded-2xl rounded-tr-sm px-5 py-3 shadow-sm text-[15px] leading-relaxed bg-blue-600 text-white">
                    {optimisticMessage}
                  </div>
                </div>
              </div>
            </div>
          )}

          <div ref={bottomRef} className="h-4" />
        </div>
      </div>

      {/* Input Area */}
      <div className="bg-white border-t border-gray-200 px-2 pt-2 pb-4 sm:p-4 shrink-0 z-20">
        <div className="max-w-3xl mx-auto relative flex items-end gap-2 sm:gap-3 rounded-2xl bg-gray-50 border border-gray-300 focus-within:border-blue-500 focus-within:ring-4 focus-within:ring-blue-500/10 transition-all p-1 sm:p-1.5 shadow-sm">
          <button
            onClick={() => chatFileInputRef.current?.click()}
            className="w-10 h-10 shrink-0 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-xl flex items-center justify-center transition-all mb-0.5"
            title="Adjuntar archivo"
          >
            <Paperclip className="w-5 h-5" />
          </button>
          <input type="file" ref={chatFileInputRef} className="hidden" accept=".docx,.txt,.xlsx,.pdf" onChange={handleFileUpload} />
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Escribe un mensaje al asistente..."
            className="w-full bg-transparent text-gray-900 text-[14px] sm:text-[15px] p-2 sm:p-3 min-h-[48px] max-h-40 outline-none resize-none placeholder:text-gray-400"
            rows={1}
            disabled={isProcessingStep || session.status === 'waiting_human'}
          />
          {isActuallyRunning ? (
            <button
              onClick={stopAgent}
              className="h-10 px-3 sm:px-4 shrink-0 bg-red-100 hover:bg-red-200 text-red-700 font-semibold rounded-xl flex items-center justify-center transition-colors mb-0.5"
            >
              <span className="hidden sm:inline">Detener</span>
              <X className="w-5 h-5 sm:hidden" />
            </button>
          ) : (
            <button
              onClick={sendMessage}
              disabled={!input.trim() || session.status === 'waiting_human'}
              className="w-10 h-10 shrink-0 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:bg-gray-300 text-white rounded-xl flex items-center justify-center transition-all mb-0.5 shadow-sm"
            >
              <Send className="w-4 h-4 ml-0.5" />
            </button>
          )}
        </div>
      </div>
    </>
  );
}
