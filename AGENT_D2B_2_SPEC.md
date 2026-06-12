# D2b.2 — Specialists Reales: OpenRouter + Agent Cards + Lifecycle + Verifier Sub-sesión

> **Spec para D2b.2.** Segundo sprint de D2b (multi-modelo + specialists, roadmap §6.2). Enchufa la integración real con OpenRouter, formaliza los Agent Cards (A2A v1.0), introduce el lifecycle de specialists, y mueve el verifier a una "sub-sesión" lógica con prompt limpio. NO usa worker pool ni child_process — la sub-sesión es una llamada LLM con system prompt independiente del productor.
>
> **Origen de la decisión**: en D2b.1 el motor tiene 3 specialists con mocks (`MockDeepSeekFlashInvoker`, `MockM3ThinkingInvoker`). Los prompts son genéricos, no se cargan principios jurídicos, el `agentVersion` es `1.0.0-d2b.1` (placeholder), y la auditabilidad es parcial. D2b.2 enchufa la integración real con OpenRouter (la key ya existe en `.env`), formaliza la metadata de los agents (Agent Card estilo A2A v1.0), introduce el lifecycle (spawn→idle→busy→paused→done→archived con eventos), y refactoriza el `VerifierSpecialist` para usar un prompt limpio sin acceso al contexto del productor (sub-sesión lógica, no child process).
>
> **Decisiones clave de este turno** (confirmadas con el usuario):
> 1. **Sub-sesión del verifier = prompt limpio, mismo LLM** (Opción A). No child_process, no Mavis.
> 2. **3 modelos en el catálogo**: liviano (`deepseek/deepseek-chat`), robusto (`anthropic/claude-3.5-sonnet`), embedding (`qwen/qwen3-embedding-8b`). Configurables.
> 3. **Agent Card = objeto TypeScript en código** con `toJSON()` A2A v1.0. Forward-compat con A2A server de D3+.

## 0. Status

- **Versión actual**: 1.0 (decisiones tomadas en este turno, 2026-06-12).
- **Alcance**: OpenRouter real + Agent Cards + lifecycle + verifier sub-sesión + Citation Grounding v2.
- **Cubre**:
  - **`OpenRouterClient` real**: `POST https://openrouter.ai/api/v1/chat/completions` con auth bearer, `response_format: { type: "json_schema" }` para output estructurado, mapeo de errores (401/402/408/429/500/502/503), `signal` para cancelación.
  - **`OpenRouterEmbeddingClient` real**: `POST /api/v1/embeddings` con `qwen/qwen3-embedding-8b` (paralelo al chat client). Tier 2 del roadmap §5.5.
  - **`OpenRouterLLMInvoker`**: `LLMInvoker` que envuelve el chat client. Retorna `LLMInvokeResult` con `costUsd` real de `usage.cost` (no estimado por pricing local — OpenRouter devuelve el costo exacto en la response).
  - **`PricingCatalog`**: tabla de precios por modelo (`promptUsdPerM`, `completionUsdPerM`). Configurable. Usado como **fallback** si el response no trae `usage.cost` (algunos modelos no lo devuelven).
  - **`AgentCard` (A2A v1.0)**: `name`, `version` (semver), `description`, `capabilities` (streaming, pushNotifications, extendedAgentCard), `skills[]` (id, name, description, tags, examples), `securitySchemes` (apiKey Bearer), `provider`, `defaultInputModes`/`defaultOutputModes`, `pricing` (extensión Worgena: promptUsdPerM, completionUsdPerM, limits), `limits` (extensión Worgena: maxTokens, maxRequestsPerMinute, maxConcurrent).
  - **Lifecycle formal**: `spawn → idle → busy → paused → done → archived`. Cada specialist tiene un `Lifecycle` instance que trackea estado, emite eventos (`onStateChange`), y persiste timestamps. `paused` se usa cuando un HITL pausa el workflow.
  - **`VerifierSpecialist` con sub-sesión lógica**: el system prompt del verifier es **completamente independiente** del system prompt del productor. El verifier recibe solo el output a verificar + el contexto resuelto del state, sin acceso al system prompt del nodo productor. La llamada LLM es lógicamente una "sesión nueva" (mismo LLM, mismo proceso, pero contexto aislado por construcción). El output incluye `verifierSessionId` y `verifiedAt` para audit.
  - **`Citation Grounding v2`** (roadmap §5.13): extensión del VerifierSpecialist. Distingue citas a **texto** (`[Doc X, rango 1234-5678]`) vs **metadato** (`[Doc X, derogado_por: 'Ley 2297']`). El verifier recibe el output del productor + las fuentes referenciadas, y valida cada cita. En D2b.2 la validación es por substring matching + heurística (no hay un `read_section` real todavía — eso es D3+ con RAG).
- **NO cubre** (deuda a sprints futuros):
  - **A2A server** (D3+): publicar los Agent Cards en `/.well-known/agent.json` y aceptar requests JSON-RPC. Hoy los cards son metadata in-memory.
  - **`read_section` real para Citation Grounding v2** (D3+ con RAG): hoy la validación es heurística.
  - **Principios jurídicos colombianos en los prompts** (D2c skills v1): roadmap §5.14. Hoy los prompts siguen siendo genéricos.
  - **MCP** (roadmap §5.8): out of scope.
  - **Multi-tenant + Agent Card por tenant** (D3): hoy el card es uno por specialist, no por firma.
  - **Streaming de OpenRouter** (roadmap §5.11): no soportado en D2b.2 (todos los nodos LLM son sync). El `OpenRouterClient` no implementa `chat({stream: true})`. El `OpenRouterLLMInvoker` retorna el response completo.
  - **SaC (code-as-interface)** (roadmap §5.15): no en D2b.2 (es del cliente, no del motor).
  - **Embeddings via `OpenRouterLLMInvoker`**: el `OpenRouterClient.embeddings()` existe para uso directo (D4-D5 con RAG), pero el `OpenRouterLLMInvoker` no lo usa. El tier 2 (embeddings) del roadmap §5.5 sigue usando el patrón actual de `src/agent/memory.ts` (fetch directo a `/api/v1/embeddings`) hasta D4+.
- **Implementación esperada**: ~2500-3500 LoC. Tests: ~50-70 nuevos. **Smoke test E2E con OpenRouter real** (1 llamada con la key del `.env`).
- **Owner del cambio**: este spec vive en el repo. Modificaciones requieren acuerdo explícito antes de mergear.

---

## 1. Por qué este spec existe

D2b.1 cerró el router multi-modelo y los 3 specialists con mocks. La integración real con OpenRouter es el siguiente paso obvio (la key ya está en `.env`, el `src/agent/memory.ts` ya usa OpenRouter para embeddings, y la arquitectura de 3 capas del roadmap §5.3 lo asume). Sin OpenRouter real, Worgena no hace trabajo útil en producción — solo demos con mocks.

Además, el roadmap §5.9 (Identidad del agente, lifecycle y costo atribuible) requiere Agent Cards formales y lifecycle. Sin cards, el motor no sabe "qué hace este specialist" en formato declarativo (los capabilities son strings sueltos hoy). Sin lifecycle, no hay forma de pausar/reanudar un specialist cuando el HITL pausa el workflow.

Finalmente, el verifier con prompt limpio (sub-sesión lógica) es la diferencia entre un "verifier" que valida lo que el productor dijo (sesgo confirmatorio) y un verifier independiente. Roadmap §5.6 lo dice claro: "el verificador es un subagente en sesión nueva, sin acceso al contexto del productor". En D2b.2 implementamos "sin acceso al contexto del productor" como **prompt limpio** (Opción A confirmada con el usuario), no como child process. La auditabilidad mejora (registramos los 2 system prompts), la complejidad operacional se mantiene en cero, y el sesgo confirmatorio se elimina por construcción.

---

## 2. Goals & Non-goals

### 2.1. Goals (lo que D2b.2 DEBE cumplir)

1. **`OpenRouterClient` real**: `fetch` a `https://openrouter.ai/api/v1/chat/completions` con `Authorization: Bearer ${OPENROUTER_API_KEY}`. Soporta `response_format: { type: "json_schema", json_schema: {...} }` para output estructurado. Mapea errores del catálogo OpenRouter al catálogo del motor (`RATE_LIMIT`, `TIMEOUT`, `NETWORK_ERROR`, `MODEL_UNAVAILABLE`, `INVALID_OUTPUT`, `INTERNAL_ERROR`).
2. **`OpenRouterEmbeddingClient` real**: `fetch` a `/api/v1/embeddings` con `qwen/qwen3-embedding-8b`. Tier 2 del router (roadmap §5.5).
3. **`OpenRouterLLMInvoker`**: `LLMInvoker` que envuelve el chat client. Pasa `systemPrompt` y `userPrompt` a `messages: [{role:"system",...}, {role:"user",...}]`. Pasa `outputSchema` a `response_format: { type: "json_schema", json_schema: {...} }` (si está declarado). Pasa `tools` a `tools: [...]` (si están declarados). Retorna `LLMInvokeResult` con `tokensUsed` de `usage.{prompt_tokens, completion_tokens}`, `modelUsed` de `response.model`, y `costUsd` de `usage.cost` (si está presente) o calculado vía `PricingCatalog` (si no).
4. **`PricingCatalog`**: tabla `modelId → { promptUsdPerM, completionUsdPerM }`. Carga defaults de OpenRouter (DeepSeek Flash, Claude 3.5 Sonnet, Qwen3 Embedding 8B). Configurable: el caller puede extender/sobrescribir. Si OpenRouter devuelve `usage.cost`, ese valor tiene precedencia (es el real facturado); el catálogo es fallback.
5. **`AgentCard` A2A v1.0**: cumple el schema de la spec de Google. Cada specialist expone su `agentCard: AgentCard`. El `toJSON()` del card produce JSON A2A v1.0 válido. En D3+ el A2A server sirve este JSON en `/.well-known/agent.json`.
6. **Lifecycle formal**: cada `Specialist` tiene un `lifecycle: Lifecycle` con state machine `spawn → idle → busy → paused → done → archived`. Eventos `onStateChange(state, prev)`. `paused` se usa cuando un HITL pausa el workflow (futuro, hoy no hay HITL dentro de un specialist).
7. **3 specialists con prompts especializados reales**: los 3 del roadmap §6.2 (`intake_specialist_v1`, `clause_reviewer_specialist_v1`, `verifier_specialist_v1`), con `agentVersion: "1.0.0"` (semver limpio, no `1.0.0-d2b.1`).
8. **`VerifierSpecialist` con sub-sesión lógica**: system prompt del verifier **NO comparte texto** con el system prompt del productor. El verifier recibe solo el output a verificar + el contexto (resuelto del state). La llamada LLM es independiente. El output del verifier incluye `verifierSessionId` (un UUID generado al inicio del `execute()`) y `verifiedAt` (timestamp ISO) para que el audit log pueda vincular "este verifier verificó ese output a esa hora".
9. **Citation Grounding v2 (validación heurística)**: el `VerifierSpecialist` valida citas a texto y metadatos. Recibe el output + el contexto. Para cada cita, detecta el tipo (texto vs metadato) por la sintaxis. Hoy la validación es por substring (texto) o por check de existencia del metadato (metadata) — no es el `read_section` real, pero la API del verifier queda lista para enchufar RAG en D3+. Si una cita falla, el verifier marca `verified: false` y lista los issues.
10. **Backward-compat con D2b.1**: los tests D2b.1 (16 tests) deben seguir pasando. Los specialists pueden recibir `OpenRouterLLMInvoker` o mocks. El `SpecialistRegistry` se construye igual. El `node-runner` no cambia.
11. **Sin cambios al motor Capa 1**: el `WorkflowExecutor`, el `runLoop`, `node-runner.ts`, `circuit-breaker.ts`, `state.ts`, etc. no se tocan. D2b.2 es 100% en `src/agent/specialists/` (Capa 3) + `src/agent/llm/` (cliente HTTP).
12. **Smoke test E2E con OpenRouter real**: 1 llamada al API con la key del `.env` para validar end-to-end (1 modelo, 1 prompt simple, validar que la response llega con `usage.cost`).

### 2.2. Non-goals (D2b.2 — diferidos)

- **A2A server (D3+)**: hoy los Agent Cards son metadata in-memory. Servirlos en `/.well-known/agent.json` con JSON-RPC es D3.
- **Streaming de OpenRouter (D3+ o demanda)**: el cliente soporta streaming en teoría (`stream: true` en el body), pero el `LLMInvoker` retorna el response completo. El motor es sync.
- **`read_section` real para Citation Grounding v2 (D3+ con RAG)**: hoy heurística, no acceso a documentos.
- **Principios jurídicos colombianos (D2c skills v1)**: roadmap §5.14. Los prompts siguen siendo genéricos.
- **MCP** (roadmap §5.8): out of scope.
- **Multi-tenant + Agent Card por tenant** (D3).
- **Lifecycle events persistidos en DB** (D3): hoy el lifecycle emite eventos in-memory; el audit log es del motor.
- **Cost attribution con pricing configurable por tenant** (D3): hoy el catálogo es global, todos los tenants comparten precios.
- **SaC / sandbox** (roadmap §5.15): no en D2b.2.

---

## 3. Decisiones de diseño

### 3.1. ¿Por qué `fetch` directo en vez de `openai` SDK con `baseURL` de OpenRouter?

**Decisión**: el `OpenRouterClient` usa `fetch` de Node built-in. NO usa el SDK `openai` (que ya está en el proyecto para otra cosa).

**Razón**:
- El SDK `openai` está acoplado a la API de OpenAI (nombres de campos, tipos, paginación). OpenRouter expone la misma API de chat pero con campos adicionales (`usage.cost`, `openrouter_metadata`). El SDK no los tipifica.
- El código existente en `src/agent/memory.ts` ya usa `fetch` directo a `/api/v1/embeddings`. Mantener el patrón es consistencia.
- `fetch` es built-in en Node 18+. No agrega dependencia.

**Trade-off**: tenemos que mapear los response shapes a mano. Es ~50 LoC, pero queda claro qué campos usamos y cuáles ignoramos.

### 3.2. ¿Cómo se mapean los errores de OpenRouter al catálogo del motor?

**Decisión**:

| OpenRouter HTTP | ErrorCode del motor | retriable |
|---|---|---|
| 400 (Bad Request) | `INVALID_OUTPUT` (si el response_format es inválido) o `INTERNAL_ERROR` (si el request está mal armado) | false |
| 401 (Unauthorized) | `INTERNAL_ERROR` (la key es nuestra responsabilidad, no del workflow) | false |
| 402 (Payment Required) | `MODEL_UNAVAILABLE` (no hay crédito) | false (no tiene sentido retry sin充值) |
| 408 (Request Timeout) | `TIMEOUT` | true |
| 422 (Unprocessable Entity) | `INVALID_OUTPUT` (semantic validation failure del modelo) | false |
| 429 (Too Many Requests) | `RATE_LIMIT` | true |
| 500/502/503 (server errors) | `MODEL_UNAVAILABLE` (server errors son transitorios y del lado del modelo/proveedor upstream) | true |
| Network error (fetch throws) | `NETWORK_ERROR` | true |
| AbortError | `INTERNAL_ERROR` (cancellation, no fault del workflow) | false |

**Razón**: el `errorClassifier` del `node-runner.ts` (D2a.2.2) ya tiene `classifyLLMError` que mapea por substring ("rate limit", "timeout", etc.). El `OpenRouterClient` retorna `Error` con mensajes específicos (ej: `OpenRouter 429: rate limit exceeded`) y el classifier existente funciona. En D2b.2 el `OpenRouterClient` retorna un `OpenRouterError extends Error` con `httpStatus` y `code` (mapeado al catálogo del motor) — el `node-runner` puede usar `error.code` directamente en lugar del substring.

### 3.3. ¿Cómo se calcula el `costUsd`?

**Decisión**:
1. Si OpenRouter devuelve `usage.cost` (campo de la response), usar ese valor. Es el costo real facturado.
2. Si no, calcular vía `PricingCatalog`: `costUsd = (prompt_tokens / 1_000_000) * promptUsdPerM + (completion_tokens / 1_000_000) * completionUsdPerM`.

**Razón**: el `usage.cost` de OpenRouter es la fuente de verdad. El `PricingCatalog` es fallback para modelos que no lo devuelven. El catálogo se mantiene como **estimación de auditoría** — si el catálogo dice $0.001 y OpenRouter cobra $0.0012, el log tiene ambos y el equipo de audit detecta drift.

**Default del catálogo** (precios públicos de OpenRouter, redondeados):

| modelId | promptUsdPerM | completionUsdPerM |
|---|---|---|
| `deepseek/deepseek-chat` | 0.14 | 0.28 |
| `anthropic/claude-3.5-sonnet` | 3.00 | 15.00 |
| `qwen/qwen3-embedding-8b` | 0.05 | 0.00 |

Estos son los precios a la fecha del spec. El caller puede extender/sobrescribir vía `PricingCatalog.extend({...})`.

### 3.4. ¿Cómo se distingue un `response_format: { type: "json_schema" }` válido vs un output que no cumple el schema?

**Decisión**: OpenRouter (vía el proveedor upstream) intenta cumplir el schema. Si el output no cumple, hay 2 casos:
1. El proveedor devuelve un JSON inválido o un JSON que no cumple el schema. OpenRouter retorna 200 con `choices[0].message.content` siendo el JSON problemático. El `OpenRouterClient` lo retorna como `output` y el motor valida contra `node.outputSchema` (D2a.4 behavior).
2. El proveedor retorna un error de schema explícito (ej: 422). Se mapea a `INVALID_OUTPUT`.

**Razón**: el motor ya tiene el patrón "invocador retorna output, motor valida contra schema" (D2a.4). No duplicamos validación en el cliente. El cliente solo garantiza que la request se hizo bien.

### 3.5. ¿Cómo se construye un `AgentCard`?

**Decisión**: cada specialist tiene un `agentCard: AgentCard` construido en código (objeto TypeScript). El `toJSON()` del card produce JSON A2A v1.0 válido (validable contra el schema oficial). Los cards NO se persisten en disco en D2b.2 (eso es D3+).

**Estructura** (basada en A2A v1.0 spec, sección 4.4.1):

```typescript
interface AgentCard {
  // Identidad.
  readonly name: string;          // "Intake Specialist"
  readonly description: string;   // "Clasifica documentos legales..."
  readonly version: string;       // "1.0.0" (semver)
  readonly provider: {
    readonly organization: string;
    readonly url?: string;
  };
  // Service endpoint (D3+ — hoy placeholder).
  readonly url: string;            // "https://worgena.example.com/agents/intake_specialist_v1"
  // Capabilities A2A.
  readonly capabilities: {
    readonly streaming: boolean;   // false (D2b.2 no streamea)
    readonly pushNotifications: boolean; // false (D2b.2 no usa webhooks)
    readonly extendedAgentCard: boolean; // false
  };
  // Skills A2A (id, name, description, tags, examples).
  readonly skills: readonly AgentSkill[];
  // Security A2A.
  readonly securitySchemes: {
    readonly apiKey: { readonly type: "http"; readonly scheme: "bearer" };
  };
  readonly security: readonly { readonly apiKey: string[] }[];
  // Modalities.
  readonly defaultInputModes: readonly string[];  // ["text"]
  readonly defaultOutputModes: readonly string[]; // ["json"]
  // Extensions Worgena (no son estándar A2A pero son forward-compat).
  readonly pricing?: AgentPricing;
  readonly limits?: AgentLimits;
}

interface AgentSkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly examples?: readonly string[];
}

interface AgentPricing {
  readonly promptUsdPerM: number;
  readonly completionUsdPerM: number;
  readonly currency: "USD";
}

interface AgentLimits {
  readonly maxTokens: number;
  readonly maxRequestsPerMinute: number;
  readonly maxConcurrent: number;
}
```

**Razón**: el card es la metadata que el orquestador, otros agents, o el A2A server de D3+ necesitan para "entender" el specialist. Sin card, el specialist es un "string con un `execute()`".

### 3.6. ¿Cómo se implementa el lifecycle?

**Decisión**: clase `Lifecycle` con state machine simple. NO usa `xstate` ni libs externas — la lógica es trivial (6 estados, transiciones explícitas).

```typescript
type LifecycleState = "spawn" | "idle" | "busy" | "paused" | "done" | "archived";

class Lifecycle {
  private _state: LifecycleState = "spawn";
  private readonly _events: LifecycleEvent[] = [];
  readonly createdAt: string;
  private _stateChangedAt: string;

  get state(): LifecycleState { return this._state; }
  get events(): readonly LifecycleEvent[] { return this._events; }
  get stateChangedAt(): string { return this._stateChangedAt; }

  transition(next: LifecycleState, reason?: string): void {
    const valid = this.isValidTransition(this._state, next);
    if (!valid) throw new Error(`Invalid transition: ${this._state} → ${next}`);
    const prev = this._state;
    this._state = next;
    this._stateChangedAt = new Date().toISOString();
    const event: LifecycleEvent = { from: prev, to: next, at: this._stateChangedAt, reason };
    this._events.push(event);
    this.onStateChange?.(next, prev, reason);
  }

  private isValidTransition(from: LifecycleState, to: LifecycleState): boolean {
    // Reglas:
    // spawn → idle (registrado)
    // idle → busy (ejecutando)
    // busy → done (completó) o paused (HITL) o archived (error fatal)
    // paused → busy (resume) o archived
    // done → archived (cleanup)
    // archived → (terminal, no más transiciones)
    const transitions: Record<LifecycleState, readonly LifecycleState[]> = {
      spawn: ["idle"],
      idle: ["busy", "archived"],
      busy: ["done", "paused", "archived"],
      paused: ["busy", "archived"],
      done: ["archived"],
      archived: [],
    };
    return transitions[from].includes(to);
  }

  onStateChange?: (newState: LifecycleState, prev: LifecycleState, reason?: string) => void;
}
```

**Uso por specialist**:

```typescript
async execute(params: SpecialistExecuteParams): Promise<NodeExecutionOutcome> {
  this.lifecycle.transition("busy", `node ${params.node.id} starting`);
  try {
    const result = await this.invoker.invoke({...});
    this.lifecycle.transition("done", `node ${params.node.id} completed`);
    return result;
  } catch (e) {
    this.lifecycle.transition("archived", `error: ${e.message}`);
    throw e;
  }
}
```

**Razón**: el lifecycle es metadata pura del specialist. El motor no consulta el lifecycle en runtime (no necesita saber "este specialist está busy"). Es para audit y observabilidad.

**Backward-compat**: el lifecycle es aditivo. No cambia el contrato `Specialist.execute()`. Tests existentes no se rompen.

### 3.7. ¿Cómo se implementa la "sub-sesión" del verifier?

**Decisión**: el `VerifierSpecialist` arma su propio system prompt **sin leer el system prompt del nodo productor**. La llamada LLM es lógicamente una "sesión nueva" (mismo LLM, mismo proceso, pero contexto aislado por construcción).

**Patrón**:

```typescript
class VerifierSpecialist implements Specialist {
  // ...
  async execute(params: SpecialistExecuteParams): Promise<NodeExecutionOutcome> {
    const verifierSessionId = randomUUID();
    const verifiedAt = new Date().toISOString();

    // Sub-sesión: system prompt LIMPIO, sin acceso al system prompt del productor.
    const systemPrompt = this.buildVerifierSystemPrompt();
    const userPrompt = this.buildVerifierUserPrompt(
      params.state,         // state completo (el contexto)
      params.node.input,    // input del nodo a verificar
    );

    // El invoker es independiente del nodo productor.
    // El verifier NO recibe el system prompt del productor en ningún lado.
    const result = await this.invoker.invoke({...});

    // Output del verifier incluye metadata para audit.
    return {
      status: "completed",
      output: { ...result.output, verifierSessionId, verifiedAt },
      // ...
    };
  }

  private buildVerifierSystemPrompt(): string {
    return (
      "Sos un verificador independiente. Recibís el output de un productor y " +
      "el contexto en que se produjo. Tu trabajo es decidir si el output es " +
      "consistente con el contexto. NO tenés acceso al razonamiento del productor. " +
      // Citation Grounding v2: detectar citas a texto vs metadatos.
      "Si el output contiene citas (formato [Doc X, ...]), validá cada una. " +
      "Citas a texto (ej: [Doc X, 'rango 1234-5678']) deben corresponderse con " +
      "el contenido del contexto. Citas a metadatos (ej: [Doc X, derogado_por: 'Ley Y']) " +
      "deben ser coherentes con la metadata del documento."
    );
  }
}
```

**Lo que el verifier NO hace**:
- No lee `params.node.systemPrompt` (el del nodo productor).
- No lee `params.node.userPrompt` (el del nodo productor).
- No lee otros `NodeResult`s de la task (memoria de los productores previos).
- No comparte el `state` filtrado — recibe el state completo (sin filtrar es lo más seguro; el system prompt le dice que use solo lo que necesita).

**Lo que el verifier SÍ hace**:
- Recibe `params.state` (el state completo al momento de verificar).
- Recibe `params.node.input` (el input que se le dio al productor — el verifier puede ver QUÉ input recibió).
- Hace una llamada LLM con su propio system prompt.
- Retorna `{ verified, confidence, notes, issues, citations, verifierSessionId, verifiedAt }`.

**Por qué elimina el sesgo confirmatorio**:
- El verifier no ve cómo razonó el productor (no ve su system prompt ni su user prompt original).
- El verifier solo ve el output a verificar + el contexto. Su system prompt le pide que sea escéptico.
- Si el productor inventó un dato, el verifier (con acceso al contexto) lo detecta porque su prompt es "validá contra el contexto".

**Trade-off explícito**: el verifier y el productor comparten el mismo proceso Node. En teoría, podrían compartir variables en memoria si uno quisiera. Pero por construcción (prompts distintos, contexto distinto), el LLM no tiene forma de "ver" el razonamiento del productor. La garantía es lógica, no de proceso. Si en D3+ se necesita garantía de proceso, se mueve a child_process. Por ahora (D2b.2) la garantía lógica es suficiente y es lo que el roadmap §5.6 pide.

### 3.8. ¿Cómo se valida Citation Grounding v2?

**Decisión**: el verifier valida citas a texto y metadatos por heurística. NO usa `read_section` (eso es D3+ con RAG).

**Detección de tipo de cita**:
- **Texto**: patrón `[Doc <id>, '<texto citado>' o "rango <inicio>-<fin>"]`. El verifier busca esa sintaxis en el output.
- **Metadato**: patrón `[Doc <id>, <campo>: <valor>]` donde campo es uno de `derogado_por`, `modificado_por`, `vigente`, `tipo`, `numero`, `fecha`. Lista cerrada de campos reconocidos.

**Validación**:
- **Texto**: substring search del texto citado en el contexto. Si el texto no aparece en el contexto, la cita falla.
- **Metadato**: el verifier busca el campo en el state (el "documento" del contexto). Si el campo no está o no coincide, la cita falla.

**Output**:
```typescript
interface VerifierOutput {
  verified: boolean;
  confidence: number; // 0-1
  notes: string;
  issues: string[];   // ej: ["cita 1: texto no encontrado en el contexto"]
  citations: Array<{
    type: "text" | "metadata";
    target: string;     // ej: "Doc 1" o "Doc 1.derogado_por"
    valid: boolean;
    reason?: string;
  }>;
}
```

**Razón**: la heurística es suficiente para validar que el LLM está "inventando" citas. El LLM que inventa una cita no la pone en el formato correcto o el texto citado no aparece en el contexto. En D3+ con RAG, el `read_section` real reemplaza la heurística.

**Backward-compat**: el output del verifier en D2b.1 era `{ verified, confidence, notes }`. D2b.2 agrega `issues`, `citations`, `verifierSessionId`, `verifiedAt`. Los tests D2b.1 que validan `verified`, `confidence`, `notes` siguen pasando.

### 3.9. ¿Cómo se carga la key de OpenRouter?

**Decisión**: el `OpenRouterClient` lee `process.env.OPENROUTER_API_KEY` al construirse. Si la key no está, tira `MissingOpenRouterKeyError` con mensaje claro ("Set OPENROUTER_API_KEY in .env or pass it to the constructor").

**Razón**: consistencia con `src/agent/memory.ts` (que lee la key del env). La key NO se loguea nunca (ni en debug, ni en error). Si el call falla por 401, el log dice "OpenRouter 401 Unauthorized" sin la key.

**Backward-compat**: `OPENROUTER_API_KEY` ya existe en `.env` (verificado al inicio del sprint). No requiere acción del operador.

**Importante (regla de oro)**: la key se pasa LITERAL al header `Authorization`. No se le agrega prefijo, no se transforma, no se normaliza. (Regla del proyecto — ver `MEMORY.md` 2026-06-09.)

### 3.10. ¿Qué pasa si el usuario tiene `LLMInvoker` mockeado en lugar de `OpenRouterLLMInvoker`?

**Decisión**: backward-compat total. El `OpenRouterLLMInvoker` es un `LLMInvoker` (cumple la interface). Los tests D2b.1 que usan `MockDeepSeekFlashInvoker` y `MockM3ThinkingInvoker` siguen pasando. El caller decide qué `LLMInvoker` inyectar al `TierResolver`.

**Razón**: el contrato `LLMInvoker` (D2a.4) es la abstracción. Los mocks de D2b.1 son `LLMInvoker` válidos. D2b.2 introduce el `OpenRouterLLMInvoker` como una implementación más.

### 3.11. ¿Cómo se prueba sin hacer un call real a OpenRouter en cada test?

**Decisión**: el `OpenRouterClient` tiene un `transport: (url, init) => Promise<Response>` inyectable. En tests, el transport es un mock que retorna el response que queremos. En producción, el transport es `globalThis.fetch`.

**Razón**: mismo patrón que el `OpenAI` SDK (transport inyectable para tests). Mantiene los tests deterministas y no depende de la red ni de la key.

**Backward-compat**: si el caller no provee transport, usa `globalThis.fetch`. Producción: `fetch` real. Tests: mock.

### 3.12. Edge case: `OPENROUTER_API_KEY` no está en env

**Decisión**: el `OpenRouterClient` tira `MissingOpenRouterKeyError` con mensaje claro al construirse. El error NO se tira en cada call (sería overhead). Solo al construir.

### 3.13. Edge case: timeout del `fetch` a OpenRouter

**Decisión**: el `OpenRouterClient` acepta `timeoutMs` en el constructor (default: 60s, mismo que el default del motor). Si el fetch tarda más, se aborta vía `AbortController` y se mapea a `TIMEOUT`. El motor retry con backoff.

### 3.14. Edge case: respuesta 200 con `choices` vacío

**Decisión**: si OpenRouter retorna 200 pero `choices` está vacío (raro pero posible), el cliente tira `InvalidResponseError` con mensaje "OpenRouter returned empty choices". Se mapea a `INTERNAL_ERROR`. NO es retriable.

### 3.15. Edge case: response que no es JSON válido

**Decisión**: si el `body` del response no es JSON válido, se tira `InvalidResponseError`. Mapea a `INTERNAL_ERROR`. NO retriable.

### 3.16. Edge case: el LLM no devuelve JSON válido cuando se pidió `response_format: json_schema`

**Decisión**: el response 200 con JSON inválido se retorna como `output` (string raw). El motor valida contra `node.outputSchema` (D2a.4) y falla con `SCHEMA_VIOLATION` o `INVALID_OUTPUT`. Esto es consistente con D2a.4: el invoker retorna el output crudo, el motor valida.

**Razón**: el `response_format: json_schema` en OpenRouter es una "petición" al modelo, no una garantía. Si el modelo ignora, la response es texto libre. El motor lo maneja como cualquier otro output que no cumple schema.

### 3.17. Edge case: el nodo del verifier no declara `outputSchema` en el workflow

**Decisión**: el nodo LLM con `assignedSpecialist: "verifier_specialist_v1"` NO necesita declarar `outputSchema` en el workflow. El `VerifierSpecialist` arma su propio `outputSchema` interno (`VERIFIER_OUTPUT_SCHEMA`) y se lo pasa al invoker (OpenRouter) para forzar el `response_format: json_schema`. El motor no valida el output contra un schema (porque no hay schema declarado en el nodo). El verifier se auto-valida: el output es lo que el LLM retornó, y el verifier lo escribe al state tal cual.

**Razón**: el verifier es un specialist opaco para el motor (D2b.1 patrón). El motor solo sabe "el nodo LLM tiene un specialist, el specialist retorna un output, el motor lo escribe al state". El shape del output es responsabilidad del specialist, no del workflow.

**Backward-compat**: el motor solo valida `node.outputSchema` si está declarado. Si no, escribe el output tal cual. El stateSchema del state hace la validación final. Si el output del verifier no encaja en el state, falla con `SCHEMA_VIOLATION` — pero eso es un error de configuración del workflow, no del verifier.

### 3.18. Edge case: el modelo de reasoning devuelve `usage.completion_tokens_details.reasoning_tokens`

**Decisión**: el `OpenRouterLLMInvoker` lee `usage.completion_tokens` (campo principal). El `usage.completion_tokens_details.reasoning_tokens` se IGNORA en D2b.2 (el motor no trackea tokens de reasoning por separado).

**Razón**: el motor no audita "tokens de reasoning vs tokens de output" en D2b.2. Es una distinción de D3+ (audit detallado de costos de modelos como Claude con extended thinking). El `completion_tokens` que OpenRouter reporta YA incluye los reasoning tokens (es el total).

**Deuda**: D3+ introduce `tokensUsed.reasoning` opcional en `NodeResult` si el caller quiere el desglose.

---

## 4. Estructura del código

### 4.1. Nuevos archivos

- `src/agent/llm/openrouter-client.ts` — `OpenRouterClient` con `chat()` y `embeddings()`. `transport` inyectable.
- `src/agent/llm/openrouter-errors.ts` — `OpenRouterError`, `MissingOpenRouterKeyError`, `InvalidResponseError`.
- `src/agent/llm/openrouter-invoker.ts` — `OpenRouterLLMInvoker implements LLMInvoker`. Wrappea el `OpenRouterClient`.
- `src/agent/llm/pricing-catalog.ts` — `PricingCatalog` con defaults y `extend()`.
- `src/agent/llm/index.ts` — barrel.
- `src/agent/specialists/agent-card.ts` — `AgentCard` interface + `toJSON()` A2A v1.0.
- `src/agent/specialists/lifecycle.ts` — `Lifecycle` class con state machine.
- `src/agent/specialists/agent-cards/index.ts` — `INTAKE_AGENT_CARD`, `CLAUSE_REVIEWER_AGENT_CARD`, `VERIFIER_AGENT_CARD` (los 3 cards construidos en código).

### 4.2. Archivos modificados

- `src/agent/specialists/specialist.ts` — agregar `agentCard: AgentCard` y `lifecycle: Lifecycle` a la interface. `agentVersion` cambia de string suelto a semver.
- `src/agent/specialists/intake-specialist.ts` — refactor: `agentCard`, `lifecycle`, `agentVersion: "1.0.0"`, transición de lifecycle en `execute()`.
- `src/agent/specialists/clause-reviewer-specialist.ts` — idem.
- `src/agent/specialists/verifier-specialist.ts` — refactor mayor: `agentCard`, `lifecycle`, sub-sesión lógica, Citation Grounding v2, `agentVersion: "1.0.0"`.
- `src/agent/specialists/index.ts` — barrel actualizado.
- `src/agent/specialists/mocks/mock-invokers.ts` — agregar `MockOpenRouterClient` (un mock del cliente HTTP para tests de `OpenRouterClient`).

### 4.3. Archivos NO modificados

- `src/agent/workflow-engine/**` — Capa 1 intacta. El routing del D2b.1 sigue funcionando.
- `src/agent/agent.ts`, `src/agent/tools.ts`, `src/agent/memory.ts` — código existente intacto.
- Tests D2b.1 (16 tests) — siguen pasando sin cambios.

---

## 5. Contratos clave

### 5.1. `OpenRouterClient`

```typescript
interface OpenRouterClientOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;     // default: "https://openrouter.ai/api/v1"
  readonly timeoutMs?: number;   // default: 60_000
  readonly transport?: (url: string, init: RequestInit) => Promise<Response>; // default: globalThis.fetch
  readonly logger?: { debug(msg: string, meta?: object): void; warn(msg: string, meta?: object): void; error(msg: string, meta?: object): void };
}

interface ChatRequest {
  readonly model: string;
  readonly messages: readonly { role: "system" | "user" | "assistant"; content: string }[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly responseFormat?: JSONSchema; // si está, se traduce a response_format: { type: "json_schema", json_schema: {...} }
  readonly tools?: readonly { type: "function"; function: { name: string; description: string; parameters: JSONSchema } }[];
  readonly signal?: AbortSignal;
}

interface ChatResponse {
  readonly output: string;       // choices[0].message.content
  readonly modelUsed: string;    // response.model
  readonly tokensUsed: { input: number; output: number }; // usage.{prompt_tokens, completion_tokens}
  readonly costUsd: number;      // usage.cost (si está) o 0
  readonly raw: unknown;         // response completo (para audit)
}

class OpenRouterClient {
  constructor(options: OpenRouterClientOptions);
  async chat(request: ChatRequest): Promise<ChatResponse>;
  async embeddings(request: { model: string; input: string | string[] }): Promise<{ embedding: number[]; tokensUsed: number; costUsd: number }>;
}
```

### 5.2. `PricingCatalog`

```typescript
interface ModelPricing {
  readonly promptUsdPerM: number;
  readonly completionUsdPerM: number;
}

class PricingCatalog {
  constructor(initial?: Record<string, ModelPricing>);
  get(modelId: string): ModelPricing | undefined;
  set(modelId: string, pricing: ModelPricing): void;
  extend(pricings: Record<string, ModelPricing>): PricingCatalog; // retorna nuevo catalog con merge
  estimateCost(modelId: string, inputTokens: number, outputTokens: number): number; // 0 si modelo no está
}

const DEFAULT_PRICING: Record<string, ModelPricing> = {
  "deepseek/deepseek-chat": { promptUsdPerM: 0.14, completionUsdPerM: 0.28 },
  "anthropic/claude-3.5-sonnet": { promptUsdPerM: 3.00, completionUsdPerM: 15.00 },
  "qwen/qwen3-embedding-8b": { promptUsdPerM: 0.05, completionUsdPerM: 0.00 },
};
```

### 5.3. `OpenRouterLLMInvoker`

```typescript
class OpenRouterLLMInvoker implements LLMInvoker {
  constructor(
    private readonly client: OpenRouterClient,
    private readonly catalog?: PricingCatalog,
  );

  async invoke(params: LLMInvokeParams): Promise<LLMInvokeResult> {
    // 1. Construir messages desde systemPrompt + userPrompt.
    // 2. Llamar client.chat({...}).
    // 3. Si response.usage.cost está, usarlo. Si no, estimar con catalog.
    // 4. Si outputSchema, intentar parsear output como JSON. Si falla, retornar output raw (motor valida).
    // 5. Retornar LLMInvokeResult.
  }
}
```

### 5.4. `AgentCard`

Ver §3.5. La interface sigue A2A v1.0 spec. El `toJSON()` produce JSON validable contra el schema de A2A.

### 5.5. `Lifecycle`

Ver §3.6. State machine simple, eventos in-memory.

### 5.6. `Specialist` interface actualizada

```typescript
interface Specialist {
  readonly agentId: string;
  readonly agentVersion: string;    // semver "1.0.0" (cambia de "1.0.0-d2b.1")
  readonly agentCard: AgentCard;    // NUEVO en D2b.2
  readonly capabilities: readonly string[];
  readonly preferredModel: ModelRef;
  readonly lifecycle: Lifecycle;    // NUEVO en D2b.2

  execute(params: SpecialistExecuteParams): Promise<NodeExecutionOutcome>;
}
```

### 5.7. `VerifierSpecialist` actualizado

Ver §3.7 y §3.8. Sub-sesión lógica + Citation Grounding v2.

```typescript
class VerifierSpecialist implements Specialist {
  public readonly agentId = "verifier_specialist_v1";
  public readonly agentVersion = "1.0.0";
  public readonly agentCard: AgentCard = VERIFIER_AGENT_CARD;
  public readonly capabilities: readonly string[] = [
    "output_verification",
    "citation_grounding_v2",
    "defendibility",
  ];
  public readonly preferredModel: ModelRef = "robusto";
  public readonly lifecycle: Lifecycle;

  constructor(private readonly invoker: LLMInvoker) {
    this.lifecycle = new Lifecycle();
  }

  async execute(params: SpecialistExecuteParams): Promise<NodeExecutionOutcome> {
    this.lifecycle.transition("busy", `verify ${params.node.id}`);
    try {
      // NO leer params.node.systemPrompt ni params.node.userPrompt del productor.
      const systemPrompt = this.buildVerifierSystemPrompt();
      const userPrompt = this.buildVerifierUserPrompt(params.state, params.node);

      const result = await this.invoker.invoke({
        model: this.preferredModel,
        systemPrompt,
        userPrompt,
        outputSchema: VERIFIER_OUTPUT_SCHEMA,
        signal: params.signal,
      });

      const verifierSessionId = randomUUID();
      const verifiedAt = new Date().toISOString();

      // Validar Citation Grounding v2.
      const citations = this.detectCitations(result.output);
      const citationValidation = this.validateCitations(citations, params.state);

      const verified = citationValidation.allValid && result.output.verified === true;

      this.lifecycle.transition("done", `verify ${params.node.id} done`);
      return {
        status: "completed",
        output: {
          ...result.output,
          issues: citationValidation.issues,
          citations: citationValidation.citations,
          verifierSessionId,
          verifiedAt,
        },
        promptSnapshot: { system: systemPrompt, user: userPrompt },
        // ...
      };
    } catch (e) {
      this.lifecycle.transition("archived", `error: ${e.message}`);
      throw e;
    }
  }
}
```

---

## 6. Tests planeados (~50-70)

### 6.1. `OpenRouterClient` (~15 tests)
1. Constructor con key válida.
2. Constructor con key vacía → `MissingOpenRouterKeyError`.
3. `chat()` con response 200 válido retorna `ChatResponse` con todos los campos.
4. `chat()` con `usage.cost` presente lo retorna.
5. `chat()` con `usage.cost` ausente, usa `PricingCatalog` para estimar.
6. `chat()` con response 401 → `INTERNAL_ERROR`.
7. `chat()` con response 402 → `MODEL_UNAVAILABLE`.
8. `chat()` con response 408 → `TIMEOUT`.
9. `chat()` con response 429 → `RATE_LIMIT`.
10. `chat()` con response 500 → `INTERNAL_ERROR`.
11. `chat()` con response 502/503 → `INTERNAL_ERROR`.
12. `chat()` con response 200 y `choices` vacío → `InvalidResponseError`.
13. `chat()` con response 200 y body no JSON → `InvalidResponseError`.
14. `chat()` con `responseFormat` (JSON Schema) → se traduce a `response_format: json_schema`.
15. `chat()` con `signal` abortado → `AbortError`.
16. `embeddings()` con response 200 válido retorna embedding.

### 6.2. `PricingCatalog` (~5 tests)
17. `get()` con modelo existente.
18. `get()` con modelo inexistente → undefined.
19. `set()` agrega o sobrescribe.
20. `extend()` retorna nuevo catalog con merge (no muta el original).
21. `estimateCost()` calcula correctamente.

### 6.3. `OpenRouterLLMInvoker` (~8 tests)
22. `invoke()` con `outputSchema` parsea el output como JSON.
23. `invoke()` con `outputSchema` y output no JSON → output raw.
24. `invoke()` con `usage.cost` lo retorna en `costUsd`.
25. `invoke()` sin `usage.cost`, usa `catalog.estimateCost()`.
26. `invoke()` con `systemPrompt` y `userPrompt` los traduce a `messages: [...]`.
27. `invoke()` con `tools` los traduce al formato OpenRouter.
28. `invoke()` propaga errores del cliente.
29. `invoke()` con `signal` abortado.

### 6.4. `AgentCard` (~5 tests)
30. `toJSON()` produce JSON A2A v1.0 válido (validable contra schema).
31. `toJSON()` incluye `name`, `version`, `capabilities`, `skills`, `securitySchemes`.
32. Cada specialist expone su `agentCard` con `agentId` matching.
33. `AgentCard.pricing` es opcional.
34. `AgentCard.limits` es opcional.

### 6.5. `Lifecycle` (~8 tests)
35. Lifecycle arranca en `spawn`.
36. Transición `spawn → idle` es válida.
37. Transición `idle → busy` es válida.
38. Transición `busy → done` es válida.
39. Transición `busy → paused` es válida.
40. Transición inválida (`spawn → busy`) tira error.
41. `events` array se popula en cada transición.
42. `stateChangedAt` se actualiza en cada transición.

### 6.6. Specialists con cards y lifecycle (~6 tests)
43. Cada specialist tiene `agentCard` con `agentId` matching.
44. Cada specialist tiene `lifecycle` que arranca en `spawn`.
45. `execute()` exitoso transiciona `spawn → idle → busy → done`.
46. `execute()` con error transiciona a `archived`.
47. `agentVersion` es "1.0.0" (no "1.0.0-d2b.1").
48. `agentCard.toJSON()` es serializable a JSON.

### 6.7. VerifierSpecialist con sub-sesión (~8 tests)
49. `execute()` NO lee `params.node.systemPrompt` del productor.
50. `execute()` retorna `output.verifierSessionId` (UUID válido).
51. `execute()` retorna `output.verifiedAt` (ISO timestamp).
52. `execute()` con output que tiene citas a texto válidas → `verified: true`.
53. `execute()` con output que tiene citas a texto inválidas → `verified: false` con `issues`.
54. `execute()` con output que tiene citas a metadatos → valida contra el state.
55. `execute()` con `outputSchema` JSON schema define el shape del output del verifier.
56. El system prompt del verifier es DISTINTO del system prompt de un nodo productor.

### 6.8. Backward-compat (~3 tests)
57. Tests D2b.1 (16 tests) siguen pasando.
58. Specialists pueden recibir `MockDeepSeekFlashInvoker` o `OpenRouterLLMInvoker` indistintamente.
59. El `SpecialistRegistry` se construye igual con cualquier `LLMInvoker`.

### 6.9. Smoke test E2E con OpenRouter real (~1 test, opcional)
60. `OPENROUTER_API_KEY=sk-or-v1-xxx` en env → 1 llamada a `deepseek/deepseek-chat` con prompt "say hello" → response 200 con `usage.cost`. **Este test está marcado como opcional y solo corre si la key está disponible**. Los demás 59 tests no dependen de la red.

---

## 7. Resumen de cambios al código

| Archivo | Cambio | LoC estimadas |
|---|---|---|
| `src/agent/llm/openrouter-client.ts` (nuevo) | Cliente HTTP con transport inyectable | ~250 |
| `src/agent/llm/openrouter-errors.ts` (nuevo) | Errores específicos | ~80 |
| `src/agent/llm/openrouter-invoker.ts` (nuevo) | LLMInvoker que envuelve el cliente | ~120 |
| `src/agent/llm/pricing-catalog.ts` (nuevo) | Catálogo con defaults y extend | ~80 |
| `src/agent/llm/index.ts` (nuevo) | Barrel | ~10 |
| `src/agent/specialists/agent-card.ts` (nuevo) | Interface + toJSON | ~150 |
| `src/agent/specialists/lifecycle.ts` (nuevo) | State machine | ~120 |
| `src/agent/specialists/agent-cards/index.ts` (nuevo) | Los 3 cards en código | ~200 |
| `src/agent/specialists/specialist.ts` (modificado) | +agentCard, +lifecycle, agentVersion semver | ~50 |
| `src/agent/specialists/intake-specialist.ts` (modificado) | +agentCard, +lifecycle, version "1.0.0" | ~30 |
| `src/agent/specialists/clause-reviewer-specialist.ts` (modificado) | idem | ~30 |
| `src/agent/specialists/verifier-specialist.ts` (mayor refactor) | Sub-sesión + Citation Grounding v2 + lifecycle | ~250 |
| `src/agent/specialists/index.ts` (modificado) | Barrel actualizado | ~20 |
| `src/agent/specialists/mocks/mock-invokers.ts` (modificado) | +MockOpenRouterClient | ~80 |
| `test_workflow_d2b_2.mts` (nuevo) | 50+ tests | ~1500 |
| **Total** | | **~3,000** |

---

## 8. Decisiones tomadas en este turno (registradas para audit)

1. **D2b.2 = 1 sprint completo** (confirmado con el usuario). NO dividido en partes.
2. **OpenRouterClient = `fetch` directo, NO SDK `openai`**. Mismo patrón que `src/agent/memory.ts`.
3. **3 modelos en el catálogo**: `deepseek/deepseek-chat` (liviano), `anthropic/claude-3.5-sonnet` (robusto), `qwen/qwen3-embedding-8b` (embedding).
4. **Pricing real = `usage.cost` de OpenRouter** (cuando está) + `PricingCatalog` como fallback.
5. **Agent Card = objeto TypeScript en código** (confirmado por el usuario). `toJSON()` A2A v1.0.
6. **Lifecycle = state machine simple en código** (sin `xstate` ni libs externas).
7. **Sub-sesión del verifier = prompt limpio, mismo LLM** (confirmado por el usuario). NO child_process, NO Mavis.
8. **`agentVersion` cambia de `1.0.0-d2b.1` a `1.0.0`**. Semver limpio.
9. **`openrouter_metadata` se ignora en el `LLMInvokeResult.raw`** (es para debug, no para el motor).
10. **El `OpenRouterClient` NO loguea la key** (ni en debug, ni en error, ni en info).
11. **Citation Grounding v2 = heurística** (substring + lista cerrada de campos de metadatos). `read_section` real es D3+.
12. **El verifier retorna metadata para audit** (`verifierSessionId`, `verifiedAt`, `issues`, `citations`).
13. **Backward-compat total con D2b.1**: 16 tests existentes sin cambios, los mocks siguen funcionando.
14. **El motor (Capa 1) NO se toca** — D2b.2 es 100% en Capa 3 + nuevo `src/agent/llm/`.
15. **Smoke test E2E con OpenRouter real es opcional** (depende de la key en env). Los demás tests son offline.
16. **El `OpenRouterClient` no cachea nada** (cada llamada es fresh). Cache es D3+.
17. **Constructors de specialists backward-compat**: `new IntakeSpecialist(invoker)`, `new ClauseReviewerSpecialist(invoker)`, `new VerifierSpecialist(invoker)` siguen funcionando sin cambios. El `agentCard` es un campo estático (`public readonly agentCard = INTAKE_AGENT_CARD`) — no se pasa como param. El `lifecycle` se inicializa en el constructor. Los 16 tests D2b.1 que usan estos constructors siguen pasando.
18. **El `raw` field del `ChatResponse` NO se loguea por default** (puede contener metadata sensible del response). Si el caller quiere loguear para audit, debe sanitizar primero. El `OpenRouterClient` loguea solo campos no-sensibles (status code, latency, model).
19. **`OpenRouterLLMInvoker.invoke()` retorna `costUsd` calculado**:
    - Si `usage.cost` está en el response, usar ese (real facturado).
    - Si no, usar `catalog.estimateCost()` (estimación).
    - El `raw` field del ChatResponse preserva ambos (si el caller quiere auditar el drift).
20. **`response_format: { type: "json_schema" }` se traduce desde el `outputSchema` del LLMInvokeParams**:
    - Si `params.outputSchema` está, el invoker arma `response_format: { type: "json_schema", json_schema: { name: "structured_output", schema: outputSchema, strict: true } }`.
    - Si no, NO se manda `response_format` (el LLM responde texto libre).
    - El `strict: true` fuerza al LLM a cumplir el schema. Modelos que no soportan `strict` lo ignoran (degradación graciosa).

**Reversibilidad**: si alguna decisión no te cuadra, decime y la cambiamos antes de codear.

---

## 9. Próximo sprint (después de D2b.2)

D2b.2 cierra la sub-capa "specialists reales" de D2b. Lo que sigue:

- **D2c — Skills v1** (roadmap §5.4, §5.14): empaquetar las topic-based policies como skills con SKILL.md. Los principios jurídicos colombianos (ley posterior, ley especial, etc.) se inyectan en los prompts de los specialists via skills, no hardcodeados.
- **D3 — Multi-tenant + DB** (roadmap §5.9, §6): introducir `tenantId` en cada Agent Card, separar instancias por firma, persistir tasks y audit log en DB. Agent Cards formales por tenant.
- **D3+ — A2A server** (roadmap §5.8): publicar los Agent Cards en `/.well-known/agent.json` y aceptar requests JSON-RPC.
- **D3+ — RAG + `read_section` real** (roadmap §5.13): Citation Grounding v2 con RAG real, no heurística.
- **D3+ — Circuit breaker por specialist** (roadmap §6.1.4): hoy el breaker es por modelo, en D3+ es por specialist (con Agent Card formal).

---

## 10. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| OpenRouter cambia la API | El `OpenRouterClient` es 1 archivo aislado. Si cambia, se actualiza en un commit chico. |
| Costos de OpenRouter en CI | El smoke test E2E con OpenRouter real está marcado como opcional y solo corre si la key está disponible. Los demás 59 tests no tocan la red. |
| La key de OpenRouter se filtra en logs | El cliente NUNCA loguea la key. Verificable con grep en el código. |
| El LLM no cumple el JSON schema | El cliente retorna el output crudo; el motor valida (D2a.4). Consistente con D2a.4. |
| El verifier no detecta una cita falsa | La heurística es imperfecta. Se documenta. El `read_section` real (D3+ con RAG) cierra la garantía. |
| El lifecycle tiene race conditions | El `Lifecycle` es single-threaded (cada specialist es una instancia). Las transiciones son síncronas. No hay race conditions porque JavaScript es single-threaded. |
| El `OpenRouterLLMInvoker` se rompe con un modelo nuevo | El `PricingCatalog` es extensible. Si un modelo nuevo no tiene precio, `estimateCost` retorna 0 y el log lo registra. |
| Tests D2b.1 se rompen | No se modifica el motor. Los specialists con mocks siguen funcionando. Los 16 tests D2b.1 deben seguir pasando sin cambios. |

---

## 11. References cruzados

- `AGENT_D2B_1_SPEC.md` — spec del sprint anterior (D2b.1).
- `AGENT_ROADMAP.md` §5.3 (3 capas), §5.5 (multi-model), §5.6 (verifier en sub-sesión), §5.9 (Agent Card + lifecycle + costo atribuible), §5.13 (Citation Grounding v2), §5.14 (principios jurídicos), §6.2 (D2b).
- `AGENT_WORKFLOW_DSL_SPEC.md` — DSL del motor (sin cambios en D2b.2).
- `AGENT_D2A_4_HITL_PRIMITIVES_SPEC.md` — HITL primitives (sin cambios).
- `AGENT_D2A_2_3_CORE_PRIMITIVES_SPEC.md` — primitivas de núcleo (sin cambios).
- [OpenRouter API reference](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request) — formato de request/response.
- [A2A Protocol Specification](https://github.com/a2aproject/A2A/blob/main/docs/specification.md) — schema de Agent Card.
