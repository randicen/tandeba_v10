# D3.4 Redesign — Multi-User Firm con Onboarding Explícito (Sprint Spec)

> **Sprint**: D3.4 Redesign (corrección de drift).
> **Spec vivo**: este documento. Se actualiza durante implementación si se descubre scope que falta.
> **Contexto**: el D3.4 original hizo single-user-per-firm (cada user crea su propio firm auto-generado). Eso NO matchea la visión SaaS multi-user-firm de Worgena (ver `AGENT_ROADMAP.md` §5.16 y `AGENTS.md` §8-14). Este sprint lo corrige.

## 1. Contexto

Worgena es un SaaS donde una firma legal tiene N usuarios (abogados). El modelo correcto es **multi-user-firm**:

- Un usuario pertenece a N firmas vía `tenant_members`.
- Cada firma tiene N usuarios con roles (owner / admin / member).
- La sesión activa tiene `activeFirmId` (NO `default_tenant_id` en el user).
- Onboarding explícito: el user elige "crear firma" o "unirse con invite".
- Mismo code path para el primer usuario y el millon-ésimo.

**Anti-patrón que NO vamos a repetir**: "el primer user auto-crea firm, los siguientes necesitan invite". Eran DOS paths. Mal. UN solo path con onboarding donde el user elige.

**Bloquea**: cualquier feature de producto que asuma multi-user (carpetas compartidas §12.1, vaults compartidos §12.2, monitor interno §2.5). Sin multi-user-firm, esas features no se pueden construir bien.

**Bloqueado por**: nada. D3.4 original está commiteado pero NO en producción. Re-cablear es seguro.

## 2. Objetivos (qué SÍ se hace)

- **O1**. Schema `tenants`, `tenant_members`, `tenant_invitations` con FK constraints e índices. Migraciones idempotentes.
- **O2**. `auth_session.additionalFields.activeFirmId` (string, opcional). Better Auth lo persiste automáticamente.
- **O3**. `mapProfileToUser` en `auth.ts` NO crea firm. Solo crea el user con campos básicos. Mejor Auth no debe asumir nada sobre firm.
- **O4**. Endpoints REST:
  - `POST /api/firms` — crea firm. Auth requerida (cualquier user autenticado). Body: `{name, nit?}`. Retorna `{firmId, role: 'owner'}`.
  - `POST /api/firms/join` — une con invite token. Auth requerida. Body: `{token}`. Retorna `{firmId, role: 'member'}`.
  - `POST /api/firms/:id/invitations` — crea invitación. Auth requerida + role owner/admin del firm. Body: `{email?, role}`. Retorna `{token, url, expiresAt}`.
  - `DELETE /api/firms/:id/invitations/:invitationId` — revoca invitación (owner/admin only).
  - `GET /api/firms/me` — lista firms del user actual. Retorna `[{firmId, name, role, joinedAt}]`.
  - `POST /api/firms/:id/switch` — cambia `activeFirmId` de la sesión (forward-compat multi-firm).
- **O5**. `authMiddleware` (en `handlers.ts`) detecta si el user tiene 0 firms y agrega header `X-Onboarding-Required: true` en la respuesta 403. Frontend usa este header para redirigir a `/onboarding`.
- **O6**. `DbAuthProvider` lee `req.session.activeFirmId`. Lanza error accionable si está vacío. Elimina dependencia de `req.user.default_tenant_id`.
- **O7**. `audit_auth` eventos nuevos: `firm_created`, `joined_firm`, `invitation_created`, `invitation_accepted`. Cada uno con metadata completa para compliance.
- **O8**. Página `/onboarding` HTML con 2 botones ("Crear firma" / "Unirse con código"). Mismo UI para primer user y N-ésimo.
- **O9**. Backward-compat: si llega un user con `default_tenant_id` legacy (de D3.4 viejo), crear `tenant_members` row en la primera migración.
- **O10**. **Tests nuevos** (~15-20 tests) en `test_firm_membership.mts`:
  - Schema correcto (FK, índices)
  - `POST /api/firms` crea firm + tenant_members(owner)
  - `POST /api/firms/join` con token válido crea tenant_members(member)
  - Token expirado / usado / inválido → error apropiado
  - User con 0 firms → 403 con `X-Onboarding-Required`
  - User con 1+ firms → activeFirmId seteado
  - Multi-user isolation: User A no ve datos de User B en otro firm
  - Audit log: firm_created + joined_firm events
  - Invitation flow end-to-end (admin crea → invitee acepta → ambos en firm)
- **O11**. **Cero regresión** en tests existentes (376 tests acumulados) — solo se modifican los que dependen de `default_tenant_id`.

## 3. No-objetivos (qué NO se hace)

- **NO-1**. Multi-firm por user (un user en N firms activos a la vez). Forward-compat: schema soporta multi-firm; UI del switcher queda para D6. Por ahora, user solo está en 1 firm activo.
- **NO-2**. Roles avanzados (admin / billing / read-only). Solo `owner` y `member` por ahora. Forward-compat: agregar `admin` en migración.
- **NO-3**. Soft delete de firm con cascada. Solo `archived_at` flag. UI para archivar queda para D6.
- **NO-4**. UI de admin (lista de users del firm, invitar via email, etc.). El endpoint REST existe; la UI es D6 (editor de skills/workflows). Por ahora, el admin puede invitar via API.
- **NO-5**. Email transaccional para invitaciones. La invitación se genera como link/token. El "email" es responsabilidad del admin (lo copia y manda por WhatsApp/email). Email transaccional es D6+.
- **NO-6**. Migración a Postgres. Sigue en SQLite. Schema compatible con Postgres.
- **NO-7**. Edit de firm (cambiar nombre, NIT, etc.) — fuera de scope MVP.

## 4. Primitivas no negociables

- **P1. Mismo code path para todos los users.** El primer user hace click "Crear firma". El N-ésimo hace click "Unirse con invite". Ambos pasan por el mismo onboarding screen.
- **P2. Schema multi-tenant desde el inicio.** Las 3 tablas (`tenants`, `tenant_members`, `tenant_invitations`) se crean desde día 1. NO workarounds como "columna en auth_user".
- **P3. Onboarding explícito, no implícito.** El user SIEMPRE elige. NO auto-creamos firm. NO auto-asignamos firm del body.
- **P4. Tokens de invitación one-time y expirable.** `expires_at` por default 7 días. Una vez usado, `used_at` se setea y no se puede re-usar.
- **P5. FK constraints con CASCADE.** Borrar un user borra sus `tenant_members`. Borrar un firm borra sus `tenant_invitations`. NO orphans.
- **P6. `activeFirmId` se setea en la sesión, no en el user.** Forward-compat multi-firm: un user puede cambiar de firm activo sin re-login.
- **P7. Tests E2E sin red.** Mocks para OpenRouter / Google OAuth. Mismo patrón que D3.4.
- **P8. Audit log captura cada evento de firm.** `firm_created`, `joined_firm`, `invitation_created`, `invitation_accepted`, `invitation_revoked`. Append-only.

## 5. Diseño (alto nivel)

```
┌─────────────────────────────────────────────────────────────────┐
│  Google OAuth (Better Auth)                                    │
│  ↓ callback crea el user (stub, sin firm)                       │
└─────────────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────────┐
│  authMiddleware (src/lib/auth/handlers.ts)                       │
│  - Lee session via Better Auth                                  │
│  - Lee activeFirmId de session                                  │
│  - Si vacío: 403 con header X-Onboarding-Required              │
└─────────────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────────┐
│  Frontend: si X-Onboarding-Required                            │
│  - Redirige a /onboarding.html                                  │
│  - User elige: crear firm o unirse con invite                  │
│  - POST /api/firms o POST /api/firms/join                       │
└─────────────────────────────────────────────────────────────────┘
                         ↓ (después de onboarding)
┌─────────────────────────────────────────────────────────────────┐
│  Sesión tiene activeFirmId                                      │
│  DbAuthProvider.getTenantId() → activeFirmId                   │
│  Motor recibe tenantId desde la sesión, no del body            │
└─────────────────────────────────────────────────────────────────┘
```

## 6. Archivos a tocar / crear

| Archivo | Acción | Razón |
|---|---|---|
| `src/lib/db.ts` | modificar | Agregar migraciones idempotentes para `tenants`, `tenant_members`, `tenant_invitations`. Backward-compat: si `default_tenant_id` existe en `auth_user`, migrar. |
| `src/lib/auth/auth.ts` | modificar | `mapProfileToUser` ya no crea firm. `session.additionalFields` con `activeFirmId`. |
| `src/lib/auth/handlers.ts` | modificar | `authMiddleware` chequea activeFirmId, retorna 403 con `X-Onboarding-Required` si falta. |
| `src/lib/auth/firm.ts` (nuevo) | crear | Lógica de firm: `createFirm`, `joinFirmViaInvite`, `createInvitation`, `revokeInvitation`, `getUserFirms`, `switchActiveFirm`. Wraps en DB transactions. |
| `src/lib/auth/index.ts` | modificar | Re-export del módulo firm. |
| `src/lib/auth/audit.ts` | modificar | Agregar eventos: `firm_created`, `joined_firm`, `invitation_created`, `invitation_accepted`, `invitation_revoked`. |
| `src/agent/workflow-engine/persistence/db-auth-provider.ts` | modificar | Lee `req.session.activeFirmId` en lugar de `req.user.default_tenant_id`. Mensaje de error accionable. |
| `server.ts` | modificar | Endpoints REST: `POST /api/firms`, `POST /api/firms/join`, `POST /api/firms/:id/invitations`, etc. |
| `public/onboarding.html` (nuevo) | crear | HTML con 2 botones. POST a los endpoints correspondientes. |
| `src/agent/workflow-engine/executor/types.ts` | modificar | `LLMInvokeParams`: agregar `activeFirmId` (read from session en node-runner). Forward-compat con cost attribution. |
| `test_firm_membership.mts` (nuevo) | crear | 15-20 tests E2E. |
| `test_auth_d3_4.mts` | modificar | Quitar tests de `default_tenant_id`. Actualizar a `activeFirmId`. |
| `AGENT_D3_4_SPRINT_SPEC.md` | deprecate | Marcar como superseded-by este sprint spec. |
| `AGENT_ROADMAP.md` | modificar | §6.4: marcar D3.4 rediseñado. |
| `HANDOFF.md` | modificar | Log del sprint. |

## 7. Tests

**15-20 tests nuevos** en `test_firm_membership.mts`:

| # | Test | Cubre |
|---|---|---|
| 1 | Schema `tenants` con columnas correctas | schema |
| 2 | Schema `tenant_members` con UNIQUE(user_id, tenant_id) y FKs | schema |
| 3 | Schema `tenant_invitations` con FKs y token UNIQUE | schema |
| 4 | `createFirm(name)` crea tenant + tenant_members(owner) | happy path |
| 5 | `createFirm(name, nit)` crea firm con NIT | con NIT |
| 6 | `joinFirmViaInvite(token)` crea tenant_members(member) | happy path |
| 7 | `joinFirmViaInvite(tokenExpirado)` rechaza | error path |
| 8 | `joinFirmViaInvite(tokenUsado)` rechaza (single-use) | error path |
| 9 | `joinFirmViaInvite(tokenInvalido)` rechaza | error path |
| 10 | user con 0 firms: middleware retorna 403 con `X-Onboarding-Required` | onboarding |
| 11 | user con 1 firm: sesión auto-setea `activeFirmId` | onboarding |
| 12 | DbAuthProvider lee `activeFirmId` correctamente | DbAuthProvider |
| 13 | DbAuthProvider lanza si `activeFirmId` está vacío | DbAuthProvider |
| 14 | User A en firm X NO ve datos de User B en firm Y | multi-tenant |
| 15 | `firm_created` event en audit_auth | audit |
| 16 | `joined_firm` event en audit_auth | audit |
| 17 | Invitation flow end-to-end: owner crea → invitee acepta → ambos en firm | invitation |
| 18 | `activeFirmId` se persiste en `auth_session` (no se pierde entre requests) | session |

**Regression**: actualizar tests existentes que dependan de `default_tenant_id`. Aproximadamente 5-10 tests en `test_auth_d3_4.mts` y `test_auth_d3_5.mts`.

**Test total esperado**: 376 + 18 - 5 (refactorizados) = **389 tests**.

## 8. Riesgos

| # | Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|---|
| 1 | Tests existentes de D3.4 fallan por el refactor | Alta | Medio | Refactor primero, después correr tests. Update cada test que asume `default_tenant_id`. |
| 2 | Race condition en invitation (token usado dos veces en paralelo) | Baja | Alto | DB UNIQUE constraint + check atómico en `used_at IS NULL`. |
| 3 | `auth_session.additionalFields` no funciona con `activeFirmId` en Better Auth 1.6 | Baja | Alto | Verificar doc de Better Auth antes de implementar. Si no funciona, fallback: guardar en `active_session` table separada. |
| 4 | Migration de `default_tenant_id` legacy falla | Baja | Bajo | Para MVP pre-prod, la DB está vacía. No hay legacy data. |
| 5 | User con N firmas: ¿cuál es `activeFirmId` default? | Media | Bajo | Forward-compat: si N=1, esa. Si N>1, UI selector (D6). Por ahora, documentar el comportamiento. |

## 9. Orden de ejecución (por FUNDAMENTO)

1. **Schema** — migraciones idempotentes para `tenants`, `tenant_members`, `tenant_invitations`. Base de todo.
2. **`firm.ts`** — lógica de negocio: createFirm, joinFirmViaInvite, createInvitation, etc. Wraps en transactions.
3. **`auth.ts` updates** — `mapProfileToUser` simplificado (no crea firm), `session.additionalFields` con `activeFirmId`.
4. **`handlers.ts` updates** — `authMiddleware` chequea `activeFirmId`.
5. **`audit.ts` updates** — nuevos eventos.
6. **`db-auth-provider.ts` updates** — lee `activeFirmId` de session.
7. **`server.ts`** — endpoints REST.
8. **`public/onboarding.html`** — UI.
9. **Tests** — `test_firm_membership.mts` + refactor de tests existentes.
10. **Regression** — 389 tests.
11. **Docs** — HANDOFF + AGENT_ROADMAP.
12. **Commit + push**.

## 10. Definition of Done

- [ ] Todos los objetivos de §2 implementados
- [ ] Cero objetivo de §3 implementado
- [ ] Primitivas de §4 todas en el código
- [ ] **18/18 tests nuevos** pasan
- [ ] **Refactor de tests existentes** sin regresiones
- [ ] **389 tests acumulados** pasan, 0 regresiones
- [ ] `tsc` sin errores nuevos
- [ ] `AGENT_ROADMAP.md` §6.4 actualizado (D3.4 rediseñado)
- [ ] `AGENT_D3_4_SPRINT_SPEC.md` marcado como superseded
- [ ] `HANDOFF.md` con log del sprint
- [ ] **Commit + push** a `origin/master`

## 11. Open questions / decisiones diferidas

1. **¿El user puede pertenecer a N firmas con `activeFirmId` rotando?** Schema soporta. UI selector es D6.
2. **¿Quién puede archivar un firm?** Solo owner en MVP. UI para archivar es D6.
3. **¿Los admins pueden invitar usuarios con un email pre-llenado?** Sí, vía `email?` opcional en `POST /api/firms/:id/invitations`. Forward-compat: cuando tengamos email transaccional, el admin solo escribe el email y la invitación se manda sola.
4. **¿`invitations.expires_at` se chequea en `joinFirmViaInvite`?** Sí, fail loud si expirado.

## 12. Referencias

- `AGENT_ROADMAP.md` §5.16 "Multi-tenant multi-user firm: un solo code path"
- `AGENTS.md` §8-14 "DISEÑO SaaS ESCALABLE — NO A MEDIAS"
- `PLATFORM_VISION.md` §15 "Multi-tenancy"
- `AGENT_D3_4_SPRINT_SPEC.md` (superseded-by este sprint)
- `AGENT_D3_4_5_DB_AUTH_SPEC.md` §2.4 "tenantId derivado de auth_user.default_tenant_id" (también superseded)
- `BACKLOG_P0.md` (item 2 cerrado en D3.4, ahora se reabre con el rediseño)
- Better Auth docs: `session.additionalFields`, `databaseHooks`