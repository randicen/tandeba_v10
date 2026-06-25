/**
 * Worgena Workflow Engine — Workflow Audit (D3.3 + cost attribution).
 *
 * Interface `WorkflowAudit` + tipos auxiliares. El motor registra eventos
 * de lifecycle (start, pause_hitl, resume, complete, fail, cancel, recovery,
 * zombie_sweep) Y eventos de cost attribution (llm_call) via esta interface.
 *
 * Es LIVIANO: NO registra `prompt_sent` ni `raw_response` (eso es D1 + D3.4+).
 * Solo el evento + metadata ligera.
 *
 * Spec: `AGENT_D3_3_AUTH_SWEEPER_AUDIT_SPEC.md` §3.2 +
 *       `AGENT_SPRINT_COST_ATTRIBUTION_SPEC.md` (Backlog P0 #3).
 */

export type WorkflowAuditEventType =
  | "start"
  | "pause_hitl"
  | "resume"
  | "complete"
  | "fail"
  | "cancel"
  | "recovery"
  | "zombie_sweep"
  /** Backlog P0 #3: persistido por `OpenRouterLLMInvoker` después de cada chat(). */
  | "llm_call";

export interface WorkflowAuditEvent {
  readonly tenantId: string;
  readonly taskId: string;
  readonly eventType: WorkflowAuditEventType;
  readonly payload?: Record<string, unknown>;
  /** Unix milliseconds. El motor pone `Date.now()` por default. */
  readonly createdAt: number;
}

/**
 * Evento de cost attribution por LLM call.
 *
 * Persistido por `OpenRouterLLMInvoker` después de cada `chat()` exitoso.
 * NO se persiste si el call falló (P1 — audit es secundario).
 *
 * Backlog P0 #3 — habilita revenue per-tenant + unit economics.
 */
export interface LLMCallAuditEvent {
  readonly tenantId: string;
  readonly taskId: string;
  /** ID del nodo del workflow que hizo el LLM call. */
  readonly nodeId: string;
  /** ID del agent card (si está disponible via specialist). */
  readonly agentCardId?: string;
  /** Modelo usado (e.g. "anthropic/claude-3.5-sonnet"). */
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** USD. Viene de OpenRouter `usage.cost` o fallback `PricingCatalog`. */
  readonly costUsd: number;
  /** Latencia del call (ms). */
  readonly durationMs: number;
  /** Unix milliseconds. El invoker pone `Date.now()` por default. */
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
 *
 * Backlog P0 #3: agregar `recordLLMCall()` para cost attribution.
 * `record()` queda como API legacy (lifecycle events) — backward-compat.
 */
export interface WorkflowAudit {
  /** Legacy: lifecycle events. */
  record(event: WorkflowAuditEvent): void;
  /** Backlog P0 #3: cost attribution per LLM call. */
  recordLLMCall(event: LLMCallAuditEvent): void;
}
