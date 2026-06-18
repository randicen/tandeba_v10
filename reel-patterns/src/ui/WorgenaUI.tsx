// WorgenaUI.tsx — Snapshot fiel de la app Worgena en dimensiones fijas
// (1000×700). Pensado para ser la "fuente" de los patrones: el zoom, pan y
// morph empiezan todos desde esta UI.
//
// Convenciones de layout:
//   - Sidebar  = 260px (izquierda)
//   - Main     = 740px (resto, x ≥ 260)
//   - Topbar   = 36px (parte superior del main, encima del chat)
//   - Chat area= 664px (debajo del topbar)
//
// Este archivo exporta:
//   - WORGENA_W, WORGENA_H  — dimensiones del snapshot
//   - WorgenaUI             — el snapshot completo (sidebar + chat)
//   - WorgenaScreen         — variante parametrizable (sidebar/chat/table)
//
// Las screens individuales que usa World.tsx para crear el strip
// horizontal viven en src/screens/ y se construyen sobre los mismos
// átomos (Sidebar, Topbar, ToolCallRow, Badge, etc.) exportados abajo.

import { Ic } from "./icons";

export const WORGENA_W = 1000;
export const WORGENA_H = 700;
export const CHAT_CENTER = { x: 630, y: 350 } as const;

const SIDEBAR_W = 260;
const TOPBAR_H  = 36;

// ─────────────────────────────────────────────────────────────────────────────
// Datos de relleno (reales del codebase — ver /recursos/documentos/)
// ─────────────────────────────────────────────────────────────────────────────
export const CHAT_HISTORY = [
  "Artículo de 25 páginas. Cotiza",
  "Inventario panadería",
  "Paz y salvo · Constructora Andina",
  "Compliance · Reporte trimestral",
  "Investigación · family office",
  "Notas · reunión cliente (martes)",
];

export const SPACES = [
  "Letroma - Asistencia general",
  "Asistente de EduHootie",
  "Bufete Ramírez · DD Q3",
];

// ─────────────────────────────────────────────────────────────────────────────
// Sidebar
// ─────────────────────────────────────────────────────────────────────────────
export function Sidebar() {
  return (
    <aside
      className="flex flex-col border-r border-gray-200 bg-gray-50 h-full shrink-0"
      style={{ width: SIDEBAR_W }}
    >
      {/* Wordmark */}
      <div className="px-4 pt-3.5 pb-2">
        <h1 className="text-[15px] font-bold tracking-tight text-gray-800">
          Worgena
        </h1>
      </div>

      {/* + Nuevo button */}
      <div className="px-3.5">
        <button className="w-full py-2 px-3 text-[12px] font-semibold bg-gray-900 text-white rounded-lg flex items-center gap-2 justify-center">
          <Ic.plus className="w-3.5 h-3.5" strokeWidth={2.5} />
          Nuevo
        </button>
      </div>

      {/* Nav items */}
      <nav className="px-2.5 mt-3 space-y-0.5">
        {[
          { icon: Ic.bot,         label: "Chats",          active: true  },
          { icon: Ic.folder,      label: "Espacios",       active: false },
          { icon: Ic.folder,      label: "Bóvedas",        active: false, accent: "text-amber-500" },
          { icon: Ic.wrench,      label: "Herramientas",   active: false },
          { icon: Ic.settings,    label: "Personalizar",   active: false },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <div
              key={item.label}
              className={`flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-[12px] ${
                item.active
                  ? "bg-white text-gray-900 font-medium shadow-sm"
                  : "text-gray-600"
              }`}
            >
              <Icon
                className={`w-3.5 h-3.5 shrink-0 ${item.accent ?? ""}`}
              />
              {item.label}
            </div>
          );
        })}
      </nav>

      {/* Espacios pinned (sub-list) */}
      <div className="mt-4 px-3.5">
        <div className="text-[9.5px] font-semibold tracking-wider text-gray-400 uppercase mb-1.5">
          No hay espacios fijados
        </div>
      </div>

      {/* Espacios list */}
      <div className="mt-1 px-2.5 space-y-0.5">
        {SPACES.map((s) => (
          <div
            key={s}
            className="flex items-center gap-2 px-2 py-1 rounded-md text-[11px] text-gray-700"
          >
            <Ic.folder className="w-3 h-3 text-amber-500 shrink-0" />
            <span className="truncate">{s}</span>
          </div>
        ))}
      </div>

      {/* Chat history (HISTORIAL section) */}
      <div className="mt-4 px-3.5">
        <div className="text-[9.5px] font-semibold tracking-wider text-gray-400 uppercase mb-1.5">
          Historial
        </div>
      </div>
      <div className="mt-1 px-2.5 space-y-0.5 flex-1 overflow-hidden">
        {CHAT_HISTORY.map((name, i) => (
          <div
            key={name}
            className="flex items-center gap-2 px-2 py-1 rounded-md text-[11px] text-gray-700 truncate"
            style={{ opacity: 1 - i * 0.1 }}
          >
            <Ic.messageSquarePlus className="w-3 h-3 text-gray-400 shrink-0" />
            <span className="truncate">{name}</span>
          </div>
        ))}
      </div>

      {/* User chip at bottom */}
      <div className="border-t border-gray-200 p-3 flex items-center gap-2">
        <div className="w-7 h-7 rounded-full bg-gray-900 text-white text-[10px] font-semibold flex items-center justify-center">
          JJ
        </div>
        <div className="text-[11px] leading-tight">
          <div className="font-medium text-gray-900">doctor Juan</div>
          <div className="text-gray-500 text-[9.5px]">jabog@worgena.com</div>
        </div>
      </div>
    </aside>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Topbar
// ─────────────────────────────────────────────────────────────────────────────
export function Topbar() {
  return (
    <div
      className="flex items-center justify-between px-5 border-b border-gray-100 bg-white shrink-0"
      style={{ height: TOPBAR_H }}
    >
      <div className="flex items-center gap-5">
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-gray-700">
          <Ic.monitor className="w-3.5 h-3.5" />
          <span>Monitor interno</span>
          <span className="ml-1 w-1.5 h-1.5 rounded-full bg-blue-500" />
        </div>
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-gray-600">
          <Ic.newspaper className="w-3.5 h-3.5" />
          <span>Monitor externo</span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 px-2.5 py-1 text-[11.5px] font-medium text-gray-600 rounded-lg">
          <Ic.helpCircle className="w-3.5 h-3.5" />
          <span>Guías</span>
        </div>
        <div className="flex items-center gap-1.5 px-2.5 py-1 text-[11.5px] font-medium text-gray-700 bg-white border border-gray-200 rounded-lg">
          <Ic.calendar className="w-3.5 h-3.5" />
          <span>Programadas</span>
          <Ic.chevDown className="w-3 h-3 text-gray-500" />
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Componentes compartidos
// ─────────────────────────────────────────────────────────────────────────────
export function ToolCallRow({
  icon,
  title,
  detail,
  done,
  running,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  done?: boolean;
  running?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-white border border-gray-200 shadow-sm">
      <div className="w-5 h-5 rounded bg-gray-100 flex items-center justify-center text-gray-700 shrink-0">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[10.5px] font-semibold text-gray-900 leading-tight">{title}</div>
        <div className="text-[9.5px] text-gray-500 truncate leading-tight">{detail}</div>
      </div>
      {done && (
        <div className="w-3.5 h-3.5 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
          <Ic.check className="w-2 h-2 text-emerald-600" strokeWidth={3.5} />
        </div>
      )}
      {running && (
        <div className="w-3.5 h-3.5 border-2 border-blue-500 border-t-transparent rounded-full shrink-0 animate-spin" />
      )}
    </div>
  );
}

export function Badge({ tone, children }: { tone: "green" | "red" | "blue"; children: React.ReactNode }) {
  const styles = {
    green: "bg-emerald-100 text-emerald-700",
    red:   "bg-red-100 text-red-700",
    blue:  "bg-blue-100 text-blue-700",
  }[tone];
  return (
    <span className={`text-[8.5px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${styles}`}>
      {children}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tabla de sentencias — reutilizable por ChatScreen y TableScreen
// ─────────────────────────────────────────────────────────────────────────────
export const SENTENCIAS = [
  {
    id: "T-622/16",
    tesis: "Río como sujeto de derechos",
    resultado: "Tutela" as const,
    articulo: "CP 7, 8, 79",
  },
  {
    id: "SU-133/17",
    tesis: "Cesión de títulos mineros",
    resultado: "Nulidad" as const,
    articulo: "CP 330",
  },
  {
    id: "T-106/25",
    tesis: "Oro ilícito en zona protegida",
    resultado: "Tutela" as const,
    articulo: "Ley 1658/13",
  },
];

export function SentenciasTable() {
  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden shadow-sm">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 border-b border-gray-200">
        <Ic.fileText className="w-3.5 h-3.5 text-blue-600" />
        <span className="text-[11px] font-semibold text-gray-900">tabla_sentencias_2025.docx</span>
        <span className="text-[8.5px] font-bold uppercase tracking-wider bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded">
          Read-Only
        </span>
      </div>
      <table className="w-full text-[9.5px]">
        <thead className="bg-gray-50 text-gray-600">
          <tr>
            {["Sentencia", "Tesis", "Resultado", "Artículo"].map((h) => (
              <th key={h} className="text-left font-semibold px-2.5 py-1.5 border-b border-gray-200">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="text-gray-800">
          {SENTENCIAS.map((row, i) => (
            <tr key={row.id} className={i < SENTENCIAS.length - 1 ? "border-b border-gray-100" : ""}>
              <td className="px-2.5 py-1.5 font-bold tabular-nums">{row.id}</td>
              <td className="px-2.5 py-1.5">{row.tesis}</td>
              <td className="px-2.5 py-1.5">
                <Badge tone={row.resultado === "Tutela" ? "green" : "red"}>
                  {row.resultado}
                </Badge>
              </td>
              <td className="px-2.5 py-1.5 font-mono text-gray-600">{row.articulo}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat — el "destino" del zoom
// ─────────────────────────────────────────────────────────────────────────────
export function ChatArea({ showTable = true }: { showTable?: boolean }) {
  return (
    <div className="flex-1 min-h-0 flex flex-col bg-white">
      {/* Mensajes */}
      <div className="flex-1 overflow-hidden px-8 py-5 space-y-3">
        {/* Greeting */}
        <div className="text-[20px] font-semibold text-gray-900 mb-1">
          Buenos días, doctor Juan
        </div>

        {/* User message */}
        <div className="flex justify-end pt-2">
          <div className="max-w-[78%] bg-gray-900 text-white rounded-2xl rounded-tr-sm px-3.5 py-2">
            <div className="text-[12px] leading-snug font-medium">
              Compara las 14 sentencias de la bóveda en una grilla con tesis, artículo citado y resultado. Exporta a DOCX.
            </div>
          </div>
        </div>

        {/* Tool call 1 */}
        <div className="flex items-start gap-2">
          <div className="w-6 h-6 rounded-md bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shrink-0 mt-0.5">
            <Ic.bot className="w-3.5 h-3.5 text-white" strokeWidth={2.5} />
          </div>
          <div className="flex-1 max-w-[88%] space-y-1.5">
            <ToolCallRow
              icon={<Ic.fileText className="w-3.5 h-3.5" strokeWidth={2.25} />}
              title="Lectura de archivos"
              detail="Leyendo: T-622 de 2016 · Río Atrato"
              done
            />
            <ToolCallRow
              icon={<Ic.fileText className="w-3.5 h-3.5" strokeWidth={2.25} />}
              title="Lectura de archivos"
              detail="Leyendo: SU-133 de 2017 · Derechos mineros"
              done
            />
            <ToolCallRow
              icon={<Ic.fileText className="w-3.5 h-3.5" strokeWidth={2.25} />}
              title="Creador de Archivos"
              detail="Escribiendo: tabla_sentencias_2025.docx"
              done
            />
            <ToolCallRow
              icon={<Ic.bot className="w-3.5 h-3.5" strokeWidth={2.25} />}
              title="Editor IA"
              detail="Reescribiendo documento con IA"
              running
            />
          </div>
        </div>

        {/* Result preview — the money shot */}
        {showTable && (
          <div className="pl-8 pt-1">
            <SentenciasTable />
          </div>
        )}
      </div>

      {/* Composer (al fondo del chat) */}
      <div className="px-8 pb-5 pt-2 shrink-0">
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
          <div className="px-3.5 py-2.5 min-h-[40px] text-[12px] text-gray-400">
            Escribe @ para ver conectores y fuentes
          </div>
          <div className="flex items-center justify-between px-2 py-1.5 border-t border-gray-100 bg-gray-50/50">
            <div className="flex items-center gap-1.5">
              <div className="w-5 h-5 rounded-full border border-gray-300 flex items-center justify-center">
                <Ic.plus className="w-3 h-3 text-gray-700" strokeWidth={2.5} />
              </div>
              <div className="flex items-center gap-1 px-1.5 py-0.5 bg-white border border-gray-200 rounded-md">
                <Ic.search className="w-3 h-3 text-gray-500" />
                <span className="text-[10.5px] text-gray-700 font-medium">Búsqueda</span>
                <Ic.chevDown className="w-2.5 h-2.5 text-gray-400" />
              </div>
              <div className="flex items-center bg-white border border-gray-200 rounded-md overflow-hidden">
                <span className="text-[9.5px] font-bold text-gray-900 px-1.5 py-0.5 bg-gray-100">Fast</span>
                <span className="text-[9.5px] font-medium text-gray-500 px-1.5 py-0.5">Pro</span>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <Ic.mic className="w-3.5 h-3.5 text-gray-500" />
              <div className="w-6 h-6 rounded-full bg-gray-900 flex items-center justify-center">
                <Ic.send className="w-3 h-3 text-white" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// WorgenaUI — el snapshot completo (sidebar + chat)
// ─────────────────────────────────────────────────────────────────────────────
export function WorgenaUI() {
  return (
    <div
      className="flex bg-white text-gray-900 font-sans overflow-hidden rounded-xl shadow-[0_8px_40px_rgba(0,0,0,0.4)]"
      style={{ width: WORGENA_W, height: WORGENA_H }}
    >
      <Sidebar />
      <main className="flex-1 min-w-0 flex flex-col">
        <Topbar />
        <ChatArea />
      </main>
    </div>
  );
}
