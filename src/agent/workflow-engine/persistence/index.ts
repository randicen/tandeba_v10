/**
 * Worgena Workflow Engine — Persistencia D3.1 + D3.2 + D3.3: barrel.
 *
 * Spec: `AGENT_D3_1_STORAGE_PERSISTENCE_SPEC.md` §4.1 +
 *       `AGENT_D3_2_MULTI_TENANT_SPEC.md` §4.1 +
 *       `AGENT_D3_3_AUTH_SWEEPER_AUDIT_SPEC.md` §4.1.
 */

export type { TaskStore, TaskRow } from "./task-store.js";
export { SqliteTaskStore } from "./sqlite-task-store.js";
export { InMemoryTaskStore } from "./in-memory-task-store.js";
export { runPersistenceMigrations } from "./migrations.js";
export { MissingTenantIdError } from "./errors.js";
export type { AuthProvider } from "./auth-provider.js";
export { StaticTenantProvider } from "./auth-provider.js";
export type {
  WorkflowAudit,
  WorkflowAuditEvent,
  WorkflowAuditEventType,
} from "./workflow-audit.js";
export { SqliteWorkflowAudit } from "./sqlite-workflow-audit.js";
export { InMemoryWorkflowAudit } from "./in-memory-workflow-audit.js";
