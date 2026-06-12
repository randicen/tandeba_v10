/**
 * Worgena Workflow DSL — Tipos TypeScript
 *
 * Fuente de verdad: AGENT_WORKFLOW_DSL_SPEC.md §3.
 * Spec version: 0.2
 *
 * Convenciones:
 * - Todos los tipos son readonly cuando es data inmutable (WorkflowDefinition).
 * - State, NodeResult.output, etc. son mutables (los escribe el motor).
 * - El JSON Schema de runtime está en `./schema.ts` y debe mantenerse en sync con estos tipos.
 * - Para D2a, los tipos son validados por ajv. En D2b, considerar generar JSON Schema desde
 *   estos tipos con `typescript-json-schema` para eliminar drift manual.
 */

// ============================================================
// Utilidades
// ============================================================

/** Tipo para JSON Schema arbitrario. La validación real la hace ajv en runtime. */
export type JSONSchema = Record<string, unknown>;

// ============================================================
// WorkflowDefinition — la plantilla inmutable
// ============================================================

export interface WorkflowDefinition {
  /** Identificador estable (slug, sin version). Ej: "revision-generica" */
  readonly id: string;

  /** Nombre legible para UI. */
  readonly name: string;

  /** Descripción opcional del workflow. */
  readonly description?: string;

  /** Versión semver del contenido de ESTE workflow. Ej: "1.0.0", "1.2.3" */
  readonly workflowVersion: string;

  /** Versión del spec del DSL que este workflow fue escrito contra. Hoy: 1. */
  readonly schemaVersion: 1;

  /** JSON Schema que valida el `state` en runtime. */
  readonly stateSchema: JSONSchema;

  /** Lista de nodos del grafo. */
  readonly nodes: readonly Node[];

  /** Lista de edges (transiciones) entre nodos. */
  readonly edges: readonly Edge[];

  /** ID del nodo donde arranca la ejecución. */
  readonly entryNode: string;

  /** Configuración default aplicable a todos los nodos. */
  readonly config?: WorkflowConfig;
}

export interface WorkflowConfig {
  /** Retries default para nodos que no especifican. Default: 0. */
  readonly defaultRetries?: number;

  /** Timeout default en ms. Default: 60000 (1 min). */
  readonly defaultTimeoutMs?: number;

  /** Defaults para nodos HITL. */
  readonly hitlDefaults?: HITLConfig;
}

// ============================================================
// Node — unión discriminada por `type` (D2a)
// ============================================================
// Nota: FanoutNode y FaninNode se difieren a D2b (ver spec §9).

export type Node = FunctionNode | LLMNode | HITLNode | RouterNode;

export interface BaseNode {
  /** ID único dentro del workflow. */
  readonly id: string;

  /** Nombre legible para UI y logs. */
  readonly name?: string;

  /** Descripción opcional. */
  readonly description?: string;

  /** Override del timeout default del workflow. */
  readonly timeoutMs?: number;

  /** Política de retries para este nodo. Default: 0 retries. */
  readonly retries?: RetryConfig;

  /**
   * Template para computar la idempotency key.
   * - Si se declara: el motor re-ejecuta con cache (output cacheado si la key matchea).
   * - Si NO se declara y `retriable=true`: retry sin cache (útil para funciones puras).
   * - Si NO se declara y `retriable=false` (default): FALLA con `NON_IDEMPOTENT_RETRY_DISALLOWED`.
   * Ver spec §6.1 para detalles.
   */
  readonly idempotencyKey?: string;

  /** Si true, el nodo es reintenable sin idempotencyKey. Default: false. */
  readonly retriable?: boolean;

  /** Qué hacer si el nodo falla definitivamente. Default: 'fail'. */
  readonly onError?: NodeErrorAction;
}

export type NodeErrorAction =
  | "fail" // la task pasa a status='failed'
  | "continue" // marca el nodo como 'skipped' y sigue
  | { readonly goto: string }; // salta al nodo especificado

// ============================================================
// Códigos de error reconocidos (catálogo único)
// ============================================================

export type ErrorCode =
  | "RATE_LIMIT" // upstream provider rate limit
  | "TIMEOUT" // timeout de la operación
  | "NETWORK_ERROR" // fallo de red transitorio
  | "INVALID_OUTPUT" // el output no validó contra outputSchema
  | "SCHEMA_VIOLATION" // el state no validó contra stateSchema
  | "CONTEXT_TOO_LONG" // el prompt excedió la ventana del modelo
  | "MODEL_UNAVAILABLE" // el modelo configurado no responde
  | "INTERNAL_ERROR" // bug nuestro
  | "HITL_TIMEOUT" // un nodo HITL expiró
  | "HITL_DECLINED" // un approver declinó (ej: conflicto de interés)
  | "NON_IDEMPOTENT_RETRY_DISALLOWED" // falló retry en nodo sin idempotencyKey ni retriable
  | "ROUTER_NO_MATCH" // el router no encontró match ni default
  | "WORKFLOW_HAS_CYCLE" // validación al cargar
  | "TASK_ALREADY_RUNNING" // re-ejecución concurrente rechazada
  | "SCHEMA_VERSION_UNSUPPORTED"; // schemaVersion del workflow > la del motor

export interface RetryConfig {
  /** Cantidad máxima de reintentos (no incluye la ejecución inicial). */
  readonly max: number;

  /** Tipo de backoff. Default: 'exponential'. */
  readonly backoff?: "fixed" | "exponential";

  /** Delay inicial en ms. Default: 1000. */
  readonly initialDelayMs?: number;

  /**
   * Códigos de error que disparan retry. Si está vacío, todos los errores
   * catalogados como retriable disparan retry (ver errorClassifier en runtime).
   */
  readonly on?: readonly ErrorCode[];
}

// ---- FunctionNode: ejecuta código registrado (tool / skill / acción custom)

export interface FunctionNode extends BaseNode {
  readonly type: "function";

  /** Nombre de la función registrada en el motor. */
  readonly functionRef: string;

  readonly input: NodeInput;
  readonly output: NodeOutput;
}

// ---- LLMNode: invoca un LLM con un prompt y tools opcionales

export interface LLMNode extends BaseNode {
  readonly type: "llm";

  /** Tier de modelo o nombre específico. Tier se resuelve a modelo vía config del motor. */
  readonly model: ModelRef;

  /** System prompt del nodo. Puede referenciar state con {{state.X}}. */
  readonly systemPrompt?: string;

  /** User prompt (alternativo al systemPrompt). Más común para prompts dinámicos. */
  readonly userPrompt?: string;

  /** Skills a cargar (instrucciones + contexto adicional). */
  readonly skills?: readonly string[];

  /** Tools disponibles para este nodo. */
  readonly tools?: readonly string[];

  readonly input: NodeInput;
  readonly output: NodeOutput;

  /**
   * JSON Schema que valida el output del LLM.
   * Si se declara `confidenceGating`, este schema DEBE tener la propiedad
   * `confidence: { type: "number", minimum: 0, maximum: 1 }`. Validado al cargar.
   */
  readonly outputSchema?: JSONSchema;

  readonly confidenceGating?: ConfidenceGatingConfig;
}

/** Tier (referencia simbólica) o nombre específico de modelo. */
export type ModelRef = "liviano" | "robusto" | string;

// ---- HITLNode: pausa para aprobación humana

export interface HITLNode extends BaseNode {
  readonly type: "hitl";

  /** IDs o roles de los approvers. Ej: "role:abogado_senior", "user:uuid" */
  readonly approvers: readonly string[];

  /** Qué mostrarle al humano (la pregunta). */
  readonly question: NodeInput;

  /** Contexto adicional para que el humano decida. */
  readonly context?: NodeInput;

  /** Input que se pasa al humano para que reaccione (opcional). */
  readonly input?: NodeInput;

  readonly output: NodeOutput;

  /**
   * Si hay múltiples approvers, cómo se agregan las respuestas.
   * - 'any': con que uno apruebe, sigue (first-wins).
   * - 'all': todos deben aprobar.
   * - 'majority': más de la mitad.
   * Default: 'any'.
   */
  readonly approvalMode?: "any" | "all" | "majority";

  /**
   * JSON Schema opcional que valida la respuesta humana.
   * Si no se declara: modo permisivo (log warning, acepta lo que venga).
   * Si se declara, se valida. Si falla, el approver puede reintentar o se aplica onError.
   */
  readonly outputSchema?: JSONSchema;

  /** Timeout en ms. Si expira, se ejecuta onTimeout. */
  readonly timeoutMs?: number;

  /** Acción al expirar. Default: 'fail'. */
  readonly onTimeout?: "fail" | "approve" | "reject";

  /**
   * Si true, los approvers pueden declinar con una razón (ej: conflicto de interés).
   * La razón se persiste en NodeResult.declinedReason y la task falla con HITL_DECLINED.
   * Default: false.
   */
  readonly allowDecline?: boolean;

  /**
   * Razones válidas para declinar. Default: ['conflict_of_interest', 'other'].
   * Las firmas pueden extender con razones custom en su config.
   */
  readonly declineReasons?: readonly string[];
}

export interface HITLConfig {
  readonly approvers: readonly string[];
  readonly timeoutMs: number;
  readonly onTimeout: "fail" | "approve" | "reject";
}

// ---- RouterNode: bifurcación basada en un valor del state

export interface RouterNode extends BaseNode {
  readonly type: "router";

  /** Valor a comparar contra las claves de `routes`. */
  readonly decision: NodeInput;

  /** Mapa de valor (string) → nodeId. */
  readonly routes: Readonly<Record<string, string>>;

  /** Nodo default si el valor no está en routes. */
  readonly default?: string;

  /**
   * Cómo se compara el valor de `decision` contra las claves de `routes`.
   * - 'exact': case-sensitive, sin trim, exact match.
   * - 'case-insensitive': case-insensitive, sin trim.
   * Default: 'exact'.
   */
  readonly matchMode?: "exact" | "case-insensitive";
}

// ============================================================
// Edge — transición entre nodos
// ============================================================

export interface Edge {
  /** ID del nodo origen. */
  readonly from: string;

  /** ID del nodo destino. */
  readonly to: string;

  /**
   * Condición opcional. Si no se declara, edge incondicional.
   * IMPORTANTE: la decisión de ejecutar un nodo se hace en el EDGE de entrada, no en el nodo.
   * Si ningún edge lleva al nodo, este no se ejecuta. Esto es cómo se "salta" un nodo
   * condicionalmente (ej: "ejecuta extract solo si classification.category === 'contrato'").
   *
   * El valor resuelto se interpreta como boolean: truthy = tomar el edge.
   */
  readonly condition?: NodeInput;
}

// ============================================================
// NodeInput, NodeOutput, StateRef — referencia al state
// ============================================================

/**
 * Referencia al state. Dos formas equivalentes:
 * - `template`: "{{state.foo.bar}}" — interpolación de strings.
 * - `path`:    "foo.bar"            — dot-notation (más simple para paths directos).
 *
 * El motor resuelve ambos al mismo modelo. Si no se especifica ninguno,
 * se opera con el `result` completo del nodo (vía path implícito).
 */
export interface StateRef {
  readonly template?: string;
  readonly path?: string;
}

/** Input de un nodo: de dónde leer del state. */
export interface NodeInput {
  /** De dónde leer. */
  readonly from: StateRef;

  /** Default si `from` resuelve a undefined. */
  readonly default?: unknown;
}

/** Output de un nodo: dónde escribir al state. */
export interface NodeOutput {
  /**
   * Dónde escribir. Si no se especifica `template` o `path`,
   * se escribe el `result` completo del nodo.
   */
  readonly to: StateRef;
}

// ============================================================
// Confidence gating
// ============================================================

export interface ConfidenceGatingConfig {
  /** Umbral (0-1) sobre el cual la confianza es HIGH. */
  readonly highThreshold: number;

  /** Umbral (0-1) sobre el cual la confianza es MEDIUM. Debe ser < highThreshold. */
  readonly mediumThreshold: number;

  /** Qué hacer si la confianza es MEDIUM. */
  readonly onMedium: "search_more" | "continue" | "ask_user";

  /** Qué hacer si la confianza es LOW. */
  readonly onLow: "ask_user" | "fail";
}

// ============================================================
// Task — instancia de runtime
// ============================================================

export interface Task {
  /** ID único de la task. */
  readonly taskId: string;

  /** ID del workflow que se está ejecutando. */
  readonly workflowId: string;

  /** Versión del workflow (snapshot inmutable al momento de crear la task). */
  readonly workflowVersion: string;

  /** Estado actual, validado contra stateSchema. */
  state: unknown;

  /** Estado de la task en el ciclo de vida. */
  status: TaskStatus;

  /** ID del nodo que se está ejecutando actualmente (o se va a ejecutar). */
  currentNode: string;

  /** Resultados persistidos por nodo. */
  nodeResults: Record<string, NodeResult>;

  /** Timestamps. */
  readonly createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;

  /** Tenant al que pertenece la task. */
  readonly tenantId: string;

  /** Input inicial. */
  readonly input: unknown;

  /** Error global de la task (si status='failed'). */
  error?: TaskError;

  /** Metadata de runtime. Política: no abusar (ver comentario en TaskMetadata). */
  metadata?: TaskMetadata;

  /** Si esta task es un replay, taskId original. La task original queda intacta. */
  readonly replayOf?: string;

  /** Qué se modificó en el replay (input diferente, opcional). */
  readonly replayInput?: Readonly<Record<string, unknown>>;

  /** Desde qué nodo se re-ejecutó. Si no se declara, desde entryNode. */
  readonly replayFromNode?: string;

  /**
   * Snapshot del workflow DESPUÉS de aplicar las migraciones de schema.
   * Lo que realmente se ejecutó. Se llena en el `startTask` (o replay) y
   * se persiste con la task.
   *
   * El replay usa este campo, no vuelve a aplicar migradores. Esto
   * garantiza que el replay es determinista respecto al código que corrió
   * la original: si un migrador cambia entre la original y el replay,
   * el replay no se ve afectado.
   *
   * Si el workflow ya estaba en la versión del motor, este campo es
   * `undefined` (no hubo migración).
   *
   * Decisión de diseño (D2a.2.3, revisión v1.1): la migración es LAZY al
   * ejecutar, no eager al parsear. Razón: audit legal de Worgena requiere
   * coherencia entre `workflowVersion` declarada y migraciones aplicadas.
   * Ver `AGENT_D2A_2_3_CORE_PRIMITIVES_SPEC.md` §7.4.
   */
  readonly migratedWorkflow?: WorkflowDefinition;

  /**
   * Lista de migraciones aplicadas al ejecutar esta task. Para audit legal.
   * Ej: `["1->2", "2->3"]`. Vacío (o `undefined`) si no hubo migración.
   */
  readonly appliedMigrations?: readonly string[];

  /**
   * Si la task está pausada esperando respuesta HITL, este campo persiste
   * el contexto de la pausa. Se llena cuando el motor entra en `paused_hitl`
   * y se limpia cuando `resumeTask` o `cancelTask` resuelve la task.
   *
   * D2a.4: nuevo. Hasta D2a.2.3 la pausa HITL era un `await` bloqueante;
   * ahora la task queda realmente en `paused_hitl` y el caller debe llamar
   * `executor.resumeTask(taskId, response)` para continuar.
   *
   * El campo es necesario para que `resumeTask` sepa qué nodoHITL
   * reanudar y valide la respuesta contra el `outputSchema` correcto.
   *
   * Mutable (sin `readonly`) porque el motor lo asigna y lo borra durante
   * el ciclo de vida de la task. Mismo patrón que `state`, `status`,
   * `currentNode`, `nodeResults`, `updatedAt`.
   *
   * En D2a, la pausa vive en el `Map` del executor (memoria). Si el server
   * reinicia, se pierde. D3 introduce persistencia en DB.
   *
   * Ver `AGENT_D2A_4_HITL_PRIMITIVES_SPEC.md` §4.1.
   */
  pendingDecision?: PendingHITLDecision;
}

export type TaskStatus =
  | "pending" // creada pero no iniciada
  | "running" // ejecutando un nodo
  | "paused_hitl" // esperando respuesta humana
  | "paused_error" // esperando decisión sobre un error
  | "completed" // ejecución exitosa
  | "failed" // ejecución con error
  | "cancelled"; // cancelada por usuario o sistema

/**
 * Metadata de la task. Política de uso:
 * - SOLO para datos transitorios de runtime (trace ID, user agent, session ID).
 * - Si un dato es recurrente y se necesita persistir/consultar, agregar campo explícito.
 * - NO guardar outputs de nodos acá (eso es NodeResult).
 * - NO abusar. Si la cantidad de metadata crece, repensar la arquitectura.
 */
export type TaskMetadata = Record<string, unknown>;

export interface TaskError {
  readonly code: ErrorCode;
  readonly message: string;
  /** ID del nodo donde falló. */
  readonly failedNode?: string;
}

// ============================================================
// NodeResult — output persistido de un nodo
// ============================================================

export interface NodeResult {
  readonly nodeId: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";

  /** Output del nodo (lo que se va a escribir al state según output.to). */
  output?: unknown;

  /** Input que el nodo leyó del state (snapshot al inicio de la ejecución). */
  input?: unknown;

  /** Para LLM nodes: snapshot del prompt enviado (system + user + tools). */
  promptSnapshot?: PromptSnapshot;

  /** Confidence label (HIGH/MEDIUM/LOW) si el nodo es LLM y aplicó gating. */
  confidence?: "HIGH" | "MEDIUM" | "LOW";

  /** Valor numérico de confianza (0-1) si el nodo es LLM. */
  confidenceValue?: number;

  /** Si el approver declinó, la razón. */
  declinedReason?: string;

  readonly startedAt: string;
  completedAt?: string;
  durationMs?: number;

  /** Tokens consumidos (solo nodos LLM). */
  tokensUsed?: { readonly input: number; readonly output: number };

  /** Costo en USD atribuido a este nodo. */
  costUsd?: number;

  /** Modelo específico usado (resuelto de la tier). */
  modelUsed?: string;

  /** Cantidad de retries que se ejecutaron antes de completar/fallar. */
  retryCount?: number;

  /** Idempotency key resuelta (si el nodo declaró `idempotencyKey`). */
  idempotencyKey?: string;

  error?: NodeError;
}

export interface PromptSnapshot {
  readonly system?: string;
  readonly user?: string;
  readonly tools?: readonly string[];
}

// ============================================================
// PendingHITLDecision — contexto de pausa HITL (D2a.4)
// ============================================================

/**
 * Persiste el contexto de una task en `paused_hitl`. Se llena cuando el
 * motor entra en pausa HITL y se borra cuando `resumeTask` o `cancelTask`
 * resuelve la task. Inmutable desde que se crea hasta que se resuelve
 * (por eso `readonly` en todos los campos).
 *
 * Permite que `executor.resumeTask(taskId, response)` sepa:
 * - Qué nodo HITL reanudar (nodeId).
 * - Qué `requestId` emitió el handler (vínculo a la notificación externa).
 * - Qué `outputSchema` validar la respuesta contra.
 * - Desde cuándo está esperando (startedAt, para audit "lleva N días").
 *
 * D2a.4 — ver `AGENT_D2A_4_HITL_PRIMITIVES_SPEC.md` §4.1.
 */
export interface PendingHITLDecision {
  /** ID del nodo HITL que está esperando. */
  readonly nodeId: string;

  /** ID del request emitido por el HITLHandler.initiate(). Vínculo a la notificación externa. */
  readonly requestId: string;

  /** Approvers declarados en el nodo. Para audit. */
  readonly approvers: readonly string[];

  /** Pregunta resuelta (template interpolado). Para que el caller sepa qué preguntó. */
  readonly question: unknown;

  /** Contexto resuelto (template interpolado). Idem. */
  readonly context?: unknown;

  /** Output schema del nodo. Se usa para validar la respuesta en `resumeTask`. */
  readonly outputSchema?: Record<string, unknown>;

  /** Timestamp de cuándo se inició la pausa. Para audit ("lleva 3 días esperando"). */
  readonly startedAt: string;
}

export interface NodeError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retriable: boolean;
  readonly stack?: string;
}

// ============================================================
// Constantes
// ============================================================

/** Versión del spec del DSL que este código implementa. */
export const DSL_SCHEMA_VERSION = 1 as const;

/** Versión semver de este código del motor. */
export const ENGINE_VERSION = "0.1.0-d2a.1" as const;
