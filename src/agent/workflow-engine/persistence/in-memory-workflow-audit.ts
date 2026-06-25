/**
 * Worgena Workflow Engine — InMemoryWorkflowAudit (D3.3 + cost attribution).
 *
 * Implementación para tests. Mantiene los eventos en memoria.
 *
 * Spec: `AGENT_D3_3_AUTH_SWEEPER_AUDIT_SPEC.md` §3.2 +
 *       `AGENT_SPRINT_COST_ATTRIBUTION_SPEC.md` (Backlog P0 #3).
 */

import type {
  WorkflowAudit,
  WorkflowAuditEvent,
  LLMCallAuditEvent,
} from "./workflow-audit.js";

/**
 * Union de eventos (lifecycle + cost attribution) para queries de tests.
 */
export type AnyWorkflowAuditEvent = WorkflowAuditEvent | LLMCallAuditEvent;

export class InMemoryWorkflowAudit implements WorkflowAudit {
  public readonly events: AnyWorkflowAuditEvent[] = [];

  record(event: WorkflowAuditEvent): void {
    this.events.push(event);
  }

  /**
   * Backlog P0 #3: persiste un evento de cost attribution.
   */
  recordLLMCall(event: LLMCallAuditEvent): void {
    this.events.push(event);
  }

  /**
   * Helper para tests: filtra eventos por taskId y/o tenantId.
   * Incluye eventos de LLMCall (que también tienen taskId/tenantId).
   * El filtro `eventType` solo aplica a lifecycle events; los
   * eventos de cost attribution tienen `model` en su lugar.
   */
  query(filter: {
    taskId?: string;
    tenantId?: string;
    eventType?: string;
  }): readonly AnyWorkflowAuditEvent[] {
    return this.events.filter(
      (e) =>
        (!filter.taskId || e.taskId === filter.taskId) &&
        (!filter.tenantId || e.tenantId === filter.tenantId) &&
        (!filter.eventType ||
          !("eventType" in e) ||
          e.eventType === filter.eventType),
    );
  }

  clear(): void {
    this.events.length = 0;
  }
}
