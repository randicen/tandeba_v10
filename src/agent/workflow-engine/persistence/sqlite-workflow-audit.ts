/**
 * Worgena Workflow Engine — SqliteWorkflowAudit (D3.3).
 *
 * Implementación SQLite de `WorkflowAudit`. Escribe a la tabla
 * `workflow_audit` definida en `migrations.ts`.
 *
 * Sync, NO async. better-sqlite3 es síncrono. Forward-compat con
 * Postgres: si D4+ migra, se cambia la implementación pero no la
 * interface.
 *
 * Spec: `AGENT_D3_3_AUTH_SWEEPER_AUDIT_SPEC.md` §2.4 + §3.2.
 */

import type Database from "better-sqlite3";
import type {
  WorkflowAudit,
  WorkflowAuditEvent,
} from "./workflow-audit.js";

/**
 * Tabla `workflow_audit`. Schema definido en `migrations.ts`.
 *
 * Indices:
 * - `workflow_audit_tenant_idx` (tenant_id, created_at): queries de
 *   "todos los eventos del tenant X en el último día".
 * - `workflow_audit_task_idx` (task_id, created_at): queries de
 *   "todos los eventos de la task Y".
 */
export class SqliteWorkflowAudit implements WorkflowAudit {
  private readonly insertStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO workflow_audit (
        tenant_id, task_id, event_type, payload_json, created_at
      ) VALUES (
        @tenant_id, @task_id, @event_type, @payload_json, @created_at
      )
    `);
  }

  record(event: WorkflowAuditEvent): void {
    this.insertStmt.run({
      tenant_id: event.tenantId,
      task_id: event.taskId,
      event_type: event.eventType,
      payload_json: event.payload
        ? JSON.stringify(event.payload)
        : null,
      created_at: event.createdAt,
    });
  }
}
