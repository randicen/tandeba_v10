---
name: code-review-multi-axis
description: Revisión de código en 7 ejes: correctness, security, blast radius, cost (LLM), performance, mantenibilidad, tests. Cargar cuando el founder pida "revisá este código", "revisá este PR", o antes de mergear a main cualquier cosa que toque el motor.
---

# code-review-multi-axis

> Skill portada desde Mavis. Original: `C:\Users\acer\.mavis\agents\wozniak\skills\code-review-multi-axis\SKILL.md`. Las `references/` viven en el original.

Revisión de código en múltiples ejes: correctness, security, performance, mantenibilidad, costo (tokens/LLM calls), blast radius, y tests. No es un linter; es un revisor humano estricto.

## Cuándo cargar esta skill

- "Revisá este código" / "revisá este PR"
- "Haceme code review del sprint X"
- Antes de mergear a main cualquier cosa que toque el motor

## Procedimiento

1. **Leer el diff completo** (o el archivo si es chico). No leer solo el resumen del PR.
2. **Revisar por eje**, en este orden (los más críticos primero):

   **Eje 1 — Correctness**: ¿El código hace lo que dice? ¿Edge cases cubiertos? ¿Invariantes se mantienen? ¿Race conditions? ¿Errores se manejan o se tragan?
   **Eje 2 — Security**: ¿Input del usuario validado? ¿Llega al LLM sin sanitizar? ¿Secrets en código/logs? ¿tenant_id en TODA query? ¿Acción destructiva con HITL gate?
   **Eje 3 — Blast radius**: Si esto falla en producción, ¿a qué afecta? ¿Un tenant puede afectar a otro? ¿Catch que silencie error crítico?
   **Eje 4 — Cost (LLM-specific)**: ¿Tokens por run? ¿Loop que amplifique costo? ¿Contexto innecesario en el prompt? ¿Modelo más caro cuando uno más barato alcanza?
   **Eje 5 — Performance**: ¿N+1 queries? ¿Síncrono que podría ser async? ¿Data que no se usa cargándose?
   **Eje 6 — Mantenibilidad**: ¿Nombre describe lo que hace? ¿Magic numbers? ¿Código en el lugar correcto? ¿Otra persona podría entender en 5 min?
   **Eje 7 — Tests**: ¿Cada rama nueva tiene test? ¿Cubren happy path Y edge cases? ¿Deterministas (no flaky)? ¿Test de regresión para el bug que se arregla?

3. **Para cada hallazgo**:

```
ARCHIVO: <file>:<línea>
EJE: <1-7>
SEVERIDAD: [BLOQUEANTE | MAYOR | MENOR | NIT | PRAISE]
HALLAZGO: <1 línea, concreto>
SUGERENCIA: <cómo arreglarlo>
```

4. **Devolver**:

```
RESUMEN: <1 línea — aprobar / pedir cambios / comentar>

BLOQUEANTES (no se puede mergear): ...
MAYORES (sí o sí antes de cerrar el sprint): ...
MENORES (este sprint o el próximo): ...
NITS (cuando se toque el archivo de nuevo): ...
PRAISE (bien hecho): ...

DECISIÓN SUGERIDA: APPROVE | REQUEST CHANGES | COMMENT
```

## References (leer desde Mavis original)

- `C:\Users\acer\.mavis\agents\wozniak\skills\code-review-multi-axis\references\review-checklist.md` — lista de chequeo expandida por eje
- `…\references\example-findings.md` — ejemplos de hallazgos buenos vs malos

## Anti-patrones

- "Se ve bien" sin haber revisado de verdad. Decir qué se revisó.
- Mezclar "no me gusta el estilo" con "esto rompe una invariante". Separar.
- Sugerir cambios que agregan complejidad sin reducirla. El código simple gana.
- Aprobar porque "el sprint ya está largo". La deuda se paga.
- Pedir cambios cosméticos como bloqueantes. Los cosméticos van en NIT.

## Salida esperada

Una revisión accionable, con severidad clara. El autor del código debe saber exactamente qué arreglar y por qué. Si el código está bien, decirlo y aprobar rápido — no inventar hallazgos para justificar la revisión.
