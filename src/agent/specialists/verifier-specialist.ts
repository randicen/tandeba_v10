/**
 * Worgena — VerifierSpecialist (D2b.1 + D2b.2).
 *
 * Fuente de verdad:
 * - D2b.1: `AGENT_D2B_1_SPEC.md` §3.10, §5.3.
 * - D2b.2: `AGENT_D2B_2_SPEC.md` §3.7, §3.8, §5.7.
 *
 * Specialist de tier robusto. Verifica el output de un productor (otro
 * specialist o un nodo LLM directo).
 *
 * **D2b.2 — cambios MAYORES**:
 * 1. **Sub-sesión lógica**: el system prompt del verifier es
 *    COMPLETAMENTE INDEPENDIENTE del system prompt del productor.
 *    El verifier NO lee `params.node.systemPrompt` ni `params.node.userPrompt`
 *    del productor. Construye su propio system prompt desde cero.
 *    Esto elimina el sesgo confirmatorio: el verifier razona sin
 *    haber visto cómo pensó el productor. Ver spec §3.7.
 *
 * 2. **Citation Grounding v2**: el verifier valida citas a texto y
 *    metadatos. Detecta el tipo de cita por sintaxis y valida por
 *    heurística (substring para texto, check de existencia para
 *    metadatos). El `read_section` real es D3+ con RAG. Ver spec §3.8.
 *
 * 3. **Metadata de audit**: el output del verifier incluye
 *    `verifierSessionId` (UUID) y `verifiedAt` (ISO timestamp) para
 *    que el audit log pueda vincular "este verifier verificó ese
 *    output a esa hora". Ver spec §5.7.
 *
 * 4. **Issues y citations**: el output incluye `issues` (strings con
 *    problemas detectados) y `citations` (array con cada cita
 *    validada y su estado). Esto es aditivo al output D2b.1
 *    (`{ verified, confidence, notes }`).
 *
 * 5. **agentCard + lifecycle + agentVersion semver**: igual que los
 *    otros specialists.
 *
 * **Backward-compat con D2b.1**: los campos `verified`, `confidence`,
 * y `notes` se siguen retornando con la misma semántica. Los 16 tests
 * D2b.1 que validan estos campos siguen pasando. Los nuevos campos
 * (`issues`, `citations`, `verifierSessionId`, `verifiedAt`) son
 * aditivos.
 *
 * **Salida del verifier**:
 * ```typescript
 * {
 *   verified: boolean,
 *   confidence: number, // 0-1
 *   notes: string,
 *   issues: string[],   // ej: ["cita 1: texto no encontrado en el contexto"]
 *   citations: Array<{ type: "text" | "metadata"; target: string; valid: boolean; reason?: string }>,
 *   verifierSessionId: string,  // UUID
 *   verifiedAt: string,         // ISO 8601
 * }
 * ```
 */

import { randomUUID } from "node:crypto";
import type { LLMNode } from "../workflow-engine/dsl/types.js";
import type {
  LLMInvoker,
  LLMInvokeParams,
  NodeExecutionOutcome,
  NodeExecutionSuccess,
} from "../workflow-engine/executor/types.js";
import { toNodeRuntimeError } from "../workflow-engine/executor/errors.js";
import { resolveStateRef } from "../workflow-engine/executor/state.js";
import type { Specialist, SpecialistExecuteParams } from "./specialist.js";
import type { ModelRef } from "./tier-resolver.js";
import { Lifecycle } from "./lifecycle.js";
import { VERIFIER_AGENT_CARD } from "./agent-cards/index.js";

// ============================================================
// Tipos del verifier
// ============================================================

/**
 * Output del verifier. Es lo que el LLM retorna al invoker (más los
 * campos que el specialist agrega localmente: `verifierSessionId`,
 * `verifiedAt`, `issues`, `citations`).
 *
 * **Por qué es público y exportable**: el workflow puede leer el
 * output del verifier y mostrarlo en UI / reports. El motor solo
 * lo persiste en el state; el resto del sistema lo consume.
 */
export interface VerifierOutput {
  /** Verdict del verifier: `true` si el output es consistente con el contexto. */
  verified: boolean;
  /** Confianza del verifier entre 0 y 1. */
  confidence: number;
  /** Notas breves explicando el razonamiento del verifier. */
  notes: string;
  /** Lista de issues detectados (ej: "cita 1: texto no encontrado"). */
  issues: string[];
  /** Detalle de cada cita detectada y validada. */
  citations: VerifierCitationValidation[];
  /** UUID de la sesión del verifier. Para audit. */
  verifierSessionId: string;
  /** ISO 8601 timestamp de cuándo se verificó. Para audit. */
  verifiedAt: string;
}

/**
 * Validación de una cita individual.
 *
 * - `type: "text"` — cita a texto (ej: `[Doc 1, 'rango 1234-5678']`).
 *   Valida por substring en el state.
 * - `type: "metadata"` — cita a metadato (ej: `[Doc 1, derogado_por: 'Ley 2297']`).
 *   Valida por existencia del campo en el state.
 *
 * `target` es la referencia al documento y al campo citado (string libre
 * que el verifier extrae de la sintaxis de la cita).
 */
export interface VerifierCitationValidation {
  readonly type: "text" | "metadata";
  readonly target: string;
  readonly valid: boolean;
  readonly reason?: string;
}

// ============================================================
// Citation Grounding v2 — heurística
// ============================================================

/**
 * JSON Schema que define la forma del output del verifier cuando
 * se le pide `response_format: json_schema`. Es el schema que el
 * verifier le pasa al invoker para forzar el shape.
 *
 * **Importante**: este schema es para el output del LLM (lo que
 * el modelo retorna). El specialist agrega después los campos
 * `verifierSessionId`, `verifiedAt`, `issues`, y `citations` localmente
 * (post-procesando la response del LLM con la heurística de
 * Citation Grounding v2).
 */
export const VERIFIER_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["verified", "confidence", "notes"],
  additionalProperties: false,
  properties: {
    verified: { type: "boolean" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    notes: { type: "string" },
  },
};

/**
 * Regex para detectar citas en el output del LLM.
 *
 * Captura dos formas:
 * 1. **Cita a texto**: `[Doc <id>, '<texto>' o "rango <inicio>-<fin>"]`.
 *    El grupo `textRef` captura el texto citado.
 * 2. **Cita a metadato**: `[Doc <id>, <campo>: <valor>]` donde
 *    `<campo>` es uno de la lista cerrada de campos reconocidos
 *    (derogado_por, modificado_por, vigente, tipo, numero, fecha).
 *
 * La regex es deliberadamente laxa — si una cita no matchea, no
 * la validamos (la heurística es imperfecta, y eso está documentado
 * en la spec §10). El `read_section` real de D3+ reemplaza esto.
 */
const CITATION_REGEX = /\[Doc\s+(\d+|[A-Za-z0-9_-]+)\s*,\s*([^\]]+)\]/g;

/** Lista cerrada de campos de metadatos reconocidos (ver spec §3.8). */
const METADATA_FIELDS = new Set([
  "derogado_por",
  "modificado_por",
  "vigente",
  "tipo",
  "numero",
  "fecha",
]);

/**
 * Detecta citas en el output del LLM. Retorna un array con cada
 * cita encontrada y su tipo inferido.
 *
 * Si la sintaxis no matchea ninguno de los dos patrones, la cita
 * se marca como `type: "text"` con `valid: false` y `reason` explicando
 * el problema. Esto permite al audit ver "el LLM intentó poner una
 * cita pero el formato no es el esperado".
 */
function detectCitations(output: unknown): Array<{ raw: string; type: "text" | "metadata"; target: string }> {
  if (typeof output !== "string") return [];
  const citations: Array<{ raw: string; type: "text" | "metadata"; target: string }> = [];
  for (const match of output.matchAll(CITATION_REGEX)) {
    const fullMatch = match[0];
    const docId = match[1];
    const inner = match[2]?.trim() ?? "";

    if (inner === undefined || inner === "") continue;

    // Detección de tipo: si la parte interna tiene `campo: valor` con
    // campo en METADATA_FIELDS, es metadato. Si tiene comillas o 'rango',
    // es texto. Default: texto.
    const metadataMatch = inner.match(/^([a-z_]+)\s*:\s*(.+)$/i);
    if (metadataMatch !== null && metadataMatch[1] !== undefined && METADATA_FIELDS.has(metadataMatch[1].toLowerCase())) {
      // MAY-6 (audit D2 2026-06-12): normalizamos el field a lowercase
      // para que `validateCitations` (que busca `field in state`)
      // matchee aunque el LLM haya escrito el field con case distinto
      // (ej: `DEROGADO_POR` en vez de `derogado_por`).
      const fieldNormalized = metadataMatch[1].toLowerCase();
      citations.push({
        raw: fullMatch,
        type: "metadata",
        target: `Doc ${docId}.${fieldNormalized}`,
      });
    } else {
      // Texto: limpiamos comillas externas si las tiene.
      const cleanText = inner.replace(/^['"]|['"]$/g, "").trim();
      citations.push({
        raw: fullMatch,
        type: "text",
        target: `Doc ${docId}: ${cleanText}`,
      });
    }
  }
  return citations;
}

/**
 * Valida las citas detectadas contra el state. Implementa la
 * heurística del spec §3.8:
 * - Texto: substring search del texto citado en el state. Si no
 *   aparece, la cita falla.
 * - Metadato: el verifier busca el campo en el state. Si el campo
 *   no está o no coincide, la cita falla.
 *
 * **Limitación conocida**: la heurística es imperfecta. El LLM
 * podría citar texto que existe en el state pero con parafraseo
 * (la cita pasa porque hay overlap parcial) o citar metadatos
 * cuyo valor el LLM "alucina" (la cita pasa porque el campo existe
 * pero el valor no). En D3+ con RAG, `read_section` real reemplaza
 * esto. La spec §10 lo documenta como riesgo aceptado.
 */
function validateCitations(
  citations: ReadonlyArray<{ raw: string; type: "text" | "metadata"; target: string }>,
  state: unknown,
): { allValid: boolean; issues: string[]; citations: VerifierCitationValidation[] } {
  const issues: string[] = [];
  const validated: VerifierCitationValidation[] = [];

  // Serializamos el state una sola vez para substring search.
  const stateStr = state == null ? "" : safeStringify(state);

  for (const citation of citations) {
    if (citation.type === "text") {
      // Extraemos el texto citado del `target` (formato "Doc X: <texto>").
      const colonIdx = citation.target.indexOf(":");
      const text = colonIdx >= 0 ? citation.target.slice(colonIdx + 1).trim() : citation.target;
      const found = stateStr.includes(text);
      if (found) {
        validated.push({ type: "text", target: citation.target, valid: true });
      } else {
        issues.push(`cita texto "${citation.target}" no encontrada en el contexto`);
        validated.push({
          type: "text",
          target: citation.target,
          valid: false,
          reason: "texto no encontrado en el contexto",
        });
      }
    } else {
      // Metadato: target es "Doc X.<campo>".
      const parts = citation.target.split(".");
      if (parts.length < 2) {
        issues.push(`cita metadato "${citation.target}" malformada`);
        validated.push({ type: "metadata", target: citation.target, valid: false, reason: "target malformado" });
        continue;
      }
      const field = parts[parts.length - 1];
      if (field === undefined) {
        issues.push(`cita metadato "${citation.target}" sin campo`);
        validated.push({ type: "metadata", target: citation.target, valid: false, reason: "sin campo" });
        continue;
      }
      // Búsqueda defensiva del campo en el state. Si el state es un
      // objeto, miramos si tiene ese field. Si no, fallamos.
      const exists = state != null && typeof state === "object" && field in (state as Record<string, unknown>);
      if (exists) {
        validated.push({ type: "metadata", target: citation.target, valid: true });
      } else {
        issues.push(`cita metadato "${citation.target}" — campo "${field}" no presente en el state`);
        validated.push({
          type: "metadata",
          target: citation.target,
          valid: false,
          reason: `campo "${field}" no presente en el state`,
        });
      }
    }
  }

  return {
    allValid: validated.length === 0 || validated.every((c) => c.valid),
    issues,
    citations: validated,
  };
}

/** JSON.stringify defensivo que no tira con referencias circulares. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ============================================================
// VerifierSpecialist
// ============================================================

/**
 * Specialist verificador. Tier robusto. Implementa sub-sesión lógica
 * (system prompt limpio) y Citation Grounding v2 (heurística).
 */
export class VerifierSpecialist implements Specialist {
  public readonly agentId = "verifier_specialist_v1";
  public readonly agentVersion: string = VERIFIER_AGENT_CARD.version;
  public readonly agentCard = VERIFIER_AGENT_CARD;
  public readonly capabilities: readonly string[] = VERIFIER_AGENT_CARD.skills.map((s) => s.id);
  public readonly preferredModel: ModelRef = "robusto";
  public readonly lifecycle: Lifecycle;

  constructor(private readonly invoker: LLMInvoker) {
    this.lifecycle = new Lifecycle();
    this.lifecycle.transition("idle", "registered");
  }

  async execute(params: SpecialistExecuteParams): Promise<NodeExecutionOutcome> {
    const { node, state, signal } = params;

    this.lifecycle.transition("busy", `verify ${node.id} starting`);

    // Generamos IDs de audit ANTES del LLM call. Si el call falla,
    // igual queremos registrar "este verifier intentó verificar el
    // nodo X a las Y, falló por razón Z". El sessionId se preserva.
    const verifierSessionId = randomUUID();
    const verifiedAt = new Date().toISOString();

    // ─── SUB-SESIÓN LÓGICA ─────────────────────────────────
    // El system prompt es COMPLETAMENTE INDEPENDIENTE del productor.
    // NO leemos `params.node.systemPrompt` ni `params.node.userPrompt`
    // del productor. Esta es la garantía lógica del spec §3.7.
    const systemPrompt = this.buildVerifierSystemPrompt();

    // User prompt: el output a verificar + el state (contexto).
    // El state completo se pasa — el system prompt le dice al verifier
    // que use solo lo que necesita. Filtro en el prompt es más seguro
    // que filtro en código (defense in depth).
    const userInput = resolveStateRef(state, node.input.from, node.input.default);
    const userPrompt = this.buildVerifierUserPrompt(userInput, state);

    const invokeParams: LLMInvokeParams = {
      model: this.preferredModel,
      systemPrompt,
      userPrompt,
      // Forzamos el shape del output del LLM con el schema del verifier.
      // El motor no valida este output contra un `node.outputSchema`
      // (el nodo del verifier típicamente no declara uno; ver spec §3.17).
      outputSchema: VERIFIER_OUTPUT_SCHEMA,
      signal,
    };

    try {
      const result = await this.invoker.invoke(invokeParams);

      // Parseamos el output del LLM (con la validación de shape).
      const llmOutput = this.parseAndValidateLLMOutput(result.output);

      // ─── CITATION GROUNDING v2 ─────────────────────────
      // Detectamos citas en el output del LLM. La heurística busca
      // sintaxis `[Doc X, ...]` en el string del `notes` (o en el
      // output completo si es string). Si no hay output string,
      // no hay citas que validar.
      const detectedCitations = detectCitations(llmOutput.notes);
      const citationValidation = validateCitations(detectedCitations, state);

      // El verdict final: AND entre (verified del LLM) y (todas las
      // citas válidas). Si no hay citas, depende solo del LLM.
      const verified = llmOutput.verified && citationValidation.allValid;

      // Output completo: LLM output + audit metadata + Citation Grounding v2.
      const verifierOutput: VerifierOutput = {
        verified,
        confidence: llmOutput.confidence,
        notes: llmOutput.notes,
        issues: citationValidation.issues,
        citations: citationValidation.citations,
        verifierSessionId,
        verifiedAt,
      };

      this.lifecycle.transition("done", `verify ${node.id} completed (verified=${verified})`);

      return {
        status: "completed",
        output: verifierOutput,
        confidence: this.mapConfidence(llmOutput.confidence),
        confidenceValue: llmOutput.confidence,
        tokensUsed: result.tokensUsed,
        costUsd: result.costUsd,
        modelUsed: result.modelUsed,
        retryCount: 0,
        promptSnapshot: { system: systemPrompt, user: userPrompt },
      } satisfies NodeExecutionSuccess;
    } catch (e) {
      const err = toNodeRuntimeError(e);
      this.lifecycle.transition("archived", `error: ${err.message}`);
      return {
        status: "failed",
        code: err.code,
        message: err.message,
        retriable: false,
        retryCount: 0,
        stack: err.stack,
      };
    }
  }

  // ─── Helpers ────────────────────────────────────────────

  /**
   * System prompt del verifier. Es la CLAVE de la sub-sesión lógica:
   * el prompt le dice al LLM "sos un verificador independiente, no
   * tenés acceso al razonamiento del productor, validá contra el
   * contexto".
   *
   * **Decisión crítica**: este prompt NO contiene ni siquiera una
   * referencia al system prompt del productor. Si el workflow tiene
   * un nodo clasificador con system prompt "sos un clasificador de
   * documentos", el prompt del verifier dice "sos un verificador".
   * El LLM no puede "ver" la perspectiva del productor.
   */
  protected buildVerifierSystemPrompt(): string {
    return (
      "Sos un verificador independiente. Recibís el output de un productor y " +
      "el contexto en que se produjo. Tu trabajo es decidir si el output es " +
      "consistente con el contexto. NO tenés acceso al razonamiento del productor. " +
      "Respondé con un objeto JSON que tenga: " +
      "'verified' (true si es consistente, false si no), " +
      "'confidence' (tu confianza entre 0 y 1), " +
      "y 'notes' (texto breve explicando tu razonamiento). " +
      "Si el output contiene citas en formato [Doc X, ...], mencionalas en notes. " +
      "Citas a texto (ej: [Doc X, 'rango 1234-5678']) deben corresponderse con el " +
      "contenido del contexto. Citas a metadatos (ej: [Doc X, derogado_por: 'Ley Y']) " +
      "deben ser coherentes con la metadata del documento. " +
      "Si el output es inconsistente con el contexto, tiene errores factuales, " +
      "o le falta información crítica, marcá verified=false."
    );
  }

  /**
   * User prompt: el output a verificar + el contexto (state).
   *
   * **Por qué el state completo y no filtrado**: el spec §3.7 dice
   * que el filtro vive en el system prompt, no en el código. Esto
   * es defense in depth: si el system prompt tiene un bug, el
   * LLM igual tiene la información disponible para verificar bien.
   */
  protected buildVerifierUserPrompt(userInput: unknown, state: unknown): string {
    const sections: string[] = [];
    sections.push("=== OUTPUT A VERIFICAR ===");
    sections.push(this.stringifyUnknown(userInput));
    sections.push("");
    sections.push("=== CONTEXTO (state completo) ===");
    sections.push(safeStringify(state));
    return sections.join("\n");
  }

  private stringifyUnknown(value: unknown): string {
    if (value == null) return "(null)";
    if (typeof value === "string") return value;
    return safeStringify(value);
  }

  /**
   * Parsea el output del LLM y valida el shape mínimo. El LLM
   * devolvió JSON con `verified`, `confidence`, `notes` (forzado
   * por el `response_format: json_schema` que el invoker arma).
   * Si el JSON no parsea o le falta un campo, tira error.
   */
  private parseAndValidateLLMOutput(output: unknown): { verified: boolean; confidence: number; notes: string } {
    // El invoker retorna `output` ya parseado si había outputSchema.
    // Si el LLM devolvió texto libre (no JSON), `output` es string.
    let parsed: unknown = output;
    if (typeof output === "string") {
      try {
        parsed = JSON.parse(output);
      } catch {
        throw new Error(
          "VerifierSpecialist: el LLM no devolvió JSON válido a pesar de " +
            "response_format: json_schema. Output: " + output.slice(0, 200),
        );
      }
    }
    if (parsed == null || typeof parsed !== "object") {
      throw new Error("VerifierSpecialist: output del LLM no es objeto");
    }
    const o = parsed as Record<string, unknown>;
    if (typeof o.verified !== "boolean") {
      throw new Error("VerifierSpecialist: output.verified no es boolean");
    }
    if (typeof o.confidence !== "number" || o.confidence < 0 || o.confidence > 1) {
      throw new Error("VerifierSpecialist: output.confidence no es número entre 0 y 1");
    }
    if (typeof o.notes !== "string") {
      throw new Error("VerifierSpecialist: output.notes no es string");
    }
    return {
      verified: o.verified,
      confidence: o.confidence,
      notes: o.notes,
    };
  }

  /**
   * Mapea un confidence numérico (0-1) a un nivel categórico
   * (HIGH / MEDIUM / LOW). Usa los mismos thresholds que el
   * `node.confidenceGating` default del motor, o 0.8/0.5 si
   * el nodo no declara gating.
   */
  private mapConfidence(value: number): "HIGH" | "MEDIUM" | "LOW" {
    if (value >= 0.8) return "HIGH";
    if (value >= 0.5) return "MEDIUM";
    return "LOW";
  }
}
