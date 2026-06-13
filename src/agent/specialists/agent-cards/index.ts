/**
 * Worgena — Agent Cards de los 3 specialists (D2b.2).
 *
 * Fuente de verdad: `AGENT_D2B_2_SPEC.md` §3.5, §5.4, §8.5.
 *
 * Los 3 specialists del roadmap §6.2 con sus Agent Cards formales.
 * Construidos en código (objetos TS) con `buildAgentCard(...)` y
 * exportados como `readonly` para que el motor y otros consumers
 * (audit, A2A server de D3+) los lean.
 *
 * **Por qué centralizados en un solo archivo**: 1 lugar para revisar
 * "qué agents tiene Worgena". Si en D2c se agregan skills v1, los
 * cards se actualizan acá. Forward-compat: el A2A server de D3+ lee
 * este archivo directamente para servir `/.well-known/agent.json`.
 *
 * **Inmutabilidad**: cada card se exporta como `const` (TS readonly).
 * Si en el futuro un card necesita ser dinámico (ej: pricing por
 * tenant), se reemplaza por un builder que retorna un nuevo card.
 */

import { buildAgentCard, type AgentCard } from "../agent-card.js";

// ============================================================
// INTAKE_AGENT_CARD
// ============================================================

/**
 * Card del Intake Specialist. Tier liviano. Clasifica documentos legales.
 *
 * Pricing: tier liviano (DeepSeek). Límites permisivos (es el agent
 * que más se invoca — es la entrada del workflow).
 */
export const INTAKE_AGENT_CARD: AgentCard = buildAgentCard({
  name: "Intake Specialist",
  description:
    "Clasifica documentos legales en categorías (contrato, demanda, " +
    "sentencia, opinión, otro) y devuelve un nivel de confianza entre 0 y 1. " +
    "Es el agent de entrada de los workflows de revisión.",
  version: "1.0.0",
  provider: {
    organization: "Worgena",
    url: "https://worgena.example.com",
  },
  url: "https://worgena.example.com/agents/intake_specialist_v1",
  skills: [
    {
      id: "document_classification",
      name: "Document Classification",
      description:
        "Recibe el contenido de un documento legal y devuelve su " +
        "categoría (contrato / demanda / sentencia / opinión / otro) " +
        "más un nivel de confianza entre 0 y 1.",
      tags: ["classification", "intake", "legal", "spanish"],
      examples: [
        "Clasificar el contenido de un PDF como 'contrato' o 'demanda'.",
        "Distinguir una opinión legal de una sentencia judicial.",
      ],
    },
    {
      id: "categorization_with_confidence",
      name: "Categorization with Confidence",
      description:
        "Variante de document_classification que siempre retorna el campo " +
        "'confidence' explícitamente, útil para confidence gating en el motor.",
      tags: ["confidence", "gating", "intake"],
    },
  ],
  defaultInputModes: ["text"],
  defaultOutputModes: ["json"],
  pricing: {
    promptUsdPerM: 0.14,
    completionUsdPerM: 0.28,
    currency: "USD",
  },
  limits: {
    maxTokens: 8_000,
    maxRequestsPerMinute: 60,
    maxConcurrent: 10,
  },
});

// ============================================================
// CLAUSE_REVIEWER_AGENT_CARD
// ============================================================

/**
 * Card del Clause Reviewer Specialist. Tier robusto. Revisa cláusulas
 * contractuales en busca de abusividad.
 *
 * Pricing: tier robusto (Claude 3.5 Sonnet). Límites más restrictivos
 * (es un agent caro, se invoca menos seguido).
 */
export const CLAUSE_REVIEWER_AGENT_CARD: AgentCard = buildAgentCard({
  name: "Clause Reviewer Specialist",
  description:
    "Revisa cláusulas contractuales y devuelve, para cada una, su " +
    "nivel de riesgo (low / medium / high) y una razón breve. Usa " +
    "principios generales de derecho contractual (en D2c se cargan " +
    "los principios colombianos específicos).",
  version: "1.0.0",
  provider: {
    organization: "Worgena",
    url: "https://worgena.example.com",
  },
  url: "https://worgena.example.com/agents/clause_reviewer_specialist_v1",
  skills: [
    {
      id: "clause_review",
      name: "Clause Review",
      description:
        "Recibe una lista de cláusulas contractuales (cada una con id y " +
        "texto) y devuelve, para cada una, su nivel de riesgo y razón.",
      tags: ["clause_review", "contract_analysis", "risk", "legal"],
    },
    {
      id: "abusive_clause_detection",
      name: "Abusive Clause Detection",
      description:
        "Variante que prioriza la detección de cláusulas abusivas " +
        "(desequilibrio manifiesto, renuncia a derechos, cláusulas " +
        "penales excesivas). Marca como 'high' cualquier candidata.",
      tags: ["abusive_clauses", "consumer_protection", "legal"],
    },
  ],
  defaultInputModes: ["text", "json"],
  defaultOutputModes: ["json"],
  pricing: {
    promptUsdPerM: 3.00,
    completionUsdPerM: 15.00,
    currency: "USD",
  },
  limits: {
    maxTokens: 16_000,
    maxRequestsPerMinute: 30,
    maxConcurrent: 5,
  },
});

// ============================================================
// VERIFIER_AGENT_CARD
// ============================================================

/**
 * Card del Verifier Specialist. Tier robusto. Verifica outputs de
 * productores en sub-sesión lógica (prompt limpio, sin acceso al
 * system prompt del productor). Implementa Citation Grounding v2.
 */
export const VERIFIER_AGENT_CARD: AgentCard = buildAgentCard({
  name: "Verifier Specialist",
  description:
    "Verifica el output de un productor (otro specialist o un nodo " +
    "LLM directo) en una sub-sesión lógica con prompt limpio. " +
    "Retorna un verdict (verified / not verified), nivel de confianza, " +
    "notas, issues, y la validación de Citation Grounding v2 (citas a " +
    "texto y metadatos).",
  version: "1.0.0",
  provider: {
    organization: "Worgena",
    url: "https://worgena.example.com",
  },
  url: "https://worgena.example.com/agents/verifier_specialist_v1",
  skills: [
    {
      id: "output_verification",
      name: "Output Verification",
      description:
        "Verifica si el output de un productor es consistente con el " +
        "contexto en que se produjo. Retorna verdict, confidence, y notes.",
      tags: ["verification", "consistency", "defendibility", "legal"],
    },
    {
      id: "citation_grounding_v2",
      name: "Citation Grounding v2",
      description:
        "Valida citas a texto (formato [Doc X, 'rango 1234-5678']) " +
        "y citas a metadatos (formato [Doc X, derogado_por: 'Ley Y']). " +
        "En D2b.2 la validación es heurística; en D3+ usa RAG real.",
      tags: ["citation_grounding", "text_citations", "metadata_citations", "legal"],
    },
    {
      id: "defendibility",
      name: "Defendibility Audit",
      description:
        "Auditoría explícita de la defendibilidad legal del output: " +
        "¿se sostiene contra el contexto? ¿es ambiguo? ¿requiere HITL?",
      tags: ["audit", "defendibility", "legal_colombia"],
    },
  ],
  defaultInputModes: ["text", "json"],
  defaultOutputModes: ["json"],
  pricing: {
    promptUsdPerM: 3.00,
    completionUsdPerM: 15.00,
    currency: "USD",
  },
  limits: {
    maxTokens: 16_000,
    maxRequestsPerMinute: 30,
    maxConcurrent: 5,
  },
});

// ============================================================
// Mapa: agentId → AgentCard
// ============================================================

/**
 * Mapa de `agentId` → `AgentCard`. Útil para el A2A server de D3+
 * (que itera todos los cards para servir `/.well-known/agent.json`)
 * y para diagnóstico (el motor puede listar todos los specialists
 * disponibles).
 */
export const AGENT_CARDS_BY_ID: Readonly<Record<string, AgentCard>> = Object.freeze({
  [INTAKE_AGENT_CARD.name]: INTAKE_AGENT_CARD,
  [CLAUSE_REVIEWER_AGENT_CARD.name]: CLAUSE_REVIEWER_AGENT_CARD,
  [VERIFIER_AGENT_CARD.name]: VERIFIER_AGENT_CARD,
});
