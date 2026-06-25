# Worgena — Roadmap y Arquitectura Agéntica

> Documento vivo. Captura las decisiones arquitectónicas vigentes y el plan de evolución del sistema agéntico de Worgena. Complementa la visión de producto en `PLATFORM_VISION.md` (UI, features, conexiones) y respeta las reglas duras de `AGENTS.md`.

---

## 1. Propósito

Alinear al equipo (humano y agentes) sobre:

- Qué se ha construido y qué falta.
- Las decisiones arquitectónicas vigentes y por qué se tomaron.
- El roadmap D2-D6, con dependencias y orden de ejecución.
- Las reglas de diseño que toda nueva feature debe respetar.

**Regla de mantenimiento**: cuando se tome una decisión arquitectónica nueva, se actualiza este documento **en la misma sesión** que se decide. Las decisiones que no están acá no existen.

**Relación con otros docs** (patrón de dos archivos, vigente en 2026 para instrucciones de agentes):

- `AGENTS.md` = **reglas duras** del proyecto: identidad del producto, estilo, restricciones no negociables, lo que NO se hace. Estable, cambia poco.
- `AGENT_ROADMAP.md` (este doc) = **decisiones arquitectónicas vigentes** del sistema agéntico: cómo se construye, qué se eligió y por qué, qué viene después. Evoluciona con cada sprint.
- Otros docs contextuales: `PLATFORM_VISION.md` (visión de producto, UI, features), `ARCHITECTURE.md` (lecciones aprendidas), `AGENT_DIM_1_SECURITY_PHASES.md` (detalle de D1 cerrada), `AGENT_HARDENING_PLAN.md` (plan de hardening).

Los dos primeros son la "inteligencia base" del agente para este proyecto. El primero es el quién/por qué; el segundo es el cómo.

---

## 2. Contexto del producto

Worgena es un sistema operativo agéntico vertical para firmas legales, contables y de consultoría en Colombia. Inspirado en Harvey AI, pero construido para el mercado colombiano y con workflows configurables por la firma.

**Diferenciador clave**: los workflows son el producto. Cada firma configura sus propios flujos (revisión de contratos, due diligence, demandas, etc.) sobre un motor común.

**Modelo de negocio**: SaaS multi-tenant. Aislamiento de datos por firma. Auditoría completa (qué hizo el agente, con qué permisos, con qué modelo, a qué costo).

**Stack actual** (referencia): OpenAI SDK + DeepSeek V4 Flash, React 19, SQLite (Worgena.db), custom loop agéntico en `src/agent/agent.ts`. Documentado en `ARCHITECTURE.md`.

---

## 3. Estado al cierre de Dimensión 1

**Dimensión 1 — Seguridad** (cerrada el 2026-06-08).

5 items completados, 77 tests pasando:

| Item | Tests | Doc |
|---|---|---|
| Puppeteer sandbox (auto-detect) | 10/10 | `AGENT_DIM_1_SECURITY_PHASES.md` |
| Allowlist de dominios | 16/16 | idem |
| HITL forzado en delete/download | 10/10 | idem |
| Apify cost tracking | 9/9 | `src/lib/apify-tracker.ts`, `test_apify_tracker.mts` |
| Topic-based policies | 12/12 | `src/lib/policy-engine.ts`, `policies.json` |

**Pendientes menores (no urgentes, anotados)**:
- 1.4 API key scoping (1h, en fase futura de hardening)
- UX de confirmación con botones (2-3h, mejora de UX)
- Browser test E2E del HITL (2h, validación empírica)

---

## 4. Trabajo previo en hardening (referencia)

`AGENT_HARDENING_PLAN.md` documenta 8 items para llevar a Worgena del 45% al 75-80% de un agente profesional estándar.

**Cerrado**:
- [x] Item 1: Context window management. 12 tests, 7 fixes B1-B7 documentados.

**Pendiente — decisión sobre qué hacer con cada uno**:

| Item | Decisión propuesta |
|---|---|
| 2. Auto-evaluación del trabajo | **Absorber en D2a** (parte del motor) |
| 3. Hard cap en búsqueda web | **Absorber en D2a** (parte del motor) |
| 4. Persistir `activeExecutions` en DB | **Absorber en D2a** (parte del motor) |
| 5. Embeddings vectoriales reales | Diferir a D4-D5 (memoria y RAG) |
| 6. Tests de regresión | Continuar en paralelo, no bloqueante |
| 7. Visual debugger | Diferir a D3 (cuando haya multi-tenant) |
| 8. Sub-agents especializados | **Reemplazar** por D2b (specialists de Capa 3) |

---

## 5. Decisiones arquitectónicas vigentes

Antes de listar las decisiones, conviene ubicar a Worgena en la taxonomía de 2026. Hay tres niveles que no se deben mezclar:

- **Workflow agéntico**: código determinista con un LLM embebido en algunos nodos (LangGraph, n8n, Temporal).
- **Agente**: LLM que controla el flujo de decisión, con identidad, estado y herramientas.
- **Plataforma agéntica**: el runtime que ejecuta agentes. Provee el loop, contexto, herramientas, permisos, observabilidad.

**Worgena es una plataforma agéntica vertical** para legal. Dentro corren agentes (uno cara al usuario, varios internos como specialists), y cada agente ejecuta workflows agénticos (grafos de código determinista con LLMs en algunos nodos). Analogía: el LLM es el motor, el agente es el vehículo, la plataforma es la carretera más el taller.

Las decisiones que siguen aplican al sistema agéntico de Worgena — no son independientes del producto, lo definen.

### 5.1. Memoria: 4 capas, no 1

Decisión: separar la "memoria" en 4 tipos con infraestructura distinta. Mezclar todo en una sola feature es deuda técnica desde el día 1.

| Capa | Alcance | Persistencia | Quién la escribe | Quién la lee |
|---|---|---|---|---|
| **Working** | Conversación actual, en el context window | Solo runtime | Sistema (auto) | El agente en cada turno |
| **Episodic** | Sesiones previas sobre el mismo caso | Por caso, recuperable por similitud | El LLM al cerrar una tarea | El LLM al abrir un caso existente |
| **Semantic** | Perfil de firma, cliente, preferencias | Por tenant, editable por usuario | El usuario (UI) o el LLM (con confirmación) | El LLM en cada turno |
| **Procedural** | Cómo hace las cosas esta firma (templates, checklists) | Por tenant, editable, versionado | El usuario (editor de skills) | El LLM al cargar un workflow |

**Razón**: cada tipo tiene políticas de retención, costos de retrieval y casos de uso distintos. La semantic y procedural son por tenant (multi-tenant obligatorio). La episodic es por caso. La working es en runtime.

### 5.2. Estado (state machine) ≠ memoria

- **State machine**: vive en una sola tarea. **Minutos a pocas horas. Nunca días.** Lo que el agente está haciendo AHORA.
- **Memoria**: persiste entre sesiones. Lo que el agente SABE.

Las dos cosas están siempre activas para cualquier tarea agéntica, pero son sistemas distintos. Persistencia entre días = memoria episodic, no extensión del state.

### 5.3. Arquitectura de 3 capas (modelo Harvey-like)

Tres capas, cada una con un rol distinto. **No es LangGraph. No es un framework externo. Es un motor propio.**

| Capa | Nombre | Qué hace | Quién la implementa | Sprint |
|---|---|---|---|---|
| **1** | Workflow engine | Ejecuta workflows ya definidos. Recorre el grafo, persiste estado, maneja transiciones, reintenta. | Código determinista en TypeScript (~600-1000 LoC) | D2a |
| **2** | Intake router/planner | Recibe input nuevo, decide QUÉ workflow instanciar y con qué parámetros. Clasifica + configura. | LLM liviano (DeepSeek Flash) | D2a |
| **3** | Specialist agents | Ejecutan nodos específicos del workflow. Cada uno con prompt corto, tools acotadas, contexto limpio. | LLMs por nodo (liviano o robusto según el nodo) | D2b |

**Analogía**: restaurante.
- **Capa 2 = el mesero.** Llega un cliente. El mesero pregunta qué quiere, anota en el ticket con la configuración, y lo manda a la línea correcta. **No cocina, no decide la receta, no improvisa el plato.**
- **Capa 1 = la cocina con sus protocolos.** Una vez que el ticket dice "paella, mesa 5, sin mariscos", la cocina sigue el protocolo predefinido: calentar → sofreír → arroz → reposar → servir. Cada paso es determinista.
- **Capa 3 = los cocineros especialistas.** Fogonero, salsero, parrillero. Cada uno con su prompt corto ("sos el fogonero, tu trabajo es sofreír"), sus tools acotadas, y su contexto limpio (solo lo necesario para tu paso).

### 5.4. Custom DSL para workflows (NO LangGraph)

**Decisión**: construir un motor de workflows propio, con un DSL ligero (YAML/JSON schema) y un executor en TypeScript.

**Por qué NO LangGraph**:

1. **Vendor lock-in gradual.** Sus primitivas (`StateGraph`, `channels`, `configurable`, `Send`/`Command`, `interrupt`) se filtran al código. Cuando quieras migrar a otro runtime, reescribís todos los workflows.
2. **Los workflows SON el producto.** El motor que los ejecuta es parte del IP. Tercerizarlo hipoteca el futuro del producto.
3. **El DSL propio no es tan caro como parece.** Schema YAML/JSON + ~600-1000 LoC de executor = velocidad de iteración sin dependencia externa.
4. **LegalTechs serias lo hacen.** Harvey, Casetext, y la mayoría de los LegalOps internos grandes escriben su propio motor. No por capricho, sino porque el motor termina definiendo qué clase de workflows se pueden expresar.

**Lo que SÍ construimos en D2a**:
- Schema YAML/JSON para definir workflows.
- Executor en TypeScript (~600-1000 LoC): grafo runner, state transitions, persistence, recovery, reintentos, idempotencia, schema versioning, time-travel mínimo.
- HITL primitives: nodos de pausa, approvers, resume con feedback.
- Observability hooks: logs por nodo, trace ID, métricas.

**Lo que NO construimos en D2a** (llegará cuando duela):
- Workers distribuidos, scheduling complejo, cron-like.
- Time-travel UI fancy (sí guardamos snapshots, pero la UI es para después).
- Saga patterns, compensación distribuida.
- Múltiples approvers en paralelo, timeouts con escalation.

### 5.5. Multi-model routing desde el día 1

El producto es multi-modelo desde D2, con tiers diferenciados por tipo de nodo:

| Tier | Modelo | Uso | Razón |
|---|---|---|---|
| Liviano (Tier 3) | DeepSeek V4 Flash | Intake router, clasificadores, extractores, verificadores simples | Costo y latencia |
| Robusto (Tier 1) | MiniMax M3 Thinking | Razonamiento jurídico, generación de outputs de alto riesgo, análisis complejos | Calidad de razonamiento |

**Reglas, no improvisación**: el router por tipo de nodo es determinista (config + reglas), no un LLM decidiendo en runtime. Se mide, se ajusta, se versiona.

**Productos reales de LLM Gateway** (referencia para D2b, no bloqueante para D2a): OpenRouter (Worgena ya lo usa — `OPENROUTER_API_KEY` en `.env`), Not Diamond, Martian, Portkey, LiteLLM, Unify. Hoy Worgena invoca DeepSeek directo; cuando crezca el catálogo de modelos o aparezcan necesidades de routing dinámico, se evalúa un gateway.

**Tiers con casos reales** (no son abstractos):

| Tier | Modelos | Uso |
|---|---|---|
| Tier 3 (liviano) | DeepSeek V4 Flash, Gemini Flash, Haiku, GPT-4o-mini | Intake, clasificación, extracción, verificación simple |
| Tier 2 (especializado) | Embeddings (BGE-M3, local en Nitro), visión, código (Codestral, Qwen-Coder) | Embeddings, análisis de imágenes, code-specific |
| Tier 1 (robusto) | MiniMax M3 Thinking, Opus, GPT-5, Gemini Thinking | Razonamiento jurídico, generación crítica |

Worgena hoy usa Tier 1 y Tier 3 directamente. Tier 2 se introduce cuando lleguen los embeddings reales (D4-D5).

**Decisión de hosting de embeddings** (2026-06-15, ver `HANDOFF.md`): Tier 2 corre BGE-M3 **local en el hardware del founder** (Acer Nitro V15, 16GB RAM, 4GB VRAM, ONNX fp16, ~50 chunks/seg). Razones: 4GB VRAM alcanza justo para fp16 (~1.1GB modelo), costo $0, latencia aceptable para ingesta batch; self-host GPU cloud o HF Inference son forward-compat si el volumen crece. La interface `OpenRouterClient.embeddings()` queda como abstracción compatible.

**Patrones de fallback**:

- **Circuit breaker**: si un modelo falla N veces consecutivas, se le retira temporalmente del pool. Patrón de resilience.
- **Coste-based fallback**: si Tier 1 excede presupuesto o timeout, baja automáticamente a Tier 2/3 sin que el usuario lo note.

**Diferencia con `PLATFORM_VISION.md` §2.1 (Fast/Pro)**: el toggle Fast/Pro que ve el usuario es el selector de modo general de la sesión. El routing interno multi-modelo por nodo es decisión técnica del motor, invisible al usuario. Ambos coexisten.

### 5.6. Verificador en sub-sesión, NO en el mismo loop

Para outputs de alto riesgo (contratos, borradores, análisis legales), el verificador:

- Es un subagente en **sesión nueva**, sin acceso al contexto del productor.
- Razona con prompts limpios, sin el sesgo confirmatorio del productor.
- Tiene tools de apoyo (buscar en docs, validar formato, comparar), pero **el LLM es el rey**, las tools son las manos.
- La sub-sesión usa el mismo modelo y proveedor (1 sola API, 1 sola factura), solo cambia el contexto.

**Razón**: el sesgo confirmatorio del mismo contexto hace que el "verificador" termine validando lo que el productor dijo, no lo que la fuente dice. La separación de sesión lo elimina sin duplicar complejidad operacional.

### 5.7. Tool, Skill y Subagente: tres cosas distintas que se confunden

Conceptos cercanos pero conceptualmente diferentes. Mezclarlos genera código acoplado y debug imposible.

| Concepto | Qué es | Tiene LLM propio | Cuándo se carga | Quién decide |
|---|---|---|---|---|
| **Tool** | Función pura, sin razonamiento. Recibe input, devuelve output. | No | Siempre disponible según permisos | El LLM elige cuál invocar (ReAct) |
| **Skill** | Paquete versionado de instrucciones + código + recursos. Carga instrucciones y capacidades, no razonamiento. | No | Cuando la tarea lo requiere (pre-loop, no in-loop) | El router (Capa 2) o el usuario (manual) |
| **Subagente** | Agente hijo con contexto limpio, hace su trabajo y reporta al padre. | Sí (liviano o robusto) | Cuando el orquestador lo lanza | El orquestador o el LLM padre |

**Patrón "agents-as-tools"**: un subagente se expone como tool llamable, y el agente orquestador decide cuál invocar según el problema. Es el patrón dominante en 2026 para composición de agentes.

**Aplicación a Worgena**:

- **Tools**: las 17 que ya están en `src/agent/tools.ts` (search_web, read_file, apify, ask_human, etc.). Siguen existiendo.
- **Skills**: las topic-based policies de D1 evolucionan a skills v1 en D2c. Versión 1 = formalizar el packaging; versión 2 = permitir que el usuario las edite (D6).
- **Subagentes**: los specialists de Capa 3 (D2b). Empezamos con 2-3: `intake_specialist`, `clause_reviewer_specialist`, `verifier_specialist`.

### 5.8. MCP para tools, DSL propio para workflows (separación importante)

Las **tools** y los **workflows** son cosas distintas. Worgena usa el estándar correcto para cada uno.

- **Tools** → estándar **MCP (Model Context Protocol)**. Un servidor MCP expone resources (datos), tools (funciones) y prompts (plantillas). El agente las descubre dinámicamente. En 2026 es el estándar de facto (Anthropic, Google, OpenAI lo adoptaron).
  - **Decisión para D2b**: ¿Worgena expone sus tools como MCP server, consume tools MCP de terceros, o ambos? Mi recomendación: empezar consumiendo (no urgente exponer). Exponer queda para cuando haya partners que quieran integrarse.
- **Workflows** → **DSL propio** (no MCP, no LangGraph). Los workflows son el producto, no las tools individuales. Ver §5.4.

**Razón de la separación**: el asset que vendemos son los workflows, no las tools genéricas. Las tools son commodity (cualquier agente tiene search_web, read_file, etc.). Los workflows configurables por la firma son lo diferencial.

### 5.9. Identidad del agente, lifecycle y costo atribuible

Concepto nuevo y formalizado en 2026. Hoy Worgena no lo tiene; entra en D2b y se formaliza en D3 con multi-tenancy.

- **Agent ID + Agent Card**: cada agente (cara al usuario, specialists, intake router, verifier) tiene un ID estable y un "card" que declara qué hace, qué tools usa, qué versión es. Inspirado en A2A de Google (JSON tipo OpenAPI). Habilita auditoría y composición.
- **Lifecycle**: `spawn → idle → busy → paused → done → archived`. El motor trackea el estado de cada agente. El "paused" es clave: cuando un HITL pausa un workflow, el agente asociado queda paused hasta que el humano responda.
- **Costo atribuible**: tokens consumidos, tiempo de ejecución, recursos externos (Apify, etc.) — todo por Agent ID, por Task ID, por Tenant ID. Habilita pricing por uso y auditoría de costo por firma.

**Aplicación a Worgena**:

- Worgena (cara al usuario) tiene su Agent Card con capabilities declaradas.
- Cada specialist de Capa 3 tiene su propia card. Útil para que el orquestador decida cuál lanzar y para que un humano entienda "qué agente hizo qué".
- D3 introduce el `tenant_id` en cada Agent Card, separando instancias por firma.

### 5.10. Bus de comunicación y memoria compartida entre specialists

Los specialists (Capa 3) **no comparten memoria por defecto**. Cada uno corre con contexto limpio (es lo que elimina el sesgo confirmatorio del verificador).

**Cómo colaboran cuando lo necesitan**:

- **Patrón secuencial (pipeline)**: A pasa output a B vía el output del workflow. Sin estado compartido.
- **Patrón fan-out/fan-in**: el orquestador lanza N specialists en paralelo, agrega resultados. Cada uno corre aislado.
- **Handoff**: un specialist pasa la tarea a otro, transfiriendo memoria y contexto explícitamente.
- **Producer/Verifier**: el productor y el verificador corren en sesiones distintas. El output del productor se pasa al verificador como input, sin memoria de proceso.

**Bus de comunicación**:

- **In-process** (hoy): canales tipados en memoria entre los componentes del motor.
- **Cross-process** (futuro, si distribuimos): eventos asíncronos sobre HTTP/WebSocket con colas ligeras. No Kafka todavía.
- **MCP también funciona como bus de tools**, no de mensajes entre agentes. Distinción importante.

**Memoria compartida**: cuando dos specialists necesitan "saber lo mismo", la respuesta no es memoria compartida, es pasar el output explícitamente. La memoria persistente vive en el motor (Capa 1), no en runtime entre specialists.

### 5.11. Patrones de orquestación disponibles (referencia)

Catálogo de patrones reconocidos. Worgena empieza con dos; el resto queda disponible para workflows futuros.

| Patrón | Descripción | Uso en Worgena |
|---|---|---|
| **Secuencial (pipeline)** | A → B → C, cada uno alimenta al siguiente | **Sí** — workflow base (`classify → extract → summarize → approve`) |
| **Producer/Verifier** | Un agente produce, otro verifica en sesión nueva | **Sí** — subagente verificador (D2b) |
| **Fan-out/Fan-in** | N agentes en paralelo, resultados agregados | **Cuando** — para extracción paralela de cláusulas de un contrato largo |
| **Handoff** | Un agente pasa la tarea a otro con memoria y contexto | **Cuando** — para escalación de intake a specialist |
| **Jerárquica** | Un supervisor delega y revisa subordinados | **No por ahora** — overhead no justificado |
| **Group-chat** | Agentes conversan hasta consenso | **No** — overhead de coordinación, no es el caso de uso |
| **Swarm** | Muchos agentes pequeños con presupuesto compartido | **No** — no aplica al dominio |

### 5.12. Confidence Gating (comportamiento de nodo)

Inspirado en PAKTON Interrogator, adaptado a la arquitectura de 3 capas. Es un comportamiento del agente en cada nodo, no una capa nueva.

**Regla**: después del paso de razonamiento interno de un nodo, el agente asigna un nivel de confianza explícito (HIGH / MEDIUM / LOW) y actúa según la regla.

| Confianza | Acción |
|---|---|
| **HIGH** | Entrega el output del nodo y avanza al siguiente paso. |
| **MEDIUM** | Busca más información antes de avanzar (otra tool call, más retrieval, pedir contexto adicional). |
| **LOW** | Pide clarificación al usuario. No adivina. Si es un nodo crítico, escala a HITL. |

**Aplicación a Worgena**:

- Cada specialist (Capa 3) emite un confidence level al cerrar su nodo.
- El workflow engine (Capa 1) puede decidir si continuar, escalar a MEDIUM buscando más info, o pausar para HITL si es LOW.
- El intake router (Capa 2) usa confidence gating para decidir si el input es ambiguo y debe pedir clarificación antes de instanciar un workflow.
- La confianza se loguea por nodo (parte de la observabilidad de D2a.3).

**Diferencia con el "verifier en sub-sesión"** (§5.6): confidence gating es **interno al agente que produce** (¿estoy seguro de lo que voy a decir?). El verifier es **externo** (¿lo que dijo el productor es correcto contra la fuente?). Son capas distintas, no redundantes.

### 5.13. Citation Grounding v2 (verificación de texto y metadatos)

Caso específico del verificador en sub-sesión (§5.6) para el dominio jurídico. La diferencia con un Citation Grounding genérico es que en legal una cita puede referirse a **dos cosas distintas** y el verificador debe tratarlas diferente.

**Tipos de cita jurídica**:

1. **Cita a texto de una unidad** (ej. "el Artículo 5 establece que..."). El verificador extrae el texto real con `read_section(doc_id, inicio, fin)` y compara la afirmación contra el texto extraído.
2. **Cita a un metadato del documento** (ej. "el Decreto 1080 fue derogado por la Ley 2297"). El verificador consulta el flag `derogado_por` en el Índice Documental, no el texto del artículo. Buscar "derogada" en el texto del artículo sería incorrecto.

**Cómo lo hace el verificador**:

1. Para cada cita, determina el tipo (texto vs metadato) según el `field` que cita: si la cita es `[Doc X, rango 1234-5678]` → texto; si es `[Doc X, derogado_por: 'Ley 2297']` → metadato.
2. Extrae la fuente real: `read_section(doc_id, inicio, fin)` para texto, o `db.query(metadato)` para el flag.
3. Un LLM en **sub-sesión limpia** (mismo patrón que §5.6) recibe afirmación + fuente real y determina si la afirmación se sostiene.
4. Si una cita no pasa, el agente principal recibe el flag y corrige (máximo 2 rondas).
5. Si tras 2 rondas una cita sigue sin pasar, se entrega con advertencia explícita.

**Aplicación a Worgena**:

- Worgena ya tiene Citation Grounding v1 implementado (ver `PLATFORM_VISION.md` §3.2 Paso 7). La versión 2 agrega el manejo de citas a metadatos, que es crítico para derecho colombiano (derogaciones, modificaciones, vigencias).
- Entra como mejora del verificador en D2b, no como feature nueva.

### 5.14. Principios de interpretación jurídica colombiana (约束 del agente)

El sistema agéntico de Worgena opera en derecho colombiano. El motor, el verificador y el multi-modelo son agnósticos al dominio — los principios jurídicos viven en **el prompt/skill del agente que ejecuta el nodo**, no en el motor.

Estos principios se cargan como parte del system prompt del specialist jurídico (clause_reviewer_specialist, intake_specialist jurídico, verifier_specialist jurídico) o como una skill de dominio.

**Principios vigentes** (de `PLATFORM_VISION.md` §3.2 Fase B Paso 0, formalizados aquí):

1. **Ley posterior prevalece sobre la anterior**. Si dos normas regulan la misma materia de forma contradictoria, la más reciente deroga a la anterior en lo que le sea contraria.
2. **Ley especial sobre ley general** (con matiz colombiano, distinto a España). En Colombia la regla invertida del art. 3 CC aplica: la ley especial derogala ley general solo si es anterior y posterior la general, salvo derogación expresa.
3. **Derogación tácita vs expresa**:
   - **Expresa**: la norma nueva dice "deroga X". Aplica aunque sea general derogando especial.
   - **Tácita**: la norma nueva cubre la misma materia sin decirlo. Requiere verificar incompatibilidad material.
4. **Jerarquía de normas** (constitucional sobre legal, ley sobre decreto, etc.). El specialist jurídico debe respetar el orden jerárquico al resolver antinomias.
5. **Vigencia y ultraactividad**: una norma derogada puede seguir rigiendo situaciones jurídicas concretas nacidas bajo su vigencia. El verificador de vigencia debe distinguir "derogada" (no aplica a futuro) de "no vigente para nuevas situaciones" (puede aplicar a hechos pasados).

**Mecanismo de aplicación**:

- Los principios se inyectan en el prompt del specialist jurídico, NO en el código del motor.
- Son auditables: cada vez que un specialist aplica uno, se loguea qué principio usó y por qué.
- Se versionan junto con la skill que los contiene.
- Una firma puede **extender o sobrescribir** los principios en su propia skill (ej: "para nuestro bufée, en contratos de arrendamiento, la cláusula X se interpreta según Y") — esto entra en D6.

**Razón de vivir en el agente, no en el motor**: el motor es genérico. Si mañana Worgena se expande a contabilidad o derecho laboral, los principios del motor no cambian; lo que cambia es la skill del specialist cargado.

### 5.15. Posición sobre "Code as interface" / SaC

**Decisión (vigente desde 2026-06-10, revisada 2026-06-12)**: el motor de workflows (Capa 1) **NO usa el patrón SaC** (LLM escribe-ejecuta código en sandbox) como primitiva central. Es decisión de Capa 3, no de Capa 1.

**Qué es SaC (resumen ejecutivo)**: el patrón "code as interface" o "sandboxed code as interface" (productizado por Perplexity en 2026, académicamente de la línea CodeAct) reemplaza tool-call individual por un sandbox donde el LLM escribe un script que invoca primitivas pre-construidas (`search()`, `fetch()`, `deduplicate()`). El resultado: menos rounds con el LLM, menos tokens consumidos, mayor accuracy en research estructurado. El patrón no es conceptualmente nuevo, pero su productización como capacidad de consumo es genuina.

**Aclaración importante (revisión 2026-06-12)**: el script SaC **NO hace razonamiento cualitativo por sí solo**. El razonamiento lo hace el LLM **invocado como primitiva dentro del script** (ej: `llm.classify(text, schema)`). El script es un **orquestador** de invocaciones al LLM + agregación de resultados. Sin esa distinción, parece que el script "piensa solo" — no es así. Lo que el script optimiza es la **orquestación** de muchas invocaciones al LLM bajo un plan explícito, sin que el motor tenga que re-evaluar el plan en cada paso.

**Por qué NO en el motor (Capa 1)**: el motor de workflows es determinista por diseño (regla 6: motor propio, no frameworks externos que filtran primitivas al código). Adoptar SaC en el motor introduce no-determinismo (el LLM escribe código que se ejecuta en runtime), rompe la auditabilidad legal (un script de 200 líneas ejecutado no es trazable nodo-por-nodo), y compromete el principio de orden fundamental (regla 6b: el motor cierra primitivas primero; SaC depende de primitivas cerradas).

**Por qué SÍ en D2b (Capa 3)**: el caso de uso de Worgena (auditar 100+ contratos en lote, cruzar 50 estados financieros, investigar jurisprudencia) es exactamente research estructurado. La capacidad se monta como un specialist que el motor invoca como caja negra con timeout, idéntico al patrón HITL. El motor NO cambia.

**Posición arquitectónica**:

- **Scripts viven en subagente (Capa 3)**, no en motor (Capa 1).
- **El motor solo invoca al specialist** como un nodo `function`/`llm` con timeout. La variabilidad de duración (el script puede correr minutos) vive en el subagente, no en el workflow.
- **Predecibilidad del motor se preserva**: el motor trata al subagente como caja negra. "Este nodo retorna output estructurado en N min o falla." Idéntico al patrón HITL.
- **API cerrada (no Python genérico)**: el LLM compone primitivas, no programa Python arbitrario. `search(query, limit, domain_filter)`, `fetch(url)`, `extract_structured(content, schema)`, `llm.classify(text, schema)` (el LLM como primitiva — ver aclaración arriba), `save(data, key)`. Componible, no programable.

**Cuándo SÍ vs cuándo NO (revisión 2026-06-12)**: la regla anterior era "tareas simples (<10 tool calls) NO valen el overhead de spawn de sandbox". La distinción más precisa es **el patrón de razonamiento**, no el conteo de tool calls:

| Caso | ¿SaC ayuda? | Por qué |
|---|---|---|
| Clasificar 500 contratos por tipo (independientes entre sí) | **No** (batching alcanza) | Cada unidad es independiente. El LLM no necesita ver los resultados de las otras para clasificar la actual. |
| **Agrupar 500 contratos ya clasificados por patrón emergente de cláusulas, contar, rankear** | **Sí** | Requiere ver el resultado de muchas unidades para re-clasificar/comparar/agregar. El script orquesta N invocaciones a `llm.classify()` + agrega. |
| Extraer cláusulas de 500 PDFs y deduplicar | **Sí** | Deduplicación es mecánica pero necesita comparación cruzada entre miles de items. |
| Investigar 500 sentencias, buscar contradicciones entre ellas | **Sí** | Requiere iteración cruzada con razonamiento por cada par o grupo. |
| 1-5 documentos, análisis legal profundo caso por caso | **No** (tools individuales suficientes) | El motor ya maneja este caso sin overhead de sandbox. |

**El patrón clave**: SaC gana cuando el razonamiento cualitativo necesita **ver el resultado de muchas unidades para re-clasificar, comparar o agregar** (iteración cruzada). NO gana en clasificación independiente por-unidad (batching alcanza).

**Relación con batching y RAG (no compiten, se complementan)**:

- **RAG** recupera los documentos relevantes de un corpus grande (ej: 3,000 → 500).
- **Batching** procesa en paralelo unidades independientes (ej: 50 contratos por prompt).
- **SaC** (cuando aplica) itera cruzando resultados, invocando al LLM como primitiva y agregando.

Un workflow completo con SaC usa las tres cosas en secuencia: RAG busca, batching pre-clasifica, SaC itera sobre el resultado. El script SaC **internamente** puede llamar a primitivas de RAG (`search()`) y batching (`batch_process()`) si están expuestas.

**Por qué no reemplaza a batching/RAG**: son del motor (Capa 1), auditable nodo por nodo. SaC es del specialist (Capa 3), opaco para el motor. No compiten; resuelven problemas distintos en capas distintas.

**Defensa en profundidad (en orden de importancia)**:

1. **API cerrada (PRINCIPAL)**: el LLM solo invoca primitivas pre-definidas. Esto elimina ~90% de los vectores de ataque. Si el LLM no puede escribir `os.system()` ni `requests.get()` arbitrarios, no hay escape.
2. **Validación de inputs en cada primitiva**: `fetch(url)` rechaza URLs fuera de allowlist. `search(query, limit)` rechaza `limit > 100`. `extract_structured` valida el schema antes de procesar.
3. **Rate limiting y presupuestos por task**: contador de primitivas invocadas (cap configurable, default 50). Budget de tokens/USD por task. Si excede, aborta. Sin esto, el LLM puede iterar infinitamente dentro del sandbox.
4. **Sandbox a nivel sistema (red de seguridad)**: container con AppArmor/seccomp, filesystem read-only excepto directorio efímero por task, network limitado a allowlist, CPU/memoria cap. Esto protege contra escape de proceso, NO contra uso indebido dentro del proceso. Por eso es la capa 4, no la 1.

**Audit legal (no negociable en legal colombiano)**:

- **Dos capas de auditoría, no una** (revisión 2026-06-12):
  - **Capa motor (transparente)**: el motor audita el output del specialist como cualquier nodo (output estructurado, duración, tokens atribuidos, costo). El motor NO sabe que adentro hubo 200 invocaciones al LLM — para él fue un nodo opaco que devolvió JSON.
  - **Capa specialist (opaca para el motor, registrada)**: cada script ejecutado persiste con hash, output completo, trace de primitivas invocadas, cada invocación al LLM con su prompt y response, duración, tokens consumidos por sub-invocación, costo atribuido. Es parte del audit trail del caso, pero el motor no la inspecciona — la consume el equipo de audit/QA cuando lo necesita.
- **Matiz de "auditable" (revisión 2026-06-12)**: el script SÍ se registra y se puede revisar. Pero auditar 200 líneas de código generado por el LLM cuesta ~10x más que auditar 50 tool calls con sus mensajes. La barra de "auditable" en legal colombiano requiere que un abogado (no programador) pueda seguir el razonamiento — eso es trivial con tool calls, costoso con scripts. Por eso SaC vive en Capa 3 (donde el equipo de audit puede invertir ese coste) y no en el motor (donde todo es nodo-por-nodo y debe ser entendible sin programar).
- **Producer-verifier del script antes de ejecutar**: el script que escribe el LLM productor va a un LLM verificador en sub-sesión limpia (mismo patrón que §5.6). El verificador simula mentalmente la ejecución y responde: "este script hace lo que dice, no tiene side effects raros, los límites están bien". Si falla, vuelve al productor con feedback. **Máximo 2 rondas** (definido en §5.6). Costo: ~30% más de tokens por task. **Vale cada centavo en legal** — es lo que separa demo impressive de producto defendible ante un juez.
- **Filesystem efímero por task**: garbage-collected al cerrar. Si persiste, hay riesgo de data leak entre tasks de distintos clientes en multi-tenant.
- **Sin esto, el producto no es defendible**: en legal, un script del LLM que toca 50 herramientas y dice "no hay cláusulas abusivas" sin trazabilidad completa es inutilizable. Un abogado no puede defender "la IA dijo esto" sin el código que ejecutó.

**Comparación con Perplexity (revisión 2026-06-12)**: Perplexity productizó SaC para research genérico (competir con Google en respuestas con citas). El caso de uso: "¿quién ganó el mundial del 86?". El costo de un script malo en Perplexity: una respuesta incorrecta que el usuario descarta. El costo de un script malo en Worgena: un abogado puede perder un caso porque la IA firmó un análisis que no era correcto, y el log dice "ejecutó un script que el defensor legal no puede defender fácilmente". **Worgena optimiza por defensibilidad legal; Perplexity optimiza por velocidad de respuesta.** Mercados con tolerancias al riesgo distintas justifican arquitecturas distintas. SaC no es "bueno" o "malo" — es una herramienta con un perfil de riesgo distinto para mercados distintos.

**Regla de cuándo NO usar SaC (revisión 2026-06-12)**: ver tabla "Cuándo SÍ vs cuándo NO" arriba. La heurística simple: si el razonamiento cualitativo por-unidad NO depende de los resultados de las otras unidades, batching alcanza y SaC es overhead. Si el razonamiento necesita re-evaluar después de ver el agregado, SaC gana.

**Trade-off de sandboxing a resolver antes de implementar** (decisión técnica, no arquitectónica): pyodide (escape vectors reportados en versiones viejas), subprocess con resource limits (recomendado para empezar, menos seguro), container (más seguro, más caro en infra). Esta decisión se toma en D2b cuando se implemente el specialist, no antes.

**Trigger para implementar**: cuando un cliente pida auditar 100+ contratos en lote, cruzar estados financieros a escala, o investigación jurisprudencial exhaustiva. Antes, no urgencia. **No es feature de D2a**, **es feature de D2b o D2c según demanda real**.

**Riesgos pendientes para D2b (no resueltos acá)**:

- **Cost accounting**: si el LLM itera 5 veces dentro del sandbox antes de devolver, ¿cómo se mide el costo? ¿Por tokens del specialist, por uso de CPU del sandbox, por cantidad de primitivas invocadas? Pricing pendiente.
- **Compliance multi-tenant**: el código que escribe el LLM procesa datos de clientes de la firma. El sandbox debe garantizar aislamiento entre tasks de distintos tenants.
- **Observabilidad**: cada ejecución de script genera logs estructurados que se integran con el audit log del caso. La UI de debug es D3+.

**Referencias cruzadas**:

- §5.3 (3 capas): el specialist vive en Capa 3.
- §5.6 (verificador en sub-sesión): patrón producer-verifier del script.
- §5.7 (tool/skill/subagente): el `pythonSandbox` sería un tool; el `investigator_specialist` es un subagente.
- §5.13 (Citation Grounding v2): el verificador de citas jurídicas también puede usar primitivas de este specialist para validar fuentes.
- §6.1.D2b: cuando se implemente, esta sección es el lineamiento.

## 6. Roadmap de Dimensiones

| # | Dimensión | Esfuerzo | Bloquea a | Estado |
|---|---|---|---|---|
| 1 | Seguridad (sandbox, allowlist, HITL, costs, policies) | cerrado | D2 | ✅ 77 tests |
| **2** | **Harness + workflows + multi-model** | **~12h (D2a: 8-10h, D2b: 3-4h)** | **D3, D4, D5, D6** | **Pendiente — próximo** |
| 3 | Multi-tenant + auditoría completa | 5-7h | D4, D5, D6 | Pendiente |
| 4 | Memoria 4 capas | 5-7h | D5, D6 | Pendiente |
| 5 | RAG sobre docs de la firma | 7-9h | D6 | Pendiente |
| 6 | Skills + workflows personalizables (editor por firma) | 4-6h | — | Pendiente |

### 6.1. Dimensión 2 desglosada

#### D2a — Motor de workflows propio

**Sprint partitioning** (partido en 2 sprints cortos con checkpoint entremedio):

| Sprint | Sub-items | Esfuerzo |
|---|---|---|
| **D2a-S1** (5-6 días) | 2a.1 + 2a.2 + 2a.3 (schema + executor + observabilidad) | 5-6 días |
| Checkpoint | Validar que el motor hace lo esperado antes de invertir en el workflow completo. | — |
| **D2a-S2** (3-4 días) | 2a.4 + 2a.5 + 2a.6 (HITL + workflow + tests) | 3-4 días |

| Sub-item | Qué | Esfuerzo |
|---|---|---|
| 2a.1 Schema + tipos | Workflow como data, JSON schema + TypeScript types, versionado | 1 día |
| 2a.2 Executor mínimo | Grafo runner, state transitions, persistence, recovery, reintentos | 3-4 días |
| 2a.3 Observabilidad | Logs por nodo, trace ID, métricas, integración con audit log | 0.5 día |
| 2a.4 HITL primitives | Nodos de pausa, resume con feedback, integración con HITL existente (D1) | 0.5 día |
| 2a.5 Workflow de ejemplo | Uno real end-to-end, ultra-simple | 1-2 días |
| 2a.6 Tests del motor | Cobertura del executor, integration tests | 1 día |

#### Observabilidad: OpenTelemetry y productos de referencia

2a.3 deja los **hooks** de observabilidad en el motor (logs estructurados, trace ID, contadores). El producto de observabilidad dedicado se elige en D3 cuando entre multi-tenancy y necesitemos una UI de debugging.

**Stack de referencia** (no se instala en D2a, queda como decisión para D3):

- **OpenTelemetry para LLMs** (estándar): OpenLLMetry instrumenta cada tool call como un span, cada turno del loop como un trace. Vendor-neutral.
- **Productos comerciales** (alternativas evaluables en D3): Langfuse, LangSmith, Helicone, Phoenix/Arize. Cada uno con su trade-off de costo, lock-in, y features de debugging.

**Métricas mínimas a trackear desde D2a**:

- Tokens consumidos por nodo y por task.
- Latencia por paso del workflow.
- Tasa de éxito por tool (cuántas veces se llamó vs cuántas fallaron).
- Tasa de citas no verificadas por el Citation Grounding (cuando entre en vigor).
- Costo atribuido por Agent ID, Task ID, Tenant ID.

Sin esto, "construir un agente en producción" es tirar a ciegas.

#### Detalles críticos del motor (no negociables)

Tres primitivas que son la diferencia entre "motor de demo" y "motor de producción":

1. **Idempotencia de nodos**. Un nodo que se ejecuta dos veces (por retry) debe producir el mismo resultado o **fallar explícitamente**. Sin esto, los reintentos corrompen estado silenciosamente. La diferencia entre un motor que se puede re-ejecutar con confianza y uno que no.

2. **Time travel / replay mínimo**. Snapshot del input + log de outputs por nodo. Sin UI fancy, pero con la capacidad de re-ejecutar un workflow con inputs distintos para comparar. Crítico para debug de redlines legales (comparar "qué pasó con esta cláusula bajo el workflow v1 vs v2").

3. **Versionado del schema**. Campo `schemaVersion` en cada workflow persistido + migrator. Cuando el schema cambie, las migraciones se aplican al cargar workflows viejos. Una hora de implementación, evita días de debugging en producción.
4. **Circuit breaker por agente/specialist**. Si un specialist falla N veces consecutivas (config: N=3 por defecto), se le retira del pool temporalmente y los workflows que lo requerían se reasignan o escalan. Patrón de resilience. Sin esto, un specialist roto (por bug o por un modelo que dejó de responder) tira abajo workflows de muchos usuarios en cascada.

#### Workflow de ejemplo (D2a.5)

**Decisión**: ultra-simple, no el más representativo.

Razón: si empezamos con arrendamiento (cláusulas especiales: renovación tácita, fianzas, garantías), el motor se deforma para encajar y la abstracción queda narrow.

**Workflow genérico de prueba**: `classify → extract → summarize → approve`.

- 4 nodos.
- Sin paralelismo.
- Sin condicionales complejas.
- Sirve para validar el motor, no para producción.

**Cuándo elegimos el segundo workflow**: con un workflow real a cuestas (después de D2a cerrado), ahí sí podemos elegir el representativo (arrendamiento, NDA, demanda laboral). La abstracción se generaliza con un segundo caso.

#### Metodología spec-first

Antes de tocar TypeScript, escribimos un `.md` con el schema propuesto:
- Tipos TypeScript + JSON schema.
- Ejemplos de workflows concretos.
- Edge cases (qué pasa si un nodo falla, si el workflow se re-ejecuta, si cambia el schema).
- Decisiones de diseño abiertas.

Lo revisamos juntos. Después codeamos con la spec como contrato.

### 6.2. Dimensión 2b — Multi-model + especialistas

| Sub-item | Qué | Esfuerzo |
|---|---|---|
| 2b.1 Multi-model router | Tier liviano (DeepSeek flash) vs robusto (M3 thinking), reglas por tipo de nodo, versionado | 1h |
| 2b.2 Specialist agents v1 | 2-3 especialistas: `intake_specialist`, `clause_reviewer_specialist`, `verifier_specialist`. Prompt corto, tools acotadas. | 1.5h |
| 2b.3 Subagente verificador | Sesión nueva sin sesgo confirmatorio, LLM como rey, tools de apoyo | 1h |

**Subtotal D2b: ~3.5h**

### 6.3. Dimensión 2c — Skills v1

Empaquetar las topic-based policies (D1) como skills con SKILL.md, catálogo versionado, descubrimiento por contexto. Pre-requisito de D6.

**Subtotal D2c: ~1.5h**

### 6.4. Dimensión 3 — Multi-tenancy, auth, auditoría

**Status**: ✅ **D3 cerrado completo** (5 sprints cortos: D3.1, D3.2, D3.3, D3.4, D3.5). D3.5 cerrado en sesión 2026-06-25. Habilita onboarding enterprise chico (NDA, DPA, compliance básico vía SECURITY.md).

| Sub-item | Sprint | Status | Qué |
|---|---|---|---|
| Storage cross-restart | D3.1 | ✅ Cerrado | `paused_tasks` table, `TaskStore` interface, recovery al startup. CRIT-1/MAYR-LEGAL cerrado. |
| Multi-tenant enforcement | D3.2 | ✅ Cerrado | PK compuesto `(task_id, tenant_id)`, `MissingTenantIdError`, isolation tests. |
| Auth stub + sweeper + audit | D3.3 | ✅ Cerrado | `AuthProvider` interface, sweeper con `last_heartbeat_at`, tabla `workflow_audit`. |
| **Auth real Google OAuth** | **D3.4** | ✅ **Cerrado 2026-06-24** | Better Auth + Google + SQLite + Express + `DbAuthProvider` + middleware + security headers + rate limit. 24 tests E2E pasan. Cierra BACKLOG P0 #1 (spoofing cross-tenant). |
| **Hardening (2FA + audit_auth + SECURITY.md)** | **D3.5** | ✅ **Cerrado 2026-06-25** | Plugin `twoFactor` (TOTP RFC 6238, 8 recovery codes, opt-in), tabla `audit_auth` append-only con hook a signup/login_success/logout, `SECURITY.md` con 11 secciones (data residency, encryption, auth, authorization, audit trail, data export, incident response, vulnerability disclosure, compliance, limitaciones declaradas, contact). 12 tests E2E pasan. |

**Decisión D3.4-D3.5 (2026-06-14)**: auth propio con Better Auth (no Clerk, no WorkOS, no Supabase Auth). Razón: ahorrativo desde el día 1, datos del user en TU DB (compliance habeas data Colombia sin sub-procesadores), robusto para un cliente enterprise chico, lock-in bajo (Better Auth es librería, no servicio). Spec en `AGENT_D3_4_5_DB_AUTH_SPEC.md`. **2 sprints cortos**: D3.4 = OAuth flow + middleware + tests (2-3 días) ✅ 2026-06-24, D3.5 = 2FA + audit + doc (1-2 días) ✅ 2026-06-25.

---

## 7. Decisiones que este documento invalida o actualiza

Documentos existentes que contienen referencias outdated a la arquitectura vieja. Marcadas para alinear en sesión futura.

| Doc | Sección | Estado | Acción |
|---|---|---|---|
| `PLATFORM_VISION.md` | §11 Workflow Engine | **OUTDATED** | Referenciaba PAKTON/L-MARS como inspiración y proponía Internal Quality Review + Citation Grounding como principios del loop. La nueva arquitectura (motor propio + 3 capas + verificador en sub-sesión) reemplaza este enfoque. |
| `PLATFORM_VISION.md` | §9 Agentes | **PARCIALMENTE OUTDATED** | Decía "agente único con skills dinámicas". Ahora tenemos UN agente cara al usuario + subagentes especialistas (Capa 3) y un intake router (Capa 2). El usuario sigue viendo un solo "Worgena", pero la implementación interna cambió. |
| `PLATFORM_VISION.md` | §2.1 Fast/Pro | **REINTERPRETADO** | El selector Fast/Pro sigue siendo una cosa (modo general). El routing interno multi-modelo por nodo es otra (decisión técnica del motor). No se contradicen, conviven. |
| `AGENT_HARDENING_PLAN.md` | Items 2, 3, 4 | **A ABSORBER** | Auto-evaluación, hard caps, persistencia de ejecuciones se mueven dentro de D2a como parte del motor. |
| `AGENT_HARDENING_PLAN.md` | Item 8 (Sub-agents) | **REPLANTEADO** | La implementación de especialistas se hace como parte de D2b con la arquitectura de 3 capas, no como "sub-agents" genéricos. |
| `AGENT_HARDENING_PLAN.md` | Items 5, 6, 7 | **DIFIERE** | Embeddings vectoriales → D4-D5. Tests de regresión → paralelo no bloqueante. Visual debugger → D3. |

---

## 8. Open questions / decisiones pendientes

1. **Persistencia del motor (D2a)**: ¿SQLite (lo que ya hay) o Postgres desde D2a? SQLite es lo actual; Postgres da pgvector (útil para D4/D5) pero requiere migración. Recomendación: SQLite para D2a, evaluar Postgres en D4.
2. **Auth propio vs Clerk (D3.4-D3.5)**: ✅ Resuelto 2026-06-14 → auth propio con Better Auth. Ver `AGENT_D3_4_5_DB_AUTH_SPEC.md`.
3. **UI de skills (D6)**: ¿Editor visual de workflows (drag-and-drop) o YAML editable con preview? Decisión cuando lleguemos a D6.
4. **Versionado de skills al editar (D6)**: ¿Versionar workflows cuando el usuario los edita, o destructive replace? Impacta UX y storage.
5. **Catálogo inicial de workflows predefinidos (D6)**: ¿Empezamos con 3 workflows de ejemplo (arrendamiento, NDA, demanda laboral) o dejamos que las firmas creen los suyos desde cero? Mi recomendación: 1 workflow predefinido de alto valor + creación libre.
6. **Absorción de items 2, 3, 4 de `AGENT_HARDENING_PLAN.md`**: confirmar con el equipo antes de D2a. Es una reasignación, no una eliminación, pero cambia dónde aparece el trabajo.

---

## 9. Reglas duras para nuevas features (recordatorio)

Cualquier feature nueva que toque el sistema agéntico debe respetar:

1. **Arquitectura de 3 capas** (§5.3). Routing ≠ ejecución ≠ nodos. No mezcles.
2. **Tool vs Skill vs Subagente** (§5.7). No son lo mismo. Tool = función pura. Skill = paquete versionado sin LLM. Subagente = agente hijo con su propio LLM.
3. **MCP para tools, DSL propio para workflows** (§5.8). Las tools pueden ser MCP. Los workflows son nuestro DSL.
4. **Memoria con 4 capas separadas** (§5.1). No inventes una "memoria unificada" porque es más fácil.
5. **State machine ≠ memoria** (§5.2). Tareas de horas, no de días. Persistencia entre sesiones = memoria episodic.
6. **Motor propio, NO LangGraph** (§5.4). Si la feature toca workflows, va en el motor o en el DSL, no en una librería externa que se filtre.
7. **Idempotencia, replay, schema versioning, circuit breaker** (§6.1). Si agregás un nodo, cumplí las cuatro. No son nice-to-have.
8. **Multi-model desde D2** (§5.5). El routing por tier es regla determinista, no decisión del LLM en runtime. Fallbacks: circuit breaker + coste-based.
9. **Verificador en sub-sesión** (§5.6). Para outputs de alto riesgo, el verificador NO comparte contexto con el productor.
10. **Spec-first para componentes nuevos** (§6.1). Antes de codear, escribí el spec. Revisamos juntos. Después codeás.
11. **Seguridad arquitectónica** (no de prompt):
    - **Sandboxing de tools**: cada tool corre con permisos limitados. Ya cubierto en D1 (allowlist + Puppeteer sandbox). Mantener.
    - **Permission tiers**: global / proyecto / sesión. D1 cubre el global (allowlist). D3 introduce scope por tenant. D2b introduce scope por Agent ID.
    - **Prompt injection defense**: problema de arquitectura, no de prompt. Separar datos de instrucciones, validar outputs de tools antes de inyectarlos al contexto, aislar canales de control. Sin esto, un tool malicioso (o una página web scrapeada con prompt injection) puede tomar el control del agente.
    - **Audit log completo**: prompt enviado + respuesta cruda del LLM + tool calls + outputs + decisión del verificador. Por Agent ID, Task ID, Tenant ID. Es el activo legal más importante de Worgena.

Las decisiones arquitectónicas se respetan o se discuten explícitamente, pero no se ignoran.

---

## 10. Referencias

- `PLATFORM_VISION.md` — Visión completa del producto (UI, features, conexiones). **§11, §9 parcial, §2.1 reinterpretado — ver §7**.
- `AGENT_DIM_1_SECURITY_PHASES.md` — Detalle de la Dimensión 1 (cerrada).
- `AGENT_HARDENING_PLAN.md` — Plan de hardening previo. **Items 2-4 absorbidos en D2a, item 8 replanteado en D2b, items 5-7 difieren — ver §7**.
- `ARCHITECTURE.md` — Lecciones aprendidas sobre UI, scraping, intervalos React.
- `AGENTS.md` — Reglas duras del proyecto (escalabilidad, idioma, etc.).
- `src/agent/agent.ts` — Loop agéntico actual (lo que se va a refactorizar en D2a).
- `src/agent/context-manager.ts` — Context window management (item 1 de hardening, cerrado).
