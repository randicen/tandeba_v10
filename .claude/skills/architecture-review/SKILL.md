---
name: architecture-review
description: Revisa una decisión arquitectónica propuesta contra las invariantes vigentes de Worgena y devuelve un veredicto (APROBAR / AJUSTAR / RECHAZAR) con razones concretas. Cargar cuando el founder pida "¿está bien esta decisión de arquitectura?" o antes de cerrar un sprint que toca el motor.
---

# architecture-review

> Skill portada desde Mavis. Original: `C:\Users\acer\.mavis\agents\wozniak\skills\architecture-review\SKILL.md`. Las `references/` viven en el original.

Revisa una decisión arquitectónica propuesta contra las invariantes vigentes de Worgena y devuelve un veredicto: APROBAR / AJUSTAR / RECHAZAR, con razones concretas.

## Cuándo cargar esta skill

- "Revisá esta decisión de arquitectura"
- "¿Está bien que hagamos X?"
- Antes de cerrar un sprint que toca el motor
- Cuando el founder humano pide second opinion sobre un cambio grande

## Procedimiento

1. **Leer toda la documentación técnica o visión de producto disponible** del proyecto en `C:\Users\acer\Downloads\asistente IA\untitled\`. Esto incluye (sin estar limitado a):
   - `AGENTS.md` del proyecto
   - `AGENT_ROADMAP.md`, `HANDOFF.md`, `ARCHITECTURE.md`, `PLATFORM_VISION.md`
   - Specs de sprint (`AGENT_D*_SPEC.md`)
   - Auditorías previas (`AUDIT_*.md`)
   - Documentación en `recursos/`
   - El ADR o propuesta de cambio bajo revisión
   - El código relevante en `src/` si la decisión lo toca

   No hay una lista fija de documentos obligatorios. El agente decide cuáles son relevantes según el tipo de decisión bajo revisión.
2. **Identificar invariantes vigentes** que aplican:
   - [ ] ¿Respeta las 3 capas (workflow engine / intake router / specialist agents)?
   - [ ] ¿El motor sigue siendo propio (no LangGraph/n8n/Temporal)?
   - [ ] ¿Lo que se persiste tiene versionado de esquema?
   - [ ] ¿Es multi-tenant safe? (tenant_id en todo row, sin global keys)
   - [ ] ¿El blast radius está acotado? (un tenant no puede romper a otro)
   - [ ] ¿La decisión es reversible? Si no, ¿qué se hace si falla?
3. **Evaluar costo y latencia**:
   - Tokens por run estimado
   - Latencia agregada (p95)
   - Costo en USD por 1k runs
   - Comparar contra la opción status quo
4. **Evaluar deuda técnica**:
   - ¿Agrega una nueva dependencia externa? (lock-in)
   - ¿Abre una nueva categoría de estado a sincronizar?
   - ¿Hay un test que pruebe que NO se rompe algo existente?
5. **Devolver veredicto**:

```
VEREDICTO: [APROBAR | AJUSTAR | RECHAZAR]

Invariantes respetadas: [lista]
Invariantes violadas: [lista o "ninguna"]

Trade-offs:
- Gana: ...
- Pierde: ...

Costo por run estimado: $X
Latencia p95 estimada: Xms
Riesgo principal: ...

Si AJUSTAR: cambios mínimos para aprobar
Si RECHAZAR: por qué y qué alternativa explorar
```

## References (leer desde Mavis original)

- `C:\Users\acer\.mavis\agents\wozniak\skills\architecture-review\references\three-layer-architecture.md` — la separación Capa 1/2/3 vigente y por qué
- `…\references\agent-cards-a2a.md` — el formato A2A de Google que se adoptó
- `…\references\cost-attribution-pattern.md` — cómo se atribuye costo por run, por agente, por tenant
- `…\references\schema-versioning.md` — convención de versionado de schemas persistidos

## Anti-patrones que esta skill detecta

- "Es más rápido con X framework" → RECHAZAR sin discutir. Motor propio.
- "Lo conectamos al servicio Y que ya tenemos" → AJUSTAR si Y no fue evaluado por stack-decision.
- "Después lo aislamos por tenant" → RECHAZAR. Multi-tenant es desde el día 1, no retrofit.
- "Lo probamos en producción con un flag" → AJUSTAR si el blast radius toca data de tenants. No, si toca solo config.

## Salida esperada

Una respuesta con el veredicto, las invariantes tocadas, y la lista de ajustes. Sin rodeos. Si el cambio es trivial y no toca invariantes, decirlo y aprobar rápido.
