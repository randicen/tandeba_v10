---
name: database-decisions
description: Toma decisiones sobre modelo de datos, schema, migraciones, y estrategia de storage multi-tenant. Carga esta skill cuando el founder pida evaluar "¿SQLite o Postgres?", "¿row-level vs schema-per-tenant?", "¿cómo reverso este cambio de schema?", o cualquier decisión que toque persistencia y aislamiento por tenant.
---

# Database Decisions

> Skill portada desde Mavis. Original: `C:\Users\acer\.mavis\agents\wozniak\skills\database-decisions\SKILL.md`. Las `references/` viven en el original.

Decisiones sobre modelo de datos, schema, migraciones, y storage multi-tenant. Esta skill existe porque **las decisiones de DB son las más caras de revertir en SaaS multi-tenant**. Un cambio de schema mal hecho puede borrar data de producción; un cambio de estrategia de aislamiento (de row-level a DB-per-tenant) es prácticamente imposible sin downtime.

Worgena hoy usa **SQLite** con row-level isolation (`tenant_id` en todo row). Esta skill NO asume que eso es permanente — es la posición actual y puede cambiar.

## Cuándo cargar esta skill

- "¿SQLite aguanta para Worgena o hay que migrar a Postgres?"
- "¿Row-level vs schema-per-tenant vs DB-per-tenant?"
- "¿Cómo reverso este cambio de schema?"
- "¿Cuándo normalizo y cuándo desnormalizo?"
- "¿Vale la pena sharding ya?"
- "¿Cómo testeo que una migración sea idempotente y no rompa data?"
- "¿Qué hace Worgena cuando SQLite da 'database is locked'?"

## Procedimiento

1. **Leer el contexto de Worgena**: `AGENT_ROADMAP.md`, `HANDOFF.md`, `AUDIT_D*.md`, el schema actual (no abrir el archivo, leer el código de migrations en `src/`), el ADR o propuesta bajo revisión.
2. **Identificar el blast radius**: ¿A cuántos tenants afecta? ¿Cuánto tarda en revertirse? ¿Hay downtime o se puede hacer online?
3. **Evaluar las opciones reales** (no ficticias). Para cada una: costo de implementación, costo operacional continuo, lock-in, costo de revertir, compliance con Habeas Data.
4. **Recomendar una**, con razones.
5. **Definir el plan de rollback** antes de implementar. Si la decisión es irreversible, decir "no la tomes todavía" o proponer mitigaciones.
6. **Devolver**:

```
DECISIÓN: [elegida]
ALTERNATIVAS EVALUADAS: [lista con 1 línea cada una]

Costo de implementación: Xh
Costo operacional: X/mes
Tiempo de reversión si falla: X
Downtime requerido: sí/no, cuánto

Riesgos:
- [riesgo 1] → mitigación

Plan de rollback:
1. [paso 1]
2. [paso 2]

Si toca invariante dura (motor propio, 3 capas, versionado): ADR nuevo requerido.
```

## Decisiones que esta skill cubre

### Aislamiento por tenant

- **Row-level** (actual en Worgena): `tenant_id` en cada row, queries filtradas, enforcement por código. Barato, flexible, riesgo de error humano.
- **Schema-per-tenant**: más aislamiento, más complejidad de ORM y migrations.
- **DB-per-tenant**: aislamiento máximo, costo operacional alto.
- **Híbrido**: para clientes enterprise con datos sensibles.

### Versionado de schema

- Migrations idempotentes con prefijo timestamp.
- Schema versionado en runtime (cada row tiene `schema_version`).
- Dual-write (escribir nuevo formato, leer ambos, migrar async).
- Expand-contract (agregar columna nueva → escribir en ambas → migrar reads → eliminar vieja).

### Reversibilidad

Cada cambio se clasifica:
- **Trivialmente reversible** (agregar columna nullable, índice): rollback = drop.
- **Reversible con cuidado** (agregar NOT NULL, rename, drop index): requiere script de rollback testeado.
- **Irreversible** (drop column, change type, drop table): NO hacer sin backup verificado y dry-run.
- **Destructiva pero con ventana** (truncate, mass update): feature flag + rollback documentado.

Esta skill NO aprueba cambios irreversibles sin ratificación explícita del founder.

## Multi-tenant: consideraciones específicas

Worgena maneja datos confidenciales de clientes de abogados. Por Habeas Data y por compliance enterprise:

- **Cifrado en reposo**: SQLite no lo hace nativamente. Si aplica, sqlcipher o capa externa.
- **Cifrado en tránsito**: TLS en el HTTP server, no relevante para el schema.
- **Backups por tenant**: si DB-per-tenant, cada backup es por cliente. Si row-level, un backup global sirve.
- **Borrado por solicitud (Habeas Data)**: debe ser posible eliminar TODO lo de un tenant sin tocar otros. Row-level → DELETE WHERE tenant_id. DB-per-tenant → DROP DATABASE.
- **Auditoría de accesos**: cada query que toca data de un tenant debería loguear quién y por qué.

## Anti-patrones que esta skill detecta

- "Después migramos a Postgres" → RECHAZAR. Migrar Postgres con data en producción es sprint serio.
- "Hagamos DB-per-tenant desde el día 1" → RECHAZAR. Costo operacional enorme sin justificación.
- "Borramos la columna vieja, total no la usa nadie" → AJUSTAR. Verificar 0 referencias antes. Y tener backup.
- "Cambio TEXT a INTEGER, debe ser rápido" → AJUSTAR. SQLite lo permite pero requiere validación.
- "Normalizo todo" → AJUSTAR. El 80% de los reads están en el 20% de las tablas.
- "Sharding ya porque hay 10 firmas" → RECHAZAR. Sharding es para millones de filas, no 10.

## References (leer desde Mavis original)

- `C:\Users\acer\.mavis\agents\wozniak\skills\database-decisions\references\multi-tenant-storage-patterns.md` — análisis row-level vs schema-per-tenant vs DB-per-tenant
- `…\references\migration-checklist.md` — checklist pre-flight para migraciones
- `…\references\sqlite-postgres-tradeoffs.md` — cuándo SQLite alcanza y cuándo Postgres es inevitable

## Salida esperada

Veredicto sobre la decisión de DB propuesta, con costo, tiempo de implementación, tiempo de reversión, plan de rollback explícito. ADR nuevo requerido si toca invariante dura.
