# D3.4 — Auth Real con Better Auth (Sprint Spec) — SUPERSEDED

> ⚠️ **SUPERSEDED-BY `AGENT_D3_4_REDESIGN_SPRINT_SPEC.md` (2026-06-25).**
>
> Este sprint spec implementó D3.4 con el patrón **single-user-per-firm** (cada user auto-crea su propio `tenant-${UUID}`). Ese modelo NO matchea la visión SaaS multi-user-firm de Worgena (ver `AGENT_ROADMAP.md` §5.16 y `AGENTS.md` §8-14).
>
> El rediseño correcto está en `AGENT_D3_4_REDESIGN_SPRINT_SPEC.md`. Mismo code path para todos los users, con onboarding explícito donde el user elige "crear firma" o "unirse con invite". Anti-patrón evitado: NO auto-asumimos firm para el primer user.
>
> Este archivo se mantiene para historial. NO implementar desde acá.

> **Sprint**: D3.4 de la dimensión 3.
> **Spec vivo**: este documento. Se actualiza durante implementación si se descubre scope que falta.
> **Spec de diseño** (referencia, ya commiteado en `AGENT_D3_4_5_DB_AUTH_SPEC.md`): contiene las 12 decisiones de diseño, sketch de código, plan de tests detallado y forward-compat. Este sprint spec agrega: contexto, criterios de aceptación, orden de ejecución y Definition of Done.

## 1. Contexto

D3.1-D3.3 cerraron multi-tenant enforcement (PK compuesto, `MissingTenantIdError`, isolation tests) y la interface `AuthProvider` con un stub `StaticTenantProvider`. Lo que falta es **auth real de usuario**: hoy cualquier HTTP caller puede pasar `tenantId` en el body y el motor ejecuta sin validar que corresponda a un user autenticado. Esto es **P0 #1 del BACKLOG** (spoofing cross-tenant).

D3.4 enchufa Google OAuth end-to-end con datos del user en SQLite (mismo `worgena.db`), vía Better Auth como librería. D3.5 endurece con 2FA TOTP, `audit_auth` persistente y `SECURITY.md`.

**Bloquea**: D4 (memoria 4 capas sin scope por user es deuda), D5 (RAG por tenant), pricing por uso (BACKLOG P0 §3).

**Bloqueado por**: D3.1 + D3.2 + D3.3 cerrados (✓). `AuthProvider` interface existe (✓). `worgena.db` con migraciones idempotentes (✓). Express server `server.ts` con `dotenv` (✓).

## 2. Objetivos (qué SÍ se hace)

- **O1**. Login con Google OAuth funciona end-to-end en `localhost` (botón → callback → session cookie → redirect a app).
- **O2**. `authMiddleware` en `server.ts` rechaza con `401` cualquier request a `/api/*` (excepto `/api/auth/*`) sin session cookie válida.
- **O3**. `DbAuthProvider` implementa `AuthProvider` interface, lee `tenantId` del `req.user.default_tenant_id`, lanza error claro si se invoca sin auth.
- **O4**. `helmet()` activo globalmente con CSP estricta (allowlist explícito para `accounts.google.com`).
- **O5**. `express-rate-limit` en `/api/auth/*`: 30 requests / 5 min por IP.
- **O6**. Migraciones idempotentes de tablas `auth_*` (mismo patrón que D3.1 `runPersistenceMigrations`).
- **O7**. Página `/login` mínima: HTML + JS con botón "Continuar con Google".
- **O8**. Variables de entorno documentadas en `.env.example`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`.
- **O9**. **24 tests E2E nuevos** en `test_auth_d3_4.mts` (bloques A-G según design spec §7).
- **O10**. **Cero regresión** en tests D1-D3.3 (354 tests acumulados).
- **O11**. `HANDOFF.md` y `AGENT_ROADMAP.md` actualizados al cierre.

## 3. No-objetivos (qué NO se hace — anti-scope-creep)

> Crítico. Todo lo que NO esté en §2 es NO-objetivo.

- **NO-1**. 2FA TOTP — es D3.5.
- **NO-2**. Tabla `audit_auth` persistente — D3.5 (en D3.4 los eventos de auth van a `stdout`).
- **NO-3**. `SECURITY.md` doc — D3.5.
- **NO-4**. SSO/SAML, magic links, password login — D3.6+ cuando llegue la demanda.
- **NO-5**. Multi-tenant user pool (1 user en N firmas) — D6.
- **NO-6**. Branding de la pantalla de login — minimalista en D3.4, se pule en D6 con el editor.
- **NO-7**. Cron sweeper automático del sweeper de D3.3 — sigue corriendo solo en startup.
- **NO-8**. Scrub de secretos en `step_logs` (BACKLOG P0 §1) — sprint separado después de D3.5.
- **NO-9**. Cost attribution por tenant (BACKLOG P0 §3) — sprint separado después de D3.5.
- **NO-10**. Migración a Postgres — sigue en SQLite; Better Auth ya tiene adapter Postgres oficial para cuando llegue D4+.
- **NO-11**. Frontend de `/settings/security` — D3.5.
- **NO-12**. Tests de carga / stress del auth flow — fuera de scope MVP.

## 4. Primitivas no negociables

> Estas son las que NO se skipean aunque "lleven tiempo". Si se skipean, el motor pasa de demo a deuda.

- **P1. Migraciones idempotentes**. Las tablas `auth_*` se crean con `CREATE TABLE IF NOT EXISTS`. Si el schema cambió (forward-compat), falla loud con mensaje accionable. Mismo patrón que `runPersistenceMigrations` de D3.1.
- **P2. `tenantId` viene de la session validada, NO del body**. El `DbAuthProvider.getTenantId()` lee `req.user.default_tenant_id` que el middleware inyectó. Cualquier intento del caller de meter `tenantId` en el body es ignorado para auth.
- **P3. Defense in depth: helmet + rate limit + CSP + HttpOnly + Secure + SameSite**. Si falta cualquiera, no es producción-ready. El spec los tiene como bloque (no se puede mergear D3.4 con helmet pero sin rate limit).
- **P4. Tests E2E sin dependencia de Google real**. Better Auth permite mockear el callback con `idToken` (ver doc oficial). Los tests NO pegan a Google en CI.
- **P5. Lock-in bajo a Better Auth**. Si migramos en D3.6+, solo cambia `src/lib/auth/*` y middleware de `server.ts`. El motor no se entera.
- **P6. Backward-compat con `StaticTenantProvider`**. Los tests D3.3 que usan `StaticTenantProvider` siguen pasando sin cambios. El provider stub convive con `DbAuthProvider`.

## 5. Diseño (alto nivel)

Referencia: design spec `AGENT_D3_4_5_DB_AUTH_SPEC.md` §3 (arquitectura de 4 capas).

```
┌─────────────────────────────────────────────────────────────────┐
│  Capa 4: Frontend (Vite/React existente)                         │
│  - /login: botón "Continuar con Google" (HTML mínimo)            │
└─────────────────────────────────────────────────────────────────┘
                             ↕ HTTPS + cookies HttpOnly Secure
┌─────────────────────────────────────────────────────────────────┐
│  Capa 3: server.ts middleware (Express)                         │
│  - helmet() global (CSP estricta)                                │
│  - express-rate-limit en /api/auth/*                             │
│  - authMiddleware en /api/* (excepto /api/auth/* público)        │
│  - Inyecta req.user = { id, email, default_tenant_id }           │
│  - DbAuthProvider(req).getTenantId() → tenantId validado         │
└─────────────────────────────────────────────────────────────────┘
                             ↕
┌─────────────────────────────────────────────────────────────────┐
│  Capa 2: src/lib/auth/* (Better Auth librería)                  │
│  - auth.ts: betterAuth({ database, secret, socialProviders })    │
│  - handlers.ts: monta /api/auth/* (sign-in, callback, sign-out)  │
└─────────────────────────────────────────────────────────────────┘
                             ↕
┌─────────────────────────────────────────────────────────────────┐
│  Capa 1: SQLite (worgena.db)                                    │
│  - auth_user, auth_session, auth_account, auth_verification      │
│  - Tablas existentes del motor: paused_tasks, workflow_audit,    │
│    sessions (D1), spaces, messages, step_logs, ...               │
└─────────────────────────────────────────────────────────────────┘
                             ↕
┌─────────────────────────────────────────────────────────────────┐
│  Capa 0: WorkflowEngine (src/agent/workflow-engine/)             │
│  - startTask(wf, input, options.tenantId) usa DbAuthProvider     │
│  - persistCheckpoint() usa task.tenantId (D3.2 enforzado)        │
└─────────────────────────────────────────────────────────────────┘
```

**Decisiones clave** (referencia: design spec §2):
- Better Auth 1.x (librería, no servicio). Lock-in bajo.
- Misma SQLite `worgena.db` con prefijo `auth_*` para evitar colisión con `sessions` de D1.
- Google OAuth ONLY en D3.4 (no password, no magic link).
- `tenantId` derivado de `default_tenant_id` en `auth_user` (columna nueva agregada vía Better Auth `additionalFields`).
- `AuthProvider` interface sync (compatible con `StaticTenantProvider` existente).

## 6. Archivos a tocar / crear

| Archivo | Acción | Razón |
|---|---|---|
| `package.json` | modificar | Agregar `better-auth`, `express-rate-limit`, `helmet` |
| `src/lib/auth/auth.ts` | crear | Instancia `betterAuth()` con config (DB, secret, providers) |
| `src/lib/auth/handlers.ts` | crear | `authHandler` Express que delega a `auth.handler` |
| `src/lib/db.ts` | modificar | `migrateAuthTables()` idempotente (CREATE TABLE IF NOT EXISTS) |
| `src/agent/workflow-engine/persistence/db-auth-provider.ts` | crear | `DbAuthProvider implements AuthProvider` |
| `src/agent/workflow-engine/persistence/index.ts` | modificar | Re-export `DbAuthProvider` |
| `server.ts` | modificar | `helmet()`, `rateLimit()`, `authMiddleware()`, montar `/api/auth/*` |
| `public/login.html` | crear | Botón "Continuar con Google" mínimo |
| `.env.example` | modificar | Documentar vars nuevas |
| `test_auth_d3_4.mts` | crear | 24 tests E2E (bloques A-G) |
| `AGENT_ROADMAP.md` | modificar | Marcar D3.4 cerrado, próximo sprint D3.5 |
| `HANDOFF.md` | modificar | Log del sprint cerrado |

## 7. Tests

**24 tests nuevos** en `test_auth_d3_4.mts`, distribuidos:

| Bloque | Tests | Cubre |
|---|---|---|
| A: Schema | 3 | Tablas `auth_user`, `auth_session`, `auth_account`, `audit_auth` existen con columnas correctas (verificable con `PRAGMA table_info`). |
| B: OAuth flow | 5 | Better Auth puede sign-in con Google mock. Crea user. Crea session. Retorna cookie. Logout invalida session. |
| C: Middleware | 4 | Request sin cookie → 401. Cookie inválida → 401. Cookie válida → inyecta `req.user`. `/api/auth/*` no requiere auth. |
| D: DbAuthProvider | 3 | Lee `default_tenant_id` correcto. Lanza si no hay `req.user`. Multi-request lee el de cada request. |
| E: Rate limit | 3 | 30 requests en 5min OK. Request 31 → 429. Reset después de 5min. |
| F: Security headers | 3 | `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` presentes. |
| G: E2E | 3 | Login → POST /api/sessions (con `req.user.id`) → 200. Sin login → POST /api/sessions → 401. Logout → POST /api/sessions → 401. |

**Regression**: 354 tests acumulados (D1 + D2a + D2b + D2c + D3.1 + D3.2 + D3.3) deben seguir pasando.

**Estrategia**: Better Auth permite mockear el callback con `idToken` (visto en doc oficial `https://www.better-auth.com/docs/authentication/google`). Los tests E2E usan este mecanismo para no depender de Google en CI.

## 8. Riesgos

| # | Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|---|
| 1 | Better Auth cambia API entre versiones | Baja | Alto | Pin a 1.x con `package.json` exact version. Test E2E detecta rotura. Si rompe, fix local + PR upstream. |
| 2 | Google OAuth redirect_uri_mismatch en prod | Media | Alto | `BETTER_AUTH_URL` documentado y validado al startup. Test E2E con `idToken` mock evita flakiness en CI. |
| 3 | Session cookie robada (XSS) | Baja | Crítico | HttpOnly + Secure + SameSite=Lax. CSP estricta (sin scripts inline). |
| 4 | `default_tenant_id` default `'default'` filtra datos entre users | Baja | Alto | Motor enforza `tenantId` (D3.2). Test D3.2 B11-B15 verifican aislamiento. Si dos users quedan con `'default'`, no se pisan PK porque `task_id` es UUID (ya validado en audit I-1). |
| 5 | Rate limit false-positive en IP compartida (oficina) | Media | Bajo | Configurable por env var (`AUTH_RATE_LIMIT_MAX`). Log cuando se triguea. |
| 6 | DB migration falla (tabla pre-existente con nombre diferente) | Baja | Bajo | Migraciones idempotentes con `CREATE TABLE IF NOT EXISTS`. Si el schema cambió, falla loud con mensaje accionable. |
| 7 | `DbAuthProvider` rompe tests D3.3 que usan `StaticTenantProvider` | Baja | Medio | El interface es backward-compat. Los tests D3.3 que pasan `StaticTenantProvider` siguen pasando. Solo cambia el default en producción. |
| 8 | Tests E2E del OAuth flow dependen de network o Google real | Media | Alto | Usar el mecanismo de mock con `idToken` de Better Auth. Test corre offline. |

## 9. Orden de ejecución (por FUNDAMENTO, no por velocidad)

1. **Schema `auth_*` + migraciones idempotentes** (P1, sin esto nada funciona). `migrateAuthTables()` en `src/lib/db.ts`. Test A.
2. **Better Auth instance** (`src/lib/auth/auth.ts`). Config: DB, secret, socialProviders, additionalFields para `default_tenant_id`. Verifica que levanta con el schema creado en paso 1.
3. **`DbAuthProvider`** (`src/agent/workflow-engine/persistence/db-auth-provider.ts`). Implementa `AuthProvider`. Re-export. Test D.
4. **Auth handler** (`src/lib/auth/handlers.ts`). Test B (mock OAuth con `idToken`).
5. **`server.ts` modifications** (P3 — defense in depth). `helmet()` + rate limit + authMiddleware. Test C, E, F.
6. **Wire-up en endpoints existentes**: cambiar cualquier endpoint que hoy lee `tenantId` del body para usar `DbAuthProvider(req).getTenantId()`. Backward-compat: si `req.user` no existe (modo dev), fallback a `StaticTenantProvider('default')` con warning logueado.
7. **`/login` HTML mínimo** (`public/login.html`). Botón "Continuar con Google".
8. **`.env.example`** documentado.
9. **Tests E2E completos** (test G). 24/24.
10. **Regression**: re-correr todos los tests acumulados. 354 + 24 = 378 pasan, 0 fallan.
11. **Audit post-D3.4**: `woz-security-hardening` review del diff + `woz-code-review-multi-axis`. Fix de hallazgos accionables (los P0/P1 antes de merge).
12. **HANDOFF + ROADMAP** actualizados.
13. **Commit + push**.

## 10. Definition of Done

- [ ] Todos los objetivos de §2 implementados
- [ ] Cero objetivo de §3 implementado
- [ ] Primitivas de §4 todas en el código
- [ ] **24/24 tests nuevos** en `test_auth_d3_4.mts` pasan
- [ ] **354/354 tests acumulados** (D1-D3.3) siguen pasando, 0 regresiones
- [ ] `tsc` sin errores nuevos en código D3.4 (errores pre-existentes en parser.ts OK, documentados)
- [ ] **Audit `woz-security-hardening` ejecutado**: 0 hallazgos P0/P1 sin resolver
- [ ] **Audit `woz-code-review-multi-axis` ejecutado**: blast radius, correctness, performance OK
- [ ] `AGENT_ROADMAP.md` actualizado (D3.4 ✅, próximo D3.5)
- [ ] `HANDOFF.md` con log del sprint cerrado (commits + tests + decisiones)
- [ ] `.env.example` documenta las 4 vars nuevas
- [ ] Login funciona manualmente en `localhost` (smoke test con navegador real)
- [ ] **Commit + push** a `origin/master`

## 11. Open questions / decisiones diferidas

1. **¿Cuál es el endpoint exacto que ya existe que toma `tenantId` del body y hay que cambiar?** Identificar durante implementación. Si es solo `/api/sessions`, una edición. Si hay N endpoints, refactor mayor — alertar al founder.
2. **¿El frontend de React existente necesita cambios?** Verificar si Vite sirve `public/login.html` o si hay que enrutar `/login` vía React Router. Si requiere refactor del frontend, **abrir como sprint separado** (NO-objetivo explícito).
3. **¿Cómo se sirve `public/login.html`?** Vite lo sirve estático, pero hay que verificar que no choque con la SPA existente. Si choca, agregar ruta Express explícita.

## 12. Referencias

- `AGENT_D3_4_5_DB_AUTH_SPEC.md` (design spec, ya commiteado)
- `AGENT_D3_3_AUTH_SWEEPER_AUDIT_SPEC.md` (D3.3 introduce `AuthProvider`)
- `AGENT_D3_2_MULTI_TENANT_SPEC.md` (D3.2 introduce `tenantId` enforcement)
- `AGENT_D3_1_STORAGE_PERSISTENCE_SPEC.md` (D3.1 introduce `TaskStore`, patrón de migración idempotente)
- `AGENT_ROADMAP.md` §6.4 (status D3)
- `AGENTS.md` regla 11 (consultar antes de elegir servicios críticos — Better Auth ya decidido)
- `BACKLOG_P0.md` §2 (spoofing cross-tenant — este sprint lo cierra)
- `src/agent/workflow-engine/persistence/auth-provider.ts` (interface, ya existe)
- `src/lib/db.ts` (DB wrapper)
- `server.ts` (Express server)
- https://www.better-auth.com/docs/authentication/google (doc oficial Google provider)
- https://www.better-auth.com/docs/adapters/sqlite (doc oficial SQLite adapter)