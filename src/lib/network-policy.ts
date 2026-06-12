/**
 * network-policy.ts
 * -----------------------------------------------------------------------------
 * Allowlist de dominios para tools que salen a la red.
 *
 * Cierra 🔴 Gap #2 del diagnóstico de seguridad: `read_url`, `download_file`,
 * `apify_scrape_url`, `search_web` y `browser_action` aceptaban cualquier URL.
 * Una web maliciosa con prompt injection podía exfiltrar datos a un endpoint
 * externo.
 *
 * Config:
 *   .env: ALLOWED_DOMAINS=example.com,.gov.co,otro-dominio.com
 *
 * Sintaxis del allowlist:
 *   - Dominio bare ("example.com") matchea example.com y *.example.com
 *   - Sufijo con punto inicial (".gov.co") matchea *.gov.co y **.gov.co
 *   - Lista vacía en dev = permitir todo (con warn)
 *   - Lista vacía en production = tirar error (fail-closed)
 *
 * Uso:
 *   import { assertUrlAllowed } from "./network-policy.js";
 *   try {
 *     assertUrlAllowed(url);
 *   } catch (e) {
 *     return `Error: ${e.message}`;  // propagar al LLM como tool result
 *   }
 *
 * Tests: test_network_policy.mts
 */

// Memo del warn para no spammear en cada tool call.
let warnedMissingAllowlist = false;

export class NetworkPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkPolicyError";
  }
}

/**
 * Verifica que una URL puede ser accedida según el allowlist configurado.
 *
 * Tira `NetworkPolicyError` si:
 *   - La URL es malformada
 *   - El protocolo no es http(s)
 *   - El hostname no matchea ningún patrón del allowlist
 *   - `ALLOWED_DOMAINS` está vacío y `NODE_ENV=production` (fail-closed)
 */
export function assertUrlAllowed(url: string): void {
  if (typeof url !== "string" || url.trim() === "") {
    throw new NetworkPolicyError(`URL inválida (vacía o no-string): ${String(url)}`);
  }

  const allowedEnv = (process.env.ALLOWED_DOMAINS ?? "").trim();

  // Fail-open en dev: si no hay allowlist, permitir todo + warn una vez.
  if (!allowedEnv) {
    if (process.env.NODE_ENV === "production") {
      throw new NetworkPolicyError(
        "ALLOWED_DOMAINS no está configurado en production. " +
        "Por seguridad, no se permite tráfico de red sin allowlist explícito. " +
        "Seteá ALLOWED_DOMAINS=example.com,.tudominio.com en .env"
      );
    }
    if (!warnedMissingAllowlist) {
      console.warn(
        "[NETWORK-POLICY] ALLOWED_DOMAINS no está seteado. " +
        "Permitiendo TODO el tráfico de red (solo dev). " +
        "En production, seteá ALLOWED_DOMAINS=.tudominio.com,otro.com"
      );
      warnedMissingAllowlist = true;
    }
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (e: any) {
    throw new NetworkPolicyError(`URL malformada: ${url}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new NetworkPolicyError(
      `Protocolo no permitido: ${parsed.protocol} en ${url}. Solo http(s).`
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  const patterns = allowedEnv
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);

  for (const pattern of patterns) {
    if (pattern.startsWith(".")) {
      // Sufijo: ".gov.co" matchea x.gov.co, y.x.gov.co, etc.
      if (hostname.endsWith(pattern)) return;
    } else {
      // Bare domain: "example.com" matchea example.com y *.example.com
      // Importante: el "." antes del pattern previene el "suffix attack"
      // (example.com.evil.com NO debe matchear example.com).
      if (hostname === pattern || hostname.endsWith("." + pattern)) return;
    }
  }

  throw new NetworkPolicyError(
    `Dominio no permitido por network policy: ${hostname}. ` +
    `Si este dominio es legítimo, agregalo a ALLOWED_DOMAINS en .env ` +
    `(comma-separated, ej. ALLOWED_DOMAINS=example.com,.gobierno.co).`
  );
}

/**
 * Lista de tool names que potencialmente hacen requests a la red.
 * Se usa en `executeTool()` para aplicar la policy antes de invocar la tool.
 */
export const NETWORK_TOOLS: ReadonlySet<string> = new Set([
  "read_url",
  "download_file",
  "apify_scrape_url",
  "search_web",
  "browser_action",
]);

/**
 * Extrae la URL a validar del `args` de una tool de red.
 * Retorna `null` si la tool no tiene URL en este momento
 * (ej. `browser_action` con action="screenshot" no sale a la red).
 */
export function extractUrlFromToolArgs(toolName: string, args: any): string | null {
  if (!args || typeof args !== "object") return null;
  switch (toolName) {
    case "read_url":
    case "download_file":
    case "apify_scrape_url":
      return typeof args.url === "string" ? args.url : null;
    case "search_web":
      // search_web va a DuckDuckGo via Puppeteer. No validamos el query
      // (es un parámetro de búsqueda, no una URL externa), pero la página
      // de resultados es interna. No se necesita check aquí.
      return null;
    case "browser_action":
      // browser_action solo sale a la red cuando action === "goto" con url.
      if (args.action === "goto" && typeof args.url === "string") {
        return args.url;
      }
      return null;
    default:
      return null;
  }
}
