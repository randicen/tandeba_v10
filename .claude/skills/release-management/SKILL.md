---
name: release-management
description: Cómo se hace un release de Worgena: versionado semántico, changelog, feature flags, rollback, comunicación a clientes. Cargar antes del primer release serio a producción, antes de cambios que tocan el motor, multi-tenant, billing, o cualquier feature con blast radius >0.
---

# Release Management

> Skill portada desde Mavis. Original: `C:\Users\acer\.mavis\agents\wozniak\skills\release-management\SKILL.md`. Las `references/` viven en el original.

Cómo hacer un release de Worgena sin romper producción, sin perder clientes, y sin improvisar. NO es sobre el código (eso es `sprint-spec-writing` + `code-review-multi-axis`). Es sobre el **proceso de llevar código a producción** + comunicar a stakeholders.

## Cuándo cargar esta skill

- Antes del primer release serio de Worgena a producción.
- Antes de un release que toca el motor, multi-tenant, billing, o cualquier feature con blast radius >0.
- Cuando se está por hacer un breaking change.
- Cuando se quiere introducir un feature flag nuevo.
- Después de un incidente, para formalizar el runbook.
- Cuando un cliente enterprise pregunta "¿cómo es su proceso de release?" (compliance).

## Procedimiento

1. **Identificar el tipo de release**:
   - **Patch** (1.0.x): bug fix, sin breaking change.
   - **Minor** (1.x.0): nueva feature backwards compatible.
   - **Major** (x.0.0): breaking change, requiere migración y comunicación proactiva.
2. **Verificar pre-condiciones**: tests pasan, spec cerrado en HANDOFF.md, ADR nuevo si toca invariante dura, changelog redactado, plan de rollback documentado, feature flag definido si aplica.
3. **Ejecutar el release**: merge a main, tag con versión semántica, build + push, deploy (staged si es major).
4. **Verificar post-release**: smoke tests, métricas de error rate/latencia/costo, logs de los primeros 30 min.
5. **Comunicar**: internamente (Slack, email), clientes (email, changelog in-app, blog post si es major).
6. **Monitorear durante 24-48h** post-release.

## Versionado semántico

Worgena sigue **Semantic Versioning 2.0.0** (https://semver.org):
- **MAJOR** (x.0.0): breaking change.
- **MINOR** (1.x.0): nueva feature backwards-compatible.
- **PATCH** (1.0.x): bug fix backwards-compatible.

### Pre-1.0

Mientras Worgena está en 0.x, los criterios son más laxos:
- 0.MINOR.PATCH: cada MINOR puede tener breaking changes (porque aún no hay contrato).
- Pasamos a 1.0.0 cuando: (a) tenemos N clientes pagando, (b) el motor cableado a producción, (c) API estabilizada.

## Changelog

```markdown
## [1.4.0] - 2026-06-15

### Added
- Feature X.

### Changed
- Comportamiento Z ahora hace W.

### Fixed
- Bug en el workflow de tutelas. Ref: issue #123.

### Security
- P0 #1 del BACKLOG.md: scrub de secretos en step_logs.
```

El changelog se genera **a partir de los commits + specs** del sprint, no se escribe a mano.

## Feature flags

Convención: `ff_<feature>_<variant>`. Ejemplos:
- `ff_workflow_executor_v2_enabled`
- `ff_billing_v2_enabled`
- `ff_ai_citation_grounding_v3_enabled`

Opciones de implementación: custom en DB (early stage, suficiente), LaunchDarkly/Unleash/Flagsmith (SaaS o self-hosted con A/B y gradual rollout), PostHog (integrado con analytics).

**Cuándo usar flag**: cambio de comportamiento que afecta UX, feature con opt-in, cambio de schema destructivo, cambio de modelo LLM. **Cuándo NO**: bug fix claro, agregar columna trivial.

## Plan de rollback

Cada release tiene plan de rollback ANTES del release. Incluye: cómo volver atrás, cuánto tarda, qué se pierde, trigger (condiciones para ejecutar el rollback).

### Cuándo hacer rollback

- Error rate post-release >3x el baseline.
- Latencia post-release >2x el baseline.
- Costo post-release >2x el baseline.
- Feature no funciona para ningún tenant.
- Brecha de seguridad detectada.

### Cuándo NO hacer rollback

- 1 cliente reporta problema aislado. Investigar primero.
- Métricas suben pero no superan threshold. Monitorear.
- Feature sin adoption. Darle tiempo.

## Comunicación a clientes

- **Patch (1.0.x)**: interno Slack, NO comunicación individual. Changelog público actualizado.
- **Minor (1.x.0)**: interno Slack + email, changelog in-app, email si feature visible.
- **Major (x.0.0)**: all-hands, ADR publicado, blog post 2 semanas antes, email 1 semana antes, in-app el día, soporte extra primera semana.

## Anti-patrones

- "Deployamos y si algo se rompe, lo arreglamos" → RECHAZAR. Plan de rollback OBLIGATORIO.
- "Hagamos el release un viernes a las 5pm" → RECHAZAR. Solo horario laboral con margen.
- "Skip changelog, lo escribimos después" → RECHAZAR.
- "Major release sin feature flag" → AJUSTAR.
- "Cambiar la API sin deprecar la anterior primero" → RECHAZAR.

## References (leer desde Mavis original)

- `C:\Users\acer\.mavis\agents\wozniak\skills\release-management\references\rollback-procedures.md`
- `…\references\release-checklist.md`

## Salida esperada

Plan de release que incluye versión propuesta, changelog redactado, feature flags, plan de rollback, plan de comunicación, checklist pre-deploy lleno. Sin improvisación.
