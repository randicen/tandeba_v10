# Worgena — Security Practices

> **Última actualización**: 2026-06-25 (cierre D3.5).
> **Audiencia**: cliente enterprise, CISO, equipo legal del bufete.
> **Propósito**: responder las preguntas de seguridad que un enterprise auditor / NDA / DPA exige antes de pagar.

Este documento describe las prácticas de seguridad vigentes en Worgena. Lo que **no está implementado** se declara explícitamente — preferimos sub-declarar a sobre-vender.

---

## 1. Data residency and encryption

### Dónde viven los datos

- **Database**: SQLite (`worgena.db`) corriendo en el mismo proceso que el server. En producción se deploya en Railway con volumen persistente (`/data/worgena.db`).
- **File storage**: workspace de cada thread bajo `workspace/<sessionId>/`. Archivos binarios (PDFs, DOCX) se sincronizan a Cloudflare R2 (`workspace` bucket).
- **No hay replicación cross-region** en MVP. Forward-compat: cuando llegue enterprise grande, se evalúa Postgres + multi-region.

### Encryption

- **At-rest**:
  - DB SQLite: **NO encriptada** en MVP. El volumen de Railway provee encryption at-rest del filesystem (AES-256).
  - R2 bucket: encryption at-rest built-in (AES-256).
- **In-transit**: TLS 1.3 obligatorio en producción (forzado por el middleware `httpsEnforcement` en `server.ts`, ver design spec §2.9). El server rechaza HTTP plano en `NODE_ENV=production`.
- **Secrets**: API keys y secretos (BETTER_AUTH_SECRET, GOOGLE_CLIENT_*, OPENROUTER_API_KEY, etc.) viven en env vars de Railway, encriptadas at-rest.

### Forward-compat

- En D4+ (migración a Postgres): se evalúa pgcrypto para encryption a nivel de columna (e.g., `step_logs.prompt_sent`).
- En D6+ (enterprise con compliance estricto): encryption a nivel de aplicación (libsodium / age) para datos especialmente sensibles.

---

## 2. Authentication

### D3.4: Google OAuth 2.0

- Único método de login en producción. Sin passwords stored. Vector de credential stuffing eliminado.
- Sesiones firmadas con HMAC-SHA256 usando `BETTER_AUTH_SECRET` (>=32 chars).
- Cookies con flags: `HttpOnly`, `Secure` (en prod), `SameSite=Lax`. CSRF mitigado por SameSite + state param de OAuth.

### D3.5: 2FA TOTP (RFC 6238)

- **Opt-in** por user. No se fuerza 2FA en MVP. Forward-compat: D3.6+ agrega config por tenant para forzar 2FA si un enterprise lo pide.
- Compatible con Google Authenticator, Authy, 1Password, Bitwarden, etc.
- 8 recovery codes generados al enrollment, **single-use**. Se muestran 1 sola vez al user.
- Plugin Better Auth: `twoFactor({ issuer: "Worgena", allowPasswordless: true, totpOptions: { digits: 6, period: 30 }, backupCodeOptions: { amount: 8, length: 10 } })`.

### Pendiente (forward-compat)

- SSO/SAML: D3.6+ si llega enterprise grande (>50 users). Por ahora: NO.
- Magic links: D3.6+ si Google OAuth no es opción.
- Password login: NO se implementará. Si compliance lo exige, D3.6+ con un mínimo viable.

---

## 3. Authorization

### Multi-tenant isolation

- **PK compuesto**: `paused_tasks (task_id, tenant_id)` en D3.2. PK global pisaba tasks cross-tenant. CERRADO en audit I-1.
- **Todo query filtra por tenant_id**. Tests de aislamiento: D3.2 bloque B (15 tests) + D3.4 bloque G24.
- **`tenantId` viene de la session validada, NO del body**. El `DbAuthProvider` lee `req.user.default_tenant_id` que el middleware inyectó. BACKLOG P0 #1 (spoofing cross-tenant) CERRADO en D3.4.
- **Cada user nuevo recibe un tenant UNICO** (`tenant-${UUID}`). CRIT-1 del audit D3.4: si todos los users compartían `default`, había data leakage total. CERRADO.

### Pendiente

- RBAC (admin vs regular user): D6 cuando entra el editor y la gestión de equipos.
- Audit log de acciones por user-agent: actualmente `audit_auth` (login/logout) + `workflow_audit` (motor events). Acciones finas (read, edit, share) NO se auditan. D6+ si enterprise lo pide.

---

## 4. Audit trail

### `audit_auth` (D3.5)

Tabla append-only con eventos de auth:

```sql
CREATE TABLE audit_auth (
  id TEXT PRIMARY KEY,
  user_id TEXT,             -- null si login_failed (no conocemos al user)
  event TEXT NOT NULL,       -- login_success, login_failed, logout, signup,
                             --   two_factor_enabled, two_factor_disabled, two_factor_verified
  ip TEXT,                   -- IP del request
  user_agent TEXT,           -- UA del request
  metadata_json TEXT,        -- JSON libre (sessionId, code, etc.)
  created_at INTEGER NOT NULL
);
```

- Eventos cubiertos: `signup`, `login_success`, `logout`.
- NO cubiertos aún: `login_failed`, eventos 2FA específicos. Forward-compat: D6+ si enterprise los pide (hoy Better Auth no expone hooks nativos para esos).
- **Append-only**: nunca se borran rows. Evidencia legal.
- **No bloquea el flow**: si la DB falla al insertar, se loguea a stderr pero el user sigue logueado. Audit es observabilidad, no feature crítica.

### `workflow_audit` (D3.3)

Eventos del motor: start, pause, complete, fail. Con `taskId`, `tenantId`, `eventType`, `payload_json`, `created_at`.

### `step_logs` (D1)

Cada llamada al LLM: `prompt_sent`, `raw_response`, `model`, `tokens`, `duration_ms`, `status`. **NO scrub de secretos aún** (BACKLOG P0 #1, sprint separado). El LLM podría alucinar un NIT/API key/password y quedar persistido. Mitigación actual: el LLM recibe instructions explícitas de NO generar números sensibles.

### Pendiente

- **Scrub de secretos en `step_logs`** (P0 #1): sprint separado post-D3.5. SecretScrubber configurable (regex + entropy-based). Sin esto, compliance Habeas Data Colombia tiene riesgo legal.

---

## 5. Data export and deletion

### Export

- **User export**: `GET /api/me/export` (D6+, NO en MVP). Devuelve JSON con toda la data del user: `sessions`, `messages`, `step_logs`, `audit_auth`, `workflow_audit`, `spaces`, `workspace_files`.
- **Tenant export**: igual pero scoped a un tenant_id. D6+.

### Deletion

- **User deletion**: soft delete + hard delete después. NO implementado en MVP. D3.6+:
  - Soft delete: marca `deleted_at`, sessions invalidadas, login bloqueado, data retenida 30 días para recovery.
  - Hard delete después de 30 días: cascada a `sessions`, `messages`, `step_logs`, `audit_auth`, `workflow_audit`. Workspace files en R2 eliminados.
- **Tenant deletion**: cascada a todos los users del tenant. D6+.

---

## 6. Incident response

### SLA

- **Respuesta inicial**: dentro de 4 horas hábiles (Colombia time) a `security@worgena.app`.
- **Resolución P0** (auth bypass, data leak, RCE): target 24 horas desde acknowledgment.
- **Resolución P1** (XSS, CSRF en endpoints nuevos): target 1 semana.
- **Resolución P2** (info disclosure menor): target 1 sprint.

### Disclosure

- **Reportar vulnerabilidad**: `security@worgena.app` (PGP key WIP, próxima iteración).
- **Hall of fame**: se publica en `SECURITY.md` (WIP).
- **Coordinated disclosure**: 90 días desde acknowledgment antes de disclosure público. Excepciones: si la vuln está siendo explotada activamente.

---

## 7. Vulnerability disclosure

### Programa de responsible disclosure

- Reporte privado a `security@worgena.app`.
- El equipo confirma receipt dentro de 24h hábiles.
- Status updates cada 7 días hasta resolución.
- Crédito en hall of fame (si el reporter lo desea).

### Bug bounty

- **No tenemos bug bounty formal** aún. Forward-compat D6+.
- Reconocimiento: credit en `SECURITY.md` + swag para reports válidos.
- Out of scope: DoS volumétrico, phishing, social engineering, physical access, vulnerabilities en third-party deps sin exploit claro.

---

## 8. Compliance

### Habeas Data Colombia (Ley 1581/2012)

- Datos personales procesados bajo consentimiento explícito del user (Google OAuth screen).
- DPA (Data Processing Agreement) template disponible para enterprise. WIP.
- Right to access: covered por `/api/me/export` (D6+).
- Right to rectification: D6+.
- Right to deletion: covered por soft+hard delete (D6+).
- Right to objection: NO soportado en MVP. D6+ si enterprise lo pide.

### SOC 2

- **No certificado**. Forward-compat: cuando llegue el primer cliente enterprise >50 users, se inicia el proceso (~6 meses, costo ~$50K-100K).

### ISO 27001

- **No certificado**. Mismo forward-compat que SOC 2.

### GDPR (si llega cliente europeo)

- No aplica en MVP (mercado colombiano). Si llega cliente europeo: revisar data residency (cambiar a EU region), DPA, DPO.

---

## 9. Limitaciones declaradas

Por honestidad, esto es lo que **NO** está implementado aún:

- ❌ Scrub de secretos en `step_logs` (BACKLOG P0 #1).
- ❌ `login_failed` eventos en `audit_auth` (Better Auth limitation; D6+ si enterprise lo pide).
- ❌ Eventos 2FA específicos en `audit_auth` (mismo motivo).
- ❌ Soft delete del user (D6+).
- ❌ RBAC (D6+).
- ❌ SSO/SAML (D3.6+).
- ❌ Encryption a nivel de columna en DB (D4+ si Postgres).
- ❌ Bug bounty formal (D6+).
- ❌ SOC 2 / ISO 27001.
- ❌ Bug bounty.

Si alguna de estas es un bloqueador para tu caso, hablemos — algunas se pueden priorizar si un enterprise paga por el sprint.

---

## 10. Contact

- **Security**: `security@worgena.app`
- **Privacy / DPA**: `privacy@worgena.app`
- **General**: ver `AGENTS.md` y `README.md` para contacts.

---

## 11. Cambios recientes

| Fecha | Cambio | Sprint |
|---|---|---|
| 2026-06-25 | SECURITY.md creado, 2FA plugin habilitado, audit_auth persiste | D3.5 |
| 2026-06-24 | Google OAuth, helmet, rate limit, HTTPS enforcement | D3.4 |
| 2026-06-13 | Multi-tenant isolation enforcement (PK compuesto) | D3.2 |
| (más historia en `HANDOFF.md` y `AGENT_ROADMAP.md`) |

---

> Si encontrás una vulnerabilidad, **NO la publiques**. Reportala a `security@worgena.app`. Gracias.