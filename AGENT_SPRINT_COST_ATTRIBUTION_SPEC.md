# Sprint — Backlog P0 #3: Cost Attribution por Tenant

> **Sprint**: Backlog P0 #3 (último item del backlog).
> **Spec vivo**: este documento.
> **Razón de existir**: el último item P0 crítico del backlog. Sin esto no podemos cobrar por uso ni detectar fuga de tokens. Habilita el modelo de revenue per-tenant.

## 1. Contexto

El LLM invoker (`OpenRouterLLMInvoker`) ya retorna `costUsd` en cada respuesta (D2b.2). Pero **no se persiste con qué tenant/task/node se incurrió el costo**. `step_logs` lo trackea pero a nivel de sesión de usuario, no de tenant — y joins con `workflow_audit` (que sí tiene `tenantId`) no están cableados.

**Riesgo si no se cierra**:
- No podemos cobrar por uso (no hay unit economics).
- No podemos detectar fuga de tokens (un prompt mal armado que gasta 10x lo normal pasa desapercibido).
- Auditor enterprise pregunta "¿cuánto nos cobraste por tenant X?" y no podemos responder.

**Bloquea**: cualquier modelo de revenue per-tenant. Después de cerrar esto, podemos pasar a D4 (memoria 4 capas, el siguiente sprint del roadmap).

**Bloqueado por**: D3.3 cerrado (✓, provee `workflow_audit` interface + tabla). `OpenRouterClient` ya retorna `costUsd` (✓). Solo falta cablearlos.

## 2. Objetivos (qué SÍ se hace)

- **O1**. `WorkflowAuditEventType` extendido con `llm_call`. Tabla `workflow_audit` ya soporta cualquier `event_type` (TEXT sin constraint) — no requiere migración.
- **O2**. Método nuevo en `WorkflowAudit` interface: `recordLLMCall(params: LLMCallAuditEvent)`. Persiste `{tenantId, taskId, nodeId, agentCardId?, model, inputTokens, outputTokens, costUsd, durationMs}`.
- **O3**. `OpenRouterLLMInvoker` acepta un `WorkflowAudit` opcional en el constructor. Cuando está presente y el caller provee `taskId`/`nodeId` en `LLMInvokeParams`, registra el evento después de cada `chat()` exitoso.
- **O4**. `LLMInvokeParams` extendido con campos opcionales: `tenantId?`, `taskId?`, `nodeId?`, `agentCardId?`. Backward-compat: si no se proveen, no se registra el evento.
- **O5**. `node-runner.ts` (motor) pasa `tenantId`, `taskId`, `nodeId` al invoker cuando los tiene. D2a.4 ya tiene acceso a `task.tenantId` y `task.id`. `nodeId` viene del loop.
- **O6**. **6 tests nuevos** en `test_cost_attribution.mts`:
  - invoker con audit: cada `chat()` registra 1 row.
  - invoker sin audit: NO registra nada (no-op).
  - 5 nodos consecutivos: 5 rows con `costUsd` consistente.
  - `costUsd` de `usage.cost` (OpenRouter) tiene prioridad sobre `estimateCost` (fallback).
  - row incluye `tenantId` y `taskId` correctos.
  - Failure path (API error): NO registra (cost = 0 no se persiste).

## 3. No-objetivos (qué NO se hace)

- **NO-1**. Persistir el `raw` response en el audit (eso es `step_logs` de D1). El audit solo guarda el evento + metadata ligera.
- **NO-2**. Atribución per-agent-card con model pricing custom por tenant. D6+ cuando entra multi-tenant pricing.
- **NO-3**. Dashboard de UI para visualizar cost. D6+ (editor de skills) podría tener un panel de billing.
- **NO-4**. Backfill de `workflow_audit` con events de `llm_call` históricos. Solo aplica a runs futuros. Backfill queda como TODO documentado.
- **NO-5**. Cost attribution para embeddings (Tier 2). Hoy embeddings se logean en `step_logs` pero NO van al workflow audit. D6+ si compliance lo pide.
- **NO-6**. Migración a Postgres (eso es D5). Sigue en SQLite. El workflow_audit schema es compatible con Postgres.

## 4. Primitivas no negociables

- **P1. Audit es secundario.** Si el `record()` falla, el invoker NO falla. Log a stderr y sigue. El LLM call es primario; el audit es observabilidad.
- **P2. `costUsd` siempre viene de OpenRouter `usage.cost` cuando está disponible.** Si no, `PricingCatalog.estimateCost()`. Si tampoco, 0. NUNCA inventar valores.
- **P3. Backward-compat.** El cambio en `LLMInvokeParams` es aditivo (campos opcionales). Los callers existentes siguen funcionando.
- **P4. Tests deterministas.** Los mocks deben retornar `usage.cost` fijo para que el test no dependa de fluctuaciones reales del catálogo.

## 5. Diseño (alto nivel)

```
┌──────────────────────────────────────────────────────────────────┐
│  WorkflowExecutor (D2a.4 + D3.3)                                │
│  - Tiene acceso a: task.tenantId, task.id, currentNode.id       │
│  - Llama node-runner.ts con este contexto                       │
└──────────────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────────────┐
│  node-runner.ts                                                 │
│  - Construye LLMInvokeParams con tenantId, taskId, nodeId       │
│  - Llama LLMInvoker.invoke(params)                               │
└──────────────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────────────┐
│  OpenRouterLLMInvoker (D2b.2 + este sprint)                     │
│  - Recibe WorkflowAudit opcional en constructor                 │
│  - Después de client.chat(): si audit && params.taskId,           │
│    audit.recordLLMCall({tenantId, taskId, nodeId, model,         │
│    inputTokens, outputTokens, costUsd, durationMs})            │
└──────────────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────────────┐
│  workflow_audit table (D3.3)                                    │
│  - Row: tenant_id, task_id, event_type, payload_json, created_at│
│  - event_type='llm_call'                                        │
│  - payload_json: {nodeId, agentCardId, model, tokens, cost, ...} │
└──────────────────────────────────────────────────────────────────┘
```

## 6. Archivos a tocar / crear

| Archivo | Acción | Razón |
|---|---|---|
| `src/agent/workflow-engine/persistence/workflow-audit.ts` | modificar | Agregar `llm_call` a `WorkflowAuditEventType` union type. Agregar interface `LLMCallAuditEvent` y método `recordLLMCall()` a `WorkflowAudit`. |
| `src/agent/workflow-engine/persistence/sqlite-workflow-audit.ts` | modificar | Implementar `recordLLMCall()` (INSERT con event_type='llm_call'). |
| `src/agent/workflow-engine/persistence/in-memory-workflow-audit.ts` | modificar | Implementar `recordLLMCall()` (push a array). |
| `src/agent/workflow-engine/persistence/workflow-audit.ts` (interface) | modificar | Backward-compat: `record()` queda deprecated pero sigue funcionando. `recordLLMCall()` es la nueva API. |
| `src/agent/workflow-engine/executor/types.ts` | modificar | `LLMInvokeParams` extendido con campos opcionales. |
| `src/agent/llm/openrouter-invoker.ts` | modificar | Constructor acepta `audit?`. Después de `client.chat()`, si `params.taskId` y audit, llama `recordLLMCall`. |
| `src/agent/llm/index.ts` | modificar | Re-export del constructor con audit opcional. |
| `src/agent/workflow-engine/executor/node-runner.ts` | modificar | Pasa `taskId`, `nodeId`, `tenantId` a `LLMInvokeParams`. |
| `test_cost_attribution.mts` (nuevo) | crear | 6 tests E2E. |

## 7. Tests

**6 tests nuevos** en `test_cost_attribution.mts`:

| # | Test | Cubre |
|---|---|---|
| 1 | invoker con audit: cada `chat()` registra 1 row con cost + tokens | happy path |
| 2 | invoker sin audit: NO registra nada | backward-compat |
| 3 | 5 nodos consecutivos: 5 rows con `costUsd` consistente | multi-node attribution |
| 4 | `costUsd` usa `usage.cost` de OpenRouter cuando está disponible | priority de sources |
| 5 | row incluye `tenantId` y `taskId` correctos | scope correcto |
| 6 | Failure path (API error): NO registra (cost=0 no persiste) | graceful degradation |

**Regression**: 340 tests acumulados (D1-D3.5 + scrub secretos) deben seguir pasando.

## 8. Riesgos

| # | Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|---|
| 1 | Rompe callers existentes de `OpenRouterLLMInvoker` que no pasan audit | Baja | Bajo | Audit es opcional. Default undefined = no-op. |
| 2 | Cada chat() hace 1 INSERT adicional (perf cost) | Alta | Bajo | SQLite es <1ms. Para 100 LLM calls/min = 100 INSERTs/min = negligible. |
| 3 | Si `node-runner` no pasa tenantId/taskId, el audit no se hace | Media | Medio | P4: tests verifican el path completo. Documentar en `LLMInvokeParams` que para audit hay que pasar estos campos. |
| 4 | `costUsd` se persiste con valor 0 cuando OpenRouter no retorna `usage.cost` | Media | Bajo | Aceptable: 0 significa "no tenemos pricing data". Dashboard lo muestra como "unknown". |
| 5 | Race condition: dos nodos en paralelo escribiendo al audit | Baja | Bajo | Better-sqlite3 es sync. SQLite serializa writes. No race en proceso single. Multi-proceso: cada uno tiene su DB o migrar a Postgres (D5). |

## 9. Orden de ejecución (por FUNDAMENTO)

1. **`WorkflowAuditEventType` + interface `recordLLMCall`** — primitiva, no rompe nada.
2. **`SqliteWorkflowAudit.recordLLMCall` + `InMemoryWorkflowAudit.recordLLMCall`** — implementaciones.
3. **`OpenRouterLLMInvoker` acepta audit opcional + record tras chat()** — wire-up.
4. **`LLMInvokeParams` extendido + `node-runner` los pasa** — backward-compat preserved.
5. **Tests** — 6 nuevos.
6. **Regression** — 340 tests pre-existentes.

## 10. Definition of Done

- [ ] Objetivos de §2 implementados
- [ ] Cero objetivo de §3 implementado
- [ ] Primitivas de §4 todas en el código
- [ ] **6/6 tests nuevos** pasan
- [ ] **340/340 tests acumulados** siguen pasando, 0 regresiones
- [ ] `tsc` sin errores nuevos
- [ ] `BACKLOG_P0.md` actualizado (item #3 cerrado)
- [ ] `HANDOFF.md` actualizado
- [ ] **Commit + push** a `origin/master`

## 11. Open questions / decisiones diferidas

1. **¿Persistir el `model` como string o como FK a un catálogo de modelos?** String por ahora. D6+ si compliance pide normalización.
2. **¿Cost attribution per-stage (prompt vs completion tokens)?** Sí, ya está en `payload.inputTokens` y `payload.outputTokens`. Dashboard lo separa.
3. **¿Truncar `metadata` a N campos para no inflar la tabla?** No por ahora. SQLite maneja JSON bien. Forward-compat: si crece mucho, particionar.

## 12. Referencias

- `BACKLOG_P0.md` §3 (este sprint)
- `src/agent/llm/openrouter-client.ts` (returns `costUsd`)
- `src/agent/llm/openrouter-invoker.ts` (current invoker)
- `src/agent/workflow-engine/persistence/workflow-audit.ts` (interface D3.3)
- `src/agent/workflow-engine/executor/types.ts` (`LLMInvokeParams`)
- `src/agent/workflow-engine/executor/node-runner.ts` (caller)
- `AGENT_D3_3_AUTH_SWEEPER_AUDIT_SPEC.md` (D3.3 design)
- `AGENT_D2B_2_SPEC.md` (D2b.2 cost tracking en LLM)