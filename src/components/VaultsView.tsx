import React, { useState } from 'react';
import { 
  Plus, Search, FileText, FileSpreadsheet, Image as ImageIcon, Table, 
  Grid3X3, List, Pin, MoreVertical, ChevronDown, Folder
} from 'lucide-react';
import { cn } from '../lib/utils';

interface VaultItem {
  id: string;
  name: string;
  type: 'documento' | 'hoja de calculo' | 'imagen' | 'tabla' | string;
  space: string;
  spacePath: string;
  date: string;
  pinned: boolean;
  origin: 'usuario' | 'agente';
}

const MOCK_ITEMS: VaultItem[] = [
  { id: 'v1', name: 'Contrato de servicios profesionales.docx', type: 'documento', space: 'Juan', spacePath: 'Clientes > Juan', date: 'Hace 2 días', pinned: true, origin: 'agente' },
  { id: 'v2', name: 'Demanda reparación directa.docx', type: 'documento', space: 'Caso XYZ', spacePath: 'Litigios > Caso XYZ', date: 'Ayer', pinned: true, origin: 'usuario' },
  { id: 'v3', name: 'Reporte financiero mensual.xlsx', type: 'hoja de calculo', space: 'Firmwide', spacePath: 'General', date: '15 mar 2026', pinned: false, origin: 'agente' },
  { id: 'v4', name: 'Dashboard de productividad.html', type: 'tabla', space: 'Firmwide', spacePath: 'General', date: '12 mar 2026', pinned: false, origin: 'agente' },
  { id: 'v5', name: 'Evidencia fotográfica inspección.jpg', type: 'imagen', space: 'Caso XYZ', spacePath: 'Litigios > Caso XYZ', date: '10 mar 2026', pinned: false, origin: 'usuario' },
  { id: 'v6', name: 'Poder especial.docx', type: 'documento', space: 'Juan', spacePath: 'Clientes > Juan', date: '8 mar 2026', pinned: false, origin: 'usuario' },
  { id: 'v7', name: 'Ley 80 de 1993.pdf', type: 'documento', space: 'Normativo', spacePath: 'Investigación', date: '5 mar 2026', pinned: true, origin: 'usuario' },
  { id: 'v8', name: 'Tabular Review - Contratos.xlsx', type: 'hoja de calculo', space: 'Firmwide', spacePath: 'General', date: '2 mar 2026', pinned: false, origin: 'agente' },
];

const TYPE_ICONS: Record<string, any> = {
  'documento': FileText,
  'hoja de calculo': FileSpreadsheet,
  'imagen': ImageIcon,
  'tabla': Table,
};

const TYPE_COLORS: Record<string, string> = {
  'documento': 'bg-blue-50 text-blue-600',
  'hoja de calculo': 'bg-green-50 text-green-600',
  'imagen': 'bg-purple-50 text-purple-600',
  'tabla': 'bg-amber-50 text-amber-600',
};

export default function VaultsView() {
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('todas');
  const [spaceFilter, setSpaceFilter] = useState<string>('todos');
  const [items, setItems] = useState<VaultItem[]>(MOCK_ITEMS);

  const spaces = [...new Set(items.map(i => i.spacePath))];

  const filtered = items.filter(i => {
    if (search && !i.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (typeFilter !== 'todas' && i.type !== typeFilter) return false;
    if (spaceFilter !== 'todos' && i.spacePath !== spaceFilter) return false;
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return 0;
  });

  const togglePin = (id: string) => {
    setItems(prev => prev.map(i => i.id === id ? { ...i, pinned: !i.pinned } : i));
  };

  return (
    <main className="flex-1 flex flex-col min-w-0 bg-gray-50 z-10 w-full">
      <div className="p-6 sm:p-10 max-w-6xl mx-auto w-full">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Bóvedas</h1>
            <p className="text-gray-500 text-sm mt-1">Todos tus documentos y artefactos, de todos los espacios.</p>
          </div>
          <button className="px-4 py-2 bg-gray-900 text-white text-sm font-medium rounded-lg hover:bg-gray-800 transition-colors flex items-center gap-2">
            <Plus className="w-4 h-4" /> Nueva bóveda
          </button>
        </div>

        {/* Filters bar */}
        <div className="flex flex-wrap items-center gap-3 mb-6">
          <div className="relative flex-1 min-w-[200px] max-w-xs">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar en bóvedas..."
              className="w-full pl-9 pr-4 py-2 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:border-gray-400"
            />
          </div>
          <div className="relative">
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="appearance-none pl-4 pr-8 py-2 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:border-gray-400 cursor-pointer"
            >
              <option value="todas">Todas las categorías</option>
              <option value="documento">Documentos</option>
              <option value="hoja de calculo">Hojas de cálculo</option>
              <option value="imagen">Imágenes</option>
              <option value="tabla">Tablas</option>
            </select>
            <ChevronDown className="w-3.5 h-3.5 absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          </div>
          <div className="relative">
            <select
              value={spaceFilter}
              onChange={(e) => setSpaceFilter(e.target.value)}
              className="appearance-none pl-4 pr-8 py-2 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:border-gray-400 cursor-pointer"
            >
              <option value="todos">Todos los espacios</option>
              {spaces.map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <ChevronDown className="w-3.5 h-3.5 absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          </div>
          <div className="ml-auto flex items-center gap-1 bg-white border border-gray-200 rounded-lg p-0.5">
            <button
              onClick={() => setViewMode('grid')}
              className={cn("p-1.5 rounded-md transition-colors", viewMode === 'grid' ? "bg-gray-100 text-gray-900" : "text-gray-400 hover:text-gray-600")}
            >
              <Grid3X3 className="w-4 h-4" />
            </button>
            <button
              onClick={() => setViewMode('list')}
              className={cn("p-1.5 rounded-md transition-colors", viewMode === 'list' ? "bg-gray-100 text-gray-900" : "text-gray-400 hover:text-gray-600")}
            >
              <List className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content */}
        {sorted.length === 0 ? (
          <div className="text-center py-20 text-gray-400">
            <Folder className="w-12 h-12 mx-auto mb-4 text-gray-200" />
            <p className="text-lg font-medium">Sin resultados</p>
            <p className="text-sm mt-1">No se encontraron documentos con esos filtros.</p>
          </div>
        ) : viewMode === 'grid' ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {sorted.map((item) => {
              const Icon = TYPE_ICONS[item.type] || FileText;
              const colorClass = TYPE_COLORS[item.type] || 'bg-gray-50 text-gray-600';
              return (
                <div key={item.id} className="bg-white border border-gray-200 rounded-xl p-4 hover:border-gray-300 hover:shadow-sm transition-all group cursor-pointer">
                  <div className="flex items-start justify-between mb-3">
                    <div className={cn("w-10 h-10 rounded-lg flex items-center justify-center shrink-0", colorClass)}>
                      <Icon className="w-5 h-5" />
                    </div>
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => { e.stopPropagation(); togglePin(item.id); }}
                        className={cn("p-1 rounded-md hover:bg-gray-100", item.pinned ? "text-amber-500" : "text-gray-400")}
                        title={item.pinned ? "Desfijar" : "Fijar"}
                      >
                        <Pin className="w-3.5 h-3.5" fill={item.pinned ? "currentColor" : "none"} />
                      </button>
                      <button className="p-1 rounded-md hover:bg-gray-100 text-gray-400">
                        <MoreVertical className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  <p className="text-sm font-medium text-gray-800 leading-snug mb-2 line-clamp-2">
                    {item.name}
                  </p>
                  <div className="flex items-center gap-1 text-[11px] text-gray-400 mb-1">
                    <Folder className="w-3 h-3" />
                    <span>{item.spacePath}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-gray-400">{item.date}</span>
                    <span className={cn(
                      "text-[10px] px-1.5 py-0.5 rounded-full font-medium",
                      item.origin === 'agente' ? "bg-blue-50 text-blue-600" : "bg-gray-100 text-gray-500"
                    )}>
                      {item.origin === 'agente' ? 'Agente' : 'Tuyo'}
                    </span>
                  </div>
                  {item.pinned && (
                    <div className="absolute top-2 right-2">
                      <Pin className="w-3 h-3 text-amber-500" fill="currentColor" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="grid grid-cols-12 gap-4 px-5 py-3 bg-gray-50 border-b border-gray-200 text-[11px] font-semibold text-gray-500 uppercase tracking-wider">
              <div className="col-span-5">Nombre</div>
              <div className="col-span-2">Tipo</div>
              <div className="col-span-2">Espacio</div>
              <div className="col-span-2">Fecha</div>
              <div className="col-span-1"></div>
            </div>
            {sorted.map((item) => {
              const Icon = TYPE_ICONS[item.type] || FileText;
              const colorClass = TYPE_COLORS[item.type] || 'bg-gray-50 text-gray-600';
              return (
                <div key={item.id} className="grid grid-cols-12 gap-4 px-5 py-3 border-b border-gray-100 last:border-0 hover:bg-gray-50 transition-colors cursor-pointer text-sm">
                  <div className="col-span-5 flex items-center gap-3">
                    <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center shrink-0", colorClass)}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div>
                      <span className="font-medium text-gray-800 truncate block">{item.name}</span>
                      {item.pinned && <span className="text-[10px] text-amber-500 font-medium">Fijado</span>}
                    </div>
                  </div>
                  <div className="col-span-2 flex items-center">
                    <span className="text-[11px] text-gray-500 capitalize">{item.type}</span>
                  </div>
                  <div className="col-span-2 flex items-center gap-1 text-[11px] text-gray-500">
                    <Folder className="w-3 h-3" />
                    <span>{item.spacePath}</span>
                  </div>
                  <div className="col-span-2 flex items-center">
                    <span className="text-xs text-gray-400">{item.date}</span>
                  </div>
                  <div className="col-span-1 flex items-center justify-end gap-1 opacity-0 group-hover-hover:opacity-100">
                    <button
                      onClick={(e) => { e.stopPropagation(); togglePin(item.id); }}
                      className={cn("p-1 rounded hover:bg-gray-100", item.pinned ? "text-amber-500" : "text-gray-400")}
                    >
                      <Pin className="w-3.5 h-3.5" fill={item.pinned ? "currentColor" : "none"} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
