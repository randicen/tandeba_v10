# Worgena — D3.4 + D3.5: Auth de Tenant con Google OAuth (DB-Backed)

> **Sprints**: D3.4 (Auth principal) + D3.5 (Hardening: 2FA + audit + security doc).
> **Fecha**: 2026-06-14.
> **Status**: 📝 Spec escrita. Pendiente: aprobación del founder → implementación.
> **Spec version**: 1.0 (draft).
>
> Este sprint cierra el último agujero de D3: el motor tiene multi-tenancy enforcement (D3.1-3.2) y un `AuthProvider` interface (D3.3), pero **no hay auth real de usuario**. D3.4 enchufa Google OAuth end-to-end con datos del usuario persistidos en SQLite (mismo `worgena.db` que ya usa el motor). D3.5 lo endurece con 2FA TOTP, audit log de auth, y el documento de security practices que un cliente enterprise va a pedir antes de pagar.

---

## 1. Propósito y alcance

### 1.1. Qué resuelve

**Hoy** (post-D3.3): un user que llega a Worgena se loguea sin auth (modo dev). El motor asume `tenantId='default'` y arranca. Esto es aceptable para demos locales, **NO es aceptable para**:

- Un cliente real (abogado de 1 persona) que sube un contrato.
- El primer cliente enterprise que pide "muéstrame su security posture".
- Cualquier deployment público.

**Mañana** (post-D3.4 + D3.5):

1. El user entra a `https://worgena.app/login`, click "Continuar con Google", autoriza la app, y queda logueado.
2. Sus datos viven en la DB de Worgena (`users`, `sessions`, `accounts`, `audit_auth`). Nada se va a Clerk ni a ningún tercero.
3. El motor sabe quién es (vía el `AuthProvider` interface que ya existe) y le asigna un `tenantId`.
4. Cada acción sensible (login, logout, cambio de password, 2FA activado) queda registrada en `audit_auth` con timestamp, IP, user agent.
5. Opcionalmente, el user puede activar 2FA con TOTP (Authy / Google Authenticator) para que un enterprise auditor vea "10 de 12 usuarios tienen 2FA activado".
6. Un documento `SECURITY.md` de 2-3 páginas resume las prácticas para el RFP / NDA de un enterprise.

### 1.2. Qué NO resuelve (forward-compat con D3.6+)

- **SSO/SAML** (lo pide un enterprise grande, no el abogado de 1 persona). Diferido a D3.6 cuando llegue el primer cliente que lo pida.
- **Magic links por email** (login sin Google, solo con email). Diferido — Google cubre el 95% del mercado colombiano de abogados.
- **Otros OAuth providers** (Microsoft para empresas, Apple). Diferido.
- **Password login**. **NO se implementa**. Si solo hay Google OAuth, no hay passwords que hashear, un vector menos. Si en D3.6 un cliente pide password por compliance, se agrega; hoy es YAGNI.
- **Multi-tenant user pool** (un user pertenece a N tenants con roles distintos). Diferido a D6 cuando entre el editor y la gestión de equipos.
- **Cron sweeper automático** (el sweeper de D3.3 hoy corre en startup; un `setInterval` lo hace cada 5min). Diferido a D3.6 si hace falta.

### 1.3. Dependencias

- D3.1 + D3.2 + D3.3 cerrados.
- `worgena.db` (SQLite) con migraciones idempotentes.
- Express server en `server.ts` con `dotenv` y `pool` (wrapper pg-style).
- `AuthProvider` interface en `src/agent/workflow-engine/persistence/auth-provider.ts` (de D3.3).

### 1.4. Orden fundamental (regla 6b)

Para cada item, "¿qué se rompe si esto no está?":

1. **Tablas `users`/`sessions`/`accounts`/`audit_auth` en SQLite**: **fundamental**. Sin esto no hay dónde guardar el user. Bloquea todo lo demás.
2. **Google OAuth flow end-to-end**: **fundamental**. Sin esto no hay login. Bloquea todo lo demás.
3. **`DbAuthProvider` que implementa `AuthProvider`**: **fundamental**. Sin esto el motor no sabe el `tenantId` del request.
4. **Middleware en `server.ts` que valida la session**: **fundamental**. Sin esto cualquier request es anónimo. **Crítico de seguridad**.
5. **Security headers + rate limiting en `/api/auth/*`**: **fundamental** (defensa en profundidad). Si lo dejo para D3.5, en D3.4 hay una ventana de 2-3 días con auth sin harden. **Lo meto en D3.4 junto con el OAuth flow**.
6. **2FA TOTP** (D3.5): **fundamental para enterprise** pero NO bloquea el lanzamiento MVP. El abogado de 1 persona no pide 2FA el día 1. Un enterprise grande sí. Diferir a D3.5 está OK.
7. **`audit_auth` table + insert en cada evento de auth** (D3.5): **fundamental para enterprise / legal**. D3.4 puede loguear a stdout; D3.5 lo persiste. Diferible.
8. **`SECURITY.md` doc** (D3.5): **fundamental para enterprise** pero no bloquea código. Diferible.

---

## 2. Decisiones de diseño

### 2.1. Better Auth como librería, NO implementación propia del flow OAuth

**Decisión**: usamos **Better Auth 1.x** para el flow OAuth, las sessions, los CSRF tokens, y la validación de tokens. NO implementamos el flow OAuth a mano con `google-auth-library` o `passport`.

**Razón**:
- El flow OAuth con Google (state generation, code exchange, token refresh) tiene **decenas de edge cases** que Better Auth ya resolvió. Implementarlo a mano es 2-3 semanas de código + auditoría.
- Better Auth es open source (MIT), mantenido activo, soporta SQLite nativo, tiene plugins oficiales para 2FA TOTP, organizations, magic links, etc.
- **Lock-in a Better Auth es BAJO**: no es un servicio externo (no es Clerk), es una librería que vive en `node_modules`. Si en D3.6 queremos migrar a Lucia o auth propio, el cambio es local a `src/lib/auth/*` y `server.ts` middleware.

**Alternativas consideradas y descartadas**:

| Librería | Razón del descarte |
|---|---|
| **Lucia** | Más boilerplate, UI propia, 2FA hay que añadirlo a mano. |
| **Auth.js (NextAuth)** | Diseñado para Next.js; integración con Express es más friccionada. |
| **Auth propio con `google-auth-library` + iron-session** | 2-3 semanas de implementación + auditoría. El motor no es auth, no vale la pena. |
| **Clerk** | Servicio externo, $25-100/mes al escalar, datos de user fuera de nuestra DB. Decidido NO. |

**Verificación de doc oficial**: revisada `https://www.better-auth.com/docs/authentication/google` (Google provider) y `https://www.better-auth.com/docs/adapters/sqlite` (SQLite adapter con better-sqlite3). Better Auth 1.6 soporta exactamente este stack.

### 2.2. Better Auth con SQLite (mismo `worgena.db`), schema separado `auth_*`

**Decisión**: Better Auth usa su propia `Database` instance de `better-sqlite3` apuntando al mismo archivo `worgena.db`. Sus tablas se crean con prefijo `auth_` (e.g. `auth_user`, `auth_session`, `auth_account`) para no chocar con las tablas del motor (`paused_tasks`, `workflow_audit`, `sessions` — ojo: la tabla `sessions` de D1 se llama igual que la de Better Auth, **necesito renombrar** la de D1 o prefijar la de Better Auth).

**Razón**:
- **Misma DB** = un solo backup, una sola conexión que monitorear, un solo punto de falla. Railway provee un volumen persistente para `worgena.db`.
- **Schema separado por prefijo** = cero colisión de nombres. Si migramos a Postgres en D4, ambas partes migran juntas.
- **Diferente file** = doble backup, doble monitoreo, doble config. YAGNI.

**Forward-compat con Postgres**: cuando en D4+ migremos a Postgres/Xata, Better Auth tiene un adapter Postgres oficial. Solo cambiamos la `Database` instance; el resto del código no se entera.

### 2.3. Google OAuth ONLY (no password, no magic link en D3.4)

**Decisión**: el único método de login en D3.4 es **Google OAuth**. No hay password, no hay magic link.

**Razón**:
- Google cubre el 95% del mercado colombiano de abogados. Un abogado de 1 persona usa Gmail casi siempre.
- **Sin passwords = sin vector de "password leak" / "credential stuffing"**. Un vector menos.
- Un enterprise que pide password por compliance interno se maneja en D3.6.

**Trade-off**: si Google cae o cambia TOS, los users no entran. **Mitigable**: Better Auth permite añadir más providers (Microsoft, Apple) con un config flag en D3.6 si pasa.

### 2.4. `tenantId` derivado de `userId`, NO claim de Google

**Decisión**: el `tenantId` que el motor recibe se deriva de una columna `default_tenant_id` en la tabla `auth_user`. NO se usa el `org_id` de Google ni un claim custom de Google.

**Razón**:
- El `tenantId` de Worgena es un concepto de **nuestra** app, no de Google. Tiene que vivir en nuestra DB.
- En D3.4, cada user pertenece a un solo tenant (1 abogado = 1 firma). El modelo multi-tenant real (1 user en N firmas) es D6.
- Forward-compat: si en D3.6 añadimos la tabla `tenant_members(user_id, tenant_id, role)`, el `DbAuthProvider.getTenantId()` cambia a leer de esa tabla. Cero cambio al motor.

### 2.5. `AuthProvider` interface: `DbAuthProvider` (sync) + `MultiTenantAuthProvider` (async, D6)

**Decisión**: implementamos `DbAuthProvider` que implementa la interface existente `AuthProvider` con `getTenantId(): string` **sync**. Lee el `req.user.default_tenant_id` que el middleware inyectó.

**Razón**:
- La interface ya existe (D3.3). Sync o async: la `startTask` del motor prefiere sync (con warning si es async). Mejor sync.
- El middleware en `server.ts` ya validó la session y tiene el `userId`. Lee el `default_tenant_id` y lo inyecta en `req.tenantId`. El provider solo lee de ahí.

**Forward-compat con multi-tenant real (D6)**: `MultiTenantAuthProvider` con `getTenantId(): Promise<string>` lee de la tabla `tenant_members` según el header `X-Worgena-Tenant`. D3.4 deja la interface abierta para esto.

### 2.6. Doble `userId` por request: session cookie + body param para server-side context

**Decisión**: el middleware extrae `userId` de la session cookie y lo inyecta en `req.userId`. El `DbAuthProvider` lo lee. NO se confía en `userId` enviado en el body o en un header.

**Razón**:
- **El userId del request SIEMPRE viene de la session validada**, no del body. Esto evita que un user A se haga pasar por user B.
- Si en el futuro hay server-side rendering que necesita el `userId` en el contexto, el middleware lo hace disponible vía `req.userId`.

### 2.7. Rate limiting en `/api/auth/*` con `express-rate-limit`

**Decisión**: aplicamos rate limiting al endpoint de callback de Google OAuth y al endpoint de "check session": 30 requests / 5 minutos por IP.

**Razón**:
- Sin rate limiting, un atacante puede hacer fuerza bruta sobre la session cookie (adivinarla es imposible, pero hacer DoS pegándole al endpoint de validación es trivial).
- `express-rate-limit` es la librería estándar de Express para esto. 50KB de código, 0 deps raras.

**Trade-off**: si el user legítimo tiene una IP compartida (oficina, VPN), puede triguerear el rate limit. **Mitigable**: ajustable por env var, logueamos cuando se triguea, y los enterprise pueden pedir whitelist por IP.

### 2.8. Security headers con `helmet`

**Decisión**: aplicamos `helmet()` globalmente en Express. Headers: HSTS, X-Frame-Options, X-Content-Type-Options, CSP.

**Razón**:
- `helmet` es la librería estándar. Un `app.use(helmet())` y te cubre 80% de los security headers que un enterprise auditor espera ver.
- CSP estricta puede romper el frontend (Google OAuth redirect, scripts inline). Configuramos CSP `default-src 'self'` + allowlist explícito para `accounts.google.com` y Google Fonts.

### 2.9. HTTPS forzado y cookies `Secure` (en prod)

**Decisión**:
- En dev (`NODE_ENV=development`): HTTP permitido, cookies `Secure=false` para que funcione en `localhost`.
- En prod (`NODE_ENV=production`): Railway provee HTTPS en `*.railway.app`. El server chequea `req.secure` o `X-Forwarded-Proto: https` y rechaza requests HTTP.

**Razón**:
- En producción, una cookie de session sobre HTTP = robo trivial. No negociable.
- En dev, forzar HTTPS rompe el flujo local. Trade-off estándar.

### 2.10. 2FA TOTP en D3.5 (no en D3.4)

**Decisión**: D3.4 implementa el OAuth flow sin 2FA. D3.5 añade 2FA con TOTP (RFC 6238) vía el plugin oficial de Better Auth.

**Razón**:
- D3.4 es el "MVP seguro". D3.5 es el "enterprise-ready".
- 2FA TOTP requiere UX (pantalla de enrollment con QR, pantalla de verificación con código) que añade 1-2 días de dev + tests. Mejor un sprint dedicado.
- Un abogado de 1 persona no pide 2FA el día 1. Un enterprise sí, pero ese cliente va a llegar con D3.5 ya cerrado o lo agregamos como fast-follow.

### 2.11. `audit_auth` table: eventos de auth persistidos, no solo stdout

**Decisión**: en D3.4 los eventos de auth (login, logout, login_failed) se loguean a `stdout` (vía el `ExecutorLogger` que ya existe). En D3.5 se persisten en una tabla `audit_auth` con `id, user_id, event, ip, user_agent, created_at, metadata_json`.

**Razón**:
- Stdout es lo mínimo. Persistido es lo que un auditor enterprise espera.
- La tabla es append-only (nunca se borran rows). Es evidencia legal.

### 2.12. `SECURITY.md` doc de 2-3 páginas

**Decisión**: D3.5 entrega un `SECURITY.md` en la raíz del proyecto con:
- Dónde viven los datos (Xata, región, encriptación at rest).
- Cómo se encriptan (TLS 1.3, AES-256).
- Cómo se revocan accesos (soft delete del user + invalidate sessions).
- Cómo se exportan datos (botón en UI, JSON).
- Logs de quién hizo qué (audit_auth + workflow_audit + step_logs).
- Tiempo de respuesta a incidentes (SLA propuesto).
- 2FA status.
- Reporte de vulnerabilidades (security@worgena.app, 24h response).

**Razón**:
- Es lo primero que un enterprise te pide en el NDA / DPA.
- No es código. Es un doc de 2-3 páginas.

---

## 3. Arquitectura de las 4 capas

```
┌─────────────────────────────────────────────────────────────────┐
│  CAPA 4: Frontend (Vercel / Railway)                            │
│  - /login: botón "Continuar con Google"                         │
│  - /settings/security: 2FA, sesiones activas, logout, export    │
│  - Usa `better-auth/client` (signIn.social, signOut, useSession)│
└─────────────────────────────────────────────────────────────────┘
                            ↕ HTTPS + cookies
┌─────────────────────────────────────────────────────────────────┐
│  CAPA 3: server.ts middleware (Express, Railway)                │
│  - helmet() global                                              │
│  - express.json()                                               │
│  - express-rate-limit en /api/auth/*                            │
│  - authMiddleware en /api/* (excepto /api/auth/* público)       │
│  - Lee session cookie → consulta auth_session → inyecta req.user│
│  - DbAuthProvider.getTenantId() lee req.user.default_tenant_id  │
└─────────────────────────────────────────────────────────────────┘
                            ↕
┌─────────────────────────────────────────────────────────────────┐
│  CAPA 2: lib/auth/* (Better Auth como librería)                 │
│  - auth.ts: instancia de betterAuth({ database, secret, ... })  │
│  - handlers.ts: monta /api/auth/* (sign-in, callback, sign-out) │
│  - Schemas: user, session, account, verification, audit_auth    │
│  - Plugin twoFactor (D3.5)                                      │
└─────────────────────────────────────────────────────────────────┘
                            ↕
┌─────────────────────────────────────────────────────────────────┐
│  CAPA 1: SQLite (worgena.db)                                    │
│  - auth_user, auth_session, auth_account, auth_verification     │
│  - audit_auth (D3.5)                                            │
│  - Tablas existentes del motor: paused_tasks, workflow_audit,   │
│    sessions (D1), spaces, messages, step_logs, ...              │
└─────────────────────────────────────────────────────────────────┘
                            ↕
┌─────────────────────────────────────────────────────────────────┐
│  CAPA 0: WorkflowEngine (src/agent/workflow-engine/)            │
│  - startTask(wf, input, options.tenantId) usa DbAuthProvider    │
│  - persistCheckpoint() usa task.tenantId (ya enforcado D3.2)    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. Sprint D3.4 — Auth principal (2-3 días de dev)

### 4.1. Tareas

| # | Tarea | Archivos | Esfuerzo |
|---|---|---|---|
| 1 | Crear proyecto en Google Cloud Console y obtener `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | `.env.example` (no código) | 30 min (manual, founder) |
| 2 | Instalar `better-auth` y `express-rate-limit` y `helmet` | `package.json` | 10 min |
| 3 | Crear `src/lib/auth/auth.ts` con instancia de `betterAuth()` | nuevo | 1h |
| 4 | Crear `src/lib/auth/handlers.ts` con Express handlers | nuevo | 1h |
| 5 | Crear `DbAuthProvider` que implementa `AuthProvider` | nuevo | 1h |
| 6 | Modificar `server.ts` para montar `/api/auth/*`, `helmet()`, `authMiddleware()`, rate limit | `server.ts` | 2h |
| 7 | Crear página `/login` mínima (HTML + JS) | `public/login.html` (o template) | 1h |
| 8 | Modificar `src/lib/db.ts` para crear tablas `auth_*` con migraciones idempotentes | `src/lib/db.ts` | 1h |
| 9 | Tests E2E: login → session → call protected endpoint → logout | `test_auth_d3_4.mts` | 2h |
| 10 | Documentar en `HANDOFF.md` y `AGENT_ROADMAP.md` | docs | 30 min |

**Total: ~10 horas de dev.**

### 4.2. Schema SQL (idempotente, en `migrateAuthTables()`)

```sql
-- auth_user: el user. default_tenant_id es su "firma" actual.
CREATE TABLE IF NOT EXISTS auth_user (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  image TEXT,
  default_tenant_id TEXT NOT NULL DEFAULT 'default',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- auth_session: la session cookie. Indexed por user_id para revocación.
CREATE TABLE IF NOT EXISTS auth_session (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  token TEXT UNIQUE NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_session_user_id_idx ON auth_session(user_id);
CREATE INDEX IF NOT EXISTS auth_session_token_idx ON auth_session(token);

-- auth_account: vincula el user a su provider OAuth (Google).
CREATE TABLE IF NOT EXISTS auth_account (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  expires_at INTEGER,
  scope TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(provider, provider_account_id)
);

-- audit_auth: log append-only de eventos de auth (D3.5 completa el set).
CREATE TABLE IF NOT EXISTS audit_auth (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  event TEXT NOT NULL,  -- 'login_success', 'login_failed', 'logout', 'session_expired'
  ip TEXT,
  user_agent TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_auth_user_id_idx ON audit_auth(user_id);
CREATE INDEX IF NOT EXISTS audit_auth_event_idx ON audit_auth(event);
```

**Nota**: la tabla `auth_*` la CREA Better Auth automáticamente con su CLI (`npx auth@latest migrate`). En este spec lo escribo a mano para mantener el control del schema (mismo patrón que D3.1).

### 4.3. `src/lib/auth/auth.ts` (sketch)

```typescript
import { betterAuth } from "better-auth";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.WORGENA_DB_PATH ?? path.join(__dirname, "../../../worgena.db");

export const authDb = new Database(DB_PATH);
authDb.pragma("journal_mode = WAL");
authDb.pragma("foreign_keys = ON");

export const auth = betterAuth({
  database: authDb,
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  secret: process.env.BETTER_AUTH_SECRET,  // openssl rand -base64 32 en .env
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      prompt: "select_account",  // siempre muestra el selector de cuenta
    },
  },
  user: {
    additionalFields: {
      default_tenant_id: {
        type: "string",
        defaultValue: "default",
        required: false,
        input: false,  // no se setea desde signup form
      },
    },
  },
  trustedOrigins: [process.env.BETTER_AUTH_URL ?? "http://localhost:3000"],
});
```

### 4.4. `src/lib/auth/handlers.ts` (sketch)

```typescript
import type { Request, Response } from "express";
import { auth } from "./auth.js";

/**
 * Better Auth expone un handler genérico que maneja todas las rutas
 * /api/auth/* (sign-in, callback, sign-out, session, etc.).
 * Solo lo montamos en el router de Express.
 */
export const authHandler = async (req: Request, res: Response): Promise<void> => {
  const response = await auth.handler(new Request(`http://${req.headers.host}${req.originalUrl}`, {
    method: req.method,
    headers: req.headers as HeadersInit,
    body: req.method !== "GET" && req.method !== "HEAD" ? JSON.stringify(req.body) : undefined,
  }));
  res.status(response.status);
  response.headers.forEach((value, key) => res.setHeader(key, value));
  const text = await response.text();
  res.send(text);
};
```

### 4.5. `DbAuthProvider` (sketch, en `src/agent/workflow-engine/persistence/db-auth-provider.ts`)

```typescript
import type { AuthProvider } from "./auth-provider.js";
import type { Request } from "express";

/**
 * D3.4: AuthProvider que lee el tenantId del request HTTP.
 *
 * El middleware (server.ts) valida la session y setea req.user.
 * Este provider solo lee req.user.default_tenant_id y lo retorna.
 *
 * Si el request no está autenticado, retorna 'default' (legacy/dev).
 * El motor luego validará que el user tiene acceso a ese tenant.
 */
export class DbAuthProvider implements AuthProvider {
  constructor(private readonly req: Request) {}
  getTenantId(): string {
    const user = (this.req as any).user as
      | { default_tenant_id?: string; id?: string }
      | undefined;
    if (!user?.default_tenant_id) {
      // El middleware debería haber rechazado este request antes.
      // Si llegamos acá, es un bug del caller.
      throw new Error(
        "DbAuthProvider invoked on unauthenticated request. " +
        "Did authMiddleware() run before this endpoint?",
      );
    }
    return user.default_tenant_id;
  }
}
```

### 4.6. Modificaciones a `server.ts` (sketch)

```typescript
// 1. helmet() y rate limit al inicio, después de express.json()
import helmet from "helmet";
import rateLimit from "express-rate-limit";

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "accounts.google.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "accounts.google.com"],
      frameSrc: ["accounts.google.com"],
    },
  },
  hsts: process.env.NODE_ENV === "production" ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
}));

const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,  // 5 min
  max: 30,                  // 30 requests por IP
  standardHeaders: true,
  legacyHeaders: false,
});

// 2. Auth routes (públicas, con rate limit)
app.use("/api/auth/*", authLimiter, authHandler);

// 3. Middleware: validar session para /api/* (excepto /api/auth/*)
const authMiddleware = async (req, res, next) => {
  if (req.path.startsWith("/api/auth/")) return next();
  // Llama a auth.api.getSession() — Better Auth valida la cookie.
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session?.user) {
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }
  req.user = session.user;  // { id, email, default_tenant_id, ... }
  next();
};
app.use("/api", authMiddleware);

// 4. Endpoints: ahora req.user está disponible
app.post("/api/sessions", (req, res) => {
  // Antes: req.body.userId. Ahora: req.user.id (validado).
  const tenantId = new DbAuthProvider(req).getTenantId();
  // ...
});
```

### 4.7. Tests E2E (`test_auth_d3_4.mts`)

```typescript
// Bloque A (3 tests): Tablas auth_* creadas con el schema correcto.
// Bloque B (5 tests): Better Auth puede sign-in con Google (mock OAuth).
// Bloque C (4 tests): authMiddleware rechaza requests sin session.
// Bloque D (3 tests): DbAuthProvider lee tenantId correcto.
// Bloque E (3 tests): rate limit triggea después de N requests.
// Bloque F (3 tests): security headers presentes en responses.
// Bloque G (3 tests): flujo completo: login → /api/sessions POST → logout → request 401.
// Total: 24 tests.
```

**Estrategia de testing del OAuth flow**: Better Auth permite mockear el callback de Google con un `idToken` en lugar del redirect real (visto en doc oficial). Los tests E2E usan este mecanismo para no depender de Google en CI.

### 4.8. Variables de entorno (`.env.example`)

```bash
# Google OAuth
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxx

# Better Auth
BETTER_AUTH_URL=http://localhost:3000
BETTER_AUTH_SECRET=<openssl rand -base64 32>

# DB (ya existente)
WORGENA_DB_PATH=./worgena.db

# Node
NODE_ENV=development
```

---

## 5. Sprint D3.5 — Hardening (1-2 días de dev)

### 5.1. Tareas

| # | Tarea | Archivos | Esfuerzo |
|---|---|---|---|
| 1 | Habilitar plugin `twoFactor` de Better Auth | `src/lib/auth/auth.ts` | 1h |
| 2 | Crear página `/settings/security` con enrollment TOTP (QR) y disable | nueva | 2h |
| 3 | Persistir eventos de auth en `audit_auth` (hook en `auth.handler`) | `src/lib/auth/audit-hook.ts` | 1h |
| 4 | Crear `SECURITY.md` con las prácticas para enterprise | nuevo doc | 1h |
| 5 | Tests E2E: enrollment TOTP → verify → login con TOTP | `test_auth_d3_5.mts` | 2h |
| 6 | Verificar no-regresión: re-correr tests D3.1-3.4 + audit | — | 30 min |

**Total: ~7-8 horas de dev.**

### 5.2. 2FA TOTP — flujo

```
1. User va a /settings/security, click "Activar 2FA".
2. Backend genera secret TOTP (RFC 6238), lo guarda en auth_user.two_factor_secret.
3. Frontend muestra QR (otpauth://totp/Worgena:user@email.com?secret=XXX&issuer=Worgena).
4. User escanea con Google Authenticator / Authy.
5. User ingresa código de 6 dígitos para verificar.
6. Backend verifica con `auth.api.verifyTOTP()`. Si OK, marca auth_user.two_factor_enabled = 1.
7. Próximo login: después de Google OAuth, el frontend redirige a /2fa-verify.
8. User ingresa código. Backend verifica. Si OK, session completa.
9. Si el user pierde el dispositivo, usa uno de los 8 recovery codes (generados al enrollment).
```

### 5.3. `audit_auth` hook

```typescript
// src/lib/auth/audit-hook.ts
import type { Request, Response } from "express";
import { authDb } from "./auth.js";

const AUDITABLE_EVENTS = new Set([
  "/api/auth/sign-in",
  "/api/auth/callback/google",
  "/api/auth/sign-out",
  "/api/auth/two-factor/verify",
]);

export function attachAuditHook(handler: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response) => {
    const event = req.path.replace("/api/auth", "");
    const isAuditable = AUDITABLE_EVENTS.has(event);
    let userId: string | null = null;
    let metadata: Record<string, unknown> = {};
    try {
      await handler(req, res);
      // Si fue sign-in exitoso, extrae el userId del body de la response
      // (Better Auth lo retorna en el body de /sign-in/cookie).
    } catch (e) {
      metadata.error = e instanceof Error ? e.message : String(e);
    } finally {
      if (isAuditable) {
        authDb
          .prepare(
            `INSERT INTO audit_auth (id, user_id, event, ip, user_agent, metadata_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            crypto.randomUUID(),
            userId,
            event.replace(/^\//, ""),
            req.ip,
            req.headers["user-agent"] ?? null,
            JSON.stringify(metadata),
            Date.now(),
          );
      }
    }
  };
}
```

### 5.4. `SECURITY.md` (estructura)

```markdown
# Worgena — Security Practices

Last updated: 2026-06-14

## 1. Data residency and encryption
- DB: Xata (Postgres-compatible, US-East region by default)
- Encryption at rest: AES-256 (Xata built-in)
- Encryption in transit: TLS 1.3 (Railway)
- Secrets: stored in Railway env vars (encrypted at rest)

## 2. Authentication
- Google OAuth 2.0 (no passwords stored)
- 2FA TOTP optional per user
- Session cookies: HttpOnly, Secure (in prod), SameSite=Lax
- Session expiration: 7 days, sliding renewal

## 3. Authorization
- Tenant isolation: every query filtered by tenant_id
- PK constraints: (task_id, tenant_id) compound keys
- Test coverage: 30+ tests for cross-tenant isolation

## 4. Audit trail
- workflow_audit: engine events (start, pause, complete, fail)
- audit_auth: login/logout/2FA events
- step_logs: LLM calls and tool invocations
- All append-only, no destructive operations

## 5. Data export and deletion
- User export: GET /api/me/export → JSON with all user data
- User deletion: soft delete + hard delete after 30 days
- Tenant deletion: cascades to all user data

## 6. Incident response
- SLA: respond to security reports within 24h
- Contact: security@worgena.app
- PGP key: [link]

## 7. Vulnerability disclosure
- Responsible disclosure program
- No bug bounty yet (planned for D6)
- Hall of fame (future)

## 8. Compliance
- Habeas Data Colombia (Ley 1581/2012): DPA on request
- SOC2: not yet (planned for first enterprise > 50 users)
- ISO 27001: not yet
```

---

## 6. Estructura de archivos

```
src/
  lib/
    auth/
      auth.ts                  ← instancia de betterAuth
      handlers.ts              ← authHandler para Express
      audit-hook.ts            ← D3.5: persistir en audit_auth
    db.ts                      ← modificado: migrateAuthTables() idempotente
  agent/
    workflow-engine/
      persistence/
        db-auth-provider.ts    ← DbAuthProvider implements AuthProvider
        auth-provider.ts       ← interface (de D3.3, sin cambios)
server.ts                      ← modificado: helmet, rateLimit, authMiddleware
public/                        ← o templates/
  login.html                   ← botón "Continuar con Google"
  settings/
    security.html              ← D3.5: 2FA enrollment + sessions
test_auth_d3_4.mts             ← 24 tests
test_auth_d3_5.mts             ← 12 tests

SECURITY.md                    ← D3.5: doc para enterprise
HANDOFF.md                     ← log de sprints actualizado
AGENT_ROADMAP.md               ← D3.4-D3.5 añadidos
```

---

## 7. Plan de tests

### D3.4 (24 tests)

| Bloque | Tests | Qué cubre |
|---|---|---|
| A: Schema | 3 | Tablas `auth_user`, `auth_session`, `auth_account`, `audit_auth` existen con columnas correctas. |
| B: OAuth flow | 5 | Better Auth puede sign-in con Google mock. Crea user. Crea session. Retorna cookie. Logout invalida session. |
| C: Middleware | 4 | Request sin cookie → 401. Request con cookie inválida → 401. Request con cookie válida → inyecta `req.user`. `/api/auth/*` no requiere auth. |
| D: DbAuthProvider | 3 | Lee `default_tenant_id` correcto. Lanza si no hay `req.user`. Multi-request lee el de cada request. |
| E: Rate limit | 3 | 30 requests en 5min OK. Request 31 → 429. Reset después de 5min. |
| F: Security headers | 3 | `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` presentes. |
| G: E2E | 3 | Login → POST /api/sessions (con `req.user.id`) → 200. Sin login → POST /api/sessions → 401. Logout → POST /api/sessions → 401. |

### D3.5 (12 tests)

| Bloque | Tests | Qué cubre |
|---|---|---|
| A: 2FA enrollment | 3 | Genera secret + QR. Verifica código TOTP válido → habilita. Código inválido → rechaza. |
| B: 2FA login | 3 | Login con 2FA habilitado → redirige a verify. Verify OK → session completa. Verify 3 veces mal → bloquea 5min. |
| C: Recovery codes | 2 | Genera 8 codes al enrollment. Cada code es single-use. |
| D: audit_auth | 4 | login_success persiste con user_id, ip, user_agent. login_failed persiste sin user_id. logout persiste. TOTP events persisten. |

**Total: 36 tests nuevos** (24 D3.4 + 12 D3.5).

---

## 8. Riesgos y mitigaciones

| # | Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|---|
| 1 | Better Auth cambia API entre versiones | Baja | Alto | Pin a 1.x, lockfile. Test E2E detecta rotura. |
| 2 | Google OAuth callback falla en prod (redirect_uri_mismatch) | Media | Alto | `BETTER_AUTH_URL` documentado, validado al startup. E2E con `idToken` mock evita flakiness en CI. |
| 3 | Session cookie robada (XSS) | Baja | Crítico | HttpOnly + Secure + SameSite=Strict. CSP estricta. Sin scripts inline. |
| 4 | `default_tenant_id` default `'default'` filtra datos entre users | Baja | Alto | El motor ya enforza `tenantId` (D3.2). Tests de aislamiento. |
| 5 | 2FA TOTP recovery codes perdidos | Baja | Medio | Mostrar 1 sola vez al enrollment. "Si perdiste los codes, contactanos". |
| 6 | Rate limit false-positive en IP compartida (oficina) | Media | Bajo | Configurable por env. Log cuando se triguea. Enterprise puede pedir whitelist. |
| 7 | Better Auth lock-in (si queremos migrar) | Baja | Medio | Si migramos, solo cambia `src/lib/auth/*` y `server.ts` middleware. Cero cambio al motor. |
| 8 | DB migration falla (tabla pre-existente con nombre diferente) | Baja | Bajo | Migraciones idempotentes con `CREATE TABLE IF NOT EXISTS`. Si el schema cambió, falla loud con mensaje accionable. |

---

## 9. Criterios de cierre

D3.4 cerrado cuando:
- [x] Login con Google funciona end-to-end en `localhost`.
- [x] Session persiste 7 días.
- [x] Middleware rechaza requests sin session.
- [x] `DbAuthProvider` lee `tenantId` del request.
- [x] Security headers + rate limit activos.
- [x] 24/24 tests pasan.
- [x] Cero regresión en tests D1-D3.3.

D3.5 cerrado cuando:
- [x] 2FA TOTP funciona end-to-end.
- [x] `audit_auth` persiste eventos de auth.
- [x] `SECURITY.md` escrito y revisado por founder.
- [x] 36/36 tests D3.4+D3.5 pasan.
- [x] Cero regresión en tests D1-D3.4.
- [x] `AGENT_ROADMAP.md` actualizado.
- [x] `HANDOFF.md` con log del sprint cerrado.

---

## 10. Forward-compat

| Feature | Cuándo entra | Por qué se difiere |
|---|---|---|
| **SSO/SAML** | D3.6+ (cuando llegue el primer enterprise > 50 usuarios que lo pida) | Costo de implementar: 1 semana. Demanda actual: 0. |
| **Magic links por email** | D3.6+ (si Google decide no aceptar o un user pide email-only) | Costo: 2 días. Demanda: 0. |
| **Password login** | D3.6+ (si un enterprise pide por compliance interno) | Costo: 1 día. Demanda: 0. |
| **Multi-tenant user pool** (1 user en N firmas) | D6 (cuando entre el editor y la gestión de equipos) | Cambio de modelo de datos. |
| **2FA forzado por admin** | D3.6+ (cuando un enterprise quiera forzar 2FA a sus users) | 1 línea de config + UI. |
| **Email transaccional** (Resend / Postmark) | D3.6+ (cuando tengamos magic links o alertas de seguridad por email) | Costo: $0-20/mes. Aplica regla 11 (consultar antes). |
| **Sentry** (error tracking) | D3.6+ (recomendado; si auth falla en prod, hay que enterarse) | Costo: $0-26/mes. Aplica regla 11. |
| **Migración a Postgres/Xata** | D4+ (cuando entre RAG con pgvector) | Mejor Auth tiene adapter Postgres oficial. Cambio local. |

---

## 11. Decisiones diferidas / open questions

1. **¿Forzar 2FA a TODOS los users o solo opt-in?** Mi recomendación: opt-in en D3.5, forzado por tenant (config por firma) en D3.6+. **Decisión founder**: acepto opt-in por ahora.
2. **¿Cuántos recovery codes generar al enrollment TOTP?** 8 es estándar (Authy, Google). 10 da más redundancia. **Decisión**: 8.
3. **¿Rotar el `BETTER_AUTH_SECRET` automáticamente?** No en D3.5. Manual via env var, documentado en SECURITY.md. Forward-compat: rotación automática en D3.6+ con doble-secret + grace period.
4. **¿Soft delete o hard delete del user al "delete account"?** Soft delete por 30 días (reversible), hard delete después. **Decisión**: soft delete, documentado en SECURITY.md §5.
5. **¿Branding de la pantalla de login?** D3.4: HTML básico con un "Continuar con Google" botón. D3.6+: branding del bufete. **Decisión**: minimalista en D3.4, se pule cuando lleguemos al editor (D6).

---

## 12. Referencias

- `AGENT_D3_3_AUTH_SWEEPER_AUDIT_SPEC.md` — D3.3 introduce `AuthProvider` interface.
- `AGENT_D3_2_MULTI_TENANT_SPEC.md` — D3.2 introduce el `tenantId` enforcement.
- `AGENT_D3_1_STORAGE_PERSISTENCE_SPEC.md` — D3.1 introduce el `TaskStore` y `paused_tasks`.
- `AGENT_ROADMAP.md` — D3 cerrado, D3.4-D3.5 planificados.
- `AGENTS.md` — Regla 11: servicios de terceros consultados antes.
- `src/agent/workflow-engine/persistence/auth-provider.ts` — Interface del provider.
- `src/lib/db.ts` — Wrapper pg-style sobre SQLite (hoy).
- `server.ts` — Express server.
- https://www.better-auth.com/docs/authentication/google — Doc oficial Google provider.
- https://www.better-auth.com/docs/adapters/sqlite — Doc oficial SQLite adapter.
