import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseSkillFile, type Skill, type SkillDiscoveryContext, type SkillMatch } from "./skill.js";

export type { SkillMatch } from "./skill.js";

/**
 * SkillRegistry — catálogo de skills v1.
 *
 * Carga skills del filesystem (o de un Map in-memory para tests) y
 * hace discovery determinista por topic + jurisdicción + keywords.
 *
 * El motor NO usa esta clase. Solo los specialists (Capa 3) la usan
 * para inyectar skills en su system prompt.
 *
 * Referencia: AGENT_D2C_SKILLS_V1_SPEC.md §5.
 */
export class SkillRegistry {
  private readonly skills: ReadonlyMap<string, Skill>;

  private constructor(skills: ReadonlyMap<string, Skill>) {
    this.skills = skills;
  }

  /**
   * Crea un registry desde un Map pre-construido. Útil para tests
   * y para callers que ya tienen skills en memoria.
   */
  static create(skills: ReadonlyMap<string, Skill>): SkillRegistry {
    return new SkillRegistry(skills);
  }

  /**
   * Carga todas las skills de un directorio. Cada subdirectorio
   * de primer nivel es una skill. Lee el SKILL.md obligatorio y
   * los assets de la subcarpeta `assets/`.
   *
   * Tira error si:
   * - El directorio no existe.
   * - Hay un SKILL.md malformado.
   * - Dos skills tienen el mismo `name`.
   */
  static loadFromDir(dir: string): SkillRegistry {
    if (!existsSync(dir)) {
      throw new Error(`SkillRegistry.loadFromDir: directorio no existe: ${dir}`);
    }
    const stat = statSync(dir);
    if (!stat.isDirectory()) {
      throw new Error(`SkillRegistry.loadFromDir: no es un directorio: ${dir}`);
    }

    const map = new Map<string, Skill>();
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = join(dir, entry.name);
      const skillMdPath = join(skillDir, "SKILL.md");
      if (!existsSync(skillMdPath)) {
        // Subdirectorios sin SKILL.md se ignoran silenciosamente.
        // (Permite tener directorios de recursos sueltos.)
        continue;
      }
      const content = readFileSync(skillMdPath, "utf-8");
      const assets = SkillRegistry.loadAssets(join(skillDir, "assets"));
      const skill = parseSkillFile(content, assets);

      if (map.has(skill.name)) {
        throw new Error(
          `SkillRegistry.loadFromDir: skill con name="${skill.name}" ` +
            `declarada en más de un directorio. Cada skill debe tener un name único.`,
        );
      }
      map.set(skill.name, skill);
    }
    return new SkillRegistry(map);
  }

  /**
   * Carga assets de la subcarpeta `assets/` recursivamente.
   * Path relativo a `assets/` → contenido del archivo.
   */
  private static loadAssets(assetsDir: string): ReadonlyMap<string, string> {
    const result = new Map<string, string>();
    if (!existsSync(assetsDir)) return result;

    const walk = (currentDir: string, prefix: string): void => {
      for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
        const fullPath = join(currentDir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath, prefix + entry.name + "/");
        } else if (entry.isFile()) {
          const relPath = prefix + entry.name;
          result.set(relPath, readFileSync(fullPath, "utf-8"));
        }
      }
    };
    walk(assetsDir, "");
    return result;
  }

  /** Lista nombres de skills, ordenados alfabéticamente. */
  listSkills(): readonly string[] {
    return [...this.skills.keys()].sort();
  }

  /** Obtiene una skill por nombre. */
  get(name: string): Skill | null {
    return this.skills.get(name) ?? null;
  }

  /** Cantidad de skills cargadas. */
  size(): number {
    return this.skills.size;
  }

  /**
   * Descubre skills relevantes para un contexto.
   *
   * Algoritmo de scoring (determinista):
   *  - +10 si el topic de la skill matchea el topic del contexto.
   *  - +5  si la jurisdicción matchea.
   *  - +1  por cada keyword de la skill presente en el userMessage
   *        (case-insensitive, split por whitespace y puntuación).
   *
   * Retorna skills con score > 0, ordenadas por score desc, con
   * tiebreak alfabético ascendente. Si no hay match, retorna [].
   */
  discover(context: SkillDiscoveryContext): readonly SkillMatch[] {
    const tokens = tokenize(context.userMessage ?? "");
    const topicMatch = context.topic;
    const jurisdictionMatch = context.jurisdiction;

    const matches: SkillMatch[] = [];
    for (const skill of this.skills.values()) {
      let score = 0;
      const keywordMatches: string[] = [];

      if (topicMatch !== undefined && skill.topics.includes(topicMatch)) {
        score += 10;
      }
      if (
        jurisdictionMatch !== undefined &&
        skill.jurisdiction !== undefined &&
        skill.jurisdiction === jurisdictionMatch
      ) {
        score += 5;
      }
      for (const kw of skill.triggerKeywords) {
        if (tokens.has(kw.toLowerCase())) {
          score += 1;
          keywordMatches.push(kw);
        }
      }

      if (score > 0) {
        matches.push({
          skill,
          score,
          matchedOn: {
            topic: topicMatch !== undefined && skill.topics.includes(topicMatch),
            jurisdiction:
              jurisdictionMatch !== undefined &&
              skill.jurisdiction === jurisdictionMatch,
            keywordMatches,
          },
        });
      }
    }

    // Ordenar: score desc, luego nombre asc (tiebreak).
    matches.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.skill.name.localeCompare(b.skill.name);
    });

    return matches;
  }
}

/**
 * Tokeniza un texto en keywords minúsculas.
 * Separa por whitespace y puntuación común en español (. , ; : ¿ ? ¡ !).
 */
function tokenize(text: string): Set<string> {
  const lower = text.toLowerCase();
  // Separar por cualquier cosa que no sea alfanumérico ni espacio.
  const tokens = lower.split(/[^a-záéíóúñü0-9]+/u);
  return new Set(tokens.filter((t) => t.length > 0));
}
