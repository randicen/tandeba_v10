import React, { useState } from 'react';
import { ArrowLeft, Briefcase, Folder, Zap, Plus, Search, Sparkles, Plug, Wrench } from 'lucide-react';
import { cn } from '../lib/utils';

interface CustomizePageProps {
  onBack: () => void;
}

interface Skill {
  id: string;
  name: string;
  description: string;
  category: string;
}

const MOCK_SKILLS: Skill[] = [
  { id: 's1', name: 'Análisis de contrato', description: 'Revisión de cláusulas críticas, riesgos y obligaciones.', category: 'Contratos' },
  { id: 's2', name: 'Due diligence', description: 'Checklist de análisis para procesos de auditoría.', category: 'Auditoría' },
  { id: 's3', name: 'Redacción de demanda', description: 'Plantilla y estructura para demandas civiles.', category: 'Litigio' },
  { id: 's4', name: 'Tutela', description: 'Estructura y plazos para acciones de tutela.', category: 'Litigio' },
  { id: 's5', name: 'Consulta SUIN', description: 'Búsqueda y validación de vigencia de normas.', category: 'Normativo' },
];

const CATEGORIES = ['Todas', 'Contratos', 'Litigio', 'Auditoría', 'Normativo', 'Corporativo'];

export default function CustomizePage({ onBack }: CustomizePageProps) {
  const [tab, setTab] = useState<'habilidades' | 'conectores' | 'flujos'>('habilidades');
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState('Todas');

  const filteredSkills = MOCK_SKILLS.filter(s => {
    if (activeCategory !== 'Todas' && s.category !== activeCategory) return false;
    if (search && !s.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="flex-1 flex bg-white min-w-0 w-full">
      {/* Left subnav */}
      <aside className="w-64 border-r border-gray-200 bg-gray-50/50 p-4 flex flex-col shrink-0">
        <button
          onClick={onBack}
          className="flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-gray-900 mb-6"
        >
          <ArrowLeft className="w-4 h-4" />
          Personalizar
        </button>
        <nav className="space-y-1">
          <button
            onClick={() => setTab('habilidades')}
            className={cn(
              "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors",
              tab === 'habilidades' ? "bg-white border border-gray-200 shadow-sm text-gray-900 font-medium" : "text-gray-600 hover:bg-white"
            )}
          >
            <Briefcase className="w-4 h-4" />
            Habilidades
          </button>
          <button
            onClick={() => setTab('conectores')}
            className={cn(
              "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors",
              tab === 'conectores' ? "bg-white border border-gray-200 shadow-sm text-gray-900 font-medium" : "text-gray-600 hover:bg-white"
            )}
          >
            <Folder className="w-4 h-4" />
            Conectores
          </button>
          <button
            onClick={() => setTab('flujos')}
            className={cn(
              "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors",
              tab === 'flujos' ? "bg-white border border-gray-200 shadow-sm text-gray-900 font-medium" : "text-gray-600 hover:bg-white"
            )}
          >
            <Zap className="w-4 h-4" />
            Flujos de trabajo
          </button>
        </nav>

        <div className="mt-8 border-t border-gray-200 pt-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
              Complementos personales
            </h3>
            <button className="p-1 hover:bg-gray-100 rounded text-gray-400">
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
          <p className="text-xs text-gray-500 leading-relaxed">
            Dale a Worgena experiencia a nivel de rol con plugins.
          </p>
          <button className="mt-3 px-3 py-1.5 border border-gray-300 rounded-lg text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors">
            Explorar plugins
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 overflow-y-auto p-8 sm:p-12">
        <div className="max-w-2xl mx-auto">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">
            Personalizar <span className="bg-gray-100 px-2 py-0.5 rounded">Worgena</span>
          </h1>
          <p className="text-gray-600 mb-8">
            Las habilidades, conectores y plugins definen cómo Worgena trabaja contigo.
          </p>

          {tab === 'habilidades' && (
            <div className="space-y-4">
              <div className="border border-gray-200 rounded-2xl p-5 flex gap-4 items-start bg-white">
                <div className="w-9 h-9 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
                  <Plug className="w-4 h-4 text-gray-600" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">Conecta tus aplicaciones</h3>
                  <p className="text-sm text-gray-500">Permite que Worgena lea y escriba en las herramientas que ya usas.</p>
                </div>
              </div>

              <div className="border border-gray-200 rounded-2xl p-5 flex gap-4 items-start bg-white">
                <div className="w-9 h-9 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
                  <Briefcase className="w-4 h-4 text-gray-600" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">Crear nuevas habilidades</h3>
                  <p className="text-sm text-gray-500">Enséñale a Worgena tus procesos, normas de equipo y experiencia.</p>
                </div>
              </div>

              <div className="border border-gray-200 rounded-2xl p-5 flex gap-4 items-start bg-white">
                <div className="w-9 h-9 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
                  <Wrench className="w-4 h-4 text-gray-600" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">Crea flujos de trabajo</h3>
                  <p className="text-sm text-gray-500">Orquesta procesos para trabajos complejos.</p>
                </div>
              </div>

              <div className="border border-gray-200 rounded-2xl p-5 flex gap-4 items-start bg-white">
                <div className="w-9 h-9 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
                  <Sparkles className="w-4 h-4 text-gray-600" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">Explorar plugins</h3>
                  <p className="text-sm text-gray-500">Agrega conocimiento prediseñado para tu área.</p>
                </div>
              </div>
            </div>
          )}

          {tab === 'conectores' && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-gray-900">Tus conectores</h2>
              <div className="grid grid-cols-2 gap-3">
                {['Google Drive', 'Gmail', 'Google Calendar', 'Siigo', 'Slack', 'HubSpot', 'DocuSign', 'Dropbox'].map(c => (
                  <div key={c} className="border border-gray-200 rounded-xl p-4 bg-white flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg bg-gray-100 flex items-center justify-center text-xs font-semibold text-gray-600">
                      {c[0]}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{c}</p>
                      <p className="text-xs text-gray-500">No conectado</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'flujos' && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-gray-900">Flujos de trabajo</h2>
              <p className="text-sm text-gray-500">Orquesta procesos para trabajos complejos combinando múltiples habilidades.</p>
              <div className="border-2 border-dashed border-gray-200 rounded-2xl p-12 text-center">
                <Wrench className="w-10 h-10 mx-auto text-gray-300 mb-3" />
                <p className="text-sm text-gray-600 font-medium">Sin flujos aún</p>
                <p className="text-xs text-gray-400 mt-1">Crea tu primer flujo de trabajo para automatizar tareas complejas.</p>
                <button className="mt-4 px-4 py-2 bg-gray-900 text-white text-sm rounded-lg hover:bg-gray-800 inline-flex items-center gap-2">
                  <Plus className="w-4 h-4" />
                  Crear flujo
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
