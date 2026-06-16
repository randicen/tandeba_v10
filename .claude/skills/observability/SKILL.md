---
name: observability
description: Define qué loguear, qué métricas medir, qué alertas configurar, y qué dashboards construir para un motor agéntico en producción. Carga esta skill cuando el founder pida "¿qué métricas debería estar mirando?", "¿qué loguear cuando algo se rompe?", "¿qué alertas ameritan página a las 3am?", o cuando se está por cablear el motor a producción.
---

# Observability

> Skill portada desde Mavis. Original: `C:\Users\acer\.mavis\agents\wozniak\skills\observability\SKILL.md`. Las `references/` viven en el original.

Sin observabilidad, el motor de Worgena es una caja negra. Esta skill cubre **qué instrumentar, qué medir, y qué alertar** para un motor agéntico multi-tenant. No cubre "qué herramienta de monitoring comprar" (eso es `stack-decision`). Cubre **el qué**.

## Cuándo cargar esta skill

- "¿Qué métricas debería estar mirando en producción?"
- "¿Qué loguear cuando algo se rompe?"
- "¿Qué alertas ameritan página a las 3am?"
- "¿Cómo debuggear un workflow que se comportó mal ayer?"
- "¿Cómo medir el costo real por tenant?"
- Antes del primer deploy de una feature que toca el motor.

## Procedimiento

1. **Identificar qué se quiere observar**: comportamiento del motor, comportamiento de los LLMs, comportamiento de los tenants, compliance.
2. **Definir qué se loguea**: eventos estructurados con `timestamp`, `tenant_id`, `workflow_id`, `node_id`. Niveles: DEBUG, INFO, WARN, ERROR. NO loguear secretos, PII del cliente final, ni prompts crudos.
3. **Definir qué se mide**: latencia p50/p95/p99, throughput, error rate, costo por run/nodo/tenant.
4. **Definir qué se alerta**: threshold de "página a las 3am" vs "anotar para el lunes". Quién es el dueño de cada alerta. Runbook de respuesta.
5. **Definir cómo se debuggea**: trazabilidad de queja → output LLM en 5 clicks. Replay. Comparación temporal (regression detection).

## Lo que Worgena hoy tiene

- `apify-tracker.ts` (D1): full attribution por session.
- `PricingCatalog.estimateCost` + `usage.cost` de OpenRouter (D2b.2): atribución por nodo.
- `step_logs` en DB: persistencia de cada step.
- `workflow_audit` (D3+): tabla para auditoría cross-cutting.

Lo que **falta**: latencia por endpoint con percentiles, costo por tenant agregado, correlación `executeWithTimeout` ↔ `workflow_audit` (P0 #3 del BACKLOG.md), alertas automatizadas, dashboard técnico.

## Eventos estructurados (qué loguear)

```json
{
  "ts": "2026-06-15T12:00:00.000Z",
  "level": "INFO",
  "event": "workflow.started",
  "tenant_id": "...",
  "workflow_id": "...",
  "workflow_type": "tutela",
  "user_id": "...",
  "request_id": "..."
}
```

Eventos clave: `workflow.started/completed/failed`, `node.started/completed/failed`, `llm.call.started/completed`, `tool.called/completed/failed`, `human_approval.requested/granted/rejected`, `auth.login/failed`, `data.accessed/modified/deleted`.

## Lo que NUNCA se loguea

- Secretos del cliente (API keys, passwords, NITs en prompts).
- Output crudo del LLM en producción (puede contener PII del cliente final). Solo metadata: tokens, modelo, duración, success/failure.
- Prompts crudos con PII. Hash del prompt, no el prompt mismo.
- Stack traces con paths absolutos.
- Tokens de autenticación de ningún tipo.

## Métricas operacionales

| Métrica | Tipo | Threshold de alerta |
|---|---|---|
| Latencia p50 workflow end-to-end | Gauge | >60s sostenido |
| Latencia p95 workflow end-to-end | Gauge | >5min sostenido |
| Latencia p99 workflow end-to-end | Gauge | >15min sostenido |
| Throughput workflows/hora | Counter | drop >50% vs baseline |
| Error rate global | Counter | >5% en 1h |
| Error rate por node_type | Counter | >10% en 1h |
| Costo LLM/hora | Counter | >$X (definir) |
| Costo LLM/tenant/mes | Gauge | >$Y (definir) |
| HITL approval rate | Gauge | <50% sostenido |
| Auth failure rate | Counter | >10% en 1h |

## Métricas de calidad del LLM

- **Citation accuracy** (% de citas que el verifier confirma correctas).
- **Hallucination rate** (afirmaciones sin sustento en el contexto).
- **Retry rate** (cuántas veces el LLM fue invocado de nuevo porque no pasó la validación).
- **User feedback** (el abogado corrige o rechaza el output).

## Alertas (jerarquía)

### Página inmediata (24/7 al founder)
- Worgena completamente caído.
- Auth compromise detectado.
- Data breach confirmado (output de un LLM contiene secretos de un cliente).
- Costo de LLM explotando (>$1000/hora o 3x el baseline diario).

### P1 — notificar en horario laboral, pagear si pasa del horario
- Error rate >5% en 1h sostenido.
- Latencia p95 >5min sostenido.
- Tenant enterprise caído.
- Un LLM provider degradado.

### P2 — ticket al lunes
- Un nodo específico con error rate >10% en 1 día.
- Costo de LLM sube 50% sin explicación clara.
- Un tenant dejó de usar Worgena (drop >80% en 7 días).

### P3 — backlog, no urgente
- Tendencias de uso.
- Distribución de workloads.

## Trazabilidad y debugging

Para reconstruir una queja de cliente:
1. Quién: `user_id` + `tenant_id`.
2. Qué: `workflow_id` + `node_id`.
3. Cuándo: timestamp exacto.
4. Inputs: hash del prompt (NO prompt crudo con PII), documentos, contexto.
5. Outputs: output completo del LLM.
6. Modelo: `model_id` + versión.
7. Herramientas invocadas: `tool_name` + resultado.
8. HITL: ¿se requirió aprobación? ¿quién aprobó? ¿qué cambió?
9. Costo: tokens + USD.

## Anti-patrones

- **Loguear todo en producción**: el costo de almacenamiento se vuelve problema. Loguear selectivamente.
- **Loguear PII en logs de aplicación**: scrub SIEMPRE.
- **Métricas sin dashboard**: si nadie mira, no existen.
- **Alertas con threshold mal puesto**: demasiadas = se ignoran todas.
- **Logs sin correlación entre servicios**: correlacionar por `request_id`.
- **Stack traces que el cliente ve**: regla dura. Log internamente, mensaje genérico al cliente.

## References (leer desde Mavis original)

- `C:\Users\acer\.mavis\agents\wozniak\skills\observability\references\log-format.md` — formato exacto de eventos estructurados
- `…\references\metric-catalog.md` — catálogo de métricas con nombre, tipo, fuente, threshold
- `…\references\alerting-runbook.md` — runbook de cada alerta

## Salida esperada

Plan de observabilidad para una feature o sprint, con eventos, métricas, alertas, y trazabilidad.
