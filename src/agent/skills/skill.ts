import { parse as parseYaml } from "yaml";

/**
 * Skill — tipo público del módulo de skills v1.
 *
 * Una skill es un paquete versionado de instrucciones en markdown
 * + assets opcionales. Se carga como string en el system prompt del
 * specialist. NO tiene LLM propio. Se carga pre-loop.
 *
 * Referencia: AGENT_D2C_SKILLS_V1_SPEC.md §4.3 (front matter obligatorio).
 */
export type Skill = {
  /** Identificador único. kebab-case. */
  readonly name: string;
  /** Versión semántica. */
  readonly version: string;
  /** Descripción de una línea. */
  readonly description: string;
  /** Dominio (legal, tributario, contabilidad, etc.). */
  readonly domain: string;
  /** Topics del workflow con los que matchea. */
  readonly topics: readonly string[];
  /** Palabras clave para matchear contexto. */
  readonly triggerKeywords: readonly string[];
  /** País/región (CO, US-CA, etc.). Opcional. */
  readonly jurisdiction?: string;
  /** Quién la escribió. */
  readonly author: string;
  /** Cuándo se creó (ISO date). */
  readonly created: string;
  /** Markdown body (después del front matter). */
  readonly body: string;
  /** Assets adicionales (path → contenido). */
  readonly assets: ReadonlyMap<string, string>;
};

/**
 * Contexto para discovery de skills.
 * El matching es determinista: (topic exacto) + (jurisdicción) + (keywords).
 */
export type SkillDiscoveryContext = {
  readonly topic?: string;
  readonly jurisdiction?: string;
  /** Mensaje del usuario. Se usa para keyword matching (case-insensitive). */
  readonly userMessage?: string;
};

/**
 * Resultado de un discovery: skill + razón del match (para auditoría).
 */
export type SkillMatch = {
  readonly skill: Skill;
  readonly score: number;
  readonly matchedOn: {
    readonly topic: boolean;
    readonly jurisdiction: boolean;
    readonly keywordMatches: readonly string[];
  };
};

/**
 * Parsea un SKILL.md (formato YAML front matter + markdown body).
 *
 * Estructura esperada:
 * ```
 * ---
 * name: foo
 * version: 1.0.0
 * ...
 * ---
 *
 * # Body en markdown
 * ...
 * ```
 *
 * Tira error si el front matter falta, está malformado, o no tiene los
 * campos obligatorios. Forward-compat: campos opcionales se omiten sin error.
 *
 * @param content  Contenido completo del archivo SKILL.md
 * @param assets   Mapa de assets adicionales (path → contenido)
 */
export function parseSkillFile(
  content: string,
  assets: ReadonlyMap<string, string> = new Map(),
): Skill {
  // 1. Detectar delimitador `---` al inicio.
  if (!content.startsWith("---")) {
    throw new Error(
      `parseSkillFile: SKILL.md debe empezar con '---' (front matter YAML). ` +
        `Primeros 50 chars: ${JSON.stringify(content.slice(0, 50))}`,
    );
  }

  // 2. Encontrar el cierre del front matter.
  const rest = content.slice(3);
  const closeIdx = rest.indexOf("\n---");
  if (closeIdx === -1) {
    throw new Error(
      `parseSkillFile: SKILL.md no tiene cierre de front matter ('\\n---').`,
    );
  }

  const frontMatterStr = rest.slice(0, closeIdx).replace(/^\n/, "");
  const body = rest.slice(closeIdx + 4).replace(/^\n/, ""); // saltar "\n---"

  // 3. Parsear YAML.
  let frontMatter: unknown;
  try {
    frontMatter = parseYaml(frontMatterStr);
  } catch (e) {
    throw new Error(
      `parseSkillFile: YAML inválido en front matter: ${(e as Error).message}`,
    );
  }

  if (frontMatter === null || typeof frontMatter !== "object") {
    throw new Error(
      `parseSkillFile: front matter debe ser un objeto YAML, ` +
        `recibido: ${typeof frontMatter}`,
    );
  }

  const fm = frontMatter as Record<string, unknown>;

  // 4. Validar campos obligatorios.
  const requiredString = ["name", "version", "description", "domain", "author", "created"] as const;
  for (const field of requiredString) {
    if (typeof fm[field] !== "string" || (fm[field] as string).length === 0) {
      throw new Error(
        `parseSkillFile: campo obligatorio '${field}' falta o no es string. ` +
          `Recibido: ${JSON.stringify(fm[field])}`,
      );
    }
  }

  // 5. Validar campos array.
  if (!Array.isArray(fm.topics) || fm.topics.length === 0) {
    throw new Error(
      `parseSkillFile: campo 'topics' debe ser array no-vacío. ` +
        `Recibido: ${JSON.stringify(fm.topics)}`,
    );
  }
  for (const t of fm.topics) {
    if (typeof t !== "string") {
      throw new Error(
        `parseSkillFile: 'topics' debe contener solo strings. ` +
          `Recibido elemento: ${JSON.stringify(t)}`,
      );
    }
  }

  if (!Array.isArray(fm.trigger_keywords)) {
    throw new Error(
      `parseSkillFile: campo 'trigger_keywords' debe ser array. ` +
        `Recibido: ${JSON.stringify(fm.trigger_keywords)}`,
    );
  }
  for (const kw of fm.trigger_keywords) {
    if (typeof kw !== "string") {
      throw new Error(
        `parseSkillFile: 'trigger_keywords' debe contener solo strings. ` +
          `Recibido elemento: ${JSON.stringify(kw)}`,
      );
    }
  }

  // 6. jurisdiction opcional.
  const jurisdiction =
    typeof fm.jurisdiction === "string" && fm.jurisdiction.length > 0
      ? fm.jurisdiction
      : undefined;

  // 7. Construir Skill. Aserción de tipos porque ya validamos.
  return {
    name: fm.name as string,
    version: fm.version as string,
    description: fm.description as string,
    domain: fm.domain as string,
    topics: fm.topics as readonly string[],
    triggerKeywords: fm.trigger_keywords as readonly string[],
    jurisdiction,
    author: fm.author as string,
    created: fm.created as string,
    body,
    assets,
  };
}
