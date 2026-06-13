# Worgena — Handoff Operativo

> **Documento meta.** NO es decisión arquitectónica (eso vive en `AGENT_ROADMAP.md`).
> Es contexto de sesión: dónde quedamos, qué leer primero, qué viene.
> Se actualiza al cierre de cada sprint que cambia dirección.
>
> **Regla de mantenimiento**: la primera acción de una nueva sesión debería ser leer este doc + `AGENT_ROADMAP.md` + `AGENTS.md`. Después leer el spec del sprint activo. Recién ahí meterse en el código.

---

## Estado al cierre de esta sesión

**Fecha**: 2026-06-12 (noche)
**Sprint cerrado**: **AUDIT_D2_CLEANUP #2** — sprint de limpieza que cierra los 4 hallazgos pendientes del #1 que podía resolver como ingeniero (MAY-2, MAY-7, NIT-1, NIT-4). Los 2 re-clasificados a "no requieren fix" (eran juicios erróneos de mi auditoría original).

- **Tests al cierre**: **230/230 pasan** (227 originales + 3 nuevos: 1 MAY-2, 2 MAY-7). Cero regresiones.
- **Hallazgos arreglados en #2** (4): MAY-2 (sync doc `cleanup` con código), MAY-7 (factory se invoca 1 sola vez con `preferredModel`), NIT-1 (re-clasificado, no aplica), NIT-4 (re-clasificado, formato actual es mejor).
- **Pendiente único** (forward-compat con D3): **CRIT-1/MAYR-LEGAL** — storage cross-restart para tasks `paused_hitl`. **Decisión del founder (2026-06-12 noche): opción B** — esperar a D3 (multi-tenant + DB) y meterlo ahí. 1 tabla `paused_tasks` es trabajo chico dentro del sprint D3, no redefine alcance. Razón: A es MVP-quick-fix pero hay que reescribir en D3; C es mal UX + riesgo legal. B es la única que escala y ya está en el roadmap.

**Sprints anteriores de cleanup** (en orden):
- **AUDIT_D2_CLEANUP #1** (2026-06-12 tarde): arregló 18 de 27 hallazgos. Tests 221→227.
- **D2b.2** (2026-06-12 mañana): OpenRouter real + Agent Cards + Lifecycle + sub-sesión verifier. Tests 165→221.
- **D2b.1** (2026-06-12 mañana): multi-model router + 3 specialists con mocks. Tests 130→165.
- **D2a.5** + **D2a.4** + **D2a.2.3**: motor completo con state validation, prompt snapshot, replay, schema versioning, circuit breaker, HITL primitives. Tests 0→130.

**Total acumulado D2**: **230/230 tests, 0 fallidos**.

**Próximo sprint propuesto**: **D2c — Skills v1**. Roadmap §5.4, §5.14. Empaquetar las topic-based policies como skills con SKILL.md, principios jurídicos colombianos. Catálogo de tools se enchufa al `OpenRouterLLMInvoker` (forward-compat con CRIT-2 ya aplicado).

**D1 cerrada**, **D2a cerrado**, **D2b cerrado**, **AUDIT_D2_CLEANUP cerrado** (en 2 sprints). Pendiente: D2c (skills v1), D3 (multi-tenant + DB), D4 (memoria), D5 (RAG), D6 (editor).

---

## Archivos a leer primero (en este orden)

1. **`AGENTS.md`** — reglas duras del proyecto (estilo, idioma, orden por fundamento, etc.). Lee esto PRIMERO en cualquier nueva sesión.
2. **`AGENT_ROADMAP.md`** — decisiones arquitectónicas vigentes (§5), roadmap D2-D6 (§6), open questions (§8). Lee la sección §5 completa si vas a tocar el sistema agéntico. §6.1 si vas a trabajar en D2a.
3. **Este doc (`HANDOFF.md`)** — contexto operativo, sprint recién cerrado, gotchas.
4. **`AGENT_D2A_2_3_CORE_PRIMITIVES_SPEC.md` v1.1** — el sprint que cerramos. Si vas a tocar el motor, lee el spec antes de tocar código.
5. **`AGENT_WORKFLOW_DSL_SPEC.md` v0.2** — el DSL del motor (tipos, JSON schema, primitivas contractuales). Necesario si vas a agregar/modificar tipos del DSL.
6. **`AGENT_D2A_2_2_TIMEOUT_RETRY_IDEMPOTENCY_SPEC.md` v1.0** — primitivas de retry/timeout. Complementa el motor.
7. **Código del motor**: `src/agent/workflow-engine/`
   - `dsl/` — tipos, JSON schema, parser
   - `executor/` — runtime (incluye `circuit-breaker.ts` y `state.ts::validateStateAgainstSchema` de D2a.2.3)
   - `migrations.ts` — schema versioning (D2a.2.3)
   - `executor.ts` — el motor propiamente dicho

---

## Sprint en curso: D2a.4

**Qué cubre**: cierra el gap del motor HITL. Antes de D2a.4, `node-runner.ts::runHITLNode` hacía `await hitlHandler.request()` bloqueante, lo que congelaba el motor cuando un humano debía responder. D2a.4 implementa la separación de fases pause/resume que el DSL spec §6.3 ya prometía pero el código no hacía.

**Estado**: ✅ CERRADO en este turno.

**Componentes entregados**:
- `Task.pendingDecision?: PendingHITLDecision` — persiste el contexto de la pausa (nodo, requestId, approvers, pregunta, schema, startedAt). Campo mutable (mismo patrón que `state`, `status`).
- `HITLHandler.initiate()` reemplaza al `request()` bloqueante. Retorna `{ requestId, immediateResponse? }` rápido. El handler es ahora solo notificador.
- `executor.resumeTask(taskId, response)` — nuevo método público para que el caller inyecte la respuesta humana y el motor continúe el loop. Soporta `approved` (con validación de outputSchema), `declined`, `timeout` (con `onTimeout` 'fail'/'approve'/'reject' implementado, gap heredado del DSL spec).
- `applyHITLResponse(task, node, response)` — helper interno que valida output contra `outputSchema`, escribe al state, valida state, y maneja continue/goto/fail.
- `cancelTask` retiene `pendingDecision` para audit (cuánto tiempo estuvo esperando).
- Guarda defensiva en `runLoop` contra loops infinitos si un helper interno ya marcó la task como terminal.
- Migración de `MockHITL` en tests previos: ahora `initiate()` con `immediateResponse` en lugar de `request()` bloqueante.

**Decisiones de diseño con implicaciones para el futuro**:
- **`immediateResponse` opcional**: el handler puede retornar la respuesta junto con el `requestId` (caso interactivo o test). Si está, el motor la procesa inline. Si no, el motor pausa. Esta es la primitiva que permite ambos patrones: interactivo (wrapper) o desacoplado (canal externo).
- **Sin migración del `ask_human` de D1**: el `ask_human` es una tool del LLM (`src/agent/tools.ts:652`), no un `HITLHandler` del motor. El `WorkflowExecutor` no se instancia desde `server.ts` todavía. No hay nada que migrar en D2a.4. La integración productiva del handler se hace cuando se cablee el motor (D2a.5+).
- **`requestId` lo emite el handler**, no el motor. El handler conoce el canal externo (email, Slack, etc.) y puede garantizar unicidad.
- **Persistencia de la pausa solo en memoria en D2a**: si el server reinicia, las tasks `paused_hitl` se pierden. D3 introduce DB. Workaround: el caller persiste externamente el `taskId` para poder hacer replay si es necesario.
- **No sweeper automático de timeouts en D2a**: el handler externo respeta `timeoutMs`. D3 sweeper.
- **Motor permisivo con `allowDecline=false`**: si llega `declined` aunque el nodo no permita decline, el motor procesa el decline igualmente (con warning). Backward-compatible con tests preexistentes. La policy "no se puede declinar" la aplica el handler externo, no el motor.
- **NO se valida `requestId` en `resumeTask`**: el `taskId` ya es específico. Confiamos en el caller. Documentado en spec §6.

**Archivos tocados** (5):
- `src/agent/workflow-engine/dsl/types.ts` — `Task.pendingDecision?` + interface `PendingHITLDecision`.
- `src/agent/workflow-engine/executor/types.ts` — `HITLHandler.request()` → `HITLHandler.initiate()`. Nuevas interfaces `HITLInitiateParams` y `HITLInitiateResult`. Eliminado `HITLRequestParams`.
- `src/agent/workflow-engine/executor/node-runner.ts` — eliminado `runHITLNode` (la lógica HITL pasa al executor). `case "hitl"` del switch tira `INTERNAL_BUG` defensivo.
- `src/agent/workflow-engine/executor/executor.ts` — nuevo método público `resumeTask()`, helpers privados `pauseForHITL()` y `applyHITLResponse()`. `runLoop` ya no llama a `runNode` para nodos HITL. `cancelTask` retiene `pendingDecision`. Guarda defensiva contra loops infinitos.
- `src/agent/workflow-engine/executor/index.ts` — barrel export actualizado (HITLInitiateParams, HITLInitiateResult; eliminado HITLRequestParams).
- `test_workflow_executor.mts` y `test_workflow_d2a_2_3.mts` — `MockHITL` migrado a `initiate()`. Casts agregados donde `FunctionRegistry` (wrapper) se pasa donde se espera `Map<string, WorkflowFunction>` (mismatch preexistente).
- `test_workflow_d2a_4.mts` — NUEVO, 18 tests.

**NO se toca** (confirmado en auditoría):
- `src/agent/tools.ts` (la tool `ask_human` de D1 sigue funcionando como siempre).
- `src/agent/agent.ts` (sin cambios).
- `server.ts` (el motor no se cablea al server en D2a.4; eso es D2a.5+).

**Bugs encontrados durante implementación** (no documentados en el spec original):
1. `pauseForHITL` con `immediateResponse` exitoso no avanzaba `currentNode` al siguiente → loop infinito. Arreglado en `runLoop` llamando a `findNextNodeViaEdges` después del bloque HITL.
2. `applyHITLResponse` con `response.type='approved'` o `'declined'+continue` no avanzaba `currentNode` → loop infinito en `resumeTask`. Arreglado en `resumeTask` llamando a `findNextNodeViaEdges` después de aplicar respuesta exitosa.
3. Falta de guarda en `runLoop` para estado terminal tras `applyHITLResponse` → loop infinito. Arreglado con check al inicio del while.

**Decisiones que tomé yo en este turno (registradas en spec §11)**: 14 decisiones, todas reversibles. La más opinada fue NO migrar el `ask_human` (corregido tras auditoría cuando descubrí que es una tool, no un handler del motor). La más revisada post-implementación: hacer el motor permisivo con `allowDecline=false` para mantener backward-compat con tests preexistentes.

---

## Sprint en curso: D2b.2

**Qué cubre**: el sprint más grande hasta ahora. Enchufa la integración real con OpenRouter (la key ya está en `.env`), formaliza los Agent Cards (A2A v1.0), introduce el lifecycle de specialists (`spawn → idle → busy → paused → done → archived`), y mueve el verifier a "sub-sesión lógica" con prompt limpio (sin acceso al system prompt del productor). Agrega Citation Grounding v2 como extensión del verifier.

**Componentes a entregar**:
- 5 archivos nuevos en `src/agent/llm/`: `openrouter-client.ts`, `openrouter-errors.ts`, `openrouter-invoker.ts`, `pricing-catalog.ts`, `index.ts`.
- 3 archivos nuevos en `src/agent/specialists/`: `agent-card.ts`, `lifecycle.ts`, `agent-cards/index.ts`.
- Refactor mayor: `specialist.ts` (interface con +agentCard, +lifecycle), `intake-specialist.ts`, `clause-reviewer-specialist.ts`, `verifier-specialist.ts` (sub-sesión + Citation Grounding v2), `mocks/mock-invokers.ts` (+MockOpenRouterClient).
- `test_workflow_d2b_2.mts` con 50+ tests (1 smoke test opcional con OpenRouter real).

**Sin cambios al motor Capa 1**: el `WorkflowExecutor`, `runLoop`, `node-runner.ts` no se tocan. El routing D2b.1 sigue funcionando.

**Tests al cierre esperado**: 130 (D2a/D2b.1) + 50+ (D2b.2) = **180+ tests pasan**, cero regresiones.

**Decisiones más opinadas (registradas en `AGENT_D2B_2_SPEC.md` §8, 20 decisiones)**:
- **Sub-sesión del verifier = prompt limpio, mismo LLM** (confirmado con el usuario). NO child_process, NO Mavis. El system prompt del verifier es completamente independiente del system prompt del productor. La auditoría mejora (registramos los 2 system prompts) y la complejidad operacional se mantiene en cero.
- **OpenRouter = `fetch` directo, NO SDK `openai`**. Mismo patrón que `src/agent/memory.ts` ya usa para embeddings.
- **3 modelos hardcodeados en el catálogo** (deepseek-chat, claude-3.5-sonnet, qwen3-embedding-8b) con precios públicos de OpenRouter. Configurable vía `PricingCatalog.extend()`.
- **Agent Card = objeto TypeScript con `toJSON()` A2A v1.0** (confirmado). Una sola fuente de verdad. D3+ A2A server usa el mismo `toJSON()`.
- **`agentVersion` cambia de `1.0.0-d2b.1` a `1.0.0`** (semver limpio). El sufijo `-d2b.1` se elimina.
- **Cost real = `usage.cost` de OpenRouter** (cuando está) + `PricingCatalog` como fallback. OpenRouter devuelve el costo exacto facturado.
- **Lifecycle = state machine simple en código** (sin xstate ni libs externas). 6 estados, transiciones explícitas, eventos in-memory.
- **Citation Grounding v2 = heurística** (substring + lista cerrada de campos de metadatos). `read_section` real es D3+ con RAG.
- **5xx mapea a `MODEL_UNAVAILABLE`** (retriable), no a `INTERNAL_ERROR` (no retriable). Corrección post-auditoría del spec.
- **Constructors backward-compat**: `new IntakeSpecialist(inv)`, `new ClauseReviewerSpecialist(inv)`, `new VerifierSpecialist(inv)` siguen funcionando. `agentCard` y `lifecycle` se inicializan internamente, no se pasan como params.
- **El `raw` field del `ChatResponse` NO se loguea por default** (puede contener metadata sensible). El cliente loguea solo status, latency, model.
- **Smoke test E2E con OpenRouter real es opcional** (depende de la key en env). Los demás 50+ tests son offline.

**Lo que NO toca D2b.2** (deuda a sprints futuros): A2A server HTTP (D3+), streaming (D3+ o demanda), `read_section` real (D3+), principios jurídicos (D2c), MCP, multi-tenant (D3), circuit breaker por specialist (D3+), SaC (D3+ con cliente), pricing configurable por tenant (D3), cost attribution con desglose de reasoning tokens (D3).

---

## Sprint recién cerrado: D2b.2

**Qué cubre**: el sprint más grande hasta ahora. Enchufa la integración real con OpenRouter (la key ya está en `.env`), formaliza los Agent Cards (A2A v1.0), introduce el lifecycle de specialists (`spawn → idle → busy → paused → done → archived`), y mueve el verifier a "sub-sesión lógica" con prompt limpio (sin acceso al system prompt del productor). Agrega Citation Grounding v2 como extensión del verifier.

**Estado**: ✅ CERRADO en este turno.

**Componentes entregados**:
- 5 archivos nuevos en `src/agent/llm/`: `openrouter-client.ts`, `openrouter-errors.ts`, `openrouter-invoker.ts`, `pricing-catalog.ts`, `index.ts`.
- 3 archivos nuevos en `src/agent/specialists/`: `agent-card.ts`, `lifecycle.ts`, `agent-cards/index.ts`.
- Refactor mayor: `specialist.ts` (interface con +agentCard, +lifecycle), `intake-specialist.ts`, `clause-reviewer-specialist.ts`, `verifier-specialist.ts` (sub-sesión + Citation Grounding v2), `mocks/mock-invokers.ts` (+MockOpenRouterClient + helpers de responses).
- `test_workflow_d2b_2.mts` con 56 tests (1 smoke E2E con OpenRouter real opcional, 55 offline).

**Sin cambios al motor Capa 1**: el `WorkflowExecutor`, `runLoop`, `node-runner.ts`, `circuit-breaker.ts`, `state.ts` no se tocan. El routing D2b.1 sigue funcionando tal cual.

**Tests al cierre**: **221/221 pasan** (53 + 36 + 18 + 7 + 16 + 35 + 56). Cero regresiones.

**Decisiones de diseño con implicaciones para el futuro**:
- **`OpenRouterClient` usa `fetch` directo, NO SDK `openai`** (mismo patrón que `src/agent/memory.ts`). El SDK no tipifica `usage.cost`. Forward-compat: si en el futuro se cambia a LiteLLM/Portkey, se reemplaza el cliente, no el invoker.
- **Transport inyectable en el `OpenRouterClient`**: el `transport: (url, init) => Promise<Response>` permite tests deterministas sin red ni key. `MockOpenRouterClient` lo usa para programar responses FIFO.
- **API key pasada LITERAL** al header `Authorization: Bearer ${key}` (sin prefijos, sin normalización). Regla del proyecto (ver `AGENTS.md` §5a y `MEMORY.md` 2026-06-09).
- **El cliente NUNCA loguea la key** (ni en debug, ni en error). Verificable con grep.
- **`OpenRouterError` extiende `Error` con `code: ErrorCode` del motor** ya mapeado. Permite al `node-runner` consumir `error.code` directamente sin substring matching. Backward-compat: el `classifyLLMError` de D2a.2.2 sigue funcionando con el substring fallback para errores legacy.
- **`PricingCatalog.extend()` retorna NUEVO catálogo**, no muta el original. Forward-compat con catálogos por tenant en D3+ sin contaminación cruzada.
- **Agent Card como objeto TS inmutable** con `toJSON()` que produce JSON A2A v1.0. Una sola fuente de verdad: `agentCard.version` se usa como `agentVersion` del specialist (no más constante `SPECIALIST_AGENT_VERSION`, ahora deprecated).
- **Lifecycle como state machine simple en código** (sin xstate ni libs externas). Eventos in-memory. Persistencia a DB es D3+.
- **Sub-sesión del verifier = prompt limpio, mismo LLM** (NO child_process, NO Mavis). El system prompt del verifier NO comparte texto con el system prompt del productor. Garantía LÓGICA, no de proceso. Si en D3+ se necesita garantía de proceso, se mueve a child_process.
- **Citation Grounding v2 = heurística**, no RAG real. `read_section` es D3+ con RAG. La heurística distingue citas a texto (substring en state serializado) de citas a metadatos (existencia del campo en el state). Lista cerrada de campos reconocidos.
- **Output del verifier ahora incluye metadata de audit** (`verifierSessionId` UUID + `verifiedAt` ISO + `issues` + `citations`). Backward-incompatible: tests D2b.1 que hacían `deepEqual` estricto sobre el output del verifier se actualizaron al nuevo shape. **Cambio intencional y documentado** (spec §5.7).
- **`done → busy` permitido en la tabla del Lifecycle** (decisión post-implementación): el `SpecialistRegistry` comparte instancias entre tasks (un specialist se reusa para `task1` y luego para el `replay` de `task1`). El lifecycle trackea la vida del specialist, no de cada ejecución individual. Sin esta transición, el replay falla con `INTERNAL_ERROR` (bug descubierto en test D2a.5 al implementar D2b.2).
- **El `OpenRouterClient` no cachea nada** (cada llamada es fresh). Cache es D3+.
- **El `raw` field del `ChatResponse` NO se loguea por default** (puede contener metadata sensible del response). El cliente sanitiza headers sensibles en `sanitizeForLog`. Si el caller quiere loguear para audit, debe sanitizar primero.

**Archivos tocados** (16):
- `src/agent/llm/openrouter-client.ts` (nuevo, ~330 LoC).
- `src/agent/llm/openrouter-errors.ts` (nuevo, ~150 LoC).
- `src/agent/llm/openrouter-invoker.ts` (nuevo, ~170 LoC).
- `src/agent/llm/pricing-catalog.ts` (nuevo, ~140 LoC).
- `src/agent/llm/index.ts` (nuevo, ~30 LoC, barrel).
- `src/agent/specialists/agent-card.ts` (nuevo, ~210 LoC).
- `src/agent/specialists/lifecycle.ts` (nuevo, ~150 LoC).
- `src/agent/specialists/agent-cards/index.ts` (nuevo, ~140 LoC).
- `src/agent/specialists/specialist.ts` (modificado, +agentCard +lifecycle en la interface, SPECIALIST_AGENT_VERSION deprecated).
- `src/agent/specialists/intake-specialist.ts` (modificado, +agentCard +lifecycle +transiciones).
- `src/agent/specialists/clause-reviewer-specialist.ts` (idem).
- `src/agent/specialists/verifier-specialist.ts` (refactor mayor: sub-sesión lógica + Citation Grounding v2 + lifecycle + audit metadata).
- `src/agent/specialists/mocks/mock-invokers.ts` (modificado, +MockOpenRouterClient + helpers makeChat200/makeHttpError/makeEmbedding200/makeNonJsonResponse).
- `src/agent/specialists/index.ts` (modificado, barrel actualizado).
- `test_workflow_d2b_1.mts` (modificado, 2 asserts actualizados: agentVersion a "1.0.0", output del verifier con campos D2b.2).
- `test_workflow_d2a_5.mts` (modificado, 1 bug fixed por el cambio de tabla de Lifecycle; sin cambios de código, solo detectó la falla en replay).
- `test_workflow_d2b_2.mts` (nuevo, 56 tests, ~900 LoC).

**NO se toca** (confirmado en auditoría):
- `src/agent/workflow-engine/**` — Capa 1 intacta. El routing del D2b.1 sigue funcionando.
- `src/agent/agent.ts`, `src/agent/tools.ts`, `src/agent/memory.ts` — código existente intacto.

**Bugs encontrados durante implementación** (todos arreglados, documentados):
1. **Tabla del Lifecycle no permitía `done → busy`**: rompía el replay (un specialist se reusa). Arreglado en `LIFECYCLE_TRANSITIONS`. Detectado por test D2a.5 que ya existía.
2. **Test D2b.1 con `agentVersion` viejo**: el test asumía `"1.0.0-d2b.1"`, ahora debe ser `"1.0.0"`. Backward-incompatible intencional (spec §8.8).
3. **Test D2b.1 con `deepEqual` estricto sobre output del verifier**: el output ahora tiene 4 campos extra (Citation Grounding v2 + audit metadata). Test actualizado para validar los nuevos campos explícitamente. Backward-incompatible intencional (spec §5.7).
4. **`PricingCatalog` importado como `type` pero usado como valor en `OpenRouterLLMInvoker`**: error TS1361. Arreglado cambiando el import a `import { PricingCatalog }`.
5. **`ChatRequest["messages"]` es `readonly`**: no se puede hacer `push`. Arreglado usando `Array<...>` mutable internamente y retornando el `readonly` después.
6. **Mojibake en string de test** ("¿" y "é" doblemente codificados): caracteres chinos en el archivo. Arreglado reemplazando el string por uno más simple (`startsWith("Hola")`).

**Decisiones que tomé yo en este turno (registradas en spec §8)**: 20 decisiones, todas reversibles. La más opinada fue la **transición `done → busy` permitida en la tabla del Lifecycle** (no estaba en el spec original, fue necesaria para que el replay funcione con specialists reusados). La más técnica fue el **mapeo de errores HTTP a `ErrorCode`** (la tabla §3.2 del spec está en `mapHttpStatusToMotorCode` en `openrouter-errors.ts`, función pura testeable independientemente).

**Lo que NO toca D2b.2** (deuda a sprints futuros): A2A server HTTP (D3+), streaming (D3+ o demanda), `read_section` real (D3+), principios jurídicos (D2c), MCP, multi-tenant (D3), circuit breaker por specialist (D3+), SaC (D3+ con cliente), pricing configurable por tenant (D3), cost attribution con desglose de reasoning tokens (D3).

---

## Sprint recién cerrado: AUDIT_D2_CLEANUP #2 (2026-06-12 noche)

**Qué cubre**: sprint de limpieza #2 — cierre de los hallazgos que dejé pendientes en AUDIT_D2_CLEANUP #1 por considerarlos opinables o requerir decisión de producto. Los 4 hallazgos cerrados acá son los que podía resolver como ingeniero sin decisión del usuario.

**Estado**: ✅ CERRADO en este turno.

**Hallazgos arreglados (4)**:

| ID | Severidad | Fix |
|---|---|---|
| **MAY-2** | 🟡 | Sincronizado el spec `AGENT_D2A_2_3_CORE_PRIMITIVES_SPEC.md` §9.3 con el código. El spec decía "libera el cache de idempotency pero retiene la task" — el código también libera `cancelledTasks` (cambio silencioso, no documentado). El spec ahora documenta el "soft reset" completo: libera 2 cosas (cache + flag), retiene 3 (task + workflow + status). Actualizado el `cleanup()` doc en `executor.ts` y el §9.3 del spec. Test nuevo: "cleanup(taskId) es soft reset". |
| **MAY-7** | 🟡 | El factory se invocaba 2 veces (stub + real). Fix **sin breaking**: agregué campo opcional `preferredModel` a la interface `SpecialistFactory`. Si el caller lo provee, el registry evita la doble construcción. Si no, fallback al patrón viejo (backward-compat). Migré los 5 callers (3 test files) para que aprovechen el fix. Tests nuevos: 2 (uno con `preferredModel` verifica 1 sola invocación, otro sin él verifica 2 invocaciones). El `Lifecycle` y futuros factory side-effects ya no se ejecutan 2 veces. |
| **NIT-1** | ⚪ | Re-clasificado: la referencia a A2A v1.0 NO estaba en `openrouter-errors.ts` (mi auditoría estaba mal en este punto). Las menciones de A2A están todas bien ubicadas en `agent-card.ts` con contexto correcto. **Skip — no hay nada que arreglar.** |
| **NIT-4** | ⚪ | Re-clasificado: consolidar las cabeceras "D2b.1" y "D2b.2" en una sola sección "D2b" perdería la granularidad de qué hizo cada sub-sprint. **Skip — el formato actual es más informativo.** |

**Hallazgos NO arreglados** (queda 1):

| ID | Razón |
|---|---|
| **MAYR-LEGAL / CRIT-1** | Storage cross-restart para tasks `paused_hitl`. Requiere decisión de storage externo o esperar D3 con DB. Pendiente desde #1. |

**Decisiones tomadas en este turno** (registradas para audit):

1. **MAY-7**: el campo `preferredModel` en `SpecialistFactory` es **opcional** (no breaking). Forward-compat: cuando todos los callers internos estén migrados (D2c, D3+), el campo puede volverse obligatorio. El código de fallback sigue ahí para callers externos que no actualicen.

**Tests al cierre**: **230/230 pasan** (227 originales + 3 nuevos: 1 MAY-2, 2 MAY-7). Cero regresiones.

**Archivos tocados** (4):
- `src/agent/workflow-engine/executor/executor.ts` (MAY-2: doc de `cleanup()` reescrito, ahora menciona explícitamente el "soft reset" con 2/3 liberación/retención)
- `AGENT_D2A_2_3_CORE_PRIMITIVES_SPEC.md` (MAY-2: tabla de API §10 actualizada con el comportamiento completo de `cleanup`)
- `src/agent/specialists/specialist-registry.ts` (MAY-7: nuevo campo opcional `preferredModel` en `SpecialistFactory` interface, lógica actualizada en `create()` para evitar doble construcción cuando está presente)
- 3 archivos de tests (MAY-7: 5 callers actualizados para proveer `preferredModel`, 2 tests nuevos que validan 1 vs 2 invocaciones del factory)
- `test_workflow_executor.mts` (MAY-2: test nuevo "cleanup(taskId) es soft reset")

**Lo que queda** (forward-compat con sprints futuros):
- **CRIT-1/MAYR-LEGAL**: storage cross-restart. **No es un fix de código** — es una decisión de storage. Documentado en HANDOFF gotcha #9 y spec D2a.4 §5.2. **Esperar D3 con DB**, o agregar un hook `onPause` en D2c para que el caller persista `taskId + requestId` externamente.

---

## Sprint recién cerrado: AUDIT_D2_CLEANUP #1 (2026-06-12 tarde)

**Qué cubre**: sprint de limpieza que arregla los hallazgos de `AUDIT_D2_2026-06-12.md` en orden de urgencia. **No introduce features nuevas** — solo fixes, refactors chicos, y aclaraciones de doc. Hace que D2b.2 sea producción-ready (o lo más cerca posible sin D3 con DB).

**Estado**: ✅ CERRADO en este turno.

**Hallazgos arreglados (14 de 27)**:

| ID | Severidad | Fix |
|---|---|---|
| CRIT-2 | 🔴 | `OpenRouterLLMInvoker.translateTools()` ahora falla loud cuando hay toolNames sin catálogo. Antes retornaba `[]` silenciosamente — un LLM sin tools puede alucinar. |
| MAY-6 | 🟠 | `VerifierSpecialist.detectCitations()` normaliza el field de metadata a lowercase. Antes, `DEROGADO_POR` no matcheaba con `derogado_por` en el state. |
| MAY-1 | 🟠 | `migrations.ts::loadWorkflow()` ahora retorna `{workflow, appliedMigrations}`. El método privado `executor.ts::loadAndMigrate()` se reduce a un wrapper trivial. Single source of truth. |
| MAY-3 | 🟠 | `OpenRouterClient.executeWithTimeout` usa `controller.signal.reason` para distinguir timeout interno de cancel externo. Antes la heurística `!externalSignal?.aborted` era frágil. |
| MAY-4 | 🟠 | `parseEmbeddingResponse` invierte la precedence: `total_tokens` pisa a `prompt_tokens` (antes al revés). |
| MAY-5 | 🟠 | `OpenRouterClient` ahora loguea via `logger?` en 4 puntos: request start, response OK, HTTP error, timeout/network. Antes el campo `logger` existía pero nunca se usaba. |
| MAY-8 | 🟠 | Documentada en `AGENT_D2B_2_SPEC.md` §5.8 la convención de `node.input.from` para nodos verifier. |
| MAY-10 | 🟠 | `MockOpenRouterClient.toOpenRouterClient()` delega al `OpenRouterClient` real con el `transport` programable. El mock ya no duplica el parseo. |
| MIN-1 | 🟡 | Comment en `Lifecycle` constructor aclarando que `stateChangedAt` arranca en `spawn` (mismo timestamp que `createdAt`). |
| MIN-3 | 🟡 | Comment en `Lifecycle.stateChangedAt` documentando que es redundante con `events[length-1].at` y se mantiene por backward-compat. |
| MIN-5 | 🟡 | `NodeResult.costUsd` ahora es **no opcional** (siempre `number`, default 0). Forward-compat con audit que asume número, no `undefined`. |
| MIN-6 | 🟡 | `OpenRouterClientOptions` ahora acepta `appName` y `appUrl` (parametrizan `X-Title` y `HTTP-Referer`). |
| MIN-7 | 🟡 | `SpecialistRegistry.create()` ahora tira error si dos factories declaran el mismo `agentId` (antes el segundo pisaba al primero silenciosamente). |
| MIN-8 | 🟡 | Documentado en `AGENT_D2B_2_SPEC.md` §5.9 el output shape de nodos verifier (UX de UI: cómo discriminar `VerifierOutput` de otros outputs). |
| MIN-11 | 🟡 | Eliminado el import y fallback a `SPECIALIST_AGENT_VERSION` (constante deprecated) en `node-runner.ts:212`. |
| NIT-2 | ⚪ | Comment en `Lifecycle.onStateChange` documentando que el callback debe ser síncrono. |
| NIT-3 | ⚪ | `MockOpenRouterClient.lastCall` getter para inspeccionar la última call sin hacer `calls[length-1]`. |
| NIT-5 | ⚪ | Header de `executor.ts` ahora menciona D2b.1 y D2b.2 además de los specs D2a. |

**Hallazgos NO arreglados (requieren decisión o son out of scope)**:

| ID | Razón |
|---|---|
| **MAYR-LEGAL / CRIT-1** | La auditoría legal-audit cross-restart (tasks `paused_hitl` se pierden en restart del server) requiere decisión de storage externo. **Esperar D3 con DB**. Documentado en HANDOFF gotcha #9 + spec D2a.4 §5.2. |
| **MAY-7** | `SpecialistRegistry` invoca factories 2 veces (stub + real). Cambiar la signature de `SpecialistFactory` es **breaking** para callers externos. Pendiente de decisión. |
| **MAY-2** | Inconsistencia doc vs código (D2a.2.3 §9.3 dice "cleanup libera cache" pero el código también libera `cancelledTasks`). Es fix de docs, no de motor. Pendiente. |
| **MAY-9** | Subsumido en CRIT-2 (warning de tools perdidas). |
| **MIN-2** | Re-clasificado a NIT. La tabla de §3.2 del spec SÍ está sincronizada con §8.19. El bug era de mi memoria en la auditoría. La única inconsistencia era el encoding roto en chino ("充值") que arreglé. |
| **MIN-4** | Arreglado en el mismo sprint como parte de MIN-5 (cambié `NodeResult.costUsd` a no-opcional, lo que hace redundante el `?? 0` defensivo). |
| **NIT-1, NIT-4** | Triviales, no tocan código funcional. |

**Tests al cierre**: **227/227 pasan** (221 originales + 6 nuevos: 3 CRIT-2, 1 MAY-6, 1 MIN-6, 1 MIN-7). Cero regresiones.

**Archivos tocados** (12):
- `src/agent/llm/openrouter-client.ts` (CRIT-2 tools + MAY-3 timeout + MAY-4 embeddings + MAY-5 logger + MIN-6 app headers)
- `src/agent/llm/openrouter-invoker.ts` (CRIT-2 translateTools + toolCatalog)
- `src/agent/workflow-engine/migrations.ts` (MAY-1: nuevo return type)
- `src/agent/workflow-engine/executor/executor.ts` (MAY-1 wrapper trivial + MIN-5 costUsd no-opcional + NIT-5 header)
- `src/agent/workflow-engine/executor/node-runner.ts` (MIN-4 `?? 0` + MIN-11 sin SPECIALIST_AGENT_VERSION)
- `src/agent/workflow-engine/dsl/types.ts` (MIN-5 costUsd no-opcional)
- `src/agent/specialists/verifier-specialist.ts` (MAY-6 normalización lowercase)
- `src/agent/specialists/specialist-registry.ts` (MIN-7 tira error en agentId duplicado)
- `src/agent/specialists/lifecycle.ts` (MIN-1 comment + MIN-3 comment + NIT-2 comment)
- `src/agent/specialists/mocks/mock-invokers.ts` (MAY-10 toOpenRouterClient + NIT-3 lastCall + MAY-4 embeddings precedence)
- `AGENT_D2B_2_SPEC.md` (MAY-8 §5.8 + MIN-8 §5.9 + encoding fix de "充值"→"recarga" en §3.2)
- `test_workflow_d2a_2_3.mts` (MAY-1: tests de schema versioning adaptados al nuevo return type)
- `test_workflow_d2b_2.mts` (6 tests nuevos: 3 CRIT-2, 1 MAY-6, 1 MIN-6, 1 MIN-7)

**Decisiones tomadas en este turno** (registradas para audit):
1. CRIT-2: `translateTools` falla loud en vez de warn. El workflow autor debe enterarse al ejecutar, no en producción.
2. MAY-1: `loadWorkflow` ahora retorna `{workflow, appliedMigrations}` (en vez de `WorkflowDefinition` directo). Esto es **breaking** para tests que importaban la signature vieja — los actualicé en bloque. **NO breaking** para código de producción (el único caller interno era `executor.ts::loadAndMigrate`).
3. MAY-3: uso `controller.signal.reason` (un `Error` con `message === "OpenRouter timeout"`) en vez de la heurística previa. Si el runtime de Node cambia el shape de `AbortSignal.reason`, hay que actualizar.
4. MIN-5: `NodeResult.costUsd` ahora es **no opcional**. Breaking para cualquier código que asumía `costUsd === undefined` para nodos no-LLM. **No afectado**: los nodos no-LLM escriben `costUsd: 0` explícito. **Migración**: si tenés código que hace `if (result.costUsd !== undefined)`, ahora `costUsd` siempre es `number` — usá `if (result.costUsd > 0)`.
5. MIN-7: error explícito en agentId duplicado. **Breaking** para workflows mal configurados que dependían del "segundo pisa al primero" — pero ese comportamiento era un footgun. La spec D2b.1 §4 lo documentaba como "no lo validamos explícitamente"; ahora sí.

**Reversibilidad**: las decisiones 1, 3, 4, 5 son reversibles con un commit revert. La decisión 2 (return type de `loadWorkflow`) es la más invasiva — si el equipo prefiere `WorkflowDefinition` + `appliedMigrations` como side-effect (vía un callback), hay que revertir el cambio de signature y los tests. Pero creo que el return type es más limpio.

**Lo que falta** (deuda visible para sprints futuros):
- MAY-7 (factory se invoca 2 veces) — fix requiere cambiar `SpecialistFactory` interface, breaking para callers externos. Decisión tuya.
- MAY-2 (cleanup libera más de lo que el spec dice) — fix de docs. Trivial.
- MAYR-LEGAL — esperar D3 con DB.

---

## Sprint recién cerrado: D2b.1

**Qué cubre**: primer sprint de D2b (multi-modelo + specialists, roadmap §6.2). Introduce el `TierResolver` configurable (liviano + robusto), los 3 specialists del roadmap (`IntakeSpecialist`, `ClauseReviewerSpecialist`, `VerifierSpecialist`) con mocks, y el routing por `node.assignedSpecialist`. Capa 3 del sistema agéntico (workflow engine es Capa 1).

**Componentes entregados**:
- 8 archivos nuevos en `src/agent/specialists/`: `tier-resolver.ts`, `specialist.ts`, `specialist-registry.ts`, `intake-specialist.ts`, `clause-reviewer-specialist.ts`, `verifier-specialist.ts`, `mocks/mock-invokers.ts`, `index.ts` (barrel).
- Modificaciones al motor (mínimas): `dsl/types.ts`, `dsl/schema.ts`, `executor/types.ts`, `executor/node-runner.ts`, `executor/executor.ts`, `executor/index.ts`. **El motor de D2a sigue funcionando tal cual** — los cambios son aditivos.
- `tests/fixtures/revision-generica.workflow.json` actualizado con `assignedSpecialist` en `classify`.
- `test_workflow_d2b_1.mts` con 16 tests (1 bonus sobre los 15 planeados).

**Tests al cierre**: **130/130 pasan** (53 originales + 36 D2a.2.3 + 18 D2a.4 + 7 D2a.5 + 16 D2b.1). Cero regresiones.

**Notas de implementación**:
- El `Specialist` interface requiere un campo `agentVersion: string`. En D2b.1 era `1.0.0-d2b.1` (placeholder); en D2b.2 cambia a `1.0.0` (semver limpio).
- El `executor/types.ts` importa SOLO TIPOS de los specialists (no el barrel) para evitar ciclo de runtime.
- El `mock-invokers.ts` retorna shapes específicos por specialist (detectado por substring del system prompt).
- El test D2a.5 tuvo que actualizarse para proveer un `SpecialistRegistry` cuando el fixture declara `assignedSpecialist` en `classify`. 7/7 tests siguen pasando.
- Solo `classify` del fixture tiene `assignedSpecialist`. `extract` y `summarize` no porque `ClauseReviewerSpecialist` espera shapes distintos a los que el mock del fixture retorna.

---

## Sprint recién cerrado: D2a.5

**Qué cubre**: smoke test del motor entero (D2a.2 + D2a.2.2 + D2a.2.3 + D2a.4) con un workflow real. Hasta D2a.4 los tests probaban primitivas aisladas; D2a.5 prueba que **juntas funcionan en un workflow no-trivial**. Cierra D2a.

**Estado**: ✅ CERRADO en este turno.

**Componentes entregados**:
- `tests/fixtures/revision-generica.workflow.json` (nuevo) — el workflow del DSL spec §5 como JSON ejecutable, con `additionalProperties: false` para validación estricta.
- `test_workflow_d2a_5.mts` (nuevo) — 7 tests de smoke + mocks + setup compartido.
- **Sin cambios al motor** (cerrado en D2a.4).

**Tests entregados (7)**:
1. ✅ Smoke happy path con `immediateResponse` (modo interactivo).
2. ✅ Smoke con `paused_hitl` + `resumeTask` (modo desacoplado).
3. ✅ State validation rechaza input con prop extra (rompe `additionalProperties: false`).
4. ✅ State validation rechaza output de nodo LLM con tipo incorrecto.
5. ✅ Prompt snapshot se persiste en al menos 2 nodos LLM (classify y summarize).
6. ✅ Replay del workflow completo con input distinto.
7. ✅ Confidence gating lee el campo `confidence` del output.

**Bugs descubiertos durante implementación (todos arreglados en el fixture, NO en el motor)**:
1. El motor valida `{ input }` (envuelve) contra el `stateSchema` — el `stateSchema` debe declarar `input` como propiedad explícita (no asumir props sueltas). Fixture arreglado.
2. El motor inicializa `state = { input: ... }` — los templates `{{state.documentId}}` deben ser `{{state.input.documentId}}`. Fixture arreglado.
3. El `node-runner.ts` lee `node.systemPrompt` y `node.userPrompt` separados — NO usa `input.from.template` como prompt. Fixture arreglado.
4. El `output.to.template` no se procesa (escribir el output completo, no interpolar). Fixture arreglado (quité el template del output del `summarize`).
5. La detección de `additionalProperties: false` se necesita para forzar SCHEMA_VIOLATION en input (sin `required`, el input `{}` pasa). Fixture arreglado.

**Conteo final**: 107 (motor) + 7 (D2a.5) = **114/114 tests pasan**. Cero regresiones.

**Decisiones que tomé yo en este turno (registradas en spec §8)**:
1. Usar el workflow del DSL spec §5 sin reinventarlo.
2. Dos modos de HITL testeados (`immediateResponse` + `paused_hitl` + `resumeTask`) — cubre ambos patrones de uso.
3. JSON en `tests/fixtures/` separado del test, para legibilidad y reutilización.
4. Cero cambios al motor en este sprint (los bugs descubiertos eran del fixture, no del motor — el motor funcionó como siempre).
5. 7 tests de smoke, no exhaustivo (los edge cases ya están cubiertos por unit tests).
6. Mocks específicos al workflow, no genéricos — el smoke test valida state correcto.

**Correcciones aplicadas durante la auditoría del spec (commit `007cd7f`)**:
- Mock LLM identifica nodo por `userPrompt`/`systemPrompt`, NO por `model` (que es compartido).
- `validateWorkflow` en setup es opcional (el motor ya valida en `startTask`).
- Test 3 (input inválido) usa input con tipo incorrecto, no `null` (el schema no requiere propiedades).
- Test 5 (prompt snapshot) verifica al menos 2 nodos LLM, no solo `classify`.
- JSON del fixture usa `additionalProperties: false` en vez de `required` (decisión del fixture, no del DSL).

**Deuda menor para sprints futuros (NO arreglada, documentada)**:
- El spec DSL §5 (que es la fuente del workflow) tiene los prompts en `input.from.template` (mal — el motor lee `node.systemPrompt`/`node.userPrompt`). El fixture lo corrige. **El spec DSL §5 debería actualizarse para reflejar la forma correcta de los nodos LLM**. Out of scope de D2a.5 (es un fix de docs, no de motor).
- El spec DSL §5 también tiene un bug en el `output.to.template` del `summarize` (que el motor no soporta). El fixture lo corrige quitando el template. Mismo comentario: actualizar el spec DSL.

---

## Sprint recién cerrado: D2a.2.3

**Qué cubre**: cierra 5 gaps del motor + implementa las primitivas no negociables que la roadmap §6.1 lista y el DSL spec §6 define contractualmente.

**Componentes entregados**:
- State schema validation (input + post-output). Acoplado a `ajv` (draft-07).
- Prompt snapshot persistence para nodos LLM (audit: "qué le dijimos al modelo").
- Time travel / replay: `replayTask()` clona task, NO comparte cache, hereda tenantId, usa workflowVersion actual.
- Schema versioning LAZY al ejecutar (no en parseWorkflow) con `Task.migratedWorkflow` + `appliedMigrations`. Decisión motivada por audit legal de Worgena.
- Circuit breaker interface + `NoopCircuitBreaker` default. `isOpen` se consulta antes de CADA attempt. Política real se enchufa en D2b.
- Limpieza de HITL paused branch (dead code eliminado).
- `cleanup()` ya NO elimina la task del map. Nuevo `purgeTask()` para eliminación total. **Backward-incompatible** (documentado).

**Decisiones de diseño con implicaciones para el futuro**:
- **Migración lazy al ejecutar** (no eager): el workflow persistido en DB mantiene su `schemaVersion` original. La task guarda qué migraciones se aplicaron. El replay usa la versión migrada (no re-aplica). Para Worgena-legal, esto preserva la coherencia del audit.
- **DI del registry de migradores**: el `Map<string, Migrator>` se inyecta al `ExecutorConfig`. No global mutable.
- **Circuit breaker: interfaz en motor, policy en D2b**: el motor no implementa la policy. D2b enchufa la implementación real.
- **`specialistId` opaco**: hoy se mapea a `node.model`. Mañana (D2b) se mapea a specialist ID real (más granular que el modelo).

**Archivos tocados** (10):
- `src/agent/workflow-engine/migrations.ts` (nuevo)
- `src/agent/workflow-engine/executor/circuit-breaker.ts` (nuevo)
- `src/agent/workflow-engine/executor/state.ts` (+ `validateStateAgainstSchema`)
- `src/agent/workflow-engine/executor/node-runner.ts` (+ promptSnapshot, circuitBreaker report)
- `src/agent/workflow-engine/executor/types.ts` (+ ExecutorConfig fields, -NodeExecutionPaused)
- `src/agent/workflow-engine/executor/errors.ts` (+ códigos)
- `src/agent/workflow-engine/executor/executor.ts` (state validation, replayTask, cleanup/purgeTask, loadAndMigrate)
- `src/agent/workflow-engine/executor/index.ts` (barrel actualizado)
- `src/agent/workflow-engine/dsl/parser.ts` (doc: NO llama a loadWorkflow)
- `src/agent/workflow-engine/dsl/types.ts` (+ Task.migratedWorkflow, + Task.appliedMigrations)
- `test_workflow_d2a_2_3.mts` (nuevo, 36 tests)

---

## Decisiones recientes con link al spec

| Decisión | Dónde está documentada | Sprint |
|---|---|---|
| Migración lazy al ejecutar (no eager) | `AGENT_D2A_2_3_CORE_PRIMITIVES_SPEC.md` §7.4 | D2a.2.3 |
| `cleanup()` retiene task, `purgeTask()` elimina | `AGENT_D2A_2_3_CORE_PRIMITIVES_SPEC.md` §9.3 | D2a.2.3 |
| Replay: `replayOf`, `tenantId` heredado, `workflowVersion` actual, cache no compartido | `AGENT_D2A_2_3_CORE_PRIMITIVES_SPEC.md` §6 | D2a.2.3 |
| Circuit breaker interfaz en motor, policy en D2b | `AGENT_D2A_2_3_CORE_PRIMITIVES_SPEC.md` §3, §8 | D2a.2.3 |
| State validation: acoplado a `ajv` (draft-07), no portable a otros validadores | `AGENT_D2A_2_3_CORE_PRIMITIVES_SPEC.md` §4.5.1 | D2a.2.3 |
| SaC / "Code as interface": NO en motor (Capa 1), SÍ en D2b como specialist (Capa 3) con primitivas CERRADAS | `AGENT_ROADMAP.md` §5.15 | vigente 2026-06-10 |
| Orden por fundamento, no por velocidad de feedback (regla meta) | `AGENTS.md` regla 6b | vigente 2026-06-10 |
| Credenciales literales, jamás inventar prefijos (anti-patrón: "zen-" agregado a sk-) | `AGENTS.md` regla 5a | vigente 2026-06-10 |
| Error handling: cliente final NUNCA ve detalle técnico; mensaje genérico + log interno | `AGENTS.md` + `src/lib/llm-errors.ts::getUserMessage` | vigente 2026-06-09 |

---

## Próximo sprint propuesto

**Orden fundamental → ligero** (regla 6b). El motor ya está cerrado (D2a.2.3). Lo que viene:

| # | Sprint | Esfuerzo | Por qué este orden |
|---|---|---|---|
| 1 | **D2a.4 — HITL primitives** | 0.5 día | Sin esto, el motor no puede expresar workflows que requieren intervención humana. Bloquea a D2a.5. |
| 2 | **D2a.5 — Workflow ejemplo end-to-end** | 1-2 días | Smoke test del motor entero (state validation + replay + schema versioning + circuit breaker + HITL). Cierra D2a. |
| 3 | **D2a.3 (original, NO el 2a.2.3) — Observabilidad** | 0.5 día | Útil pero NO fundamental. Se puede hacer después con el motor probado. |
| 4 | **D2b — Multi-model + specialists (con SaC)** | 3-4 días | Capa 3, depende de D2a cerrado. Aquí entra `investigator_specialist` con `pythonSandbox` (decisión §5.15). |

**Recomendación**: arrancar con **D2a.4**. Es chico, desbloquea workflows reales, y permite llegar a D2a.5 con todo el motor cerrado.

---

## Gotchas conocidos

1. **`DISABLE_HMR=true` en `.env`**: el dev server NO recarga código automáticamente. Cambios en TypeScript requieren `Ctrl+C` + `npm run dev` para aplicarse. Esto es intencional (evita errores intermitentes en tests), pero el próximo M3 lo va a sufrir si no lo sabe.
2. **Error type `ExecutorError.code`**: solo acepta códigos del catálogo literal. Si necesitás un código nuevo, agregalo en `errors.ts` Y en el union `ErrorCode` de `dsl/types.ts`.
3. **`cleanup()` ya NO elimina la task del map** (cambio D2a.2.3). Si algún test preexistente asume el comportamiento viejo, va a fallar. Usar `purgeTask()` para eliminación total.
4. **`node-runner.ts:348` y `parser.ts:146,258,259`**: errores TS preexistentes. No los toques, son del equipo anterior.
5. **`test_workflow_executor.mts:551, 1430`**: directivas `@ts-expect-error` huérfanas. No las toques.
6. **El spec DSL `validateWorkflow` retorna discriminated union con narrowing implícito**: a veces TS no narrowea bien en el call site. Workaround usado en `executor.ts:151`: cast explícito. Si ves ese patrón, no es un bug, es el workaround acordado.
7. **Tests de LLM en `node-runner.ts::runLLMNode`**: el motor ahora consulta `breaker.isOpen(specialistId)` ANTES de CADA attempt. Si vas a escribir tests de retry, recordá que con breaker abierto, ni el primer attempt se invoca.
8. **El spec DSL `stateRef` se valida con `interpolate`**: si un path no existe, retorna `""` (string vacío), no `undefined` ni error. El `promptSnapshot` refleja esto. Documentado en `AGENT_D2A_2_3_CORE_PRIMITIVES_SPEC.md` §5.2.
9. **Tasks `paused_hitl` se pierden en restart del server** (limitación D2a). La pausa vive en el `Map<taskId, Task>` del executor. Workaround: el caller persiste externamente el `taskId` y el `requestId` para poder recrear la task. D3 introduce DB y sweeper en startup.
10. **El `HITLHandler` no se cablea al server en D2a.4**. D2a.4 implementa la primitiva (`initiate` + `resumeTask`) con mocks para tests. La integración productiva con un canal externo (email, Slack, webhook) se diseña en D2a.5+ cuando se cablee el motor.

---

## Convenciones vigentes

- **Spec-first**: para componentes arquitectónicos nuevos, escribir el spec antes de codear. El spec es el contrato. Cambios al spec se acuerdan antes de tocar código.
- **Toda decisión se documenta en la misma sesión** que se decide (regla del roadmap §1). Lo que no está en el roadmap no existe.
- **Orden por fundamento, no por velocidad** (regla 6b): para cada item, "¿qué se rompe si esto no está?". Las cosas que rompen algo van primero.
- **Tests en archivos `.mts`**, no `.ts`. El runner es `npx tsx test_*.mts`. Los tests de D2a.2.3 viven en `test_workflow_d2a_2_3.mts` separados del original.
- **Comentarios en código, mensajes de commit, contenido de docs**: en español consistente (regla 10 de AGENTS.md).
- **Multi-tenancy**: single-tenant por workflow en D2a. Multi-tenancy real entra en D3. NO diseñar para multi-tenant antes de D3 (premature optimization — los 3 desacuerdos del peer M3 sobre composite key en circuit breaker ilustran esto).
- **Provider-agnostic**: el motor no acopla a un proveedor de LLM. La policy de routing por tier es D2b.
- **Audit legal primero**: en Worgena-legal, el audit log es el activo más importante. Si una decisión compromete la trazabilidad (ej: eager migration que miente sobre qué versión corrió), no se hace. La coherencia del audit pesa más que la simplicidad del código.

---

## Changelog del handoff

- **2026-06-10**: creado. Cierre de D2a.2.3 (spec v1.1 + implementación + 89 tests). 36 tests nuevos en `test_workflow_d2a_2_3.mts`. Decisión sobre SaC documentada en `AGENT_ROADMAP.md` §5.15. Regla 6b agregada a `AGENTS.md`.
- **2026-06-10 (cierre del día)**: sprint D2a.4 cerrado. Spec `AGENT_D2A_4_HITL_PRIMITIVES_SPEC.md` v1.0 escrita, auditada y revisada post-implementación. Implementación completa del motor: separación de fases pause/resume con `HITLHandler.initiate()` no-bloqueante + `executor.resumeTask()`. 18 tests nuevos en `test_workflow_d2a_4.mts`. Suite completa del motor: **107/107 tests pasan** (53 + 36 + 18). Cero regresiones. D2a cerrado. Próximo sprint propuesto: D2a.5 (workflow ejemplo end-to-end).
- **2026-06-12 (mañana)**: sprint D2a.5 cerrado. Spec `AGENT_D2A_5_SPEC.md` v1.0 escrita, auditada y corregida (4 correcciones aplicadas: mock LLM identifica nodo por prompt no por model, validateWorkflow redundante, test 3 con tipo incorrecto no null, test 5 con 2 nodos LLM). Fixture JSON `tests/fixtures/revision-generica.workflow.json` creado. 7 tests nuevos en `test_workflow_d2a_5.mts` (smoke end-to-end del workflow). 5 bugs descubiertos en el fixture (no en el motor), todos arreglados: motor valida `{ input }` envuelto, state inicializa con `input`, prompts en `systemPrompt`/`userPrompt` separados, output.to.template no se procesa, additionalProperties:false necesario para validación estricta. Suite completa del motor: **114/114 tests pasan** (53 + 36 + 18 + 7). Cero regresiones. **D2a cerrado completo**. Próximo sprint propuesto: D2b (multi-modelo + specialists).
- **2026-06-12 (D2b.1)**: sprint D2b.1 cerrado. Spec `AGENT_D2B_1_SPEC.md` v1.0 escrita y auditada. 8 archivos nuevos en `src/agent/specialists/` (TierResolver, SpecialistRegistry, 3 specialists, 2 mocks, barrel). Modificaciones mínimas al motor. Fixture `revision-generica.workflow.json` con `assignedSpecialist` en `classify`. 16 tests nuevos en `test_workflow_d2b_1.mts`. **130/130 tests pasan**. Cero regresiones. D2b.1 cerrado.
- **2026-06-12 (D2b.2)**: sprint D2b.2 cerrado. Spec `AGENT_D2B_2_SPEC.md` v1.0 escrita y auditada (20 decisiones). 5 archivos nuevos en `src/agent/llm/` (cliente HTTP con `fetch` directo, errores con código del motor, invoker, pricing catalog, barrel) + 3 archivos nuevos en `src/agent/specialists/` (AgentCard A2A v1.0, Lifecycle state machine, 3 cards pre-construidos). Refactor de 4 archivos en `specialists/` (+agentCard, +lifecycle, +transiciones, sub-sesión del verifier con prompt limpio, Citation Grounding v2 heurística). 56 tests nuevos en `test_workflow_d2b_2.mts` (incluyendo smoke E2E con OpenRouter real que retornó `modelUsed=deepseek/deepseek-chat-v3, costUsd=$0.0000139`). 2 tests D2b.1 actualizados por cambios de contrato intencionales (`agentVersion` a `"1.0.0"` desde el agentCard, output del verifier con metadata de audit). 6 bugs encontrados y arreglados durante implementación (el más interesante: tabla del Lifecycle no permitía `done → busy` y rompía el replay, arreglado). **221/221 tests pasan**. Cero regresiones. **D2b cerrado completo** (multi-modelo real + 3 specialists reales + Agent Cards + Lifecycle + sub-sesión verifier). Próximo sprint propuesto: D2c (skills v1 + principios jurídicos colombianos).
- **2026-06-12 (AUDIT_D2_CLEANUP, tarde)**: sprint de limpieza que arregla 18 de 27 hallazgos de `AUDIT_D2_2026-06-12.md` en orden de urgencia. Sin features nuevas. 1 crítico (CRIT-2: tools silenciosamente perdidas — ahora falla loud), 6 mayores (MAY-1/3/4/5/6/10), 8 menores (MIN-1/3/5/6/7/8/11 + NIT-5), 2 nits. 3 cambios breaking: MAY-1 (`loadWorkflow` ahora retorna `{workflow, appliedMigrations}`), MIN-5 (`NodeResult.costUsd` no opcional), MIN-7 (tira error en agentId duplicado). 12 archivos de código tocados + 2 specs (D2b.2 §3.2 encoding fix, §5.8 MAY-8, §5.9 MIN-8). **227/227 tests pasan** (221 + 6 nuevos). Cero regresiones. **D2 listo para D2c**. Pendiente: MAY-7 (signature de factory), MAY-2 (doc fix), MAYR-LEGAL (esperar D3 con DB).
- **2026-06-12 (AUDIT_D2_CLEANUP #2, noche)**: sprint de limpieza que cierra 4 hallazgos pendientes del #1. MAY-2 cerrado: cleanup() documentado como 'soft reset' (libera 2: cache + flag cancelacion; retiene 3: task + workflow + status). Spec sec 9.3 y doc en executor.ts sincronizados. MAY-7 cerrado: SpecialistFactory ahora acepta preferredModel opcional. Si esta presente, el registry invoca el factory 1 vez (antes 2: stub + real). 5 callers actualizados. Fallback backward-compat. NIT-1 y NIT-4 re-clasificados como falsos de mi auditoria. 3 tests nuevos (1 MAY-2, 2 MAY-7). 230/230 tests pasan. tsc limpio. Decision del founder sobre CRIT-1/MAYR-LEGAL: opcion B - esperar a D3 (multi-tenant + DB) y meterlo ahi. 1 tabla paused_tasks es trabajo chico dentro del sprint D3.
