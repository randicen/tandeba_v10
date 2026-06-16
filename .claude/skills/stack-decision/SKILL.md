---
name: stack-decision
description: Análisis corto de un servicio o librería externa antes de integrarlo a Worgena, evaluando pricing, lock-in, compliance, alternativas y costo de integración. Cargar cuando se evalúe un proveedor de auth, storage, LLM, payments, o cualquier cosa con lock-in significativo. La decisión final la toma el founder humano.
---

# stack-decision

> Skill portada desde Mavis. Original: `C:\Users\acer\.mavis\agents\wozniak\skills\stack-decision\SKILL.md`. Las `references/` viven en el original.

Análisis corto de un servicio o librería externa antes de integrarlo a Worgena. Sigue la regla de la casa: **consultar antes de elegir servicios críticos**.

## Cuándo cargar esta skill

- "¿Usamos X o Y para <auth / storage / payments / LLM / etc.>?"
- "Compará OpenAI directo vs OpenRouter"
- "Evaluá Clerk vs Supabase Auth"
- Cualquier decisión de stack que toque: auth/identidad, storage de datos de clientes, LLMs de producción, payments, o algo con lock-in significativo.

## Procedimiento

1. **Definir el problema** en 1-2 oraciones. No la solución, el problema.
   - Ej: "Necesitamos auth multi-tenant con SSO para firmas de 50+ abogados cada una."
   - Anti-ejemplo: "¿Usamos Clerk?" → eso es saltar a la solución.
2. **Listar 2-3 candidatos reales**. Si solo hay 1, decirlo (es lock-in total).
3. **Para cada candidato, evaluar 5 ejes**:

| Eje | Pregunta |
|---|---|
| **Pricing** | ¿Cuánto cuesta a nuestra escala objetivo (100 firmas, 10k usuarios)? ¿Hay free tier? ¿Cómo escala? |
| **Lock-in** | ¿Qué pasa si nos queremos ir? ¿Cuánto cuesta migrar? (data egress, re-cableado de UI, re-training del agente) |
| **Compliance** | ¿Cumple lo que necesitamos? (Habeas Data Colombia, SOC2 si el cliente lo pide, GDPR si hay datos UE) |
| **Alternativas** | ¿Hay 1-2 opciones serias más? (no es para descartarlas, es para tener backup) |
| **Costo de integración** | Horas de implementación + tiempo de mantenimiento continuo |

4. **Recomendar UNO**, con razones. Si los 3 sirven y da lo mismo, decirlo y dejar que el founder elija.
5. **Si el servicio toca data de clientes**: agregar explícitamente data residency, acceso a la data encriptada, RTO/RPO del proveedor.
6. **Devolver** en formato corto:

```
PROBLEMA: <1-2 oraciones>
CANDIDATOS: 1, 2, 3 con 1 línea cada uno
ANÁLISIS: tabla con los 5 ejes
RECOMENDACIÓN: <uno, con razones>
RIESGO: <qué se rompe si la recomendación está mal>
PRÓXIMO PASO: <acción concreta — pilot, contrato, o decisión del founder>
```

## References (leer desde Mavis original)

- `C:\Users\acer\.mavis\agents\wozniak\skills\stack-decision\references\llm-routing.md` — comparativa OpenAI vs Anthropic vs OpenRouter
- `…\references\openrouter-patterns.md` — cómo se usa OpenRouter en Worgena
- `…\references\storage-tradeoffs.md` — comparativa S3 / R2 / Supabase Storage / Vercel Blob
- `…\references\auth-providers-analysis.md` — comparativa Clerk / WorkOS / Auth0 / Supabase Auth

## Anti-patrones

- "Es lo que conozco" → no es razón. Hay que evaluar.
- "Es lo que usa la mayoría" → no es razón. Hay que evaluar al problema nuestro.
- "Lo evaluamos después" → no se integra sin evaluar antes.
- "Es gratis" → el costo de integración y lock-in también cuentan.

## Restricción crítica

El founder humano toma la decisión final. Esta skill **propone**, no decide. Si el founder ya mencionó un proveedor casualmente ("había considerado Clerk"), asumir que está en fase exploratoria, NO integrarlo sin pedir confirmación.
