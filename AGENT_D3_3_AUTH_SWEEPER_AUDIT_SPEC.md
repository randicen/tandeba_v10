# Worgena — D3.3: Auth Stub + Sweeper de Zombies + Audit del Workflow Engine

> **Sprint**: D3.3 (tercer y último de D3 partido en 3 sprints cortos).
> **Fecha**: 2026-06-13.
> **Status**: ✅ Cerrado.
> **Spec version**: 1.0.
>
> Este sprint cierra D3 con 3 entregables:
> 1. **`AuthProvider` interface** + `StaticTenantProvider` stub (no JWT, no login — la interface queda lista para D3.4+).
> 2. **Sweeper de zombies** con `last_heartbeat_at` (workaround para tasks `running` que quedaron a mitad de un crash).
> 3. **Audit del workflow engine**: tabla `workflow_audit` con eventos de lifecycle, integrado al motor.
>
> **Bonus del audit post-D3.2**: PK compuesto `(task_id, tenant_id)` en `paused_tasks` ya está aplicado (I-1 fix). D3.3 lo documenta formalmente.

---

## 1. Propósito y alcance

### 1.1. Qué resuelve

D3.3 cierra D3 con los 3 entregables que la auditoría post-D3.2 y el roadmap §6.3 identifican como fundamentales:

1. **Auth stub**: cómo el caller HTTP obtiene el `tenantId` del request. Hoy: hardcoded `'default'`. Mañana: el server.ts enchufa un `AuthProvider` real (JWT, session cookie, etc.) sin tocar el motor.
2. **Sweeper de zombies**: tasks en `running` que quedaron a mitad de un crash. Hoy: el recovery las re-mapea a `paused_hitl` sintética (D3.1 §2.3). Mañana: el sweeper **automáticamente** las marca como `paused_error` si el heartbeat tiene más de N minutos (default 30min).
3. **Audit del workflow engine**: tabla que registra eventos de lifecycle del motor (start, pause, resume, complete, fail, cancel, recovery, zombie_sweep). Hoy: no hay. Mañana: existe y se loguea.

### 1.2. Qué NO resuelve (forward-compat con D3.4+)

- **Auth real** (JWT, login, sesiones de usuario, middleware de auth). D3.3 define la INTERFACE, no la implementación. La implementación real es **D3.4 + D3.5** (ver `AGENT_D3_4_5_DB_AUTH_SPEC.md` v1.0, escrita 2026-06-14). Decisión: Better Auth + Google OAuth + SQLite, auth propio (no Clerk, no servicios externos).
- **Cron automático del sweeper** (que corra cada N minutos sin intervención). D3.3 expone el método `sweep()`; el server.ts lo invoca al startup. D3.4+ lo enchufa a un cron (`setInterval` o similar).
- **Audit de `prompt_sent` y `raw_response` del motor** (qué le dijimos al LLM y qué respondió). Eso ya está cubierto por `step_logs` de D1 para el loop agéntico. D3.4+ lo enchufa al motor si quiere.
- **Cifrado at rest / TLS / etc.**: forward, post-D6.
- **Rate limiting por tenant**: forward, post-D6.

### 1.3. Dependencias

- D3.1 + D3.2 cerrados (storage + multi-tenant enforcement).
- I-1 (audit fix) cerrado (PK compuesto en `paused_tasks`).
- `worgena.db` con SQLite + WAL.

### 1.4. Orden fundamental (regla 6b)

Para cada item: "¿qué se rompe si esto no está?".

- **`AuthProvider` interface** (D3.3): **fundamental arquitectónicamente**. Sin esto, el motor es single-tenant. **NO desbloquea funcionalidad**, pero la interface DEBE existir antes de que D3.4+ enchufe auth real.
- **Sweeper de zombies** (D3.3): **fundamental**. Las tasks `running` post-crash se acumulan. Hoy el recovery las re-mapea, pero el sweeper automático es lo que las cierra definitivamente.
- **Audit del workflow** (D3.3): **fundamental para legal-audit**. Worgena-legal es el caso de uso principal. Sin audit de eventos del motor, no hay trazabilidad forense.

---

## 2. Decisiones de diseño

### 2.1. `AuthProvider` interface, no auth real

**Decisión**: el motor acepta un `AuthProvider` en el constructor. La interface tiene UN método: `getTenantId(): string | Promise<string>`. La implementación stub `StaticTenantProvider` retorna `'default'` siempre.

```ts
interface AuthProvider {
  getTenantId(): string | Promise<string>;
}

class StaticTenantProvider implements AuthProvider {
  constructor(private readonly tenantId: string = "default") {}
  getTenantId(): string { return this.tenantId; }
}
```

**Razón**: D3.3 no puede implementar JWT/login (es un proyecto entero). Pero la interface DEBE existir para que D3.4+ enchufe el real. **El motor es provider-agnostic, el server.ts es responsable del provider.**

**Forward-compat con D3.4+**: `JwtAuthProvider` lee el JWT del request, lo valida, extrae el `tenantId` (claim custom) o el `userId` y mapea a tenantId via una tabla de usuarios. El motor no cambia.

**Trade-off**: el server.ts actual NO usa auth. **D3.3 NO enchufa el server.ts al motor** — eso queda para D3.4+. El motor tiene la interface, el `main()` del motor puede usar `StaticTenantProvider('default')` para dev.

### 2.2. Sweeper automático al startup, NO cron

**Decisión**: `executor.sweepStaleTasks(maxAgeMs)` itera tasks en `running` con `last_heartbeat_at` viejo y las marca `paused_error`. **El server.ts lo invoca al startup** (después del recovery, antes de aceptar requests).

```ts
executor.sweepStaleTasks(30 * 60 * 1000); // 30 min default
```

**Razón**: un cron es infra (systemd, node-cron, k8s CronJob). D3.3 no puede decidir dónde corre. **El server.ts decide la cadencia** (al startup es suficiente para dev/staging; D3.4+ enchufa cron).

**Forward-compat**: la firma es sync y stateless. D3.4+ puede llamarlo desde `setInterval` sin cambios.

**Decisión clave**: el sweeper **NO borra** tasks. Las marca `paused_error` con un `error.code: "ZOMBIE_SWEEP"`. El audit log lo registra. El caller (D3.4+ server.ts) puede decidir qué hacer después (notificar al approver, llamar a `cancelTask`, etc.).

### 2.3. `last_heartbeat_at` se actualiza en cada `persistCheckpoint`

**Decisión**: el motor llama `taskStore.touch(taskId, tenantId)` después de cada checkpoint. Esto actualiza `last_heartbeat_at = NOW()` en una fila separada (o en la misma fila de `paused_tasks` con un campo nuevo).

**Razón**: el sweeper necesita saber cuándo fue la última actividad de una task. Sin `last_heartbeat_at`, el sweeper no distingue "running 3 horas" de "running 3 segundos".

**Decisión arquitectónica**: agrego columna `last_heartbeat_at INTEGER` a `paused_tasks` (timestamp Unix en ms, no ISO). Es más eficiente para `WHERE last_heartbeat_at < ?`. Forward-compat: en Postgres sería `BIGINT`.

**Forward-compat con recovery**: el recovery D3.1 ya setea `task.updatedAt`. El sweep usa `last_heartbeat_at` (campo separado) para distinguir "última actividad real" de "última mutación sintética del recovery".

### 2.4. `workflow_audit` tabla liviana

**Decisión**: tabla nueva `workflow_audit` con schema minimal:

```sql
CREATE TABLE workflow_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  event_type TEXT NOT NULL,  -- 'start' | 'pause_hitl' | 'resume' | 'complete' | 'fail' | 'cancel' | 'recovery' | 'zombie_sweep'
  payload_json TEXT,          -- opcional, JSON con contexto del evento
  created_at INTEGER NOT NULL -- Unix ms
);
CREATE INDEX workflow_audit_tenant_idx ON workflow_audit(tenant_id, created_at);
CREATE INDEX workflow_audit_task_idx ON workflow_audit(task_id, created_at);
```

**Razón**: el audit actual (`step_logs`, `tool_calls`, `apify_usage`) es del LOOP de D1. El motor Capa 1 NO tiene audit. **Esta tabla es específica del motor**, y registra los eventos de lifecycle (start, pause, resume, complete, fail, cancel).

**Lo que NO se loguea en `workflow_audit`** (forward-compat con D3.4+):
- `prompt_sent` / `raw_response`: ya está en `step_logs` de D1 para el loop. Si D3.4+ quiere para el motor, lo enchufa.
- `state_json` completo: podría ser muy grande. Solo se loguea el delta (qué cambió).

**Forward-compat**: en D3.4+ se puede agregar una tabla `workflow_audit_payload` con el cuerpo completo si se necesita forense profunda. D3.3 solo registra el evento + metadata ligera.

### 2.5. Sweeper de zombies: una pasada, no loop infinito

**Decisión**: `sweepStaleTasks` itera UNA vez sobre las tasks en `running` con `last_heartbeat_at` viejo. Si una task ya está marcada `paused_error` por el sweeper, no la vuelve a marcar (idempotente).

```ts
// pseudocódigo
for (task in store.loadActive('tenantId')) {
  if (task.status !== 'running') continue;
  if (Date.now() - task.lastHeartbeatAt < maxAgeMs) continue;
  task.status = 'paused_error';
  task.error = { code: 'ZOMBIE_SWEEP', message: '...', ... };
  store.save(task, tenantId);
  this.audit.record('zombie_sweep', task);
}
```

**Razón**: simple, predecible, fácil de testear. El caller decide cuándo llamarlo.

### 2.6. `last_heartbeat_at` NO se persiste en cada nodo (caro)

**Decisión**: el `last_heartbeat_at` se actualiza **solo en `persistCheckpoint`** (D3.1), no en cada nodo. Es un write extra por checkpoint, no por nodo.

**Razón**: `persistCheckpoint` ya es 1 write. Agregar 1 campo más al `UPDATE` es trivial. En cambio, agregar heartbeat por nodo (que puede ser cientos en una workflow larga) sería IO innecesario.

**Trade-off**: si un nodo LLM tarda 10 minutos, el `last_heartbeat_at` no se actualiza durante esos 10 minutos. El sweeper usa el ULTIMO checkpoint como referencia. **Si el workflow corre sin checkpoints por más de 30min, el sweeper lo marca como zombie prematuramente.** Esto es un trade-off documentado. Forward-compat: si en D3.4+ hay workflows largas (>30min entre checkpoints), se baja el threshold o se enchufa un heartbeat por nodo opcional.

### 2.7. NO se introduce `pauseForError` automático (decisión del caller)

**Decisión**: el sweeper marca `paused_error`. NO llama a `cancelTask` ni notifica al approver. El caller (D3.4+ server.ts) decide qué hacer.

**Razón**: el sweeper es una herramienta. Las acciones (notificar, cancelar, reintentar) son policy. La policy la decide el caller, no el motor. **Separation of concerns.**

### 2.8. `WorkflowAudit` interface, no tabla hardcoded

**Decisión**: el motor interactúa con el audit via interface `WorkflowAudit`:

```ts
interface WorkflowAudit {
  record(event: AuditEvent): void;
}

type AuditEvent = {
  tenantId: string;
  taskId: string;
  eventType: 'start' | 'pause_hitl' | 'resume' | 'complete' | 'fail' | 'cancel' | 'recovery' | 'zombie_sweep';
  payload?: Record<string, unknown>;
  createdAt: number; // Unix ms
};
```

`SqliteWorkflowAudit` es la implementación que escribe a la tabla `workflow_audit`. `InMemoryWorkflowAudit` es para tests.

**Forward-compat con D3.4+**: si se quiere mandar a un servicio externo (Datadog, Sentry, custom), se implementa `DatadogWorkflowAudit` y se inyecta. El motor no cambia.

### 2.9. `startTask` con `tenantId` custom

**Decisión**: el constructor del motor acepta un `authProvider`. `startTask` lo usa para setear `task.tenantId`. Pero `startTask` también acepta un param opcional `tenantId?: string` que pisa el del provider (útil para tests, admin, migraciones).

```ts
startTask(workflow, input, { tenantId?: string }): Task
```

**Razón**: el caso normal es "el provider sabe el tenant". El override es para casos especiales (tests, admin D3.3+, migraciones D3.4+).

**Backward-compat**: el `startTask` actual de D2a es `startTask(workflow, input): Task`. D3.3 lo extiende con un 3er param opcional. Cero cambios al interface público actual.

### 2.10. El sweeper se ejecuta DESPUÉS del recovery, no antes

**Decisión**: orden de operaciones en el constructor del `WorkflowExecutor`:

1. `recoverActiveTasks(taskStore, recoveryTenantIds)` — re-hidrata tasks paused.
2. Si `enablePersistence && authProvider`: `sweepStaleTasks(30min)` — barre zombies.
3. Listo para aceptar requests.

**Razón**: si el sweeper corre antes del recovery, podría marcar como zombie una task que el recovery iba a re-hidratar. **Orden importa.**

---

## 3. API

### 3.1. `AuthProvider` interface (nueva)

`src/agent/workflow-engine/persistence/auth-provider.ts`:

```ts
/**
 * D3.3: provee el `tenantId` del request al motor.
 * El server.ts es responsable de inyectar la implementación real.
 *
 * Hoy: `StaticTenantProvider('default')` hardcoded.
 * Mañana (D3.4+): `JwtAuthProvider` lee el JWT del request.
 */
export interface AuthProvider {
  getTenantId(): string | Promise<string>;
}

export class StaticTenantProvider implements AuthProvider {
  constructor(private readonly tenantId: string = "default") {}
  getTenantId(): string { return this.tenantId; }
}
```

### 3.2. `WorkflowAudit` interface (nueva)

`src/agent/workflow-engine/persistence/workflow-audit.ts`:

```ts
export type WorkflowAuditEventType =
  | "start" | "pause_hitl" | "resume" | "complete"
  | "fail" | "cancel" | "recovery" | "zombie_sweep";

export interface WorkflowAuditEvent {
  readonly tenantId: string;
  readonly taskId: string;
  readonly eventType: WorkflowAuditEventType;
  readonly payload?: Record<string, unknown>;
  readonly createdAt: number;
}

export interface WorkflowAudit {
  record(event: WorkflowAuditEvent): void;
}
```

### 3.3. `TaskStore` extendido (D3.3, no breaking)

```ts
interface TaskStore {
  save(task, tenantId): void;
  load(taskId, tenantId): Task | null;
  loadActive(tenantId): readonly Task[];
  delete(taskId, tenantId): void;
  // D3.3 nuevo: actualiza last_heartbeat_at de una task.
  // Si la task no existe o es de otro tenant, no-op (idempotente).
  touch(taskId: string, tenantId: string): void;
}
```

### 3.4. `WorkflowExecutor` constructor (D3.3, no breaking)

```ts
// D3.2 (existente)
new WorkflowExecutor(
  config: ExecutorConfig,
  taskStore?: TaskStore,
  recoveryTenantIds?: readonly string[],
);

// D3.3 (extendido, no breaking)
new WorkflowExecutor(
  config: ExecutorConfig,
  taskStore?: TaskStore,
  recoveryTenantIds?: readonly string[],
  authProvider?: AuthProvider,        // D3.3 nuevo
  audit?: WorkflowAudit,              // D3.3 nuevo
);
```

### 3.5. `executor.sweepStaleTasks(maxAgeMs)` (nuevo)

```ts
/**
 * Barre tasks en `running` con `last_heartbeat_at` viejo.
 * Las marca como `paused_error` con `error.code = "ZOMBIE_SWEEP"`.
 * Idempotente. Retorna el número de tasks barreadas.
 */
sweepStaleTasks(maxAgeMs: number = 30 * 60 * 1000): number;
```

### 3.6. `executor.startTask` con tenantId custom (D3.3, no breaking)

```ts
// D3.2 (existente)
startTask(workflow, input): Task;

// D3.3 (extendido)
startTask(workflow, input, options?: { tenantId?: string }): Task;
```

---

## 4. Estructura de archivos

### 4.1. Nuevos

| Archivo | Líneas est. | Propósito |
|---|---|---|
| `src/agent/workflow-engine/persistence/auth-provider.ts` | 40 | `AuthProvider` interface + `StaticTenantProvider`. |
| `src/agent/workflow-engine/persistence/workflow-audit.ts` | 60 | `WorkflowAudit` interface + `WorkflowAuditEvent` type. |
| `src/agent/workflow-engine/persistence/sqlite-workflow-audit.ts` | 100 | Implementación SQLite. |
| `src/agent/workflow-engine/persistence/in-memory-workflow-audit.ts` | 30 | Para tests. |
| `test_workflow_d3_3.mts` | 350+ | Tests del sprint. |

### 4.2. Modificados

| Archivo | Qué cambia |
|---|---|
| `src/agent/workflow-engine/persistence/task-store.ts` | +`touch()` method. |
| `src/agent/workflow-engine/persistence/sqlite-task-store.ts` | +`touchStmt`. Columna `last_heartbeat_at` en tabla. |
| `src/agent/workflow-engine/persistence/in-memory-task-store.ts` | +`touch()` method. |
| `src/agent/workflow-engine/persistence/migrations.ts` | +columna `last_heartbeat_at`. +tabla `workflow_audit`. |
| `src/agent/workflow-engine/persistence/index.ts` | Re-exports. |
| `src/agent/workflow-engine/executor/executor.ts` | +3er y 4to param al constructor. +`sweepStaleTasks()`. +audit en cada persist. +`startTask` con `tenantId` custom. +reorder recovery → sweep. |
| `src/agent/workflow-engine/executor/index.ts` | Re-exports. |
| `test_workflow_d3_1.mts` | +`touch()` tests (D3.3). Backward-compat. |
| `test_workflow_d3_2.mts` | +`touch()` + sweeper tests. Backward-compat. |

### 4.3. NO se tocan

- `src/agent/agent.ts` (loop D1, D3.4+).
- `src/agent/skills/**`, `src/agent/specialists/**`, `src/agent/llm/**`.
- `src/lib/db.ts` (la tabla `workflow_audit` la crea `persistence/migrations.ts`).
- `server.ts` (D3.4+ enchufa el motor al server).

---

## 5. Decisiones de implementación

### 5.1. `last_heartbeat_at` como INTEGER (Unix ms)

`paused_tasks.last_heartbeat_at INTEGER` (no ISO string). Razón: queries de comparación (`WHERE last_heartbeat_at < ?`) son más rápidas con INTEGER. Y el código del motor no necesita formatear a string.

### 5.2. `touch()` no falla si la task no existe

Si `touch(taskId, tenantId)` se llama con un taskId que no existe en el store, no lanza. Es idempotente. Forward-compat: el motor puede llamar a `touch` en cada checkpoint sin chequear existencia primero.

### 5.3. Sweeper corre DESPUÉS del recovery (orden)

`new WorkflowExecutor(...)` ejecuta:
1. `this.recoverActiveTasks(...)` — re-hidrata tasks paused.
2. Si `authProvider` está presente: `this.sweepStaleTasks(30min)` — barre zombies.
3. Listo.

Si el sweeper corre antes, podría pisar tasks que el recovery iba a re-hidratar. **Orden importa.**

### 5.4. Sweeper es opcional (default off)

Si el constructor no recibe `audit` ni `authProvider`, el sweeper no corre. Backward-compat 100% con tests existentes. Los tests D3.3 lo activan explícitamente.

### 5.5. `WorkflowAudit` no bloquea el motor

Si `audit.record()` lanza (e.g., DB lock), el motor **NO** captura el error. Loguea con `error()` y sigue. **El audit es secundario; el motor es primario.** Forward-compat: si el audit es crítico, se enchufa un queue persistente en D3.4+.

### 5.6. `startTask` con `tenantId` custom: solo si difiere del provider

Si `options.tenantId` es distinto del `authProvider.getTenantId()`, el motor lo acepta con un warning. Es para admin/tests. En producción, el caller no debería override.

---

## 6. Decisiones con implicaciones futuras (registradas)

1. **`AuthProvider` interface mínimo** (§2.1) — D3.4+ enchufa JWT/session. El motor no cambia.
2. **Sweeper al startup, no cron** (§2.2) — D3.4+ enchufa cron. El motor no cambia.
3. **`last_heartbeat_at` por checkpoint, no por nodo** (§2.6) — trade-off documentado. Si workflows >30min entre checkpoints, D3.4+ ajusta.
4. **`workflow_audit` sin `prompt_sent`/`raw_response`** (§2.4) — el audit del motor es LIVIANO. Forense profunda es D3.4+.
5. **Sweeper marca `paused_error`, no cancela** (§2.7) — el caller decide la policy.
6. **`WorkflowAudit` interface, no hardcoded** (§2.8) — forward-compat con servicios externos.
7. **`startTask` con override de tenantId** (§2.9) — solo para admin/tests. Caller normal usa el provider.
8. **Sweeper no bloquea, no captura errores** (§5.5) — audit es secundario, motor es primario.

---

## 7. Lo que NO hace D3.3 (forward-compat)

- **D3.4+**: auth real (JWT/login/session), cron del sweeper, audit forense profundo, rate limiting por tenant, integración con motor de D1 (queries `messages`/`step_logs`/`tool_calls`/`apify_usage` con `tenant_id`).
- **Postgres migration**: la interface `TaskStore`/`WorkflowAudit` no acopla a SQLite. Migrar es swap de implementación.
- **Encryption at rest**: forward, post-D6.

---

## 8. Reversibilidad

- `AuthProvider` interface: revertible (quitar el param del constructor, default hardcoded a `'default'`).
- Sweeper: revertible (no llamar `sweepStaleTasks` en el constructor).
- `touch()` en TaskStore: revertible (no llamar en el motor).
- `workflow_audit` tabla: aditiva, se puede dejar aunque no se use.
- `last_heartbeat_at` columna: aditiva, se puede dejar.

---

## 9. Criterio de cierre

- 25+ tests pasan, 0 fallidos, 0 regresiones en los 291 tests acumulados.
- `tsc --noEmit` sin errores nuevos en código D3.3.
- `AuthProvider` interface y `StaticTenantProvider` implementados.
- Sweeper marca zombies correctamente.
- `workflow_audit` tabla se crea y se popula.
- `touch()` se llama en cada `persistCheckpoint`.
- HANDOFF.md actualizado con el cierre.

---

## 10. Riesgos identificados

| Riesgo | Mitigación |
|---|---|
| Sweeper marca zombie prematuramente (workflow >30min entre checkpoints) | Documentado. D3.4+ ajusta threshold o enchufa heartbeat por nodo. |
| `audit.record()` lanza y bloquea el motor | Try/catch interno: loguea, sigue. |
| `last_heartbeat_at` no se actualiza en nodos largos | Aceptado: el sweeper es "best effort". El recovery los re-mapea a `paused_hitl` si crash. |
| Caller (server.ts) no enchufa el `AuthProvider` | El motor default a `StaticTenantProvider('default')`. Backward-compat. |
| Sweeper corre en producción con 0 tasks paused | Loop vacío, no overhead. |

---

## 11. Tests planeados (≥25)

`test_workflow_d3_3.mts`:

### Bloque A — `AuthProvider` (5 tests)
- A1: `StaticTenantProvider` retorna tenantId.
- A2: `StaticTenantProvider('custom')` retorna custom.
- A3: `AuthProvider` interface es estructural (mock implementa).
- A4: `getTenantId` puede ser sync (string) o async (Promise<string>).
- A5: `startTask` lee tenantId del provider.

### Bloque B — Sweeper de zombies (8 tests)
- B6: `sweepStaleTasks` con 0 tasks: retorna 0.
- B7: `sweepStaleTasks` con task en `running` con `last_heartbeat_at` viejo: la marca `paused_error`.
- B8: `sweepStaleTasks` con task en `running` con `last_heartbeat_at` reciente: la deja.
- B9: `sweepStaleTasks` con task en `paused_hitl`: NO la toca.
- B10: `sweepStaleTasks` con task zombie: emite evento `zombie_sweep` al audit.
- B11: `sweepStaleTasks` cross-tenant: no toca otras tasks.
- B12: `sweepStaleTasks` idempotente: 2da llamada no hace nada.
- B13: `sweepStaleTasks` con `maxAgeMs=0`: barre todas las running.

### Bloque C — `last_heartbeat_at` (5 tests)
- C14: `touch()` actualiza `last_heartbeat_at` de la task.
- C15: `touch()` no-op si la task no existe.
- C16: `touch()` no-op cross-tenant.
- C17: `persistCheckpoint` llama `touch()` después del save.
- C18: `touch()` en DB preserva el campo entre reads.

### Bloque D — `workflow_audit` (5 tests)
- D19: Audit registra evento `start` al `startTask`.
- D20: Audit registra evento `pause_hitl` al `pauseForHITL`.
- D21: Audit registra evento `complete` al completar.
- D22: Audit registra evento `zombie_sweep` al sweeper.
- D23: Audit no bloquea el motor si `record()` lanza.

### Bloque E — Integración (5 tests)
- E24: Recovery → Sweep ordering: sweep corre DESPUÉS del recovery.
- E25: `startTask` con `options.tenantId` custom: pisa el del provider.
- E26: Sin `authProvider` ni `audit`: sweeper no corre, motor funciona legacy.
- E27: Sweeper con `audit` no provisto: warning logueado, sweeper sigue.
- E28: `touch()` en DB SQLite: query `SELECT last_heartbeat_at` retorna el valor actualizado.

**Total: 28 tests.**

---

## 12. Referencias

- `AGENT_D3_1_STORAGE_PERSISTENCE_SPEC.md` — storage.
- `AGENT_D3_2_MULTI_TENANT_SPEC.md` — multi-tenant enforcement + I-1 fix (PK compuesto).
- `AGENT_D2A_2_3_CORE_PRIMITIVES_SPEC.md` §7 — sweeper original como "D3+".
- `AGENT_ROADMAP.md` §6 — D3 sprint breakdown.
- `HANDOFF.md` — sprint order y gotchas.
- `src/lib/db.ts` — patrón de migraciones idempotentes.
- `src/agent/logger.ts` — patrón de audit (`step_logs`).
