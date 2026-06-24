# AGENT D2C — SKILLS v1 SPEC

**Versión**: 1.0
**Fecha**: 2026-06-13
**Sprint**: D2c
**Roadmap referencia**: §5.4, §5.7, §5.14

---

## 0. Status

**Cerrado en este sprint.** Decisiones tomadas: 8 (ver §11). Implementación cubierta por tests (ver §12).

---

## 1. Por qué este spec existe

D1 dejó un `policy-engine` con **topic-based policies** (tributario, jurisprudencia, laboral, comercial, general). Era un JSON con listas de URLs permitidas/prohibidas. Sirvió para validar URLs en D1, pero **no se integró con el motor del agente** (D2a) ni con los specialists (D2b).

**D2c formaliza el packaging de policies como skills**, en línea con la decisión arquitectónica de roadmap §5.7:

> **Skill** = paquete versionado de instrucciones + código + recursos. Carga instrucciones y capacidades, no razonamiento. **No tiene LLM propio**. Se carga cuando la tarea lo requiere (pre-loop, no in-loop). Decide el router (Capa 2) o el usuario (manual).

**Objetivo concreto**: que los 3 specialists actuales (`intake_specialist`, `clause_reviewer_specialist`, `verifier_specialist`) puedan cargar la skill jurídica colombiana (ley posterior, ley especial, etc.) y la inyecten en su system prompt **sin que el motor sepa nada de eso**.

---

## 2. Goals & Non-goals

### Goals

- **G1**: definir el formato de una skill (SKILL.md + assets).
- **G2**: implementar un `SkillRegistry` con descubrimiento por contexto (topic + jurisdicción + dominio).
- **G3**: que los specialists carguen la skill jurídica colombiana en su `systemPrompt` automáticamente cuando el `WorkflowContext.topic === "jurisprudencia"` o `"tributario"`, etc.
- **G4**: que el motor no sepa de skills (forward-compat: cualquier dominio puede tener su skill sin tocar el motor).
- **G5**: mantener compatibilidad con el `policy-engine` de D1 (no romper `test_policy_engine.mts`).
- **G6**: cubrir todo con tests.

### Non-goals

- **NG1**: NO se permite que el usuario edite skills (eso es D6, skill v2).
- **NG2**: NO se carga la skill in-loop. Es pre-loop (al construir el specialist, no en cada nodo).
- **NG3**: NO hay descubrimiento por LLM. El matching es determinista (keywords + topic).
- **NG4**: NO se persisten skills cross-restart. El catálogo se carga del filesystem en cada boot.
- **NG5**: NO hay versiones múltiples de la misma skill activa. Una sola versión por nombre. (Versionado histórico queda para v2.)

---

## 3. Conceptos: Tool, Skill, Subagente

(Referencia: roadmap §5.7. Repetido acá para que el spec sea autocontenido.)

| Concepto | Qué es | Tiene LLM propio | Cuándo se carga | Quién decide |
|---|---|---|---|---|
| **Tool** | Función pura. Input → output. | No | Siempre disponible según permisos. | El LLM elige (ReAct). |
| **Skill** | Paquete versionado de instrucciones + recursos. | No | Pre-loop, cuando la tarea lo requiere. | El router (Capa 2) o el usuario. |
| **Subagente** | Agente hijo con contexto limpio. | Sí | Cuando el orquestador lo lanza. | El orquestador o el LLM padre. |

**Aplicación a D2c**: las skills son archivos `.md` (instrucciones en markdown) + opcionalmente assets (`.json`, `.txt`). Se cargan como strings y se concatenan al system prompt del specialist. NO ejecutan código.

---

## 4. Formato de una skill

### 4.1. Estructura de directorio

```
skills/
├── juridica-colombia/
│   ├── SKILL.md          # Manifiesto + instrucciones (obligatorio)
│   ├── principios.md     # Principios jurídicos (opcional, incluido en SKILL.md)
│   └── assets/
│       └── glosario.json  # Términos para el verificador (opcional)
├── tributaria-co/
│   ├── SKILL.md
│   └── ...
└── general/
    ├── SKILL.md
    └── ...
```

### 4.2. SKILL.md — formato

YAML front matter + markdown body. Ejemplo:

```markdown
---
name: juridica-colombia
version: 1.0.0
description: Principios de interpretación jurídica colombiana (ley posterior, ley especial, jerarquía normativa)
domain: legal
jurisdiction: CO
topics:
  - jurisprudencia
  - tributario
  - laboral
  - comercial
trigger_keywords:
  - demanda
  - contrato
  - ley
  - jurisprudencia
  - código
  - constitución
  - sentencia
  - tutela
author: Worgena
created: 2026-06-13
---

# Principios de interpretación jurídica colombiana

Aplica a cualquier análisis jurídico en Colombia. Estos principios son **normas de segundo orden** (reglas sobre cómo aplicar las normas de primer orden).

## 1. Ley posterior prevalece sobre la anterior

Si dos normas regulan la misma materia de forma contradictoria, la más reciente deroga a la anterior en lo que le sea contraria.

## 2. Ley especial sobre ley general (matiz colombiano)

A diferencia de España, en Colombia la regla es **invertida** (art. 3 CC colombiano): la ley especial deroga la ley general solo si es **anterior y posterior la general**, salvo **derogación expresa**.

## 3. Derogación tácita vs expresa

- **Expresa**: la norma nueva dice "deroga X". Aplica aunque sea general derogando especial.
- **Tácita**: la norma nueva cubre la misma materia sin decirlo. Requiere verificar incompatibilidad material.

## 4. Jerarquía de normas

Constitucional > legal > decreto > resolución > circular. Resolver antinomias respetando el orden.

## 5. Vigencia y ultraactividad

Una norma derogada puede seguir rigiendo **situaciones jurídicas concretas** nacidas bajo su vigencia. Distinguir "derogada" (no aplica a futuro) de "no vigente para nuevas situaciones" (puede aplicar a hechos pasados).
```

### 4.3. Front matter — campos obligatorios

| Campo | Tipo | Descripción |
|---|---|---|
| `name` | string | Identificador único de la skill. kebab-case. |
| `version` | semver | Versión semántica. |
| `description` | string | Descripción de una línea. |
| `domain` | string | Dominio (`legal`, `tributario`, `contabilidad`, etc.). |
| `topics` | string[] | Topics del workflow con los que matchea. |
| `trigger_keywords` | string[] | Palabras clave para matchear contexto. **Convención**: lowercase, singular, alfanumérico sin `_` (ver §4.4). |
| `jurisdiction` | string | País/región (`CO`, `US-CA`, etc.). Opcional. |
| `author` | string | Quién la escribió. |
| `created` | ISO date | Cuándo se creó. |

### 4.4. Convención de `trigger_keywords` (MIN-2, MIN-3 — audit D2c 2026-06-13)

El matching de keywords es **estricto, sin stemming ni lematización**. Para que el match funcione predeciblemente, las keywords deben seguir esta convención:

- **Lowercase**: la keyword se compara con el `userMessage` después de `toLowerCase()`. Si la keyword es "LEY" y el texto dice "ley", matchea (por la lowercasing). Pero por consistencia, **siempre escribir en lowercase**.
- **Singular**: "ley" matchea "ley" y "leyes" NO matchea. Si querés matchear plural, agregá ambas como keywords separadas. **Convención: usar singular.**
- **Alfabético, sin `_`**: el regex de tokenización separa por `[^a-záéíóúñü0-9]+`. El `_` no está incluido. Si la keyword es "caso_123" nunca va a matchear. **Convención: solo `[a-z0-9áéíóúñü]`.**
- **Sin puntuación interna**: "código civil" se tokeniza como 2 tokens (`código` y `civil`). La keyword "código civil" no matchea como frase exacta. **Convención: 1 keyword = 1 palabra.**

**Por qué esta convención**: stemming/lematización agregan complejidad (qué librería, qué idioma, falsos positivos) y el spec §11 decisión 3 dice "discovery determinista, no por LLM". Si en D6 (editor de skills) se necesita fuzzy matching, se agrega como feature explícita, no se cambia el default.

---

## 5. SkillRegistry — API

### 5.1. Tipo `Skill`

```typescript
type Skill = {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly domain: string;
  readonly topics: readonly string[];
  readonly triggerKeywords: readonly string[];
  readonly jurisdiction?: string;
  readonly author: string;
  readonly created: string;
  readonly body: string;       // Markdown body (después del front matter)
  readonly assets: ReadonlyMap<string, string>;  // path → contenido
};
```

### 5.2. Clase `SkillRegistry`

```typescript
class SkillRegistry {
  /** Carga todas las skills de un directorio. */
  static loadFromDir(dir: string): SkillRegistry;

  /** Carga skills desde un Map pre-construido (para tests / in-memory). */
  static create(skills: ReadonlyMap<string, Skill>): SkillRegistry;

  /** Lista nombres de skills, ordenados alfabéticamente. */
  listSkills(): readonly string[];

  /** Obtiene una skill por nombre. */
  get(name: string): Skill | null;

  /** Cantidad de skills cargadas. */
  size(): number;

  /**
   * Descubre skills relevantes para un contexto. Retorna `SkillMatch[]`
   * (no `Skill[]`): cada match incluye `score` y `matchedOn` para
   * debugging y auditoría.
   *
   * Algoritmo de scoring determinista (ver §5.3).
   * Si no hay match, retorna [].
   */
  discover(context: SkillDiscoveryContext): readonly SkillMatch[];
}

type SkillDiscoveryContext = {
  readonly topic?: string;
  readonly jurisdiction?: string;
  readonly userMessage?: string;  // Para keyword matching
};

type SkillMatch = {
  readonly skill: Skill;
  readonly score: number;
  readonly matchedOn: {
    readonly topic: boolean;
    readonly jurisdiction: boolean;
    readonly keywordMatches: readonly string[];
  };
};
```

### 5.3. Algoritmo de discovery

```
score = 0
if skill.topics.includes(context.topic): score += 10
if skill.jurisdiction === context.jurisdiction: score += 5
if any(keyword in context.userMessage): score += keyword_count

return skills con score > 0, ordenadas por score desc
```

**Tiebreak**: nombre alfabético ascendente (determinista).

---

## 6. Integración con specialists

### 6.1. Inyección de skills en `systemPrompt`

Cada specialist (en D2b) tiene un método `buildSystemPrompt()`. Se modifica para:

1. Recibir un `SkillRegistry` en el constructor (opcional).
2. En cada `execute()`, construir un `SkillDiscoveryContext` a partir del `node.metadata` (topic + jurisdiction) y del `userMessage` derivado del input del nodo.
3. Llamar a `discover(ctx)` y concatenar las skills resultantes al system prompt base.

**Convención: el workflow pasa `topic` y `jurisdiction` via `node.metadata`**. Esto es D2c-only; en D3+ se introducirá un `WorkflowContext` formal. El interface `LLMNode` declara `metadata?: { topic?: string; jurisdiction?: string }` (ver `src/agent/workflow-engine/dsl/types.ts`).

```typescript
class ClauseReviewerSpecialist implements Specialist {
  constructor(
    private readonly invoker: LLMInvoker,
    public readonly skills?: SkillRegistry,
  ) {}

  async execute(params: SpecialistExecuteParams): Promise<NodeExecutionOutcome> {
    const { node, state } = params;
    const userInput = resolveStateRef(state, node.input.from, node.input.default);
    const discoveryCtx: SkillDiscoveryContext = {
      topic: node.metadata?.topic,
      jurisdiction: node.metadata?.jurisdiction,
      userMessage: typeof userInput === "string" ? userInput : JSON.stringify(userInput),
    };
    const systemPrompt = this.buildSystemPrompt(discoveryCtx);
    // ... usar systemPrompt
  }

  protected buildSystemPrompt(discoveryCtx?: SkillDiscoveryContext): string {
    const base = "Sos un revisor de cláusulas contractuales. ...";
    if (this.skills && discoveryCtx) {
      return base + formatSkillsForPrompt(this.skills, discoveryCtx);
    }
    return base;
  }
}
```

### 6.2. Cuándo se cargan

**El `discover()` se hace en cada `execute()`** (no pre-loop, no al boot):

- El `SkillRegistry` se carga una sola vez al boot (`SkillRegistry.loadFromDir(...)`), incluyendo el parseo de todos los SKILL.md (caro, se hace 1 vez).
- En cada `execute()`, el specialist construye un `SkillDiscoveryContext` con el `topic` y `jurisdiction` del `node.metadata` (más el `userMessage` derivado del input del nodo), llama a `discover(ctx)`, y concatena el resultado al system prompt.

**Razón**: el contexto del nodo (topic, jurisdicción, mensaje) puede cambiar entre nodos del mismo workflow. Hacer el discover por nodo permite que el mismo specialist se adapte a contextos distintos sin tener que re-construirlo.

**Costo**: el `discover()` es O(N×K) sobre N skills con K keywords cada una. Típicamente <1ms para 10 skills con 10 keywords. Despreciable comparado con el costo del LLM call (cientos de ms a segundos). **No es un cuello de botella.**

**Forward-compat**: si en D3+ con multi-tenant el catálogo crece a 1000+ skills por tenant, se puede pasar a O(1) con un índice invertido (mapa `topic → Set<skillName>`). El interface público no cambia.

### 6.3. Auditoría

Cuando un specialist aplica una skill, lo loguea en el audit log:

```json
{
  "event": "skill.loaded",
  "skill": "juridica-colombia",
  "version": "1.0.0",
  "matchedOn": {
    "topic": "jurisprudencia",
    "jurisdiction": "CO",
    "keywordMatches": ["sentencia", "tutela"]
  }
}
```

**Implementación**: se agrega un `audit` callback opcional al `SpecialistRequest`. Si está presente, el specialist lo invoca cuando carga skills. Sin callback, no se loguea (backward-compat).

---

## 7. Compatibilidad con D1

El `policy-engine` de D1 sigue existiendo. Las **skills** son una capa nueva encima. Relación:

- `policy-engine` se usa para **validar URLs** (allowlist/blocklist por topic). No cambia.
- Las **skills** son **instrucciones para el LLM** (markdown, no lógica). Nuevo.
- Una skill puede referenciar URLs de `policy-engine` en su body, pero no se cruzan automáticamente.

**Test**: `test_policy_engine.mts` debe seguir pasando tal cual. Las skills no lo tocan.

---

## 8. Estructura de archivos

```
src/agent/skills/
├── skill.ts            # Tipo Skill, parser de front matter
├── skill-registry.ts   # Clase SkillRegistry
└── index.ts            # Barrel

skills/                  # Directorio de skills (assets, no código)
├── juridica-colombia/
│   ├── SKILL.md
│   └── (assets opcionales)
└── general/
    └── SKILL.md

test_workflow_d2c.mts    # Tests del módulo de skills
```

---

## 9. API pública (consumida por los specialists)

```typescript
export type { Skill, SkillDiscoveryContext } from "./skill.js";
export { SkillRegistry } from "./skill-registry.js";
```

Los specialists importan `SkillRegistry` y lo reciben por constructor (opcional). Si no se les pasa, no cargan skills (modo sin skills, para tests sin dominio).

---

## 10. Edge cases

| Caso | Comportamiento esperado |
|---|---|
| SKILL.md sin front matter válido | Tira error al cargar. No se ignora silenciosamente. |
| Dos skills con el mismo `name` | Tira error al cargar. No se sobreescribe. |
| Topic que no matchea ninguna skill | `discover()` retorna `[]`. No es error. |
| User message con caracteres especiales | Match es case-insensitive y split por whitespace + puntuación. |
| Skill con `body` vacío | Se carga igual (puede tener solo assets). Se loguea warning. |
| Disco duro con permisos denegados | `loadFromDir` tira error con el path. No falla silencioso. |

---

## 11. Decisiones de diseño (registradas)

1. **Front matter en YAML, no JSON**. Es estándar en tooling de skills (Anthropic Skills, Cursor, etc.) y más legible.
2. **Skills son markdown, no código**. Se cargan como string. No hay DSL propio. Forward-compat: si en v2 el usuario quiere editarlas, es texto plano.
3. **Discovery determinista, no por LLM**. El matching es por keywords + topic. Más rápido, debuggeable, sin riesgo de alucinación.
4. **Score en el discovery es explícito** (no hidden weights). El caller puede reimplementarlo si quiere.
5. **No hay `enable/disable` por skill**. Si está en el directorio, está activa. Para v2 (D6) sí.
6. **El motor no sabe de skills**. Los specialists son el único punto de integración. Forward-compat con cualquier dominio.
7. **`loadFromDir` falla loud**. Si una SKILL.md está malformada, el boot falla. No se skipea.
8. **Auditoría es opcional** (callback). Forward-compat con D3+ donde se logueará a DB.

---

## 12. Tests requeridos

### 12.1. Test del parser

- Parsea SKILL.md con front matter válido → Skill correcto.
- Falla con front matter faltante.
- Falla con YAML inválido.
- Lee `body` después del front matter (no como parte del front matter).

### 12.2. Test del registry

- `loadFromDir` carga todas las skills de un directorio.
- `get(name)` retorna la skill o null.
- `listSkills()` retorna nombres ordenados alfabéticamente.
- Doble skill con mismo `name` tira error.
- Skill sin front matter válido tira error.

### 12.3. Test del discovery

- Match exacto por topic.
- Match por jurisdicción + 1 keyword.
- Sin match → `[]`.
- Múltiples matches → ordenadas por score desc.
- Tiebreak alfabético.

### 12.4. Test de integración con specialists

- `ClauseReviewerSpecialist` con `SkillRegistry` carga la skill jurídica cuando `topic === "jurisprudencia"`.
- Sin `SkillRegistry`, el specialist funciona igual (modo sin skills).
- El `audit` callback se invoca cuando se carga una skill.

### 12.5. Test de compatibilidad con D1

- `test_policy_engine.mts` sigue pasando sin cambios.

---

## 13. Open questions / action items

| # | Pregunta | Decisión |
|---|---|---|
| OQ-1 | ¿Soportar skills anidadas (subcarpetas)? | **No en v1**. Solo 1 nivel. |
| OQ-2 | ¿Soportar `body` en JSON en vez de markdown? | **No**. Markdown es el formato. |
| OQ-3 | ¿Las skills tienen `runtime` (TypeScript ejecutable)? | **No en v1**. Solo markdown + assets. |
| OQ-4 | ¿Cuántas skills se cargan máximo? | Sin límite hard. Razonable < 20. |
| OQ-5 | ¿El usuario puede `force-load` una skill manualmente? | **No en v1**. Solo discovery automático. |

---

## 14. Forward-compat con sprints futuros

- **D3 (multi-tenant)**: el catálogo de skills puede ser por tenant. `SkillRegistry.loadFromDir(tenantId)`. El interface no cambia.
- **D6 (editor)**: el usuario edita skills. Cambia `loadFromDir` a `loadFromDir` + override de usuario. Sin breaking change en API pública.
- **v2 de skills**: el `Skill` type gana `runtime?: TypeScriptModule` para lógica custom. El motor lo ejecuta en sandbox. Skills v1 (markdown) siguen funcionando.
