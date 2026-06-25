---
created: 2026-06-15 12:54
updated: 2026-06-15 12:54
tags: [backlog, P0, seguridad, wozniak, sprint-futuro]
---

# Backlog P0 — issues conocidos (a evaluar al volver a D3)

Issues críticos identificados por Wozniak al poblar las `references/`
de las skills de cofundador. NO son sprints cerrados. Son **trabajo
pendiente que probablemente debería entrar antes o durante D3**.

## 1. Scrub de secretos en `step_logs` (P0)

Tags: #seguridad #audit-log #legal

**Hallazgo** (Wozniak, sesión 2026-06-15, `tech-debt-audit` → `debt-categories.md`):
- `step_logs.prompt_sent` y `step_logs.raw_response` persisten raw.
- Si el LLM alucina un secreto del cliente (password, NIT, API key),
  queda en DB sin filtro.
- AUDIT_D2 §6 lo marca explícitamente.
- Sin rate limit ni validación de input length.

**Riesgo si no se cierra**: legal alto. Worgena procesa datos
confidenciales de clientes; un secreto persistido en logs es
incumplimiento de Habeas Data y潜在的 vector de breach.

**Próximo paso propuesto**:
- Definir un `SecretScrubber` configurable (regex + entropy-based).
- Aplicarlo en el path de escritura de `step_logs`, no en lectura
  (es más barato y previene).
- Audit log de scrub: cuántos secrets se filtraron por sprint (sin
  contenido).
- Test de regresión: input con un NIT/API key/password no aparece en
  el row persistido.

## 2. Auth real en el motor (P0)

Tags: #seguridad #multi-tenant #auth #D3.4

**Hallazgo** (Wozniak, sesión 2026-06-15, `security-hardening` →
`multi-tenant-isolation.md` y `audit-log-patterns.md`):
- Cualquier HTTP caller puede mentir `tenantId` en `options` del
  `startTask` (`executor.ts:604-608`).
- El motor confía en el caller. No valida que el `tenantId`
  corresponda a un usuario autenticado.
- D3.4 spec escrita (`AGENT_D3_4_5_DB_AUTH_SPEC.md`) pero no
  implementada.

**Riesgo si no se cierra**: spoofing cross-tenant. Un caller
autenticado como firma A podría operar tareas de firma B pasando
`tenantId: B` en el body. El motor ejecuta sin quejarse. El
aislamiento row-level actual protege los datos, pero no las acciones
entre tenants.

**Próximo paso propuesto**:
- Implementar la D3.4 spec (auth middleware + verificación de
  `tenantId` en el path crítico).
- Test obligatorio: usuario de firma A intenta `startTask({tenantId: B})`
  → 403.
- Migrar gradualmente: feature flag, primero en endpoints nuevos.

## 3. Costo de LLM no atribuible por tenant (P1, muy cerca de P0)

Tags: #costo #observabilidad #openrouter #D3+

**Hallazgo** (Wozniak, sesión 2026-06-15, `security-hardening` →
`audit-log-patterns.md` y `code-review-multi-axis` → `review-checklist.md`):
- Hay 3 capas de medición: `apify-tracker.ts` (D1, full attribution
  por session), `PricingCatalog.estimateCost` + `usage.cost` de
  OpenRouter (D2b.2, atribución por nodo via `NodeResult.costUsd`).
- `OpenRouterClient.executeWithTimeout` no loguea `taskId`/`tenantId`
  en la llamada, solo `model` y `latencyMs`.
- Correlacionar costo-por-tenant requiere cruzar timestamps con
  `workflow_audit` (tabla que existe en D3+).

**Riesgo si no se cierra**: no podemos cobrar por uso, no podemos
hacer unit economics, no podemos detectar fuga de tokens por
prompt mal armado.

**Próximo paso propuesto**:
- Modificar `OpenRouterClient.executeWithTimeout` para aceptar
  contexto `{taskId, tenantId, agentCardId}` y loguearlo.
- Tabla `workflow_audit` (de D3.3) ya tiene los hooks; falta
  cablearlos al invoker.
- Test de regresión: un workflow de 5 nodos genera 5 rows en
  `workflow_audit` con `costUsd` consistente con la suma de
  `usage.cost` de los nodos.

## Cómo trabajar estos items

Cuando se arranque D3 (o el sprint equivalente), leer primero:
- `AGENT_ROADMAP.md` (orden vigente)
- `HANDOFF.md` (estado al cierre)
- Las `references/` pobladas por Wozniak (las 8 que se actualizaron
  en esta sesión).

Cada item de este backlog debe tener, antes de construir:
1. Spec en formato `AGENT_Dx_<item>_SPEC.md` con scope, no-objetivos,
   primitivas, tests, riesgos.
2. ADR si la decisión toca una invariante dura (motor propio, 3
   capas, versionado, multi-tenant).
3. Test de regresión desde el día 1 — sin test, el item no se
   considera cerrado.

## Estado

- [ ] Item 1 — scrub de secretos (próximo sprint post-D3.5)
- [x] Item 2 — auth real en el motor — ✅ CERRADO via D3.4 (commit `4af3e0c`) + audit fixes (commit `fe90ab7`)
- [ ] Item 3 — atribución de costo por tenant
