// SidebarScreen.tsx — Pantalla #1 del mundo (versión "wide").
//
// A diferencia del Sidebar original (260px de ancho), esta variante
// ocupa los 1000px completos. La idea: cuando la cámara hace travelling
// hacia esta pantalla, lo que veamos debe ser una vista "amplia" de la
// sidebar — un grid de 2 columnas con el nav principal a la izquierda
// y los espacios + historial reciente a la derecha. Es como abrir el
// menú de la app en su modo "overview", donde los espacios y chats
// recientes se ven lado a lado en vez de en una columna estrecha.
//
// Esto es importante para el travelling: la cámara (390px de ancho
// en el mundo escalado) debe ver CONTENIDO real cuando apunta al
// centro de esta pantalla. Si la sidebar fuera de 260px, la cámara
// solo vería el 26% de la pantalla y el resto sería padding vacío.

import { WORGENA_W, WORGENA_H, SPACES, CHAT_HISTORY } from "../ui/WorgenaUI";
import { Ic } from "../ui/icons";

export function SidebarScreen() {
  return (
    <div
      className="flex flex-col bg-gray-50 text-gray-900 font-sans overflow-hidden rounded-xl shadow-[0_8px_40px_rgba(0,0,0,0.4)]"
      style={{ width: WORGENA_W, height: WORGENA_H }}
    >
      {/* Wordmark + brand row */}
      <div className="flex items-center justify-between px-8 pt-5 pb-3 border-b border-gray-200">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-gray-900 to-gray-700 flex items-center justify-center">
            <span className="text-white text-[12px] font-black">W</span>
          </div>
          <h1 className="text-[18px] font-bold tracking-tight text-gray-900">Worgena</h1>
        </div>
        <button className="py-2 px-4 text-[12px] font-semibold bg-gray-900 text-white rounded-lg flex items-center gap-2">
          <Ic.plus className="w-3.5 h-3.5" strokeWidth={2.5} />
          Nuevo
        </button>
      </div>

      {/* 2-col grid: nav principal (izq) + espacios/historial (der) */}
      <div className="flex-1 flex min-h-0">
        {/* Nav principal */}
        <nav className="w-[300px] shrink-0 px-6 py-5 border-r border-gray-200 space-y-1">
          {[
            { icon: Ic.bot,      label: "Chats",        active: true  },
            { icon: Ic.folder,   label: "Espacios",     active: false },
            { icon: Ic.folder,   label: "Bóvedas",      active: false, accent: "text-amber-500" },
            { icon: Ic.wrench,   label: "Herramientas", active: false },
            { icon: Ic.settings, label: "Personalizar", active: false },
          ].map((item) => {
            const Icon = item.icon;
            return (
              <div
                key={item.label}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-[14px] ${
                  item.active
                    ? "bg-white text-gray-900 font-semibold shadow-sm"
                    : "text-gray-600"
                }`}
              >
                <Icon className={`w-4 h-4 shrink-0 ${item.accent ?? ""}`} />
                {item.label}
              </div>
            );
          })}
        </nav>

        {/* Espacios + Historial */}
        <div className="flex-1 px-7 py-5 overflow-hidden">
          {/* Espacios */}
          <div className="mb-5">
            <div className="text-[10.5px] font-bold tracking-wider text-gray-400 uppercase mb-2.5">
              Espacios
            </div>
            <div className="grid grid-cols-3 gap-2.5">
              {SPACES.map((s) => (
                <div
                  key={s}
                  className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-white border border-gray-200 text-[12px] text-gray-800 font-medium"
                >
                  <Ic.folder className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                  <span className="truncate">{s}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Historial */}
          <div>
            <div className="text-[10.5px] font-bold tracking-wider text-gray-400 uppercase mb-2.5">
              Historial reciente
            </div>
            <div className="grid grid-cols-2 gap-2">
              {CHAT_HISTORY.map((name) => (
                <div
                  key={name}
                  className="flex items-center gap-2 px-3 py-2 rounded-md bg-white border border-gray-100 text-[11.5px] text-gray-700"
                >
                  <Ic.messageSquarePlus className="w-3 h-3 text-gray-400 shrink-0" />
                  <span className="truncate">{name}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Footer: user chip */}
      <div className="border-t border-gray-200 px-8 py-3 flex items-center gap-3 bg-white">
        <div className="w-8 h-8 rounded-full bg-gray-900 text-white text-[11px] font-semibold flex items-center justify-center">
          JJ
        </div>
        <div className="text-[12px] leading-tight">
          <div className="font-semibold text-gray-900">doctor Juan</div>
          <div className="text-gray-500 text-[10.5px]">jabog@worgena.com</div>
        </div>
      </div>
    </div>
  );
}
