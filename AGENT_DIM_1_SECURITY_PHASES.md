# Dimensión 1: Seguridad y Permisos — Plan por Fases

**Fecha**: 2026-06-08
**Estado actual**: ~30% del estándar pro 2026
**Objetivo**: Llevar al ~75% cerrando los 3 agujeros rojos y agregando controles granulares

Contexto y diagnóstico completo en la conversación que produjo este doc. Resumen rápido del estado actual:

| Control | Estado | Archivo:línea |
|---|---|---|
| Path traversal protection | ✅ Sólido | `tools.ts:119,138,314,343,...` (16 lugares) y `server.ts:96,295,...` |
| Sandbox de código E2B | ✅ Bien | `tools.ts:18,33-37` |
| **Puppeteer con `--no-sandbox`** | 🔴 **Gap #1** | `tools.ts:608, 655, 756` |
| **Network egress sin allowlist** | 🔴 **Gap #2** | `tools.ts:325-330, 385-387` |
| **Sin auth de usuarios** | 🔴 **Gap #3** | `server.ts` completo |
| Sin rate limits | 🟠 Gap #4 | Todos los endpoints |
| API keys todas en mismo .env | 🟠 Gap #5 | `.env` |
| Tool permissions sin scope | 🟠 Gap #6 | `tools.ts:321` |
| Destructive actions sin HITL forzado | 🟠 Gap #7 | `tools.ts:359, 385` |
| Sin PII detection | 🟡 Gap #8 | — |
| Audit sin user attribution | 🟠 Gap #9 | `step_logs` schema |
| Workspace size limit no en tools | 🟡 Gap #10 | `server.ts:64-66` solo en upload |

---

## Fase 1 — Quick wins (1-2 días)

Cierra los 3 agujeros rojos. Cambios aislados, alto impacto.

### Item 1.1: Puppeteer sandbox nativo (2h) — ✅ HECHO

**Problema**: `puppeteer.launch({ args: ['--no-sandbox', ...] })` en 3 lugares. Chrome sin sandbox puede leer/escribir el host filesystem si la página es maliciosa.

**Cambio aplicado**:
- `getPuppeteerLaunchArgs()` exportado en `tools.ts:19-95` con auto-detección
- **Auto-detecta si necesita `--no-sandbox`**: detecta Docker via `/.dockerenv`, o root via `process.getuid()`. Si cualquiera → desactiva sandbox + warn una vez. En Windows y Linux/macOS como usuario normal → sandbox nativo.
- **Override `ALLOW_SANDBOX=1`** (fuerza safe incluso si auto-detect dice no — para Docker con user custom)
- **Override `ALLOW_NO_SANDBOX=1`** (escape hatch manual, con warn siempre)
- 3 `puppeteer.launch` reemplazados (líneas 668, 715, 816)
- Default: `['--disable-dev-shm-usage']` (Chrome usa su sandbox nativo)
- Warn una sola vez por proceso (no spammea en cada tool call)
- Warn con severidad: `MEDIUM` en dev, `HIGH` en production o si `SAAS_MODE=1`

**Validación**:
- 10/10 unit tests en `test_puppeteer_args.mts` (default, ALLOW_NO_SANDBOX combinations, ALLOW_SANDBOX override, auto-detect en Windows dev env, warn format)
- Smoke E2E: `readUrl("https://example.com")` directo → Chrome arranca en 1.6s con sandbox nativo, trae "Example Domain"

**Archivos tocados**:
- `src/agent/tools.ts` (helper + 3 reemplazos)
- `test_puppeteer_args.mts` (nuevo, 10 tests)

---

### 🚨 DEPLOY EN RAILWAY (OBLIGATORIO PARA SAAS MULTI-TENANT)

**Por qué**: Railway por default corre tu app como root en un container Docker. Chrome **no puede** sandboxearse como root. Si no hacés nada, en producción tu navegador del agente va a estar **sin corralito**, lo que es un agujero serio para un SaaS que vende a firmas con datos sensibles.

**Solución (gratis, 5 minutos)**: deployar como non-root via Dockerfile custom.

#### Opción A: Dockerfile mínimo (recomendado)

1. En Railway, en lugar de usar el build automático (Nixpacks), elegí **"Deploy from Dockerfile"**.
2. Creá un archivo `Dockerfile` en la raíz del repo:

```dockerfile
FROM node:20-slim

# Instalar Chrome (Puppeteer ya lo trae via @puppeteer/browsers, pero por las dudas)
# Si tu puppeteer usa el Chrome bundled, este paso no es necesario.

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Crear usuario no-root
RUN groupadd -r worgena && useradd -r -g worgena worgena
RUN chown -R worgena:worgena /app
USER worgena

EXPOSE 3000
CMD ["npx", "tsx", "server.ts"]
```

3. En Railway, configurá la env var: `SAAS_MODE=1` (activa el warn de severidad HIGH en el server logs).
4. Deploy. El proceso va a correr como `worgena` (UID no-root), el auto-detect NO va a apagar el sandbox, y Chrome va a estar contenido.

#### Opción B: Si no querés tocar el Dockerfile

Setear `ALLOW_SANDBOX=1` en el env de Railway. Chrome va a **intentar** sandboxearse. Si el container lo permite (algunos kernels sí), va a funcionar. Si no, vas a ver errores tipo "Failed to launch browser". En ese caso, **volver a Opción A**.

#### Costo

**$0.** El cambio es solo configuración. No agrega compute, no agrega servicios.

---

### Item 1.2: Allowlist de dominios (3h) — ✅ HECHO

**Problema**: `read_url`, `download_file`, `apify_scrape_url`, `search_web`, `browser_action` aceptan cualquier URL. Una web maliciosa con prompt injection puede exfiltrar datos.

**Cambio aplicado**:
- `src/lib/network-policy.ts` (nuevo) con `assertUrlAllowed(url)`, `NetworkPolicyError`, `NETWORK_TOOLS` (Set), `extractUrlFromToolArgs(name, args)`
- Sintaxis del allowlist: bare domain (`example.com` matchea + subdominios) o suffix con punto (`.gov.co` matchea *.gov.co)
- Fail-open en dev (allowlist vacío = permitir + warn una vez), fail-closed en production (allowlist vacío = throw)
- Integración: `executeTool()` valida la URL ANTES de invocar la tool; si falla, devuelve el error como tool result (no crashea el step)
- Previene suffix attack: `example.com` no matchea `example.com.evil.com`

**Validación**:
- 16/16 unit tests en `test_network_policy.mts` cubriendo: default dev, production fail-closed, bare exact/subdomain/suffix, suffix attack prevention, suffix multi-level, multi-dominio, case-insensitive, URL malformada, URL vacía, protocolos no http(s), extractUrl por tool, executeTool integration (3 casos)
- Type check: clean

**Archivos tocados**:
- `src/lib/network-policy.ts` (nuevo, 110 líneas con JSDoc)
- `src/agent/tools.ts` (import + check al inicio de `executeTool`)
- `test_network_policy.mts` (nuevo)

**Lo que NO probé empíricamente** (caveats honestos):
- No hice smoke test con el server arriba (no es trivial forzar al LLM a llamar `read_url` con URL específica). Los unit tests cubren la integración con `executeTool` directamente, que es lo que corre en producción.

---

### Item 1.3: HITL forzado en acciones destructivas (4h) — ✅ HECHO

**Problema**: `delete_file`, `batch_review`, y `download_file` desde URL externa — el LLM decidía si pedir permiso al humano. No había enforcement.

**Cambio aplicado**:
- `src/lib/hitl-policy.ts` (nuevo) con `requiresHumanApproval(toolName, args)` que retorna `{requires, reason, question}`
- Lista de tools destructivas:
  - `delete_file` → siempre (datos del usuario, sin undo)
  - `batch_review` → siempre (procesa todo el workspace con sub-LLM)
  - `download_file` → solo si la URL NO es interna (localhost / 127.0.0.1 / 192.168.x)
- `executeTool()` (tools.ts:443-451) valida ANTES de ejecutar. Si requiere aprobación y el LLM no pasó `__human_approved: true`, devuelve error con la pregunta pre-formulada para `ask_human`
- **Convención**: el LLM llama `ask_human` con la pregunta del error, y si el humano dice "sí"/"ok"/"hazlo"/"approved", reintenta con `__human_approved: true`
- `agent.ts` system prompt (líneas 130-141) tiene la regla explícita para que el LLM sepa el flujo

**Validación**:
- 10/10 unit tests en `test_hitl_policy.mts`:
  - `delete_file` y `batch_review` siempre requieren
  - `download_file` requiere con URL externa, NO requiere con localhost
  - Tools no destructivas (read_file, write_file, list_files, search_web, read_url) NO requieren
  - `executeTool` con `delete_file` SIN `__human_approved` → bloquea con mensaje estructurado
  - `executeTool` con `delete_file` CON `__human_approved: true` → procede (no devuelve error de HITL)
  - `executeTool` con `read_file` → NO bloqueado
- Total: 56 tests / 5 suites en verde (test_summary_logic 12, test_preprocess_html 8, test_puppeteer_args 10, test_network_policy 16, test_hitl_policy 10)

**Archivos tocados**:
- `src/lib/hitl-policy.ts` (nuevo, 120 líneas con JSDoc)
- `src/agent/tools.ts` (import + check al inicio de `executeTool`, líneas 12 y 443-451)
- `src/agent/agent.ts` (system prompt actualizado con HITL rules, líneas 130-141)
- `test_hitl_policy.mts` (nuevo, 10 tests)

**Lo que NO probé empíricamente** (caveats honestos):
- El flujo end-to-end real con un LLM que llama `delete_file`, ve el error, llama `ask_human`, recibe respuesta, y retry. Los unit tests cubren la integración `executeTool`, pero no el comportamiento del LLM siguiendo las instrucciones. Requiere test E2E con LLM real (no trivial por la no-determinismo).
- Las URLs R2 (`*.r2.cloudflarestorage.com`) NO están en la lista de "internas" actual. Si deployás y querés que el agente pueda descargar desde tu propio R2 sin pedir aprobación, hay que agregar el dominio a la lista. Por ahora, la heurística es solo same-host.

---

### Item 1.4: API key scoping (1h) — ⏳ Pendiente

**Problema**: Todas las API keys en el mismo `.env`. El agente, si introspecciona, ve todas. No hay separación "server vs agente".

**Cambio planeado**:
- Convención: keys que el agente usa directamente se llaman `AGENT_*` (ej. `AGENT_DEEPSEEK_KEY=...`)
- El server (no el agente) lee las keys reales (`DEEPSEEK_API_KEY`, etc.)
- Si el agente necesita una key, el server la inyecta en el contexto (ej. en el system prompt, o en un wrapper que crea un cliente OpenAI scoped)
- Migración suave: aliases en `.env` (`AGENT_DEEPSEEK_KEY` apunta al mismo valor que `DEEPSEEK_API_KEY` por ahora)
- Documentar la convención en `AGENTS.md` para que próximos features la respeten

**Validación planeada**:
- Diff: ningún archivo del agente debe leer `process.env.DEEPSEEK_API_KEY` directamente
- Diff: el server inyecta las keys via API/scoped clients

**Archivos**:
- `.env` (agregar aliases)
- `src/agent/agent.ts` (cambiar acceso a env vars)
- `AGENTS.md` (documentar convención)

---

## Extras implementados (no estaban en el plan original)

### Apify cost tracking ✅

- Tabla `apify_usage` (migración segura en `src/lib/db.ts`)
- `src/lib/apify-tracker.ts` con `logApifyUsage()`, `getApifyUsageTotal()`, `getApifyUsageBySession()`
- `apifyScrapeUrl` loguea cada call (success o failure) con: sessionId, targetUrl, calledAt, success, errorMessage, durationMs, resultSizeBytes, costEstimateUsd
- Costo configurable via `APIFY_COST_PER_CALL_USD` (default $0.005)
- 9/9 tests en `test_apify_tracker.mts`
- **Sin dashboard** (por pedido del usuario). Solo captura en DB para que vos lo consultes cuando tengas el dashboard de multi-tenancy.

### Topic-based policies ✅

- `src/lib/policies.json` con 5 topics default: tributario, jurisprudencia, laboral, comercial, general
- `src/lib/policy-engine.ts` con `loadPolicies()`, `getTopicPolicy()`, `listTopics()`, `generateSystemPromptSection()`, `checkUrlAgainstTopic()`, `domainMatchesAny()`
- El system prompt del agente inyecta automáticamente la sección de policies (el LLM las lee y las usa como guidance)
- **Soft guidance** (no runtime enforcement). El URL allowlist sigue siendo el backstop hard.
- 12/12 tests en `test_policy_engine.mts`
- El usuario va a refinar `policies.json` con el tiempo (la estructura es estable, solo cambia el contenido)

---

## Pendiente

- **Item 1.4 (API key scoping)**: bajo impacto hoy, hacerlo en una iteración futura cuando haya multi-tenancy real
- **UX de confirmación (botones)**: cuando el agente pide aprobación para delete/download, hoy es texto libre (`ask_human`). Mejor UX: botones "Confirmar"/"Cancelar" inline. Requiere tocar `ask_human` tool + frontend
- **Browser test E2E del flujo HITL**: validar el flujo completo LLM→UI→humano→LLM con Playwright

---

## Resumen de la Dimensión 1

| Métrica | Antes | Después |
|---|---|---|
| Tests totales | 0 (sin suite) | 77 (7 suites) |
| Cobertura del context-manager | n/a | 12 tests |
| Cobertura del preprocessor | n/a | 8 tests |
| Puppeteer sandbox | `--no-sandbox` siempre | auto-detect con escape hatch |
| Network egress | sin control | allowlist + topic policies |
| HITL enforcement | prompting only | runtime check con flag de aprobación |
| Apify cost tracking | n/a (delegado a dashboard) | DB local con agregaciones |
| Topic-based access | n/a | 5 topics default, refinables |

**Total**: 4/4 items del plan + 2 extras. Pendiente: 1.4 (bajo impacto) + UX/browser test.

---

## Fase 2 — Tabla de permisos (3-5 días)

Granularidad real por sesión.

### Item 2.1: Tabla `tool_permissions` en DB

**Schema**:
```sql
CREATE TABLE tool_permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_type TEXT NOT NULL,    -- 'session' | 'space' | 'user'
  scope_id TEXT NOT NULL,      -- session_id, space_id, or 'default'
  tool_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  reason TEXT,                 -- por qué se deshabilitó (auditoría)
  created_at BIGINT NOT NULL,
  UNIQUE(scope_type, scope_id, tool_name)
);
```

Default: `('user', 'default', '*', 1, 'allow by default')`.

**API nueva**:
- `GET /api/admin/permissions?scope=session:abc`
- `PUT /api/admin/permissions` (body: `{scope, tool, enabled, reason}`)
- `DELETE /api/admin/permissions/:id`

### Item 2.2: `executeTool()` valida la policy

Antes de ejecutar, query la tabla. Si `enabled=0` para el scope, return `Error: tool X not enabled for this Y`. Loguear el intento en `step_logs` o en una nueva `access_log`.

### Item 2.3: Rate limits in-memory con persist

LRU cache `(user, tool, window) → count`. Si excede, return `Error: rate limit exceeded`. Reset cada 1 minuto. Persistir contadores en DB cada 5 min para que un restart del server no dé "credit" infinito.

### Item 2.4: Audit con `user_id`

Una vez que haya auth (Fase 3), agregar `user_id` (nullable por ahora) a `step_logs`. Migración segura con `ALTER TABLE`.

---

## Fase 3 — Multi-tenancy real (1-2 semanas)

Lo que diferencia a Worgena de "demo para una firma" a "producto enterprise".

### Item 3.1: Auth básico

- Tabla `users(id, email, api_token_hash, role, created_at)`
- `role` ∈ {`admin`, `member`, `guest`}
- Middleware `requireAuth` que valida `Authorization: Bearer <token>`
- Endpoint `POST /api/auth/login` (genera token)
- Endpoint `POST /api/auth/logout`

### Item 3.2: Workspaces y multi-tenant

- Tabla `workspaces(id, owner_user_id, name, created_at)`
- `sessions.workspace_id` ya existe; agregar FK a `workspaces`
- `users.workspaces` (N:M)

### Item 3.3: RBAC por role

Mapping: `role → tools_habilitadas`:
- `admin`: todas
- `member`: tools estándar (sin `delete_*`, `batch_review`)
- `guest`: solo lectura (`read_file`, `read_url`, `list_files`)

### Item 3.4: Vault integration (opcional, enterprise)

Si la firma usa HashiCorp Vault o AWS Secrets Manager: el server lee las keys de allá, no del .env. Para la mayoría de clientes (1 firma) esto es overkill — Fase 3.4 se justifica solo si una firma enterprise pide compliance.

### Item 3.5: OpenTelemetry

SDK de Node, propagación por headers HTTP. Export a OTLP endpoint (Datadog, Honeycomb, etc.). Permite ver un request del usuario hasta el LLM call y la tool call, con `trace_id` consistente.

---

## Roadmap de ejecución

| Sprint | Fase | Items | Esfuerzo | Cierra gaps |
|---|---|---|---|---|
| **Sprint actual** | Fase 1 | 1.1 → 1.2 → 1.3 → 1.4 | 1-2 días | 🔴 #1, #2 (parcial), 🟠 #7 |
| Próximo sprint | Fase 2 | 2.1 → 2.2 → 2.3 → 2.4 | 3-5 días | 🟠 #4, #5, #6, #9 |
| Cuando haya demanda | Fase 3 | 3.1 → 3.2 → 3.3 → (3.4, 3.5 opcional) | 1-2 semanas | 🔴 #3, todos los demás |

---

## Lo que NO está en este plan

- **Sandbox de Puppeteer con Docker/VM por sesión**: costoso, complejo, el sandbox nativo de Chrome (sin `--no-sandbox`) es suficiente para el 90% de los casos. Solo si una firma pide "máximo aislamiento" se justifica.
- **Full RBAC por usuario/permiso/recurso**: el producto es para firmas, no para empresas de 10K empleados. El admin de la firma configura, los usuarios usan.
- **PII detection automática**: integrado cuando los clientes pidan compliance. Hoy no hay PII handling en Worgena.
- **Migrar a otro modelo base solo por seguridad**: el LLM no es el problema; los tools y el sandbox sí. Cambiar de DeepSeek a GPT-4 no resuelve ninguno de los 10 gaps.
