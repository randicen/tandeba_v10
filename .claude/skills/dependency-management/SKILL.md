---
name: dependency-management
description: Ongoing management de dependencias de Worgena: cuándo upgradear, cómo auditar CVEs, cómo eliminar deps no usadas, conflictos de versiones, lockfile policy, reproducible builds. Cargar trimestralmente para una auditoría, o cuando se detecte un CVE crítico en una dep.
---

# Dependency Management

> Skill portada desde Mavis. Original: `C:\Users\acer\.mavis\agents\wozniak\skills\dependency-management\SKILL.md`. Las `references/` viven en el original.

Las dependencias son riesgo de seguridad y mantenimiento. Una dep no actualizada puede tener CVEs conocidos. Una dep sin uso es código muerto. Un conflicto de versiones rompe builds. Esta skill cubre el **mantenimiento continuo** de las deps, no la decisión de agregar una nueva (eso es `stack-decision`).

## Cuándo cargar esta skill

- Trimestralmente, para una auditoría de deps.
- Cuando se publica un CVE crítico en una dep que Worgena usa.
- Cuando se va a hacer un upgrade mayor (breaking change probable).
- Cuando `npm audit` reporta vulnerabilidades.
- Antes de un release mayor.

## Procedimiento

1. **Inventariar** las deps y sus versiones actuales.
2. **Auditar** CVEs conocidos y severidad.
3. **Evaluar** upgrades pendientes (patch: seguro, minor: leer changelog, major: refactor + test exhaustivo).
4. **Decidir** qué upgradear y qué no.
5. **Aplicar** upgrades con tests después de cada uno.
6. **Documentar** qué se cambió y por qué.

## Categorías de deps

### Producción (runtime)
Las que el código importa directamente. Críticas. Ejemplo en Worgena: `better-sqlite3`, `react`, `openai` (también usado por OpenRouter-compatible), modelos LLM via OpenRouter (no son deps npm).

### Desarrollo (devDependencies)
Solo build, test, lint. No afectan producción pero sí el workflow. `typescript`, `vitest`/`jest`, `eslint`, `prettier`, `@types/*`.

### Transitivas
Las heredadas de otras deps. El lockfile las incluye. Hay que auditarlas también.

## Cuándo upgradear

### Patch (X.Y.Z → X.Y.Z+1)
- **Cuándo**: lo antes posible, especialmente si es security fix.
- **Riesgo**: bajo. Backwards compatible por semver.
- **Tiempo**: minutos.

### Minor (X.Y.Z → X.Y+1.Z)
- **Cuándo**: cuando el feature es deseable, o cuando se acumulan 3+ minor versions.
- **Riesgo**: bajo a medio.
- **Tiempo**: horas.

### Major (X.Y.Z → X+1.0.0)
- **Cuándo**: cuando el feature es crítico, o cuando se va a discontinuar la actual.
- **Riesgo**: alto.
- **Tiempo**: días a semanas.

## Cuándo eliminar

- Deps no usadas (no aparecen en `import`).
- Deps reemplazables por funcionalidad estándar.
- Deps con替代 maduro.
- Deps abandonadas (sin releases hace 1+ año).

Para detectar: `npx depcheck` o `npx knip`. Manual: `grep -r "from 'package'" src/`.

## CVEs y seguridad

### Cómo auditar
- `npm audit` (built-in, base de GitHub Advisory).
- `npm audit --production`.
- `snyk test` (más completa, plan gratis).

### Cómo priorizar

| Severidad (CVSS) | Acción |
|---|---|
| 9.0-10.0 (Critical) | Upgrade inmediato, sprint dedicado si necesario |
| 7.0-8.9 (High) | Upgrade próximo sprint, P0 |
| 4.0-6.9 (Medium) | Backlog, sprint de mantenimiento |
| 0.1-3.9 (Low) | Backlog, no urgente |

### Cómo upgradear un dep con CVE
1. Verificar el fix: leer advisory.
2. Verificar compatibilidad con Node version.
3. `npm install package@^X.Y.Z`.
4. Correr suite completa de tests.
5. Smoke test manual en dev.
6. Patch release inmediato.
7. Notificar si el cliente fue afectado.

## Lockfile policy

- **Siempre commitear** el lockfile al repo.
- **Nunca** borrar el lockfile manualmente.
- **Nunca** editar a mano. Solo `npm install` lo modifica.
- **Regenerar** (`rm package-lock.json && npm install`) solo si hay conflicto irresoluble.

### Conflictos
1. Pull el más reciente.
2. `rm -rf node_modules && npm install`.
3. Si persiste, mergear manualmente los `package.json`.
4. `npm install` regenera el lockfile.

## Licencias incompatibles

Cada dep tiene licencia. Auditar que todas sean compatibles:
- **MIT, Apache 2.0, BSD**: OK, permissive.
- **LGPL**: OK con cuidado, requiere que el consumidor pueda reemplazar la lib.
- **GPL**: complicado, requiere開示 del código.
- **AGPL**: problemático para SaaS (Network Use es distribución).
- **Custom / Unknown**: investigar.

Worgena, como SaaS, debe evitar AGPL. Herramienta: `npx license-checker`.

## Deps innecesarias (overhead)

Cada dep suma bundle size, install time, security surface, mantenimiento. Antes de agregar, preguntar:
- ¿Realmente la necesitamos o son 20 líneas propias?
- ¿La dep tiene >10K stars?
- ¿Se mantiene activamente (último release <6 meses)?
- ¿Tiene tests propios?
- ¿Cuál es el bundle size (si es frontend)?

Regla: si el feature es <50 LoC, no agregar dep. Si es >50, evaluar dep vs implementación.

## Reproducible builds

Para garantizar: commit `package-lock.json`, no usar `^` en versiones críticas, o usar `--save-exact` o pnpm.

Por defecto, Worgena puede usar `^` para flexibilidad y aceptar que el lockfile se actualiza con cada `npm install`.

## Trimestral: la auditoría

1. `npm list --depth=0` para deps directas.
2. `npm audit` o Snyk.
3. `npm outdated`.
4. `npx depcheck` o `npx knip`.
5. `npx license-checker --onlyAllow 'MIT;Apache-2.0;BSD-3-Clause'`.
6. Output: lista priorizada de acciones.
7. Asignar: cada acción con owner y sprint objetivo.

## Anti-patrones

- `npm install <package>` sin revisar.
- Ignorar `npm audit`.
- Major upgrade sin planning.
- Deps para todo.
- Lockfile en .gitignore (nunca).
- No commitear cambios de lockfile en PRs.

## References (leer desde Mavis original)

- `C:\Users\acer\.mavis\agents\wozniak\skills\dependency-management\references\cve-response-procedure.md`

## Salida esperada

Plan de mantenimiento de deps: inventario actual, CVEs priorizados, upgrades pendientes, deps a eliminar, reporte trimestral con acciones y owners.
