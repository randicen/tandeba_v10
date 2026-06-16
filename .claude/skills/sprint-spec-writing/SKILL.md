---
name: sprint-spec-writing
description: Genera el spec de un trabajo de Worgena — sprint del roadmap, investigación, migración, refactor, spike, integración externa, experimento. Cargar cuando el founder pida "escribí el spec del sprint X" o cualquier plan escrito antes de codear.
---

# sprint-spec-writing

> Skill portada desde Mavis. Original: `C:\Users\acer\.mavis\agents\wozniak\skills\sprint-spec-writing\SKILL.md`. Las `references/` viven en el original.

Genera el spec de un trabajo de Worgena. No está limitado a sprints del roadmap `AGENT_D*` — puede ser cualquier trabajo que requiera un spec antes de ejecutar. Scope acotado, no-objetivos explícitos, primitivas claras, tests definidos cuando aplique.

## Cuándo cargar esta skill

- "Escribí el spec del sprint X"
- "Necesito planear el sprint que hace Y"
- "Armá el spec del próximo item del roadmap"
- "Escribí el spec para la migración a Postgres"
- "Necesito un spec para decidir entre X e Y"
- Cualquier trabajo que requiera un plan escrito antes de codear

## Procedimiento

1. **Leer toda la documentación técnica o visión de producto disponible** del proyecto en `C:\Users\acer\Downloads\asistente IA\untitled\`. El agente decide cuáles son relevantes según el tipo de spec. Si es un spec de pricing research, no hace falta leer el código del motor. Si toca el motor, sí.
2. **Identificar inputs**: ¿Qué pide el founder? ¿Qué dependencias tiene este trabajo de otros sprints? ¿Qué bloquea si no se hace? ¿Restricciones de tiempo, presupuesto, compliance?
3. **Escribir el spec** con esta estructura (template vigente):

```markdown
# D<nivel> — <nombre> Spec

> Sprint # de la dimensión <D>. Cierra: <qué ítem del roadmap>. Spec vivo: se actualiza durante implementación.

## 1. Contexto
<2-4 oraciones. Por qué este sprint existe AHORA. Qué habilita. Qué bloquea si no se hace.>

## 2. Objetivos (qué SÍ se hace)
- O1. <objetivo medible>
- O2. ...

## 3. No-objetivos (qué NO se hace)
> Crítico. Esta sección es lo que evita scope creep. Todo lo que no esté en §2 es NO-objetivo.
- NO-1. <feature que se podría confundir con el sprint>
- NO-2. ...

## 4. Primitivas no negociables
> Estas son las que NO se skipean aunque "lleven tiempo".
- P1. <ej: idempotencia de nodos>
- P2. <ej: schema versioning>
- P3. <ej: sub-sesión de verifier>

## 5. Diseño (alto nivel)
<Diagrama ASCII o descripción de la solución. 1-2 páginas máximo.>

## 6. Archivos a tocar / crear
| Archivo | Acción | Razón |
|---|---|---|
| `src/agent/...` | crear | <razón> |

## 7. Tests
- <cantidad> tests nuevos en `<archivo>`
- Cubren: <lista de casos>
- Regression: <qué se chequea que sigue funcionando>

## 8. Riesgos
| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|

## 9. Orden de ejecución
> Por FUNDAMENTO, no por velocidad de feedback. Primitivas primero, optimizaciones después.
1. <paso 1>
2. <paso 2>

## 10. Definition of Done
- [ ] Todos los objetivos de §2 implementados
- [ ] Cero objetivo de §3 implementado
- [ ] Primitivas de §4 todas en el código
- [ ] Tests de §7 pasando
- [ ] `tsc` limpio
- [ ] AGENT_ROADMAP.md actualizado si hubo cambio arquitectónico
- [ ] HANDOFF.md actualizado al cierre
- [ ] Spec vivo actualizado si hubo desvío
```

4. **Revisión cruzada**: ¿Scope realista para 1-3 días? ¿No-objetivos bien marcados? ¿Primitivas correctas? ¿Orden con fundamento o "lo más rápido primero"?
5. **Devolver** el spec listo para commit. Si el founder ya lo escribió a mano, mejorarlo, no reescribirlo desde cero sin pedir.

## References (leer desde Mavis original)

- `C:\Users\acer\.mavis\agents\wozniak\skills\sprint-spec-writing\references\spec-template.md` — el template exacto vigente
- `…\references\scope-cutting-guide.md` — heurísticas para decir NO y mantener el sprint corto

## Anti-patrones

- Spec de 30 páginas. Spec corto, vivo, actualizado.
- "Después definimos los no-objetivos". NO. Van en §3 desde el día 1.
- Mezclar primitivas con optimizaciones. Las primitivas son no negociables.
- Orden de ejecución por velocidad. Orden por dependencia y fundamento.

## Salida esperada

Un archivo `.md` con el spec completo. Nomenclatura:
- Sprint del roadmap: `AGENT_Dx_<nombre>_SPEC.md`
- Otro tipo de trabajo: nombre descriptivo en `kebab-case`, guardado en la raíz de `untitled/` o subcarpeta temática.

Si hay secciones que no aplican, marcar "N/A" con razón, no omitir.
