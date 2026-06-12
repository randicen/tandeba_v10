# D2b.1 — Multi-Model Router + 3 Specialists: Spec

> **Spec para D2b.1.** Primer sprint de D2b (multi-modelo + specialists, roadmap §6.2). Implementa el multi-model router con 2 tiers (liviano + robusto) y los 3 specialists del roadmap (`intake_specialist`, `clause_reviewer_specialist`, `verifier_specialist`), con mocks. La integración real con OpenRouter, los Agent Cards formales (JSON tipo A2A), el lifecycle, y el verifier en sub-sesión aislada son **D2b.2** (siguiente sprint).
>
> **Origen de la decisión**: en D2a el motor tiene `LLMInvoker` inyectable, pero no distingue entre tiers. Hoy todos los nodos LLM invocan el mismo `llmInvoker` (sea DeepSeek o M3 Thinking). D2b.1 introduce el routing por tier, modelado como un `TierResolver` que mapea `node.model: "liviano" | "robusto"` → invocador concreto. Los 3 specialists son sub-agentes de Capa 3 que ejecutan nodos LLM con prompts cortos, tools acotadas, y contexto limpio.

## 0. Status

- **Versión actual**: 1.0 (decisiones tomadas en este turno, 2026-06-12).
- **Alcance**: multi-model router + 3 specialists con mocks. Sin sub-sesión de verifier (D2b.2), sin Agent Cards formales (D2b.2), sin integración real con OpenRouter (D2b.2).
- **Cubre**:
  - **`TierResolver`**: interface que mapea `ModelRef` ("liviano" | "robusto" | nombre-específico) a un `LLMInvoker` concreto. Default: tier 1 (robusto) → tier 3 (liviano) según reglas configurables.
  - **3 specialists**: `IntakeSpecialist`, `ClauseReviewerSpecialist`, `VerifierSpecialist`. Cada uno con `agentId`, prompt corto, system prompt que declara su rol, `capabilities` (lista de skills/tools que sabe usar), y un método `execute(node, task, state) → NodeExecutionOutcome`.
  - **Agent ID básico**: cada specialist tiene un `agentId` (string estable) que se loguea en `NodeResult.metadata` (campo nuevo, opcional). Sin Agent Card formal todavía.
  - **Cost attribution básico**: cada `NodeResult` de un nodo LLM registra `tokensUsed` y `costUsd` (campos ya existen en D2a.2.3). Cada nodo anota qué specialist lo ejecutó en `metadata.executedBy`.
  - **Integración con el workflow**: el `WorkflowExecutor` sigue funcionando como en D2a.4. Los specialists se invocan desde el `node-runner` cuando el nodo LLM tiene `node.assignedSpecialist` (campo nuevo, opcional) — si no, usa el `llmInvoker` default.
  - **Mappers de tier**: `liviano` → invocador liviano (mock DeepSeek Flash en D2b.1), `robusto` → invocador robusto (mock M3 Thinking en D2b.1).
- **NO cubre** (llegará cuando duela):
  - **Sub-sesión de verifier** (D2b.2): hoy el `verifier_specialist` ejecuta en el mismo proceso, no en sesión nueva. La "sub-sesión" se mockea como un invocador separado.
  - **Agent Cards formales (JSON tipo A2A)** (D2b.2): hoy los specialists tienen `agentId` + `capabilities` simples. La Card completa con metadata OpenAPI-style entra en D2b.2.
  - **Lifecycle `spawn → idle → busy → paused → done → archived`** (D2b.2): hoy el lifecycle es implícito en el runLoop. El lifecycle formal entra en D2b.2.
  - **Cost attribution con pricing real** (D2b.2): hoy se registra `costUsd` que retorna el invocador (mock = 0). D2b.2 introduce pricing por modelo.
  - **Integración real con OpenRouter** (D2b.2): el `OPENROUTER_API_KEY` ya existe en `.env` pero no se usa. D2b.2 enchufa el `OpenRouterClient` real.
  - **Citation Grounding v2** (roadmap §5.13, depende del verifier en sub-sesión): D2b.2.
  - **SaC (code-as-interface)** (roadmap §5.15): D2b+ según demanda de cliente.
  - **Skills v1** (D2c): después de D2b.
- **Implementación esperada**: ~500-700 LoC (más que D2a.4 por el alcance). Tests: ~12-15 nuevos en `test_workflow_d2b_1.mts`.
- **Owner del cambio**: este spec vive en el repo. Modificaciones requieren acuerdo explícito antes de mergear.

---

## 1. Por qué este spec existe

D2a cerró un motor de workflows capaz de ejecutar primitivas no negociables: state validation, retry, idempotency, replay, schema versioning, circuit breaker, HITL pause/resume. El motor está cerrado. Pero los nodos LLM del workflow invocan **un solo `LLMInvoker`** — el que el `ExecutorConfig` le pasa. No hay distinción entre "este nodo es trivial, usa tier liviano" vs "este nodo es razonamiento jurídico, usa tier robusto".

En la práctica, Worgena hoy usa M3 Thinking (tier 1) para casi todo. Eso es 10x más caro que DeepSeek Flash (tier 3) para nodos que no lo necesitan (clasificación, extracción simple). Multi-model routing baja costos sin sacrificar calidad — el tier correcto para cada nodo.

Además, hoy el `LLMInvoker` recibe `model: "liviano" | "robusto" | string` y lo pasa al provider. El mapping de tier → modelo concreto (ej: "liviano" → "deepseek/deepseek-chat" en OpenRouter) está hardcoded en el invocador. D2b.1 introduce el `TierResolver` que centraliza este mapping y permite configurarlo.

Finalmente, los specialists son sub-agentes de Capa 3 que ejecutan nodos LLM con prompts cortos y contexto limpio. En el workflow `revision-generica` de D2a.5, los nodos LLM usan el `llmInvoker` con un prompt fijo. En Worgena real, cada nodo LLM debería ejecutarlo un specialist con un prompt especializado (ej: "intake_specialist" para clasificar, "clause_reviewer_specialist" para analizar cláusulas). D2b.1 introduce estos 3 specialists y el mecanismo para invocarlos desde el workflow.

---

## 2. Goals & Non-goals

### 2.1. Goals (lo que D2b.1 DEBE cumplir)

1. **`TierResolver` configurable**: interface que mapea `ModelRef` → `LLMInvoker` concreto. Default: tier 1 (robusto) → "m3-thinking", tier 3 (liviano) → "deepseek-flash". El `ExecutorConfig` acepta un `tierResolver` opcional; si no se provee, se usa el `llmInvoker` default (backward-compat con D2a.5).
2. **Routing determinista**: el `TierResolver` es una función pura, no un LLM decidiendo en runtime. El `model` declarado en el nodo LLM se mapea a un invocador concreto sin ambigüedad.
3. **3 specialists implementados**:
   - `IntakeSpecialist`: tier 3 (liviano). Clasifica documentos. Prompt corto ("Sos un clasificador de documentos legales..."). Input: contenido del documento. Output: categoría + confidence.
   - `ClauseReviewerSpecialist`: tier 1 (robusto). Revisa cláusulas en busca de abusividad. Prompt largo con principios de derecho colombiano. Input: lista de cláusulas. Output: análisis de cada cláusula.
   - `VerifierSpecialist`: tier 1 (robusto). Verifica el output de un nodo anterior. Input: el output a verificar + el contexto. Output: verdict (pass/fail) + justificación.
4. **Cada specialist tiene `agentId` estable**: un string único que identifica al specialist en logs y métricas. Ej: `"intake_specialist_v1"`, `"clause_reviewer_specialist_v1"`, `"verifier_specialist_v1"`. Sin Agent Card formal todavía (eso es D2b.2).
5. **`capabilities` por specialist**: lista de skills/tools que el specialist sabe usar. Hoy son placeholders (los specialists no invocan tools aún; eso entra en D2b.2 con el verifier en sub-sesión). Pero la interface `capabilities: string[]` está para forward-compat.
6. **`node.assignedSpecialist` opcional**: el nodo LLM puede declarar qué specialist lo ejecuta. Si está, el motor delega al specialist. Si no, usa el `llmInvoker` default (backward-compat).
7. **El specialist se conecta al motor via la `LLMInvoker` interface**: el specialist **es un wrapper** alrededor de un `LLMInvoker` (el tier correspondiente). El motor no cambia su ciclo de vida; el `node-runner` detecta `node.assignedSpecialist` y enruta al specialist antes de invocar al LLM.
8. **Cost attribution básico**: cada `NodeResult` de un specialist lleva `metadata.executedBy: { agentId, agentVersion }` y el `costUsd` que el invocador retorna. Para audit y métricas por specialist.
9. **Sin cambios al motor**: el `WorkflowExecutor` y el `runLoop` no se tocan (D2a cerrado). El routing al specialist ocurre en el `node-runner` antes de invocar al LLM. Si el nodo no tiene `assignedSpecialist`, el comportamiento es idéntico a D2a.4.
10. **Mappers de tier como mocks**: en D2b.1, los `LLMInvoker` concretos son mocks que retornan outputs específicos por specialist (no por modelo). La integración real con OpenRouter (donde el `model` se traduce a "deepseek/deepseek-chat" o "anthropic/claude-3.5-sonnet") es D2b.2.
11. **Tests de smoke end-to-end**: el workflow `revision-generica` con `node.assignedSpecialist` en cada nodo LLM corre y completa. Cada nodo se ejecuta con el specialist correcto (verificable por `metadata.executedBy`).

### 2.2. Non-goals (D2b.1 — diferidos)

- **Sub-sesión de verifier**: el `VerifierSpecialist` en D2b.1 es un mock que retorna un output determinístico. No hay "sesión nueva" — el invocador es otro `LLMInvoker` separado. El verdadero "sesión nueva sin sesgo confirmatorio" es D2b.2.
- **Agent Cards formales (JSON tipo A2A)**: hoy los specialists tienen `agentId` + `capabilities` simples. La Card completa con metadata OpenAPI-style, `version`, `skills`, `endpoints`, etc. es D2b.2.
- **Lifecycle `spawn → idle → busy → paused → done → archived`**: hoy el lifecycle es implícito en el `runLoop`. El lifecycle formal con eventos y observabilidad es D2b.2.
- **Cost attribution con pricing real**: hoy `costUsd` es lo que el mock retorna (0). El pricing real por modelo (tokens × $/M) entra en D2b.2.
- **Integración real con OpenRouter**: el `OPENROUTER_API_KEY` ya existe en `.env` pero no se usa. El `OpenRouterClient` real entra en D2b.2.
- **Citation Grounding v2**: depende del verifier en sub-sesión (D2b.2). Roadmap §5.13.
- **Skills v1 (D2c)**: D2b.1 define la interface `capabilities: string[]` para forward-compat, pero no las usa.
- **SaC**: out of scope.
- **MCP**: el roadmap §5.8 dice "empezar consumiendo MCP de terceros". D2b.1 no introduce MCP. D2b.2 podría, si hay tiempo.
- **Fan-out/fan-in de specialists**: el roadmap §5.11 lo lista como "cuando". D2b.1 implementa solo secuencial.
- **Handoff entre specialists**: mismo, "cuando". D2b.1 secuencial.
- **UI de configuración de specialists**: D6 (editor de skills/workflows).

---

## 3. Decisiones de diseño

### 3.1. ¿Por qué 3 specialists y no 1 o 5?

**Decisión**: los 3 del roadmap §6.2 (`intake_specialist`, `clause_reviewer_specialist`, `verifier_specialist`).

**Razón**: el roadmap los define por rol funcional claro:
- `intake_specialist`: clasifica input nuevo (Capa 2 según §5.3, pero en D2b.1 se modela como Capa 3 invocable desde un nodo).
- `clause_reviewer_specialist`: revisa cláusulas (el caso de uso principal de Worgena).
- `verifier_specialist`: verifica outputs (defendibilidad legal).

Más specialists = más granularidad pero más overhead de mantener. Menos = menos precisión en el routing. 3 es el balance.

### 3.2. ¿Cómo se mapea `ModelRef` → `LLMInvoker`?

**Decisión**: `TierResolver` es una función pura `(modelRef: ModelRef) => { invoker: LLMInvoker, tier: 'liviano' | 'robusto' | string, model: string }`.

**Razón**: hoy el `node-runner` lee `node.model` y lo pasa directo al `llmInvoker.invoke()`. No hay separación entre "qué modelo" y "qué invocador". El `TierResolver` introduce esa separación: tier es la categoría (liviano/robusto), invoker es la implementación concreta, model es el nombre específico del modelo.

**Backward-compat**: si el workflow NO tiene `TierResolver` configurado, el `node-runner` usa el `llmInvoker` default del `ExecutorConfig` (igual que D2a.5). El `TierResolver` es opcional.

### 3.3. ¿Cómo se invoca un specialist desde el workflow?

**Decisión**: campo opcional `node.assignedSpecialist: string` (agentId) en el nodo LLM. Si está presente, el `node-runner` busca el specialist en un `SpecialistRegistry` inyectado al `ExecutorConfig` y lo usa en vez del `llmInvoker` default.

**Razón**: el specialist es un wrapper que se conecta al `LLMInvoker` (vía `TierResolver`). El motor no necesita saber que existe el specialist — solo ve un `LLMInvoker` configurado por specialist.

**Backward-compat**: si el nodo no tiene `assignedSpecialist`, el comportamiento es idéntico a D2a.4. Los workflows existentes (revision-generica de D2a.5) no necesitan cambios.

### 3.4. ¿Cómo se relaciona `TierResolver` con `LLMInvoker`?

**Decisión**: el `TierResolver` retorna un `LLMInvoker` (que es la interface que el motor ya conoce). El `SpecialistRegistry` se construye con el `TierResolver` y, al crear cada specialist, le pasa el `LLMInvoker` resuelto para su `preferredModel`. Cadena de delegación:

```
node-runner
  → specialistRegistry.get(agentId)        // devuelve Specialist
  → specialist.execute(params)             // Specialist tiene el invoker
    → invoker.invoke({system, user, ...})  // El LLM real (o mock)
```

**Razón**: el `SpecialistRegistry` centraliza la construcción. El motor no necesita saber cómo se construye cada specialist. El `TierResolver` solo sabe mapear `ModelRef → LLMInvoker`; el registry sabe qué specialist prefiere qué modelo.

```typescript
class IntakeSpecialist {
  constructor(
    public readonly agentId: string,
    public readonly capabilities: string[],
    private readonly invoker: LLMInvoker, // provisto por el registry al construirse
  ) {}
  async execute(params: SpecialistExecuteParams): Promise<NodeExecutionOutcome> {
    // 1. Construir system + user prompts del specialist (cortos, específicos).
    // 2. Llamar al invoker con system + user.
    // 3. Validar output contra node.outputSchema.
    // 4. Calcular confidence gating si node.confidenceGating está declarado.
    // 5. Retornar NodeExecutionOutcome con metadata.executedBy.
  }
}
```

**El specialist hace toda la lógica del nodo** (system + user prompt + output validation + confidence gating). El node-runner es **pasivo** para nodos con specialist — solo delega y recibe el outcome. El motor NO sabe que el specialist existe; sigue viendo un `LLMInvoker` que retorna un `NodeExecutionOutcome` (vía el specialist, transparentemente).

**Backward-compat**: si el nodo no tiene `assignedSpecialist`, el node-runner hace lo que hacía en D2a.4 (system + user prompt desde `node.systemPrompt`/`node.userPrompt` + invoke directo + output validation). El specialist es **opt-in**.

### 3.5. ¿Cómo se prueba sin API real?

**Decisión**: en D2b.1, los invocadores concretos son mocks:
- `MockDeepSeekFlashInvoker`: retorna outputs específicos para `intake_specialist` (clasificación).
- `MockM3ThinkingInvoker`: retorna outputs específicos para `clause_reviewer_specialist` y `verifier_specialist`.

Los tests usan estos mocks. La integración real con OpenRouter (D2b.2) los reemplaza.

### 3.6. ¿Dónde viven los specialists?

**Decisión**: en un nuevo directorio `src/agent/specialists/` (separado del motor `src/agent/workflow-engine/`). Tres archivos:
- `src/agent/specialists/intake-specialist.ts`
- `src/agent/specialists/clause-reviewer-specialist.ts`
- `src/agent/specialists/verifier-specialist.ts`
- `src/agent/specialists/specialist-registry.ts` (mapa de agentId → Specialist)
- `src/agent/specialists/tier-resolver.ts`

**Razón**: los specialists son Capa 3 según el roadmap §5.3. Separarlos del motor (Capa 1) y del DSL (interfaz) refleja la arquitectura de 3 capas. Si después agregamos más specialists, el directorio escala.

### 3.7. ¿Qué interface tiene un Specialist?

```typescript
interface Specialist {
  readonly agentId: string;
  readonly capabilities: string[];
  /** Modelo que el specialist prefiere (puede ser distinto del node.model). */
  readonly preferredModel: ModelRef;
  /**
   * Ejecuta un nodo LLM. Retorna el outcome que el nodo-runner pasaría
   * al motor si no hubiera specialist.
   */
  execute(params: SpecialistExecuteParams): Promise<NodeExecutionOutcome>;
}

interface SpecialistExecuteParams {
  readonly node: LLMNode;
  readonly task: Task;
  readonly state: WorkflowState;
  readonly signal?: AbortSignal;
  /** Tokens consumidos en invocaciones previas del mismo nodo (para retries). */
  readonly priorTokens?: { input: number; output: number };
}
```

**Razón**: la interface es mínima. El specialist recibe el nodo + state + task, retorna el outcome. El motor no ve el detalle de qué hizo el specialist adentro.

### 3.8. ¿Cómo se configura el `SpecialistRegistry` en el ExecutorConfig?

```typescript
interface ExecutorConfig {
  // ... campos existentes ...
  readonly tierResolver?: TierResolver;
  readonly specialistRegistry?: SpecialistRegistry;
}
```

Si `specialistRegistry` no está configurado, los nodos sin `assignedSpecialist` usan el `llmInvoker` default. Si está, los nodos con `assignedSpecialist` se delegan al specialist.

### 3.9. ¿Dónde va `metadata.executedBy`?

En el `NodeResult` (interface ya existente en `dsl/types.ts`). Hoy `NodeResult` tiene `confidence`, `confidenceValue`, `tokensUsed`, `costUsd`, `modelUsed`, `retryCount`, `idempotencyKey`, `error`, `output`, `input`, `promptSnapshot`, `startedAt`, `completedAt`, `durationMs`, `declinedReason`. **Agrego** `metadata?: { executedBy?: { agentId: string; agentVersion: string; tier: string; model: string } }`.

**Razón**: backward-compat (campo opcional). Permite auditoría de "qué specialist ejecutó qué nodo" sin romper tests existentes.

### 3.10. ¿Qué hace el verifier_specialist en D2b.1?

**Decisión**: el `VerifierSpecialist` en D2b.1 es un mock que **NO está en sub-sesión**. Recibe el output a verificar + el contexto y retorna `{ verified: true, confiance: 0.85, notes: "..." }` o `{ verified: false, issues: [...] }`. Es un patrón de invocación doble: el productor ejecuta, el verifier verifica en el mismo proceso (mock).

**Razón**: el verdadero "verifier en sub-sesión aislada" es D2b.2. En D2b.1 establecemos la interface y el patrón; en D2b.2 lo enchufamos a un LLM real en proceso separado. Esto evita saltar directo a la complejidad de sub-sesión sin validar primero que el patrón funciona.

**Trade-off explícito**: en D2b.1, el verifier NO elimina el sesgo confirmatorio (está en el mismo proceso, mismo contexto). Esto es un mock. La auditabilidad legal real viene en D2b.2.

### 3.11. Edge case: `assignedSpecialist` que no existe en el `SpecialistRegistry`

**Decisión**: falla **fast en `startTask`** (validación al cargar el workflow), con `ExecutorError` código `NODE_NOT_FOUND` (reusar el código existente, es la misma situación: el nodo referencia algo que no existe). El workflow no se crea.

**Razón**: falla fast en lugar de runtime. Si el workflow dice `assignedSpecialist: "foo_v1"` y el registry no tiene ese specialist, es un error de configuración, no algo que pueda resolverse en runtime. Fallar al cargar el workflow es lo correcto.

### 3.12. Edge case: validación de `outputSchema` con specialist

**Decisión**: el `node-runner` valida el output del specialist contra `node.outputSchema`, **igual que en D2a.4** (donde el node-runner valida el output del LLM directo contra el schema del state). El specialist retorna el output, el node-runner valida. El specialist no duplica la validación.

**Razón**: el outputSchema es metadata del nodo del workflow, no del specialist. El specialist no debería saber del outputSchema directamente; el motor lo valida contra el state.

**Backward-compat**: en D2a.4, el node-runner (`runLLMNode`) hace:
```typescript
if (node.outputSchema) {
  const valid = validateAgainstSchema(result.output, node.outputSchema);
  if (!valid.ok) return failure({...});
}
```
Misma lógica en D2b.1, pero aplicada al output del specialist.

### 3.13. Edge case: retry con specialist

**Decisión**: la retry policy del motor (D2a.2.2: `executeWithTimeoutAndRetry`) se aplica **antes** de delegar al specialist. El motor envuelve la llamada al specialist con su retry logic. El specialist NO maneja retry internamente.

**Razón**: la retry policy es del motor (Capa 1), no del specialist (Capa 3). El specialist es opaco para el motor. Si el invocador del specialist tira `RATE_LIMIT`, el motor retry. El specialist ve una sola invocación exitosa (o falla definitiva).

**Idempotency**: la idempotency key del nodo (D2a.2.2) se aplica al output del specialist, no a invocaciones internas. Si el motor retry, el specialist se ejecuta de nuevo (a menos que el cache de idempotency tenga un hit, en cuyo caso el motor retorna el output cacheado sin llamar al specialist).

### 3.14. Edge case: `circuitBreaker` con specialist

**Decisión**: el `circuitBreaker` del motor (D2a.2.3) sigue funcionando. El `specialistId` que se reporta al circuit breaker es el `agentId` del specialist (en D2b.1, el invocador detrás del specialist — "deepseek-flash" o "m3-thinking" — sigue siendo el `specialistId` para el breaker). Documentado en §3.4 del spec D2a.2.3.

**Cuestión abierta (D2b.2)**: el roadmap §6.1.4 menciona "Circuit breaker por agente/specialist". Hoy el breaker es por modelo, no por specialist. D2b.2 introduce la distinción cuando los Agent Cards formales lleguen. **D2b.1 NO implementa circuit breaker por specialist** — es backward-compat con D2a.4 (breaker por modelo).

### 3.15. Edge case: confidence gating con specialist

**Decisión**: el confidence gating se evalúa **dentro del specialist** (porque el specialist tiene el system prompt y el output completo). El node-runner recibe el `NodeExecutionOutcome` con `confidence` y `confidenceValue` ya seteados por el specialist. El motor los persiste en `NodeResult.confidence` y `NodeResult.confidenceValue` (igual que en D2a.4).

**Razón**: el specialist tiene el system prompt que define las reglas de confidence ("Sos un clasificador... tu nivel de confianza entre 0 y 1"). El motor no sabe esas reglas. El specialist evalúa, el motor persiste.

### 3.16. Carga de principios jurídicos en el prompt del specialist

**Decisión**: D2b.1 son **mocks con prompts genéricos** ("Sos un clasificador de documentos legales..."). Los principios jurídicos específicos (ley posterior deroga anterior, ley especial, derogación tácita vs expresa, jerarquía de normas, vigencia y ultraactividad) **NO se cargan en D2b.1**.

**Razón**: el roadmap §5.14 dice "Los principios se inyectan en el prompt del specialist jurídico, NO en el código del motor". En D2b.1 los specialists son mocks con prompts genéricos. La carga de principios reales viene en **D2b.2** (con skills v1 de D2c, que es donde el sistema de skills entra).

**Deuda documentada**: cuando D2b.2 implemente los specialists reales, debe cargar los principios jurídicos como parte del system prompt. Out of scope de D2b.1.

---

## 4. Estructura del código

### 4.1. Nuevos archivos

- `src/agent/specialists/tier-resolver.ts` — interface `TierResolver` + impl default + mocks.
- `src/agent/specialists/specialist-registry.ts` — `SpecialistRegistry` class.
- `src/agent/specialists/intake-specialist.ts` — `IntakeSpecialist` class.
- `src/agent/specialists/clause-reviewer-specialist.ts` — `ClauseReviewerSpecialist` class.
- `src/agent/specialists/verifier-specialist.ts` — `VerifierSpecialist` class.
- `src/agent/specialists/index.ts` — barrel export.
- `src/agent/specialists/mocks/mock-deepseek-flash.ts` — `LLMInvoker` mock para tier liviano.
- `src/agent/specialists/mocks/mock-m3-thinking.ts` — `LLMInvoker` mock para tier robusto.

### 4.2. Archivos modificados

- `src/agent/workflow-engine/dsl/types.ts` — agregar `pendingDecision` ya está; agregar `assignedSpecialist?: string` a `LLMNode`; agregar `metadata?` a `NodeResult`.
- `src/agent/workflow-engine/executor/types.ts` — agregar `TierResolver`, `Specialist`, `SpecialistRegistry` interfaces. Agregar `tierResolver?` y `specialistRegistry?` a `ExecutorConfig`.
- `src/agent/workflow-engine/executor/node-runner.ts` — antes de invocar al `llmInvoker`, consultar el `specialistRegistry`; si el nodo tiene `assignedSpecialist`, delegar al specialist. Si no, comportamiento actual.
- `src/agent/workflow-engine/executor/index.ts` — barrel: exportar nuevas interfaces.

### 4.3. Archivos no modificados

- `src/agent/workflow-engine/executor/executor.ts` — el `WorkflowExecutor` no se toca. El `node-runner` ya pasa por el invocador; el cambio es que el invocador puede venir de un specialist.
- `src/agent/workflow-engine/dsl/schema.ts` — el `LLMNode` schema acepta `assignedSpecialist` opcional.
- `tests/fixtures/revision-generica.workflow.json` — se actualiza para usar `assignedSpecialist` en los nodos LLM (migración del fixture).

---

## 5. Contratos clave

### 5.1. `TierResolver`

```typescript
export type ModelRef = "liviano" | "robusto" | string;

export interface ResolvedTier {
  readonly invoker: LLMInvoker;
  readonly tier: "liviano" | "robusto";
  readonly model: string;
}

export interface TierResolver {
  resolve(modelRef: ModelRef): ResolvedTier;
}

/** Default TierResolver: liviano → DeepSeek Flash mock, robusto → M3 Thinking mock. */
export class DefaultTierResolver implements TierResolver {
  constructor(
    private readonly livianoInvoker: LLMInvoker,
    private readonly robustoInvoker: LLMInvoker,
  ) {}
  resolve(modelRef: ModelRef): ResolvedTier {
    if (modelRef === "liviano") {
      return { invoker: this.livianoInvoker, tier: "liviano", model: "deepseek-flash" };
    }
    if (modelRef === "robusto") {
      return { invoker: this.robustoInvoker, tier: "robusto", model: "m3-thinking" };
    }
    // modelRef es un nombre específico de modelo (ej: "gpt-4o"): cae a robusto por default.
    return { invoker: this.robustoInvoker, tier: "robusto", model: modelRef };
  }
}
```

### 5.2. `Specialist`

```typescript
export interface Specialist {
  readonly agentId: string;
  readonly capabilities: string[];
  readonly preferredModel: ModelRef;

  execute(params: SpecialistExecuteParams): Promise<NodeExecutionOutcome>;
}

export interface SpecialistExecuteParams {
  readonly node: LLMNode;
  readonly task: Task;
  readonly state: WorkflowState;
  readonly signal?: AbortSignal;
}
```

### 5.3. `IntakeSpecialist`

```typescript
export class IntakeSpecialist implements Specialist {
  public readonly agentId = "intake_specialist_v1";
  public readonly capabilities = ["document_classification", "categorization"];
  public readonly preferredModel: ModelRef = "liviano";

  constructor(private readonly invoker: LLMInvoker) {}

  async execute(params: SpecialistExecuteParams): Promise<NodeExecutionOutcome> {
    // 1. Construir system prompt: "Sos un clasificador de documentos legales. ..."
    // 2. Construir user prompt: interpolate {{state.input.documentContent}}
    // 3. Llamar al invoker.
    // 4. Validar output contra outputSchema.
    // 5. Calcular confidence gating.
    // 6. Retornar con metadata.executedBy.
  }
}
```

(Análogamente para `ClauseReviewerSpecialist` y `VerifierSpecialist`.)

### 5.4. Cambios en `LLMNode`

```typescript
export interface LLMNode extends BaseNode {
  // ... campos existentes ...
  readonly assignedSpecialist?: string; // NUEVO en D2b.1
}
```

### 5.5. Cambios en `NodeResult`

```typescript
export interface NodeResult {
  // ... campos existentes ...
  readonly metadata?: { // NUEVO en D2b.1
    readonly executedBy?: {
      readonly agentId: string;
      readonly agentVersion: string;
      readonly tier: "liviano" | "robusto" | string;
      readonly model: string;
    };
  };
}
```

---

## 6. Tests planeados (~12-15)

1. **`tier-resolver: liviano → DeepSeek Flash mock`**.
2. **`tier-resolver: robusto → M3 Thinking mock`**.
3. **`tier-resolver: modelRef desconocido → robusto (default seguro)`**.
4. **`specialist: IntakeSpecialist clasifica un documento`**.
5. **`specialist: ClauseReviewerSpecialist analiza cláusulas`**.
6. **`specialist: VerifierSpecialist verifica output del productor`**.
7. **`workflow: nodo con assignedSpecialist se delega al specialist correcto`**.
8. **`workflow: nodo SIN assignedSpecialist usa el llmInvoker default (backward-compat)`**.
9. **`workflow: workflow revision-generica con assignedSpecialist en cada nodo LLM corre end-to-end`**.
10. **`audit: NodeResult.metadata.executedBy tiene agentId, agentVersion, tier, model`**.
11. **`audit: cost attribution básico (costUsd del invocador se preserva)`**.
12. **`workflow: confidence gating sigue funcionando con specialist`**.
13. **`workflow: prompt snapshot sigue funcionando con specialist`**.
14. **`workflow: circuit breaker sigue funcionando con specialist`**.
15. **`error: si un specialist tira, el nodo se marca como failed con el error del specialist`**.

---

## 7. Resumen de cambios al código

| Archivo | Cambio | LoC estimadas |
|---|---|---|
| `src/agent/specialists/tier-resolver.ts` (nuevo) | Interface + impl default | ~80 |
| `src/agent/specialists/specialist-registry.ts` (nuevo) | Registry class | ~50 |
| `src/agent/specialists/intake-specialist.ts` (nuevo) | Specialist | ~120 |
| `src/agent/specialists/clause-reviewer-specialist.ts` (nuevo) | Specialist | ~150 |
| `src/agent/specialists/verifier-specialist.ts` (nuevo) | Specialist (mock, sin sub-sesión) | ~150 |
| `src/agent/specialists/index.ts` (nuevo) | Barrel | ~10 |
| `src/agent/specialists/mocks/mock-deepseek-flash.ts` (nuevo) | Mock invoker tier liviano | ~50 |
| `src/agent/specialists/mocks/mock-m3-thinking.ts` (nuevo) | Mock invoker tier robusto | ~50 |
| `src/agent/workflow-engine/dsl/types.ts` | +`assignedSpecialist` a LLMNode, +`metadata` a NodeResult | ~15 |
| `src/agent/workflow-engine/executor/types.ts` | +TierResolver, Specialist, SpecialistRegistry, ExecutorConfig fields | ~50 |
| `src/agent/workflow-engine/executor/node-runner.ts` | Routing al specialist si está | ~30 |
| `src/agent/workflow-engine/executor/index.ts` | Barrel | ~10 |
| `tests/fixtures/revision-generica.workflow.json` | +`assignedSpecialist` en cada nodo LLM | ~10 |
| `test_workflow_d2b_1.mts` (nuevo) | 15 tests | ~450 |
| **Total** | | **~1,225** |

---

## 8. Decisiones tomadas en este turno (registradas para audit)

1. **D2b en 2 sprints** (D2b.1 + D2b.2). **NO** en 1 sprint grande ni en 3 micro-sprints. Razón: balance entre control y velocidad.
2. **3 specialists del roadmap** (intake + clause_reviewer + verifier). **NO** 1 (MVP) ni 2.
3. **Integración real con OpenRouter en D2b.2**, no en D2b.1. D2b.1 usa mocks.
4. **Agent Cards formales en D2b.2**, no en D2b.1. D2b.1 implementa `agentId` + `capabilities` simples.
5. **Verificer en sub-sesión en D2b.2**, no en D2b.1. D2b.1 implementa un mock de "verifier en mismo proceso".
6. **Specialists en directorio separado** `src/agent/specialists/`. **NO** en `src/agent/workflow-engine/` (que es Capa 1).
7. **El specialist es un wrapper alrededor de un `LLMInvoker`**, no un `LLMInvoker` directo. **NO** es una nueva interface que el motor entiende — el motor sigue usando `LLMInvoker` y el `node-runner` enruta.
8. **`assignedSpecialist` es opcional** en `LLMNode`. **NO** obligatorio. Backward-compat con D2a.5.
9. **`metadata.executedBy` se agrega a `NodeResult`** (no un campo nuevo `executedBy` al lado). **NO** un sistema de metadata rico (eso es D2b.2 con Agent Cards).
10. **`TierResolver` es opcional** en `ExecutorConfig`. **NO** obligatorio. Backward-compat con D2a.5.
11. **El `verifier_specialist` en D2b.1 es un mock** (mismo proceso). **NO** sub-sesión. Documentado como limitación.
12. **Falla fast en `startTask` si `assignedSpecialist` no existe en el registry** (validación al cargar, `NODE_NOT_FOUND`). No en runtime.
13. **El node-runner valida `outputSchema`**, no el specialist (mismo patrón que D2a.4). El specialist no duplica.
14. **Retry del motor envuelve al specialist**. El specialist NO retry internamente. El cache de idempotency cachea outputs del specialist.
15. **Circuit breaker sigue siendo por modelo** (D2a.4). Circuit breaker por specialist queda para D2b.2 con Agent Cards.
16. **Confidence gating se evalúa dentro del specialist** (porque el specialist tiene el system prompt). El motor persiste.
17. **D2b.1 son mocks con prompts genéricos**. Principios jurídicos (roadmap §5.14) entran en D2b.2 con skills v1 de D2c.
18. **El fixture `revision-generica.workflow.json` se actualiza UNA sola vez** con `assignedSpecialist` en cada nodo LLM. No hay dos versiones (con/sin specialist). Backward-compat implícita para workflows sin el campo.

**Reversibilidad**: si alguna decisión no te cuadra, decime y la cambiamos antes de codear.

---

## 9. Próximo sprint (D2b.2, después de D2b.1)

D2b.2 introduce:
- **Integración real con OpenRouter** (usar `OPENROUTER_API_KEY` del `.env`).
- **Agent Cards formales (JSON tipo A2A)** con metadata OpenAPI-style: `version`, `skills`, `endpoints`, `pricing`, `limits`.
- **Lifecycle formal** `spawn → idle → busy → paused → done → archived` con eventos.
- **Cost attribution con pricing real** por modelo (tokens × $/M).
- **Verifier en sub-sesión aislada** (sin sesgo confirmatorio).
- **Citation Grounding v2** (roadmap §5.13) como mejora del verifier.
- **MCP server para tools** (roadmap §5.8) — empezar consumiendo de terceros.

D2b.2 es el sprint que hace que Worgena haga trabajo real de legal colombiano con un specialist, no solo con un LLM.
