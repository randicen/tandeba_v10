// TableScreen.tsx — Pantalla #3 del mundo (la última, a la derecha).
//
// Solo la tabla de sentencias, centrada y ampliada. Sin sidebar, sin
// tool calls, sin composer. Es el "resultado final" de la app: las
// sentencias comparadas con tesis, resultado y artículo citado. Las
// filas son más grandes y los badges más prominentes porque esta es la
// pantalla "del dinero" — el output que el abogado va a citar.

import { WORGENA_W, WORGENA_H, SENTENCIAS, Badge } from "../ui/WorgenaUI";
import { Ic } from "../ui/icons";

export function TableScreen() {
  return (
    <div
      className="flex flex-col bg-white text-gray-900 font-sans overflow-hidden rounded-xl shadow-[0_8px_40px_rgba(0,0,0,0.4)]"
      style={{ width: WORGENA_W, height: WORGENA_H }}
    >
      {/* Header: nombre del archivo + badge de read-only */}
      <div className="flex items-center gap-3 px-8 pt-6 pb-3 border-b border-gray-200">
        <div className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center">
          <Ic.fileText className="w-5 h-5 text-blue-600" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-semibold text-gray-900">tabla_sentencias_2025.docx</div>
          <div className="text-[11px] text-gray-500">3 sentencias comparadas · Bóveda Río Atrato</div>
        </div>
        <span className="text-[10px] font-bold uppercase tracking-wider bg-gray-200 text-gray-600 px-2 py-1 rounded">
          Read-Only
        </span>
      </div>

      {/* Tabla ampliada */}
      <div className="flex-1 px-8 py-5 overflow-hidden">
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden shadow-sm h-full">
          <table className="w-full h-full text-[12px]">
            <thead className="bg-gray-50 text-gray-700">
              <tr>
                {["Sentencia", "Tesis", "Resultado", "Artículo citado"].map((h) => (
                  <th
                    key={h}
                    className="text-left font-semibold px-4 py-3 border-b border-gray-200"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="text-gray-800">
              {SENTENCIAS.map((row, i) => (
                <tr
                  key={row.id}
                  className={i < SENTENCIAS.length - 1 ? "border-b border-gray-100" : ""}
                >
                  <td className="px-4 py-4 font-bold tabular-nums text-[13px]">{row.id}</td>
                  <td className="px-4 py-4 text-[12.5px] leading-snug">{row.tesis}</td>
                  <td className="px-4 py-4">
                    <span className="inline-block">
                      <Badge tone={row.resultado === "Tutela" ? "green" : "red"}>
                        {row.resultado}
                      </Badge>
                    </span>
                  </td>
                  <td className="px-4 py-4 font-mono text-gray-600 text-[12px]">{row.articulo}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Footer: hint */}
      <div className="px-8 py-3 border-t border-gray-100 text-[11px] text-gray-500 flex items-center gap-2">
        <Ic.check className="w-3.5 h-3.5 text-emerald-600" strokeWidth={3} />
        Comparación completada · 3/3 sentencias
      </div>
    </div>
  );
}
