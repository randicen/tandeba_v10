/**
 * Worgena Workflow Engine — Workflow Audit (D3.3).
 *
 * Interface `WorkflowAudit` + tipos auxiliares. El motor registra eventos
 * de lifecycle (start, pause_hitl, resume, complete, fail, cancel, recovery,
 * zombie_sweep) via esta interface.
 *
 * Es LIVIANO: NO registra `prompt_sent` ni `raw_response` (eso es D1 + D3.4+).
 * Solo el evento + metadata ligera.
 *
 * Spec: `AGENT_D3_3_AUTH_SWEEPER_AUDIT_SPEC.md` §3.2.
 */

export type WorkflowAuditEventType =
  | "start"
  | "pause_hitl"
  | "resume"
  | "complete"
  | "fail"
  | "cancel"
  | "recovery"
  | "zombie_sweep";

export interface WorkflowAuditEvent {
  readonly tenantId: string;
  readonly taskId: string;
  readonly eventType: WorkflowAuditEventType;
  readonly payload?: Record<string, unknown>;
  /** Unix milliseconds. El motor pone `Date.now()` por default. */
  readonly createdAt: number;
}

/**
 * Interface del audit del workflow engine.
 *
 * Implementaciones:
 * - `SqliteWorkflowAudit`: escribe a la tabla `workflow_audit`.
 * - `InMemoryWorkflowAudit`: para tests.
 * - D3.4+: `DatadogWorkflowAudit`, `SentryWorkflowAudit`, etc.
 *
 * Si `record()` lanza, el motor NO captura el error. Loguea y sigue.
 * El audit es secundario; el motor es primario.
 */
export interface WorkflowAudit {
  record(event: WorkflowAuditEvent): void;
}
