# D2a.5 — Workflow Ejemplo End-to-End: Spec

> **Spec para D2a.5.** Smoke test del motor entero (D2a.2 + D2a.2.2 + D2a.2.3 + D2a.4) con un workflow real que ejercita cada primitiva no negociable: state validation, prompt snapshot, replay, schema versioning, circuit breaker, HITL pause/resume. Esta es la **primera vez que el motor corre con un workflow no-trivial end-to-end**. Hasta ahora los tests unitarios probaban primitivas aisladas; este sprint prueba que **juntas funcionan**.
>
> **Origen de la decisión**: el workflow canónico ya está documentado en `AGENT_WORKFLOW_DSL_SPEC.md` §5 (`revision-generica`, el workflow de prueba del motor). Se eligió ultra-simple a propósito — 4 nodos, sin paralelismo, sin condicionales complejas — para validar el motor sin que la abstracción se deforme para encajar un caso real. La abstracción se generaliza con un segundo caso (cuando llegue D6 o un workflow real de la firma).

## 0. Status

- **Versión actual**: 1.0 (decisiones tomadas en este turno, 2026-06-12).
- **Alcance**: workflow ejemplo end-to-end. Cierra D2a.
- **Cubre**:
  - **Implementar el workflow `revision-generica`** del spec DSL §5 como JSON ejecutable.
  - **Mocks productivos de los 3 inyectables** (`LLMInvoker`, `HITLHandler`, `FunctionRegistry`) que ejecutan el workflow de inicio a fin.
  - **Smoke test end-to-end** que verifica que el motor cierra el workflow con todas las primitivas ejercitadas.
  - **Tests de integración** (no unitarios) que validan el comportamiento del workflow completo, no de primitivas aisladas.
- **NO cubre** (llegará cuando duela):
  - **Persistencia de tasks y nodos en DB** (D3).
  - **Specialists reales** (D2b). Acá los mocks hacen el trabajo.
  - **UI de HITL** (D3+). Acá el `HITLHandler` retorna `immediateResponse` o espera el `resumeTask` programático.
  - **Multi-tenancy** (D3). La task tiene `tenantId: "default"`.
  - **Observabilidad UI** (D3+). El log del executor es `console.log` simple.
  - **Cableado del motor al server** (D2a.5+). Acá el workflow se ejecuta standalone desde un script de test.
  - **Casos representativos** (arrendamiento, NDA, demanda laboral). El workflow es genérico a propósito; los casos reales entran cuando una firma los pida.
- **Implementación esperada**: archivo JSON del workflow + mocks en un nuevo test file `test_workflow_d2a_5.mts`. Sin cambios al motor (ya cerrado en D2a.4).
- **Owner del cambio**: este spec vive en el repo. Modificaciones requieren acuerdo explícito antes de mergear.

---

## 1. Por qué este spec existe

Hasta D2a.4, el motor está testeado por primitivas:
- `test_workflow_executor.mts` (53 tests): lifecycle, loop, router, error actions, state I/O, abort signals.
- `test_workflow_d2a_2_3.mts` (36 tests): state validation, prompt snapshot, replay, schema versioning, circuit breaker, HITL paused branch cleanup.
- `test_workflow_d2a_4.mts` (18 tests): HITL pause/resume, immediate response, outputSchema, onTimeout.

Cada test prueba UNA primitiva. **Nunca probamos el workflow completo de inicio a fin con todas las primitivas interactuando**. Esto es lo que D2a.5 hace.

**Riesgo sin este sprint**: el motor puede pasar 107 tests unitarios pero romperse en la primera ejecución real de un workflow no-trivial. El bug aparecería en producción o cuando un dev cablee el motor al server.

**Riesgo que NO es**: el motor está "roto" o "incompleto". Los tests unitarios cubren cada primitiva. Lo que falta es la **prueba de integración** de que las primitivas interactúan correctamente.

---

## 2. Goals & Non-goals

### 2.1. Goals (lo que D2a.5 DEBE cumplir)

1. **Workflow ejecutable end-to-end**: el JSON del workflow `revision-generica` corre de inicio a fin sin errores. El motor completa la task con `status='completed'` y todos los `NodeResult` con `status='completed'`.
2. **Mocks productivos**: el `LLMInvoker` mock retorna outputs válidos para `classify`, `extract`, `summarize`. El `HITLHandler` mock retorna `immediateResponse` para `approve` (o se llama `resumeTask` programáticamente en un test alternativo). El `FunctionRegistry` está vacío (no se usan nodos `function` en el workflow; igual el `ExecutorConfig` lo requiere como inyectable, ver §3.3).

**Identificación de nodo en el mock LLM**: el mock identifica qué nodo lo llama por el `userPrompt` o `systemPrompt` (campos únicos por nodo en el workflow), NO por el campo `model` (que es compartido entre workflows, ej: `model: "robusto"` lo usan `extract` y `summarize`). Implementación típica: matchear un substring del prompt contra constantes por nodo.
3. **Ejercitar todas las primitivas no negociables en un solo test**:
   - State schema validation (input + post-output).
   - Prompt snapshot persistence (nodos LLM).
   - Confidence gating (nodo `classify` tiene `outputSchema` con `confidence`, el motor lo lee).
   - Replay (un test que crea una task, la completa, y hace replay con un input distinto).
   - Schema versioning (un test que carga el workflow con `schemaVersion: 1` y verifica que no se aplica ninguna migración).
   - Circuit breaker (un test que verifica que el motor consulta `isOpen` antes de cada attempt — con el `NoopCircuitBreaker` default, nunca abre).
   - HITL pause/resume (un test que verifica el camino completo: pause con `pendingDecision` → `resumeTask` → task completed).
4. **Tests de integración claros**: un archivo `test_workflow_d2a_5.mts` con ~6-8 tests que validan el workflow completo, no primitivas aisladas. El patrón es: setup del workflow + mocks → `startTask` + `run` → assertions sobre el `TaskRunResult` y el estado final.
5. **Cero cambios al motor**: el motor está cerrado en D2a.4. Si D2a.5 revela un bug del motor, se arregla y se documenta como sprint extra (no en este).
6. **Documentación operativa**: este spec + un README breve en `test_workflow_d2a_5.mts` que explique cómo correr el smoke test.

### 2.2. Non-goals (D2a.5 — diferidos)

- **Persistencia en DB**: la task vive en el `Map` del executor. Si el server reinicia, se pierde. D3.
- **Specialists reales**: los `LLMInvoker` y `HITLHandler` son mocks. D2b enchufa los reales.
- **UI de HITL**: el `HITLHandler` retorna `immediateResponse` (modo interactivo) o se llama `resumeTask` desde el test. No hay UI. D3+.
- **Multi-tenancy**: `tenantId: "default"`. D3 introduce tenants reales.
- **Observabilidad UI**: el log es `console.log` simple. D3+ introduce dashboards.
- **Casos reales**: el workflow es genérico (`revision-generica`). Casos representativos (arrendamiento, NDA, demanda laboral) se eligen cuando una firma los pida. D6.
- **Cableado al server**: el workflow se ejecuta standalone desde el test. Cablear el motor al `server.ts` es un sprint separado (D2a.5+ o D2b).
- **Performance**: el smoke test no mide latencia ni throughput. Solo valida correctitud.
- **Workflows múltiples en paralelo**: un test corre un workflow a la vez. Multi-task se prueba en `test_workflow_executor.mts`.

---

## 3. Decisiones de diseño

### 3.1. ¿Por qué `revision-generica` y no otro workflow?

**Decisión**: usar el workflow que ya está documentado en `AGENT_WORKFLOW_DSL_SPEC.md` §5.

**Razón**: el spec DSL lo define como el "workflow de prueba v1" del motor. Es ultra-simple a propósito (4 nodos, sin paralelismo, sin condicionales complejas). La abstracción del motor no se deforma para encajar un caso real.

**Cuándo elegir el segundo workflow (representativo)**: cuando llegue una firma con un caso concreto (arrendamiento, NDA, demanda laboral). Ahí se elige el segundo workflow con más cuidado y se generaliza la abstracción con dos casos en lugar de uno.

### 3.2. ¿Cómo se proveen los inputs al workflow?

**Decisión**: el test pasa el input completo al `startTask`. El workflow espera `{ documentId, documentContent }`. El input del test es:

```typescript
const input = {
  documentId: "doc-001",
  documentContent: "CONTRATO DE ARRENDAMIENTO DE VIVIENDA...",
};
```

**Por qué hardcoded en el test**: es un smoke test, no un test de parametrización. Si el workflow requiere inputs más complejos en el futuro, se parametriza. Hoy, simple.

### 3.3. ¿Cómo se mockean los inyectables?

**Decisión**: mocks específicos al workflow. El `LLMInvoker` reconoce qué nodo lo llama (vía el campo `model` o vía el prompt template) y retorna el output apropiado. El `HITLHandler` retorna `immediateResponse` (modo interactivo) por default, con un flag para testear el modo `paused_hitl` + `resumeTask`.

**Alternativa considerada**: mocks genéricos que retornan lo que sea. **Descartada**: un test que valida el workflow completo necesita verificar que el state se escribe correctamente. Eso requiere outputs específicos del LLM mock, no basura genérica.

### 3.4. ¿Modo `immediateResponse` o `paused_hitl` para el HITL del workflow?

**Decisión**: dos tests separados.

- **Test A** (modo `immediateResponse`): el `HITLHandler` mock retorna `{ type: "approved", output: { approved: true, feedback: "OK" } }` via `immediateResponse`. El workflow corre de inicio a fin sin pausa real. Valida el camino "feliz".
- **Test B** (modo `paused_hitl` + `resumeTask`): el `HITLHandler` mock retorna `{ requestId }` sin `immediateResponse`. El workflow se pausa en `approve`. El test llama `executor.resumeTask(taskId, response)` con la respuesta. Valida el camino "HITL real con resume explícito".

**Por qué ambos**: el modo `immediateResponse` es lo que el `ask_human` de D1 usa hoy (interactivo). El modo `paused_hitl` es lo que el `HITLHandler` desacoplado de D2b+ usará. Validar ambos en el smoke test cubre los dos patrones de uso que veremos en producción.

### 3.5. ¿Dónde vive el JSON del workflow?

**Decisión**: en `tests/fixtures/revision-generica.workflow.json` (nuevo directorio).

**Razón**: el workflow es un asset del test, no del código de producción. Separar el JSON del `.mts` permite:
- Validar el JSON contra el DSL schema independientemente del test.
- Reutilizar el mismo JSON en futuros tests (D2a.5+, D2b, D3).
- Mostrar el workflow "completo" en un archivo legible sin navegar TypeScript.

**Alternativa considerada**: inline el JSON en el `.mts`. **Descartada**: el JSON tiene ~80 líneas, inline hace el test ilegible.

**Diferencia con el spec DSL §5**: el JSON del spec DSL §5 tiene `stateSchema` con `properties` pero sin `required` (las propiedades son todas opcionales). Para que el test 3 (state validation rechaza input inválido) funcione sin falsear el schema, el JSON del fixture agrega `required: ["documentContent"]`. Es una decisión del fixture, no del spec DSL — el DSL deja las propiedades como opcionales a propósito (los workflows reales pueden tener input parcial).

### 3.6. ¿Se commitea el cambio al motor?

**No, en principio.** Si el smoke test pasa sin tocar el motor, D2a.5 es solo tests + fixture JSON. Si el smoke test revela un bug del motor, ese bug se arregla en un sprint aparte (no se mezcla con D2a.5).

**Si D2a.5 necesita un fix mínimo del motor** (ej: un caso edge que no se cubrió en D2a.4): se arregla acá, se documenta en el spec como "bug encontrado durante smoke test", y se incluye un test que verifica el fix.

---

## 4. Estructura del smoke test

### 4.1. Mocks

```typescript
// Mocks específicos al workflow `revision-generica`.

class RevisionGenericaLLM implements LLMInvoker {
  async invoke(params: LLMInvokeParams): Promise<LLMInvokeResult> {
    // Detectar qué nodo nos llama por el userPrompt o systemPrompt.
    // El nodo classify pide "categoría y confianza" → retornamos {category, confidence}.
    // El nodo extract pide "extraer cláusulas" → retornamos [{...}, {...}].
    // El nodo summarize pide "resumir" → retornamos {summary: "..."}.
  }
}

class RevisionGenericaHITL implements HITLHandler {
  // Modo interactivo: retorna immediateResponse con approved.
  // Modo paused: retorna solo requestId, el test llama resumeTask después.
  async initiate(params: HITLInitiateParams): Promise<HITLInitiateResult> {
    if (this.mode === "interactive") {
      return {
        requestId: "test-req-1",
        immediateResponse: { type: "approved", output: { approved: true, feedback: "OK" } },
      };
    }
    return { requestId: "test-req-1" }; // paused
  }
}
```

### 4.2. Tests (~7)

1. **`smoke: workflow revision-generica corre end-to-end con immediateResponse`** — el caso feliz. Verifica `status='completed'`, todos los `NodeResult.status='completed'`, state final con `classification`, `extractedClauses`, `summary`, `approval` poblados.

2. **`smoke: workflow revision-generica con pause/resume explícito`** — el caso HITL real. Verifica que la task se pausa con `pendingDecision`, el test llama `resumeTask`, y la task completa.

3. **`smoke: state validation rechaza input inicial inválido`** — pasa un input que rompe el `stateSchema`. Verifica que `startTask` tira `ExecutorError` con código `SCHEMA_VIOLATION`. **Decisión de implementación**: el workflow del spec DSL §5 no tiene `required: ["documentId"]` en el `stateSchema` (solo `properties`), así que pasar `input: null` puede no fallar. El test debería pasar explícitamente `{ documentContent: 123 }` (número en vez de string) para forzar la violación. O agregar `required: ["documentContent"]` al JSON del workflow (decisión: agregar `required` para hacer el test más estricto).

4. **`smoke: state validation rechaza output que rompe schema`** — el mock LLM de `classify` retorna `{category: 123}` (número en vez de string). Verifica que la task falla con `SCHEMA_VIOLATION` y el `NodeResult` de `classify` queda en `failed`.

5. **`smoke: prompt snapshot se persiste en nodos LLM`** — los `NodeResult` de `classify` y `summarize` (ambos nodos LLM) tienen `promptSnapshot` con system + user interpolados (no vacíos). Verificar **al menos 2 nodos LLM** porque el spec dice que el snapshot es invariante, no solo en un nodo.

6. **`smoke: replay del workflow completo con input distinto`** — corre el workflow, hace `replayTask` con un `documentContent` distinto, verifica que la nueva task corre el workflow con el nuevo input y completa con el state del nuevo documento.

7. **`smoke: confidence gating lee el campo confidence del output`** — el output de `classify` tiene `confidence: 0.95`. El motor calcula el label (HIGH/MEDIUM/LOW) y lo persiste en `NodeResult.confidence`. Verifica que el label es `HIGH` con `highThreshold: 0.8`.

### 4.3. Setup compartido

```typescript
function setupRevisionGenerica(): {
  workflow: WorkflowDefinition;
  executor: WorkflowExecutor;
  llm: RevisionGenericaLLM;
  hitl: RevisionGenericaHITL;
} {
  const workflow = JSON.parse(
    readFileSync("tests/fixtures/revision-generica.workflow.json", "utf-8"),
  );
  // Sanity check opcional: el motor valida el workflow en startTask, pero
  // validarlo acá acelera el debug si el JSON está mal armado.
  // const validation = validateWorkflow(workflow);
  // assert.equal(validation.valid, true, "workflow debe pasar validateWorkflow");
  const llm = new RevisionGenericaLLM();
  const hitl = new RevisionGenericaHITL();
  const executor = new WorkflowExecutor({
    // FunctionRegistry vacío: el workflow no usa nodos `function`, pero el
    // ExecutorConfig requiere el inyectable. Cast por mismatch preexistente
    // de tipos (FunctionRegistry vs Map<string, WorkflowFunction>).
    functionRegistry: new FunctionRegistry() as unknown as Map<string, WorkflowFunction>,
    llmInvoker: llm,
    hitlHandler: hitl,
  });
  return { workflow, executor, llm, hitl };
}
```

---

## 5. Validación del fixture JSON

El JSON del workflow debe:
- Pasar `validateWorkflow(workflow)` sin errores (shape + cross-validation).
- Tener `schemaVersion: 1` (compatible con el motor).
- Respetar el contrato de cada nodo (ver DSL spec §3).

Si la validación falla, el test lo detecta al inicio con un `assert` claro:
```typescript
const validation = validateWorkflow(workflow);
assert.equal(validation.valid, true, "workflow debe pasar validateWorkflow");
```

---

## 6. Edge cases que el smoke test cubre (sin pretender cubrirlos todos)

El smoke test NO es exhaustivo. Cubre los flujos principales. Los edge cases están en los tests unitarios (`test_workflow_executor.mts`, `test_workflow_d2a_2_3.mts`, `test_workflow_d2a_4.mts`).

| Edge case | Dónde se cubre |
|---|---|
| Output de nodo que rompe `stateSchema` | `test_workflow_d2a_5.mts` test 4 (smoke) + `test_workflow_d2a_2_3.mts` unitarios |
| Replay de task con input distinto | `test_workflow_d2a_5.mts` test 6 (smoke) + `test_workflow_d2a_2_3.mts` unitarios |
| HITL con `declined` | `test_workflow_d2a_4.mts` unitarios |
| HITL con `onTimeout='approve'` | `test_workflow_d2a_4.mts` unitarios |
| Schema versioning con migrador | `test_workflow_d2a_2_3.mts` unitarios |
| Circuit breaker abierto | `test_workflow_d2a_2_3.mts` unitarios |
| Reintento de LLM por RATE_LIMIT | `test_workflow_executor.mts` unitarios |

**Conteo final esperado al cierre de D2a.5**: 107 (motor, sin cambios) + 7 (D2a.5 smoke) = **114/114 tests pasan**. Cero regresiones.

---

## 7. Resumen de cambios al código

| Archivo | Cambio |
|---|---|
| `tests/fixtures/revision-generica.workflow.json` (nuevo) | El workflow del DSL spec §5 como JSON ejecutable. |
| `test_workflow_d2a_5.mts` (nuevo) | 7 tests de smoke + mocks + setup compartido. README breve al inicio. |
| `AGENT_WORKFLOW_DSL_SPEC.md` | Sin cambios. El JSON es ejecutable contra el spec tal como está. |
| `src/agent/workflow-engine/**` | **Sin cambios**. El motor está cerrado en D2a.4. Si D2a.5 revela un bug, sprint aparte. |

**Estimación de líneas**:
- `revision-generica.workflow.json`: ~80 líneas.
- `test_workflow_d2a_5.mts`: ~300 líneas (mocks ~100, tests ~150, setup ~50).
- **Total**: ~380 líneas.

---

## 8. Decisiones que tomo en este turno (registradas para audit)

1. **El workflow es `revision-generica` del DSL spec §5** — ya está diseñado, no reinvento.
2. **Dos modos de HITL testeados** (`immediateResponse` + `paused_hitl` + `resumeTask`) — cubre los dos patrones de uso.
3. **JSON en `tests/fixtures/` separado del test** — el JSON es asset, no código de test.
4. **Cero cambios al motor en este sprint** — si un test falla por bug del motor, sprint aparte.
5. **7 tests de smoke, no exhaustivo** — los edge cases ya están cubiertos por los unit tests.
6. **Mocks específicos al workflow, no genéricos** — el smoke test valida state correcto, requiere outputs específicos.

**Reversibilidad**: si alguna decisión no te cuadra, decime y la cambiamos antes de codear.

---

## 9. Próximo sprint propuesto (D2a cerrado, D2b próximo)

Con D2a cerrado (D2a.5 es el último sprint de D2a), el siguiente bloque es **D2b — multi-modelo + specialists**:
- Tier liviano (DeepSeek Flash) vs robusto (M3 Thinking), reglas por tipo de nodo, versionado.
- 2-3 specialists: `intake_specialist`, `clause_reviewer_specialist`, `verifier_specialist`.
- Subagente verificador en sesión nueva (sin sesgo confirmatorio).

D2b es la "primera vez que el motor hace trabajo real de legal colombiano" — conecta el motor a un caso de uso concreto. El motor cerrado es infraestructura; D2b es producto.
