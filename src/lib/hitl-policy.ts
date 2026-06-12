/**
 * hitl-policy.ts
 * -----------------------------------------------------------------------------
 * Human-in-the-loop: tools destructivas que requieren aprobación humana explícita
 * antes de ejecutarse.
 *
 * Cierra 🟠 Gap #7 del diagnóstico: `delete_file`, `batch_review`, y
 * `download_file` desde una URL externa se ejecutaban sin que el humano
 * interviniera. El LLM decidía si preguntar o no.
 *
 * Patrón:
 *   1. LLM quiere llamar `delete_file`
 *   2. `executeTool` detecta que la tool requiere aprobación
 *   3. Si el LLM no pasó `__human_approved: true` en args, devuelve error
 *      con la pregunta pre-formulada para `ask_human`
 *   4. El LLM (guiado por el system prompt) llama `ask_human` con esa pregunta
 *   5. El humano responde vía UI
 *   6. El LLM reintenta la tool con `__human_approved: true`
 *   7. Esta vez pasa el check y la tool se ejecuta
 *
 * El flag `__human_approved` es convención (no enforcement real). El
 * enforcement se refuerza con el system prompt: instruye al LLM a
 * SIEMPRE llamar `ask_human` antes de tools destructivas.
 *
 * Tests: test_hitl_policy.mts
 */

export interface HitlDecision {
  /** True si esta tool call requiere aprobación humana previa. */
  requires: boolean;
  /** Razón legible (para que el LLM entienda por qué se bloqueó). */
  reason: string;
  /** Pregunta pre-formulada que el LLM debe pasar a `ask_human`. */
  question: string;
}

/**
 * Determina si una tool call requiere aprobación humana ANTES de ejecutarse.
 *
 * Reglas (en este orden):
 *   - `delete_file` → siempre (borra datos del usuario)
 *   - `batch_review` → siempre (procesa muchos archivos)
 *   - `download_file` → solo si la URL NO está en el workspace de la firma
 *     (descargar un archivo a tu propio workspace es seguro; descargar a
 *      una URL externa es exfiltración)
 *
 * El resto de las tools (read_file, write_file, list_files, etc.) no
 * requieren aprobación.
 */
export function requiresHumanApproval(toolName: string, args: any): HitlDecision {
  if (toolName === "delete_file") {
    const path = args?.path ?? "(archivo no especificado)";
    return {
      requires: true,
      reason: "delete_file elimina datos del workspace del usuario. Sin undo.",
      question:
        `Voy a eliminar el archivo "${path}" del workspace. Esta acción NO se puede deshacer. ` +
        `¿Confirmás que querés continuar? (sí/no)`,
    };
  }

  if (toolName === "batch_review") {
    const n = Array.isArray(args?.columns) ? args.columns.length : "?";
    return {
      requires: true,
      reason: "batch_review procesa todos los documentos del workspace con un sub-LLM. " +
              "Consume tokens y modifica archivos derivados (dashboard HTML).",
      question:
        `Voy a procesar todos los documentos del workspace con ${n} pregunta(s) de revisión. ` +
        `Esto puede tardar varios minutos y consumir tokens de LLM. ¿Confirmás? (sí/no)`,
    };
  }

  if (toolName === "download_file") {
    const url = String(args?.url ?? "");
    const filename = String(args?.filename ?? "(archivo no especificado)");
    // Si la URL es interna (R2, el propio dominio), no requiere aprobación
    const isInternal = isInternalUrl(url);
    if (!isInternal) {
      return {
        requires: true,
        reason: "download_file desde URL externa puede exfiltrar datos. " +
                "Solo URLs internas (R2 workspace, mismo dominio) son seguras.",
        question:
          `Voy a descargar el archivo desde "${url}" y guardarlo como "${filename}". ` +
          `La URL es externa al workspace. ¿Confirmás que es legítimo? (sí/no)`,
      };
    }
    return { requires: false, reason: "URL interna, sin riesgo de exfiltración.", question: "" };
  }

  return { requires: false, reason: "Tool no destructiva, no requiere aprobación.", question: "" };
}

/**
 * Determina si una URL es "interna" (workspace de la firma, R2 propio, mismo host).
 * Heurística simple: misma host o dominio en R2.
 *
 * Esto NO es un security check (eso es `network-policy.ts`). Esto es solo
 * para distinguir "download a tu propio workspace" (seguro) de
 * "download desde internet" (riesgoso).
 */
function isInternalUrl(url: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    // Mismo host (localhost, 127.0.0.1, dominio del server)
    if (host === "localhost" || host === "127.0.0.1" || host.startsWith("192.168.")) {
      return true;
    }
    // R2 de Cloudflare (account-specific, no se puede saber sin env var)
    // Por ahora, considerar "interno" solo same-host. Si querés agregar tu
    // dominio del server, hacelo acá: || host === "tuserver.com"
    return false;
  } catch {
    return false;
  }
}

/**
 * El "magic flag" que el LLM setea en args después de pedir (y recibir) aprobación.
 *
 * Convención: si `args.__human_approved === true`, el HITL check se omite.
 * Cualquier otro valor (false, undefined, etc.) → HITL check activo.
 */
export const HUMAN_APPROVED_FLAG = "__human_approved";
