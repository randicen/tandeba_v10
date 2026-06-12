# Worgena Workflow DSL — Spec v0.2

> **Spec para D2a.1 (Schema + tipos del motor de workflows).** Esta es la **fuente de verdad** del DSL. La implementación en TypeScript debe reflejar este spec sin desviarse. Cambios al spec se acuerdan y actualizan **antes** de tocar código.

## 0. Status

- **Versión actual**: 0.2 (revisión del otro M3 aplicada — ver CHANGELOG al final)
- **Alcance**: D2a (motor propio mínimo, single-process)
- **No incluye** (ver §1.2): workers distribuidos, scheduling, time-travel UI, saga patterns, paralelismo arbitrario, drag-and-drop UI, fanout/fanin
- **Stack objetivo**: TypeScript + JSON Schema (validación) + SQLite (D2a) → Postgres (D3)
- **Owner del cambio**: este spec vive en el repo. Modificaciones requieren acuerdo explícito antes de mergear.

---

## 1. Goals & Non-goals

### 1.1. Goals (lo que el DSL DEBE cumplir)

1. **Workflows como data, no como código.** Un workflow es un objeto JSON/YAML que vive en DB. Se modifica sin redeploy.
2. **Versionable.** Cada workflow tiene `workflowVersion` (semver del contenido) y `schemaVersion` (versión del spec del DSL que usa). Workflows viejos siguen funcionando cuando se actualiza el spec, vía migradores explícitos.
3. **Portable.** El formato NO depende del runtime de Worgena. Un workflow escrito en JSON puede leerse, validarse y entenderse sin ejecutar nada. (No es un framework, es un formato.)
4. **Audit-friendly.** Cada ejecución produce logs estructurados por nodo, con trace ID, tokens consumidos, costo atribuido, modelo usado, retries.
5. **Idempotente.** Un nodo que se ejecuta dos veces (por retry) produce el mismo resultado o falla explícitamente. La idempotencia es declarada por el autor del nodo, no inferida.
6. **Replayable.** Dado un `taskId` y los `nodeResults` históricos, se puede re-ejecutar el workflow desde un nodo específico o con un input modificado, para comparar resultados.
7. **HITL como primitiva de primera clase.** La pausa para aprobación humana no es un workaround; es un tipo de nodo (`hitl`) con semántica explícita de pause/resume/timeout.
8. **Confidence gating declarativo.** Los nodos LLM pueden declarar umbrales HIGH/MEDIUM/LOW y la acción a tomar en cada caso. La lógica no se mete en el prompt.
9. **Multi-modelo declarativo.** El modelo a usar en un nodo LLM se declara en el workflow, no se infiere en runtime. Las tiers (liviano, robusto) son referencias a configuración del motor.

### 1.2. Non-goals (v1 — diferidos, no en D2a)

- **Workers distribuidos / scheduling**: ejecución single-process. No hay cron, no hay recurrencia.
- **Saga patterns / compensación distribuida**: si un nodo falla, se reintenta o se falla la task. No hay rollback complejo.
- **Time-travel UI fancy**: guardamos snapshots por nodo, pero la UI para navegar el histórico es para D3.
- **Drag-and-drop editor**: workflows se editan como YAML/JSON, con preview textual. Editor visual es para D6.
- **Loops arbitrarios**: workflows son DAGs (grafos dirigidos acíclicos). Fan-out/fan-in es primitiva explícita; loops genéricos no.
- **Paralelismo arbitrario de nodos**: fan-out en v1 es **secuencial** (un nodo se corre N veces seguidas). Paralelismo real es v2.
- **Sub-workflows (composición)**: un workflow no llama a otro. Si hace falta, se duplica o se parametriza.
- **Dynamic workflow generation**: el workflow se define en el momento del alta, no se genera en runtime por el LLM.

---

## 2. Conceptos centrales

| Concepto | Qué es | Quién lo crea | Quién lo consume |
|---|---|---|---|
| **WorkflowDefinition** | Plantilla inmutable. Define nodos, edges, state schema. Vive en DB con `workflowVersion`. | El usuario (UI en D6) o el sistema (workflows predefinidos) | El engine al instanciar una Task |
| **Task** | Instancia de runtime. Una ejecución concreta de un workflow con un input dado. | El engine, al recibir input del intake router | El engine, el usuario (UI), el audit log |
| **Node** | Unidad de trabajo. Tipos: `function`, `llm`, `hitl`, `router`, `fanout`, `fanin`. | El autor del workflow | El engine al ejecutar la task |
| **Edge** | Transición entre nodos. Puede ser incondicional o condicional (basada en state). | El autor del workflow | El engine al decidir el siguiente nodo |
| **State** | Dato mutable que pasa entre nodos. Tipado por `stateSchema`. | Cada nodo produce parte del state | El siguiente nodo, el router, el verificador |
| **NodeResult** | Output persistido de un nodo. Es la unidad de audit y replay. | El engine, al cerrar un nodo | El verificador, el debugger, el replay |

**Analogía con un proceso de manufactura**: el workflow es el plano de la fábrica. La task es la orden de producción específica. Los nodos son las estaciones. Los edges son las correas transportadoras. El state es el producto semi-terminado moviéndose por la línea. El NodeResult es el ticket de calidad de cada estación.

---

## 3. Tipos TypeScript (fuente de verdad para la implementación)

```typescript
// ============================================================
// WorkflowDefinition — la plantilla inmutable
// ============================================================

interface WorkflowDefinition {
  /** Identificador estable (slug, sin version). Ej: "revision-generica" */
  id: string;

  /** Nombre legible para UI. */
  name: string;

  /** Descripción opcional del workflow. */
  description?: string;

  /** Versión semver del contenido de ESTE workflow. Ej: "1.0.0", "1.2.3" */
  workflowVersion: string;

  /** Versión del spec del DSL que este workflow fue escrito contra. Hoy: 1 */
  schemaVersion: 1;

  /** JSON Schema que valida el `state` en runtime. */
  stateSchema: JSONSchema;

  /** Lista de nodos del grafo. */
  nodes: Node[];

  /** Lista de edges (transiciones) entre nodos. */
  edges: Edge[];

  /** ID del nodo donde arranca la ejecución. */
  entryNode: string;

  /** Configuración default aplicable a todos los nodos. */
  config?: WorkflowConfig;
}

interface WorkflowConfig {
  /** Retries default para nodos que no especifican. Default: 0. */
  defaultRetries?: number;
  /** Timeout default en ms. Default: 60000 (1 min). */
  defaultTimeoutMs?: number;
  /** Defaults para nodos HITL. */
  hitlDefaults?: HITLConfig;
}

// ============================================================
// Node — unión discriminada por `type` (D2a)
// ============================================================
// Nota: FanoutNode y FaninNode se difieren a D2b (ver §9).

type Node = FunctionNode | LLMNode | HITLNode | RouterNode;

interface BaseNode {
  /** ID único dentro del workflow. */
  id: string;
  /** Nombre legible para UI y logs. */
  name?: string;
  /** Descripción opcional. */
  description?: string;
  /** Override del timeout default del workflow. */
  timeoutMs?: number;
  /** Política de retries para este nodo. Default: 0 retries. */
  retries?: RetryConfig;
  /**
   * Template para computar la idempotency key.
   * - Si se declara: el motor re-ejecuta con cache (output cacheado si la key matchea).
   * - Si NO se declara y `retriable=true`: retry sin cache (útil para funciones puras).
   * - Si NO se declara y `retriable=false` (default): FALLA con `NON_IDEMPOTENT_RETRY_DISALLOWED`.
   * Ver §6.1 para detalles.
   */
  idempotencyKey?: string;
  /** Si true, el nodo es reintenable sin idempotencyKey. Default: false. */
  retriable?: boolean;
  /** Qué hacer si el nodo falla definitivamente. Default: 'fail'. */
  onError?: NodeErrorAction;
}

type NodeErrorAction =
  | 'fail'           // la task pasa a status='failed'
  | 'continue'       // marca el nodo como 'skipped' y sigue
  | { goto: string }; // salta al nodo especificado

// ============================================================
// Códigos de error reconocidos (catálogo único)
// ============================================================

type ErrorCode =
  | 'RATE_LIMIT'                       // upstream provider rate limit
  | 'TIMEOUT'                          // timeout de la operación
  | 'NETWORK_ERROR'                    // fallo de red transitorio
  | 'INVALID_OUTPUT'                   // el output no validó contra outputSchema
  | 'SCHEMA_VIOLATION'                 // el state no validó contra stateSchema
  | 'CONTEXT_TOO_LONG'                 // el prompt excedió la ventana del modelo
  | 'MODEL_UNAVAILABLE'                // el modelo configurado no responde
  | 'INTERNAL_ERROR'                   // bug nuestro
  | 'HITL_TIMEOUT'                     // un nodo HITL expiró
  | 'HITL_DECLINED'                    // un approver declinó (ej: conflicto de interés)
  | 'NON_IDEMPOTENT_RETRY_DISALLOWED'  // falló retry en nodo sin idempotencyKey ni retriable
  | 'ROUTER_NO_MATCH'                  // el router no encontró match ni default
  | 'WORKFLOW_HAS_CYCLE'               // validación al cargar
  | 'TASK_ALREADY_RUNNING'             // re-ejecución concurrente rechazada
  | 'SCHEMA_VERSION_UNSUPPORTED';      // schemaVersion del workflow > la del motor

interface RetryConfig {
  /** Cantidad máxima de reintentos (no incluye la ejecución inicial). */
  max: number;
  /** Tipo de backoff. Default: 'exponential'. */
  backoff?: 'fixed' | 'exponential';
  /** Delay inicial en ms. Default: 1000. */
  initialDelayMs?: number;
  /**
   * Códigos de error que disparan retry. Si está vacío, todos los errores
   * catalogados como retriable disparan retry (ver errorClassifier en runtime).
   */
  on?: ErrorCode[];
}

// ---- FunctionNode: ejecuta código registrado (tool / skill / acción custom)

interface FunctionNode extends BaseNode {
  type: 'function';
  /** Nombre de la función registrada en el motor. */
  functionRef: string;
  input: NodeInput;
  output: NodeOutput;
}

// ---- LLMNode: invoca un LLM con un prompt y tools opcionales

interface LLMNode extends BaseNode {
  type: 'llm';
  /** Tier de modelo o nombre específico. Tier se resuelve a modelo vía config del motor. */
  model: ModelRef;
  /** System prompt del nodo. Puede referenciar state con {{state.X}}. */
  systemPrompt?: string;
  /** User prompt (alternativo al systemPrompt). Más común para prompts dinámicos. */
  userPrompt?: string;
  /** Skills a cargar (instrucciones + contexto adicional). */
  skills?: string[];
  /** Tools disponibles para este nodo. */
  tools?: string[];
  input: NodeInput;
  output: NodeOutput;
  /**
   * JSON Schema que valida el output del LLM.
   * Si se declara `confidenceGating`, este schema DEBE tener la propiedad
   * `confidence: { type: "number", minimum: 0, maximum: 1 }`. Validado al cargar.
   */
  outputSchema?: JSONSchema;
  confidenceGating?: ConfidenceGatingConfig;
}

/** Tier (referencia simbólica) o nombre específico de modelo. */
type ModelRef = 'liviano' | 'robusto' | string;

// ---- HITLNode: pausa para aprobación humana

interface HITLNode extends BaseNode {
  type: 'hitl';
  /** IDs o roles de los approvers. Ej: "role:abogado_senior", "user:uuid" */
  approvers: string[];
  /** Qué mostrarle al humano (la pregunta). */
  question: NodeInput;
  /** Contexto adicional para que el humano decida. */
  context?: NodeInput;
  /** Input que se pasa al humano para que reaccione (opcional). */
  input?: NodeInput;
  output: NodeOutput;
  /**
   * Si hay múltiples approvers, cómo se agregan las respuestas.
   * - 'any': con que uno apruebe, sigue (first-wins).
   * - 'all': todos deben aprobar.
   * - 'majority': más de la mitad.
   * Default: 'any'.
   */
  approvalMode?: 'any' | 'all' | 'majority';
  /**
   * JSON Schema opcional que valida la respuesta humana.
   * Si no se declara: modo permisivo (log warning, acepta lo que venga).
   * Si se declara, se valida. Si falla, el approver puede reintentar o se aplica onError.
   */
  outputSchema?: JSONSchema;
  /** Timeout en ms. Si expira, se ejecuta onTimeout. */
  timeoutMs?: number;
  /** Acción al expirar. Default: 'fail'. */
  onTimeout?: 'fail' | 'approve' | 'reject';
  /**
   * Si true, los approvers pueden declinar con una razón (ej: conflicto de interés).
   * La razón se persiste en NodeResult.declinedReason y la task falla con HITL_DECLINED.
   * Default: false.
   */
  allowDecline?: boolean;
  /**
   * Razones válidas para declinar. Default: ['conflict_of_interest', 'other'].
   * Las firmas pueden extender con razones custom en su config.
   */
  declineReasons?: string[];
}

interface HITLConfig {
  approvers: string[];
  timeoutMs: number;
  onTimeout: 'fail' | 'approve' | 'reject';
}

// ---- RouterNode: bifurcación basada en un valor del state

interface RouterNode extends BaseNode {
  type: 'router';
  /** Valor a comparar contra las claves de `routes`. */
  decision: NodeInput;
  /** Mapa de valor (string) → nodeId. */
  routes: Record<string, string>;
  /** Nodo default si el valor no está en routes. */
  default?: string;
  /**
   * Cómo se compara el valor de `decision` contra las claves de `routes`.
   * - 'exact': case-sensitive, sin trim, exact match.
   * - 'case-insensitive': case-insensitive, sin trim.
   * Default: 'exact'.
   * Para matching más flexible (regex, fuzzy, etc.), agregar un nodo function previo que normalice.
   */
  matchMode?: 'exact' | 'case-insensitive';
}

// ============================================================
// Edge — transición entre nodos
// ============================================================

interface Edge {
  /** ID del nodo origen. */
  from: string;
  /** ID del nodo destino. */
  to: string;
  /**
   * Condición opcional. Si no se declara, edge incondicional.
   * IMPORTANTE: la decisión de ejecutar un nodo se hace en el EDGE de entrada, no en el nodo.
   * Si ningún edge lleva al nodo, este no se ejecuta. Esto es cómo se "salta" un nodo
   * condicionalmente (ej: "ejecuta extract solo si classification.category === 'contrato'").
   *
   * El valor resuelto se interpreta como boolean: truthy = tomar el edge.
   */
  condition?: NodeInput;
}

// ============================================================
// NodeInput, NodeOutput, StateRef — referencia al state
// ============================================================

/**
 * Referencia al state. Dos formas equivalentes:
 * - `template`: "{{state.foo.bar}}" — interpolación de strings.
 * - `path`:    "foo.bar"            — dot-notation (más simple para paths directos).
 *
 * El motor resuelve ambos al mismo modelo. Para inputs/outputs simples, path.
 * Para interpolación con strings compuestas, template.
 *
 * Si no se especifica ninguno, se opera con el `result` completo del nodo (vía path implícito).
 */
interface StateRef {
  template?: string;
  path?: string;
}

/** Input de un nodo: de dónde leer del state. */
interface NodeInput {
  /** De dónde leer. */
  from: StateRef;
  /** Default si `from` resuelve a undefined. */
  default?: unknown;
}

/** Output de un nodo: dónde escribir al state. */
interface NodeOutput {
  /** Dónde escribir. Si no se especifica `template` o `path`, se escribe el `result` completo del nodo. */
  to: StateRef;
}

// ============================================================
// Confidence gating
// ============================================================

interface ConfidenceGatingConfig {
  /** Umbral (0-1) sobre el cual la confianza es HIGH. */
  highThreshold: number;
  /** Umbral (0-1) sobre el cual la confianza es MEDIUM. Debe ser < highThreshold. */
  mediumThreshold: number;
  /** Qué hacer si la confianza es MEDIUM. */
  onMedium: 'search_more' | 'continue' | 'ask_user';
  /** Qué hacer si la confianza es LOW. */
  onLow: 'ask_user' | 'fail';
}

// ============================================================
// Task — instancia de runtime
// ============================================================

interface Task {
  /** ID único de la task. */
  taskId: string;
  /** ID del workflow que se está ejecutando. */
  workflowId: string;
  /** Versión del workflow (snapshot inmutable al momento de crear la task). */
  workflowVersion: string;
  /** Estado actual, validado contra stateSchema. */
  state: unknown;
  /** Estado de la task en el ciclo de vida. */
  status: TaskStatus;
  /** ID del nodo que se está ejecutando actualmente (o se va a ejecutar). */
  currentNode: string;
  /** Resultados persistidos por nodo. */
  nodeResults: Record<string, NodeResult>;
  /** Timestamps. */
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  /** Tenant al que pertenece la task. */
  tenantId: string;
  /** Input inicial. */
  input: unknown;
  /** Error global de la task (si status='failed'). */
  error?: TaskError;
  /** Metadata de runtime. Política: no abusar (ver comentario en TaskMetadata). */
  metadata?: TaskMetadata;
  /** Si esta task es un replay, taskId original. La task original queda intacta. */
  replayOf?: string;
  /** Qué se modificó en el replay (input diferente, opcional). */
  replayInput?: Record<string, unknown>;
  /** Desde qué nodo se re-ejecutó. Si no se declara, desde entryNode. */
  replayFromNode?: string;
}

type TaskStatus =
  | 'pending'      // creada pero no iniciada
  | 'running'      // ejecutando un nodo
  | 'paused_hitl'  // esperando respuesta humana
  | 'paused_error' // esperando decisión sobre un error
  | 'completed'    // ejecución exitosa
  | 'failed'       // ejecución con error
  | 'cancelled';   // cancelada por usuario o sistema

/**
 * Metadata de la task. Política de uso:
 * - SOLO para datos transitorios de runtime (trace ID, user agent, session ID).
 * - Si un dato es recurrente y se necesita persistir/consultar, agregar campo explícito.
 * - NO guardar outputs de nodos acá (eso es NodeResult).
 * - NO abusar. Si la cantidad de metadata crece, repensar la arquitectura.
 */
type TaskMetadata = Record<string, unknown>;

interface TaskError {
  code: ErrorCode;
  message: string;
  /** ID del nodo donde falló. */
  failedNode?: string;
}

// ============================================================
// NodeResult — output persistido de un nodo
// ============================================================

interface NodeResult {
  nodeId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  /** Output del nodo (lo que se va a escribir al state según output.to). */
  output?: unknown;
  /** Input que el nodo leyó del state (snapshot al inicio de la ejecución). */
  input?: unknown;
  /** Para LLM nodes: snapshot del prompt enviado (system + user + tools). */
  promptSnapshot?: PromptSnapshot;
  /** Confidence label (HIGH/MEDIUM/LOW) si el nodo es LLM y aplicó gating. */
  confidence?: 'HIGH' | 'MEDIUM' | 'LOW';
  /** Valor numérico de confianza (0-1) si el nodo es LLM. */
  confidenceValue?: number;
  /** Si el approver declinó, la razón. */
  declinedReason?: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  /** Tokens consumidos (solo nodos LLM). */
  tokensUsed?: { input: number; output: number };
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

interface PromptSnapshot {
  system?: string;
  user?: string;
  tools?: string[];
}

interface NodeError {
  code: ErrorCode;
  message: string;
  retriable: boolean;
  stack?: string;
}

// ============================================================
// JSONSchema (tipo genérico, implementación en lib externa)
// ============================================================

type JSONSchema = object; // Tipo completo se importa de la lib de validación elegida
```

---

## 4. JSON Schema (resumen del top-level)

El JSON Schema completo se genera a partir de los tipos de §3 usando `typescript-json-schema` o similar. A continuación, el schema mínimo del top-level para validar que un JSON es un `WorkflowDefinition` válido:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["id", "name", "workflowVersion", "schemaVersion", "stateSchema", "nodes", "edges", "entryNode"],
  "properties": {
    "id": { "type": "string", "pattern": "^[a-z0-9-]+$" },
    "name": { "type": "string" },
    "description": { "type": "string" },
    "workflowVersion": { "type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+$" },
    "schemaVersion": { "const": 1 },
    "stateSchema": { "type": "object" },
    "nodes": { "type": "array", "minItems": 1 },
    "edges": { "type": "array" },
    "entryNode": { "type": "string" },
    "config": { "type": "object" }
  }
}
```

**Decisión**: por cada tipo de nodo, se valida con su sub-schema específico. JSON Schema soporta `oneOf` para uniones discriminadas por el campo `type`.

---

## 5. Ejemplo: workflow "Revisión Genérica" (workflow de prueba v1)

Workflow ultra-simple, **no representativo** del caso de uso real. Sirve para validar el motor. 4 nodos, sin paralelismo, sin condicionales complejas.

```json
{
  "id": "revision-generica",
  "name": "Revisión Genérica de Documentos",
  "description": "Workflow de prueba v1 del motor. Clasifica, extrae, resume y pide aprobación humana. NO es representativo de un caso legal real — se eligió por simplicidad para validar el motor.",
  "workflowVersion": "1.0.0",
  "schemaVersion": 1,
  "stateSchema": {
    "type": "object",
    "properties": {
      "documentId": { "type": "string" },
      "documentContent": { "type": "string" },
      "classification": {
        "type": "object",
        "properties": {
          "category": { "type": "string" },
          "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
        }
      },
      "extractedClauses": {
        "type": "array",
        "items": { "type": "object" }
      },
      "summary": { "type": "string" },
      "approval": {
        "type": "object",
        "properties": {
          "approved": { "type": "boolean" },
          "feedback": { "type": "string" }
        }
      }
    }
  },
  "config": {
    "defaultTimeoutMs": 60000,
    "defaultRetries": 0
  },
  "nodes": [
    {
      "id": "classify",
      "type": "llm",
      "name": "Clasificar documento",
      "model": "liviano",
      "systemPrompt": "Sos un clasificador de documentos legales. Recibís el contenido de un documento y devolvés su categoría (contrato / demanda / sentencia / opinión / otro) y tu nivel de confianza entre 0 y 1 (0 = sin idea, 1 = absolutamente seguro).",
      "input": { "from": { "template": "{{state.documentContent}}" } },
      "output": { "to": { "path": "classification" } },
      "outputSchema": {
        "type": "object",
        "required": ["category", "confidence"],
        "properties": {
          "category": { "type": "string" },
          "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
        }
      },
      "confidenceGating": {
        "highThreshold": 0.8,
        "mediumThreshold": 0.5,
        "onMedium": "continue",
        "onLow": "ask_user"
      }
    },
    {
      "id": "extract",
      "type": "llm",
      "name": "Extraer cláusulas",
      "model": "robusto",
      "skills": ["clause-extractor-v1"],
      "input": { "from": { "template": "{{state.documentContent}}" } },
      "output": { "to": { "path": "extractedClauses" } },
      "retries": { "max": 2, "on": ["RATE_LIMIT", "TIMEOUT"] }
    },
    {
      "id": "summarize",
      "type": "llm",
      "name": "Resumir documento",
      "model": "robusto",
      "input": {
        "from": { "template": "DOCUMENTO:\n{{state.documentContent}}\n\nCLÁUSULAS EXTRAÍDAS:\n{{state.extractedClauses}}" }
      },
      "output": { "to": { "template": "{{result.summary}}", "path": "summary" } }
    },
    {
      "id": "approve",
      "type": "hitl",
      "name": "Aprobación humana",
      "approvers": ["role:abogado_senior"],
      "question": { "from": { "template": "¿Aprobás este resumen del documento?\n\n{{state.summary}}" } },
      "context": { "from": { "template": "Documento ID: {{state.documentId}}\nCategoría: {{state.classification.category}}" } },
      "output": { "to": { "path": "approval" } },
      "outputSchema": {
        "type": "object",
        "required": ["approved"],
        "properties": {
          "approved": { "type": "boolean" },
          "feedback": { "type": "string" }
        }
      },
      "approvalMode": "any",
      "allowDecline": true,
      "declineReasons": ["conflict_of_interest", "needs_revision", "other"],
      "timeoutMs": 86400000,
      "onTimeout": "fail"
    }
  ],
  "edges": [
    { "from": "classify", "to": "extract" },
    { "from": "extract", "to": "summarize" },
    { "from": "summarize", "to": "approve" }
  ],
  "entryNode": "classify"
}
```

---

## 6. Primitivas (comportamiento garantizado por el motor)

### 6.1. Idempotencia

**Cómo se declara**: el autor del nodo puede declarar `idempotencyKey: "{{state.documentId}}-{{node.id}}"` (template evaluado contra el state actual). Opcionalmente, puede marcar el nodo como `retriable: true` si quiere que el motor reintente sin cachear (útil para funciones puras).

**Cómo funciona**:

1. Antes de ejecutar un nodo, el engine computa la `idempotencyKey` resolviendo el template contra el state actual.
2. Busca en `nodeResults` si ya existe un `NodeResult` con ese mismo `key` Y `status='completed'`.
3. Si existe, **retorna el output cacheado** sin re-ejecutar el nodo.
4. Si no existe, ejecuta normalmente y al cerrar guarda la `idempotencyKey` resuelta en el `NodeResult`.

**Reglas duras (revisadas)**:

- Si el nodo declara `idempotencyKey`: re-ejecución con cache. Seguro para nodos que mutan estado externo.
- Si el nodo declara `retriable: true` (sin key): re-ejecución sin cache. Útil para funciones puras que no mutan nada (cálculos, transformaciones). El motor las puede reintentar libremente.
- **Si el nodo NO declara ni `idempotencyKey` ni `retriable`, y el motor detecta un error retriable**: el nodo **falla con `NON_IDEMPOTENT_RETRY_DISALLOWED`**. Esto es una decisión de seguridad, no una limitación: en el caso de funciones que mutan estado externo (enviar email, cobrar tarjeta, publicar en Slack), retry silencioso es un bug grave. Esta regla te protege.
- Si el `NodeResult` previo está `failed`, **se re-ejecuta** (los fallos no son cacheables).
- Si el state cambió de tal forma que la `idempotencyKey` cambia, se re-ejecuta (nueva "operación lógica").

### 6.2. Retries

**Cómo se declara**: `retries: { max: 2, on: ["RATE_LIMIT", "TIMEOUT"], backoff: "exponential" }`.

**Cómo funciona**:

1. Si la ejecución de un nodo falla con un error cuyo `code` está en `on` (o si `on` está vacío y cualquier error catalogado como retriable), el engine espera `initialDelayMs * 2^retryCount` y reintenta.
2. Repite hasta `max` veces. Si tras `max` reintentos sigue fallando, se ejecuta `onError`.
3. **Solo se reintenta si la idempotencia es segura**: o el nodo declaró `idempotencyKey` (cache), o `retriable: true` (función pura), o es un nodo que el motor considera intrínsecamente idempotente (read-only por diseño).
4. Si la idempotencia no es segura y el error es retriable, falla con `NON_IDEMPOTENT_RETRY_DISALLOWED` (ver §6.1).

**Catálogo de errores** (ver `ErrorCode` en §3): los códigos que el motor reconoce son los del union type. El motor hace el mapping desde errores del SDK/provider a estos códigos en un único `errorClassifier.ts` centralizado. Sin esto, retry no dispararía porque el código no matchearía.

### 6.3. HITL (Human-in-the-Loop)

**Cómo se declara**: nodo con `type: 'hitl'`. Puede declarar `outputSchema`, `approvalMode`, `allowDecline`, `declineReasons`, `timeoutMs`, `onTimeout`.

**Cómo funciona**:

1. Cuando el engine alcanza un nodo `hitl`, **pausa la task**. Status pasa a `paused_hitl`.
2. El engine emite una notificación (UI, email, webhook — el canal es externo al motor).
3. Un humano responde a través del canal. La respuesta se valida contra `outputSchema` si está declarado. Si no, se acepta en modo permisivo (con warning en logs).
4. Si hay múltiples approvers, se aplica `approvalMode`:
   - `any` (default): el primero que aprueba, sigue. Los demás dejan de recibir notificaciones.
   - `all`: todos deben aprobar. Si uno declina, el nodo falla.
   - `majority`: más de la mitad deben aprobar.
5. El engine escribe la respuesta en el `output` declarado, marca el `NodeResult` como `completed`, y reanuda la task.
6. Si `timeoutMs` expira antes de la respuesta, se ejecuta `onTimeout`: `fail`, `approve` o `reject`.
7. **Declinación por conflicto de interés** (en legal, común): si `allowDecline: true`, el approver puede declinar con una razón (`declineReasons`, default `['conflict_of_interest', 'other']`). El `NodeResult` persiste `declinedReason`, y la task falla con `HITL_DECLINED`.

**Re-notificación en timeouts largos**: en D2a, NO hay re-notificación automática. El motor espera la respuesta o el timeout. Si el canal de notificación falla (email bounce, webhook 500), el workflow se queda pausado hasta el timeout. La política de recordatorios es responsabilidad de la capa de UI/notification (D3+). Documentado como limitación.

**Reglas duras**:

- Una task `paused_hitl` no consume recursos del engine (solo storage).
- El humano puede ver la task pausada, leer el contexto, y dar una respuesta estructurada.
- **El motor NO decide qué approvers** están autorizados — eso es política del workflow. El engine solo verifica que el approver está en la lista del nodo.

### 6.4. Confidence Gating (para nodos LLM)

**Cómo se declara**: `confidenceGating: { highThreshold: 0.8, mediumThreshold: 0.5, onMedium: "continue", onLow: "ask_user" }`.

**Cómo funciona**:

1. Cuando un nodo LLM termina, el motor lee la confianza reportada por el LLM en el output, campo `confidence` de tipo `number` (rango 0-1).
2. Compara con los umbrales:
   - `confidence >= highThreshold` → HIGH → continúa.
   - `mediumThreshold <= confidence < highThreshold` → MEDIUM → `onMedium`.
   - `confidence < mediumThreshold` → LOW → `onLow`.
3. Acciones posibles:
   - `onMedium: "search_more"` → busca más información (tool call adicional) y re-ejecuta el nodo.
   - `onMedium: "continue"` → sigue al siguiente nodo.
   - `onMedium: "ask_user"` → pausa la task pidiendo clarificación.
   - `onLow: "ask_user"` → pausa la task pidiendo clarificación.
   - `onLow: "fail"` → la task falla.

**Reglas duras**:

- **Validación al cargar el workflow**: si `confidenceGating` está declarado, `outputSchema` DEBE contener `confidence: { type: "number", minimum: 0, maximum: 1 }`. Si no, falla con `INVALID_WORKFLOW_DEFINITION` al cargar, no en runtime.
- Si el output del LLM no tiene `confidence` (o no valida el schema), no se aplica gating y se loguea warning.
- **Por qué el LLM declara y el motor no evalúa (con logprobs)**:
  - Logprobs no están disponibles en todos los modelos. Atar el gating a logprobs ata a un subconjunto de proveedores.
  - La confianza semántica del LLM es más interpretable que la estadística.
  - El workflow sabe qué umbral es razonable para su tarea; el motor no.

### 6.5. Time travel / replay

**Cómo se declara**: NO se declara. Es una capacidad del engine, expuesta como API.

**Cómo funciona**:

1. El engine guarda un **snapshot del state** al inicio de cada nodo, en el `NodeResult`.
2. Para hacer replay de una task: el usuario (o un admin) llama a una API `POST /tasks/:id/replay` con:
   - El nuevo `input` (opcional)
   - El nodo desde el cual re-ejecutar (opcional, default: `entryNode`)
3. El engine clona la task original, aplica los cambios, y crea una **nueva task** marcada con:
   - `replayOf: <originalTaskId>` — referencia a la original.
   - `replayInput: { ... }` — qué se modificó.
   - `replayFromNode: <nodeId>` — desde dónde se re-ejecuta.
4. La nueva task se ejecuta desde el punto indicado, con state inicializado a `{ input: newInput }` (reset total). El `newInput` es el `input` provisto al `replayTask()`, o el `input` de la task original si no se proveyó. Los nodos que ya se ejecutaron en la original SE RE-EJECUTAN en el replay (no se copian `nodeResults`); el `nodeResults` del replay arranca vacío y se llena a medida que los nodos se ejecutan.

**Nota sobre "state reseteado al snapshot"**: en versiones anteriores del spec esta frase era ambigua entre reset total, reset al state del `fromNode`, y reset parcial. Se aclara acá: el state del replay es `{ input: newInput }`, sin datos de la original más allá del input. El reset parcial (reconstruir state desde `nodeResults` de la original) es D3+. Ver `AGENT_D2A_2_3_CORE_PRIMITIVES_SPEC.md` §6.4.

**Regla dura**: el replay es **clon de task, no branch in-place**. La task original queda en su estado final, sin modificar. La nueva task referencia a la original via `replayOf`. Esto garantiza:
- Audit legal: una task nunca se sobrescribe (relevante en Colombia, donde la inmutabilidad de documentos legales es importante).
- Comparación side-by-side entre original y replay.
- In-place branch sería destructivo: si re-ejecutás y falla, perdiste el resultado bueno.

**Casos de uso**:

- Re-ejecutar un workflow con un modelo distinto (cambiar `model: 'liviano'` → `'robusto'`) para comparar resultados.
- Re-ejecutar después de un bug fix en una `function` registrada.
- Re-ejecutar una rama específica (cambiar el input que tomaba un router) para validar lógica.

**Limitaciones v1**:

- El replay es **clon de task**, no "branch in-place". La task original queda intacta.
- Solo se re-ejecuta desde un nodo que tenga snapshot (todos los nodos tienen snapshot, así que esto es solo aclaración).
- No hay "merge" de resultados de replay con la task original.

### 6.6. Schema versioning (migración de workflows)

**Cómo se declara**: el campo `schemaVersion` en cada `WorkflowDefinition`. Para workflows escritos contra spec v1, vale `1`. Cuando salga spec v2, los workflows nuevos tendrán `schemaVersion: 2`.

**Cómo funciona**:

1. Al cargar un workflow de DB, el engine compara su `schemaVersion` con la versión actual del spec.
2. Si son iguales, OK.
3. Si el del workflow es **menor** que el actual, el engine busca un migrador registrado: `migrators[fromVersion][toVersion]`. Si existe, lo aplica. Si no, falla con error claro: "No hay migrador de spec v1 a v2 para workflows del tipo X".
4. Si el del workflow es **mayor** que el actual, el engine rechaza la carga con `SCHEMA_VERSION_UNSUPPORTED`: "Workflow escrito contra spec v2, el motor actual solo soporta v1. Actualizá el motor."

**Migradores** son funciones puras registradas en el motor: `function migrator_v1_to_v2(workflow: WorkflowDefinition): WorkflowDefinition`.

**Regla dura**: un migrador **nunca** borra datos. Solo agrega campos con defaults razonables, renombra, o reorganiza. Si la transformación requiere decisión humana, el migrador falla y pide acción manual.

### 6.7. Cancelación externa

**Por qué**: en multi-tenant, el usuario va a querer "cancelar este workflow que se colgó" o "cambié de opinión, no sigas". Sin esto, un workflow LLM puede quedar esperando respuesta 5 minutos sin que el usuario pueda pararlo.

**Cómo se declara**: NO se declara en el workflow. Es una capacidad del engine, expuesta como API.

**Cómo funciona**:

1. El usuario (o un admin) llama a `POST /tasks/:id/cancel`.
2. El engine marca la task con `status: 'cancelled'`. **No mata la ejecución actual del nodo en curso** (no podemos interrumpir una llamada al LLM a mitad), pero el motor chequea el status **antes de cada nodo**.
3. Cuando el nodo actual termina, el motor ve `status === 'cancelled'`, persiste el `NodeResult` final, y sale del loop.
4. La task queda en estado terminal `cancelled`, con `nodeResults` completos hasta el punto donde se canceló.

**Reglas duras**:

- Una task `cancelled` no se puede reanudar. Si se quiere seguir, se crea una task nueva.
- El `currentNode` queda apuntando al nodo que estaba ejecutándose cuando se canceló (para audit: "se canceló aquí").
- Implementación: 10 líneas en el loop del motor, pero ahorra sustos cuando un workflow LLM se cuelga.

---

## 7. Edge cases y manejo de errores

| Escenario | Comportamiento |
|---|---|
| **Nodo falla permanentemente** (retries agotados) | Se ejecuta `onError`: `fail` (task → `failed`), `continue` (nodo `skipped`, sigue), o `goto:NODE_ID` (salta al nodo). El error queda logueado en el `NodeResult`. |
| **Nodo retriable falla sin `idempotencyKey` ni `retriable: true`** | Falla con `NON_IDEMPOTENT_RETRY_DISALLOWED` (decisión de seguridad, ver §6.1). El motor NO retry silenciosamente. |
| **Edge no tiene destino válido** (router no matchea y no hay `default`) | La task falla con `code: "ROUTER_NO_MATCH"`. Loguea el valor que se intentó rutear. |
| **Workflow referencia un nodo que no existe** (en edges o entryNode) | Validación al cargar el workflow: falla con error claro, no se persiste. |
| **Ciclo en el grafo** (A → B → A) | Validación al cargar: rechaza con `code: "WORKFLOW_HAS_CYCLE"`. Los workflows son DAGs. |
| **State no valida contra `stateSchema`** (después de un output de nodo) | El nodo se marca `failed` con `code: "SCHEMA_VIOLATION"`. La task falla. |
| **LLM output no valida contra `outputSchema`** | El nodo se reintenta (si la idempotencia es segura). Si tras retries falla, se aplica `onError`. |
| **`outputSchema` no contiene `confidence` pero `confidenceGating` está declarado** | Falla al cargar el workflow con `INVALID_WORKFLOW_DEFINITION` (ver §6.4). |
| **HITL timeout** | Se ejecuta `onTimeout`: `fail` (task → `failed`), `approve` (output = `{approved: true}`, sigue), `reject` (output = `{approved: false, feedback: "timeout"}`, sigue). |
| **HITL declinación por conflicto de interés** | Si `allowDecline: true`, el approver puede declinar con razón. La task falla con `HITL_DECLINED`, `NodeResult.declinedReason` persiste. |
| **HITL aprobación parcial con `approvalMode: 'all'`** | Si uno declina o no responde antes del timeout, la task falla (con `HITL_DECLINED` o `HITL_TIMEOUT`). |
| **Task se queda `running` por más de X tiempo** (engine crashea) | En el startup del engine, un sweeper detecta tasks `running` con `updatedAt` muy viejo y las marca como `failed` con `code: "INTERNAL_ERROR"`. Opcionalmente, las pone en `paused_error` para revisión humana. |
| **Re-ejecución concurrente de la misma task** | No permitida. La task tiene un lock implícito por `taskId`. Si llega otra ejecución para la misma task, se rechaza con `code: "TASK_ALREADY_RUNNING"`. |
| **Cancelación externa de una task en ejecución** | API `POST /tasks/:id/cancel`. Marca `status: 'cancelled'`. El motor chequea antes de cada nodo y sale del loop. El nodo en curso termina, se persiste su `NodeResult`, y la task queda en estado terminal. |
| **Workflow modificado mientras hay tasks en ejecución** | Las tasks en ejecución siguen con el snapshot del workflow que tenían al arrancar. Las nuevas tasks usan la versión actual. Esto se garantiza guardando `workflowVersion` en la task. |
| **Input inicial no cumple con `stateSchema` (en parte)** | El motor rellena con defaults o falla con `code: "SCHEMA_VIOLATION"`. Recomendación: fallar, no rellenar silenciosamente. |
| **`Task.metadata` crece sin control** | Política documentada en `TaskMetadata` (ver §3): no abusar. Si crece, repensar la arquitectura. El motor NO valida el contenido de metadata, pero se puede monitorear tamaño por task. |

---

## 8. Decisiones de diseño abiertas (necesitan tu OK)

Estas decisiones se tomaron tentativamente para llegar a un spec funcional. **Si alguna te parece mal, decime y la cambiamos antes de codear.**

### 8.1. Formato del archivo: JSON, YAML, o ambos

**Recomendación**: **ambos**. JSON para validación estricta y tooling, YAML para legibilidad y edición a mano. El engine internamente trabaja con un modelo único, y se ofrece un parser para cada formato.

- **Pro**: flexibilidad. Los workflows predefinidos del sistema vienen en JSON (versionados en código). Los workflows editables por la firma en D6 vienen en YAML.
- **Contra**: dos parsers que mantener. Pero son libs estándar (`js-yaml` para YAML, nativo para JSON).
- **Default si no se especifica extensión**: JSON.
- **Arquitectura**: parser aparte, no asumir JSON en el core. Si en D2a solo soportás JSON, está bien, pero dejá la arquitectura abierta.

**¿OK o preferís solo JSON?**

### 8.2. ¿Dónde viven los skills?

**Recomendación revisada (v0.2)**: **en código en D2a, en DB en D6**.

- En D2a: los skills son assets de código. Se referencian por nombre desde el workflow, y se cargan desde archivos `.ts` o `.md` en el repo. Versionables en git.
- En D6: cuando llegue el editor visual de workflows, los skills pueden ser custom subidos por la firma, persistidos en DB. Es ahí donde el modelo "skill en DB" tiene sentido.

**Por qué el cambio desde la recomendación original**: en la v0.1 recomendaba DB desde el inicio. El otro M3 señaló correctamente que versionar assets de código en dos lados (git + DB) es pesadilla. La solución es: skills son código hasta que la firma los pueda editar (D6), y a partir de ahí son DB.

**¿OK con este plan (código en D2a, DB en D6)?**

### 8.3. ¿Cómo referencia el intake router a los workflows disponibles?

**Recomendación**: el intake router es un componente **separado** del motor de workflows. El catálogo de workflows es una tabla en DB que el motor puebla al cargar workflows (en startup o hot-reload), y el router/agente lo lee.

- **Pro**: limpia separación. El motor no se "auto-registra" en el catálogo; el catálogo es solo data que el motor lee/escribe.
- **Contra**: hay dos cosas que "saben" de workflows: el catálogo y el motor. Hay que mantenerlos sincronizados.
- **Para multi-región en D3+**: el catálogo se vuelve el cuello. Habría que sharding. Por ahora: tabla simple, refresh on workflow deploy.

**¿OK?**

### 8.4. ¿Cómo se resuelven las tiers de modelo a modelos específicos?

**Recomendación**: archivo de config del motor. Por ejemplo:

```json
{
  "models": {
    "liviano": { "provider": "deepseek", "name": "deepseek-chat", "maxTokens": 8000 },
    "robusto": { "provider": "minimax", "name": "MiniMax-M3", "maxTokens": 32000 }
  }
}
```

- Un nodo dice `model: "liviano"`. El motor busca en config y resuelve al modelo concreto.
- Permitir override por nodo: `model: "minimax/MiniMax-M3"` para casos especiales.
- El config del motor tiene un default razonable, y un workflow puede override por nodo.

**¿OK?**

### 8.5. ¿Persistencia: SQLite o Postgres? ¿Cuándo migrar?

**Recomendación revisada (v0.2)**: **SQLite en D2a, migrar a Postgres en D3, integrar pgvector en D4**.

- **D2a (SQLite)**: cero cambios a infra. Worgena ya usa SQLite (`worgena.db`). El motor de workflows usa las mismas tablas nuevas. SQLite con WAL mode aguanta single-process.
- **D3 (Postgres)**: coincide con multi-tenancy. Postgres tiene RLS (Row Level Security) nativo, que es la forma correcta de aislar datos por tenant. SQLite no tiene equivalente.
- **D4 (pgvector)**: cuando llega la memoria episodic con embeddings reales, pgvector entra natural. Para ese momento ya estamos en Postgres.

**Por qué el cambio desde la recomendación original**: en v0.1 sugería Postgres en D4. El otro M3 señaló correctamente que multi-tenancy (D3) es el momento natural para Postgres por RLS, no RAG. Adelantamos la migración a D3.

**¿OK con esta timeline (SQLite D2a → Postgres D3 → pgvector D4)?**

### 8.6. ¿Cómo manejamos la concurrencia de múltiples tasks?

**Recomendación revisada (v0.2)**: **1 worker in-process en v1, pero con queue interface**.

El motor expone una interfaz tipo:

```typescript
interface WorkflowEngine {
  enqueue(taskInput: TaskInput): Promise<string>;  // retorna taskId
  getStatus(taskId: string): Promise<TaskStatus>;
  cancel(taskId: string): Promise<void>;
  // ...
}
```

Detrás es 1 worker in-process. Cuando se pase a N workers (D3+), es swap de la implementación, no refactor del motor. Esto es 1 hora de código extra y te salva semanas en D3.

- **Pro**: simple, determinista, fácil de debuggear. Y escalable sin reescribir.
- **Contra**: una sola task corre a la vez en v1. Para 100 tasks simultáneas, hay cola.

**¿OK?**

### 8.7. ¿Persiste el `nodeResults` completo o solo el output?

**Recomendación**: **`NodeResult` completo** (output + metadata). El storage es lo más barato, el valor de tener todos los datos para audit/replay/debug es enorme. Se estima ~5-50KB por nodo; con 1M de ejecuciones = 50-500GB. Aceptable.

- **Pro**: time-travel completo, debugging, audit, re-uso para eval. Sin esto perdemos el 80% del valor de tener un motor.
- **Contra**: storage. Pero es la decisión correcta.
- **Optimización para outputs grandes**: si el output es enorme (>1MB), guardar referencia a storage externo (S3, R2) + metadata. El `output` en el NodeResult queda como `{ $ref: "s3://...", size: 1234567 }`.

**¿OK?**

### 8.8. ¿Naming de la librería / módulo en código?

**Recomendación revisada (v0.2)**: `src/agent/workflow-engine/` con jerarquía de sub-módulos (NO plano):

```
src/agent/workflow-engine/
  ├── dsl/
  │   ├── types.ts                # tipos del DSL
  │   ├── schema.ts               # JSON Schema del top-level + validador
  │   └── parser.ts               # JSON / YAML → WorkflowDefinition
  ├── executor/
  │   ├── engine.ts               # el motor: ejecuta tasks
  │   └── loop.ts                 # el loop principal (cargar contexto, ejecutar nodo, persistir, etc.)
  ├── primitives/
  │   ├── idempotency.ts
  │   ├── retries.ts
  │   ├── hitl.ts
  │   ├── confidence-gating.ts
  │   ├── replay.ts
  │   ├── cancel.ts
  │   └── error-classifier.ts     # mapea errores del SDK a ErrorCode
  ├── nodes/
  │   ├── function.ts
  │   ├── llm.ts
  │   ├── hitl.ts
  │   └── router.ts
  ├── persistence/
  │   ├── tasks.ts                # CRUD de tasks
  │   ├── node-results.ts         # CRUD de nodeResults
  │   └── workflows.ts            # CRUD de WorkflowDefinitions
  └── migrators/
      └── (vacío por ahora, se llena cuando cambie schemaVersion)
```

**Por qué el cambio desde la recomendación original**: el otro M3 señaló correctamente que si todo va en una carpeta plana, en D3-D4 se vuelve inmantenible. La jerarquía dsl/executor/primitives/nodes/persistence separa concerns.

**¿OK o lo llamás diferente?**

---

## 9. Out of scope explícito (v1)

Para que quede claro qué NO se hace en D2a:

- **Multi-tenancy** (D3): el motor no conoce tenants. La task tiene `tenantId` para auditoría, pero el motor no valida aislamiento. Eso es responsabilidad de la capa de arriba.
- **Editor visual de workflows** (D6): los workflows se editan como JSON/YAML.
- **Workflows dinámicos generados por LLM** (futuro): el LLM no puede crear un workflow en runtime.
- **Sub-workflows** (futuro): no hay `subworkflow` node. Si hace falta, se duplica o parametriza.
- **Fanout / Fanin** (D2b): la ejecución de un nodo N veces y la agregación de N resultados. Se difiere explícitamente para evitar scope creep.
- **Compensación / saga patterns** (futuro): si un nodo falla, se reintenta o se falla la task. No hay rollback complejo.
- **Persistencia distribuida** (D2a=D3): single-process. Postgres en D3 sigue single-process; sharding es D4+.
- **Time-travel UI** (D3): el replay se invoca por API, sin UI.
- **Realtime streaming de progreso al cliente** (futuro): el cliente hace polling de `GET /tasks/:id`.
- **Versionado de skills** (D6): los skills se referencian por nombre, no por versión. Si la firma quiere versionar, lo hace en D6.
- **Re-notificación automática en HITL** (futuro): el motor no re-envía notificaciones. Política de recordatorios es de la capa de UI/notification (D3+).

---

## 10. Referencias

- `AGENT_ROADMAP.md` — Decisiones arquitectónicas vigentes (3 capas, multi-modelo, verificador, etc.)
- `PLATFORM_VISION.md` §11 — Visión del workflow engine (este spec es la concreción)
- `AGENT_HARDENING_PLAN.md` — Histórico, items 2/3/4 absorbidos en este motor
- `AGENTS.md` — Reglas duras del proyecto
- `AGENT_DIM_1_SECURITY_PHASES.md` — HITL previo (D1) que este motor integra y extiende

---

## 11. Próximos pasos cuando apruebes este spec

1. **D2a.1** (Schema + tipos): implementar `dsl/types.ts` y `dsl/schema.ts` exactamente como están acá. Validar que el JSON Schema del top-level acepta/rechaza los workflows de prueba.
2. **D2a.1b**: implementar `dsl/parser.ts` (JSON + YAML).
3. **D2a.2** (Executor): implementar el motor (`executor/engine.ts` + `executor/loop.ts`). El `WorkflowDefinition` de prueba (`revision-generica`) debe ejecutarse end-to-end.
4. Tests con el workflow de prueba desde el día 1.

**Si hay cambios al spec**, los discutimos, actualizamos este doc, y después codeamos con la versión actualizada como contrato.

---

## 12. CHANGELOG

### v0.1 → v0.2 (2026-06-09)

Revisión por segunda instancia de M3. 13 issues identificados, todos aplicados.

**🔴 Issues rojos (críticos, bloqueaban D2a):**

1. **`StateTemplate` y `StateMapping` mal modelados.** Unificados en `StateRef` (template o path). Separados en `NodeInput` y `NodeOutput` para claridad. El ejemplo §5 actualizado.
2. **`outputSchema.confidence` no conectado con `confidenceGating`.** Ahora `confidence` es `number` 0-1 (no enum string). Validación al cargar el workflow: si `confidenceGating` está declarado, `outputSchema` debe contener `confidence: { type: "number", minimum: 0, maximum: 1 }`.

**🟡 Issues amarillos (importantes):**

3. **Router `matchMode` no especificado.** Agregado: `'exact'` (default) o `'case-insensitive'`. Para matching flexible, nodo function previo.
4. **FanoutNode/FaninNode en el union pero out-of-scope.** Sacados del union en D2a. Documentado en §1.2 y §9 que se difieren a D2b.
5. **`RetryConfig.on` sin catálogo de códigos.** Agregado `ErrorCode` union type en §3. `errorClassifier.ts` documentado como single point of mapping desde SDK errors a códigos.

**🟠 Lagunas conceptuales (mejoras de completitud):**

6. **NodeResult sin `input` ni `promptSnapshot`.** Agregados. Ahora el NodeResult tiene `input`, `promptSnapshot` (para LLM), `confidenceValue` (número), `declinedReason`, `idempotencyKey` resuelta. Audit real.
7. **HITL: agregados `approvalMode` ('any'/'all'/'majority'), `outputSchema` opcional, `allowDecline`, `declineReasons`.** Conflict of interest declination soportada nativamente (relevante para legal colombiano).
8. **Regla de idempotencia mal redactada.** Cambiada: ahora si el nodo no declara `idempotencyKey` ni `retriable: true`, falla con `NON_IDEMPOTENT_RETRY_DISALLOWED`. Es decisión de seguridad, no limitación. También agregado `retriable: boolean` para funciones puras.
9. **SQLite→Postgres timing.** Adelantado a D3 (coincide con multi-tenancy y RLS nativo), no D4.

**🟢 Extras (mejoras nice-to-have):**

10. **Cancelación externa no contemplada.** Agregada §6.7 + `POST /tasks/:id/cancel` API. Status check antes de cada nodo.
11. **`Task.metadata` sin política.** Documentada política de uso (no abusar, datos transitorios de runtime).
12. **Schema version rejection poco claro.** Error code explícito `SCHEMA_VERSION_UNSUPPORTED`.
13. **Decisión de ejecutar nodo en el edge de entrada, no en el nodo.** Documentado en Edge.

**🟠 Decisiones estratégicas revisadas (acordadas con M3):**

- **Skills (8.2):** en código en D2a, en DB en D6. (Original: DB desde inicio.)
- **Persistencia (8.5):** SQLite D2a → Postgres D3 → pgvector D4. (Original: Postgres en D4.)
- **Concurrencia (8.6):** 1 worker in-process con queue interface para escalar sin refactor. (Original: solo 1 worker sin interface.)
- **Naming (8.8):** jerarquía `dsl/executor/primitives/nodes/persistence` en lugar de plano. (Original: plano.)
- **8.3 catálogo de workflows:** desacoplado del motor. Tabla en DB que el motor puebla al cargar, router lee.
- **8.4 tiers de modelo:** ya estaba OK, sin cambios.
- **8.1 formato:** JSON+YAML, sin cambios.
- **8.7 NodeResult completo:** sin cambios.

**🔧 Nuevas primitivas agregadas:**

- `ErrorCode` union type (catálogo único de errores reconocidos).
- `Cancellation` (§6.7).
- `TaskMetadata` type con política documentada.
- `replayOf` / `replayInput` / `replayFromNode` en Task.
- `allowDecline` / `declineReasons` en HITLNode.
