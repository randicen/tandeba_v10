/**
 * Worgena Workflow Engine — Persistencia D3.1: InMemoryTaskStore.
 *
 * Implementación de `TaskStore` que guarda las tasks en un `Map<>`.
 * Usado en tests. NO debe usarse en producción (no sobrevive restarts).
 *
 * Si una task está en estado terminal, NO se guarda (D3.1, §2.1).
 * Esto refleja el comportamiento de SqliteTaskStore: `loadActive` los
 * excluye. Si el caller hace `save` con una task terminal, el store
 * la ignora silenciosamente (es la convención del motor: terminales
 * se purgan al completar).
 *
 * Spec: `AGENT_D3_1_STORAGE_PERSISTENCE_SPEC.md` §2.4.
 */

import type { Task } from "../dsl/types.js";
import type { TaskStore } from "./task-store.js";
import { MissingTenantIdError } from "./errors.js";

/**
 * Helper privado: valida que el `tenantId` no sea undefined ni string vacío.
 * D3.2 strict. Falla loud con `MissingTenantIdError`.
 */
function requireTenantId(method: string, tenantId: string | undefined): asserts tenantId is string {
  if (tenantId === undefined || tenantId === "") {
    throw new MissingTenantIdError(method);
  }
}

const TERMINAL_STATUSES: ReadonlySet<Task["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/**
 * D3.3: heartbeat paralelo. Key compuesta igual que `tasks`.
 * Permite al sweeper preguntar "¿cuándo fue la última actividad?"
 * sin tocar la fila principal de la task.
 */
interface HeartbeatEntry {
  readonly lastHeartbeatAt: number;
}

export class InMemoryTaskStore implements TaskStore {
  // D3.2 audit fix (I-1): key compuesta `${tenantId}::${taskId}` para
  // evitar colisión cross-tenant.
  private readonly tasks: Map<string, Task> = new Map();
  /** D3.3: heartbeats paralelos. */
  private readonly heartbeats: Map<string, HeartbeatEntry> = new Map();

  /** Helper privado: key compuesta. */
  private static key(tenantId: string, taskId: string): string {
    return `${tenantId}::${taskId}`;
  }

  save(task: Task, tenantId: string): void {
    requireTenantId("save", tenantId);
    // D3.1: terminales NO se persisten. Las borramos (idempotente).
    if (TERMINAL_STATUSES.has(task.status)) {
      const key = InMemoryTaskStore.key(tenantId, task.taskId);
      this.tasks.delete(key);
      this.heartbeats.delete(key);
      return;
    }
    // D3.2 strict: spread SIEMPRE (no mutar la task original en el Map).
    const toSave: Task = { ...task, tenantId };
    const key = InMemoryTaskStore.key(tenantId, task.taskId);
    this.tasks.set(key, toSave);
    // D3.3: save() también bumpea last_heartbeat_at. El caller NO
    // necesita llamar touch() después de save(); el heartbeat se
    // actualiza como parte del checkpoint atómico.
    this.heartbeats.set(key, { lastHeartbeatAt: Date.now() });
  }

  load(taskId: string, tenantId: string): Task | null {
    requireTenantId("load", tenantId);
    const task = this.tasks.get(InMemoryTaskStore.key(tenantId, taskId));
    return task ?? null;
  }

  loadActive(tenantId: string): readonly Task[] {
    requireTenantId("loadActive", tenantId);
    const prefix = `${tenantId}::`;
    const result: Task[] = [];
    for (const [key, task] of this.tasks) {
      if (!key.startsWith(prefix)) continue;
      if (TERMINAL_STATUSES.has(task.status)) continue;
      result.push(task);
    }
    // Orden por updatedAt ASC, mismo orden que SqliteTaskStore
    return result.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }

  delete(taskId: string, tenantId: string): void {
    requireTenantId("delete", tenantId);
    const key = InMemoryTaskStore.key(tenantId, taskId);
    this.tasks.delete(key);
    this.heartbeats.delete(key);
  }

  touch(taskId: string, tenantId: string): void {
    requireTenantId("touch", tenantId);
    const key = InMemoryTaskStore.key(tenantId, taskId);
    // D3.3: solo actualiza el heartbeat, no toca la task. Idempotente.
    this.heartbeats.set(key, { lastHeartbeatAt: Date.now() });
  }

  findStaleZombieTasks(tenantId: string, maxAgeMs: number): readonly Task[] {
    requireTenantId("findStaleZombieTasks", tenantId);
    const cutoff = Date.now() - maxAgeMs;
    const prefix = `${tenantId}::`;
    const result: Task[] = [];
    for (const [key, task] of this.tasks) {
      if (!key.startsWith(prefix)) continue;
      if (task.status !== "running") continue;
      const hb = this.heartbeats.get(key);
      // Sin heartbeat (fila pre-D3.3) o heartbeat viejo: zombie.
      // `<=` en vez de `<` para que `maxAgeMs=0` barra: si el heartbeat
      // es exactamente = cutoff (mismo ms), también es zombie.
      if (hb === undefined || hb.lastHeartbeatAt <= cutoff) {
        result.push(task);
      }
    }
    return result;
  }
}
