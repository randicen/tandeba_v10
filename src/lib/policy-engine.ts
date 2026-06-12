/**
 * policy-engine.ts
 * -----------------------------------------------------------------------------
 * Carga las policies de `policies.json` y expone helpers para que el LLM
 * (vía system prompt) las consulte como guidance.
 *
 * Diseño:
 *   - Las policies son **soft guidance** (el LLM las lee del system prompt
 *     y decide si seguirlas).
 *   - El **URL allowlist** (`ALLOWED_DOMAINS` en .env) sigue siendo el
 *     backstop hard en runtime.
 *   - Esto permite que el usuario refine las policies sin tocar código.
 *
 * Tests: test_policy_engine.mts
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface TopicPolicy {
  description: string;
  use_these_sites: string[];
  avoid_these_sites: string[];
  rationale: string;
}

export interface PoliciesFile {
  topics: Record<string, TopicPolicy>;
  instructions: {
    how_to_use: string;
    if_no_topic_matches: string;
    enforcement_note: string;
  };
}

let cachedPolicies: PoliciesFile | null = null;

/**
 * Carga el policies.json. Cachea en memoria después de la primera carga.
 */
export function loadPolicies(): PoliciesFile {
  if (cachedPolicies) return cachedPolicies;
  const pathToFile = path.join(__dirname, "policies.json");
  const content = readFileSync(pathToFile, "utf-8");
  cachedPolicies = JSON.parse(content) as PoliciesFile;
  return cachedPolicies;
}

/**
 * Devuelve la policy de un topic, o null si no existe.
 */
export function getTopicPolicy(topic: string): TopicPolicy | null {
  const policies = loadPolicies();
  return policies.topics[topic] || null;
}

/**
 * Lista los nombres de topics disponibles.
 */
export function listTopics(): string[] {
  return Object.keys(loadPolicies().topics);
}

/**
 * Genera un fragmento de system prompt que el LLM puede leer.
 * Lista los topics y resume cada uno. Esto se inyecta en el system prompt
 * del agente.
 */
export function generateSystemPromptSection(): string {
  const policies = loadPolicies();
  const topicNames = Object.keys(policies.topics);

  let section = `\n\nPOLÍTICAS DE ACCESO POR TÓPICO (Topic-based policies):
Cuando hagas búsquedas o visites URLs (read_url, download_file, apify_scrape_url), seguí estas guías:

${policies.instructions.how_to_use}

${policies.instructions.if_no_topic_matches}

${policies.instructions.enforcement_note}

TÓPICOS DISPONIBLES:
`;

  for (const name of topicNames) {
    const t = policies.topics[name];
    section += `\n### ${name}\n`;
    section += `${t.description}\n`;
    section += `Sitios preferidos: ${t.use_these_sites.join(", ")}\n`;
    section += `Evitar: ${t.avoid_these_sites.join(", ")}\n`;
    section += `Razón: ${t.rationale}\n`;
  }

  return section;
}

/**
 * Verifica si un dominio matchea alguno de los patrones de una lista
 * (bare domain o suffix con punto). Misma lógica que network-policy.ts
 * pero expuesta para que el policy engine la use.
 */
export function domainMatchesAny(hostname: string, patterns: string[]): boolean {
  const h = hostname.toLowerCase();
  for (const p of patterns) {
    const pattern = p.toLowerCase();
    if (pattern.startsWith(".")) {
      if (h.endsWith(pattern)) return true;
    } else {
      if (h === pattern || h.endsWith("." + pattern)) return true;
    }
  }
  return false;
}

/**
 * Helper de decisión: dado un URL y un topic, retorna
 * { shouldAvoid, reason }. NO es enforcement (eso lo hace network-policy),
 * es solo information para el LLM.
 */
export function checkUrlAgainstTopic(url: string, topic: string): {
  inRecommended: boolean;
  inAvoided: boolean;
  reason: string;
} {
  const policy = getTopicPolicy(topic);
  if (!policy) {
    return { inRecommended: false, inAvoided: false, reason: `Topic '${topic}' no existe` };
  }

  let hostname = "";
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return { inRecommended: false, inAvoided: false, reason: "URL inválida" };
  }

  const inAvoided = domainMatchesAny(hostname, policy.avoid_these_sites);
  const inRecommended = domainMatchesAny(hostname, policy.use_these_sites);

  if (inAvoided) {
    return {
      inRecommended,
      inAvoided: true,
      reason: `El sitio ${hostname} está en la lista de evitar para el topic '${topic}': ${policy.rationale}`,
    };
  }

  if (inRecommended) {
    return {
      inRecommended: true,
      inAvoided: false,
      reason: `El sitio ${hostname} es recomendado para el topic '${topic}'`,
    };
  }

  return {
    inRecommended: false,
    inAvoided: false,
    reason: `El sitio ${hostname} no está ni recomendado ni evitado para '${topic}'. Decisión del LLM.`,
  };
}

/** Test-only: resetea el cache para forzar recarga. */
export function __resetPoliciesCacheForTesting(): void {
  cachedPolicies = null;
}
