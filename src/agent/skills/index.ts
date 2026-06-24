import type { SkillRegistry, SkillMatch } from "./skill-registry.js";
import type { SkillDiscoveryContext } from "./skill.js";

export type { Skill, SkillDiscoveryContext, SkillMatch } from "./skill.js";
export { parseSkillFile } from "./skill.js";
export { SkillRegistry } from "./skill-registry.js";

/**
 * Formatea las skills discoveries como sección de system prompt.
 *
 * Se concatena al final del system prompt del specialist. Si no hay
 * skills, retorna string vacío (no agrega ruido al prompt).
 *
 * Formato:
 * ```
 *
 * # Skills cargadas
 *
 * <skill name="juridica-colombia" version="1.0.0">
 * {body completo de la skill}
 * </skill>
 *
 * <skill name="otra" version="2.0.0">
 * {body}
 * </skill>
 * ```
 */
export function formatSkillsForPrompt(
  registry: SkillRegistry,
  context: SkillDiscoveryContext,
): string {
  const matches = registry.discover(context);
  if (matches.length === 0) return "";
  const sections = matches.map(
    (m: SkillMatch) =>
      `<skill name="${m.skill.name}" version="${m.skill.version}">\n${m.skill.body}\n</skill>`,
  );
  return `\n\n# Skills cargadas\n\n${sections.join("\n\n")}`;
}

