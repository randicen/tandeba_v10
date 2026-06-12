# D2a.2.3 — Primitivas de Núcleo Cerradas: Spec

> **Spec para cerrar D2a.2 (executor).** Cubre los gaps que D2a.2.2 dejó + las primitivas no negociables que la roadmap §6.1 lista y el DSL spec §6 ya define contractualmente pero no están implementadas. Esta es la **fuente de verdad** del comportamiento de runtime de estas primitivas. Cambios al comportamiento se acuerdan y reflejan **antes** de tocar código.

## 0. Status

- **Versión actual**: 1.1 (incorpora revisión de peer M3 + decisiones de auditoría legal de Worgena)
- **Alcance**: D2a.2 (executor mínimo, single-process). Cierra el motor para que D2a.5 (workflow ejemplo end-to-end) se pueda escribir sobre cimientos sólidos.
- **Cubre**:
  - **State schema validation** (gap heredado de D2a.2.2 — el comentario dice "el motor valida" pero el código no lo hace).
  - **Prompt snapshot persistence** (gap menor — el `NodeResult.promptSnapshot` está en el DSL spec §3 pero el `node-runner` no lo guarda).
  - **Time travel / replay mínimo** (DSL spec §6.5 ya define el contrato — falta implementación).
  - **Schema versioning con migrator** (DSL spec §6.6 ya define el contrato — falta implementación).
  - **Circuit breaker — interfaz** (decisión zanjada acá: el motor provee la interfaz, la política vive en otro lado).
  - **Limpieza de HITL paused** (dead code en `executor.ts:330-337` que hay que remover o completar).
- **NO cubre** (llegará cuando duela):
  - **Cache persistente de idempotency** entre tasks (D3 introduce DB).
  - **Time-travel UI** (D3).
  - **Schema migration auto-generada** desde diff de spec (humano escribe el migrador).
  - **Circuit breaker policy real** (D2b multi-model router implementa la policy, no acá).
- **Implementación esperada**: extiende `src/agent/workflow-engine/`. **Tests**: `test_workflow_executor.mts` (50 → ~88 tests, +38).
- **Owner del cambio**: este spec vive en el repo. Modificaciones requieren acuerdo explícito antes de mergear.

---

## 1. Por qué este spec existe

D2a.2.2 cerró timeout/retry/idempotency con 14 tests y un bug crítico corregido (orden de checks: safety net antes que catalog filter). Bien. Pero releer el código ahora muestra tres problemas:

1. **Comentarios desactualizados en el código.** `executor/index.ts:14-19` y `executor.ts:13-19` dicen "NO incluido en v1: Retry config, Idempotency, State schema validation, Replay" — eso es lo que ERA cierto en D2a.2 v1, antes de 2a.2.2. Retry e idempotency YA están. Pero state validation NO se hizo y el comentario no se actualizó. Riesgo: el próximo developer lee el comentario, cree que state validation no es prioridad, y la primitiva queda olvidada para siempre.

2. **Gaps de implementación no documentados como gaps.** El DSL spec §3 dice que `NodeResult` tiene `promptSnapshot` para audit. El `node-runner` no lo guarda. El `executor.ts::makeSuccessResult` no lo recibe. Es un gap silencioso.

3. **Primitivas definidas en el DSL spec como contrato pero no implementadas.** Time travel (§6.5) y schema versioning (§6.6) son contrato. El usuario los lee y asume que existen. No existen en código. El primer workflow real que intente hacer replay (debug de redlines legales) se va a encontrar con un motor que no sabe hacerlo.

Este spec zanja los tres. Y de paso decide formalmente dónde vive el **circuit breaker** (la roadmap §6.1 lo lista como primitiva del motor; el spec 2a.2.2 dice que vive en D2b; el código no tiene nada).

**Sin este spec**, el motor parece cerrado (D2a.2.2 ✅) pero tiene cimientos flojos. D2a.5 (workflow ejemplo) corre, pero no valida state, no puede hacer replay, y no maneja el caso de "el schema del spec cambió y un workflow viejo queda huérfano".

---

## 2. Goals & Non-goals

### 2.1. Goals (lo que D2a.2.3 DEBE cumplir)

1. **State validation real.** Después de cada output de nodo, el motor valida el state contra `stateSchema`. Si no valida, la task falla con `SCHEMA_VIOLATION` y el `NodeResult` queda persistido con el error. El comentario obsoleto en `state.ts:103` se elimina.
2. **Input validation.** El `input` inicial pasado a `startTask` se valida contra `stateSchema`. Si no valida, `startTask` tira error claro (no se crea la task). El spec DSL §7 ya dice esto — falta la implementación.
3. **Prompt snapshot persistido.** Cada `NodeResult` de un nodo LLM lleva `promptSnapshot: { system, user, tools }` con el texto exacto enviado al LLM. Es el activo de audit. Sin esto, un incidente de "el LLM dijo algo raro" no se puede investigar.
4. **Time travel mínimo funcional.** El executor expone `replayTask(taskId, opts)` que clona una task, opcionalmente cambia el `input` y opcionalmente arranca desde un nodo específico. La task original queda intacta. Cumple DSL spec §6.5.
5. **Schema versioning real.** Al cargar un workflow (`parseWorkflow` o `validateWorkflow`), el motor compara su `schemaVersion` con la del motor actual. Si difiere, aplica migradores registrados. Si no hay migrador, error claro. Cumple DSL spec §6.6.
6. **Circuit breaker: interfaz + default no-op.** El motor provee una interfaz `CircuitBreaker` que el LLM/HITL runner puede consultar y reportar. La implementación por default es un `NoopCircuitBreaker` (nunca abre). D2b inyecta la implementación real.
7. **HITL paused: o se implementa, o se borra.** El dead code en `executor.ts:330-337` que trata `paused` como `HITL_TIMEOUT` se elimina. Si la respuesta del HITL handler es válida, el motor la procesa (que es lo que ya hace el `node-runner` retornando `success` o `failure` con códigos específicos).
8. **Comentarios sincronizados.** Los comentarios en `executor/index.ts`, `executor.ts`, y `state.ts` se actualizan para reflejar lo que está y lo que NO está implementado. Próximo developer que lea no se confunde.

### 2.2. Non-goals (D2a.2.3 — diferidos)

- **Cache persistente de idempotency.** Sigue en memoria por task. D3 introduce DB.
- **Time-travel UI.** Replay es por API. D3 introduce UI.
- **Schema migration auto-generada.** Un humano escribe el migrador y lo registra. No se genera automáticamente del diff.
- **Circuit breaker policy real.** `NoopCircuitBreaker` por default. D2b provee el real.
- **Replay con cambio de modelo en runtime.** Replay re-ejecuta el MISMO workflow. Si querés cambiar el modelo, editás el workflow y creás una task nueva. Replay con override de modelo por nodo es D3+.
- **Snapshot storage externo.** Los snapshots viven en `NodeResult` (in-memory en D2a, DB en D3). No hay S3 hasta que duela.
- **Garbage collection de tasks "huérfanas" en `running` por crash.** El sweeper que el DSL spec §7 menciona es D3+.

---

## 3. Decisión arquitectónica: ¿dónde vive el circuit breaker?

Esta es la decisión que zanja este spec. Hay dos visiones en el repo:

- **Roadmap §6.1**: "Circuit breaker por agente/specialist. Si un specialist falla N veces consecutivas (config: N=3 por defecto), se le retira del pool temporalmente y los workflows que lo requerían se reasignan o escalan."
- **Spec 2a.2.2 §2.2**: "Circuit breaker por nodo. Si un nodo falla N veces seguidas, no se le retira del pool. Eso vive en el **multi-model router** de D2b, no acá."

**Decisión (propuesta — pedir OK al usuario antes de codear)**:

El **motor** provee la **interfaz y la instrumentación**. La **política** vive en otro lado.

- **Motor (D2a.2.3)**:
  - Define `interface CircuitBreaker { recordSuccess(specialistId): void; recordFailure(specialistId): void; isOpen(specialistId): boolean }`.
  - Implementación por default: `NoopCircuitBreaker` (siempre cerrado, nunca afecta).
  - El `node-runner` y el `executor` reportan éxito/fallo al `CircuitBreaker` cuando tienen un specialistId (en D2a, los nodos LLM pueden tener un `modelUsed` que se usa como specialistId).
  - Antes de ejecutar un nodo LLM, el executor consulta `isOpen(model)`; si está abierto, el nodo retorna `failure: { code: "MODEL_UNAVAILABLE", retriable: true }` sin invocar al LLM.

- **Multi-model router (D2b)**:
  - Implementa `CircuitBreaker` real: cuenta fallos consecutivos en una ventana de tiempo, abre el circuito si llega al umbral, lo cierra tras cool-down.
  - Política configurable (defaults razonables, ajustables por tenant en D3).
  - Inyecta su implementación al `ExecutorConfig` del motor.

**Por qué esta separación**:
- El motor no debe hardcodear política de fallos. Distinto tenant podría querer políticas distintas (algunos más tolerantes, otros más estrictos).
- El motor no sabe qué es "un specialist" más allá de un `modelUsed` string. La política depende del multi-model routing, que es lo que D2b introduce.
- Testeable: el motor se testea con `NoopCircuitBreaker`; el multi-model router se testea con un mock de la interfaz.

**Trade-off explícito**: si D2a.2.3 entra antes que D2b, el motor tiene la interfaz pero no la usa para nada útil. Está bien — es infraestructura, no feature. Cuando D2b llegue, enchufa su implementación y el motor ya está listo.

**¿OK con esta decisión?** Si preferís que el motor tenga la policy hardcodeada (3 fallos, 60s, etc.), también es defendible — más simple, menos capas. Pero pierde flexibilidad multi-tenant. Pedir OK antes de codear.

---

## 4. State schema validation (cierra el gap de D2a.2.2)

### 4.1. Por qué importa

El DSL spec §1.1 dice: "Workflows como data, no como código. Un workflow es un objeto JSON/YAML que vive en DB. Se modifica sin redeploy." Y §3 define `stateSchema: JSONSchema` que el motor DEBE validar.

Si el state se escribe sin validar, un output mal formado (LLM que devuelve `null` cuando el schema dice `object`, function que tira `undefined` en un campo requerido) corrompe el state en silencio. Los nodos downstream leen `undefined` donde esperaban un objeto, fallan con errores crípticos, y el debug es pesadilla.

### 4.2. Cuándo se valida

Tres momentos:

1. **`startTask(workflow, input)`**: el `input` se valida contra `stateSchema`. Si no valida, `startTask` tira `ExecutorError` con código `SCHEMA_VIOLATION` y la lista de errores del schema. La task NO se crea.
2. **Después de cada output de nodo (success)**: el state actualizado se valida contra `stateSchema`. Si no valida, el `NodeResult` se persiste con `status: "failed"`, `code: "SCHEMA_VIOLATION"`, y la task falla con `onError: "fail"` (default). El nodo queda marcado como el origen del schema violation.
3. **NO se valida durante el run del nodo**: el nodo lee/escribe state mutable, validar en cada read/write sería prohibitivamente caro. Solo al cierre del nodo.

### 4.3. Schema "parcial" durante la ejecución

El `stateSchema` describe el state FINAL, no el state intermedio. Por ejemplo, un workflow `classify → extract` puede tener un state donde `extractedClauses` no existe hasta que `extract` corre. El motor no debe quejarse de que `extractedClauses` falta después de ejecutar `classify`.

**Solución**: el `stateSchema` se interpreta como "el state final debe cumplir esto, pero los campos opcionales pueden no existir durante el run intermedio". El schema se aplica como **conformance check** (el state final tiene los campos requeridos, los tipos son correctos), no como **invariante intermedio**.

**Concretamente**: usamos JSON Schema draft-07. Si un campo no está en `required`, puede faltar. Si está en `required`, debe existir al final del nodo. Los tipos se validan siempre que el campo exista.

### 4.4. Implementación

```typescript
// En executor.ts, después de writeOutputToState:
const validation = validateStateAgainstSchema(state, workflow.stateSchema);
if (!validation.valid) {
  this.recordNodeResult(
    task,
    node,
    this.makeFailedResult(node.id, {
      code: "SCHEMA_VIOLATION",
      message: `Output del nodo "${node.id}" dejó el state inválido: ${validation.error}`,
      retriable: false,
      retryCount: outcome.retryCount,
    }, "failed"),
  );
  this.failTask(task, {
    code: "SCHEMA_VIOLATION",
    message: `State inválido después de "${node.id}": ${validation.error}`,
    failedNode: node.id,
  });
  return;
}
```

`validateStateAgainstSchema` usa la misma instancia de ajv ya compilada en el DSL (singleton). Costo: ~1ms por validación, despreciable.

### 4.5. Edge cases

- **State vacío `{}` después del primer nodo**: válido solo si `stateSchema` lo permite (todos los campos son opcionales). Si `stateSchema` requiere `extractedClauses: string`, falla con `SCHEMA_VIOLATION` después del primer nodo. El workflow autor debe ajustar el schema o el nodo debe escribir el campo.
- **Output `undefined` del nodo**: la convención actual es que `output.to` con `path: "foo"` escribe `undefined` al path. JSON Schema rechaza `undefined` en campos no-nullable. Esto falla con `SCHEMA_VIOLATION` después del nodo. El workflow autor debe usar `path: "foo?"` (campo opcional) o el nodo debe escribir un valor concreto.
- **Output que es `null` cuando schema dice `string`**: falla con `SCHEMA_VIOLATION`. Esperado.
- **Output que es un objeto con campos extra**: por default JSON Schema permite campos extra. Si el schema tiene `additionalProperties: false`, falla. La decisión queda al workflow autor.

#### 4.5.1. Precisiones al comportamiento de validación

- **Acoplamiento con `ajv`**: el motor usa `ajv` (draft-07) para validar. El comportamiento documentado arriba es específico a `ajv`. No es portable a otros validadores sin cambio explícito. Si en el futuro se cambia de validador, este spec se actualiza.
- **`null` vs tipo declarado**: en JSON Schema, `null` tiene su propio `type`. Si el schema dice `{ type: "string" }` y el output es `null`, falla con `SCHEMA_VIOLATION`. Si el schema dice `{ type: ["string", "null"] }`, pasa. El output respeta los tipos JSON Schema estándar.
- **Template fallido en `output.to`**: si el template es `"{{result.summary}}"` y `result.summary` no existe, la interpolación retorna `undefined`. El motor no distingue entre "el output no tiene el campo" y "el template apunta a un campo que no existe" — ambos se manifiestan como `SCHEMA_VIOLATION` después del nodo. Si se quiere mejor diagnóstico, en D3+ se agrega `validationContext: { attemptedPath, actualValue }` al `NodeError`.
- **Por qué no hay opt-out por nodo**: hoy el DSL no permite nodos sin `output` (todos los tipos de nodo — `function`, `llm`, `hitl` — tienen `output: NodeOutput` obligatorio). Un nodo que no escribe al state no es expresable. Por lo tanto, un flag `skipStateValidation` no tendría caso de uso real. Si alguien necesita "no validar", la solución correcta es ajustar el `stateSchema` (declarar el campo como opcional o quitarlo del schema).

### 4.6. Tests (~6 tests)

- `state validation: input inicial cumple schema → task created`
- `state validation: input inicial NO cumple schema → ExecutorError SCHEMA_VIOLATION, task NOT created`
- `state validation: output de nodo deja state válido → task continúa`
- `state validation: output de nodo deja state inválido (campo requerido faltante) → task FAILED con SCHEMA_VIOLATION, NodeResult registrado`
- `state validation: output de nodo deja state inválido (tipo incorrecto) → task FAILED con SCHEMA_VIOLATION`
- `state validation: state intermedio puede no tener campos que solo se llenan después → no falla durante run, solo al final`

---

## 5. Prompt snapshot persistence (gap menor)

### 5.1. El gap

DSL spec §3 define:
```typescript
interface NodeResult {
  // ...
  /** Para LLM nodes: snapshot del prompt enviado (system + user + tools). */
  promptSnapshot?: PromptSnapshot;
  // ...
}

interface PromptSnapshot {
  system?: string;
  user?: string;
  tools?: string[];
}
```

El `node-runner.ts::runLLMNode` interpola `systemPrompt` y `userPrompt` (líneas 160-165) y los pasa al `llmInvoker`. Pero `success()` (línea 398-409) NO guarda los prompts interpolados en el outcome. El `executor.ts::makeSuccessResult` (líneas 695-712) NO recibe promptSnapshot.

**Consecuencia**: el `NodeResult` no tiene el prompt real que se envió al LLM. Si el usuario quiere auditar "qué le dijimos al modelo", no puede.

### 5.2. Implementación

Tres cambios chicos:

1. **`node-runner.ts::runLLMNode`**: después de interpolar, guardar los prompts en una variable local.
2. **`SuccessInput` interface (línea 387-396)**: agregar `promptSnapshot?: PromptSnapshot`.
3. **`success()` y `failure()` (líneas 398-428)**: pasar `promptSnapshot` al outcome.

Después, en el executor, `makeSuccessResult` recibe el outcome (que ahora tiene `promptSnapshot`) y lo guarda en el `NodeResult`.

```typescript
// node-runner.ts: en runLLMNode, después de invocar llmInvoker
const promptSnapshot: PromptSnapshot = {
  system: systemPrompt,
  user: userPrompt,
  tools: node.tools ? [...node.tools] : undefined,
};

// Pasarlo a success():
return success({
  output: result.output,
  // ...
  promptSnapshot,
  retryCount: 0,
  startedAt,
});
```

**Nota sobre interpolación con field undefined**: si el template referencia `{{state.X}}` y `X` no existe en el state, el interpolador retorna `""` (string vacío), no `undefined` ni error (definido en `state.ts::interpolate`, líneas 99-108). El `promptSnapshot` refleja exactamente lo que el LLM vio, incluyendo los strings vacíos. Esto es **explícitamente** lo que la auditoría necesita: si el log dice "el LLM收到了 el prompt X", el snapshot debe mostrar X literal, no X-resuelto-de-otra-forma. Si el interpolador cambia su comportamiento (ej: en D3+ decide tirar error en vez de fallar a string vacío), el snapshot cambia con él y la auditoría sigue siendo coherente.

### 5.3. Tests (~2 tests)

- `prompt snapshot: nodo LLM persiste system + user + tools en NodeResult.promptSnapshot`
- `prompt snapshot: nodo function NO tiene promptSnapshot (solo LLM)`
- `prompt snapshot: interpolación con field undefined en state → snapshot guarda string vacío (refleja lo que el LLM vio)`

### 5.3. Tests (~2 tests)

- `prompt snapshot: nodo LLM persiste system + user + tools en NodeResult.promptSnapshot`
- `prompt snapshot: nodo function NO tiene promptSnapshot (solo LLM)`

---

## 6. Time travel / replay (DSL spec §6.5 → implementación)

### 6.1. Lo que el DSL spec ya define

DSL spec §6.5 establece el contrato:
- `Task.replayOf: string` — referencia a la task original.
- `Task.replayInput: Record<string, unknown>` — qué se modificó en el replay.
- `Task.replayFromNode: string` — desde qué nodo arranca el replay.
- El replay es **clon de task**, no branch in-place. La original queda intacta.

Lo que falta es la API y la lógica de re-ejecución.

### 6.2. API

```typescript
interface ReplayOptions {
  /** Input nuevo (opcional). Si se omite, usa el input original. */
  input?: unknown;
  /** Nodo desde el cual re-ejecutar (opcional, default: entryNode). */
  fromNode?: string;
  /** Si se omite, el replay arranca desde el principio con el state reseteado al snapshot del fromNode. */
  resetStateToSnapshot?: boolean;
}

class WorkflowExecutor {
  // ...
  /**
   * Crea una NUEVA task que es un replay de `originalTaskId`. La original queda intacta.
   * El replay empieza desde `fromNode` (o entryNode) con el state reseteado al snapshot de ese nodo.
   *
   * Si la task original no terminó (sigue 'running', 'paused_hitl', 'pending'), no se puede hacer replay.
   * Solo tasks en estado terminal (completed, failed, cancelled) son replayables.
   */
  replayTask(originalTaskId: string, options?: ReplayOptions): Task;
}
```

### 6.3. Implementación

```typescript
replayTask(originalTaskId: string, options: ReplayOptions = {}): Task {
  const original = this.requireTask(originalTaskId);
  
  // Solo tasks terminales son replayables.
  if (original.status !== "completed" && original.status !== "failed" && original.status !== "cancelled") {
    throw new ExecutorError(
      `Task ${originalTaskId} no está en estado terminal (status=${original.status}). Solo se puede hacer replay de tasks completadas, fallidas o canceladas.`,
      "INVALID_TASK_STATE",
      { taskId: originalTaskId, status: original.status },
    );
  }
  
  const workflow = this.getWorkflow(original);
  const fromNode = options.fromNode ?? workflow.entryNode;
  
  // Validar que fromNode existe y que la original tiene snapshot.
  const fromNodeResult = original.nodeResults[fromNode];
  if (!fromNodeResult) {
    throw new ExecutorError(
      `No hay snapshot del nodo "${fromNode}" en la task original. El nodo nunca se ejecutó.`,
      "NODE_NOT_FOUND",
      { taskId: originalTaskId, nodeId: fromNode },
    );
  }
  
  // Crear la nueva task con replayOf apuntando a la original.
  const newTaskId = this.config.taskIdGenerator
    ? this.config.taskIdGenerator()
    : randomUUID();
  
  const newInput = options.input ?? original.input;
  
  // Validar el input contra stateSchema (consistencia con startTask).
  const stateSchema = workflow.stateSchema;
  if (stateSchema) {
    const validation = validateStateAgainstSchema({ input: newInput }, stateSchema);
    if (!validation.valid) {
      throw new ExecutorError(
        `Input del replay no cumple stateSchema del workflow "${workflow.id}": ${validation.error}`,
        "SCHEMA_VIOLATION",
        { workflowId: workflow.id, replayOf: original.taskId, errors: validation.error },
      );
    }
  }
  
  const replay: Task = {
    taskId: newTaskId,
    workflowId: original.workflowId,
    // Usamos la workflowVersion ACTUAL del workflow, no la de la original.
    // Razón: si el workflow fue editado entre la original y el replay, el audit
    // debe registrar qué versión corrió, no qué versión estaba en el archivo de
    // la original. Esto habilita comparar "qué cambió entre la 1.0.0 y la 1.1.0"
    // vía la diferencia de audit logs.
    workflowVersion: workflow.workflowVersion,
    state: { input: newInput },  // state reseteado al input
    status: "pending",
    currentNode: fromNode,        // arranca desde el nodo pedido
    nodeResults: {},              // vacío — los snapshots vendrán de la ejecución nueva
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tenantId: original.tenantId,  // heredado de la original (multi-tenant D3 se basa en esto)
    input: newInput,
    replayOf: original.taskId,    // ← link a la original
    replayInput: options.input !== undefined ? { input: options.input } : undefined,
    replayFromNode: fromNode,
  };
  
  this.tasks.set(newTaskId, replay);
  this.taskWorkflows.set(newTaskId, workflow);
  // CRÍTICO: cache de idempotency NUEVO y vacío. NO se comparte con la original.
  // Si se compartiera, un retry en el replay podría devolver un output que corresponde
  // a la original con un state distinto — bug silencioso.
  this.idempotencyCaches.set(newTaskId, new Map());
  this.log?.info(`task replay created`, { 
    newTaskId, 
    originalTaskId, 
    fromNode, 
  });
  
  return replay;
}
```

### 6.4. State reset al snapshot — el detalle fino

El replay tiene dos modos:

- **Reset total** (`resetStateToSnapshot: true`, default): el state arranca como `{ input: newInput }` y se llena a medida que los nodos se ejecutan. Los nodos que ya se ejecutaron en la original SE RE-EJECUTAN (porque no hay nada en `nodeResults` del replay). Esto es lo más común.
- **Reset parcial** (`resetStateToSnapshot: false`): se copian los `nodeResults` de la original para los nodos anteriores a `fromNode`, y el state se reconstruye desde esos outputs. Útil para "re-ejecutar solo este nodo" sin perder el trabajo previo.

**Decisión (propuesta)**: D2a.2.3 implementa solo **reset total**. Reset parcial es D3+ (necesita un mecanismo de "replay del state" que se confunde con el run normal, complejidad no justificada en D2a).

**Acción derivada sobre `AGENT_WORKFLOW_DSL_SPEC.md` §6.5**: la frase actual del DSL spec dice "con el state reseteado al snapshot correspondiente", que es ambigua entre reset total, reset al state del fromNode, y reset parcial. Se edita para que diga literal "con state inicializado a `{ input: newInput }`" — coincide con la implementación de este spec. Sin esta precisión, en D3 cuando se revise el código se va a leer "reseteado al snapshot" y no se va a entender qué se quiso decir.

### 6.5. Edge cases

- **Replay de una task que nunca ejecutó el fromNode**: falla con `NODE_NOT_FOUND` antes de crear la task.
- **Replay concurrente de la misma original**: permitido. Cada replay es una task distinta. La original no se modifica.
- **Replay durante el run de la original**: permitido. El replay es una task nueva, no comparte estado con la original.
- **Replay de un replay**: permitido. `replayOf` se sobreescribe con la última original referenciada. Si querés la cadena completa, mirás `replayOf` recursivamente (fuera del motor, en la UI).
- **Replay con cambio de modelo en el workflow**: el replay usa el workflow actual. Si el workflow fue editado entre la original y el replay, el replay usa la versión nueva. Esto es **explícitamente** lo que el DSL spec §6.5 dice: "Re-ejecutar un workflow con un modelo distinto (cambiar `model: 'liviano'` → `'robusto'`) para comparar resultados."
- **Replay con input inválido contra stateSchema**: falla con `ExecutorError SCHEMA_VIOLATION` antes de crear la task. Mismo check que `startTask` (consistencia).
- **Replay con workflow removido del catálogo entre original y replay**: si el workflow de la original ya no está disponible (eliminado del catálogo), `getWorkflow(original)` tira `ExecutorError` con código `WORKFLOW_NOT_FOUND`. El usuario puede crear un nuevo workflow con el mismo id antes de reintentar. Es un edge case real en multi-tenant (firma desactiva workflow, tasks viejas se quedan sin poder hacer replay).
- **Replay con `cleanup()` de la original**: `cleanup()` libera el cache de idempotency de la original pero NO remueve la task del map interno. Replay sigue funcionando mientras la task no haya sido `cleanup()`eada. Documentado en §9.3.
- **Replay NO comparte cache de idempotency con la original**: cada replay tiene su propio `Map<string, NodeExecutionSuccess>` vacío. Si compartiera, un retry en el replay podría devolver un output cacheado de la original con un state distinto — bug silencioso.
- **Re-entrada post-crash (workaround manual)**: en D2a no hay sweeper que detecte tasks en `running` con `updatedAt` viejo. Si el motor crashea a mitad de una task, la task queda en estado inconsistente. Workaround: el usuario llama a `replayTask(taskId, { fromNode: task.currentNode })` para crear una nueva task desde el nodo donde se crasheó. Feo pero honesto. El sweeper automático es D3+.

### 6.6. Tests (~9 tests)

- `replay: replay de task completed → nueva task creada con replayOf apuntando a la original`
- `replay: replay de task running → ExecutorError INVALID_TASK_STATE`
- `replay: fromNode no ejecutado en la original → ExecutorError NODE_NOT_FOUND`
- `replay: input opcional reemplaza al original; sin input, usa el original`
- `replay: la task original queda intacta (status, nodeResults, error no se modifican)`
- `replay: input inválido contra stateSchema → ExecutorError SCHEMA_VIOLATION, replay no se crea`
- `replay: el cache de idempotency de la original NO se comparte con el replay (cada uno tiene su Map)`
- `replay: replay hereda tenantId de la original (no se reasigna)`
- `replay: workflowVersion del replay es la del workflow actual, no la de la original`
- `replay: workflow removido del catálogo → ExecutorError WORKFLOW_NOT_FOUND`

---

## 7. Schema versioning con migrator (DSL spec §6.6 → implementación)

### 7.1. El gap

DSL spec §6.6 define el contrato y el catálogo de migradores:
- `schemaVersion: 1` en cada workflow.
- Al cargar, comparar con la versión del motor.
- Si es menor, buscar `migrators[from][to]`. Si no existe, error.
- Si es mayor, rechazar con `SCHEMA_VERSION_UNSUPPORTED`.
- Migradores son funciones puras: `(workflow: WorkflowDefinition) => WorkflowDefinition`.

**Lo que falta en código**: el catálogo de migradores, la lógica de carga, y el rechazo con código claro.

### 7.2. API

```typescript
// Nuevo módulo: src/agent/workflow-engine/migrations.ts

import type { WorkflowDefinition } from "./dsl/types.js";

/** Versión del spec del DSL que el motor actual soporta. */
export const CURRENT_SCHEMA_VERSION = 1 as const;

/**
 * Un migrador transforma un workflow de un schemaVersion a otro. Es una función
 * pura: no toca DB, no hace I/O. Solo adapta la shape.
 */
export type Migrator = (workflow: WorkflowDefinition) => WorkflowDefinition;

/**
 * Registro de migradores. Key: `${fromVersion}->${toVersion}`.
 * Ej: "1->2" para migrar de spec v1 a v2.
 *
 * NO es un global mutable: se inyecta al ExecutorConfig por DI (ver §7.4).
 * Cada Executor tiene su propio Map. Esto evita que un test que registra un
 * migrador contamine a otros tests.
 */
export type MigratorRegistry = Map<string, Migrator>;

/**
 * Carga un workflow aplicando migradores del registry si es necesario.
 * - Si el schemaVersion coincide con la versión objetivo, retorna el workflow tal cual.
 * - Si es menor, busca migradores en cadena. Ej: 1→2→3 si los hay.
 * - Si es mayor, tira ExecutorError con SCHEMA_VERSION_UNSUPPORTED.
 * - Si falta un migrador intermedio, tira error claro.
 *
 * El registry se pasa explícitamente (no se importa de un global). El target
 * version también se pasa, no se hardcodea.
 */
export function loadWorkflow(
  workflow: WorkflowDefinition,
  registry: MigratorRegistry,
  targetVersion: number,
): WorkflowDefinition;
```

**Decisión clave: DI del registry, no global mutable**. Razón: si el registry fuera un `Map` global a nivel de módulo, un test que registra un migrador contaminaría a todos los tests siguientes. Con DI, cada `Executor` tiene su propio registry. Mismo patrón que el `CircuitBreaker` (§8): el motor no tiene estado global, todo se inyecta.

**Integración con `ExecutorConfig`**:

```typescript
interface ExecutorConfig {
  // ... lo que ya tiene ...
  
  /**
   * Registry de migradores de schema. Default: Map vacío.
   * Si un workflow tiene schemaVersion < motor's CURRENT_SCHEMA_VERSION y no hay
   * migrador en este registry, falla al ejecutar con SCHEMA_VERSION_UNSUPPORTED.
   */
  readonly migrators?: MigratorRegistry;
  
  /**
   * Versión del spec del DSL que este motor ejecuta. Default: 1 (constante del módulo).
   * Inyectable para tests que simulan motores viejos.
   */
  readonly schemaVersion?: number;
}
```

### 7.3. Implementación

```typescript
// src/agent/workflow-engine/migrations.ts

import { ExecutorError } from "./executor/errors.js";
import type { WorkflowDefinition } from "./dsl/types.js";

export const CURRENT_SCHEMA_VERSION = 1 as const;

export type Migrator = (workflow: WorkflowDefinition) => WorkflowDefinition;
export type MigratorRegistry = Map<string, Migrator>;

export function loadWorkflow(
  workflow: WorkflowDefinition,
  registry: MigratorRegistry,
  targetVersion: number = CURRENT_SCHEMA_VERSION,
): WorkflowDefinition {
  if (workflow.schemaVersion === targetVersion) {
    return workflow;  // No migration needed.
  }
  
  if (workflow.schemaVersion > targetVersion) {
    throw new ExecutorError(
      `Workflow "${workflow.id}" v${workflow.workflowVersion} escrito contra schema v${workflow.schemaVersion}, pero el motor solo soporta hasta v${targetVersion}. Actualizá el motor o reescribí el workflow.`,
      "SCHEMA_VERSION_UNSUPPORTED",
      { workflowId: workflow.id, workflowSchemaVersion: workflow.schemaVersion, motorSchemaVersion: targetVersion },
    );
  }
  
  // workflow.schemaVersion < targetVersion. Aplicar migradores en cadena.
  let current: WorkflowDefinition = workflow;
  let currentVersion = current.schemaVersion;
  
  while (currentVersion < targetVersion) {
    const key = `${currentVersion}->${currentVersion + 1}`;
    const migrator = registry.get(key);
    if (!migrator) {
      throw new ExecutorError(
        `No hay migrador de schema v${currentVersion} a v${currentVersion + 1} para workflows. Workflow "${workflow.id}" v${workflow.workflowVersion} no se puede cargar.`,
        "SCHEMA_VERSION_UNSUPPORTED",
        { workflowId: workflow.id, missingMigration: key },
      );
    }
    current = migrator(current);
    currentVersion = current.schemaVersion;
  }
  
  return current;
}
```

**Atomicidad de los migradores**: los migradores son funciones puras `(WorkflowDefinition) => WorkflowDefinition`. Si uno tira (por edge case en el JSON, por un input malformado), no se aplica nada — la función pura no completó y no hay estado intermedio que persistir. La atomicidad es por construcción, no requiere transacción explícita. Si en el futuro los migradores se vuelven impuros (ej: registran en un log), se agrega un wrapper transaccional. Hoy no hace falta.

### 7.4. Integración con el executor: **migración LAZY al ejecutar**

**Decisión zanjada (revisión v1.1)**: la migración se aplica al ejecutar la task, NO al parsear el workflow.

**Razón** (específica de Worgena, no genérica): en un vertical para legal colombiano, el audit log es el activo más importante. Si el workflow dice `workflowVersion: "1.0.0"`, el log debe poder reconstruir exactamente qué código corrió bajo esa versión. Con migración eager (al parsear), la workflow v1.0.0 persistida en DB se reescribe a v2 silenciosamente, y la task original dice "corrí v1.0.0" cuando en realidad corrió código v2. Eso es mentira en el log, y en un juicio de "por qué la IA firmó este contrato mal" es desastroso.

Con migración lazy, el workflow persistido en DB mantiene su `schemaVersion` original. Al ejecutar, el motor aplica los migradores al vuelo. La task guarda:
- `workflowVersion: "1.0.0"` (la declarada en el workflow persistido).
- `migratedWorkflow: WorkflowDefinition` (snapshot del workflow YA migrado, para que el replay no re-aplique migradores).
- `appliedMigrations: string[]` (qué migraciones se aplicaron, para audit). Ej: `["1->2"]`.

**Flujo concreto**:

1. **Persistencia** (en D3, hoy no aplica): cuando se guarda un workflow en DB, se guarda tal cual con su `schemaVersion` original. NO se migra al guardar.
2. **Parseo** (`parseWorkflow` en `dsl/parser.ts`): solo parsea shape. **NO** llama a `loadWorkflow`. La shape se valida con un JSON Schema que acepta cualquier `schemaVersion` (no estricto, parsea cualquier valor numérico).
3. **Validación** (`validateWorkflow` en `dsl/schema.ts`): solo valida estructura y cross-validation. **NO** llama a `loadWorkflow`. El workflow puede tener una `schemaVersion` que el motor actual no soporte, pero la validación de shape pasa.
4. **Ejecución** (en el `WorkflowExecutor`, al cargar el workflow para una task): llama a `loadWorkflow(workflow, this.config.migrators, this.config.schemaVersion)`. Si la versión del workflow es la del motor, no se aplica nada. Si es menor, se aplican los migradores en cadena. El resultado se guarda en `task.migratedWorkflow`.
5. **Replay** (D2a.2.3 §6): el replay usa `task.migratedWorkflow` si existe (la versión ya migrada que corrió la original). NO vuelve a aplicar migradores. Esto garantiza que el replay es **determinista** respecto al código que corrió la original: si el migrador cambió entre la original y el replay, el replay no se ve afectado porque usa el resultado de la migración ORIGINAL.

**Por qué no eager** (mi argumento original, que el peer M3 corrigió): yo argumentaba "migración eager mantiene la DB simple, no se pre-optimiza". Válido para un motor genérico. Inválido para Worgena. El peer M3 identificó que con eager + replayTask, el audit log se vuelve incoherente: la task dice `workflowVersion: "1.0.0"` pero corrió código v2. La coherencia del audit es el fundamento, no la simplicidad de la DB.

**Costo de lazy vs eager**: 30 min extra de implementación (campo `migratedWorkflow` en `Task`, `appliedMigrations: string[]` en el audit). Vale la pena para Worgena. Para un motor genérico no-legal, eager sería defendible; acá no.

**Implementación del campo nuevo en `Task`**:

```typescript
// En dsl/types.ts, agregar a la interface Task:
interface Task {
  // ... lo que ya tiene ...
  
  /**
   * Snapshot del workflow DESPUÉS de aplicar las migraciones. Lo que realmente
   * se ejecutó. Se llena en el primer startTask y se persiste con la task.
   * El replay usa este campo, no vuelve a aplicar migradores.
   * Si el workflow ya estaba en la versión del motor, este campo es undefined
   * (no hubo migración).
   */
  migratedWorkflow?: WorkflowDefinition;
  
  /**
   * Lista de migraciones aplicadas al ejecutar esta task. Para audit legal.
   * Ej: ["1->2", "2->3"].
   * Vacío si no hubo migración.
   */
  appliedMigrations?: readonly string[];
}
```

**Cambio en `parseWorkflow`**: ya no llama a `loadWorkflow`. La shape se valida sin importar la versión. Si el usuario carga un workflow con `schemaVersion: 99` y el motor es v1, el parseo pasa (es un JSON válido), pero la ejecución falla con `SCHEMA_VERSION_UNSUPPORTED` cuando el executor intente cargarlo.

**Cambio en `validateWorkflow`**: igual. La validación de estructura no se mete con la versión.

**Acción derivada sobre el DSL spec** (`AGENT_WORKFLOW_DSL_SPEC.md` §6.5): la frase actual dice "con el state reseteado al snapshot correspondiente", que es ambigua. Se edita para clarificar "state = { input: newInput }" (consistente con la implementación de este spec §6.4). Sin esto, en D3 el código se va a leer y no se va a entender qué se quiso decir.

### 7.5. Tests (~6 tests)

- `schema version: workflow con schemaVersion = target → loadWorkflow retorna tal cual`
- `schema version: workflow con schemaVersion > target → ExecutorError SCHEMA_VERSION_UNSUPPORTED`
- `schema version: workflow con schemaVersion < target y migrador registrado → retorna workflow migrado`
- `schema version: workflow con schemaVersion < target y migrador FALTANTE → ExecutorError con mensaje claro sobre qué migración falta`
- `schema version: cadena de migradores 1→2→3, motor en v3, ambos migradores registrados → aplica los 2 en secuencia`
- `schema version: migrador que tira a mitad de ejecución → ExecutorError, workflow NO queda con shape parcial (atomicidad de función pura)`

### 7.4. Integración con `parseWorkflow` y `validateWorkflow`

`parseWorkflow` (en `dsl/parser.ts`) llama a `loadWorkflow` después de parsear. Si la versión es incompatible, falla con el error claro. `validateWorkflow` (en `dsl/schema.ts`) queda igual — opera sobre la shape después de migrar.

### 7.5. Tests (~4 tests)

- `schema version: workflow con schemaVersion = CURRENT → loadWorkflow retorna tal cual`
- `schema version: workflow con schemaVersion > CURRENT → ExecutorError SCHEMA_VERSION_UNSUPPORTED`
- `schema version: workflow con schemaVersion < CURRENT y migrador registrado → retorna workflow migrado`
- `schema version: workflow con schemaVersion < CURRENT y migrador FALTANTE → ExecutorError con mensaje claro sobre qué migración falta`

### 7.6. ¿Cuándo se escribe el primer migrador?

Cuando salga el spec v2 (futuro, sin fecha). Hoy no hay v2, no hay migradores, el catálogo está vacío. D2a.2.3 implementa la **infraestructura** (registro, lógica de carga, rechazo). El primer migrador se escribe cuando haya v2 que valga la pena.

---

## 8. Circuit breaker — interfaz (la decisión de §3)

### 8.1. La interfaz

```typescript
// src/agent/workflow-engine/executor/circuit-breaker.ts

/**
 * El circuit breaker decide si una "specialist" (modelo, herramienta, approver)
 * debe ser invocada o no, basándose en su historial reciente de fallos.
 *
 * El motor NO implementa la policy (cuándo abrir, cuánto tiempo, etc.).
 * Solo expone la interfaz y un default no-op. La policy real es inyectada
 * por el caller (en D2a: NoopCircuitBreaker; en D2b: implementación real).
 */
export interface CircuitBreaker {
  /** Registra un éxito del specialist. Resetea contadores. */
  recordSuccess(specialistId: string): void;
  
  /** Registra un fallo del specialist. Incrementa contadores. */
  recordFailure(specialistId: string): void;
  
  /** ¿El circuito está abierto para este specialist? Si true, no invocarlo. */
  isOpen(specialistId: string): boolean;
}

/** Default: nunca abre. Útil para tests y para D2a donde la policy es no-op. */
export class NoopCircuitBreaker implements CircuitBreaker {
  recordSuccess(_specialistId: string): void {}
  recordFailure(_specialistId: string): void {}
  isOpen(_specialistId: string): boolean { return false; }
}
```

**Nota sobre `specialistId` (revisión v1.1)**: en D2a, `specialistId` se mapea a `node.model` (que es `'liviano'`, `'robusto'`, o un nombre específico de modelo). En D2b, cuando el multi-model router introduzca specialists reales (ej: `clause_extractor_specialist_v1`, `intake_router_specialist`), `specialistId` se mapea al **ID del specialist**, que puede ser más granular que el modelo subyacente. Hoy se solapan (un specialist es esencialmente un modelo); mañana no necesariamente (un specialist podría enrutar entre varios modelos). El motor trata `specialistId` como string opaco, no asume que es un modelo. Esto es lo correcto.

### 8.2. Integración con el executor

```typescript
// En executor.ts, ExecutorConfig:
interface ExecutorConfig {
  // ... lo que ya tiene ...
  
  /**
   * Circuit breaker para specialists. Default: NoopCircuitBreaker.
   * En D2b se inyecta la implementación real.
   */
  readonly circuitBreaker?: CircuitBreaker;
}
```

```typescript
// En runLLMNode (node-runner.ts), antes de invocar:
const breaker = params.circuitBreaker ?? new NoopCircuitBreaker();
const specialistId = node.model;  // 'liviano' o 'robusto' o nombre específico

// CRÍTICO: el breaker se consulta antes de CADA attempt, no solo antes del primero.
// Si el breaker abre durante los retries (por fallos intermedios), el siguiente attempt
// también lo ve y falla rápido sin invocar al LLM. Si solo se consultara antes del
// primer attempt, los retries consumirían invocaciones innecesarias al modelo roto.
if (breaker.isOpen(specialistId)) {
  return failure({
    code: "MODEL_UNAVAILABLE",
    message: `Circuit breaker abierto para specialist "${specialistId}". Reintentá más tarde.`,
    retriable: true,
    startedAt: new Date().toISOString(),
  });
}

// Después de la invocación (en try o catch):
try {
  const result = await llmInvoker.invoke({ /* ... */ });
  breaker.recordSuccess(specialistId);
  return success({ /* ... */ });
} catch (e) {
  breaker.recordFailure(specialistId);
  // ... existing failure handling ...
}
```

**El check `isOpen` debe estar dentro del loop de retry en `executeWithTimeoutAndRetry`**, no solo al inicio del nodo. Si el breaker abre entre attempt 1 y attempt 2 (por fallos de otra task o por el threshold cruzado durante los reintentos de ESTA task), el attempt 2 también lo ve y falla con `MODEL_UNAVAILABLE` sin invocar al LLM. Esto evita consumir invocaciones a un modelo que el breaker ya marcó como caído.

### 8.3. Por qué solo LLM (no HITL, no function)

- **LLM**: el modelo puede fallar (rate limit, outage, context too long). El circuit breaker es natural.
- **HITL**: el approver es una persona. No tiene sentido un circuit breaker humano.
- **Function**: las funciones son código nuestro, deberían ser robustas. Si fallan, es bug. Mejorar la función, no añadir circuit breaker.

D2a.2.3 implementa circuit breaker solo para LLM. Si en el futuro hay specialists de otros tipos, se extiende la interfaz (no se rehace).

### 8.4. Tests (~3 tests)

- `circuit breaker: NoopCircuitBreaker (default) nunca abre → todas las invocaciones pasan`
- `circuit breaker: isOpen=true para un specialist → nodo retorna MODEL_UNAVAILABLE sin invocar LLM`
- `circuit breaker: recordSuccess después de un fallo resetea el contador (verificable con mock breaker)`

---

## 9. Limpieza de HITL paused (dead code)

### 9.1. El problema

`executor.ts:330-337`:
```typescript
// 3. Pause (HITL handler en v1 siempre resuelve; paused es por si en v2
//    un handler decide "necesito más tiempo" sin tirar timeout).
if (outcome.status === "paused") {
  this.failTask(task, {
    code: "HITL_TIMEOUT",
    message: `HITL node "${node.id}" pausó sin respuesta.`,
    failedNode: node.id,
  });
  return;
}
```

`node-runner.ts::runHITLNode` (líneas 305-340) NUNCA retorna `paused`. Siempre retorna `success` (si approved), `failure` con `HITL_DECLINED` (si declined), o `failure` con `HITL_TIMEOUT` (si timeout). El branch `paused` del executor es dead code.

**Decisión**: eliminar el branch. Si en el futuro el HITL handler quiere pausar de verdad, se reintroduce con la lógica apropiada (status='paused_hitl', persistir la pregunta, esperar resume). Pero no ahora.

### 9.2. Limpieza

- Eliminar el `if (outcome.status === "paused")` en `executor.ts`.
- Eliminar `NodeExecutionPaused` de `executor/types.ts` (nadie lo usa).
- Actualizar el comentario en `node-runner.ts:281-282` que dice "retorna el outcome (success/failure/paused)" → "retorna el outcome (success/failure)".

### 9.3. Tests (~2 tests, integración)

- `hitl: handler responde approved → outcome es success, no paused` (regression test del fix).
- `cleanup: cleanup libera el cache de idempotency pero la task sigue en el map (replay puede seguir usándola)` — ver nota sobre `cleanup()` y replay en §6.5.

**Nota sobre `cleanup()` y replay (revisión v1.1)**: hoy `cleanup(taskId)` en `executor.ts:251-259` elimina la task del map (`this.tasks.delete(taskId)`), libera el cache de idempotency, libera el workflow asociado, y libera el flag de cancelación. Esto significa que `cleanup()` + `replayTask(taskId)` no funciona — la task ya no existe en el map. Para que el replay funcione, `cleanup()` tiene que **liberar el cache de idempotency pero NO remover la task del map**. La task queda accesible para `replayTask()` hasta que se llame a otro cleanup explícito o el motor se reinicie. Cambio: el comportamiento actual de `cleanup` se divide en dos: `cleanup(taskId)` libera cache pero retiene la task; `purgeTask(taskId)` (nuevo método) elimina todo. Esto es backward-incompatible con el comportamiento actual — el cambio se documenta en el changelog del spec.

---

## 10. Actualización de comentarios

Después de implementar todo, los siguientes comentarios en el código deben reflejar el estado real (no el de v1). El próximo developer que lea el código no se debe confundir con referencias a specs viejos.

- `executor/index.ts:7-23`: actualizar la doc de "qué incluye D2a.2 v1". Específicamente, retry e idempotency YA están (vino en 2a.2.2). State validation, prompt snapshot, replay, schema versioning entran en 2a.2.3.
- `executor.ts:7-29`: mismo. Actualizar.
- `state.ts:102-104`: el comentario "El motor valida que el state final cumpla con el stateSchema del workflow (D2a.2.2)" debe pasar a "El motor valida que el state final cumpla con el stateSchema del workflow (D2a.2.3)" — y, una vez implementado, cambiar a "El motor valida..." sin la referencia al spec.
- `node-runner.ts:281-282`: comentario sobre HITL que dice "retorna el outcome (success/failure/paused)" → "retorna el outcome (success/failure)".
- `node-runner.ts:387-409`: el comentario sobre `SuccessInput` y `success()` debe mencionar `promptSnapshot` como campo nuevo.
- `types.ts` (interface `ExecutorConfig`): documentar los nuevos campos `circuitBreaker`, `migrators`, `schemaVersion`.
- `parser.ts`: comentario sobre `loadWorkflow` debe decir "se llama al ejecutar, no al parsear" (cambio de D2a.2.3 lazy migration).
- `migrations.ts` (nuevo módulo): documentación de cabecera sobre atomicidad de funciones puras y DI del registry.

Sin esta limpieza, el próximo developer que lea el código va a tener la misma confusión que tuve yo al armar este spec.

---

## 11. Resumen de cambios al código

| Archivo | Cambio |
|---|---|
| `executor/circuit-breaker.ts` (nuevo) | Interface `CircuitBreaker` + `NoopCircuitBreaker` default. |
| `executor/executor.ts` | State validation post-output. Input validation en `startTask`. Integración con `circuitBreaker` (check antes de cada attempt, no solo el primero). Limpieza de HITL paused branch. División de `cleanup()` (libera cache, retiene task) + nuevo `purgeTask()` (elimina todo). Método `replayTask()` con validación de input, herencia de tenantId, workflowVersion actual. Check de `loadWorkflow` al cargar la task. Actualización de comentarios. |
| `executor/node-runner.ts` | Pasaje de `promptSnapshot` al outcome (interpolado, con strings vacíos donde el path no existe). Reporte a `circuitBreaker` antes/después de cada invocación LLM. Limpieza de comentarios sobre `paused`. |
| `executor/types.ts` | Eliminar `NodeExecutionPaused`. Agregar `circuitBreaker`, `migrators`, `schemaVersion` a `ExecutorConfig`. |
| `executor/state.ts` | Validación de input y state (helper `validateStateAgainstSchema`). Actualización de comentarios (referencia a D2a.2.3, no 2a.2.2). |
| `executor/index.ts` | Barrel export con `circuit-breaker`, `migrations`, helpers de validación. Actualización de comentarios. |
| `migrations.ts` (nuevo) | Tipo `MigratorRegistry` (Map<string, Migrator>) inyectable. Función `loadWorkflow(workflow, registry, targetVersion)` con rechazo claro si versión mayor o falta migrador. Atomicidad por construcción (funciones puras). |
| `dsl/types.ts` | Agregar `Task.migratedWorkflow?: WorkflowDefinition` y `Task.appliedMigrations?: readonly string[]`. |
| `dsl/parser.ts` | **NO llama a `loadWorkflow`** (cambio de D2a.2.3 lazy migration). Solo parsea shape. Documentar en comentario. |
| `dsl/schema.ts` | Validación queda igual (estructura + cross-validation, no se mete con la versión). |
| `AGENT_WORKFLOW_DSL_SPEC.md` | Editar §6.5: "state reseteado al snapshot correspondiente" → "state inicializado a `{ input: newInput }`" (acción derivada). |
| `test_workflow_executor.mts` | +38 tests: 6 state validation, 3 prompt snapshot, 10 replay, 6 schema versioning, 4 circuit breaker, 2 HITL/cleanup, 7 varios (edge cases, regression). Ver breakdown abajo. |

**Desglose explícito de los 7 "varios"** (no son placeholders — son tests reales):

1. `state validation: stateSchema con propiedades anidadas y array → valida correctamente`
2. `state validation: confidenceGating + outputSchema en workflow cargado → cross-validation corre`
3. `prompt snapshot: confidence gating label se preserva en el outcome`
4. `replay: replay con replayOf encadenado (replay de un replay) → última referencia gana`
5. `replay: replay durante cleanup de la original → falla con TASK_NOT_FOUND después de cleanup (porque original ya no está)`
6. `schema version: workflow con schemaVersion no numérico (ej: "v1") → falla al parsear, no al ejecutar`
7. `circuit breaker: breaker.isOpen=true Y node retriable → reintenta el nodo (consulta isOpen antes de cada attempt, ve que sigue abierto, falla con MODEL_UNAVAILABLE, retry policy normal aplica)`

**Total estimado de tests**: 50 → 88 (+38).

---

## 12. Edge cases consolidados

| Escenario | Comportamiento |
|---|---|
| **Input inicial no cumple stateSchema** | `startTask` tira `ExecutorError SCHEMA_VIOLATION`. Task NO se crea. |
| **Output de nodo deja state inválido** | Nodo `failed: SCHEMA_VIOLATION`. Task `failed`. NodeResult registrado. |
| **Output de nodo es `undefined` en campo required** | Mismo que arriba. |
| **Output es `null` cuando schema dice `string`** | Falla con `SCHEMA_VIOLATION` (regla JSON Schema estándar). |
| **Output template apunta a path inexistente en state** | Falla con `SCHEMA_VIOLATION` (motor no distingue "output sin campo" vs "template mal"). |
| **Replay de task no terminal** | `ExecutorError INVALID_TASK_STATE`. Replay no se crea. |
| **Replay con fromNode no ejecutado en original** | `ExecutorError NODE_NOT_FOUND`. Replay no se crea. |
| **Replay con input inválido contra stateSchema** | `ExecutorError SCHEMA_VIOLATION`. Replay no se crea. |
| **Replay con workflow removido del catálogo** | `ExecutorError WORKFLOW_NOT_FOUND`. Replay no se crea. |
| **Replay con input opcional** | Si se pasa, se usa. Si no, se usa el input original. |
| **Replay de un replay** | Permitido. `replayOf` apunta al último. Cadena accesible recursivamente. |
| **Replay NO comparte cache de idempotency con la original** | Cada replay tiene su propio `Map<string, NodeExecutionSuccess>` vacío. |
| **Replay hereda tenantId de la original** | El replay usa `original.tenantId`, no se reasigna. |
| **Replay usa workflowVersion actual, no la de la original** | Para audit de "qué cambió entre 1.0.0 y 1.1.0". |
| **Workflow con schemaVersion > target** | `ExecutorError SCHEMA_VERSION_UNSUPPORTED`. Falla al ejecutar (no al parsear, por lazy migration). |
| **Workflow con schemaVersion < target y migrador falta** | `ExecutorError SCHEMA_VERSION_UNSUPPORTED` con mensaje específico sobre qué migración falta. |
| **Workflow con schemaVersion < target y migrador existe** | Migrador aplica al ejecutar. `task.migratedWorkflow` y `task.appliedMigrations` se llenan. |
| **Migrador tira a mitad de ejecución** | `ExecutorError`, workflow NO queda con shape parcial (atomicidad de función pura). |
| **Circuit breaker abierto para un modelo** | Nodo LLM retorna `failure: MODEL_UNAVAILABLE` sin invocar. El check corre antes de CADA attempt, no solo el primero. |
| **HITL handler responde approved** | Nodo `success` con output del approver. State actualizado. Loop continúa. |
| **HITL handler responde declined** | Nodo `failure: HITL_DECLINED`. `onError` aplica (default: fail). |
| **HITL handler responde timeout** | Nodo `failure: HITL_TIMEOUT`. `onError` aplica (default: fail). |
| **Nodo LLM persiste promptSnapshot** | `NodeResult.promptSnapshot = { system, user, tools }` con los textos interpolados (strings vacíos donde el path no existe). |
| **`cleanup(taskId)`** | Libera el cache de idempotency pero retiene la task en el map. La task sigue accesible para `replayTask()` y `getTask()`. |
| **`purgeTask(taskId)` (nuevo)** | Elimina la task del map, libera cache, libera workflow, libera flag de cancelación. Después de `purgeTask`, la task es irrecuperable. |
| **Motor crashea durante una task** | La task queda en `running` con `updatedAt` viejo. Workaround manual: `replayTask(taskId, { fromNode: task.currentNode })`. Sweeper automático es D3+. |

---

## 13. Open questions / action items

> Preguntas resueltas en v1.1 marcadas como `[✓ Resuelta]`. Action items derivados marcados como `[ ]`.

### Resueltas en v1.1 (con la revisión del peer M3)

- **[✓] Pregunta 1 — Circuit breaker**: A (interfaz en motor + `NoopCircuitBreaker` default, D2b enchufa la real). Resuelta por peer M3 revisión + ratificada por el usuario. Justificación: separación de capas (Capa 1 no sabe qué es un specialist), testabilidad, flexibilidad multi-tenant en D3.
- **[✓] Pregunta 2 — Replay reset**: A (reset total en D2a.2.3, reset parcial en D3+). Resuelta por peer M3.
- **[✓] Pregunta 3 — Migradores en código o DB**: A (código en D2a, DB si hace falta en D6+). Resuelta por peer M3.
- **[✓] Pregunta 4 — promptSnapshot con output crudo**: A (solo el prompt, el output ya está en `NodeResult.output`). Resuelta por peer M3. Ver action item de `rawOutput` futuro.
- **[✓] Pregunta 5 — State validation opt-out**: A (siempre validar, sin opt-out). Resuelta por peer M3 con el refuerzo de que el DSL no permite nodos sin output, por lo que el opt-out no tendría caso de uso real.

### Action items derivados (a resolver en futuras dimensiones)

- **[ ] D3: revisar si `CircuitBreaker.specialistId` necesita ser `{tenantId, model}` o se mantiene string**. Decisión antes de implementar multi-tenancy. Red de seguridad porque en multi-tenant, un tenant podría tener un modelo con el mismo nombre que otro y el breaker afectaría a ambos. Hasta D2a, single-tenant por workflow — el riesgo es latente pero no material.
- **[ ] D3: considerar abstraer `SchemaValidator` (interfaz sobre `ajv`) si aparece validación custom por tenant o por workflow**. El motor YA está acoplado a `ajv` en `dsl/schema.ts`. Abstraer requiere un PR que abarque las dos validaciones (shape + state) juntas, no una sola. Sin caso de uso concreto hoy, no se hace.
- **[ ] D3: implementar sweeper post-crash que detecte tasks en `running` con `updatedAt` viejo**. Workaround manual actual: `replayTask(taskId, { fromNode: task.currentNode })`.
- **[ ] D3: implementar reset parcial del replay** (copiar `nodeResults` de la original para nodos anteriores al `fromNode`, reconstruir el state desde esos outputs).
- **[ ] D3+ si duele: agregar `NodeResult.rawOutput?: string`** (texto crudo del LLM antes de parsear) para debug de parseo. Hoy solo guardamos el output parseado + el prompt. Si el JSON del LLM viene malformado, no hay forma de ver qué dijo realmente. ~5 líneas de código cuando se materialice el caso.
- **[ ] D3+ si duela: cache persistente de idempotency** (DB en lugar de in-memory). Hoy el cache se pierde si el motor crashea. D3 introduce DB.

### Resueltas en la revisión v1.1 que requirieron cambio de decisión

- **[✓] Migración lazy vs eager (Issue 10 del peer M3)**: opción (3) lazy al ejecutar. Cambio de voto por razón específica de Worgena (audit legal). El workflow persistido en DB mantiene su `schemaVersion` original; la task guarda `migratedWorkflow` y `appliedMigrations` para audit coherente. El replay usa `migratedWorkflow` (determinista respecto al código que corrió la original).
