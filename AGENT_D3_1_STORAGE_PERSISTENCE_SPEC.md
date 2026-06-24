# Worgena — D3.1: Persistencia Cross-Restart del Motor

> **Sprint**: D3.1 (de D3 partido en 3 sprints cortos).
> **Fecha**: 2026-06-13.
> **Status**: ✅ Cerrado.
> **Spec version**: 1.0.
>
> Este sprint cierra la deuda **CRIT-1 / MAYR-LEGAL** documentada en `HANDOFF.md` gotcha #9: las tasks `paused_hitl` se pierden en restart del server porque viven en el `Map<taskId, Task>` del `WorkflowExecutor`.
>
> **Decisión del founder (2026-06-12 noche)**: esperar a D3 y meterlo acá. Este spec ejecuta esa decisión.

---

## 1. Propósito y alcance

### 1.1. Qué resuelve

Cierra el riesgo legal-audit: en Worgena-legal, una task en pausa HITL puede estar esperando días la respuesta de un approver humano. Si el server reinicia en el medio, la pausa se pierde y con ella:

- El `state` actual de la task (contexto del caso legal).
- El `pendingDecision` (qué nodo HITL, qué approvers, qué pregunta, desde cuándo).
- Los `nodeResults` ya computados.
- El audit trail: "esta task estuvo esperando N horas, se perdió por restart".

El sprint D3.1 introduce persistencia transaccional de tasks para que el motor **sobreviva restarts** sin perder trabajo en curso.

### 1.2. Qué NO resuelve (forward-compat con D3.2 y D3.3)

- **Multi-tenant real con `tenant_id` en queries** (D3.2). D3.1 introduce el campo `tenant_id` en la tabla pero NO lo usa para filtrar — el motor sigue siendo single-tenant en memoria.
- **Auth de tenant** (D3.3).
- **Sweeper de timeouts HITL al startup** (D3.3). D3.1 persiste, pero el handler externo sigue manejando timeouts.
- **Audit log completo por Agent ID** (D3.3). D3.1 solo persiste tasks; el audit log de steps (D1) sigue como está.
- **Migración de tasks a Postgres** (forward, post-D6). D3.1 deja el `TaskStore` como interface, no acoplado a SQLite, para que migrar sea swap de implementación.

### 1.3. Dependencias

- D2a.4 cerrado (HITL primitives con `paused_hitl` y `resumeTask`).
- `worgena.db` con SQLite + WAL activo. Patrón ya en `src/lib/db.ts`.

### 1.4. Orden fundamental

Regla 6b del proyecto: "¿qué se rompe si esto no está?".

- D3.1 (storage cross-restart) — **fundamental**. Sin esto, un restart tira abajo trabajo legal en curso. Riesgo legal real.
- D3.2 (multi-tenant schema) — **fundamental** (SaaS requiere aislamiento de datos por firma), pero D3.1 lo desbloquea técnicamente (la tabla `paused_tasks` ya tiene `tenant_id`).
- D3.3 (auth + sweeper + audit) — **necesario para producción**, pero se puede vivir sin él en dev/staging.

---

## 2. Decisiones de diseño

### 2.1. Persistencia solo de tasks NO terminales

**Decisión**: el `TaskStore` persiste solo tasks en estado no terminal (`pending`, `running`, `paused_hitl`, `paused_error`). Tasks terminales (`completed`, `failed`, `cancelled`) NO se persisten — el `TaskStore` es para **work in progress**, no para audit histórico.

**Razón**:

- Audit histórico de tasks se hace en otra capa (logs del LLM, cost tracking). El motor no es la fuente de verdad del audit.
- Persistir todo infla la DB innecesariamente. Una task de revisión de contrato puede correr 10 minutos con cientos de `nodeResults`; mantenerla viva en SQLite después de completada es ruido.
- Si el caller quiere guardar tasks terminales, lo hace en su propio storage. La interface del motor no le impide serializar la task al cerrar.

**Forward-compat**: si en D3.3+ queremos persistir el `completion` por unas horas (para que un usuario pueda ver "qué terminé hace 5 minutos"), se agrega un TTL o un flag `persistOnCompletion`. D3.1 no lo hace.

### 2.2. Sync write a SQLite dentro de transaction atómica

**Decisión**: cuando el motor entra o sale de `paused_hitl`, la actualización del estado de la task (incluido `pendingDecision`) se hace en una **transaction atómica** de SQLite, antes de retornar al caller.

**Razón**:

- better-sqlite3 síncrono + `db.transaction(fn)` da atomicidad de forma trivial. No hay async, no hay race conditions.
- Si el `INSERT` falla (DB lock, disk full), el motor NO continúa. Lanza error. Esto es lo correcto: si no podemos persistir la pausa, no pausamos. El caller recibe el error y decide qué hacer.
- Trade-off: bloquear el event loop durante la escritura. **Pero es SQLite local en WAL, ~ms por write**. Aceptable. La latencia del HITL es del orden de horas (un humano respondiendo), no de microsegundos.

**Forward-compat con async**: si en el futuro migramos a Postgres, la interface del `TaskStore` no cambia. La implementación cambia a `await pool.query(...)` y el motor ya consume la interface, no la implementación.

### 2.3. Recovery al startup: re-hidratar tasks paused

**Decisión**: al instanciar el `WorkflowExecutor`, se le pasa un `TaskStore` configurado. El executor, en su constructor, lee del store todas las tasks en estado no terminal y las re-hidrata en su `Map<taskId, Task>` interno. Después sigue operando normal.

**Razón**:

- El motor es quien decide cuándo cargar tasks. No hay un "sweeper" global. Single responsibility.
- Las tasks `running` al momento del restart: el motor las marca como `paused_hitl` con un synthetic `pendingDecision` indicando "recuperado de restart" y notifica al handler externo para que decida si continuar, cancelar o reintentar.
- Las tasks `paused_hitl` se re-hidratan tal cual, con su `pendingDecision` intacto. El handler externo (cuando se cablee en D3.3) las reconoce por su `requestId` y puede continuar o cerrar.

**Trade-off conocido**: si el server crashea en medio de un nodo LLM (después del LLM call, antes de persistir el `nodeResult`), ese nodo se re-ejecuta. El motor loguea el re-ejecución con `idempotencyKey` (D2a.2) para que el cache de idempotencia minimice el costo. Sin idempotencyKey, el nodo re-ejecuta "fresco" — esto es por diseño, el caller debe declarar `idempotencyKey` en nodos LLM.

### 2.4. `TaskStore` como interface, no como clase concreta

**Decisión**: el motor consume una interface `TaskStore`. La implementación concreta `SqliteTaskStore` vive aparte. Los tests usan `InMemoryTaskStore`.

**Razón**:

- Testeable: tests no necesitan SQLite, usan `Map` en memoria.
- Forward-compat: D4+ pueden meter `PostgresTaskStore` sin tocar el motor.
- Cumple regla 6 del proyecto: "Provider-agnostic. El motor no acopla a un proveedor". `TaskStore` no es un proveedor, pero el principio es el mismo.

**Interface mínima** (definida en §4):

```ts
interface TaskStore {
  save(task: Task): void;          // sync; throws on error
  load(taskId: string): Task | null;
  loadActive(): Task[];            // todas las no terminales
  delete(taskId: string): void;   // para cancel + purge
}
```

### 2.5. `tenant_id` presente en la tabla pero no enforced (D3.1)

**Decisión**: la tabla `paused_tasks` tiene columna `tenant_id` desde D3.1. El motor la escribe pero NO la usa para filtrar (D3.1 es single-tenant en queries). D3.2 introduce el `tenant_id` como filtro en runtime.

**Razón**: prefijar el schema ahora evita una migración más adelante. La columna es NOT NULL, default `'default'` para que código single-tenant existente no se rompa.

### 2.6. Schema de la tabla `paused_tasks`

```sql
CREATE TABLE paused_tasks (
  task_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  workflow_id TEXT NOT NULL,
  workflow_version TEXT NOT NULL,
  status TEXT NOT NULL,           -- 'pending' | 'running' | 'paused_hitl' | 'paused_error'
  current_node TEXT NOT NULL,
  state_json TEXT NOT NULL,       -- JSON.stringify(task.state)
  node_results_json TEXT NOT NULL,-- JSON.stringify(task.nodeResults)
  pending_decision_json TEXT,     -- nullable; JSON.stringify(task.pendingDecision) si paused_hitl
  migrated_workflow_json TEXT,    -- nullable; D2a.2.3 snapshot
  applied_migrations_json TEXT,   -- nullable; JSON.stringify(task.appliedMigrations)
  input_json TEXT NOT NULL,       -- JSON.stringify(task.input)
  error_json TEXT,                -- nullable; JSON.stringify(task.error)
  metadata_json TEXT,             -- nullable; JSON.stringify(task.metadata)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,                -- nullable
  completed_at TEXT,              -- nullable, aunque D3.1 no persiste tasks completed
  replay_of TEXT,                 -- nullable
  replay_input_json TEXT,         -- nullable
  replay_from_node TEXT           -- nullable
);

CREATE INDEX paused_tasks_tenant_idx ON paused_tasks(tenant_id, status);
CREATE INDEX paused_tasks_status_idx ON paused_tasks(status, updated_at);
```

**Razón**:

- Todo el `Task` se serializa como JSON. **No** se hace mapping columna-por-columna. El motor evoluciona rápido, y un cambio en `Task` no debería requerir migration de la tabla cada vez.
- `state_json` y `node_results_json` son los más grandes. SQLite los maneja sin problema.
- Índices: por `tenant_id` (D3.2 va a filtrar por tenant), y por `status` para que el recovery sea eficiente (solo lee `paused_hitl` y `paused_error`).
- **Lo que NO se persiste**: `promptSnapshot` y `nodeResults` que ya están en `step_logs` (D1). No duplicamos.

### 2.7. `cleanup()` del motor YA NO elimina del TaskStore

**Decisión**: el `executor.cleanup(taskId)` actual (D2a.2.3, "soft reset": libera cache + flag de cancelación, retiene task) NO toca el `TaskStore`. La task sigue en SQLite.

**Razón**: `cleanup()` es para liberar memoria del motor, no para borrar persistencia. Si el caller quiere borrar la task, usa `purgeTask()` (D2a.2.3) que SÍ elimina del store.

**Backward-compat**: el comportamiento actual de los tests D2a.2.3 no cambia — `cleanup` no tocaba nada persistido (porque no había persistencia). Ahora sigue sin tocar, pero la task sigue viva en SQLite. Si los tests usaban `purgeTask` después de `cleanup`, siguen funcionando.

### 2.8. Notification al `HITLHandler` cuando se hidrata una task paused

**Decisión**: cuando el motor hidrata una task `paused_hitl` desde SQLite, llama a `config.hitlHandler.onResumeFromRestart?(taskId, pendingDecision)` (opcional). Si el handler implementa este método, recibe la notificación. Si no, no pasa nada. El `hitlHandler` se lee del `ExecutorConfig` existente — no se duplica en el segundo param del constructor.

**Razón**:

- En producción (D3.3), el handler querrá saber "esta task estuvo pausada 3 horas, el server reinició, sigues queriendo notificar al approver?" o "el approver ya respondió antes del restart, ignora".
- En dev/test, el handler no implementa este método. El motor sigue funcionando.
- Backward-compat: el método es opcional. Los `MockHITLHandler` de tests D2a.4 no lo implementan, no hay que tocarlos.

### 2.9. Sweeper de tasks zombie: out of scope D3.1

**Decisión**: tasks que quedaron en `running` (server murió a mitad de un nodo) NO se limpian automáticamente. El motor las re-hidrata con `status='paused_hitl'` + un `pendingDecision` sintético. El caller (D3.3 sweeper) decide qué hacer.

**Razón**: distinguir "task que está corriendo AHORA en otro worker" de "task zombie de un crash" requiere un heartbeat o un lock distribuido. SQLite + single-process no lo necesita. D3.3 introduce sweeper con un campo `last_heartbeat_at` y un cron que pregunta "¿este running lleva más de N minutos sin update? → es zombie, muévelo a paused_error".

### 2.10. NO se persisten las tasks durante `startTask`, solo en checkpoints

**Decisión**: el `startTask(taskId, workflow, input)` actual (D2a) crea la task en memoria. D3.1 hace que `startTask` también la persista. Pero durante la ejecución de cada nodo, NO se persiste tras cada step. Solo en transiciones de estado (`running → paused_hitl`, `running → completed`, etc.).

**Razón**: persistir tras cada nodo es IO innecesario. El motor tiene `nodeResults` en memoria. Si crashea a mitad de un workflow no-pausado, perdemos el progreso — pero esto es **aceptable por diseño**: el caller puede re-ejecutar el workflow (D2a.2.3 replay). El único momento donde la persistencia importa legal-audit es cuando la task está **esperando algo externo** (HITL). Ahí sí persistimos.

**Forward-compat con D3.3**: si en el futuro queremos persistir tras cada nodo (para debug de redlines, "qué pasó en este workflow exacto"), se agrega un flag `persistAfterEachNode: true` en el `ExecutorConfig`. No rompe nada.

---

## 3. API

### 3.1. `TaskStore` interface (nueva)

`src/agent/workflow-engine/persistence/task-store.ts` (nuevo archivo).

```ts
import type { Task } from "../dsl/types.js";

/**
 * Persistencia de tasks en estado no terminal.
 * El motor usa esto para sobrevivir restarts.
 *
 * D3.1: implementación sync (better-sqlite3). En D4+ puede migrarse
 * a async (Postgres) sin tocar el motor.
 *
 * Las implementaciones deben ser ACID: si `save()` lanza, NINGÚN
 * cambio fue persistido. El motor confía en esto.
 */
export interface TaskStore {
  /**
   * Persiste o actualiza la task. Si `taskId` ya existe, hace UPDATE.
   * Lanza error si la persistencia falla. El motor NO captura el error.
   */
  save(task: Task): void;

  /**
   * Carga una task por ID. Retorna null si no existe.
   */
  load(taskId: string): Task | null;

  /**
   * Carga todas las tasks en estado no terminal. Usado en el recovery
   * al instanciar el WorkflowExecutor.
   *
   * Performance: en la mayoría de deployments habrá <100 tasks paused.
   * Si en el futuro hay miles, se cambia a paginación.
   */
  loadActive(): readonly Task[];

  /**
   * Elimina la task del store. Usado por `purgeTask`.
   * No lanza si la task no existe (es idempotente).
   */
  delete(taskId: string): void;
}
```

### 3.2. `WorkflowExecutor` constructor (modificado, backward-compat)

```ts
// D2a signature
new WorkflowExecutor(config: ExecutorConfig);

// D3.1 signature (extiende, no rompe)
// El config EXISTENTE ya tiene hitlHandler. Solo se agrega taskStore como
// segundo param opcional.
new WorkflowExecutor(config: ExecutorConfig, taskStore?: TaskStore);
```

**Backward-compat**: los tests D2a existentes no pasan `taskStore` → `undefined` → comportamiento legacy (en memoria). Cero cambios a los 130+ tests existentes. El `hitlHandler` para el recovery se lee del `config.hitlHandler` existente.

**Razón de no usar `options` interface**: menos superficie de cambio, menos confusión con `ExecutorConfig`. El segundo param es solo `TaskStore | undefined`.

### 3.3. `ExecutorConfig` extendido (D3.1, no breaking)

```ts
// Campo nuevo
interface ExecutorConfig {
  // ... campos existentes D2a ...
  
  /**
   * D3.1: si true y hay TaskStore configurado, el executor persiste
   * la task en cada checkpoint (paused, completed, failed).
   * Si false o no hay store, el motor es single-process.
   * Default: false (conservador, no cambia comportamiento actual).
   */
  enablePersistence?: boolean;
}
```

### 3.4. `HITLHandler` extendido (D3.1, no breaking)

```ts
// D2a interface
interface HITLHandler {
  initiate(params: HITLInitiateParams): Promise<HITLInitiateResult>;
}

// D3.1: método opcional, no rompe implementaciones existentes
interface HITLHandler {
  initiate(params: HITLInitiateParams): Promise<HITLInitiateResult>;
  
  /**
   * D3.1: notifica al handler que una task paused_hitl fue recuperada
   * del TaskStore tras un restart. El handler decide qué hacer
   * (reenviar notificación al approver, marcar como expirada, etc.).
   *
   * Si no se implementa, el motor no notifica. Default: no-op.
   */
  onResumeFromRestart?(taskId: string, pending: PendingHITLDecision): void;
}
```

---

## 4. Estructura de archivos

### 4.1. Nuevos

| Archivo | Líneas est. | Propósito |
|---|---|---|
| `src/agent/workflow-engine/persistence/task-store.ts` | 60 | Interface `TaskStore` + tipos auxiliares. |
| `src/agent/workflow-engine/persistence/sqlite-task-store.ts` | 200 | Implementación SQLite usando `worgena.db`. |
| `src/agent/workflow-engine/persistence/in-memory-task-store.ts` | 50 | Implementación para tests. |
| `src/agent/workflow-engine/persistence/index.ts` | 15 | Barrel. |
| `src/agent/workflow-engine/persistence/migrations.ts` | 60 | Crea la tabla `paused_tasks` y aplica ALTERs idempotentes. |
| `test_workflow_d3_1.mts` | 300+ | Tests del sprint. |

### 4.2. Modificados (cambios mínimos, backward-compat)

| Archivo | Qué cambia |
|---|---|
| `src/agent/workflow-engine/dsl/types.ts` | Nada. Los tipos ya están. |
| `src/agent/workflow-engine/executor/types.ts` | Agregar `onResumeFromRestart?` a `HITLHandler`. |
| `src/agent/workflow-engine/executor/executor.ts` | Constructor acepta `options`. En cada transición de estado, si `enablePersistence && taskStore`, llamar `store.save(task)`. En el constructor, si `taskStore`, llamar `store.loadActive()` y re-hidratar. |
| `src/agent/workflow-engine/executor/node-runner.ts` | Nada. |
| `src/agent/workflow-engine/executor/index.ts` | Exportar `TaskStore` (re-export desde persistence). |
| `src/lib/db.ts` | NO se toca. La tabla `paused_tasks` la crea `persistence/migrations.ts` (mismo patrón lazy que el motor usa para workflow migrations). |

### 4.3. NO se tocan

- `src/agent/agent.ts` (loop de D1).
- `src/agent/tools.ts` (tools D1).
- `src/agent/memory.ts`.
- `src/agent/specialists/**` (D2b).
- `src/agent/skills/**` (D2c).
- `src/agent/llm/**` (D2b.2).
- `server.ts` (D2a.4 ya documentó que el motor no se cablea al server hasta D3.3+).

---

## 5. Migración de DB

D3.1 introduce 1 tabla nueva + 2 índices. La migración es **idempotente** (usa `CREATE TABLE IF NOT EXISTS` y `CREATE INDEX IF NOT EXISTS`, mismo patrón que `src/lib/db.ts`).

`persistence/migrations.ts`:

```ts
import type Database from "better-sqlite3";

export function runPersistenceMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS paused_tasks (
      task_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      workflow_id TEXT NOT NULL,
      workflow_version TEXT NOT NULL,
      status TEXT NOT NULL,
      current_node TEXT NOT NULL,
      state_json TEXT NOT NULL,
      node_results_json TEXT NOT NULL,
      pending_decision_json TEXT,
      migrated_workflow_json TEXT,
      applied_migrations_json TEXT,
      input_json TEXT NOT NULL,
      error_json TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      replay_of TEXT,
      replay_input_json TEXT,
      replay_from_node TEXT
    );

    CREATE INDEX IF NOT EXISTS paused_tasks_tenant_idx
      ON paused_tasks(tenant_id, status);
    CREATE INDEX IF NOT EXISTS paused_tasks_status_idx
      ON paused_tasks(status, updated_at);
  `);
}
```

Esta función se llama en el constructor de `SqliteTaskStore`. **No** en `src/lib/db.ts` — el motor no acopla a la DB global. La función recibe un `Database` inyectado (forward-compat con múltiples DBs por tenant en D3.2+).

---

## 6. Decisiones de implementación

### 6.1. Serialización: `JSON.stringify` con revivers custom

`Task` tiene campos como `Map`, `Date`, etc.? **No.** Mirando `dsl/types.ts`:

- `state`, `input`, `nodeResults`, `error`, `metadata`: `unknown` (JSON-safe por convención).
- `pendingDecision`, `migratedWorkflow`: objetos planos.
- `nodeResults[key].promptSnapshot`: strings.
- `nodeResults[key].tokensUsed`: `{input, output}` numérico.
- `nodeResults[key].error.stack`: string.
- Todos los timestamps: `string` ISO 8601.

`JSON.stringify` funciona sin revivers. `JSON.parse` revivifica.

**Forward-compat**: si en D3.3+ queremos guardar `Buffer` (raw prompts), agregamos un reviver. D3.1 no lo necesita.

### 6.2. `loadActive()` en el recovery: orden y transaccionalidad

El recovery hace:
1. `store.loadActive()` → array de tasks.
2. Por cada task, validar que su `workflowId`+`workflowVersion` siga disponible (sino, marcarla como `failed` con error `WORKFLOW_NOT_FOUND`).
3. Insertarla en el `Map<taskId, Task>` interno.
4. Si la task estaba `running` al crash, marcarla `paused_hitl` con un synthetic `pendingDecision` (ver §2.9).
5. Si la task estaba `paused_hitl`, llamar `handler.onResumeFromRestart?` si está configurado.

**No** se hace en una sola transacción de SQLite: cada `save` es atómico, pero el batch de load + mutate es lógico, no transaccional. Razón: si crashea a mitad del recovery, el siguiente startup re-corre el recovery. Las tasks ya persistidas se cargan de nuevo. Idempotente.

### 6.3. Forward-compat con multi-tenant: el `taskStore` recibe `tenantId`

**Decisión**: `TaskStore.save(task, tenantId?)` y `TaskStore.load(taskId, tenantId?)` reciben `tenantId` opcional desde D3.1. D3.1 lo lee de `task.tenantId` si no se pasa. D3.2 lo usa para filtrar.

**Razón**: la interface ya queda lista para D3.2 sin breaking change. D3.2 simplemente hace que las implementaciones chequeen `tenantId` en cada operación.

```ts
interface TaskStore {
  save(task: Task, tenantId?: string): void;
  load(taskId: string, tenantId?: string): Task | null;
  loadActive(tenantId?: string): readonly Task[];
  delete(taskId: string, tenantId?: string): void;
}
```

### 6.4. Logging estructurado en transiciones

**Decisión**: cada vez que el motor guarda en el `TaskStore`, loguea un evento estructurado con `taskId`, `status`, `trigger` (`"pause_hitl"`, `"resume"`, `"cancel"`, `"start"`, `"complete"`, `"fail"`).

**Razón**: el audit log del motor (D1, `step_logs`) es por LLM call. Las transiciones de estado de la task son otro eje. Logs estructurados en stdout permiten que D3.3 los pipeé a la DB de audit.

**Implementación**: usa el `logger` que ya está en el `ExecutorConfig`. Si no hay logger, no loguea (mismo patrón que el resto del motor).

---

## 7. Tests planeados (≥30 tests)

`test_workflow_d3_1.mts` (nuevo):

### Bloque A — InMemoryTaskStore (10 tests)

1. `save` + `load` roundtrip preserva todos los campos.
2. `save` de la misma taskId hace UPDATE (no INSERT duplicado).
3. `load` de task inexistente retorna null.
4. `loadActive` retorna solo no-terminales.
5. `loadActive` excluye `completed`, `failed`, `cancelled`.
6. `delete` elimina la task.
7. `delete` de task inexistente no lanza (idempotente).
8. `save` con `tenantId` persiste el campo.
9. `load` filtra por `tenantId` si se pasa.
10. Roundtrip preserva `pendingDecision` con `requestId` y `outputSchema`.

### Bloque B — SqliteTaskStore (8 tests, usan :memory:)

11. Inicialización crea la tabla idempotentemente.
12. Roundtrip con DB real (no memory) preserva state complejo.
13. Concurrencia: dos `save` simultáneos en tasks distintas, ambos commitean.
14. `loadActive` respeta índices (test con 1000 tasks, solo lee las no-terminales).
15. Recovery: tras `save` + cerrar DB + abrir nueva, `load` retorna la task.
16. WAL activo: `journal_mode = wal` verificado.
17. Foreign keys: paused_tasks no tiene FK a otras tablas (es intencional, ver §2.6).
18. Migrations idempotentes: 3 corridas consecutivas de `runPersistenceMigrations` no fallan.

### Bloque C — Recovery del WorkflowExecutor (8 tests)

19. Constructor con `taskStore` re-hidrata tasks `paused_hitl` en el `Map` interno.
20. Constructor sin `taskStore` no intenta recovery (modo legacy).
21. Task `running` al crash se re-hidrata como `paused_hitl` con synthetic `pendingDecision`.
22. Task `paused_hitl` re-hidratada llama `handler.onResumeFromRestart?` si está configurada.
23. Recovery con `workflowId` desconocido marca la task como `failed`.
24. Recovery preserva `pendingDecision.startedAt` (no se resetea).
25. Después del recovery, `resumeTask(taskId, response)` sigue funcionando.
26. `cleanup(taskId)` no elimina del store (verifica §2.7).

### Bloque D — Persistencia en checkpoints (8 tests)

27. `startTask` con `enablePersistence=true` persiste la task al store.
28. Transición `running → paused_hitl` persiste con `pendingDecision` lleno.
29. `resumeTask` con respuesta exitosa persiste con `status='running'`, sin `pendingDecision`.
30. `cancelTask` persiste con `status='cancelled'`.
31. `pauseForHITL` fallido (store.save lanza) NO muta la task en memoria (atomicidad).
32. Transición `running → completed` con `enablePersistence=true` elimina la task del store (D3.1 no persiste terminales, ver §2.1).
33. Sin `enablePersistence`, el motor no toca el store (modo legacy).
34. Transiciones a `failed` se persisten con `error_json` lleno.

### Bloque E — HITLHandler.onResumeFromRestart (4 tests)

35. Handler sin el método: recovery funciona, no se llama nada.
36. Handler con el método: se llama una vez por task paused_hitl recuperada.
37. Handler lanza: el recovery no se rompe (el error se loguea y se continúa).
38. El método recibe el `pendingDecision` completo (no solo el `requestId`).

**Total: 38 tests**. Cubre los 4 bloques de riesgo (storage, recovery, persistence, handler).

---

## 8. Decisiones con implicaciones futuras (registradas)

1. **JSON.stringify como serialización** (§6.1) — si en D3.3+ guardamos `Buffer` (raw prompts para audit forense), hay que migrar a una estrategia con revivers/custom serializer. Bajo costo.

2. **`TaskStore` recibe `tenantId` opcional** (§6.3) — la interface ya está lista para D3.2. D3.2 la enchufa en runtime. Si en D3.2 decidimos schema-per-tenant o DB-per-tenant, la signature se mantiene; la implementación cambia.

3. **`onResumeFromRestart` opcional en `HITLHandler`** (§3.4) — D3.3 enchufa el handler productivo. D3.1 no necesita implementación, solo el slot.

4. **`cleanup` no toca el store** (§2.7) — el caller debe llamar `purgeTask` explícitamente. D3.3 puede agregar un cron que purgue tasks canceladas hace >30 días.

5. **Sweeper de zombies** (§2.9) — D3.3 introduce `last_heartbeat_at` + cron. D3.1 deja el synthetic `pendingDecision` como señal "esto fue un crash, decidí qué hacer".

6. **NO se persisten tasks terminales** (§2.1) — si en D3.3 queremos historial de tasks para UI ("qué terminé hace 1h"), agregamos `persistOnCompletion: boolean` al `ExecutorConfig`. D3.1 no rompe.

7. **`enablePersistence` opt-in** (§3.3) — default `false` para no romper tests existentes. Forward-compat: en D3.3 podemos flipearlo a `true` para producción.

---

## 9. Lo que NO hace D3.1 (forward-compat)

- **D3.2**: multi-tenant real. `tenant_id` se usa en queries, wrapper `pool.queryFor(tenantId, sql, params)`, tests de aislamiento entre tenants. El `TaskStore` ya recibe `tenantId`, solo hay que enchufarlo.
- **D3.3**: auth de tenant (JWT o API key por firma), sweeper de zombies con `last_heartbeat_at`, audit log completo con `prompt_sent` y `raw_response` por Agent ID.
- **Postgres migration**: la interface `TaskStore` no acopla a SQLite. Migrar es swap de implementación.
- **Streaming de output**: nodos que emiten output incremental (D4+).
- **Multi-region / replicación**: forward, post-D6.
- **Encryption at rest**: SQLite no lo trae built-in. Forward, post-D6. Worgena-legal probablemente lo necesita.

---

## 10. Reversibilidad

Todas las decisiones son reversibles con `git revert` del sprint:

- `TaskStore` interface: si la rechazamos, el motor vuelve a `Map<>` en memoria (D2a).
- `SqliteTaskStore`: si lo rechazamos, `InMemoryTaskStore` sigue funcionando.
- `enablePersistence` default `false`: si flipeamos a `true` y rompe algo, revert del default.
- Schema: la tabla `paused_tasks` se queda. Si la decisión cambia (DB-per-tenant, schema-per-tenant, etc.), la tabla se mueve al nuevo schema. Migración de datos es post-D3.3.

---

## 11. Decisión sobre el sweeper de zombies (§2.9 reconsiderada)

**Decisión final**: D3.1 NO incluye sweeper. Las tasks `running` al momento del crash se re-hidratan como `paused_hitl` con un synthetic `pendingDecision.requestId = "synthetic-from-restart"`. El handler externo (cuando se implemente en D3.3) las trata como "el approver tiene X horas para responder; si no, timeout".

**Razón reconsiderada**: un sweeper que decida "esta running es zombie" requiere un heartbeat, lo que requiere otro mecanismo (lock distribuido, last_heartbeat_at, etc.). D3.1 no tiene ese mecanismo. Mejor dejar las tasks en un estado conocido (`paused_hitl`) que el caller puede inspeccionar, que inventar una heurística.

**Forward-compat**: el campo `pendingDecision.requestId = "synthetic-from-restart"` permite al handler productivo (D3.3) discriminar "esta pausa es de un crash, no notifiques al approver de nuevo" vs "esta pausa es normal, notifica".

---

## 12. Riesgos identificados

| Riesgo | Mitigación |
|---|---|
| SQLite se corrompe en el medio de una escritura | WAL activo + transactions. Si pasa, el recovery del siguiente startup detecta la task huérfana y la marca `failed`. El audit log queda con el error. |
| `state` con tipos no-JSON-safe (e.g., `Map`, `Date`) rompe `JSON.stringify` | D3.1 doc: el `state` debe ser JSON-safe. Si no lo es, `save` lanza. Forward-compat D3.3: revivers si guardamos `Buffer` u otros tipos. |
| Recovery carga 10k tasks y tarda 30s | D3.1 OK para <1000 tasks paused (esperado). Si pasa, paginar `loadActive` y cargar en chunks. Documentado en la interface. |
| `Map<>` interno del executor y `TaskStore` se desincronizan | El motor tiene UNA source of truth: la task en memoria. El `TaskStore` es proyección. Toda mutación va por el motor, no por el store directamente. |
| Tests D2a existentes rompen por nuevo `options?` param | El param es opcional. Tests sin `options` → comportamiento legacy. 130+ tests sin tocar. |

---

## 13. Criterio de cierre

- 38+ tests pasan, 0 fallidos, 0 regresiones en los 259 tests acumulados.
- `tsc --noEmit` limpio.
- `WorkflowExecutor` con y sin `TaskStore` funcionan (modo persistido + modo legacy).
- Recovery demostrado: persistir task paused, simular restart (cerrar DB, abrir nueva), verificar que la task se re-hidrata.
- HANDOFF.md actualizado con el cierre.

---

## 14. Referencias

- `AGENT_D2A_4_HITL_PRIMITIVES_SPEC.md` §4.1 — `pendingDecision` introducido en D2a.4.
- `AGENT_D2A_2_3_CORE_PRIMITIVES_SPEC.md` §7.4 — migración lazy al ejecutar.
- `AGENT_ROADMAP.md` §6 — roadmap D3.
- `HANDOFF.md` gotcha #9 — la deuda que cierra este sprint.
- `src/agent/workflow-engine/dsl/types.ts` — tipos `Task`, `PendingHITLDecision`.
- `src/lib/db.ts` — patrón de migraciones idempotentes.
- [better-sqlite3 docs](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md) — `db.transaction()`, prepared statements, WAL.
