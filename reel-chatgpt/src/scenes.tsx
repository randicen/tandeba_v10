import { motion } from "motion/react";
import { useState, useEffect } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Easings — copia del lenguaje de motion de la skill `animation` V1.1
// ─────────────────────────────────────────────────────────────────────────────
const easeEnter: [number, number, number, number]  = [0.16, 1, 0.3, 1];
const easeCross: [number, number, number, number]  = [0.25, 0.46, 0.45, 0.94];
const easePop:   [number, number, number, number]  = [0.34, 1.56, 0.64, 1];

// ─────────────────────────────────────────────────────────────────────────────
// Inline SVG icons (no lucide-react dep). Tamaños w-/h- via className del padre.
// ─────────────────────────────────────────────────────────────────────────────
type IconProps = { className?: string; strokeWidth?: number };
const ic = (paths: string, fill = "none", viewBox = "0 0 24 24") =>
  ({ className, strokeWidth = 2 }: IconProps) => (
    <svg
      className={className}
      viewBox={viewBox}
      fill={fill}
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      // La skill exige currentColor para que las clases de Tailwind pinten el icono
      dangerouslySetInnerHTML={{ __html: paths }}
    />
  );

// Lucide-style icon paths
const PATHS = {
  folder:    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  fileText:  '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/><line x1="10" x2="8" y1="9" y2="9"/>',
  file:      '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  search:    '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  plus:      '<path d="M5 12h14"/><path d="M12 5v14"/>',
  mic:       '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>',
  send:      '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  chevDown:  '<path d="m6 9 6 6 6-6"/>',
  chevRight: '<path d="m9 18 6-6-6-6"/>',
  activity:  '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  user:      '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  globe:     '<circle cx="12" cy="12" r="10"/><line x1="2" x2="22" y1="12" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  terminal:  '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  bot:       '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  download:  '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  check:     '<polyline points="20 6 9 17 4 12"/>',
  sparkles:  '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
  refresh:   '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
  eye:       '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  x:         '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  more:      '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
};

const I = {
  folder:    ic(PATHS.folder),
  fileText:  ic(PATHS.fileText),
  file:      ic(PATHS.file),
  search:    ic(PATHS.search),
  plus:      ic(PATHS.plus),
  mic:       ic(PATHS.mic),
  send:      ic(PATHS.send),
  chevDown:  ic(PATHS.chevDown),
  chevRight: ic(PATHS.chevRight),
  activity:  ic(PATHS.activity),
  user:      ic(PATHS.user),
  globe:     ic(PATHS.globe),
  terminal:  ic(PATHS.terminal),
  bot:       ic(PATHS.bot),
  download:  ic(PATHS.download),
  check:     ic(PATHS.check),
  sparkles:  ic(PATHS.sparkles),
  refresh:   ic(PATHS.refresh),
  eye:       ic(PATHS.eye),
  x:         ic(PATHS.x),
  more:      ic(PATHS.more),
};

// ─────────────────────────────────────────────────────────────────────────────
// Datos reales — extraídos de /recursos/documentos/ (Worgena: jurisprudencia
// ambiental y minera colombiana, lote de Tabular Review).
// ─────────────────────────────────────────────────────────────────────────────
type Doc = { name: string; size: string; type: "PDF" | "DOCX" };

const SENTENCIAS: Doc[] = [
  { name: "T-622 de 2016 · Río Atrato",                    size: "847 KB", type: "PDF"  },
  { name: "SU-133 de 2017 · Derechos mineros",             size: "1.2 MB", type: "PDF"  },
  { name: "T-106 de 2025 · Explotación ilícita de oro",    size: "692 KB", type: "PDF"  },
  { name: "C-035 de 2016 · Reserva minera",                size: "543 KB", type: "PDF"  },
  { name: "T-445 de 2016 · Consultas mineras",             size: "488 KB", type: "DOCX" },
  { name: "T-361 de 2017 · Páramos",                       size: "721 KB", type: "PDF"  },
  { name: "C-259 de 2016 · Minería ilegal",                size: "612 KB", type: "DOCX" },
  { name: "C-389 de 2016 · Normas ambientales",            size: "498 KB", type: "DOCX" },
  { name: "CE 2022 · Río Las Ánimas",                      size: "1.4 MB", type: "PDF"  },
  { name: "CE 2022 · Títulos mineros (Rad. 2013-02459)",   size: "892 KB", type: "PDF"  },
  { name: "CE 2017 · Concesiones mineras Tolima",          size: "1.1 MB", type: "PDF"  },
  { name: "TAA 2017 · Daño ambiental inmuebles",           size: "763 KB", type: "DOCX" },
  { name: "CE 2015 · Maquinaria pesada",                   size: "521 KB", type: "DOCX" },
  { name: "CE 2017 · Quebrada La Cianurada",               size: "688 KB", type: "PDF"  },
];

// Tabla comparativa — la que se construye en la escena 3 y se ve en la 4
type Row = {
  id: string;
  code: string;
  topic: string;
  thesis: string;
  outcome: string;
  article: string;
};

const TABLE: Row[] = [
  { id: "1", code: "T-622/16",  topic: "Río Atrato",        thesis: "Río como sujeto de derechos",                  outcome: "Tutela concedida",  article: "CP arts. 7, 8, 79" },
  { id: "2", code: "SU-133/17", topic: "Cesión minera",     thesis: "Consulta previa en cesión de títulos",         outcome: "Nulidad",          article: "CP art. 330"      },
  { id: "3", code: "T-106/25",  topic: "Oro ilícito",       thesis: "Prohibición en zona protegida",                outcome: "Tutela concedida",  article: "Ley 1658/13"      },
  { id: "4", code: "C-035/16",  topic: "Reserva minera",    thesis: "Exclusión de áreas de reserva especial",       outcome: "Exequibilidad",    article: "Ley 1382/10"      },
  { id: "5", code: "T-445/16",  topic: "Consulta popular",  thesis: "Vinculatoriedad de la consulta antiminería",   outcome: "Tutela concedida",  article: "Ley 1341/09"      },
  { id: "6", code: "T-361/17",  topic: "Páramos",           thesis: "Prohibición minería en ecosistemas de páramo",  outcome: "Tutela concedida",  article: "Ley 1450/11"      },
];

// ─────────────────────────────────────────────────────────────────────────────
// Reusable primitives — pequeñísimos, sin estado
// ─────────────────────────────────────────────────────────────────────────────

/** File-icon tinteado (PDF rojo, DOCX azul) — el estilo de la Worgena Vault */
function FileTypeBadge({ type, className = "" }: { type: "PDF" | "DOCX"; className?: string }) {
  const isPDF = type === "PDF";
  return (
    <div className={`flex flex-col items-center justify-center w-7 h-8 rounded-[3px] flex-shrink-0 ${
      isPDF ? "bg-red-50 text-red-600" : "bg-blue-50 text-blue-600"
    } ${className}`}>
      <I.fileText className="w-3.5 h-3.5" strokeWidth={2.25} />
      <span className="text-[5.5px] font-bold tracking-tight leading-none mt-0.5">
        {type}
      </span>
    </div>
  );
}

/** Etiqueta de tamaño + tipo, como en la Worgena sidebar */
function MetaText({ children }: { children: React.ReactNode }) {
  return <span className="text-[9px] text-gray-500 tabular-nums">{children}</span>;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENE 1 — Bóveda: lista real de sentencias colombianas
// ─────────────────────────────────────────────────────────────────────────────
export function BovedasScene({ active }: { active: boolean }) {
  return (
    <div className="absolute inset-0 flex flex-col">
      {/* App header — pegado a la estética Worgena: gris-50, borde inferior sutil */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 bg-white">
        <div className="flex items-center gap-1.5 min-w-0">
          <I.folder className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
          <span className="text-[10.5px] font-semibold text-gray-900 truncate">
            Bóveda · Colombia
          </span>
          <span className="text-[9px] text-gray-400">/ sentencias</span>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <MetaText>14 docs</MetaText>
          <div className="w-px h-3 bg-gray-200" />
          <MetaText>11.2 MB</MetaText>
        </div>
      </div>

      {/* Filter pills — réplica del ribbon de la Worgena VaultsView */}
      <div className="flex items-center gap-1 px-2.5 py-1.5 bg-gray-50 border-b border-gray-100">
        {["Todos", "PDF", "DOCX", "Fijados"].map((f, i) => (
          <span
            key={f}
            className={`text-[8.5px] font-medium px-1.5 py-0.5 rounded-full ${
              i === 0
                ? "bg-gray-900 text-white"
                : "bg-white text-gray-600 border border-gray-200"
            }`}
          >
            {f}
          </span>
        ))}
      </div>

      {/* Lista — los 14 documentos reales */}
      <div className="flex-1 overflow-hidden bg-white">
        {SENTENCIAS.map((doc, i) => (
          <motion.div
            key={doc.name}
            className="flex items-center gap-2 px-2.5 py-1.5 border-b border-gray-100 last:border-b-0"
            initial={{ opacity: 0, x: -8 }}
            animate={active ? { opacity: 1, x: 0 } : {}}
            transition={{ duration: 0.35, delay: i * 0.06, ease: easeEnter }}
          >
            <FileTypeBadge type={doc.type} />
            <span className="flex-1 min-w-0 text-[10px] text-gray-800 truncate font-medium">
              {doc.name}
            </span>
            <MetaText>{doc.size}</MetaText>
          </motion.div>
        ))}
      </div>

      {/* Footer — replicando la franja de "seleccionados para tabular review" */}
      <div className="flex items-center justify-between px-2.5 py-1.5 bg-gray-50 border-t border-gray-200">
        <span className="text-[9px] text-gray-500">
          <span className="font-bold text-gray-900">14</span> seleccionados
        </span>
        <motion.div
          className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-gray-900 text-white"
          initial={{ opacity: 0, scale: 0.9 }}
          animate={active ? { opacity: 1, scale: 1 } : {}}
          transition={{ duration: 0.4, delay: 1.0, ease: easePop }}
        >
          <I.sparkles className="w-2.5 h-2.5" strokeWidth={2.5} />
          <span className="text-[8.5px] font-semibold tracking-wide">Tabular Review</span>
        </motion.div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENE 2 — Prompt: WelcomeScreen real con el composer del usuario
// ─────────────────────────────────────────────────────────────────────────────
export function PromptScene({ active }: { active: boolean }) {
  const fullPrompt = "Compara las 14 sentencias en una grilla con tesis, artículo citado y resultado. Exporta a DOCX.";
  const [typed, setTyped] = useState("");

  // Typewriter cuando la escena se monta
  useEffect(() => {
    if (!active) { setTyped(""); return; }
    let i = 0;
    const id = window.setInterval(() => {
      i++;
      setTyped(fullPrompt.slice(0, i));
      if (i >= fullPrompt.length) window.clearInterval(id);
    }, 28);
    return () => window.clearInterval(id);
  }, [active]);

  return (
    <div className="absolute inset-0 flex flex-col bg-white">
      {/* Top bar — réplica del WelcomeScreen: Monitor interno · Monitor externo · Guías · Programadas */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-100 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            <I.activity className="w-3 h-3 text-gray-600" />
            <span className="text-[9px] text-gray-600 font-medium">Monitor interno</span>
            <span className="w-1.5 h-1.5 rounded-full bg-blue-500 ml-0.5" />
          </div>
          <div className="flex items-center gap-1">
            <I.globe className="w-3 h-3 text-gray-600" />
            <span className="text-[9px] text-gray-600 font-medium">Monitor externo</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[8.5px] text-gray-600 font-medium">Guías</span>
          <div className="flex items-center gap-0.5 px-1.5 py-0.5 border border-gray-200 rounded">
            <span className="text-[8.5px] text-gray-700 font-medium">Programadas</span>
            <I.chevDown className="w-2.5 h-2.5 text-gray-500" />
          </div>
        </div>
      </div>

      {/* Body — saludo + composer */}
      <div className="flex-1 flex flex-col items-center justify-center px-4">
        <motion.h1
          className="text-[18px] sm:text-[20px] font-semibold text-gray-900 mb-4 text-center"
          initial={{ opacity: 0, y: 8 }}
          animate={active ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.5, ease: easeEnter }}
        >
          Buenos días, doctor Juan
        </motion.h1>

        {/* PromptComposer real — el de Worgena: input + add + send + mic + mode */}
        <motion.div
          className="w-full bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden"
          initial={{ opacity: 0, y: 12, scale: 0.97 }}
          animate={active ? { opacity: 1, y: 0, scale: 1 } : {}}
          transition={{ duration: 0.6, delay: 0.15, ease: easeEnter }}
        >
          {/* Textarea con typewriter */}
          <div className="px-3 py-2.5 min-h-[58px] flex items-start">
            <div className="flex-1 text-[11.5px] text-gray-900 leading-snug font-medium">
              {typed}
              <motion.span
                className="inline-block w-[1.5px] h-3 bg-gray-900 ml-0.5 align-middle"
                animate={{ opacity: [1, 0] }}
                transition={{ duration: 0.6, repeat: Infinity, ease: "easeInOut" }}
              />
            </div>
          </div>

          {/* Toolbar inferior del composer */}
          <div className="flex items-center justify-between px-2 py-1.5 border-t border-gray-100 bg-gray-50/50">
            <div className="flex items-center gap-1.5">
              {/* `+` adjuntar */}
              <div className="w-5 h-5 rounded-full border border-gray-300 flex items-center justify-center">
                <I.plus className="w-3 h-3 text-gray-700" strokeWidth={2.5} />
              </div>
              {/* Búsqueda — el icono del @ source */}
              <div className="flex items-center gap-1 px-1.5 py-0.5 bg-white border border-gray-200 rounded-md">
                <I.search className="w-3 h-3 text-gray-500" />
                <span className="text-[9px] text-gray-700 font-medium">Búsqueda</span>
                <I.chevDown className="w-2.5 h-2.5 text-gray-400" />
              </div>
              {/* Mode toggle Fast / Pro — copy exacto del WelcomeScreen */}
              <div className="flex items-center bg-white border border-gray-200 rounded-md overflow-hidden">
                <span className="text-[8.5px] font-bold text-gray-900 px-1.5 py-0.5 bg-gray-100">
                  Fast
                </span>
                <span className="text-[8.5px] font-medium text-gray-500 px-1.5 py-0.5">
                  Pro
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <I.mic className="w-3.5 h-3.5 text-gray-500" />
              {/* Send — circular Worgena brand button */}
              <div className="w-6 h-6 rounded-full bg-gray-900 flex items-center justify-center">
                <I.send className="w-3 h-3 text-white" />
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENE 3 — Procesando: chat con tool calls reales (getToolDisplay de App.tsx)
// ─────────────────────────────────────────────────────────────────────────────
type ToolCall = {
  id: string;
  name: string;
  icon: React.ComponentType<IconProps>;
  title: string;
  detail: string;
  status: "running" | "done";
};

const TOOL_CALLS: ToolCall[] = [
  { id: "t1", name: "read_file",         icon: I.fileText,  title: "Lectura de archivos",   detail: "Leyendo: T-622/16 · Río Atrato",                status: "done"    },
  { id: "t2", name: "read_file",         icon: I.fileText,  title: "Lectura de archivos",   detail: "Leyendo: SU-133/17 · Derechos mineros",         status: "done"    },
  { id: "t3", name: "read_file",         icon: I.fileText,  title: "Lectura de archivos",   detail: "Leyendo: T-106/25 · Oro ilícito",               status: "done"    },
  { id: "t4", name: "write_file",        icon: I.fileText,  title: "Creador de Archivos",   detail: "Escribiendo: tabla_sentencias_2025.docx",      status: "done"    },
  { id: "t5", name: "ai_document_editor",icon: I.bot,       title: "Editor IA",             detail: "Reescribiendo documento con IA",                status: "running" },
];

function ToolCallCard({ call, delay }: { call: ToolCall; delay: number }) {
  const Icon = call.icon;
  return (
    <motion.div
      className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-white border border-gray-200 shadow-sm"
      initial={{ opacity: 0, y: 8, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.4, delay, ease: easeEnter }}
    >
      {/* Icono circular — el estilo "tool chip" de Worgena */}
      <div className="w-6 h-6 rounded-md bg-gray-100 flex items-center justify-center flex-shrink-0">
        <Icon className="w-3.5 h-3.5 text-gray-700" strokeWidth={2.25} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[9.5px] font-semibold text-gray-900 leading-tight">{call.title}</div>
        <div className="text-[8.5px] text-gray-500 truncate leading-tight mt-0.5">{call.detail}</div>
      </div>
      {call.status === "running" ? (
        <motion.div
          className="w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full flex-shrink-0"
          animate={{ rotate: 360 }}
          transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
        />
      ) : (
        <div className="w-3 h-3 rounded-full bg-emerald-100 flex items-center justify-center flex-shrink-0">
          <I.check className="w-2 h-2 text-emerald-600" strokeWidth={3.5} />
        </div>
      )}
    </motion.div>
  );
}

export function ProcesandoScene({ active }: { active: boolean }) {
  return (
    <div className="absolute inset-0 flex flex-col bg-white">
      {/* Top bar — el header de chat con breadcrumb, replicando el de App.tsx */}
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-gray-100 bg-white flex-shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <I.folder className="w-3 h-3 text-amber-500 flex-shrink-0" />
          <span className="text-[9px] text-gray-500 truncate">Bóveda · Colombia</span>
          <span className="text-gray-300 text-[9px]">/</span>
          <span className="text-[9.5px] text-gray-900 font-semibold truncate">Tabular Review</span>
        </div>
        <span className="text-[8px] text-gray-400 font-mono">en vivo</span>
      </div>

      {/* Chat area */}
      <div className="flex-1 overflow-hidden px-3 py-2.5 space-y-2">
        {/* User message — el prompt recién enviado */}
        <motion.div
          className="flex justify-end"
          initial={{ opacity: 0, y: 6 }}
          animate={active ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.4, ease: easeEnter }}
        >
          <div className="max-w-[85%] bg-gray-900 text-white rounded-2xl rounded-tr-sm px-2.5 py-1.5">
            <div className="text-[10px] leading-snug font-medium">
              Compara las 14 sentencias en una grilla con tesis, artículo citado y resultado. Exporta a DOCX.
            </div>
          </div>
        </motion.div>

        {/* Tool calls — secuencia animada con stagger */}
        <div className="space-y-1.5 pt-1">
          {TOOL_CALLS.map((call, i) => (
            <ToolCallCard key={call.id} call={call} delay={0.5 + i * 0.55} />
          ))}
        </div>

        {/* Streaming bubble del agente — placeholder mientras corre el último tool */}
        <motion.div
          className="flex items-center gap-1.5 pt-1"
          initial={{ opacity: 0 }}
          animate={active ? { opacity: 1 } : {}}
          transition={{ duration: 0.4, delay: 3.2 }}
        >
          <div className="w-5 h-5 rounded-md bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center flex-shrink-0">
            <I.bot className="w-3 h-3 text-white" strokeWidth={2.5} />
          </div>
          <div className="flex items-center gap-1 px-2.5 py-1.5 rounded-2xl rounded-tl-sm bg-gray-100">
            {[0, 1, 2].map((i) => (
              <motion.span
                key={i}
                className="w-1.5 h-1.5 rounded-full bg-gray-500"
                animate={{ y: [0, -3, 0], opacity: [0.4, 1, 0.4] }}
                transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.15, ease: "easeInOut" }}
              />
            ))}
          </div>
        </motion.div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENE 4 — Resultados: DOCX canvas con la grilla comparativa
// ─────────────────────────────────────────────────────────────────────────────
export function ResultadosScene({ active }: { active: boolean }) {
  return (
    <div className="absolute inset-0 flex flex-col bg-white">
      {/* File header — replicando WorkspaceSidebar del App.tsx */}
      <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 border-b border-gray-200 bg-gray-50 flex-shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <I.fileText className="w-3.5 h-3.5 text-blue-600 flex-shrink-0" />
          <span className="text-[10.5px] font-semibold text-gray-900 truncate">
            tabla_sentencias_2025.docx
          </span>
          <span className="text-[7.5px] font-bold uppercase tracking-wider bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded flex-shrink-0">
            Read-Only
          </span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <I.refresh className="w-3 h-3 text-gray-400" />
          <I.eye className="w-3 h-3 text-gray-400" />
        </div>
      </div>

      {/* Tabs strip — File / Home / Insert / Layout / Review / View / Efficiency */}
      <div className="flex items-end px-2 pt-0.5 bg-gray-100 border-b border-gray-200 flex-shrink-0 overflow-hidden">
        <div className="px-2.5 py-1 text-[9px] font-medium text-white bg-blue-600 rounded-t">
          File
        </div>
        {["Home", "Insert", "Layout", "Review", "View", "Efficiency"].map((t) => (
          <div
            key={t}
            className={`px-2 py-1 text-[9px] font-medium border-b-2 ${
              t === "Home"
                ? "border-blue-600 text-blue-700 bg-white rounded-t"
                : "border-transparent text-gray-600"
            }`}
          >
            {t}
          </div>
        ))}
      </div>

      {/* Read-only banner — el aviso amarillo del editor Worgena */}
      <div className="flex items-center justify-between px-2.5 py-1 bg-amber-50 border-b border-amber-200 flex-shrink-0">
        <span className="text-[8.5px] text-amber-800 font-medium leading-tight">
          Habilita la edición para hacer cambios.
        </span>
        <span className="text-[8px] text-amber-700 font-semibold">Habilitar</span>
      </div>

      {/* Document body — la tabla comparativa real */}
      <div className="flex-1 overflow-hidden p-2 bg-gray-100">
        <motion.div
          className="bg-white rounded shadow-sm border border-gray-200 overflow-hidden h-full"
          initial={{ opacity: 0, y: 8 }}
          animate={active ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.5, delay: 0.2, ease: easeEnter }}
        >
          {/* Tabla comparativa */}
          <div className="h-full flex flex-col">
            {/* Header row */}
            <div className="grid grid-cols-[18px_52px_1fr_1fr_68px_72px] gap-0 bg-gray-50 border-b border-gray-300">
              {["#", "Sentencia", "Tesis", "Resultado", "Artículo", "Tipo"].map((h, i) => (
                <div
                  key={h}
                  className={`text-[7.5px] font-bold uppercase tracking-wider text-gray-700 px-1.5 py-1 ${
                    i > 0 ? "border-l border-gray-200" : ""
                  }`}
                >
                  {h}
                </div>
              ))}
            </div>

            {/* Data rows — staggered */}
            {TABLE.map((row, i) => (
              <motion.div
                key={row.id}
                className="grid grid-cols-[18px_52px_1fr_1fr_68px_72px] gap-0 border-b border-gray-100 last:border-b-0"
                initial={{ opacity: 0, x: -8 }}
                animate={active ? { opacity: 1, x: 0 } : {}}
                transition={{ duration: 0.4, delay: 0.6 + i * 0.15, ease: easeEnter }}
              >
                <div className="text-[8px] text-gray-400 tabular-nums px-1.5 py-1.5 text-center font-medium">
                  {row.id}
                </div>
                <div className="text-[8.5px] text-gray-900 font-bold tabular-nums px-1.5 py-1.5 border-l border-gray-100">
                  {row.code}
                </div>
                <div className="text-[8px] text-gray-800 px-1.5 py-1.5 border-l border-gray-100 leading-snug">
                  <div className="font-semibold text-gray-900">{row.topic}</div>
                  <div className="text-gray-500 leading-tight mt-0.5">{row.thesis}</div>
                </div>
                <div className="text-[8px] text-gray-700 px-1.5 py-1.5 border-l border-gray-100 leading-snug">
                  {row.outcome}
                </div>
                <div className="text-[7.5px] text-gray-600 px-1.5 py-1.5 border-l border-gray-100 font-mono leading-tight">
                  {row.article}
                </div>
                <div className="px-1.5 py-1.5 border-l border-gray-100 flex items-center justify-center">
                  <span
                    className={`text-[7px] font-bold uppercase tracking-wide px-1 py-0.5 rounded ${
                      row.outcome === "Tutela concedida"
                        ? "bg-emerald-100 text-emerald-700"
                        : row.outcome === "Nulidad"
                        ? "bg-red-100 text-red-700"
                        : "bg-blue-100 text-blue-700"
                    }`}
                  >
                    {row.outcome === "Tutela concedida" ? "Tutela" : row.outcome}
                  </span>
                </div>
              </motion.div>
            ))}
          </div>
        </motion.div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENE 5 — Exportar: workspace sidebar + download menu
// ─────────────────────────────────────────────────────────────────────────────
export function ExportarScene({ active }: { active: boolean }) {
  return (
    <div className="absolute inset-0 flex flex-col bg-white">
      {/* File header — mismo estilo que Resultados */}
      <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 border-b border-gray-200 bg-gray-50 flex-shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <I.fileText className="w-3.5 h-3.5 text-blue-600 flex-shrink-0" />
          <span className="text-[10.5px] font-semibold text-gray-900 truncate">
            tabla_sentencias_2025.docx
          </span>
          <span className="text-[7.5px] font-bold uppercase tracking-wider bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded flex-shrink-0">
            Editing
          </span>
        </div>
        <motion.button
          className="flex items-center gap-1 px-2 py-0.5 bg-blue-600 text-white rounded text-[8.5px] font-semibold flex-shrink-0"
          initial={{ opacity: 0, scale: 0.9 }}
          animate={active ? { opacity: 1, scale: 1 } : {}}
          transition={{ duration: 0.4, delay: 0.4, ease: easePop }}
        >
          <I.check className="w-2.5 h-2.5" strokeWidth={3.5} />
          Guardar
        </motion.button>
      </div>

      {/* Tabs */}
      <div className="flex items-end px-2 pt-0.5 bg-gray-100 border-b border-gray-200 flex-shrink-0">
        <div className="px-2.5 py-1 text-[9px] font-medium text-white bg-blue-600 rounded-t">
          File
        </div>
        {["Home", "Insert", "Layout", "Review"].map((t) => (
          <div
            key={t}
            className="px-2 py-1 text-[9px] font-medium text-gray-600 border-b-2 border-transparent"
          >
            {t}
          </div>
        ))}
      </div>

      {/* Body — workspace sidebar (archivos) + download menu flotante */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar — WorkspaceSidebar files */}
        <div className="w-[42%] border-r border-gray-200 bg-white flex flex-col">
          <div className="px-2 py-1.5 border-b border-gray-100 flex items-center justify-between">
            <span className="text-[9px] font-semibold text-gray-700">Archivos</span>
            <I.plus className="w-3 h-3 text-gray-500" strokeWidth={2.5} />
          </div>
          {[
            { name: "tabla_sentencias_2025.docx", active: true,  size: "47 KB" },
            { name: "tabla_sentencias_2024.docx", active: false, size: "52 KB" },
            { name: "notas_t-622.docx",           active: false, size: "12 KB" },
            { name: "ficha_su-133.pdf",            active: false, size: "847 KB" },
          ].map((f, i) => (
            <motion.div
              key={f.name}
              className={`flex items-center gap-1.5 px-2 py-1 border-b border-gray-50 ${
                f.active ? "bg-blue-50" : ""
              }`}
              initial={{ opacity: 0, x: -6 }}
              animate={active ? { opacity: 1, x: 0 } : {}}
              transition={{ duration: 0.35, delay: i * 0.08 + 0.3, ease: easeEnter }}
            >
              <FileTypeBadge type={f.name.endsWith(".pdf") ? "PDF" : "DOCX"} />
              <span className={`flex-1 min-w-0 text-[8.5px] truncate ${
                f.active ? "font-semibold text-blue-700" : "text-gray-700"
              }`}>
                {f.name}
              </span>
              <MetaText>{f.size}</MetaText>
            </motion.div>
          ))}
        </div>

        {/* Vista preview + download menu flotante */}
        <div className="flex-1 bg-gray-100 p-2 relative">
          {/* Mini doc preview */}
          <div className="bg-white rounded shadow-sm border border-gray-200 h-full p-2 overflow-hidden">
            <div className="space-y-1">
              {TABLE.slice(0, 4).map((row) => (
                <div key={row.id} className="flex items-center gap-1 text-[7.5px]">
                  <span className="font-bold text-gray-900 w-9 tabular-nums">{row.code}</span>
                  <span className="text-gray-500 truncate">{row.topic}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Download menu flotante — la firma del WorkspaceSidebar Worgena */}
          <motion.div
            className="absolute right-2 top-8 w-[88px] bg-white border border-gray-200 rounded-lg shadow-xl py-1 z-10"
            initial={{ opacity: 0, y: -6, scale: 0.95 }}
            animate={active ? { opacity: 1, y: 0, scale: 1 } : {}}
            transition={{ duration: 0.45, delay: 1.0, ease: easePop }}
          >
            <div className="px-2 py-0.5 text-[7.5px] font-bold uppercase tracking-wider text-gray-500 border-b border-gray-100">
              Descargar
            </div>
            <div className="px-2 py-1.5 flex items-center gap-1.5 hover:bg-gray-50 cursor-pointer">
              <I.fileText className="w-3 h-3 text-red-500" />
              <span className="text-[8.5px] text-gray-800 font-medium">PDF</span>
            </div>
            <div className="px-2 py-1.5 flex items-center gap-1.5 hover:bg-gray-50 cursor-pointer border-t border-gray-100">
              <I.fileText className="w-3 h-3 text-blue-500" />
              <span className="text-[8.5px] text-gray-800 font-medium">WORD</span>
            </div>
          </motion.div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENE 6 — Cierre: wordmark + tagline
// ─────────────────────────────────────────────────────────────────────────────
export function CierreScene({ active }: { active: boolean }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-white text-center px-4">
      <motion.div
        className="w-12 h-12 rounded-xl bg-gray-900 flex items-center justify-center mb-3"
        initial={{ opacity: 0, scale: 0.7 }}
        animate={active ? { opacity: 1, scale: 1 } : {}}
        transition={{ duration: 0.6, ease: easePop, delay: 0.1 }}
      >
        <span className="text-white font-bold text-[22px] tracking-tight">W</span>
      </motion.div>

      <motion.h1
        className="text-[24px] font-bold text-gray-900 tracking-tight"
        initial={{ opacity: 0, y: 8 }}
        animate={active ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.5, delay: 0.3, ease: easeEnter }}
      >
        Worgena
      </motion.h1>

      <motion.p
        className="text-[10.5px] text-gray-500 mt-1.5 font-medium"
        initial={{ opacity: 0 }}
        animate={active ? { opacity: 1 } : {}}
        transition={{ duration: 0.5, delay: 0.5 }}
      >
        Agentes para firmas colombianas
      </motion.p>

      <motion.div
        className="mt-5 flex items-center gap-1.5"
        initial={{ opacity: 0, y: 6 }}
        animate={active ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.5, delay: 0.7, ease: easeEnter }}
      >
        <div className="px-2.5 py-1 rounded-md border border-gray-200 bg-white">
          <span className="text-[9px] text-gray-700 font-mono font-medium">worgena.com</span>
        </div>
        <div className="px-2.5 py-1 rounded-md bg-gray-900 text-white">
          <span className="text-[9px] font-semibold">Probar gratis</span>
        </div>
      </motion.div>

      {/* Tagline pills — los diferenciadores de Worgena */}
      <motion.div
        className="flex items-center gap-1 mt-4"
        initial={{ opacity: 0 }}
        animate={active ? { opacity: 1 } : {}}
        transition={{ duration: 0.5, delay: 0.9 }}
      >
        {["Tabular Review", "Investigación", "Due diligence"].map((t) => (
          <span
            key={t}
            className="text-[7.5px] text-gray-500 font-medium px-1.5 py-0.5 rounded-full bg-gray-100"
          >
            {t}
          </span>
        ))}
      </motion.div>
    </div>
  );
}
