# Plan de Hardening del Agente Worgena

> **Doc histórico (2026-06-08).** El trabajo activo del sistema agéntico está en [`AGENT_ROADMAP.md`](./AGENT_ROADMAP.md). Este doc se conserva como registro de fixes, benchmark y decisiones cerradas, no como plan vigente.
>
> - **Item 1 (context-manager)**: cerrado y migrado a D2a.
> - **Items 2, 3, 4** (auto-evaluación, hard caps, persistencia de `activeExecutions`): absorbidos en D2a como parte del motor de workflows.
> - **Item 5** (embeddings vectoriales reales): movido a D4-D5.
> - **Item 6** (tests de regresión): continúa en paralelo, no bloqueante.
> - **Item 7** (visual debugger): movido a D3 (cuando entre multi-tenancy).
> - **Item 8** (sub-agents genéricos): replanteado como D2b (specialists de Capa 3 en la arquitectura de 3 capas).

**Fecha de inicio**: 2026-06-08
**Objetivo**: Llevar Worgena del ~45% al 75-80% de un agente profesional estándar 2026
**Tiempo estimado**: 2 días con trabajo focalizado
**Stack actual**: OpenAI SDK + DeepSeek V4 Flash, React 19, SQLite, custom loop agentico en `src/agent/agent.ts`

## Estado general

| Categoría | Worgena actual | Estándar pro | Gap |
|---|---|---|---|
| Gestión de estados | 60% | 100% | Medio |
| Memoria | 50% | 100% | RAG sobre archivos falta, episodic no escala |
| Tools | 60% | 100% | Sin validación outputs, sin retries por tool |
| Planning | 30% | 100% | Solo prompting, no enforced |
| Execution loop | 70% | 100% | Sin paralelismo de tools |
| Human-in-the-loop | 70% | 100% | Sin streaming live, sin timeouts en espera |
| Observabilidad | 50% | 100% | Datos sí, UI no |
| Error handling | 40% | 100% | Sin retries, sin fallbacks |
| Seguridad | 30% | 100% | Sin permisos granulares, sin rate limits |
| Context mgmt | 20% | 100% | Sin truncation, sin budget awareness |
| Concurrencia | 40% | 100% | Sin paralelismo tools, sin locks |
| Sub-agents | 0% | 100% | No existe |
| Testing | 10% | 100% | Solo benchmark ad-hoc |

**Puntuación actual**: ~45% de un agente pro.

## Bugs críticos encontrados en el benchmark (10 runs, 5 tareas)

| Tarea | Rep | Status | Steps | Tokens | Duración | Observación |
|---|---|---|---|---|---|---|
| T1 búsqueda web | 1 | timeout | 7 | 121,597 | 92.7s | Loop infinito, 13 tool calls |
| T1 búsqueda web | 2 | timeout | 9 | 117,956 | 92.1s | Loop infinito, 17 tool calls |
| T2 resumen TXT | 1 | ok | 4 | 22,435 | 21.4s | Determinista |
| T2 resumen TXT | 2 | ok | 4 | 22,104 | 21.7s | Determinista |
| T3 dashboard CSV | 1 | ok | 7 | 59,105 | 56.3s | Variabilidad alta |
| T3 dashboard CSV | 2 | ok | 5 | 39,667 | 47.3s | |
| T4 editar DOCX | 1 | "ok" | 3 | 15,441 | 16.8s | Miente: solo listó, no editó |
| T4 editar DOCX | 2 | error | 4 | 15,228 | 19.8s | Pidió ask_human, falló |
| T5 guardar memoria | 1 | ok | 17 | 107,210 | 81.0s | 5.6x más pasos que rep 2 |
| T5 guardar memoria | 2 | ok | 3 | 15,537 | 13.6s | |

**Conclusiones benchmark**:
- T1: 🔴 Loop infinito en búsqueda web. Sin mecanismo de stop.
- T4: 🟠 LLM miente sobre completar trabajo. No verifica resultados.
- T5: 🟡 Variabilidad 5-7x. Determinismo pobre en tareas con memoria.
- T2: ✅ Tareas simples son deterministas.
- T3: 🟡 Variabilidad media. Aceptable.

## Plan de trabajo (8 items priorizados)

### 1. Context window management — 🔴 CRÍTICO (1-2 días)
**Por qué primero**: Sin esto, el agente se rompe con chats largos en producción.

Tareas:
- [ ] Detectar cuando el prompt > N tokens (e.g. 80K)
- [ ] Summarizar mensajes antiguos (dejar solo system + últimos 5-10 + summary)
- [ ] Mantener coherencia: el summary debe incluir "hechos clave" mencionados
- [ ] Inyectar el summary como un mensaje `role: 'system'` adicional
- [ ] Testear con un chat de 50+ mensajes

Archivos a tocar:
- `src/agent/agent.ts` (función `toOpenAIMessages`, antes de llamar a OpenAI)
- Posible nuevo: `src/agent/context-manager.ts`

### 2. Auto-evaluación del trabajo — 🔴 CRÍTICO (1 día)
**Por qué**: Soluciona el bug de T4 (el LLM miente sobre completar).

Tareas:
- [ ] Después de tools de modificación (write_file, find_replace_text, etc.), forzar una verificación
- [ ] El LLM debe leer el archivo modificado y comparar con el objetivo
- [ ] Si no coincide, retry (máx 2 veces) con mensaje "tu edición no se completó, intenta de nuevo"
- [ ] Solo entonces permitir que el LLM responda al usuario

Archivos a tocar:
- `src/agent/agent.ts` (línea 832, después de ejecutar tools)
- Posible nuevo: `src/agent/self-check.ts`

### 3. Hard cap en búsqueda web — 🔴 CRÍTICO (medio día)
**Por qué**: Soluciona el bug de T1 (loop infinito consumiendo tokens).

Tareas:
- [ ] Contar `search_web` + `read_url` calls consecutivos en la sesión
- [ ] Si llega a 3 sin consolidar, forzar respuesta: "ya tienes suficiente info, responde"
- [ ] Inyectar instrucción en el siguiente prompt: "Has hecho 3 búsquedas. No busques más. Consolida y responde."

Archivos a tocar:
- `src/agent/agent.ts` (líneas 808-870, después de ejecutar tools)
- O en `toOpenAIMessages`: añadir un mensaje al LLM forzando consolidación

### 4. Persistir `activeExecutions` en DB — 🟠 ALTO (medio día)
**Por qué**: Si el server crashea mid-step, la sesión queda colgada.

Tareas:
- [ ] Crear tabla `active_executions` (session_id, started_at, last_heartbeat)
- [ ] Al iniciar step, insertar registro
- [ ] Heartbeat cada 5s durante el step
- [ ] Al terminar (éxito o error), eliminar registro
- [ ] En el startup del server, escanear registros "stale" (> 60s sin heartbeat) y marcarlos como error
- [ ] Liberar la sesión para que el usuario pueda reintentar

Archivos a tocar:
- `src/agent/agent.ts` (líneas 504-515, 543-544)
- Migración nueva en `src/lib/db.ts` para crear la tabla

### 5. Embeddings vectoriales reales — 🟠 ALTO (1 día)
**Por qué**: El brute-force cosine no escala más allá de 1K episodios.

Tareas:
- [ ] Evaluar opciones: pgvector (si migramos a Postgres), o vector DB ligero (Qdrant, Chroma, sqlite-vss)
- [ ] Implementar la opción más simple: probablemente **sqlite-vss** o **vec** (extensión de sqlite)
- [ ] Crear índice sobre `episodic_memory_v2.embedding`
- [ ] Cambiar `searchEpisodicMemory` para usar la búsqueda vectorial en vez de cargar todo
- [ ] Testear con 10K episodios (debe ser < 100ms)

Archivos a tocar:
- `src/agent/memory.ts` (líneas 99-123)
- Migración nueva para crear el índice

### 6. Tests de regresión — 🟠 ALTO (2-3 días)
**Por qué**: Cada cambio en el system prompt puede romper casos. Necesitamos CI.

Tareas:
- [ ] Convertir el benchmark en un test suite automatizado
- [ ] Crear fixtures: 5 tareas canónicas con archivos de prueba
- [ ] Para cada tarea: prompt, run, validar respuesta con criterios simples
- [ ] Umbrales: tiempo máximo, tokens máximos, éxito/fracaso
- [ ] Integrar con CI (cuando exista)
- [ ] Output: reporte HTML o JSON con diff vs baseline

Archivos a crear:
- `tests/agent/benchmark.mjs` (evolución del script que ya existe)
- `tests/agent/fixtures/` con archivos de prueba
- `tests/agent/regression.test.mjs`

### 7. Visual debugger (Observability UI) — 🟡 MEDIO (3-5 días)
**Por qué**: El audit trail es oro, pero sin UI no se aprovecha.

Tareas:
- [ ] Página nueva: `/sessions/:id/debug`
- [ ] Timeline de steps con expandable por step
- [ ] Por step: prompt enviado, respuesta cruda, tool calls, tokens, duración
- [ ] Diff visual entre step actual y baseline
- [ ] Búsqueda por texto en el contenido
- [ ] Filtros: por tool, por éxito/fallo, por rango de tiempo

Archivos a crear/tocar:
- `src/components/DebugSession.tsx` (nuevo)
- Routing en `App.tsx`
- Endpoint nuevo: `GET /api/sessions/:id/full-audit` que devuelve step_logs + tool_calls + messages

### 8. Sub-agents especializados — 🟢 BAJA PRIORIDAD (1-2 semanas)
**Por qué**: Feature importante pero la más costosa. Hacer solo si las 7 anteriores están estables.

Tareas:
- [ ] Diseñar 2-3 sub-agents con system prompts especializados:
  - `InvestigadorWeb`: solo search_web, read_url, browser_action. Output: reporte con fuentes.
  - `EditorDocs`: solo find_replace_text, read_docx_structure, edit_docx_content. Output: documento modificado.
  - `AnalistaDatos`: solo execute_code (Python/pandas), read_file (CSV). Output: análisis + dashboard.
- [ ] Implementar dispatch: el agente principal detecta "esto es para X" y lanza al sub-agent
- [ ] El sub-agent corre, devuelve output, el principal integra
- [ ] UI: el panel de actividad muestra "Main agent lanzó sub-agent X"

Archivos a tocar:
- `src/agent/agent.ts` (loop principal)
- Nuevos: `src/agent/subagents/investigador.ts`, `editor.ts`, `analista.ts`

## Registro de avance

### Sesión 2026-06-08 (sesión actual)

- [x] **Creado este plan**
- [x] **Item 1: Context window management** — completado. Archivos: `src/agent/context-manager.ts` (nuevo), `src/agent/agent.ts` (B5 inflight fix), `src/agent/logger.ts` (B6/B7 plumb), `src/lib/db.ts` (3 columnas via migración segura). Tests: `test_summary_logic.mts` con 12 tests (unit + E2E con mock LLM + concurrencia 50 calls), 12/12 ✓. Detalles de los 7 fixes (B1-B7) en la sección "Contexto del context-manager" más abajo.
- [ ] **Pendiente**: items 2-8

### Contexto del context-manager (referencia futura)

7 fixes del context-manager que se validaron con tests:

- **B1** `serializeMessageForSummarizer` ya no lee timestamp del UUID v4 (era inventado). Usa `idx`.
- **B2** Caso 50K-58K tokens con todo dentro del recent window: return early sin summary vacío.
- **B3** Índice de tokens se calcula sobre `nonSystem` directo (no offset frágil que asume 1 solo system).
- **B4** Try/catch ante ids no-hex o contenido no-string en serializer (defensivo, no propaga).
- **B5** `Map<sessionId, Promise>` en vez de `Set<sessionId>` (fix race condition de stepSession).
- **B6** Nueva columna `step_logs.optimized_messages_count` (cuenta post context-manager).
- **B7** Nuevas columnas `step_logs.summarizer_prompt_sent` y `summarizer_raw_response` (captura forense del resumidor).

Tests notables:
- `testB5_MassiveConcurrency_NoDuplicateStepLogs`: 50 calls concurrentes al mismo sessionId con LLM delay=300ms → 1 sola llamada al LLM, 1 step_log row, 307ms total. Demuestra que el dedupe funciona bajo carga.
- `testE2E_StepSession_PersistsB6B7Columns`: valida JSON parseable en las 3 columnas forenses.
- `testE2E_StepSession_FailsCleanlyWhenSummarizerFails`: confirma que el agente NO propaga la excepción, marca step_log con status=error, agrega msg "An error occurred..." al usuario.

Migración DB: las 3 columnas se agregan con `ALTER TABLE` al primer arranque con la nueva versión. Si la DB ya existía, las nuevas columnas arrancan NULL para rows viejos. Sin acción manual.

### Próxima sesión

(rellenar conforme avancemos)

## Decisiones tomadas

- **NO migrar a Antigravity SDK** ahora. El producto está verde (1 mes), 20-30x más caro en API, 5-7 meses de migración.
- **Endurecer Worgena** es la mejor decisión costo/beneficio a corto plazo.
- **Re-evaluar Antigravity en 6 meses** cuando el producto madure.
- El benchmark manual que corrimos se conserva como base de regression testing.

## Métricas de éxito (KPIs)

Para considerar el plan exitoso:
- [ ] 95%+ de tareas de benchmark completan sin timeout ni error (vs 70% actual)
- [ ] 0 loops infinitos en búsqueda web (T1 fixed)
- [ ] 0% de "miente sobre completar" en tools de edición (T4 fixed)
- [ ] Chats de 50+ mensajes funcionan sin crash (context management)
- [ ] Búsqueda episodic con 10K episodios < 200ms
- [ ] Suite de regression tests corre en CI y detecta regresiones de prompt

## Lo que NO está en este plan (y por qué)

- **Visual debugger completo estilo LangSmith** (3-5 días): el item 7 es una versión mínima, no la suite completa. Si crece, será item 9.
- **Multi-modelo (soporte Claude, GPT)**: tu pricing depende de DeepSeek. Cambiar de modelo base es un proyecto en sí.
- **Migrar a Postgres + pgvector**: depende de si querés moverte de SQLite. Hoy Worgena usa SQLite, y eso tiene sentido para tu escala.
- **Sistema de RBAC (roles, permisos por usuario)**: las herramientas ya están scoped por sesión. RBAC más fino es una feature de producto, no del agente.
- **Code interpreter más avanzado (sandbox propio en vez de E2B)**: complejo, alto costo, poco beneficio inmediato.

## Archivos críticos a revisar antes de empezar

Para familiarizarme con el código:
- `src/agent/agent.ts` (975 líneas) — el corazón
- `src/agent/tools.ts` (1037 líneas) — las 17 tools
- `src/agent/memory.ts` (124 líneas) — core + episodic
- `src/agent/logger.ts` (298 líneas) — step_logs
- `server.ts` — endpoints

## Recursos

- Resultados del benchmark: `C:/Users/acer/AppData/Local/Temp/opencode/bench_results.json`
- Log del benchmark: `C:/Users/acer/AppData/Local/Temp/opencode/bench_log.txt`
- Archivos de prueba: `C:/Users/acer/AppData/Local/Temp/opencode/bench_files/`

## Notas y observaciones

- El usuario (Pedro) prefiere mensajes en español, sin jerga, con analogías concretas.
- El system prompt actual (líneas 44-127) tiene buena estructura MCTS-style, pero no está enforced. Mejorable.
- Hay un bug menor: todos los mensajes del asistente se renderizan como "user" en el frontend (App.tsx). No afecta al backend ni al benchmark.
- AGENTS.md tiene reglas estrictas sobre `<scratchpad>` y `tool_calls` que se deben respetar en cualquier cambio.
