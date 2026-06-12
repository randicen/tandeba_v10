# D2a.2.2 — Timeout, Retry, Idempotency: Spec

> **Spec para D2a.2.2 (primitivas de producción del executor).** Complementa `AGENT_WORKFLOW_DSL_SPEC.md` (define el DSL) con la semántica de runtime del executor. Esta es la **fuente de verdad** del comportamiento de timeout/retry/idempotency. Cambios al comportamiento se acuerdan y reflejan **antes** de tocar código.

## 0. Status

- **Versión actual**: 1.0 (cerrada 2026-06-09)
- **Alcance**: D2a.2 (executor mínimo, single-process)
- **Cubre**: timeout per-attempt, retry config (con backoff), idempotency cache, NON_IDEMPOTENT_RETRY_DISALLOWED, interacción entre los 3.
- **NO cubre** (llegará cuando duela): retry distribuido, idempotency entre tasks, cache persistente, jitter en backoff, max backoff cap, circuit breaker por nodo.
- **Implementación**: `src/agent/workflow-engine/executor/executor.ts` → `executeWithTimeoutAndRetry`. **Tests**: `test_workflow_executor.mts` (50 tests totales; 14 son D2a.2.2).
- **Owner del cambio**: este spec vive en el repo. Modificaciones requieren acuerdo explícito antes de mergear.

---

## 1. Por qué este spec existe

`AGENT_WORKFLOW_DSL_SPEC.md` §1.5 dice: "Un nodo que se ejecuta dos veces (por retry) produce el mismo resultado o falla explícitamente. La idempotencia es declarada por el autor del nodo, no inferida."

Eso es la promesa. Este spec la hace concreta: define cómo se coordina timeout, retry y cache de idempotency en el executor, y en qué orden se aplican las decisiones cuando un nodo falla.

**Sin este spec**, el motor se comporta de formas sutilmente diferentes según combinaciones de config, y el usuario no tiene forma de predecir qué va a pasar. Con este spec, el comportamiento es determinista y testeable.

---

## 2. Goals & Non-goals

### 2.1. Goals (lo que D2a.2.2 DEBE cumplir)

1. **Timeout per-attempt determinista.** Cada intento de un nodo tiene un `timeoutMs` máximo. Si lo excede, el intento falla con `code: "TIMEOUT"`, `retriable: true`.
2. **Retry configurable por nodo.** El usuario declara `retries: { max, backoff, initialDelayMs, on }`. El motor respeta exactamente esa config.
3. **Safety net explícito.** Si un nodo tiene `retries.max > 0` pero no declara `idempotencyKey` ni `retriable: true`, el motor falla con `NON_IDEMPOTENT_RETRY_DISALLOWED` en vez de re-ejecutar a ciegas. Esto evita duplicar efectos colaterales.
4. **Idempotency cache per-task.** Si un nodo declara `idempotencyKey`, el output exitoso se cachea por task. Re-ejecuciones con la misma key hittean el cache.
5. **Coordinación correcta entre los 3.** Timeout cuenta como 1 intento. Retry con idempotency → cache hit en el 2do intento. Retry sin idempotency → re-ejecuta, no cachea. Ver §6 para las combinaciones.
6. **Defaults seguros.** Si el workflow tiene `config.defaultRetries` o `config.defaultTimeoutMs`, aplican a nodos que no especifican. Si un nodo NO declara retries y el workflow no tiene default → no hay retry, 1 solo intento.

### 2.2. Non-goals (D2a.2.2 — diferidos)

- **Cache persistente entre tasks.** El cache vive solo en memoria, por task. `cleanup()` lo libera. D3 introduce DB-backed cache que sobrevive restarts.
- **Circuit breaker por nodo.** Si un nodo falla N veces seguidas, no se le retira del pool. Eso vive en el **multi-model router** de D2b, no acá.
- **Jitter en backoff.** Hoy el backoff es determinista (fixed o exponential puro). En D3+, agregar jitter para evitar thundering herd.
- **Max backoff cap.** `initialDelayMs * 2^N` puede crecer mucho. Hoy el usuario es responsable de no pasarse. En D3+, agregar `maxDelayMs`.
- **Retry async en background.** El retry es bloqueante. Para nodos de minutos/horas, hay que mover a queue (D3).
- **Distributed idempotency.** La key no se coordina entre réplicas del motor. Single-process por ahora.

---

## 3. Configuración (el input del usuario)

Tres lugares donde el usuario declara config:

### 3.1. Por nodo (lo más común)

```typescript
{
  type: "function",
  id: "send_email",
  functionRef: "send_email",
  input: { from: { path: "input.email" } },
  output: { to: { path: "sent" } },
  timeoutMs: 30000,                    // 30s por intento
  retries: {
    max: 3,                            // hasta 3 reintentos
    backoff: "exponential",            // o "fixed"
    initialDelayMs: 1000,              // base del backoff
    on: ["TIMEOUT", "NETWORK_ERROR"]   // solo retry en estos códigos (opcional)
  },
  idempotencyKey: "email-{{state.input.email.id}}",  // cache key
  retriable: true                      // afirma que es seguro re-ejecutar
}
```

### 3.2. Por workflow (defaults)

```typescript
{
  id: "my-workflow",
  ...
  config: {
    defaultTimeoutMs: 60000,    // 1 min si el nodo no especifica
    defaultRetries: 2,          // 2 reintentos si el nodo no especifica
    // hitlDefaults: {...}      // (HITL, no D2a.2.2)
  }
}
```

### 3.3. Jerarquía y precedencia

| Campo | Precedencia |
|---|---|
| `timeoutMs` | **Nodo** > `config.defaultTimeoutMs` > sin timeout (cero = sin límite) |
| `retries.max` | **Nodo** > `config.defaultRetries` > 0 (sin retry) |
| `retries.on` | Solo nodo. Si no se declara, el comportamiento depende de si hay retries en nodo o en workflow (ver §5.3). |
| `idempotencyKey` | Solo nodo. |
| `retriable` | Solo nodo. |

---

## 4. El ciclo de vida de un nodo: lazo principal

Cada nodo (no-router) pasa por este flujo. El motor llama a `executeWithTimeoutAndRetry(node)`, que internamente ejecuta este loop:

```
while attempt < maxAttempts:
  1. Si attempt > 0 y hay idempotencyKey:
       buscar cache[getIdempotencyKey(state)]
       si hit: return cached (con retryCount actualizado)
  
  2. Ejecutar nodo con timeoutMs y signal combinado:
       createCombinedSignal(parentSignal)  // para que cancelación del padre aborte
       setTimeout(() => abort, timeoutMs) // si > 0
       outcome = await runNode(...)
  
  3. Si timeout disparó (timedOut=true):
       outcome = { status: "failed", code: "TIMEOUT", retriable: true }
     Else:
       outcome = outcome del runNode
  
  4. Si outcome.status === "completed" y hay idempotencyKey:
       cache[getIdempotencyKey(state)] = outcome
  
  5. Si outcome.status !== "failed":
       return outcome
  
  6. Failure → decidir retry:
       attempt++
       si attempt >= maxAttempts: break
       
       Safety net PRIMERO:
         si !idempotencyKey y !retriable:
           outcome = { code: "NON_IDEMPOTENT_RETRY_DISALLOWED", ... }
           break
       
       Filter (en orden de especificidad):
         si retries.on declarado y code ∉ retries.on: break
         elif retries.max declarado en nodo: skip catalog (override del usuario)
         else: si !isRetriableByDefault(code): break
       
       Backoff:
         delay = fixed ? initialDelayMs
                      : initialDelayMs * 2^(attempt-1)
         await sleep(delay)
```

`maxAttempts = retries.max + 1` (incluye el intento inicial). `retries.max: 0` significa 1 solo intento, sin retry.

---

## 5. Decisión de retry: la tabla que importa

Esta es la tabla de verdad. Para cada combinación de (config del nodo, error code), qué pasa.

### 5.1. ¿Se agotaron los intentos?

```
attempt >= maxAttempts  →  break (sin retry)
```

`maxAttempts = maxRetries + 1`. Si el usuario dijo `max: 3` y vamos por el 4to intento, no hay retry. **Esto es no negociable** — el usuario dijo "3 reintentos" y se respetan.

### 5.2. Safety net: ¿es seguro reintentar?

```
!node.idempotencyKey && !node.retriable  →  outcome.code = "NON_IDEMPOTENT_RETRY_DISALLOWED", break
```

Este check corre **primero**, antes de cualquier filtro de catálogo. Razón: si el usuario declaró `retries.max > 0` (quiere retry) pero NO declaró `idempotencyKey` ni `retriable: true` (no afirmó que es seguro), el motor NO adivina. Falla explícitamente con un código de error que el workflow puede inspeccionar.

**Por qué safety net primero, no después del catalog filter**: el catalog filter (`isRetriableByDefault`) es un default seguro para errores transitorios conocidos (RATE_LIMIT, TIMEOUT, etc.). Si un usuario declara `retries.max > 0` para un error `INTERNAL_ERROR` (un throw genérico), el catalog filter rompe antes de llegar al safety net, y el safety net nunca se evalúa. El resultado es un fallo silencioso con el error original en vez del `NON_IDEMPOTENT_RETRY_DISALLOWED` explícito. Eso es lo que pasó en v1.5 — bugfix en D2a.2.2 v1.0.

### 5.3. Filtro de códigos (3 casos, en orden de especificidad)

```
1. retries.on declarado:
   si code ∉ retries.on: break
   
2. retries.max declarado EN EL NODO:
   // override del usuario. Confiamos en su declaración.
   // No aplicamos catalog filter.
   // → retry para CUALQUIER error
   
3. (defaultRetries del workflow, sin retries en nodo):
   si !isRetriableByDefault(code): break
   // catalog filter como safety net (solo RATE_LIMIT, TIMEOUT, NETWORK_ERROR, MODEL_UNAVAILABLE)
```

**Por qué el nodo overridea el catalog**: si el usuario escribió `retries: { max: 3 }` en su workflow, está diciendo "estos son los errores que quiero que se reintenten". Aplicarle el catalog filter por encima sería contradictorio — le estaríamos diciendo "te reintentamos los errores de catálogo, no los que vos pediste".

**Por qué el catalog SÍ aplica para `defaultRetries` del workflow**: el workflow-level default es una policy genérica. El usuario no pensó específicamente qué errores pasar — es razonable ser conservador y solo reintentar lo conocido como transitorio.

### 5.4. Tabla de verdad resumida

| `idempotencyKey` | `retriable` | `retries.on` | `retries.max` (nodo) | `defaultRetries` (wf) | Error code | Resultado |
|---|---|---|---|---|---|---|
| sí | * | * | > 0 | * | cualquiera | Retry (cache en success) |
| no | true | * | > 0 | * | cualquiera | Retry (sin cache) |
| no | false | declarado | > 0 | * | code ∈ on | Retry (sin cache) |
| no | false | declarado | > 0 | * | code ∉ on | **NON_IDEMPOTENT_RETRY_DISALLOWED** (safety net) |
| no | false | no | > 0 | * | cualquiera | **NON_IDEMPOTENT_RETRY_DISALLOWED** (safety net) |
| no | false | * | no | > 0 | catalog-retriable | Retry (sin cache) |
| no | false | * | no | > 0 | NO catalog-retriable | No retry (catalog rompe) |
| * | * | * | 0 | 0 | * | No retry (1 solo intento) |

`catalog-retriable` = `RATE_LIMIT | TIMEOUT | NETWORK_ERROR | MODEL_UNAVAILABLE`.

---

## 6. Interacción timeout + retry + idempotency

### 6.1. Timeout + retry

El timeout es **per-attempt**, no total. Un nodo con `timeoutMs: 30000` y `retries.max: 3` puede correr hasta 4 × 30s = 120s en el peor caso (más backoffs).

El timeout cuenta como un intento. Si un nodo timeouttea:
- `code: "TIMEOUT"`
- `retriable: true` (sí, por convención)
- El retry loop lo trata como un failure normal
- El catalog filter lo deja pasar (TIMEOUT está en `isRetriableByDefault`)

### 6.2. Timeout + idempotency

Si el nodo declara `idempotencyKey` y el primer intento timeouttea, el cache está vacío (solo se guarda en success). El segundo intento ejecuta normalmente. Si el segundo intento tiene éxito, se cachea.

**Edge case**: si el nodo es idempotente y timeouttea, ¿deberíamos re-ejecutar contra el cache? No — el cache solo guarda outputs exitosos. La idea del cache es "ya tuvimos éxito, no repitas". Si no tuvimos éxito, no hay nada que cachear.

### 6.3. Retry + idempotency: el caso interesante

Tres patrones que el usuario puede combinar:

**Patrón A: idempotencyKey, retries.max > 0**
- Primer intento: ejecuta, falla. Cache miss.
- Segundo intento: ejecuta, éxito. Cache store.
- Tercer intento (si se dispara): cache hit, no re-ejecuta. Retorna cached.

**Patrón B: retriable=true (sin idempotencyKey), retries.max > 0**
- Primer intento: ejecuta, falla.
- Segundo intento: ejecuta, éxito.
- Tercer intento (si se dispara): ejecuta OTRA VEZ. No hay cache. Útil solo si la función es pura (mismo input → mismo output).

**Patrón C: idempotencyKey, retries.max > 0, retriable=true**
- Combinación válida. La presencia de `idempotencyKey` gana para el cache. `retriable=true` es redundante pero explícito.
- Se comporta como patrón A.

### 6.4. NON_IDEMPOTENT_RETRY_DISALLOWED en la práctica

Si el nodo tiene `retries.max > 0` pero no es seguro reintentar (sin idempotencyKey ni retriable), el motor falla con `NON_IDEMPOTENT_RETRY_DISALLOWED` en el **primer** intento (no espera a que se agoten los reintentos). El usuario ve el error inmediatamente y puede:
- Agregar `idempotencyKey` o `retriable: true` si sabe que es seguro.
- Cambiar el `onError` a `"continue"` o `{ goto: ... }` para que la task siga pese al fallo.
- Dejarlo así si quiere que la task falle explícitamente (lo más conservador).

**Por qué fallar en el primer intento, no en el último**: si el usuario ve el código, sabe que el problema es de declaración, no de "se agotaron los intentos". El mensaje de error es claro: "el nodo no declara idempotencyKey ni retriable, retry bloqueado para evitar duplicar efectos".

---

## 7. Idempotency: detalles del cache

### 7.1. Cuándo se guarda

**Solo en `status: "completed"`.** Un fallo (con cualquier código) NO se cachea. Esto es crítico: si se cachearan los fallos, un nodo que falla por timeout nunca se reintenta en la misma task (el cache hit devolvería el failure). Eso sería peor que no tener cache.

### 7.2. Cuándo se busca

**Solo en `attempt > 0`** (es decir, solo en reintentos). El primer intento siempre ejecuta, incluso si hay cache. Razón: si la task acaba de arrancar, el cache debería estar vacío. Si no lo está (por bug), el primer intento ejecuta y sobreescribe.

### 7.3. Estructura del cache

```typescript
// Por task, en memoria. D3 introduce DB.
private readonly idempotencyCaches = new Map<string, Map<string, NodeExecutionSuccess>>();
//                            taskId              cacheKey       outcome

// En startTask:
this.idempotencyCaches.set(taskId, new Map());

// En cleanup(taskId):
this.idempotencyCaches.delete(taskId);
```

**Per-task, no global**. Dos tasks distintas con la misma `idempotencyKey` no se pisan. Esto es importante: si el usuario corre el mismo workflow dos veces en paralelo, cada task tiene su propio cache.

### 7.4. Interpolación de la key

```typescript
private getIdempotencyKey(task: Task, node: WorkflowNode): string {
  if (!node.idempotencyKey) return "";
  return interpolate(node.idempotencyKey, this.getState(task));
}
```

`interpolate` reemplaza `{{state.X.Y}}` con el valor del state en ese path. Si el path no existe, retorna `""` (string vacío, no error).

**El usuario es responsable de hacer la key lo suficientemente específica** para que el cache hit sea semánticamente correcto. Ejemplo:

```yaml
# Mal: key constante, dos docs distintos con misma key
idempotencyKey: "doc"

# Bien: key por docId + version
idempotencyKey: "doc-{{state.input.docId}}-v{{state.input.version}}"
```

Si la key es muy genérica, el cache hit puede devolver un output que no corresponde al input actual. Es un bug del usuario, no del motor. El motor no puede inferir qué parte del input afecta el output.

### 7.5. lifecycle del cache

- `startTask` → crea el Map para el taskId.
- Cada `attempt > 0` del nodo → busca en el cache.
- Cada `success` del nodo → guarda en el cache.
- `cleanup(taskId)` → libera el Map.

**No hay TTL.** El cache vive lo que vive la task en memoria. Si el motor crashea, el cache se pierde. D3 introduce cache persistente en DB con TTL.

---

## 8. Cancelación y timeout: el signal combinado

`AbortSignal` se compone de 2 fuentes:

1. **Signal del padre** (la task fue cancelada). Si aborta, el controller local aborta, lo que el invoker/handler puede respetar.
2. **Controller local con `setTimeout`**. Si `timeoutMs > 0`, después de ese tiempo aborta.

```typescript
private createCombinedSignal(parent: AbortSignal) {
  const controller = new AbortController();
  if (parent.aborted) {
    controller.abort();
    return { signal: controller.signal, controller };
  }
  parent.addEventListener("abort", () => controller.abort(), { once: true });
  return { signal: controller.signal, controller };
}
```

**Por qué combinar y no usar el signal del padre directo**: queremos poder distinguir "el padre canceló" de "el timeout disparó". El controller local es el único que el timeout toca, y se compone con el del padre. Si cualquiera aborta, el invoker ve el abort.

**Comportamiento si el invoker ignora el signal**: el motor tiene su propia verificación cooperativa en el loop. El `timedOut` flag se setea cuando el setTimeout dispara, y el motor lo usa para sobrescribir el outcome. El signal es cortesía, no dependencia.

---

## 9. Observabilidad (lo que se loggea)

Por cada intento, el logger emite:

- `function node ${id} starting` — antes de cada attempt
- `function node ${id} failed` — en cada fallo (con error code)
- `retrying node after backoff` — antes de cada reintento (con attempt, delayMs, errorCode)
- `idempotency cache hit` — cuando un retry hittea el cache
- `idempotency cache stored` — cuando un success guarda en cache
- `wrote output to state` — cuando el success se persiste al state

Estos logs son por attempt, no por nodo. Útil para debug: "¿se reintentó? ¿cuántas veces? ¿con qué backoff? ¿el cache funcionó?".

En D2a.3 se reemplazan por spans de OpenTelemetry, pero los hooks quedan.

---

## 10. Edge cases y comportamiento explícito

### 10.1. Función no registrada

Si `functionRef` no está en el `FunctionRegistry`, el nodo retorna:
```typescript
{ code: "INTERNAL_ERROR", message: "Función 'X' no registrada.", retriable: false }
```

**No se reintenta.** Razón: registrar la función es bug del developer, no condición transitoria. Reintentar no va a hacer aparecer la función.

### 10.2. outputSchema no se cumple (LLM)

Si el LLM invoker devuelve un output que no valida contra `outputSchema`:
```typescript
{ code: "INVALID_OUTPUT", retriable: false }
```

**No se reintenta por default.** Razón: el LLM suele dar el mismo tipo de output si le das el mismo prompt. Si el usuario quiere reintentar, lo declara explícitamente con `retries.on: ["INVALID_OUTPUT"]`.

### 10.3. Cancelación durante un intento

Si el signal aborta durante un intento, el nodo-runner tira `AbortError` (o devuelve failure con `code: "INTERNAL_ERROR"` si la implementación del runner no maneja AbortError). El motor:
- Detecta el abort (signal.aborted)
- Marca la task como `cancelled`
- No aplica retry
- El loop termina

### 10.4. Cancelación durante un backoff

Si el signal aborta durante el `await sleep(delay)`, el sleep no respeta el signal (es un `setTimeout` pelado). **Esto es un bug conocido de v1** (dejado para D3). El retry continúa. Si el usuario quiere cancelar, debe cancelar antes del backoff o esperar a que termine.

Mitigación parcial: el `taskIdGenerator` puede inyectar un `AbortController` con `setTimeout` que respete cancellation, pero no es parte del contrato actual.

### 10.5. Max retries alcanzado con último error catalog-retriable

Si `retries.max: 3` y los 4 intentos fallan con `NETWORK_ERROR`, el outcome final es `{ code: "NETWORK_ERROR", retryCount: 3, ... }`. El motor lo devuelve al loop principal, que aplica `onError` (default: "fail"). El `retryCount` queda persistido en el `NodeResult` para auditoría.

---

## 11. Tests que validan este spec

`test_workflow_executor.mts` — 14 tests específicos de D2a.2.2:

```
D2a.2.2 — Timeout
  ✓ timeout: function que tarda más que el timeoutMs → task FAILED con TIMEOUT
  ✓ timeout: function que termina antes del timeoutMs → completa normalmente
  ✓ timeout: workflow.config.defaultTimeoutMs aplica al nodo que no tiene override

D2a.2.2 — Retry
  ✓ retry: function que falla 2 veces y luego succeeds → completa al tercer intento
  ✓ retry: function que falla más que max → task FAILED con error original
  ✓ retry: filter 'on' restringe los códigos que disparan retry
  ✓ retry: sin idempotencyKey ni retriable → NON_IDEMPOTENT_RETRY_DISALLOWED
  ✓ retry: con retriable=true (sin idempotencyKey) re-ejecuta sin cache

D2a.2.2 — Idempotency
  ✓ idempotency: con idempotencyKey, retry devuelve cached output
  ✓ idempotency: el cache sobrevive retries DENTRO de la misma task
  ✓ idempotency: cache se limpia con cleanup()

D2a.2.2 — Combined (timeout + retry + idempotency)
  ✓ combo: timeout dispara retry; tras 2 timeouts, completa al 3er intento (éxito rápido)
  ✓ combo: timeout + idempotency → reintento con cache hit
```

Si se agrega un test que viola este spec, o el spec cambia sin actualizar tests, hay un mismatch y hay que resolverlo (preferentemente actualizar el spec, no "arreglar" el test para que pase).

---

## 12. Open questions / decisiones pendientes

1. **¿El `retriable: true` permite reintentar CUALQUIER error, incluso NO catalog-retriable?** Hoy sí (override del nodo). ¿Tiene sentido permitirlo? Un nodo puede afirmar "soy determinístico, reintentame siempre que falle". Es lo que el test "fail 2 times then succeed" valida. Sí, tiene sentido.

2. **¿Debería haber un `maxDelayMs` en RetryConfig?** Hoy no. Si el usuario pone `initialDelayMs: 1000` y `max: 10` con exponential, el último backoff es `1000 * 2^9 = 512000ms = 8.5 minutos`. ¿Es OK? Decisión para D3: agregar cap o warning.

3. **¿El `onError: "continue"` con un nodo que tiene `retries.max > 0` debería agotar los reintentos antes de continuar?** Hoy sí (el loop interno corre todos los retries, devuelve el failure final, y el loop externo aplica `onError`). ¿Tiene sentido "abortar retry al primer failure si onError=continue"? Decisión: no, mantener comportamiento actual. Razón: el usuario pidió retries, los respetamos; el continue es la policy de qué hacer cuando **aún así** falla.

4. **¿Cache hit debería contar como un attempt?** Hoy no — el cache hit retorna sin incrementar `attempt`. Entonces, si `retries.max: 3` y tenemos 1 fail + 3 cache hits, el `retryCount` final es 0 (el cache hit no es un retry). ¿Es OK? Decisión: sí, el cache hit es la versión "gratis" del retry. Si el usuario quiere contar los cache hits, lo hacemos en D3 con `cacheHits` separado.

---

## 13. Changelog

### v1.0 (2026-06-09) — Cierre de D2a.2.2

**Bugfix crítico**: el orden de los checks en `executeWithTimeoutAndRetry` estaba invertido. El `isRetriableByDefault` (catalog filter) rompía el loop antes de llegar al safety net `NON_IDEMPOTENT_RETRY_DISALLOWED`. Resultado: para errores NO catalog-retriable (ej: `INTERNAL_ERROR` de un throw), el motor ignoraba `retries.max > 0` y hacía 1 solo intento.

**Fix**: reordenar para que el safety net corra primero, y el catalog filter solo aplique cuando `defaultRetries` viene del workflow (no del nodo). Si el usuario declaró `retries.max` en el nodo, el catalog filter no se aplica (override del usuario).

**Otros bugfixes**:
- Typo en test: `functionRef: "expense"` → `"expensive"`.
- Patrón de function mock en test: "throw N veces, luego succeed para siempre" no modela "throw N veces por task". Cambiado a "throw N consecutivas, reset en success".

**Resultado**: 50/50 tests pasan, 0 fails. Comportamiento documentado y determinista.
