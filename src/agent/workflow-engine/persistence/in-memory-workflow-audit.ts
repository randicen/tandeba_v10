/**
 * Worgena Workflow Engine — InMemoryWorkflowAudit (D3.3).
 *
 * Implementación para tests. Mantiene los eventos en memoria.
 *
 * Spec: `AGENT_D3_3_AUTH_SWEEPER_AUDIT_SPEC.md` §3.2.
 */

import type {
  WorkflowAudit,
  WorkflowAuditEvent,
} from "./workflow-audit.js";

export class InMemoryWorkflowAudit implements WorkflowAudit {
  public readonly events: WorkflowAuditEvent[] = [];

  record(event: WorkflowAuditEvent): void {
    this.events.push(event);
  }

  /**
   * Helper para tests: filtra eventos por taskId y/o tenantId.
   */
  query(filter: { taskId?: string; tenantId?: string }): readonly WorkflowAuditEvent[] {
    return this.events.filter(
      (e) =>
        (!filter.taskId || e.taskId === filter.taskId) &&
        (!filter.tenantId || e.tenantId === filter.tenantId),
    );
  }

  clear(): void {
    this.events.length = 0;
  }
}
