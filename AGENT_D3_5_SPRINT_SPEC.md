# D3.5 — Hardening: 2FA TOTP + audit_auth + SECURITY.md (Sprint Spec)

> **Sprint**: D3.5 de la dimensión 3.
> **Spec vivo**: este documento. Se actualiza durante implementación si se descubre scope que falta.
> **Spec de diseño** (referencia, ya commiteado en `AGENT_D3_4_5_DB_AUTH_SPEC.md` §5): contiene las decisiones de diseño para 2FA, `audit_auth` hook, y estructura de `SECURITY.md`.

## 1. Contexto

D3.4 cerró el spoofing cross-tenant con Google OAuth + Better Auth. D3.5 endurece el flujo para que un cliente enterprise pueda onboarding:

1. **2FA TOTP (RFC 6238)**: opcional per-user. Un enterprise auditor espera ver "X de Y users tienen 2FA activado".
2. **`audit_auth` table**: persistencia append-only de eventos de auth (login_success, login_failed, logout, 2FA events). Evidencia legal. D3.4 los loguea a stdout; D3.5 los persiste.
3. **`SECURITY.md`**: documento de 2-3 páginas que un enterprise lee antes de firmar NDA / DPA. Es lo primero que un CISO pide.

**Bloquea**: onboarding del primer cliente enterprise chico (abogado de 1 persona con NDA estándar). NO bloquea el lanzamiento MVP al abogado de 1 persona sin compliance — D3.4 es suficiente para eso.

**Bloqueado por**: D3.4 cerrado (✓). Better Auth 1.6 soporta el plugin `twoFactor` (✓, ver docs).

## 2. Objetivos (qué SÍ se hace)

- **O1**. Plugin `twoFactor` de Better Auth habilitado con TOTP (RFC 6238). Usuario puede activar/desactivar 2FA vía `/api/auth/two-factor/enable` y `/api/auth/two-factor/disable`.
- **O2**. QR code de enrollment generado vía el endpoint built-in de Better Auth.
- **O3**. 8 recovery codes generados al enrollment, single-use. Si el user pierde el dispositivo, usa uno de los 8.
- **O4**. Verificación TOTP integrada en el flow de login: después de Google OAuth, si el user tiene 2FA activado, el frontend redirige a `/api/auth/two-factor/verify` antes de completar la session.
- **O5**. Tabla `audit_auth` creada vía migraciones idempotentes. Schema: `id, user_id, event, ip, user_agent, metadata_json, created_at`. Append-only.
- **O6**. Hook de Better Auth que persiste en `audit_auth` cada evento de auth (login_success, login_failed, logout, two_factor_enabled, two_factor_disabled, two_factor_verified, etc.). Si la DB falla, log a stderr pero NO bloquear el flow (audit es observabilidad, no feature crítica).
- **O7**. `SECURITY.md` en la raíz del proyecto con: data residency, encryption (at-rest + in-transit), authentication, authorization (multi-tenant isolation), audit trail, data export/deletion, incident response (SLA), vulnerability disclosure, compliance (Habeas Data Colombia).
- **O8**. **12 tests nuevos** en `test_auth_d3_5.mts` (2FA enrollment + verify + login flow + recovery codes + audit_auth persistence).
- **O9**. **Cero regresión** en tests D1-D3.4 (408 tests acumulados).
- **O10**. `AGENT_ROADMAP.md` actualizado (D3.5 cerrado, próximo D4).
- **O11**. `HANDOFF.md` actualizado al cierre.

## 3. No-objetivos (qué NO se hace)

- **NO-1**. Forzar 2FA a todos los users — sigue opt-in. En D3.6+ si un enterprise lo pide, se agrega config por tenant.
- **NO-2**. UI de `/settings/security` para enrollment/desactivación de 2FA — Better Auth expone los endpoints REST, la UI la hace D6 (editor).
- **NO-3**. Email transaccional (Resend / Postmark) para recovery codes — opt-in user recibe los codes en pantalla al enrollment, no por email. Si en D6 un enterprise pide email, se agrega.
- **NO-4**. Soft-delete del user — D3.6+ cuando llegue el primer enterprise que pida account deletion formal.
- **NO-5**. SAML / SSO — D3.6+ si llega el primer cliente enterprise grande (>50 users).
- **NO-6**. Sentry / error tracking — sprint separado, no bloquea MVP.
- **NO-7**. Rate-limit diferenciado por endpoint (stricter para sign-in) — sprint separado, fuera de scope D3.5.
- **NO-8**. CSRF tokens — aceptado para MVP (SameSite=lax cubre la mayoría); D6 cuando enterprise auditor pida.
- **NO-9**. Migración a Postgres — sigue en SQLite; Better Auth ya tiene adapter Postgres oficial para cuando llegue D4+.
- **NO-10**. Multi-tenant user pool — D6.

## 4. Primitivas no negociables

- **P1. 2FA opt-in, NO opt-out del usuario.** Forzar 2FA rompería el flujo del abogado de 1 persona. Mejor Auth soporta opt-out solo si el user lo decide.
- **P2. Recovery codes single-use.** Cuando un recovery code se usa, se invalida inmediatamente. Forward-compat: el usuario puede regenerar el set si los pierde todos.
- **P3. `audit_auth` append-only, NUNCA borrar rows.** Evidencia legal. Si se necesita "borrar", se inserta un evento `redacted` con metadata, NO se hace DELETE.
- **P4. Hook de auditoría NO bloquea el flow de auth.** Si la DB falla al insertar el evento, se loguea a stderr pero el user sigue logueado. Audit es observabilidad, no feature crítica. Si lo bloqueáramos, una DB caída = nadie puede loguearse.
- **P5. `SECURITY.md` debe ser honesto sobre el estado actual.** Si algo no está implementado, decirlo explícitamente. Mejor sub-declarar que sobre-vender.
- **P6. TOTP secret almacenado encriptado** (Better Auth lo hace por default vía `encryptedSecret` en el schema).

## 5. Diseño (alto nivel)

Referencia: design spec `AGENT_D3_4_5_DB_AUTH_SPEC.md` §5.

```
┌─────────────────────────────────────────────────────────────────┐
│  Capa 4: Frontend                                              │
│  - /settings/security (D6+, NO en D3.5)                        │
│  - /2fa-verify (UI de verificación post-login, NO en D3.5)     │
└─────────────────────────────────────────────────────────────────┘
                             ↕
┌─────────────────────────────────────────────────────────────────┐
│  Capa 3: server.ts (D3.5: agregamos endpoints 2FA)              │
│  - /api/auth/two-factor/* (Better Auth plugin routes)          │
│  - audit_hook: middleware que persiste cada evento a audit_auth│
└─────────────────────────────────────────────────────────────────┘
                             ↕
┌─────────────────────────────────────────────────────────────────┐
│  Capa 2: src/lib/auth/auth.ts (D3.5: agregamos plugin twoFactor)│
│  - twoFactor({ issuer: "Worgena", totpOptions: {...} })         │
│  - databaseHooks: persiste eventos a audit_auth                  │
└─────────────────────────────────────────────────────────────────┘
                             ↕
┌─────────────────────────────────────────────────────────────────┐
│  Capa 1: SQLite (D3.5: nueva tabla audit_auth)                  │
│  - audit_auth (id, user_id, event, ip, user_agent, metadata)   │
│  - columnas adicionales en auth_user (two_factor_*) via plugin  │
└─────────────────────────────────────────────────────────────────┘
```

## 6. Archivos a tocar / crear

| Archivo | Acción | Razón |
|---|---|---|
| `src/lib/auth/auth.ts` | modificar | Agregar plugin `twoFactor({ issuer, totpOptions })`. El schema de `auth_user` se extiende automáticamente con `twoFactorEnabled`, `twoFactorSecret`, `twoFactorBackupCodes`. |
| `src/lib/auth/handlers.ts` | modificar | Agregar `auditHook` middleware que persiste eventos a `audit_auth`. |
| `src/lib/auth/migrations.ts` (nuevo) | crear | `runAuditAuthMigrations()` que crea la tabla `audit_auth` idempotente. |
| `src/lib/auth/index.ts` | modificar | Re-export del nuevo módulo de migraciones. |
| `SECURITY.md` (nuevo) | crear | Doc para enterprise: data residency, encryption, auth, authorization, audit trail, data export/deletion, incident response, vulnerability disclosure, compliance. |
| `test_auth_d3_5.mts` (nuevo) | crear | 12 tests E2E (2FA enrollment, verify, login flow, recovery codes, audit_auth persistence). |
| `AGENT_ROADMAP.md` | modificar | Marcar D3.5 cerrado. |
| `HANDOFF.md` | modificar | Log del sprint cerrado. |

## 7. Tests

**12 tests nuevos** en `test_auth_d3_5.mts`, distribuidos:

| Bloque | Tests | Cubre |
|---|---|---|
| A: 2FA enrollment | 3 | Genera secret TOTP + QR + 8 recovery codes. POST `/api/auth/two-factor/enable` con código válido → habilita. Código inválido → rechaza. |
| B: 2FA login flow | 3 | User con 2FA habilitado hace sign-in → redirige a verify. Verify con código OK → session completa. Verify 3 veces mal → bloquea 5min (rate limit). |
| C: Recovery codes | 2 | 8 codes generados al enrollment. Cada code es single-use (segundo uso → falla). |
| D: audit_auth | 4 | login_success persiste con user_id, ip, user_agent. login_failed persiste sin user_id. logout persiste. 2FA events (enabled, verified, disabled) persisten. |

**Regression**: 408 tests acumulados (D1-D3.4) deben seguir pasando.

**Estrategia**: Better Auth provee endpoints internos para enrollment y verify. Tests usan esos endpoints con código TOTP generado vía `speakeasy` o librería nativa (RFC 6238). Si no hay `speakeasy`, usar `otplib` o implementación custom basada en Web Crypto API.

## 8. Riesgos

| # | Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|---|
| 1 | Better Auth `twoFactor` plugin no funciona con `modelName: "auth_*"` prefix | Baja | Alto | Si falla, probar sin prefix (el plugin asume nombres default). Validar con test A1. |
| 2 | TOTP drift entre client y server | Media | Bajo | Better Auth usa ventana de ±1 step (30s) por default. Aceptable para UX. |
| 3 | User bloqueado por perder dispositivo + recovery codes | Baja | Alto | UI muestra recovery codes 1 sola vez al enrollment con mensaje "guardalos en un lugar seguro". En D6+: email transaccional. |
| 4 | `audit_auth` crece sin bound | Media | Bajo | Forward-compat: índice por `created_at` para queries, rotación a cold storage post-D6. |
| 5 | Hook de auditoría rompe el flow si DB está caída | Baja | Alto | P4: si insert falla, log a stderr y continuar. NUNCA bloquear el login por audit. |
| 6 | 2FA enrollment sin UI = user no sabe cómo activarlo | Alta | Medio | D3.5 doc + script SQL para que el founder active manualmente. UI real en D6. |
| 7 | Recovery codes leaked en logs (si user los tipea en el chat) | Baja | Alto | `SECRET_SCRUBBER` (futuro Backlog P0 §1) los enmascara. Por ahora, doc que recovery codes NO se tipeen en chat. |

## 9. Orden de ejecución (por FUNDAMENTO)

1. **Schema `audit_auth`** (P3, append-only). Crear tabla con migración idempotente. Test D1-D4.
2. **Plugin `twoFactor` en auth.ts**. Habilitar Better Auth plugin. Verificar que schema se extiende. Test A1-A3.
3. **Hook de auditoría**. Implementar middleware que persiste eventos. Test D1-D4.
4. **Tests E2E completos**. 12 tests pasan.
5. **`SECURITY.md`**. Escribir doc con secciones §1-§8 según design spec.
6. **Regression**: re-correr 408 tests. 420 (408 + 12) pasan.
7. **Docs**: HANDOFF + ROADMAP.
8. **Commit + push**.

## 10. Definition of Done

- [ ] Todos los objetivos de §2 implementados
- [ ] Cero objetivo de §3 implementado
- [ ] Primitivas de §4 todas en el código
- [ ] **12/12 tests nuevos** en `test_auth_d3_5.mts` pasan
- [ ] **408/408 tests acumulados** siguen pasando, 0 regresiones
- [ ] `tsc` sin errores nuevos en código D3.5
- [ ] `SECURITY.md` revisado y completo (8 secciones)
- [ ] `AGENT_ROADMAP.md` actualizado (D3.5 ✅)
- [ ] `HANDOFF.md` con log del sprint cerrado
- [ ] **Commit + push** a `origin/master`

## 11. Open questions / decisiones diferidas

1. **¿`SECRET_SCRUBBER` para recovery codes en logs?** Recovery codes son secretos. Si el user los tipea en chat, quedan en `step_logs`. Backlog P0 §1 (scrub de secretos) lo cubre. Por ahora, doc en `SECURITY.md` que NO se tipeen en chat.
2. **¿Forzar 2FA a TODOS los users?** Mi recomendación: NO en D3.5. En D3.6+ si un enterprise lo pide, se agrega config por tenant. D3.5 doc que el setting es opt-in.
3. **¿Soft-delete del user al "delete account"?** Soft delete por 30 días (reversible), hard delete después. NO en D3.5 — D3.6+ cuando llegue enterprise con compliance estricto.

## 12. Referencias

- `AGENT_D3_4_5_DB_AUTH_SPEC.md` §5 (design spec D3.5)
- `AGENT_D3_4_SPRINT_SPEC.md` (sprint spec D3.4 — patron)
- `AGENT_D3_3_AUTH_SWEEPER_AUDIT_SPEC.md` (D3.3 introduce `AuthProvider`)
- `AGENT_ROADMAP.md` §6.4 (status D3)
- `AGENTS.md` regla 11 (consultar antes de elegir servicios críticos)
- `BACKLOG_P0.md` §1 (scrub de secretos — depende parcialmente de D3.5)
- https://www.better-auth.com/docs/plugins/2fa (doc oficial Better Auth 2FA plugin)
- RFC 6238 (TOTP standard)