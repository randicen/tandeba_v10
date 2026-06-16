---
name: tech-debt-audit
description: Auditoría sistemática del código de Worgena para mapear deuda técnica por categoría, severidad y costo de pago. Cargar cuando el founder pida "auditoría el código", "qué deuda tenemos?", al cierre de cada sprint grande, o antes de tomar features grandes que tocan código viejo.
---

# tech-debt-audit

> Skill portada desde Mavis. Original: `C:\Users\acer\.mavis\agents\wozniak\skills\tech-debt-audit\SKILL.md`. Las `references/` viven en el original.

Auditoría sistemática del código de Worgena para mapear deuda técnica por categoría, severidad y costo de pago.

## Cuándo cargar esta skill

- "Auditoría el código"
- "¿Qué deuda tenemos?"
- Al cierre de cada sprint grande (D2, D3, D4...) para tener un snapshot
- Antes de tomar features grandes que tocan código viejo

## Procedimiento

1. **Recorrer las 7 categorías de deuda**. Por cada una, identificar instancias concretas con `file_path:line_number`:

   **1. Idempotencia**: ¿qué pasa si la misma operación corre 2 veces? ¿Hay un test?
   **2. Versionado**: ¿lo que se persiste tiene `version` o `schema_version`? ¿Las migraciones son reversibles?
   **3. Blast radius**: si esto falla, ¿a cuántos tenants/rows/runs afecta? ¿Está acotado?
   **4. Observabilidad**: cuando algo falla, ¿se sabe qué? ¿Hay logs estructurados con trace_id, tenant_id, agent_id?
   **5. Estado distribuido**: ¿hay estado en 2+ lugares que se puede desincronizar?
   **6. Lock-in evitable**: ¿usamos una librería/servicio que se podría reemplazar con código propio de 200 LoC?
   **7. Test gaps**: ¿qué caminos de código NO tienen test? ¿Cuál es la probabilidad de romperse?

2. **Para cada hallazgo**, registrar:

```
ID: TD-<número>
Severidad: [BLOQUEANTE | MAYOR | MENOR | NIT]
Categoría: [1-7]
Archivo: <file_path>:<line>
Descripción: <1 línea>
Costo de pago: <horas estimadas>
Riesgo si no se paga: <qué se rompe>
```

3. **Priorizar** por la fórmula: `prioridad = (severidad * 3) + (categoría 1-2-3 pesa doble) + costo_inverso`. No se paga primero lo más rápido. Se paga primero lo que bloquea o rompe.

4. **Devolver**:
   - Tabla de hallazgos priorizados
   - Resumen ejecutivo (3-5 bullets)
   - Sprint sugerido para pagar los críticos (los que tocan Capa 1)

## References (leer desde Mavis original)

- `C:\Users\acer\.mavis\agents\wozniak\skills\tech-debt-audit\references\debt-categories.md` — detalle de las 7 categorías con ejemplos en Worgena
- `…\references\refactor-prioritization.md` — heurísticas para ordenar el pago

## Anti-patrones

- Auditar solo lo que el auditor conoce. Recorrer todo el código, no solo el módulo bajo cambio.
- Pagar primero lo más rápido. Pagar primero lo más crítico.
- Mezclar categorías (ej: "falta observabilidad y también hay un bug" → separar en 2 hallazgos).

## Salida esperada

Una tabla priorizada + un sprint sugerido. Si no hay hallazgos críticos, decirlo y pasar a MENOR/NIT. Si hay un BLOQUEANTE, levantarlo inmediatamente.
