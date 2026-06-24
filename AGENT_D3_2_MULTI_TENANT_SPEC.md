# Worgena — D3.2: Multi-Tenant Schema + Enforcement en TaskStore

> **Sprint**: D3.2 (segundo de D3 partido en 3 sprints cortos).
> **Fecha**: 2026-06-13.
> **Status**: ✅ Cerrado.
> **Spec version**: 1.0.
>
> Este sprint activa el `tenant_id` que D3.1 ya tenía como columna en `paused_tasks` pero NO enforzaba. D3.2 introduce el wrapper `queryFor(tenantId, sql, params)` en la DB layer y el enforcement real en `TaskStore.load/loadActive/delete`.

---

## 1. Propósito y alcance

### 1.1. Qué resuelve

D3.1 dejó la columna `tenant_id` en `paused_tasks` y la interface `TaskStore` ya recibe `tenantId` opcional. Pero el **enforcement real** es no-op: si un caller lee cross-tenant, no falla, retorna `null` por convención (defensivo, no estricto).

D3.2 introduce:

1. **Migración de columna `tenant_id` en el resto de las tablas** del motor que aún no la tienen. Esto es forward-compat con D3.3 (auth) — la columna existe, solo falta el chequeo.
2. **Wrapper `queryFor(tenantId, sql, params)` en `src/lib/db.ts`** que **fuerza** el `WHERE tenant_id = ?` en SELECTs y el `tenant_id = ?` en INSERTs/UPDATEs. **Falla loud** si la query no menciona `tenant_id` (no aplica parche mágico).
3. **Enforcement estricto en `TaskStore`**: `load`/`loadActive`/`delete` **requieren** `tenantId` (param no opcional). Si llega `undefined`, throw.

### 1.2. Qué NO resuelve (forward-compat con D3.3)

- **Auth real** (D3.3): cómo se obtiene el `tenantId` del request. JWT, API key por firma, sesión, etc. D3.2 solo **enchufa** el enforcement; la fuente del `tenantId` la define D3.3.
- **Multi-tenant en `agent.ts` (loop D1)**: las queries a `sessions`, `messages`, `step_logs`, `tool_calls` no se migran en D3.2. Razón explicada en §1.4.
- **Audit log completo** (D3.3): la tabla `audit_runs` y el desglose por Agent ID.
- **Sweeper de zombies** (D3.3).
- **Migración de tasks de tenants viejos a nuevos**: si un cliente cambia de `tenant_id`, las tasks se quedan en el tenant original. Out of scope D3.2.

### 1.3. Dependencias

- D3.1 cerrado (la columna `tenant_id` ya está en `paused_tasks`).
- `worgena.db` con SQLite + WAL.

### 1.4. Orden fundamental (regla 6b)

Para cada item: "¿qué se rompe si esto no está?".

- **`tenant_id` en `paused_tasks` enforcement** (D3.2): **fundamental**. Sin esto, dos firmas distintas podrían leer las tasks paused_hitl de la otra. **Riesgo legal real** (comparten DB).
- **`tenant_id` columna en `sessions`/`spaces`/`messages`/etc.**: **fundamental arquitectónicamente**, pero **NO rompe nada funcionalmente** hoy (no hay auth de tenant). Es forward-compat puro.
- **Migrar queries de `agent.ts` a usar `queryFor`**: **no fundamental hoy**. Diferir a D3.3 cuando entre auth y el enforcement sea bloqueante.
- **Wrapper `queryFor` con auto-inyección SQL**: **no fundamental**. Es un buen patrón, pero el enforcement de `TaskStore` se puede hacer sin él (es 1 store, no 51 queries).

**Decisión**: D3.2 hace solo (1) enforcement en `TaskStore` + (2) columna `tenant_id` en `sessions`/`spaces` (las 2 tablas del dominio donde multi-tenant es más urgente porque son las que el usuario ve primero). D3.3 migra el resto + auth + sweeper + audit.

---

## 2. Decisiones de diseño

### 2.1. `tenantId` ahora es OBLIGATORIO en `TaskStore`

**Decisión**: la interface `TaskStore` cambia:

```ts
// D3.1 (deprecated, queda en overloads opcionales)
save(task: Task, tenantId?: string): void;
load(taskId: string, tenantId?: string): Task | null;
loadActive(tenantId?: string): readonly Task[];
delete(taskId: string, tenantId?: string): void;

// D3.2 (strict)
save(task: Task, tenantId: string): void;       // tenantId required
load(taskId: string, tenantId: string): Task | null;  // tenantId required
loadActive(tenantId: string): readonly Task[];  // tenantId required
delete(taskId: string, tenantId: string): void;  // tenantId required
```

**Razón**: D3.1 dejó `tenantId?` opcional para backward-compat con tests D2a. D3.2 quita el opcional: si llega `undefined`, **throw `MissingTenantIdError`**. El motor es el único caller (en `executor.persistCheckpoint(task, trigger)`), lee `task.tenantId` y lo pasa. Si una task llega sin `tenantId`, es bug nuestro.

**Breaking**: tests que llaman `store.save(task)` sin `tenantId` rompen. **Los arreglo en este sprint** (4 ocurrencias en `test_workflow_d3_1.mts`).

**Forward-compat**: si en D3.3+ queremos un "super-admin" que lea cross-tenant, agregamos `loadCrossTenant(taskId)` con un nombre explícito que requiera permisos elevados. **No** dejamos el `tenantId?` opcional como backdoor.

### 2.2. `tenantId` del task, no del param, es la fuente de verdad

**Decisión**: el motor **SIEMPRE** lee `task.tenantId` y lo pasa a `store.save`. El param `tenantId` que acepta `TaskStore` es **solo** para los casos donde el caller quiere pisar el de la task (típicamente tests, o D3.3+ cuando se migra una task de un tenant a otro).

**Razón**: simplifica el contrato. El motor tiene UNA task, UN tenantId. El param extra es para casos raros.

**Riesgo de confusión**: si en `TaskStore.save(task, tenantId)` los dos difieren, ¿cuál gana? **Gana el param**, con un warning logueado. El motor nunca debería pasar un `tenantId` distinto al de la task.

### 2.3. Migración de `sessions` y `spaces`: `tenant_id TEXT NOT NULL DEFAULT 'default'`

**Decisión**: agregar columna `tenant_id` a las 2 tablas más urgentes (sessions, spaces) con `NOT NULL DEFAULT 'default'`. Las filas existentes reciben `'default'`. Forward-compat: D3.3 hace que el `default` desaparezca cuando entre auth.

**Razón**: idéntico a D3.1 §2.5 con `paused_tasks`. Prefijar el schema ahora evita una migración más adelante.

**Tablas NO migradas en D3.2** (forward-compat con D3.3):
- `messages`: tiene FK a `sessions`, que tendrá `tenant_id`. La columna se puede derivar del join. D3.3 lo decide.
- `core_memory`, `episodic_memory_v2`: memoria del loop D1. D3.3+ con RAG multi-tenant.
- `step_logs`, `tool_calls`: audit del loop D1. D3.3+ con audit multi-tenant.
- `message_summaries`: tiene FK a `sessions`. Mismo caso que `messages`.
- `apify_usage`: tiene FK a `sessions`. Mismo caso.

**Razón del recorte**: las queries a `messages`, `step_logs`, etc. son del loop D1 (`agent.ts`), no del motor Capa 1. El motor Capa 1 (workflow engine) NO las toca. **D3.2 se enfoca en lo que el motor ACKs**: `paused_tasks` (D3.1) + `sessions`/`spaces` (D3.2, porque son el entry point del producto).

### 2.4. Wrapper `queryFor(tenantId, sql, params)` — DECIDIDO NO implementar en D3.2

**Decisión**: D3.2 **NO introduce** el wrapper `queryFor` automático. Razón: el auto-parse de SQL para inyectar `WHERE tenant_id = ?` es frágil (cualquier string concat con `?` o comentario rompe el parser), y el codebase tiene 51 queries con patrones heterogéneos. **El costo > el beneficio**.

**Forward-compat**: si D3.3+ lo necesita (e.g., para 100+ queries), se introduce con una librería como `sql-template-tag` o un parser custom pequeño. D3.2 mantiene el status quo en `pool.query`.

**Razón reconsiderada**: estuve a punto de meter el wrapper. Lo descarté porque (1) el spec es grande de por sí, (2) el enforcement de `TaskStore` cubre el riesgo legal-audit (tasks paused), y (3) el resto del codebase no es fundamental para D3.2.

### 2.5. `MissingTenantIdError` como error tipado

**Decisión**: si `TaskStore.save/load/loadActive/delete` recibe `tenantId === undefined`, throw:

```ts
class MissingTenantIdError extends Error {
  constructor(method: string) {
    super(
      `TaskStore.${method}() requiere tenantId (D3.2 strict). ` +
      `Pasá task.tenantId o un string explícito. ` +
      `Para acceso cross-tenant (admin), usá store.loadCrossTenant(taskId) — D3.3+.`
    );
    this.name = "MissingTenantIdError";
  }
}
```

**Razón**: falla loud, mensaje claro, apunta a la solución (D3.3 admin). Si un dev futuro escribe código que olvida el tenantId, el error es explícito.

### 2.6. Backward-compat con tests D2a: el motor acepta `tenantId: 'default'`

**Decisión**: el `WorkflowExecutor` (y todos sus callers) usan `task.tenantId`. Si la task tiene `tenantId: 'default'` (legacy), funciona. Si tiene cualquier otro valor, también.

**Razón**: cero cambios al motor. La interface `Task.tenantId: string` ya existe desde D2a. El `TaskStore` solo valida que el motor lo pase.

### 2.7. NO se cambia la forma de obtener `tenantId` (eso es D3.3)

**Decisión**: D3.2 NO introduce cómo el caller HTTP obtiene el `tenantId` del request. El motor sigue recibiendo tasks con `tenantId` ya seteado (por D1, que lo hardcodea a `'default'`).

**Razón**: el motor no sabe de HTTP. El `tenantId` se inyecta en la task al construirla (`startTask(workflow, input, { tenantId: 'acme' })` en D3.3, no D3.2). Hoy, `startTask(workflow, input)` setea `tenantId: 'default'` automáticamente.

### 2.8. SQL injection: status quo

**Decisión**: el wrapper `queryFor` no se introduce (decisión 2.4), así que el patrón "concatenar strings" sigue siendo el riesgo. **D3.2 NO agrega防御 contra SQL injection** — eso ya es responsabilidad de cada query (todas son prepared statements hoy).

**Forward-compat**: si D3.3 introduce un wrapper, ese wrapper debe rechazar SQL con concatenación de strings. Pero eso es problema de D3.3.

### 2.9. `InMemoryTaskStore` y `SqliteTaskStore` ambos cumplen la interface estricta

**Decisión**: ambas implementaciones actualizan su signature. `InMemoryTaskStore` ya filtra por tenant en `load`/`loadActive`/`delete`. `SqliteTaskStore` ya filtra en `load` (línea 112), `delete` (línea 131), y `loadActive` (línea 121-123). Solo falta **hacer el param obligatorio** y agregar el check de `MissingTenantIdError`.

### 2.10. `cleanup()` no cambia

`cleanup` ya no tocaba el store en D3.1. Sigue igual. D3.2 no lo toca.

---

## 3. API

### 3.1. `TaskStore` interface (estricta)

`src/agent/workflow-engine/persistence/task-store.ts`:

```ts
export interface TaskStore {
  /**
   * D3.2: tenantId OBLIGATORIO. Si llega undefined, throw MissingTenantIdError.
   * El motor lee task.tenantId y lo pasa.
   *
   * Si tenantId !== task.tenantId, gana tenantId (con warning).
   */
  save(task: Task, tenantId: string): void;

  /**
   * D3.2: tenantId OBLIGATORIO. Filtra por tenant.
   * Retorna null si la task no existe O si pertenece a otro tenant
   * (mismo resultado para no leak de existencia cross-tenant).
   */
  load(taskId: string, tenantId: string): Task | null;

  /**
   * D3.2: tenantId OBLIGATORIO. Retorna SOLO tasks del tenant.
   */
  loadActive(tenantId: string): readonly Task[];

  /**
   * D3.2: tenantId OBLIGATORIO. No-op si la task es de otro tenant
   * (idempotente, no leak).
   */
  delete(taskId: string, tenantId: string): void;
}

export class MissingTenantIdError extends Error { /* ... */ }
```

### 3.2. `WorkflowExecutor` (sin cambios al interface público)

El motor lee `task.tenantId` y lo pasa. **Cero cambios al interface público**. Los tests existentes siguen funcionando.

### 3.3. Migración de DB (idempotente)

`src/agent/workflow-engine/persistence/migrations.ts` (modificado):

```ts
export function runPersistenceMigrations(db: BetterSqliteDatabase): void {
  db.exec(`
    -- D3.1: paused_tasks
    CREATE TABLE IF NOT EXISTS paused_tasks (...);
    CREATE INDEX IF NOT EXISTS paused_tasks_tenant_idx ON paused_tasks(tenant_id, status);
    CREATE INDEX IF NOT EXISTS paused_tasks_status_idx ON paused_tasks(status, updated_at);

    -- D3.2: tenant_id en sessions y spaces
    -- Migración idempotente con PRAGMA table_info
  `);

  addTenantIdIfMissing(db, 'sessions');
  addTenantIdIfMissing(db, 'spaces');
}

function addTenantIdIfMissing(db: BetterSqliteDatabase, table: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === 'tenant_id')) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${table}_tenant_idx ON ${table}(tenant_id)`);
  }
}
```

**Razón del `IF MISSING`**: las migraciones corren en CADA instanciación del `SqliteTaskStore`. Si la columna ya existe, no la agregamos de nuevo (SQLite rechazaría el ALTER).

---

## 4. Estructura de archivos

### 4.1. Nuevos

| Archivo | Líneas est. | Propósito |
|---|---|---|
| `src/agent/workflow-engine/persistence/errors.ts` | 30 | `MissingTenantIdError`. |

### 4.2. Modificados

| Archivo | Qué cambia |
|---|---|
| `src/agent/workflow-engine/persistence/task-store.ts` | `TaskStore` strict. `tenantId` required. Tipo `TaskRow` ya estaba. |
| `src/agent/workflow-engine/persistence/sqlite-task-store.ts` | Throws `MissingTenantIdError` cuando `tenantId === undefined`. Filtros ya estaban. |
| `src/agent/workflow-engine/persistence/in-memory-task-store.ts` | Idem. |
| `src/agent/workflow-engine/persistence/migrations.ts` | `addTenantIdIfMissing` para `sessions` y `spaces`. |
| `src/agent/workflow-engine/persistence/index.ts` | Re-export de `MissingTenantIdError`. |
| `src/agent/workflow-engine/executor/executor.ts` | En `persistCheckpoint`, lee `task.tenantId` y lo pasa. Si está vacío, throw `ExecutorError` con `INTERNAL_ERROR`. |
| `test_workflow_d3_1.mts` | 4 sitios donde se llama `store.save(task)` sin tenantId → agregar `'default'`. |

### 4.3. NO se tocan

- `src/agent/agent.ts` y el resto del loop D1 (D3.3).
- `src/agent/specialists/**`, `src/agent/skills/**`, `src/agent/llm/**`.
- `src/lib/db.ts` (la migración de `tenant_id` la hace `persistence/migrations.ts`, no la DB global).
- `server.ts`.

---

## 5. Decisiones de implementación

### 5.1. El `pool.query` global de `src/lib/db.ts` NO cambia

Sigue siendo `pool.query(sql, params)`. D3.2 no introduce `queryFor`. Las queries existentes del loop D1 siguen funcionando como antes. **Backward-compat 100%**.

### 5.2. El motor NO llama `pool.query` directamente

El motor solo conoce el `TaskStore` (interface, ya tiene enforcement). No toca `pool`. Esto es **regla del proyecto** (regla 6: provider-agnostic).

### 5.3. Forward-compat: si en D3.3+ queremos `loadCrossTenant` (admin), ¿qué signature?

Propuesta (no implementada en D3.2):

```ts
interface TaskStore {
  // D3.2 strict
  load(taskId: string, tenantId: string): Task | null;
  loadActive(tenantId: string): readonly Task[];
  // D3.3+ admin
  loadCrossTenant(taskId: string): Task | null;
  loadAllTenantsActive(): readonly Task[];
}
```

Los métodos admin **requieren** un flag de capacidad en el constructor: `new SqliteTaskStore(db, { allowCrossTenant: true })`. D3.2 NO implementa esto. Solo deja la puerta abierta.

### 5.4. Tests del sprint

`test_workflow_d3_2.mts` (nuevo, ≥25 tests):

**Bloque A — `TaskStore` strict (8 tests)**:
1. `save` sin tenantId throws `MissingTenantIdError`.
2. `load` sin tenantId throws.
3. `loadActive` sin tenantId throws.
4. `delete` sin tenantId throws.
5. `save` con tenantId funciona (roundtrip).
6. `load` con tenantId distinto al de la task retorna null.
7. `delete` con tenantId distinto no elimina.
8. `MissingTenantIdError` tiene mensaje accionable (menciona D3.3 admin).

**Bloque B — Multi-tenant isolation (8 tests, InMemory)**:
9. `loadActive` con tenantA retorna solo tasks de tenantA.
10. `load` con tenantA de una task de tenantB retorna null.
11. `delete` con tenantA de una task de tenantB no elimina.
12. `save` con tenantA, `load` con tenantA, `load` con tenantB: A ve, B no.
13. `save` con tenantA, `save` con tenantB de la misma taskId: ambas coexisten o la segunda pisa (decisión documentada: **pisa** porque `task_id` es PK).
14. `loadActive` con múltiples tenants: filtra correctamente.
15. `loadActive` con 0 tasks: retorna `[]`.
16. Roundtrip con `tenantId` custom preserva el campo.

**Bloque C — Multi-tenant isolation (4 tests, SQLite)**:
17. Roundtrip con DB en `:memory:`, tenant filter funciona.
18. `loadActive` con 5 tasks de 2 tenants, filtra por tenant.
19. La columna `tenant_id` se crea en la tabla al instanciar el store.
20. Migración idempotente: 3 corridas de `runPersistenceMigrations` no fallan.

**Bloque D — Migración de `sessions` y `spaces` (5 tests)**:
21. `runPersistenceMigrations` agrega `tenant_id` a `sessions` si no existe.
22. `runPersistenceMigrations` agrega `tenant_id` a `spaces` si no existe.
23. `runPersistenceMigrations` con columna ya existente: no falla, no duplica.
24. Columna tiene `DEFAULT 'default'` para rows legacy.
25. Las columnas `tenant_id` de `sessions` y `spaces` tienen índices.

**Bloque E — Integración con el motor (5 tests)**:
26. `executor.persistCheckpoint` lee `task.tenantId` y lo pasa al store.
27. `executor.persistCheckpoint` con `task.tenantId = ''` throw `ExecutorError` (no llama al store con tenantId inválido).
28. Multi-tenant: 2 tasks de tenants distintos, recovery las mantiene separadas.
29. `executor.cleanup` no toca el store (status quo D3.1).
30. Backward-compat: tests D2a siguen pasando con `tenantId: 'default'`.

**Total: 30 tests**.

---

## 6. Decisiones con implicaciones futuras (registradas)

1. **Strict `tenantId` en `TaskStore`** (§2.1) — D3.3+ puede agregar métodos admin con nombres explícitos. No se reabre el `tenantId?` opcional.

2. **`tenantId` del task gana, param es override** (§2.2) — si un dev futuro discea entre los dos, el comportamiento es predecible. El motor NUNCA debe pasar un tenantId distinto al de la task.

3. **`sessions` y `spaces` son las únicas tablas con `tenant_id` en D3.2** (§2.3) — el resto se hace en D3.3 con auth. Documentado en HANDOFF.

4. **Sin `queryFor` wrapper** (§2.4) — el codebase de 51 queries sigue con `pool.query`. Forward-compat con D3.3 si se necesita.

5. **`MissingTenantIdError` accionable** (§2.5) — el mensaje apunta a la solución (`loadCrossTenant` en D3.3).

6. **Backward-compat 100% con tests existentes** (§2.6) — los 260+ tests acumulados no se rompen. Los 4 sitios de `test_workflow_d3_1.mts` se arreglan con `'default'` literal.

---

## 7. Lo que NO hace D3.2 (forward-compat)

- **D3.3**: auth de tenant (JWT/API key), `loadCrossTenant` para admin, sweeper de zombies con `last_heartbeat_at`, audit log multi-tenant, migración de `messages`/`step_logs`/`tool_calls`/`apify_usage`.
- **D3.3+**: `queryFor` wrapper si la cantidad de queries lo justifica.
- **Multi-region / replicación**: forward, post-D6.
- **Encryption at rest**: SQLite no lo trae built-in. Forward, post-D6.
- **Migración de tasks entre tenants**: si un cliente cambia de firma, las tasks se quedan en el tenant original. Out of scope D3.2.

---

## 8. Reversibilidad

- Strict `tenantId` es revertible: agregar `?` de vuelta a la interface + manejar `undefined`. Costo: 30 min.
- Columnas `tenant_id` en `sessions`/`spaces` son aditivas — se pueden dejar aunque no se usen. Costo de remover: 1 migration por tabla.
- `MissingTenantIdError` es un nuevo tipo de error — eliminar el throw + dejar el param opcional = revertir la decisión 2.1.

---

## 9. Criterio de cierre

- 30+ tests pasan, 0 fallidos, 0 regresiones en los 299 tests acumulados (260 + 30 + 9 nuevos que ajusto en D3.1).
- `tsc --noEmit` sin errores nuevos en código D3.2.
- El `TaskStore` falla loud si recibe `tenantId` undefined.
- Las columnas `tenant_id` existen en `sessions` y `spaces`.
- HANDOFF.md actualizado con el cierre.

---

## 10. Riesgos identificados

| Riesgo | Mitigación |
|---|---|
| Olvidar pasar `tenantId` en alguna llamada del motor | El motor SIEMPRE lee `task.tenantId`. Si está vacío, throw `ExecutorError` antes de tocar el store. |
| Tests existentes sin tenantId rompen | Los arreglo en este sprint (4 sitios en `test_workflow_d3_1.mts`). |
| Migración corre en cada instanciación | `addTenantIdIfMissing` usa `PRAGMA table_info` para check, ~ms. Aceptable. |
| `tenant_id` queda con valor `'default'` legacy | Forward-compat: D3.3 auth hace que el caller setee `tenantId` real. Las tasks legacy siguen en `'default'`. Si la firma decide borrar `'default'`, hay que migrar tasks antes. |
| `InMemoryTaskStore` con `tenantId` distinto al de la task muta el spread | El motor NUNCA pasa tenantId distinto. Los tests que sí lo hacen, usan `InMemoryTaskStore` (no producción). Documentado. |

---

## 11. Referencias

- `AGENT_D3_1_STORAGE_PERSISTENCE_SPEC.md` — el sprint anterior que dejó la columna `tenant_id` en `paused_tasks` y la interface con `tenantId?` opcional.
- `HANDOFF.md` — sprint order (D3.1 → D3.2 → D3.3).
- `AGENT_ROADMAP.md` §5.9 — Identidad del agente, lifecycle y costo atribuible. D3 introduce el `tenant_id` en cada Agent Card.
- `AGENT_ROADMAP.md` §8 — Open question #1 (multi-tenant auth model). Resuelta en D3.2: row-level con `tenant_id` en cada tabla, enforced en `TaskStore`.
- `src/agent/workflow-engine/persistence/task-store.ts` — la interface que D3.2 vuelve estricta.
- `src/lib/db.ts` — el `pool` global, NO se toca en D3.2.
