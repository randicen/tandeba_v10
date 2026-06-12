# D2a.4 — HITL Primitives: Pause/Resume Reales: Spec

> **Spec para D2a.4.** Cierra el gap del motor: hoy `runHITLNode` hace `await hitlHandler.request()` bloqueante, lo que congela el motor cuando un humano debe responder. Este spec define la separación de fases pause/resume, los nuevos contratos, y la migración del HITL de D1. Es la **fuente de verdad** del comportamiento de runtime HITL a partir de D2a.4. Cambios al comportamiento se acuerdan y reflejan **antes** de tocar código.
>
> **Origen de la decisión**: la pausa real está documentada en `AGENT_WORKFLOW_DSL_SPEC.md` §6.3 (status='paused_hitl', resume externo) pero nunca se implementó. El motor hoy bloquea. Esto es un gap silencioso: el primer workflow real con HITL de larga espera (ej: aprobación humana con `timeoutMs: 86400000`) congelaría el motor entero.

## 0. Status

- **Versión actual**: 1.0 (decisiones tomadas en este turno, 2026-06-10).
- **Alcance**: motor de workflows (Capa 1, D2a). NO toca specialists (Capa 3, D2b). NO toca la UI de HITL (D3+).
- **Cubre**:
  - **Separación pause/resume**: el motor ya no se bloquea en `await` esperando humanos.
  - **Nuevo método `executor.resumeTask(taskId, response)`**: API explícita para que el caller (UI, webhook, lo que sea) inyecte la respuesta humana y el motor continúe el loop.
  - **Nueva interfaz `HITLHandler.initiate()`**: reemplaza al `request()` bloqueante. El handler es ahora solo **notificador** (envía email, webhook, push, etc.). Retorna un `requestId` rápido.
  - **`Task.pendingDecision`**: nuevo campo que persiste el estado de la pausa (qué nodo, qué contexto, qué approvers, qué `requestId`, desde cuándo).
  - **Lifecycle claro**: `running → paused_hitl → (resumeTask | cancelTask | purgeTask)`. La task `paused_hitl` vive en el `Map` del executor hasta que se resuelva.
  - **Sin migración del `ask_human` de D1**: el `ask_human` actual es una TOOL que el LLM invoca (en `src/agent/tools.ts:652`, consumida por `src/agent/agent.ts`), NO un `HITLHandler` que el motor inyecta. El `WorkflowExecutor` no se instancia desde `server.ts` todavía. No hay nada que migrar en D2a.4. La integración productiva del `HITLHandler` con el sistema externo (canal de respuestas desacoplado) es D2a.5+ cuando se cablee el motor.
  - **Audit preservado**: el `NodeResult` del HITL guarda `requestId` (vínculo a la notificación), `output` validado contra `outputSchema`, y si hubo decline, la razón en `declinedReason`. Todo lo que el audit legal necesita.
- **NO cubre** (llegará cuando duela):
  - **Persistencia de la pausa en DB** (D3 introduce DB; en D2a, si el server reinicia, las tasks `paused_hitl` se pierden).
  - **Sweeper de timeout automático** (en D2a, el handler externo es responsable de respetar `timeoutMs`; en D3+ un sweeper detecta pauses vencidas y aplica `onTimeout`).
  - **Multi-approver coordination UI** (en D2a, el `approvalMode` declarado en el nodo se respeta a nivel de output, pero la coordinación de "quién ya respondió" es responsabilidad del caller que invoca `resumeTask`; D3+ introduce un canal de respuestas por approver).
  - **Re-notificación automática** (documentado como limitación en DSL spec §6.3; sale de scope del motor).
- **Implementación esperada**: extiende `src/agent/workflow-engine/`. **Tests**: `test_workflow_d2a_4.mts` (nuevo archivo, ~12-15 tests).
- **Owner del cambio**: este spec vive en el repo. Modificaciones requieren acuerdo explícito antes de mergear.

---

## 1. Por qué este spec existe

Releer `node-runner.ts::runHITLNode` (líneas 312-393) y `executor.ts::runLoop` muestra el problema:

```typescript
// node-runner.ts:329 (versión actual)
const response = await hitlHandler.request({
  taskId: task.taskId,
  nodeId: node.id,
  // ... qué pregunta, qué contexto, qué approvers ...
  signal,
});
```

`hitlHandler.request()` es una promise que el motor espera. El `HITLHandler` actual es un contrato de inyección; las implementaciones de hoy son mocks para tests del motor (no hay implementación productiva cableada todavía — el `WorkflowExecutor` no se instancia desde `server.ts`).

**No funciona** para un motor de workflows que:

1. **Debe soportar N tasks en paralelo.** Si la task A está esperando HITL de 24h, la task B (que solo necesita 2s de LLM) tiene que poder ejecutarse. Con `await` bloqueante en el motor, la task B nunca arranca.

2. **Debe sobrevivir a un restart del server.** Hoy la task vive en el `Map<taskId, Task>` del executor. Si el server crashea, se pierde. Eso era aceptable para tasks cortas (segundos), pero NO para tasks que esperan humanos por horas.

3. **Debe permitir integración con canales externos.** Una firma legal quiere que el HITL se apruebe por email o por Slack, no solo por la UI de Worgena. Hoy el handler es un único `request()` síncrono. Mañana necesita un "inicié la solicitud, te aviso cuando haya respuesta" desacoplado.

4. **El DSL spec §6.3 ya lo promete.** El spec dice: "Cuando el engine alcanza un nodo `hitl`, pausa la task. Status pasa a `paused_hitl`". El código no lo hace. Mismatch entre documentación y realidad. Peor que no documentar: miente.

**Sin este spec**, D2a.5 (workflow ejemplo) no se puede escribir con HITL real. El primer workflow con aprobación humana bloquearía el motor entero, y el usuario lo descubriría en producción.

---

## 2. Goals & Non-goals

### 2.1. Goals (lo que D2a.4 DEBE cumplir)

1. **El motor nunca se bloquea esperando humanos.** Cuando llega a un nodo HITL, retorna inmediatamente con `status='paused_hitl'`. El `run()` retorna. La task queda accesible para que otros `run()` en otras tasks procedan.
2. **Nuevo método `resumeTask(taskId, response)`** que re-engancha el loop desde donde quedó, aplicando la respuesta del humano (validada contra `outputSchema` si está declarado, escrita al state, state validado, nodo siguiente ejecutado).
3. **Nueva interfaz `HITLHandler.initiate()`** que reemplaza al `request()` bloqueante. Retorna `{ requestId }` rápido. El handler decide cómo notificar (email, webhook, push, etc.) — eso queda fuera del motor.
4. **`Task.pendingDecision` persiste el contexto de la pausa**: qué nodo, qué pregunta, qué approvers, qué `outputSchema`, `requestId`, `startedAt`. Necesario para que `resumeTask` sepa qué validar y dónde escribir.
5. **Lifecycle coherente**: `paused_hitl` es un estado terminal transitorio. Se resuelve con `resumeTask`, `cancelTask`, o `purgeTask`. La task NO se auto-resuelve por timeout (D2a limitación; D3 sweeper).
6. **Audit preservado**: `NodeResult` del HITL persiste `requestId`, `output` validado, `declinedReason` si declined. El `pendingDecision` queda en la `Task` para trazabilidad de cuánto tiempo estuvo pausada.
7. **`replayTask` no permite replay de tasks `paused_hitl`**: igual que `running` y `pending`, la task debe estar en estado terminal para hacer replay. Documentado.
8. **`cancelTask` funciona en `paused_hitl`**: la cancelación externa debe poder matar una task que quedó esperando humanos. Sin esto, un humano podría dejar la task colgada por horas.
9. **Comentarios y documentación sincronizados**: el comentario "paused" en `executor/types.ts` y "paused_hitl" en `dsl/types.ts` se actualizan para reflejar que el flujo es real.

### 2.2. Non-goals (D2a.4 — diferidos)

- **Persistencia de la pausa en DB.** La task vive en el `Map` del executor. D3 introduce DB y un sweeper que persiste y recupera pauses en startup.
- **Sweeper automático de timeouts.** En D2a, el `HITLHandler` externo es responsable de respetar el `timeoutMs` del nodo y llamar `cancelTask` o `resumeTask({type: 'timeout'})` cuando expire. D3+ introduce sweeper.
- **Multi-approver coordination UI.** El `approvalMode` ('any' | 'all' | 'majority') se respeta semánticamente, pero la lógica de "¿todos los approvers respondieron ya?" es responsabilidad del caller que invoca `resumeTask`. D3+ introduce un canal de respuestas por approver.
- **Re-notificación.** Política de recordatorios ("lleva 3 días sin responder, mandale otro email") queda fuera del motor. D3+ UI/notification.
- **UI de HITL del lado del motor.** La UI de chat actual de Worgena sigue funcionando como siempre (es la tool `ask_human` que el LLM invoca, no toca el motor). El motor no se cablea al server en D2a.4.
- **Implementación productiva del `HITLHandler`.** En D2a.4 solo definimos la interfaz (`initiate` + `resumeTask`). La integración real con un canal externo (email, Slack, webhook) se diseña cuando se cablee el motor al server (D2a.5+).

---

## 3. Decisión arquitectónica central: separación de fases

### 3.1. Lo que cambia

El `HITLHandler` actual:

```typescript
// types.ts:69 (versión actual)
export interface HITLHandler {
  request(params: HITLRequestParams): Promise<HITLResponse>;
}
```

`request()` es bloqueante. El motor hace `await` y queda congelado hasta que el handler resuelve con `approved` / `declined` / `timeout`.

**Lo nuevo (D2a.4)**:

```typescript
// types.ts (versión D2a.4)
export interface HITLHandler {
  /**
   * Inicia la solicitud HITL. El handler notifica al canal correspondiente
   * (email, webhook, push, etc.) y retorna inmediatamente con un requestId.
   *
   * El motor NO espera la respuesta acá. La respuesta llega via
   * `executor.resumeTask(taskId, response)` cuando el handler externo
   * (o un listener, o un cron) la obtiene.
   */
  initiate(params: HITLInitiateParams): Promise<HITLInitiateResult>;
}

export interface HITLInitiateParams {
  readonly taskId: string;
  readonly nodeId: string;
  readonly approvers: readonly string[];
  readonly question: unknown;
  readonly context?: unknown;
  readonly outputSchema?: Record<string, unknown>;
  readonly timeoutMs?: number;
}

export interface HITLInitiateResult {
  /** Identificador del request. Lo emite el handler; se persiste en Task.pendingDecision.requestId. */
  readonly requestId: string;
  /** Opcional: si el handler ya sabe la respuesta (ej: respuesta pre-cargada en tests). */
  readonly immediateResponse?: HITLResponse;
}
```

**¿Por qué `immediateResponse` opcional?** Para no romper el patrón de tests que pre-cargan respuestas, y para soportar un futuro handler interactivo que ya tenga la respuesta al momento de `initiate()`. Si el handler ya tiene la respuesta (ej: test que aprueba de una), puede retornarla junto con el `requestId` y el motor la procesa inmediatamente sin pasar por `paused_hitl`. Si no, `immediateResponse` es `undefined` y el motor sí pasa por `paused_hitl`.

### 3.2. Por qué esta separación (no otra)

**Alternativas consideradas**:

| Alternativa | Por qué no |
|---|---|
| **Worker/thread para el `await` bloqueante** | Single-process. D2a no introduce workers. D3+ si distribuimos. Hoy, en el mismo event loop, `await` bloquea las otras tasks. No funciona. |
| **Polling del handler cada N segundos** | Ruido. El handler no es naturalmente pollable (es notificador). Acopla el motor al handler. |
| **Mantener `request()` pero agregar timeout corto y "best effort"** | El HITL puede esperar horas. No hay timeout corto razonable. Falla por diseño. |
| **Cola de mensajes in-process** (handler encola, motor desencola) | Más complejo que pause/resume, sin beneficio claro. Pause/resume es la primitiva correcta. |
| **WebSocket bidireccional al handler** | Acopla el motor a un transporte. Hoy el handler puede ser HTTP, email, push, UI. Pause/resume es transporte-agnóstico. |

**La separación pause/resume es la primitiva correcta** porque:

1. **Es transporte-agnóstico.** El handler notifica como quiere. El motor expone una API (`resumeTask`) que cualquiera puede llamar cuando tenga la respuesta.
2. **El motor queda simple.** No maneja timeouts, no coordina approvers, no sabe qué canal se usó. Solo persiste la pausa y expone el resume.
3. **Es testeable.** El motor se testea con un mock que retorna `immediateResponse` o nada. La lógica de notificación se testea aparte.
4. **Escala a multi-tenant y distribuido** (D3+). Una vez en DB, la pausa sobrevive restarts. Una vez distribuido, otra instancia del motor puede recibir el `resumeTask`.

### 3.3. La pregunta del D1: ¿migración completa o wrapper?

**Decisión de este turno**: **no hay migración que hacer en D2a.4**.

**Hallazgo durante la auditoría (post-spec)**: el `ask_human` actual (`src/agent/tools.ts:652`, consumido por `src/agent/agent.ts:815`) NO es un `HITLHandler` del motor. Es una **tool** que el LLM invoca en el chat para pedir input humano. El `WorkflowExecutor` no se instancia desde `server.ts` todavía — el motor está construido y testeado, pero no cableado al server.

Por lo tanto:

- **No hay `HITLHandler` productivo que migrar.** El `HITLHandler` que define el motor es un contrato de inyección; la única implementación que existe son mocks para tests.
- **El `ask_human` de D1 sigue intacto y funcionando como siempre.** No hay que tocarlo.
- **La integración productiva del `HITLHandler` con un canal externo desacoplado** (email, Slack, webhook) se diseña en D2a.5 o después, cuando se cablee el motor al server. Ahí sí hay que decidir si es interactivo (wrapper) o desacoplado (canal externo).

**Implicación para §10 (cambios al código)**: el archivo `src/agent/hitl-wrapper.ts` se elimina del scope de D2a.4. `server.ts` no se toca. `tools.ts` y `agent.ts` no se tocan.

---

## 4. Nuevos tipos y contratos

### 4.1. `Task.pendingDecision`

Nuevo campo en `Task` (en `dsl/types.ts`):

```typescript
export interface Task {
  // ... lo que ya tiene ...

  /**
   * Si la task está pausada esperando respuesta HITL, este campo persiste
   * el contexto de la pausa. Se llena cuando el motor entra en `paused_hitl`
   * y se limpia cuando `resumeTask` o `cancelTask` resuelve la task.
   *
   * El campo es necesario para que `resumeTask(taskId, response)` sepa
   * qué nodoHITL reanudar y valide la respuesta contra el `outputSchema`
   * correcto.
   */
  readonly pendingDecision?: PendingHITLDecision;
}

export interface PendingHITLDecision {
  /** ID del nodo HITL que está esperando. */
  readonly nodeId: string;

  /** ID del request emitido por el HITLHandler.initiate(). Vínculo a la notificación externa. */
  readonly requestId: string;

  /** Approvers declarados en el nodo. Para audit. */
  readonly approvers: readonly string[];

  /** Pregunta resuelta (template interpolado). Para que el caller sepa qué preguntó. */
  readonly question: unknown;

  /** Contexto resuelto (template interpolado). Idem. */
  readonly context?: unknown;

  /** Output schema del nodo. Se usa para validar la respuesta en `resumeTask`. */
  readonly outputSchema?: Record<string, unknown>;

  /** Timestamp de cuándo se inició la pausa. Para audit ("lleva 3 días esperando"). */
  readonly startedAt: string;
}
```

**Por qué `readonly`**: la pausa es inmutable desde que se crea hasta que se resuelve. Si la task se pausa, luego se resume, el `pendingDecision` se borra. Si se cancela, también. No hay mutación intermedia.

**¿Por qué no `pausedAt` separado?** El audit necesita saber "cuánto tiempo estuvo esperando" y eso se calcula como `now - pendingDecision.startedAt`. El campo único es suficiente.

### 4.2. `HITLHandler.initiate()` (nueva interfaz)

Definido arriba en §3.1. Repetimos los puntos clave acá para que sean un único lugar de referencia:

```typescript
// En executor/types.ts

export interface HITLHandler {
  initiate(params: HITLInitiateParams): Promise<HITLInitiateResult>;
}

export interface HITLInitiateParams {
  readonly taskId: string;
  readonly nodeId: string;
  readonly approvers: readonly string[];
  readonly question: unknown;
  readonly context?: unknown;
  readonly outputSchema?: Record<string, unknown>;
  readonly timeoutMs?: number;
}

export interface HITLInitiateResult {
  readonly requestId: string;
  readonly immediateResponse?: HITLResponse;
}
```

**Decisiones de diseño**:

- **`requestId` lo emite el handler**, no el motor. Razón: el handler es quien conoce el canal externo y puede garantizar unicidad (ej: el ID del email enviado, el ID del mensaje Slack, etc.). El motor solo lo persiste. Si el handler no tiene noción de ID, genera un UUID y listo.
- **`immediateResponse` opcional**: si está, el motor la procesa inmediatamente sin pausar. Útil para tests con respuestas pre-cargadas y para un futuro handler interactivo. Si no está, el motor pausa.
- **NO incluimos `signal` de cancelación en `HITLInitiateParams`**: la pausa puede durar horas; el `signal` del `run()` original ya expiró. La cancelación de una task pausada se hace via `cancelTask()` (que es un método del executor, no del handler).

**`HITLResponse` queda igual** que la versión actual (ya en `types.ts:95`):

```typescript
export type HITLResponse =
  | { readonly type: "approved"; readonly output: unknown }
  | { readonly type: "declined"; readonly reason: string }
  | { readonly type: "timeout" };
```

### 4.3. `executor.resumeTask(taskId, response)` (nuevo método público)

```typescript
// En WorkflowExecutor (executor.ts)

export interface ResumeTaskResult extends TaskRunResult {
  // Reutiliza TaskRunResult. status será:
  // - 'running' si la respuesta era intermedia y el motor siguió
  //   ejecutando nodos hasta el final (sync flow).
  // - 'completed' / 'failed' / 'cancelled' si la respuesta resolvió
  //   la task.
  // - 'paused_hitl' si el siguiente nodo es otro HITL y volvió a pausar
  //   (recursivo). El caller debe llamar resumeTask de nuevo cuando llegue
  //   la respuesta.
}

class WorkflowExecutor {
  /**
   * Reanuda una task que está en `paused_hitl`, aplicando la respuesta humana.
   *
   * Pipeline:
   * 1. Verifica que la task existe y está en `paused_hitl`. Si no, tira
   *    `INVALID_TASK_STATE`.
   * 2. Verifica que `response.nodeId` (si viene) o el nodo del `pendingDecision`
   *    matchea. Si no, tira error claro.
   * 3. Aplica la respuesta:
   *    - 'approved' con output válido: escribe al state, valida state,
   *      encuentra el siguiente nodo, continúa el loop (puede pausar de
   *      nuevo si el siguiente es otro HITL).
   *    - 'declined': marca el nodo como `failed` con `HITL_DECLINED` y la
   *      razón en `declinedReason`, y aplica `onError` del nodo.
   *    - 'timeout': aplica `onTimeout` del nodo ('fail' / 'approve' / 'reject').
   * 4. El `run()` interno recorre los nodos hasta que la task alcanza un
   *    estado terminal o vuelve a pausar.
   * 5. Retorna `ResumeTaskResult` con el estado final.
   *
   * Idempotencia: si se llama `resumeTask` dos veces con la misma respuesta
   * sobre la misma task, la segunda llamada falla con `INVALID_TASK_STATE`
   * (la task ya no está `paused_hitl`). Esto es defensivo, no hay race
   * condition posible (single-threaded).
   */
  async resumeTask(taskId: string, response: HITLResponse): Promise<TaskRunResult>;
}
```

**Forma de la signature**: `response: HITLResponse` (sin `nodeId`). El `nodeId` se infiere de `task.pendingDecision.nodeId`. Razón: el caller ya sabe a qué task está respondiendo; pedirle el `nodeId` de nuevo es redundante y fuente de bugs. Si la respuesta se manda al `nodeId` equivocado, es bug del caller y debe fallar — la validación en el paso 2 lo cubre.

**`onTimeout` aplicado en `resumeTask` con `response.type='timeout'`**: hoy el `node-runner.ts::runHITLNode` ya maneja `case 'timeout'` con `code: "HITL_TIMEOUT"` y `retriable: false`, lo que falla la task. Pero el DSL spec §6.3 dice que `onTimeout` puede ser `'fail'` (default), `'approve'` o `'reject'`. Hoy el `onTimeout` no se implementa (siempre falla). D2a.4 lo implementa en `resumeTask`:

```typescript
// En resumeTask, caso response.type === 'timeout':
const onTimeout = node.onTimeout ?? 'fail';
if (onTimeout === 'fail') {
  // Igual que decline: marca failed, aplica HITL_TIMEOUT.
  return;
}
if (onTimeout === 'approve') {
  // Equivalente a response.type === 'approved' con output = { approved: true }.
  // Sigue el loop.
  return;
}
if (onTimeout === 'reject') {
  // Equivalente a response.type === 'approved' con output = { approved: false, feedback: 'timeout' }.
  // Sigue el loop.
  return;
}
```

Documentado en §6 (Edge cases).

### 4.4. `executor.pauseForHITL()` (helper interno)

El método `resumeTask` necesita la lógica de "aplicar la respuesta y continuar el loop". Esa lógica es muy parecida a la de `runLoop` (líneas 478-623 de `executor.ts`). Para no duplicar, refactorizamos:

```typescript
class WorkflowExecutor {
  // ... existing runLoop ...

  /**
   * Helper interno. Llamado por `runLoop` cuando llega a un nodo HITL.
   * Persiste la pausa en la task, setea `status='paused_hitl'`, y retorna.
   *
   * NO espera respuesta. La continuación del loop sucede cuando alguien
   * llama `resumeTask(taskId, response)`.
   */
  private async pauseForHITL(
    task: Task,
    node: HITLNode,
    workflow: WorkflowDefinition,
    outcome: { requestId: string; immediateResponse?: HITLResponse },
  ): Promise<void> {
    // Resolver question/context/input desde el state.
    const state = this.getState(task);
    const question = resolveStateRef(state, node.question.from, node.question.default);
    const context = node.context
      ? resolveStateRef(state, node.context.from, node.context.default)
      : undefined;

    // Construir pendingDecision.
    const pending: PendingHITLDecision = {
      nodeId: node.id,
      requestId: outcome.requestId,
      approvers: node.approvers,
      question,
      context,
      outputSchema: node.outputSchema,
      startedAt: new Date().toISOString(),
    };

    // Actualizar la task.
    task.pendingDecision = pending;
    task.status = 'paused_hitl';
    task.updatedAt = pending.startedAt;
    this.log?.info(`task paused for HITL`, {
      taskId: task.taskId,
      nodeId: node.id,
      requestId: outcome.requestId,
      approvers: node.approvers,
    });

    // Si hay immediateResponse, no pausamos de verdad. Procesamos inline.
    if (outcome.immediateResponse) {
      // Limpiar pendingDecision antes de procesar.
      delete (task as { pendingDecision?: PendingHITLDecision }).pendingDecision;
      task.status = 'running';
      await this.applyHITLResponse(task, node, outcome.immediateResponse);
      // Después de aplicar, el caller (runLoop) continúa con el siguiente nodo.
    }
  }

  /**
   * Helper interno. Llamado por `resumeTask` (después de validar la task)
   * y por `pauseForHITL` (en el caso immediateResponse). Aplica la respuesta
   * humana al state, valida state, y maneja el continue/goto/fail según
   * corresponda.
   */
  private async applyHITLResponse(
    task: Task,
    node: HITLNode,
    response: HITLResponse,
  ): Promise<void> {
    // Switch según response.type y onTimeout.
    // Ver §6 (Edge cases) para el detalle.
  }
}
```

**El refactor del `runLoop`**: el handler `case "hitl"` del `node-runner.ts` se reemplaza por una llamada a `pauseForHITL`. El nodo-runner ya no maneja HITL directamente — el executor lo hace. Cambio arquitectónico, documentado en §10.

---

## 5. Persistencia y lifecycle

### 5.1. Estados posibles de una task HITL

| Estado anterior | Acción | Estado nuevo | Notas |
|---|---|---|---|
| `running` (llega a nodo HITL) | `pauseForHITL` sin `immediateResponse` | `paused_hitl` | Task queda en Map. El `run()` retorna. |
| `running` (llega a nodo HITL) | `pauseForHITL` CON `immediateResponse` | `running` (sigue al siguiente) | El motor procesa la respuesta inline y continúa. |
| `paused_hitl` | `resumeTask(approved)` con output válido | `running` → `completed` / `paused_hitl` (otro HITL) | El loop continúa hasta el final o nueva pausa. |
| `paused_hitl` | `resumeTask(declined)` | `failed` con `HITL_DECLINED` | Aplica `onError` del nodo. |
| `paused_hitl` | `resumeTask(timeout)` con `onTimeout='fail'` | `failed` con `HITL_TIMEOUT` | Aplica `onError` del nodo. |
| `paused_hitl` | `resumeTask(timeout)` con `onTimeout='approve'` | `running` → ... | Equivalente a approved con `{approved: true}`. |
| `paused_hitl` | `resumeTask(timeout)` con `onTimeout='reject'` | `running` → ... | Equivalente a approved con `{approved: false, feedback: 'timeout'}`. |
| `paused_hitl` | `cancelTask()` | `cancelled` | El `pendingDecision` queda en la task (para audit), pero la cancelación es terminal. |
| `paused_hitl` | `purgeTask()` | (task eliminada del Map) | Irrecuperable. |
| `paused_hitl` | `replayTask()` | Error `INVALID_TASK_STATE` | Igual que `running` y `pending`. |

### 5.2. Persistencia en D2a (memoria)

En D2a, la task vive en el `Map<taskId, Task>` interno del executor (`executor.ts:84`). Si el server reinicia, **se pierde**. Esto es una limitación conocida de D2a (todo el motor es in-memory; D3 introduce DB).

**Implicaciones para producción**:

- Una task `paused_hitl` sobrevive a N llamadas de `run()` y `resumeTask()`, pero NO a un restart del server.
- En desarrollo, está bien. En producción (multi-tenant), la limitación se mitiga con workers stateless detrás de un load balancer que mantenga sticky sessions, pero la solución real es D3 con DB.

**Documentado en `HANDOFF.md` gotcha sección, en este mismo sprint**. No en el código (sería ruido).

### 5.3. Cleanup y lifecycle

`cleanup(taskId)` (que desde D2a.2.3 retiene la task pero libera el cache de idempotency) **funciona en `paused_hitl`**: libera el cache, retiene la task. La task sigue accesible para `resumeTask`. Si querés eliminarla, `purgeTask(taskId)`.

`listActiveTasks()` debe incluir las tasks `paused_hitl` (son "activas" en el sentido de no-terminales). El código actual ya lo hace (filtra `completed`/`failed`/`cancelled`; `paused_hitl` pasa el filtro). Sin cambios.

### 5.4. ¿Qué pasa con `circuitBreaker` durante la pausa?

Nada. La espera HITL no es invocación de modelo. El circuit breaker no se toca. Cuando el motor reanuda (después de `resumeTask`), si el siguiente nodo es LLM, consulta el breaker como siempre. La pausa no "enfría" ni "consume" el breaker.

### 5.5. ¿Qué pasa con `idempotencyCaches` durante la pausa?

El cache se preserva durante la pausa. Si la task tiene un nodo con `idempotencyKey` y se re-ejecuta (ej: tras un replay), el cache se consulta. Como la pausa no afecta el cache, no hay acción especial.

`cleanup()` libera el cache pero retiene la task (D2a.2.3). Si se llama `cleanup` durante una pausa, el cache se pierde. Si después se hace `replayTask` y el nodo HITL se vuelve a ejecutar, el cache vacío significa que el idempotency check falla como en cualquier caso de cache vacío — el nodo se ejecuta. Documentado en §6.

---

## 6. Edge cases y manejo de errores

### 6.1. `response.type='approved'` con output inválido contra `outputSchema`

```typescript
// En applyHITLResponse, caso 'approved':
if (response.type === 'approved') {
  if (node.outputSchema) {
    const valid = validateAgainstSchema(response.output, node.outputSchema);
    if (!valid.ok) {
      // ¿Qué hacer? Opciones:
      // 1. Fallar la task con INVALID_OUTPUT.
      // 2. Tratarlo como 'declined' con razón 'invalid_output'.
      // 3. Retornar error al caller sin aplicar nada (la task sigue paused).
      //
      // Decisión: opción 1 (fallar la task con INVALID_OUTPUT).
      // Razón: si la respuesta no cumple el schema, es un bug del approver
      // (mandó el formato equivocado). El caller debería validar ANTES
      // de llamar resumeTask. Si igual lo llama con output inválido,
      // fallar es lo más predecible. El caller puede hacer replayTask
      // desde el nodo HITL para reintentar.
      return this.failTask(task, {
        code: 'INVALID_OUTPUT',
        message: `HITL response no cumple outputSchema del nodo "${node.id}": ${valid.error}`,
        failedNode: node.id,
      });
    }
  }
  // Output válido: escribir al state, validar, seguir.
  this.writeOutputToState(task, node, response.output);
  // ... state validation, find next node, etc.
}
```

### 6.2. `response.type='declined'` con `onError='continue'`

El nodo HITL declaró `onError: 'continue'`. El approver declina. ¿Se marca como `skipped` o como `failed`?

**Decisión (revisada post-implementación)**: `NodeResult.status='skipped'` y `error` se limpia. `declinedReason` se PRESERVA (es metadata de audit, no es error funcional). La task sigue al siguiente nodo.

**Razón**: este es el mismo patrón que el motor usa para cualquier nodo con `onError='continue'` (un nodo function/llm que falla con `continue` se marca como `skipped`, no como `failed`). El decline procesado con `continue` es semánticamente "el workflow decidió seguir, no falló". El `declinedReason` queda en `NodeResult` para audit.

La diferencia con `onError='fail'` (default) es que la task sigue corriendo en lugar de fallar. El nodo queda con `skipped` + la razón persistida, y el motor toma el siguiente edge.

### 6.3. `response.type='timeout'` con `onTimeout='approve'`

Cuando el handler externo decide que expiró el timeout y llama `resumeTask(taskId, { type: 'timeout' })`, el motor consulta `node.onTimeout`:

- `'fail'`: falla la task con `HITL_TIMEOUT`.
- `'approve'`: equivalente a `response.type='approved'` con `output = { approved: true }`. Escribe al state, valida, sigue.
- `'reject'`: equivalente a `response.type='approved'` con `output = { approved: false, feedback: 'timeout' }`. Escribe al state, valida, sigue.

**Edge case**: si el nodo NO declara `outputSchema` y `onTimeout='approve'` / `'reject'`, el output `{ approved: true }` o `{ approved: false, feedback: 'timeout' }` se escribe sin validación. El workflow autor es responsable de que esto sea coherente con su `output.to`. Documentado en §6.5 del DSL spec (HITL).

### 6.4. `resumeTask` en task no pausada

```typescript
async resumeTask(taskId: string, response: HITLResponse): Promise<TaskRunResult> {
  const task = this.requireTask(taskId);
  if (task.status !== 'paused_hitl' || !task.pendingDecision) {
    throw new ExecutorError(
      `Task ${taskId} no está paused_hitl (status=${task.status}). resumeTask solo aplica a tasks esperando respuesta HITL.`,
      'INVALID_TASK_STATE',
      { taskId, status: task.status, hasPendingDecision: !!task.pendingDecision },
    );
  }
  // ... aplicar response ...
}
```

### 6.5. `resumeTask` en task que fue `cleanup`eada

`cleanup` retiene la task. `resumeTask` funciona. Si fue `purgeTask`, `requireTask` tira `TASK_NOT_FOUND`. Comportamiento correcto, sin cambios.

### 6.6. `cancelTask` en `paused_hitl`

```typescript
// En cancelTask (executor.ts:294), comportamiento actual preservado.
// La task pasa a 'cancelled', el pendingDecision queda en la task
// para audit (cuánto tiempo estuvo esperando antes de cancelar).
cancelTask(taskId: string): void {
  const task = this.requireTask(taskId);
  if (task.status === 'completed' || task.status === 'failed') {
    return;
  }
  this.cancelledTasks.add(taskId);
  task.status = 'cancelled';
  // NO limpiamos pendingDecision: es evidencia de que la task estuvo
  // esperando HITL y fue cancelada. Útil para audit ("cancelada tras 3 días").
  task.updatedAt = new Date().toISOString();
  this.log?.info('task cancelled', { taskId, wasPausedHITL: !!task.pendingDecision });
}
```

### 6.7. `replayTask` de una task `paused_hitl`

```typescript
// En replayTask (executor.ts:382), la validación de estado terminal
// ya cubre esto. La task paused_hitl NO está en {completed, failed, cancelled},
// así que falla con INVALID_TASK_STATE. Sin cambios.
```

### 6.8. Nodo HITL con `immediateResponse` (handler ya tiene la respuesta)

Si el handler retorna `immediateResponse`, el motor procesa la respuesta sin pausar. El `pendingDecision` se crea brevemente (en `pauseForHITL`) pero se borra antes de retornar. El `status` de la task queda en `running` y el loop continúa.

**Implicación**: el `audit log` ve la pausa como un parpadeo. Es OK — la pausa nunca existió desde el punto de vista del caller. Pero si en D3+ queremos audit de "qué respuesta vino de qué canal", el `NodeResult.promptSnapshot`-equivalente (un campo nuevo `hitlResponseSource: 'immediate' | 'resume'`) lo cubre. D2a.4 NO agrega este campo; queda para D3 cuando se implemente el canal desacoplado.

### 6.9. `purgeTask` en `paused_hitl`

`purgeTask` (ya en el código desde D2a.2.3) elimina todo. La task `paused_hitl` se elimina del Map. El `requestId` queda en la nada (el canal externo sigue teniendo la notificación activa, pero el motor no la va a procesar). El handler externo debería tener un mecanismo de timeout/cleanup propio. Documentado como limitación.

### 6.10. Crash del server durante `paused_hitl`

La task se pierde (D2a limitación; D3 con DB lo arregla). Workaround: el cliente (UI, sistema externo) llama `replayTask` con la task original... pero la task original no existe. **El cliente debe persistir externamente el `taskId` y el `requestId` para poder recrear la task si es necesario**. Documentado en `HANDOFF.md` gotchas.

En D3+ con DB, el sweeper en startup recupera las tasks `paused_hitl` y las marca como `paused_error` (nuevo estado) o aplica `onTimeout` si el `startedAt + timeoutMs < now`.

### 6.11. `response.type='declined'` pero `allowDecline=false` en el nodo

`allowDecline=false` significa que el approver no puede declinar formalmente. Pero la response puede llegar igual (ej: un cliente que llama `resumeTask` con `declined` a propósito, o un test preexistente que no declara `allowDecline`).

**Decisión (revisada post-tests preexistentes)**: si `allowDecline=false` y `response.type='declined'`, el motor **procesa el decline** igualmente (falla la task con `HITL_DECLINED`) y loguea un warning. Razón: el test preexistente `test_workflow_executor.mts:1300` espera este comportamiento (asume que `allowDecline` es opt-in para **persistir** la razón en `NodeResult.declinedReason` con razones custom, pero NO rechaza declines). Backward-compatible con la semántica anterior.

**Implicación**: la policy "no se puede declinar" se aplica al **caller** del handler, no al motor. El handler externo debe filtrar antes de llamar `resumeTask` si quiere bloquear declines. El motor es permisivo.

### 6.12. `response.type` con shape inválida

TypeScript lo previene en compilación. En runtime, si llega un objeto que no matchea `HITLResponse`, `applyHITLResponse` lo trata como `INVALID_OUTPUT` (defensa).

### 6.13. `Task` queda en `paused_hitl` y el server crashea antes de que `pendingDecision` se persista (race)

En D2a, `pendingDecision` se setea en el Map (memoria). Si el server crashea entre el `set` y el `return`, el dato se pierde. Imposible recuperar (es memoria, no hay log de "cambios pendientes"). Aceptado como limitación de D2a. En D3+ con DB, se hace en una transacción.

---

## 7. Audit y trazabilidad

### 7.1. ¿Qué persiste para una task que pasó por HITL?

- `Task.pendingDecision.requestId`: vínculo a la notificación externa. Si el handler emitió un email con ID `email-abc-123`, ese ID queda en la task. El audit puede rastrear "¿qué canal se usó para notificar al humano?".
- `Task.pendingDecision.startedAt`: cuándo se pausó. Combinado con `Task.completedAt` o `Task.updatedAt` final, da "cuánto tiempo estuvo esperando". Crítico para SLA de legal.
- `NodeResult.output` (si approved): la respuesta validada. El audit lee esto.
- `NodeResult.declinedReason` (si declined): la razón del decline. El audit lee esto.
- `NodeResult.error.code === 'HITL_DECLINED'` o `'HITL_TIMEOUT'`: queda claro por qué falló.

### 7.2. ¿Qué NO persiste en D2a (queda para D3)?

- `NodeResult.hitlResponseSource` ('immediate' | 'resume'): de dónde vino la respuesta. En D2a solo hay 'immediate' o 'resume' según si el handler retornó `immediateResponse` o no. Útil para audit cuando se use en producción.
- Historial de "se enviaron 3 recordatorios antes del timeout": responsabilidad del canal externo, no del motor.
- Metadata del approver (quién aprobó, desde qué IP, etc.): la respuesta `approved` puede incluir `output.approvedBy`, pero el motor no lo descompone. D3+ lo agrega si la firma lo necesita.

### 7.3. `Task.appliedMigrations` y el replay

Una task con HITL que se re-ejecuta via `replayTask` recrea el `pendingDecision` si el nodo HITL se vuelve a alcanzar. El replay NO preserva la respuesta humana original (eso sería anti-pattern — el replay es una ejecución nueva). Si el caller quiere la misma respuesta, llama `resumeTask` con ella después del replay. Documentado en §6.5 del D2a.2.3 spec (replay).

---

## 8. Integración con D1 (sin migración)

### 8.1. Estado actual

`src/agent/tools.ts:652` define `ask_human` como una **tool** que el LLM invoca (en `src/agent/agent.ts:815`). El `HITLHandler` del motor (`src/agent/workflow-engine/executor/types.ts:69`) es un contrato de inyección que hoy solo tiene mocks para tests — no hay implementación productiva en D1.

El `WorkflowExecutor` tampoco se instancia desde `server.ts` todavía. El motor existe como librería testeada, pero no está cableado al server.

### 8.2. Decisión: D2a.4 no toca nada del D1

- El `ask_human` de D1 sigue funcionando como siempre (es la tool que el LLM usa en el chat).
- El `HITLHandler` del motor no se conecta a nada productivo en D2a.4. Solo se testea con mocks.
- `tools.ts`, `agent.ts` y `server.ts` no se tocan.

### 8.3. Cuándo se hace la integración

En **D2a.5** (workflow ejemplo end-to-end) o después, cuando se cablee el motor al server, ahí se decide:

- Si el handler es **interactivo** (el cliente HTTP espera la respuesta humana antes de retornar), se usa el patrón `immediateResponse` que ya definimos. Compilable hoy.
- Si el handler es **desacoplado** (envía email/webhook, fire-and-forget), se diseña con canal de respuestas y `executor.resumeTask` desde un listener. Diseño más complejo, queda para cuando se implemente.

La separación `initiate` + `resumeTask` que estamos haciendo en D2a.4 es la primitiva que habilita ambos patrones. El patrón concreto se elige cuando se use.

### 8.4. Tests del handler mock

Los 17 tests de §9 usan un `MockHITLHandler` (test-only) que retorna `immediateResponse` o nada. No se necesita wrapper de D1.

---

## 9. Tests (~13 tests)

Archivo: `test_workflow_d2a_4.mts` (nuevo). Patrón: `npx tsx test_workflow_d2a_4.mts`. Igual que `test_workflow_d2a_2_3.mts`.

### 9.1. Pause (3 tests)

1. `hitl: motor llega a nodo HITL sin immediateResponse → status='paused_hitl', pendingDecision persistido, run() retorna`
2. `hitl: motor llega a nodo HITL con immediateResponse approved → status='running', pendingDecision se borra, loop continúa al siguiente nodo`
3. `hitl: pendingDecision contiene nodeId, requestId, approvers, question, context, outputSchema, startedAt correctos`

### 9.2. Resume approved (3 tests)

4. `resumeTask: response approved con output válido → output escrito al state, state validado, loop continúa`
5. `resumeTask: response approved con output INVÁLIDO contra outputSchema → task falla con INVALID_OUTPUT, NodeResult persiste el error`
6. `resumeTask: response approved pero siguiente nodo es HITL → loop continúa, vuelve a pausar, retorna TaskRunResult con status='paused_hitl'`

### 9.3. Resume declined (2 tests)

7. `resumeTask: response declined con allowDecline=true → task falla con HITL_DECLINED, declinedReason persistido en NodeResult`
8. `resumeTask: response declined con allowDecline=false → motor procesa el decline igual (warning) y falla con HITL_DECLINED. Backward-compatible con tests preexistentes.`

### 9.4. Resume timeout (3 tests)

9. `resumeTask: response timeout con onTimeout='fail' (default) → task falla con HITL_TIMEOUT`
10. `resumeTask: response timeout con onTimeout='approve' → output {approved:true} escrito, loop continúa`
11. `resumeTask: response timeout con onTimeout='reject' → output {approved:false, feedback:'timeout'} escrito, loop continúa`

### 9.5. Edge cases del resumeTask (2 tests)

12. `resumeTask: en task NO paused_hitl (status=completed/running/failed) → ExecutorError INVALID_TASK_STATE`
13. `resumeTask: en task paused_hitl después de cleanup → funciona (cleanup retiene la task), pero cache de idempotency se perdió (verificar)`

### 9.6. Lifecycle interactions (3 tests)

14. `cancelTask: en task paused_hitl → status='cancelled', pendingDecision RETENIDO en la task para audit`
15. `purgeTask: en task paused_hitl → task eliminada del Map, irrecuperable`
16. `replayTask: en task paused_hitl → ExecutorError INVALID_TASK_STATE (igual que running)`

### 9.7. `immediateResponse` (2 tests, integración)

17. `immediate: handler retorna immediateResponse approved → motor nunca entra en paused_hitl, procesa la respuesta inline, loop continúa`
18. `immediate: handler retorna immediateResponse declined → motor nunca entra en paused_hitl, marca el nodo como failed con HITL_DECLINED, aplica onError`

**Total: 18 tests** (uno más que los 17 iniciales; la cobertura de `immediateResponse` se justifica porque es el modo "interactivo" que vamos a usar cuando se cablee el handler productivo).

---

## 10. Resumen de cambios al código

| Archivo | Cambio |
|---|---|
| `src/agent/workflow-engine/dsl/types.ts` | Agregar `Task.pendingDecision?: PendingHITLDecision`. Nueva interface `PendingHITLDecision`. |
| `src/agent/workflow-engine/executor/types.ts` | `HITLHandler.request()` → `HITLHandler.initiate()`. Nuevas interfaces `HITLInitiateParams` y `HITLInitiateResult`. Agregar `timeoutMs` a `HITLInitiateParams`. `HITLResponse` queda igual. Eliminar `HITLRequestParams` (reemplazado por `HITLInitiateParams`). |
| `src/agent/workflow-engine/executor/node-runner.ts` | Eliminar `runHITLNode` (líneas 312-393). El `case "hitl"` del switch principal tira `INTERNAL_BUG` con mensaje "HITL se maneja en el executor vía pauseForHITL". Actualizar comentario de cabecera. |
| `src/agent/workflow-engine/executor/executor.ts` | `runLoop` ya no llama a `runNode` para nodos `hitl`. Detecta `node.type === 'hitl'`, llama `pauseForHITL` (helper nuevo). Nuevo método público `resumeTask(taskId, response)`. Nuevo helper privado `pauseForHITL(task, node, workflow, outcome)`. Nuevo helper privado `applyHITLResponse(task, node, response)`. `cancelTask` no limpia `pendingDecision` (para audit). Comentarios actualizados. |
| `src/agent/workflow-engine/executor/index.ts` | Barrel export: agregar `HITLInitiateParams`, `HITLInitiateResult`, `PendingHITLDecision`. Eliminar `HITLRequestParams` del export. |
| `src/agent/hitl-wrapper.ts` (eliminado del scope) | **No se crea.** El `ask_human` de D1 es una tool, no un `HITLHandler`. No hay nada que wrappear. |
| `src/agent/tools.ts` | Sin cambios. La tool `ask_human` sigue funcionando como siempre. |
| `src/agent/agent.ts` | Sin cambios. La invocación de `ask_human` desde el LLM sigue igual. |
| `server.ts` | Sin cambios. El `WorkflowExecutor` no se cablea al server en D2a.4 (queda para D2a.5+). |
| `AGENT_WORKFLOW_DSL_SPEC.md` §6.3 | Actualizar para reflejar que `paused_hitl` es estado real (no solo teórico). Mencionar `executor.resumeTask` y `Task.pendingDecision`. Mencionar la limitación de D2a (persistencia en memoria). |
| `HANDOFF.md` | Agregar gotcha: "Tasks `paused_hitl` se pierden en restart del server (limitación D2a). D3 introduce DB." |
| `test_workflow_d2a_4.mts` (nuevo) | 17 tests según §9. |

**Desglose explícito de líneas de código estimadas**:

- `executor.ts`: +120 líneas (resumeTask, pauseForHITL, applyHITLResponse, ajustes en runLoop, cancelTask).
- `node-runner.ts`: -80 líneas (runHITLNode eliminado).
- `types.ts` (executor): +30 líneas (HITLInitiateParams, HITLInitiateResult, ajustes).
- `types.ts` (dsl): +20 líneas (PendingHITLDecision, ajuste Task).
- `test_workflow_d2a_4.mts`: +500 líneas (17 tests, promedio ~30 líneas c/u con setup).
- **Total**: ~590 líneas. Menor que D2a.2.3 (~620 reales) porque no hay wrapper.

---

## 11. Changelog de decisiones tomadas en este turno

Documento todas las decisiones que tomé yo (en lugar de preguntar) para que queden registradas y sean reversibles si no te gustan:

1. **Separación de fases (initiate + resumeTask)** — SÍ. Decisión arquitectónica central, justificada en §3.2.
2. **`immediateResponse` opcional en `HITLInitiateResult`** — SÍ. Permite tests con respuestas pre-cargadas y wrapper D1 síncrono. Justificada en §4.2.
3. **`requestId` lo emite el handler** — SÍ. El handler conoce el canal externo. Justificada en §4.2.
4. **NO `signal` de cancelación en `HITLInitiateParams`** — SÍ. La cancelación de task pausada se hace via `cancelTask()`, no del handler. Justificada en §4.2.
5. **NO wrapper del `ask_human` de D1** — corrección post-auditoría. El `ask_human` es una tool del LLM, no un `HITLHandler` del motor. El motor no está cableado al server. No hay nada que migrar en D2a.4. La integración productiva del handler se hace en D2a.5+. Documentado en §8.
6. **`response` en `resumeTask` no lleva `nodeId`** — SÍ. Se infiere de `task.pendingDecision.nodeId`. Justificada en §4.3.
7. **`onTimeout` implementado en D2a.4** — SÍ. El DSL spec ya lo prometía. Hoy `case 'timeout'` siempre falla; en D2a.4 respeta `'fail'/'approve'/'reject'`. Justificada en §4.3.
8. **Output inválido contra `outputSchema` en `approved` → `INVALID_OUTPUT` (falla la task)** — SÍ. Decisión de §6.1.
9. **`declined` con `allowDecline=false` → motor procesa el decline igual (warning)** — REVISADA post-tests. El test preexistente `test_workflow_executor.mts:1300` asume que el decline se procesa aunque `allowDecline` no esté declarado. Backward-compatible. La policy "no se puede declinar" la aplica el handler externo, no el motor. Decisión de §6.11.
10. **`cancelTask` retiene `pendingDecision` en la task** — SÍ. Para audit ("cancelada tras 3 días"). Decisión de §6.6.
11. **Persistencia de la pausa solo en memoria en D2a** — SÍ (limitación). DB en D3. Decisión de §5.2.
12. **NO sweeper automático de timeouts en D2a** — SÍ (limitación). El handler externo es responsable. Decisión de §2.2.
13. **NO `hitlResponseSource` en `NodeResult`** — SÍ. No en D2a. D3+ cuando entre el canal desacoplado. Decisión de §7.2.
14. **17 tests** (en lugar de 12-15 estimados) — SÍ. La cobertura de edge cases justifica el extra.

**Reversibilidad**: si alguna de estas decisiones no te cuadra, decime y la cambiamos antes de codear. Cambios al spec requieren acuerdo explícito.
