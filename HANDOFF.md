# Worgena — Handoff Operativo

> **Documento meta.** NO es decisión arquitectónica (eso vive en `AGENT_ROADMAP.md`).
> Es contexto de sesión: dónde quedamos, qué leer primero, qué viene.
> Se actualiza al cierre de cada sprint que cambia dirección.
>
> **Regla de mantenimiento**: la primera acción de una nueva sesión debería ser leer este doc + `AGENT_ROADMAP.md` + `AGENTS.md`. Después leer el spec del sprint activo. Recién ahí meterse en el código.

---

## Estado al cierre de esta sesión

**Fecha**: 2026-06-12
**Sprint cerrado**: **D2b.1 — Multi-Model Router + 3 Specialists (con mocks)**. D2b.1 cerrado completo.
- Spec: `AGENT_D2B_1_SPEC.md` v1.0 (cerrada tras auditoría, 18 decisiones registradas).
- Implementación: 8 archivos nuevos en `src/agent/specialists/` (TierResolver, SpecialistRegistry, 3 specialists, 2 mocks, barrel) + 1 test file (`test_workflow_d2b_1.mts`, 16 tests).
- Modificaciones mínimas al motor: `dsl/types.ts` (+`assignedSpecialist`, +`metadata.executedBy`), `dsl/schema.ts` (+`assignedSpecialist`), `executor/types.ts` (+TierResolver, +SpecialistRegistry en ExecutorConfig), `executor/node-runner.ts` (routing al specialist), `executor/executor.ts` (validación en startTask, setea metadata).
- Fixture actualizado: `tests/fixtures/revision-generica.workflow.json` con `assignedSpecialist` en `classify`.
- Tests: **130/130 pasan** (53 + 36 + 18 + 7 + **16 nuevos en `test_workflow_d2b_1.mts`**). Cero regresiones.

**Próximo sprint propuesto**: **D2b.2** — verifier en sub-sesión real + Agent Cards JSON tipo A2A + lifecycle `spawn→idle→busy→paused→done→archived` + integración real con OpenRouter + cost attribution con pricing real + Citation Grounding v2 (roadmap §5.13).

**D1 cerrada**, **D2a cerrado** (motor completo), **D2b.1 cerrado** (multi-modelo + 3 specialists con mocks). Pendiente: D2b.2 (specialists reales), D2c (skills v1), D3 (multi-tenant), D4 (memoria), D5 (RAG), D6 (editor).

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

## Sprint recién cerrado: D2b.1

**Qué cubre**: primer sprint de D2b (multi-modelo + specialists, roadmap §6.2). Introduce el `TierResolver` configurable (liviano + robusto), los 3 specialists del roadmap (`IntakeSpecialist`, `ClauseReviewerSpecialist`, `VerifierSpecialist`) con mocks, y el routing por `node.assignedSpecialist`. Capa 3 del sistema agéntico (workflow engine es Capa 1).

**Componentes entregados**:
- 8 archivos nuevos en `src/agent/specialists/`: `tier-resolver.ts`, `specialist.ts`, `specialist-registry.ts`, `intake-specialist.ts`, `clause-reviewer-specialist.ts`, `verifier-specialist.ts`, `mocks/mock-invokers.ts`, `index.ts` (barrel).
- Modificaciones al motor (mínimas): `dsl/types.ts`, `dsl/schema.ts`, `executor/types.ts`, `executor/node-runner.ts`, `executor/executor.ts`, `executor/index.ts`. **El motor de D2a sigue funcionando tal cual** — los cambios son aditivos.
- `tests/fixtures/revision-generica.workflow.json` actualizado con `assignedSpecialist` en `classify`.
- `test_workflow_d2b_1.mts` con 16 tests (1 bonus sobre los 15 planeados).

**Tests al cierre**: **130/130 pasan** (53 originales + 36 D2a.2.3 + 18 D2a.4 + 7 D2a.5 + 16 D2b.1). Cero regresiones.

**Decisiones más opinadas (registradas en `AGENT_D2B_1_SPEC.md` §8, 18 decisiones)**:
- D2b en 2 sprints cortos, no 1 ni 3. Balance control/velocidad.
- Specialist hace TODA la lógica del nodo (system + user + output validation + confidence gating). Node-runner es pasivo. Razón: el specialist tiene el system prompt; el motor no sabe esas reglas.
- Falla fast en `startTask` si `assignedSpecialist` no existe (validación al cargar, `NODE_NOT_FOUND`). No en runtime.
- D2b.1 son mocks con prompts genéricos. Principios jurídicos (roadmap §5.14) entran en D2b.2 con skills v1 de D2c.
- Circuit breaker sigue siendo por modelo en D2b.1 (D2a.4). Circuit breaker por specialist queda para D2b.2 con Agent Cards.
- `assignedSpecialist` opcional en el LLMNode. Backward-compat: workflows sin el campo se ejecutan idéntico a D2a.4.
- `tierResolver` opcional en ExecutorConfig. Sin él, el motor usa `llmInvoker` default (D2a.4).
- `NodeResult.metadata.executedBy` opcional, se popula solo para nodos con specialist.

**Lo que NO toca D2b.1** (deuda a D2b.2): integración real con OpenRouter, Agent Cards formales (JSON tipo A2A), lifecycle `spawn→idle→busy→paused→done→archived`, cost attribution con pricing real, verifier en sub-sesión aislada, Citation Grounding v2, MCP, principios jurídicos colombianos en prompts.

**Notas de implementación**:
- El `Specialist` interface requiere un campo `agentVersion: string` (no se me ocurrió en la spec original, lo agregué durante la implementación para que el motor pueda poblar `metadata.executedBy` sin consultar el registry dos veces). El valor es `SPECIALIST_AGENT_VERSION = "1.0.0-d2b.1"`.
- El `executor/types.ts` importa SOLO TIPOS de los specialists (no el barrel) para evitar ciclo de runtime. Los specialists importan del motor, y el motor importa solo tipos que TypeScript borra.
- El `mock-invokers.ts` retorna shapes específicos por specialist (detectado por substring del system prompt), no genéricos. Esto hace que los tests deterministas y detecta routing incorrecto.
- El test D2a.5 (`test_workflow_d2a_5.mts`) tuvo que actualizarse para proveer un `SpecialistRegistry` ahora que el fixture declara `assignedSpecialist` en `classify`. Los 7 tests D2a.5 siguen pasando sin cambios en asserts (el specialist usa como invoker el mismo `RevisionGenericaLLM` mock del test).
- Solo `classify` del fixture tiene `assignedSpecialist`. `extract` y `summarize` no porque `ClauseReviewerSpecialist` espera shapes distintos a los que el mock del fixture retorna (decisión documentada: el campo es opcional, no obligatorio en TODOS los nodos LLM).

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
