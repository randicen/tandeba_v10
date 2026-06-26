# P0 #4 — Billing v1 Spec (ePayco Colombia)

> Cierra: **P0 #4 (planes + credits + billing)** de `BACKLOG_P0.md`.
> Spec vivo: se actualiza durante implementación si se descubre scope que faltaba.
> Sprint corto, estimado 3-5 días de un dev (Wozniak-style: primitivas primero, demo después).

---

## 1. Contexto

Worgena cerró D3.4 redesign multi-tenant (commit `fd80b1d`) y hoy cualquier user autenticado puede crear/unirse a una firma. Pero el sistema **no puede cobrar**. Sin billing:

- No podemos tomar el primer cliente pagando.
- `cost_attribution` (P0 #3) registra uso LLM por tenant pero no metrea ni enforza.
- Un cliente con plan $10 USD/mes puede generar $1000 de LLM en 1h y el sistema no se entera.

**Decisión bloqueante ya cerrada** (founder, 2026-06-25): pasarela = **ePayco** (Davivienda). Razón: subscriptions nativas con dunning automatizado, persona natural con RUT sin SAS, encaja con stack TypeScript, soporta todos los métodos B2B colombianos. Razón completa + 19 fuentes: `C:\Users\acer\Downloads\asistente IA\untitled\Asesoría Steve\2026-06-25_decision_pasarela_pagos_colombia.md`. Lección CTO del 2026-06-25: en early-stage, **simplicidad de implementación > optimización marginal de fees**.

**Lo que habilita este sprint**: revenue recurrente desde el día 1. Worgena pasa de "SaaS gratis" a SaaS con planes + wallet + enforcement LLM por balance.

**Lo que bloquea si no se hace**: no podemos operar comercialmente. `BACKLOG_P0.md` §4 sigue abierto.

---

## 2. Objetivos (qué SÍ se hace)

- **O1. Schema Postgres-compatible para billing**. Tablas: `plans`, `firm_subscriptions`, `credit_ledger`, `credit_packs`, `wallet_purchases`, `auto_recharge_config`. Migrations idempotentes en `src/lib/db.ts`. Forward-compat: 100% compatible con migración futura a Postgres (TEXT, INTEGER, sin AUTOINCREMENT/JSONB/VARCHAR — ver AGENTS.md §15).
- **O2. Servicio de billing local** (`src/lib/billing/billing.ts`). Funciones: `getCreditBalance(firmId)`, `consumeCredit(firmId, amount, reason, meta)`, `grantCredit(firmId, amount, reason, meta)`, `hasActivePlan(firmId)`, `getCurrentPlan(firmId)`, `changePlan(firmId, planId)`. Todas las funciones de mutación de balance escriben a `credit_ledger` (append-only). Backward-compat: si `credit_ledger` no tiene row, balance = 0.

  **Conversión credit↔USD** (constante en código): `1 crédito = $0.01 USD = 100 créditos por USD`. Helper: `usdToCredits(usd: number): number` y `creditsToUsd(credits: number): number`. Default configurable vía `CREDIT_USD_RATE` en `.env` (forward-compat si se revalúa la economía de la unidad). `consumeCredit` recibe `amountUsd` (en USD) y lo convierte a créditos con `Math.ceil()` para no sub-pagar. La LLM enforcement compara `costUsd * CREDIT_USD_RATE <= getCreditBalance(firmId)`.

  **Plan free default**: si un firm no tiene row en `firm_subscriptions`, se trata como plan_free. Helper `hasActivePlan(firmId)` retorna `true` si (a) firm no tiene subscription y plan_free existe, o (b) firm tiene subscription `active` con `current_period_end > now`. Si retorna `false` (firm con subscription past_due o cancelled sin periodo vigente), `consumeCredit` lanza `INSUFFICIENT_CREDITS`. El plan free grants 100 créditos automáticamente al primer `getCreditBalance` de un firm nuevo (idempotente via `reason='plan_grant'` con check previo).

- **O2.bis. Constante `CREDIT_USD_RATE` y helpers de conversión** (en `src/lib/billing/conversion.ts`). Exporta `usdToCredits(usd)`, `creditsToUsd(credits)`, `CREDIT_USD_RATE` (default 100). Tests unitarios incluidos.
- **O3. Integración ePayco con subscriptions nativas** (`src/lib/billing/epayco-client.ts`). Cliente HTTP custom en TypeScript (mismo patrón que `OpenRouterLLMInvoker` — fetch directo, NO SDK pesado). Endpoints usados: `customers.create`, `plans.create`, `subscriptions.create`, `subscriptions.cancel`, webhooks de eventos de subscripción. Config: `EPAYCO_PUBLIC_KEY`, `EPAYCO_PRIVATE_KEY`, `EPAYCO_TEST_MODE` en `.env`. **Trade-off declarado**: el SDK oficial `epayco-sdk-node` (v1.4.4) existe y es estable, pero el fetch directo nos da type-safety y control de errores. Decisión final en §5.
- **O4. LLM enforcement por balance** (en `OpenRouterLLMInvoker.invoke()`). Después de `resolveCost(...)` y ANTES de retornar, chequea: `getCreditBalance(tenantId) >= costUsd`. Si falla: throw `OpenRouterError` con `code: "INSUFFICIENT_CREDITS"`, `retriable: false`, mensaje accionable. Si pasa: `consumeCredit(tenantId, costUsd, 'llm_call', { llmCallAuditId })` (atómico con el `recordLLMCall` del audit). Test: firm con balance 0 → segunda llamada LLM rechaza con `INSUFFICIENT_CREDITS`.
- **O5. Endpoints REST** (en `server.ts`):
  - `GET /api/billing/plans` (**PÚBLICO**, sin authMiddleware — precios son marketing). Lista planes activos.
  - `GET /api/billing/me` (autenticado, retorna `{plan, balance, nextBillingDate, currentPeriodEnd}`).
  - `POST /api/billing/subscribe` (autenticado, body `{planId, paymentMethodToken?}`, crea `firm_subscriptions` + ePayco subscription, retorna checkout URL si requiere acción del cliente).
  - `POST /api/billing/cancel` (autenticado, owner only, marca `cancel_at_period_end`).
  - `GET /api/billing/usage?from=&to=` (autenticado, lee de `credit_ledger` agregado).
  - `GET /api/billing/wallet` (autenticado, retorna balance + packs disponibles + historial de últimas N compras).
  - `POST /api/billing/wallet/purchase` (autenticado, body `{creditPackId}`, crea `wallet_purchases` con status `pending`, dispara cobro en ePayco, retorna checkout URL).
  - `POST /api/webhooks/epayco` (**PÚBLICO**, sin authMiddleware — usa verificación de firma HMAC). Procesa eventos de subscripción y de cobros de wallet.

  **Auth skip**: el `authMiddleware` actual (en `src/lib/auth/handlers.ts`) skipea paths que empiezan con `/auth/`, `/health`. Hay que agregar `/webhooks/` y `/billing/plans` al skip list (o montar el webhook endpoint ANTES del `app.use("/api", authMiddleware)`). El webhook endpoint DEBE ser público: ePayco no sabe autenticar con cookies, solo verifica firma HMAC.
- **O6. Webhook handler con verificación de firma** (`src/lib/billing/epayco-webhook.ts`). Lee el header `x-signature` de ePayco (algoritmo HMAC-SHA256 sobre el body, con `EPAYCO_PRIVATE_KEY` como secret). Si la firma no valida: 401, NO loguear el body. Si valida: encola un job (in-process queue v1, jobs system completo v2) para procesar el evento asíncrono. Responde 200 en <30s (constraint de ePayco).
- **O7. Wallet de créditos** (funcionalidad básica, no auto-recharge). Schema: `credit_packs` con 3 packs predefinidos al seed (100/500/2000 créditos a COP $10K/$45K/$160K). Endpoint de purchase + ledger entry. Auto-recharge queda en §3 (NO-objetivo de este sprint).
- **O8. Tests E2E** (en `test_billing_v1.mts`): 20+ tests que cubren schema, balance computation, plan change, LLM enforcement, webhook signature validation, end-to-end flow (subscribe → webhook → plan active → LLM call balance decremented).

---

## 3. No-objetivos (qué NO se hace)

> Crítico. Esta sección es lo que evita scope creep. Todo lo que no esté en §2 es NO-objetivo.

- **NO-1. Jobs system completo (P0 #5)**. Para v1, los webhooks se procesan in-process con una `Promise` queue interna. NO se crea la tabla `jobs`, NO se enchufa el worker loop, NO se crea el job type `send_invitation_email`. Eso es un sprint separado (P0 #5, paralelo). Justificación: ePayco subscriptions son nativas, no necesitamos cron propio. **Lección CTO del 2026-06-25 (Jobs = bloqueante) ya NO aplica con ePayco**.
- **NO-2. Auto-recharge del wallet**. Schema y endpoints sí (O7), pero la lógica de auto-detect "balance bajo → cobrar" NO. Eso requiere periodic jobs. Diferible a P0 #5 + sprint billing v2.
- **NO-3. DIAN facturación electrónica**. Cuando Worgena sea SAS y facture B2B, hay que cablear un operador autorizado (Factus, Lemp, EDICOM, Siigo, Alegra, Datium). Sprint adicional post-SAS, no bloqueante para v1. v1 emite comprobantes internos via `credit_ledger` (es el audit trail).
- **NO-4. Multi-currency**. v1 es COP-only. Si en el futuro Worgena expande a LatAm (Mexico, Peru, Chile), se evalúa agregar segunda pasarela (Wompi, Mercado Pago, PayU) y multi-currency. Forward-compat: el campo `currency` en `credit_ledger` y `credit_packs` está en el schema desde día 1.
- **NO-5. UI de billing / checkout**. v1 expone los endpoints REST. La UI (página de planes, formulario de tarjeta, dashboard de uso) es un sprint de frontend separado. Para el primer cliente, el founder puede usar la API directamente o mandar un link de checkout de ePayco.
- **NO-6. Plan changes con proration**. v1 permite upgrade/downgrade solo al final del periodo (`cancel_at_period_end` + subscribe al nuevo plan). Proration automática es ePayco-feature (la tienen pero requiere integrarla); v2.
- **NO-7. Refunds / disputes**. El endpoint de refund existe en ePayco; Worgena lo cablea solo si el cliente lo pide. No es flujo de v1.
- **NO-8. Migración a Postgres**. v1 corre en SQLite (decisión vigente hasta primer trigger: primer cliente pagando + multi-instancia + >5GB DB). Schema ya es portable (ver AGENTS.md §15). Migración es swap de adapter de `db.ts`.
- **NO-9. Migración de tenants existentes al plan free**. Cuando abramos billing, todos los firms existentes (probablemente 0 o few en dev) arrancan en plan `free` con 0 créditos. El plan free no requiere cobro, es el "demo" implícito. Forward-compat: el plan free existe en `plans` desde el seed.
- **NO-10. Wompi como segunda pasarela**. Si el volumen crece o expandimos LatAm, agregamos Wompi. v1 es ePayco-only.

---

## 4. Primitivas no negociables

> Estas son las que NO se skipean aunque "lleven tiempo". Si se skipean, el motor pasa de demo a deuda.

- **P1. Idempotencia del webhook handler**. ePayco puede mandar el mismo evento 2+ veces (retry por timeout, red). El handler DEBE ser idempotente: cada evento se procesa una sola vez. Implementación: tabla `webhook_events` (id, provider, external_event_id, received_at, status) con UNIQUE en `(provider, external_event_id)`. El handler hace INSERT IGNORE; si ya existe, retorna 200 sin reprocesar.
- **P2. `credit_ledger` es append-only, NUNCA UPDATE/DELETE**. Source of truth del balance. La mutación es siempre INSERT. El balance se computa con `SELECT SUM(delta) FROM credit_ledger WHERE firm_id = ?`. Forward-compat: cualquier sistema externo (Paddle, Stripe, lo que sea) puede re-derivar el balance desde el ledger. Test: `test_billing_v1.mts` A1-A4 verifican que UPDATE/DELETE sobre `credit_ledger` rompe tests.
- **P3. `consumeCredit` y `grantCredit` son atómicos**. Un `BEGIN; SELECT SUM(delta) ...; INSERT ...; COMMIT;` con `db.transaction()` (better-sqlite3). Si el balance no alcanza, el INSERT falla y se retorna error. Race condition: dos calls LLM concurrentes contra el mismo firm con balance justo = uno pasa, el otro falla. Aceptable (cliente reintenta). **Cross-process forward-compat** (Postgres): el patrón SQLite single-writer NO se traslada. Cuando se migre a Postgres, agregar advisory lock por `firm_id` en el transaction, o usar `INSERT ... WHERE NOT EXISTS` pattern con `SELECT FOR UPDATE`. Documentar en HANDOFF al migrar.
- **P4. Verificación de firma del webhook ANTES de cualquier side-effect**. Si la firma no valida, NO escribir a DB, NO loguear body, retornar 401. Header `x-signature` con HMAC-SHA256 sobre el raw body. Test obligatorio: webhook con firma inválida → 401, ningún side-effect.
- **P5. Multi-tenancy en TODO endpoint nuevo**. Cada query a `firm_subscriptions`, `credit_ledger`, `credit_packs`, `wallet_purchases` filtra por `firm_id` (= `req.activeFirmId`). Backward-compat con D3.4: `authMiddleware` ya inyecta `activeFirmId`. Test: cross-tenant access a `credit_ledger` retorna 403, no leak.
- **P6. Schema Postgres-compatible**. Todo lo nuevo cumple AGENTS.md §15. `credit_ledger` con `INTEGER` (no REAL para deltas — los deltas son enteros positivos/negativos), `TEXT` para IDs y strings, `JSON.stringify()` para metadata_json. **Cero `AUTOINCREMENT`, cero `VARCHAR(n)`, cero `JSONB`, cero `TIMESTAMP`**. Test de portabilidad: `mgrep` no encuentra features SQLite-specific en las nuevas migrations.
- **P7. LLM enforcement es fail-loud, no fail-silent**. Si el chequeo de balance falla por un error de DB (no por insuficiencia de créditos), el invoker DEBE throwear. No se silencia el error para "no romper el flow". El motor propaga al usuario final. Log estructurado para que ops investigue.
- **P8. Audit de toda mutación de balance en `credit_ledger`**. Cada `consumeCredit` y `grantCredit` registra `reason` (ENUM), `llm_call_audit_id` (cuando aplica), `created_at`. Permite forensics: "qué le pasó al balance de este firm en este periodo".

---

## 5. Diseño (alto nivel)

```
┌─────────────────────────────────────────────────────────────────┐
│                        WORGENA STACK                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐   ┌──────────────────┐   ┌────────────────┐  │
│  │  Chat agent  │──▶│ OpenRouterLLM    │──▶│  OpenRouter    │  │
│  │  (D1)        │   │ Invoker          │   │  (LLM)         │  │
│  └──────────────┘   └────────┬─────────┘   └────────────────┘  │
│                              │  P7: check                     │
│                              │  P3: consumeCredit             │
│                              ▼                                 │
│                    ┌──────────────────┐                        │
│                    │ credit_ledger    │ (append-only)          │
│                    │ (SQLite)         │                        │
│                    └────────┬─────────┘                        │
│                             │                                  │
│  ┌──────────────┐          │  webhook (P4)                    │
│  │  /api/       │─────────▶│                                  │
│  │  webhooks/   │          ▼                                  │
│  │  epayco      │   ┌──────────────────┐                       │
│  └──────────────┘   │ epayco-webhook   │                       │
│                     │ (in-process)     │                       │
│  ┌──────────────┐   └────────┬─────────┘                       │
│  │  /api/       │            │                                 │
│  │  billing/*   │──┬─────────┤                                 │
│  └──────────────┘  │         │                                 │
│                   ▼         ▼                                 │
│           ┌──────────────────────────┐                         │
│           │  billing.ts              │                         │
│           │  getCreditBalance        │                         │
│           │  consumeCredit (P3)      │                         │
│           │  grantCredit             │                         │
│           │  getCurrentPlan          │                         │
│           │  changePlan              │                         │
│           └────────┬─────────────────┘                         │
│                    │                                           │
│                    ▼                                           │
│           ┌──────────────────────────┐                         │
│           │  epayco-client.ts        │                         │
│           │  (fetch directo)         │──▶ ePayco API          │
│           │  customers/plans/        │    (api.epayco.co)     │
│           │  subscriptions/cash      │                         │
│           └──────────────────────────┘                         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Flujo de subscripción (subscribe → active)**:

```
1. User autenticado POST /api/billing/subscribe {planId: "pro_monthly"}
2. billing.ts:
   a. Lee plan de `plans` table
   b. Llama ePayco.customers.create (con el user.email del session)
   c. Llama ePayco.subscriptions.create (cliente + plan + paymentMethodToken)
   d. ePayco responde {status: "pending", checkout_url: "..."}  ← cliente completa el pago
   e. INSERT en `firm_subscriptions` con status='pending' + ePayco customer/subscription IDs
   f. Responde al cliente: {checkoutUrl, firmSubscriptionId}
3. Cliente completa el pago en ePayco (redirect a checkout).
4. ePayco manda webhook "subscription.approved" → /api/webhooks/epayco
5. epayco-webhook.ts:
   a. Verifica firma (P4) → si falla, 401
   b. INSERT IGNORE en `webhook_events` (P1)
   c. UPDATE `firm_subscriptions` SET status='active', current_period_start=now
   d. INSERT en `credit_ledger` (+plan.monthly_credits, reason='plan_grant')
   e. Responde 200
6. Cliente puede ahora usar el producto. Cada LLM call: consumeCredit.
```

**Flujo de cobro recurrente mensual**:

```
- ePayco internamente: cada 30 días cobra al cliente según el plan.
- Si OK: webhook "subscription.charged" → UPDATE `current_period_end`, INSERT plan_grant.
- Si falla: webhook "subscription.failed" → dunning interno de ePayco (reintentos automáticos).
  - Si ePayco agota reintentos: webhook "subscription.cancelled" → UPDATE status='past_due',
    ePayco desactiva el acceso. billing.ts detecta y bloquea nuevas LLM calls (balance = 0 o
    current_period_end < now).
```

**Flujo de wallet (compra one-time)**:

```
1. User GET /api/billing/wallet → ve packs disponibles.
2. User POST /api/billing/wallet/purchase {creditPackId: "pack_500"} → ePayco.cash.create o
   ePayco.subscriptions.create con intervalo largo (one-time). Retorna checkout URL.
3. Cliente paga → webhook "payment.completed" → INSERT en `wallet_purchases` status='completed',
   INSERT en `credit_ledger` (+pack.credits_amount, reason='wallet_purchase').
4. Balance sube. Cliente sigue usando.
```

**Sobre el SDK oficial vs fetch directo**: el spec asume fetch directo. Razón: ya tenemos el patrón con `OpenRouterLLMInvoker` (fetch + type-safety + manejo de errores custom). El SDK `epayco-sdk-node` v1.4.4 es estable pero agrega una dependencia y abstrae control que queremos tener. **Decisión abierta en §11**: si durante implementación se ve que el SDK cubre el 95% sin sorpresas, swappear a SDK. Si no, mantener fetch.

**Seed de planes** (en `src/lib/db.ts` migrations, idempotente):

```
plans:
  - id='plan_free', name='Free', monthly_credits=100, max_users=1,
    monthly_price_usd=0, currency='COP', features_json='{"trial":true,"support":"community"}'
  - id='plan_pro', name='Pro', monthly_credits=2000, max_users=10,
    monthly_price_usd=30, currency='COP', features_json='{"support":"email","sla":"99%"}'
  - id='plan_enterprise', name='Enterprise', monthly_credits=20000, max_users=100,
    monthly_price_usd=300, currency='COP', features_json='{"support":"dedicated","sla":"99.9%"}'
credit_packs:
  - id='pack_100', name='100 créditos extra', credits_amount=100, price_cop=10000
  - id='pack_500', name='500 créditos extra', credits_amount=500, price_cop=45000
  - id='pack_2000', name='2000 créditos extra', credits_amount=2000, price_cop=160000
```

**Warning de fees en PSE** (de la doc ePayco): "En el medio de pago PSE el valor de comisión en transacciones menores a $60.000 Pesos es de $2.000 + IVA". Para nuestro plan más barato (Pro a COP $30K/mes ≈ $7.50 USD), si el cliente paga con PSE, el fee efectivo = 2.64% × $30K + $2.000 = $2.792 = **9.3%** (no 2.64%). **Implicación**: ofrecer descuento o empujar a tarjeta de crédito. Documentar en `plans` table (`preferred_payment_method`).

---

## 6. Archivos a tocar / crear

| Archivo | Acción | Razón |
|---|---|---|
| `src/lib/db.ts` | modificar | Agregar 6 tablas: `plans`, `firm_subscriptions`, `credit_ledger`, `credit_packs`, `wallet_purchases`, `auto_recharge_config`, `webhook_events`. Idempotente (CREATE TABLE IF NOT EXISTS). Seed de planes y packs. Migrations additive, no breaking. |
| `src/lib/billing/billing.ts` | crear | Servicio de billing local: `getCreditBalance`, `consumeCredit`, `grantCredit`, `getCurrentPlan`, `changePlan`. Transacciones atómicas. Acepta `dbInstance?` opcional (forward-compat tests :memory:). |
| `src/lib/billing/epayco-client.ts` | crear | Cliente HTTP custom. Endpoints: customers/plans/subscriptions/cash. Lee keys de env. TypeScript types. Errores tipados (`EpaycoError`). |
| `src/lib/billing/epayco-webhook.ts` | crear | Handler de webhooks. Verifica firma HMAC-SHA256 (P4). Idempotente via `webhook_events` (P1). Procesa eventos: subscription.approved, subscription.charged, subscription.cancelled, subscription.failed, payment.completed, payment.failed. |
| `src/lib/billing/index.ts` | crear | Barrel exports. |
| `src/agent/llm/openrouter-invoker.ts` | modificar | Inyectar `BillingService?` en constructor. Después de `resolveCost`, antes de retornar: chequea balance y consume (P7, P3). Si `billing` es undefined (backward-compat con tests viejos), skip el chequeo. |
| `src/agent/workflow-engine/dsl/types.ts` | modificar | Agregar `INSUFFICIENT_CREDITS` a `ErrorCode` union type. |
| `src/agent/llm/openrouter-errors.ts` | modificar | Mapear el nuevo code en el mapper HTTP→code si aplica. |
| `server.ts` | modificar | Agregar 8 endpoints de §2-O5. `POST /api/webhooks/epayco` público (sin authMiddleware, pero con verificación de firma). Otros 7 con authMiddleware. |
| `test_billing_v1.mts` | crear | 20+ tests E2E. Schema, balance, plan change, LLM enforcement, webhook signature, end-to-end. |
| `package.json` | modificar | Sin deps nuevas (fetch directo). Si durante implementación decidimos usar SDK, agregar `epayco-sdk-node`. |
| `.env.example` | modificar | Agregar `EPAYCO_PUBLIC_KEY`, `EPAYCO_PRIVATE_KEY`, `EPAYCO_TEST_MODE` (true/false). |
| `BACKLOG_P0.md` | modificar | Marcar P0 #4 cerrado al completar sprint. |
| `HANDOFF.md` | modificar | Documentar sprint cerrado. |
| `AGENT_ROADMAP.md` | modificar | Si hay decisión arquitectónica nueva (no se anticipa). |

---

## 7. Tests

- **20+ tests nuevos** en `test_billing_v1.mts` (estructura similar a `test_firm_membership.mts`):
  - **Bloque A: Schema** (5 tests). Cada tabla existe con columnas correctas. Indices existen. UNIQUE constraints funcionan.
  - **Bloque B: Balance computation** (4 tests). credit_ledger append-only. SUM(delta) es el balance. Grants suman, consumes restan. Reason ENUM funciona.
  - **Bloque C: Atomicidad de consumeCredit** (3 tests). Balance justo + 2 calls concurrentes = 1 pasa, 1 falla. UPDATE/DELETE sobre credit_ledger rompe (intencional, no se debe mutar). Failure en middle del transaction hace rollback completo.
  - **Bloque D: LLM enforcement** (3 tests). Firm con balance suficiente: LLM call pasa + consume. Firm con balance 0: LLM call falla con `INSUFFICIENT_CREDITS`. Firm con balance < costUsd: LLM call falla.
  - **Bloque E: Webhook** (4 tests). Firma válida + evento nuevo: INSERT en webhook_events + side-effect. Firma inválida: 401, ningún side-effect. Mismo evento 2 veces: 1 procesa, la 2da es no-op. Cada tipo de evento (approved/charged/cancelled/failed) actualiza `firm_subscriptions` correctamente.
  - **Bloque F: End-to-end** (3 tests). Subscribe → webhook approved → firm_subscriptions active + credit_ledger plan_grant → LLM call pasa. Cancel → current_period_end actualizado → después del periodo, LLM call falla.
  - **Bloque G: Multi-tenant isolation** (2 tests). Cross-tenant access a credit_ledger retorna null/empty (no leak). LLM enforcement valida que tenantId del request == firmId del balance.
- **Regression**: todos los tests acumulados (358 al cierre de D3.4) deben seguir pasando. LLM invoker con `billing: undefined` (backward-compat) sigue funcionando.
- **Smoke opcional**: con `EPAYCO_TEST_MODE=true` + sandbox keys, un E2E que cree un customer real en sandbox ePayco y verifique que el webhook rebota correctamente. Skip si no hay keys.

---

## 8. Riesgos

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| ePayco API cambia shape (breaking) | media | alto | Cliente HTTP custom nuestro (no SDK). Cambios de ePayco se absorben en `epayco-client.ts`. Tests mockeando `fetch` para validar contratos. |
| Webhook con retry de ePayco causa doble cobro / doble grant | alta | alto | **P1 (idempotencia via `webhook_events` con UNIQUE) + P3 (transacciones atómicas en credit_ledger)**. Test E3 verifica doble webhook = 1 solo side-effect. |
| LLM call concurrente contra mismo firm con balance bajo | media | medio | **P3 (atomicidad)**. Uno pasa, el otro falla con `INSUFFICIENT_CREDITS`. Cliente reintenta. Aceptable. |
| Card on file expira o falla | alta (B2B SaaS) | medio | ePayco maneja dunning internamente. Worgena solo recibe el webhook `subscription.cancelled` cuando ePayco agota reintentos. Documentar en HANDOFF. |
| KYC de ePayco rechaza a Worgena | baja | alto | Sandbox + cuenta de persona natural con RUT (NO requiere SAS). Ya validado con Steve. Si rechaza, fallback = Wompi (NO Stripe, NO Paddle). |
| Schema no portable a Postgres | baja | medio | **P6**. Todo INTEGER, TEXT, sin AUTOINCREMENT/JSONB/VARCHAR. Test de portabilidad: `mgrep` no encuentra features SQLite-specific en migrations nuevas. |
| Balance negativo por bug en `consumeCredit` | baja | alto | **P2 (append-only) + P3 (atomicidad) + tests de race condition**. P1 también: si el balance es < cost, el INSERT falla antes de COMMIT. |
| Founder (Jesús) no aprueba el plan free + seed automáticamente | media | bajo | El seed es idempotente y arranca con plan free. Si no aprueba, el firm existente queda en plan 'free' con 0 créditos (no rompe nada, solo no permite LLM calls). |
| Endpoints REST sin UI bloquean el primer cliente | media | medio | Aceptable: el founder puede usar la API directamente o generar link de checkout de ePayco y mandarlo por email. UI es sprint separado. |
| Compliance Habeas Data: ¿`credit_ledger` cuenta como dato personal? | baja | medio | `credit_ledger` no guarda email/nombre del user, solo `firm_id` y deltas. NO es dato personal directo. `wallet_purchases` puede guardar `external_payment_id` de ePayco (que internamente referencia al customer) — anonimizar en exports. Documentar en SECURITY.md. |

---

## 9. Orden de ejecución

> Por FUNDAMENTO, no por velocidad de feedback. Primitivas primero, integraciones después.

1. **Schema + migrations** (Día 1 mañana). Las 6 tablas en `db.ts`, idempotente. Seed de planes + packs. Test A1-A5. **Sin schema, nada más se puede testear.**
2. **`billing.ts` core** (Día 1 tarde). `getCreditBalance`, `consumeCredit`, `grantCredit`, `getCurrentPlan`, `changePlan`. Tests B1-B4, C1-C3. **Sin servicio core, no podemos hacer enforcement ni webhooks.**
3. **`epayco-client.ts` mockeado** (Día 2 mañana). Cliente HTTP con `transport: (url, init) => Promise<Response>` inyectable (mismo patrón que `OpenRouterClient`). Mockeado en tests. **Sin cliente, no integramos con ePayco real.**
4. **`epayco-webhook.ts` con verificación de firma** (Día 2 tarde). P1 (idempotencia), P4 (firma). Tests E1-E4. **Sin webhook, no procesamos cobros recurrentes.**
5. **Endpoints REST** (Día 3 mañana). Los 8 endpoints de §2-O5. Tests F1-F3 parciales. **Sin endpoints, no hay superficie de uso.**
6. **LLM enforcement en `OpenRouterLLMInvoker`** (Día 3 tarde). Inyectar `BillingService?`. P3, P7. Tests D1-D3. **Sin esto, billing no sirve para nada.**
7. **E2E con sandbox real (opcional)** (Día 4). Si `EPAYCO_TEST_MODE=true` + keys, correr smoke test con ePayco sandbox. Si falla, fallback a mock.
8. **Regression + cleanup** (Día 4 tarde). Correr los 358 tests acumulados. HANDOFF.md + AGENT_ROADMAP.md actualizados. Commit + push.

**Tiempo total estimado**: 4 días de un dev (1 sprint corto). Si se atrasa, los puntos críticos son 1, 2, 4, 6 (schema, core, webhook, enforcement). Los endpoints REST (5) y el smoke E2E (7) son nice-to-have para el cierre.

---

## 10. Definition of Done

- [ ] O1: Schema completo en `db.ts`, migrations idempotentes, 6 tablas + 4 índices.
- [ ] O2: `billing.ts` con 5 funciones, todas con tests unit + tests de atomicidad.
- [ ] O3: `epayco-client.ts` con 4 endpoints (customers, plans, subscriptions, cash) + type-safety + errores tipados.
- [ ] O4: `OpenRouterLLMInvoker` chequea balance y consume credit. Test D1-D3 verde. Backward-compat con `billing: undefined`.
- [ ] O5: 8 endpoints REST en `server.ts` con authMiddleware donde aplica.
- [ ] O6: `epayco-webhook.ts` con verificación de firma + idempotencia. Tests E1-E4 verde.
- [ ] O7: 3 credit_packs seed. Endpoints wallet/purchase + ledger entry.
- [ ] O8: 20+ tests en `test_billing_v1.mts` pasando.
- [ ] Cero objetivo de §3 implementado.
- [ ] P1-P8 (primitivas) todas en el código + testeadas.
- [ ] `tsc` limpio.
- [ ] 358 tests acumulados + 20 nuevos = 378+ tests pasando, 0 regresiones.
- [ ] `BACKLOG_P0.md` actualizado: P0 #4 marcado como cerrado.
- [ ] `HANDOFF.md` actualizado con sprint cerrado, decisiones, próximos pasos.
- [ ] Si hubo cambio arquitectónico, `AGENT_ROADMAP.md` actualizado.
- [ ] Spec vivo (este archivo) actualizado si hubo desvío.

---

## 11. Decisiones abiertas (a resolver durante implementación)

- **D1. SDK oficial vs fetch directo**. Spec asume fetch directo. Si durante implementación se ve que el SDK `epayco-sdk-node` v1.4.4 cubre el 100% sin fricción, swappear. Si tiene quirks o está desactualizado, mantener fetch. **Default: fetch. Re-evaluar en Día 2.**
- **D2. ¿Cómo manejar el caso "firm ya tiene ePayco customer_id"?** Si el firm ya pagó antes (re-subscribe), reutilizar el customer_id de ePayco. Lógica en `changePlan` y `subscribe`. Default: guardar `epayco_customer_id` en `firm_subscriptions` (no en `tenants`, porque un user podría pertenecer a 2 firms con 2 customers distintos).
- **D3. ¿Webhooks enqueue o procesan in-process?** Spec dice in-process queue v1 (Promise.resolve chain). Si en producción vemos backpressure, migrar a jobs system (P0 #5). **Trade-off**: complejidad de jobs vs simplicidad v1. Default: in-process. Re-evaluar si webhook latency > 5s.
- **D4. ¿Manejamos `cancel_at_period_end` o solo cancelación inmediata?** Spec dice `cancel_at_period_end` (Stripe-style). El cliente sigue usando hasta fin del periodo, después se desactiva. Más amigable. Si el cliente quiere inmediato, botón "cancel now" que llama `ePayco.subscriptions.cancel` y bloquea al toque.

---

## 12. Referencias

- **Decisión pasarela Colombia**: `C:\Users\acer\Downloads\asistente IA\untitled\Asesoría Steve\2026-06-25_decision_pasarela_pagos_colombia.md` (57KB, 19 fuentes, 6 candidatos evaluados).
- **ePayco docs oficiales**: `docs.epayco.com` (páginas checkout-respuesta-y-confirmacion, suscripciones, webhooks).
- **SDK Node**: `npmjs.com/package/epayco-sdk-node` (v1.4.4 estable, mantenido).
- **Schema Postgres-compatible**: `AGENTS.md` §15 (reglas de portabilidad).
- **Multi-tenancy D3.4 redesign**: `AGENT_D3_4_REDESIGN_SPRINT_SPEC.md` (commit `fd80b1d`).
- **Cost attribution (P0 #3)**: `BACKLOG_P0.md` §3 (cerrado en commit `770f3b2`). `OpenRouterLLMInvoker` ya tiene `recordLLMCall` — billing v1 enchufa `consumeCredit` en el mismo punto.
- **Migración a Postgres (forward-compat)**: `AGENTS.md` §15 trigger list (primer cliente pagando + multi-instancia + >5GB DB o >1 dev).
- **Patrón de cliente HTTP custom**: `src/agent/llm/openrouter-invoker.ts` y `src/agent/llm/openrouter-client.ts` (fetch directo, transport inyectable, errores tipados).
