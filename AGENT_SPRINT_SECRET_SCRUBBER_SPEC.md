# Sprint — Backlog P0 #1: Scrub de Secretos en `step_logs`

> **Sprint**: Backlog P0 #1 (no tiene número Dx porque no es parte del roadmap D2-D6).
> **Spec vivo**: este documento. Se actualiza durante implementación si se descubre scope que falta.
> **Razón de existir**: Habeas Data Colombia (Ley 1581/2012) + cualquier compliance enterprise exige que secretos del cliente (NIT, API keys, passwords, PII) NO se persistan raw en logs. Hoy `step_logs.prompt_sent` y `raw_response` se persisten sin filtro.

## 1. Contexto

`step_logs` es la tabla donde el agente LLM persiste cada llamada (prompt enviado + respuesta cruda). Si el LLM alucina un secreto del cliente — por ejemplo, el user le pasa una factura y el LLM "ve" un NIT, o el LLM devuelve un API key que el user le pegó en el chat — ese secreto queda en DB sin filtro.

**Riesgo si no se cierra** (de `BACKLOG_P0.md` §1):
- Incumplimiento Habeas Data Colombia (datos personales sin protección adecuada).
- Vector de breach: un atacante con acceso a la DB (read-only) encuentra secretos.
- Sin audit de cuántos secretos se filtraron: no podemos medir el riesgo real.

**Bloquea**: onboarding de cualquier cliente que procese datos sensibles (todos, en legal). D3.5 cerró el camino de compliance; scrub lo completa.

**Bloqueado por**: D3.5 cerrado (DONE). Mejor Auth provee el scope por tenant (tenant_id en cada step_log vía sesión).

## 2. Objetivos (qué SÍ se hace)

- **O1**. `SecretScrubber` configurable en `src/lib/secret-scrubber.ts`. Detecta y redacta:
  - **Regex-based**: NIT colombiano (formato `123.456.789-0` o `1234567890`), API keys (formato `sk-xxx`, `AIzaSyxxx`, `ghp_xxx`, etc.), credit cards (16 dígitos), emails, phone numbers, JWT tokens (3 segmentos base64).
  - **Entropy-based**: strings de 32+ chars con entropy >= 4.5 (probable secret random).
- **O2**. Aplicar scrub a los 4 campos donde prompt/raw response se persisten en `step_logs`:
  - `prompt_sent`
  - `raw_response`
  - `summarizer_prompt_sent`
  - `summarizer_raw_response`
- **O3**. Reemplazo: `[REDACTED:<tipo>]` (e.g., `[REDACTED:NIT]`, `[REDACTED:API_KEY]`). NO usar `***` porque pierde el signal de QUÉ tipo era.
- **O4**. Audit log de scrub: cada llamada a scrub incrementa un counter en memoria (process-local). NO persistir en DB (es observabilidad operacional, no audit legal). Si el counter sube mucho, alerta en logs.
- **O5**. **8 tests nuevos** en `test_secret_scrubber.mts` (unit + integración con `step_logs`):
  - Unit: NIT, API key, JWT, credit card, email, entropy.
  - Integration: un input con secretos en `prompt_sent` se persiste redactado en DB.
  - Regression: input sin secretos pasa intacto (zero false positives).
- **O6**. **Cero regresión** en tests D1-D3.5 (422 tests acumulados).
- **O7**. `HANDOFF.md` actualizado al cierre.

## 3. No-objetivos (qué NO se hace)

- **NO-1**. Persistir el contenido redacted en otra tabla. El scrub es destructivo en `step_logs` (es la decisión correcta: no queremos secretos en DB).
- **NO-2**. Hash + salt del secreto en vez de redactar. Eso sería útil para análisis forense ("¿cuántas veces apareció este NIT?") pero es scope adicional. Forward-compat: D6+ si compliance lo pide.
- **NO-3**. Scrubber configurable por tenant. MVP: scrub global. Forward-compat: D6+ permite reglas custom por tenant.
- **NO-4**. Scrub retroactivo de `step_logs` existentes. Solo aplica a writes futuros. Backfill de rows existentes queda como TODO documentado.
- **NO-5**. Persistir el "tipo" detectado (NIT vs API key) en la tabla. Si lo hicieramos, sería PII metadata que también podría ser泄露. Forward-compat: log a stdout con tipo+count (sin contenido).
- **NO-6**. Scrubber en otras tablas (`messages`, `core_memory`, `episodic_memory_v2`). Scope: solo `step_logs`. Si compliance pide, expande en sprint separado.

## 4. Primitivas no negociables

- **P1. Zero false positives en datos normales.** El scrubber debe redactar secretos sin tocar texto legítimo (e.g., un párrafo sobre NITs de clientes NO debe ser redactado — solo NITs reales con el formato exacto).
- **P2. Scrub es destructivo en `step_logs` pero reversible por design.** Si el user necesita el contenido original para audit forense, debe haberlo exportado antes (D6+: `/api/me/export`).
- **P3. El scrubber NO throw.** Si falla (e.g., JSON malformado, regex overflow), log a stderr pero NO bloquees el step log. Un scrubber roto NO debe tumbar el agente.
- **P4. Audit counter es process-local.** NO en DB (es operacional, no legal). Reset por restart del proceso. Forward-compat: si se necesita persistente, post-D6.
- **P5. Scrub se aplica EN EL WRITE, no en lectura.** Es más barato (1 pasada) y previene. Si scrubearamos en lectura, los secretos seguirían en DB.

## 5. Diseño (alto nivel)

```
┌─────────────────────────────────────────────────────────────┐
│  LLM call (OpenRouter / DeepSeek / etc.)                    │
│  - Devuelve promptSent (puede tener secretos)                │
│  - Devuelve rawResponse (puede tener secretos)              │
└─────────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│  completeStepLog() en src/agent/logger.ts                  │
│  - ANTES de persistir, llama scrubSecrets()                 │
│  - Si scrub detecta algo, log a stderr + increment counter   │
│  - Persiste el valor redactado en step_logs                  │
└─────────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│  step_logs table                                             │
│  prompt_sent: "[REDACTED:API_KEY] El usuario dijo..."        │
│  raw_response: "... [REDACTED:NIT] ..."                     │
└─────────────────────────────────────────────────────────────┘
```

## 6. Archivos a tocar / crear

| Archivo | Acción | Razón |
|---|---|---|
| `src/lib/secret-scrubber.ts` (nuevo) | crear | `SecretScrubber` class + `scrubSecrets(input)` function. Regex + entropy. Counter interno. |
| `src/agent/logger.ts` | modificar | Llamar `scrubSecrets()` en las 4 variables antes del UPDATE (líneas 117-122). |
| `test_secret_scrubber.mts` (nuevo) | crear | 8 tests (unit + integration). |
| `HANDOFF.md` | modificar | Log del sprint cerrado. |

## 7. Tests

**8 tests nuevos** en `test_secret_scrubber.mts`:

| # | Test | Cubre |
|---|---|---|
| 1 | scrubSecrets detecta NIT colombiano (`123.456.789-0`) | regex NIT |
| 2 | scrubSecrets detecta API key formato `sk-...` (OpenAI style) | regex API key |
| 3 | scrubSecrets detecta JWT (3 segmentos base64 separados por `.`) | regex JWT |
| 4 | scrubSecrets detecta email | regex email |
| 5 | scrubSecrets detecta credit card (16 dígitos) | regex CC |
| 6 | scrubSecrets detecta string con entropy >= 4.5 (>= 32 chars) | entropy-based |
| 7 | scrubSecrets NO redacta texto legítimo (zero false positives) | regression |
| 8 | Integration: step_logs.prompt_sent con secreto se persiste redactado en DB | integration |

**Regression**: 422 tests acumulados (D1-D3.5) deben seguir pasando.

## 8. Riesgos

| # | Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|---|
| 1 | False positive en regex NIT (e.g., ID de orden `123.456.789-0` que NO es NIT) | Media | Bajo | Regex estricto (formato DIAN con dígito de verificación). Forward-compat: lista de allowlist. |
| 2 | False positive en entropy (e.g., un texto largo legítimo tiene alta entropy) | Baja | Bajo | Threshold conservador (entropy >= 4.5 + length >= 32). |
| 3 | Scrubber degrada performance con strings de 1MB | Baja | Medio | Truncar input a 100KB antes de scrub. |
| 4 | Scrubber NO detecta secret (false negative) | Alta | Alto | Trade-off aceptado: scrubber imperfecto > sin scrubber. Forward-compat: agregar más patrones en cada sprint. |
| 5 | Scrubber rompe JSON válido del prompt/response | Baja | Alto | P3: try/catch + log error. NO throw. |

## 9. Orden de ejecución (por FUNDAMENTO)

1. **SecretScrubber** — implementación. Regex primero (más predecible), entropy después.
2. **Counter interno** — in-memory, reset por restart.
3. **Integration en logger.ts** — las 4 variables se scrubbean antes del UPDATE.
4. **Tests unit** — 6 tests de regex + entropy.
5. **Test integration** — end-to-end con DB.
6. **Regression** — 422 tests pre-existentes.
7. **Docs** — HANDOFF.

## 10. Definition of Done

- [ ] Todos los objetivos de §2 implementados
- [ ] Cero objetivo de §3 implementado
- [ ] Primitivas de §4 todas en el código
- [ ] **8/8 tests nuevos** pasan
- [ ] **422/422 tests acumulados** siguen pasando, 0 regresiones
- [ ] `tsc` sin errores nuevos
- [ ] `HANDOFF.md` actualizado al cierre
- [ ] **Commit + push** a `origin/master`

## 11. Open questions / decisiones diferidas

1. **¿Threshold de entropy?** Mi recomendación: 4.5 + length >= 32. Default NIST para "high entropy". Si genera false positives, subir a 5.0.
2. **¿Truncar input grande?** Sí, a 100KB. Más allá de eso es probablemente un archivo binario en base64, no texto natural.
3. **¿Log de scrub a stdout o stderr?** stderr. stdout es para output del flow; stderr es para diagnóstico operacional.
4. **¿Backfill de step_logs existentes?** NO en este sprint. Forward-compat: sprint separado si compliance pide.

## 12. Referencias

- `BACKLOG_P0.md` §1 (este sprint)
- `src/agent/logger.ts` (call site: líneas 117-122, 128-149)
- `src/lib/db.ts` (schema `step_logs`)
- `AGENT_D3_5_SPRINT_SPEC.md` (patrón de sprint spec)
- `SECURITY.md` §4 (audit trail — menciona que scrub está pendiente)
- Ley 1581/2012 Colombia (Habeas Data)
- NIST SP 800-63B (entropy thresholds para secrets)