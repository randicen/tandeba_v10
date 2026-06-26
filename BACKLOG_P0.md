---
created: 2026-06-15 12:54
updated: 2026-06-15 12:54
tags: [backlog, P0, seguridad, wozniak, sprint-futuro]
---

# Backlog P0 — issues conocidos (a evaluar al volver a D3)

Issues críticos identificados por Wozniak al poblar las `references/`
de las skills de cofundador. NO son sprints cerrados. Son **trabajo
pendiente que probablemente debería entrar antes o durante D3**.

## 1. Scrub de secretos en `step_logs` (P0)

Tags: #seguridad #audit-log #legal

**Hallazgo** (Wozniak, sesión 2026-06-15, `tech-debt-audit` → `debt-categories.md`):
- `step_logs.prompt_sent` y `step_logs.raw_response` persisten raw.
- Si el LLM alucina un secreto del cliente (password, NIT, API key),
  queda en DB sin filtro.
- AUDIT_D2 §6 lo marca explícitamente.
- Sin rate limit ni validación de input length.

**Riesgo si no se cierra**: legal alto. Worgena procesa datos
confidenciales de clientes; un secreto persistido en logs es
incumplimiento de Habeas Data y潜在的 vector de breach.

**Próximo paso propuesto**:
- Definir un `SecretScrubber` configurable (regex + entropy-based).
- Aplicarlo en el path de escritura de `step_logs`, no en lectura
  (es más barato y previene).
- Audit log de scrub: cuántos secrets se filtraron por sprint (sin
  contenido).
- Test de regresión: input con un NIT/API key/password no aparece en
  el row persistido.

## 2. Auth real en el motor (P0)

Tags: #seguridad #multi-tenant #auth #D3.4

**Hallazgo** (Wozniak, sesión 2026-06-15, `security-hardening` →
`multi-tenant-isolation.md` y `audit-log-patterns.md`):
- Cualquier HTTP caller puede mentir `tenantId` en `options` del
  `startTask` (`executor.ts:604-608`).
- El motor confía en el caller. No valida que el `tenantId`
  corresponda a un usuario autenticado.
- D3.4 spec escrita (`AGENT_D3_4_5_DB_AUTH_SPEC.md`) pero no
  implementada.

**Riesgo si no se cierra**: spoofing cross-tenant. Un caller
autenticado como firma A podría operar tareas de firma B pasando
`tenantId: B` en el body. El motor ejecuta sin quejarse. El
aislamiento row-level actual protege los datos, pero no las acciones
entre tenants.

**Próximo paso propuesto**:
- Implementar la D3.4 spec (auth middleware + verificación de
  `tenantId` en el path crítico).
- Test obligatorio: usuario de firma A intenta `startTask({tenantId: B})`
  → 403.
- Migrar gradualmente: feature flag, primero en endpoints nuevos.

## 3. Costo de LLM no atribuible por tenant (P1, muy cerca de P0)

Tags: #costo #observabilidad #openrouter #D3+

**Hallazgo** (Wozniak, sesión 2026-06-15, `security-hardening` →
`audit-log-patterns.md` y `code-review-multi-axis` → `review-checklist.md`):
- Hay 3 capas de medición: `apify-tracker.ts` (D1, full attribution
  por session), `PricingCatalog.estimateCost` + `usage.cost` de
  OpenRouter (D2b.2, atribución por nodo via `NodeResult.costUsd`).
- `OpenRouterClient.executeWithTimeout` no loguea `taskId`/`tenantId`
  en la llamada, solo `model` y `latencyMs`.
- Correlacionar costo-por-tenant requiere cruzar timestamps con
  `workflow_audit` (tabla que existe en D3+).

**Riesgo si no se cierra**: no podemos cobrar por uso, no podemos
hacer unit economics, no podemos detectar fuga de tokens por
prompt mal armado.

**Próximo paso propuesto**:
- Modificar `OpenRouterClient.executeWithTimeout` para aceptar
  contexto `{taskId, tenantId, agentCardId}` y loguearlo.
- Tabla `workflow_audit` (de D3.3) ya tiene los hooks; falta
  cablearlos al invoker.
- Test de regresión: un workflow de 5 nodos genera 5 rows en
  `workflow_audit` con `costUsd` consistente con la suma de
  `usage.cost` de los nodos.

## 4. Sistema de planes, créditos y billing (P0 — no negociable)

Tags: #revenue #planes #creditos #stripe #paddle #saas #monetizacion

**Hallazgo** (Wozniak, sesión 2026-06-25 — falla del CTO al cerrar
D3.4 redesign sin considerar monetización):
- D3.4 rediseño multi-tenant está cerrado, pero el producto no
  tiene cómo cobrar. No hay `plans`, no hay `subscriptions`, no hay
  `credit_ledger`, no hay `stripe_webhook`. **No podemos tomar
  el primer cliente pagando.**
- `cost_attribution` (P0 #3) solo registra uso. NO metrea. NO
  enforza. NO bloquea cuando un cliente quema más de su quota.
- Un cliente con plan $10/mes puede generar $1000 de LLM en 1h
  y el sistema no se entera. Eso es bancarrota operativa.
- AGENTS.md §11 "asumir que el producto va a crecer" — crecí el
  modelo multi-tenant, no crecí el modelo de revenue. Falla
  de razonamiento: traté "crecimiento" como "multi-user", no
  como "monetizable".
- El usuario (founder) lo señaló explícitamente el 2026-06-25
  con tono de decepción. Anotado como evidencia de que el
  revenue model DEBE ser parte del sprint, no un afterthought.

**Riesgo si no se cierra**:
- Cero revenue. SaaS que escala usuarios pero no factura = muerte.
- LLM budget unlimited → bancarrota en el primer cliente que abuse.
- Unit economics imposibles de calcular (sin `credit_ledger` no
  sabemos el margen por firm).
- Compliance Colombia (DIAN) requiere facturación electrónica para
  cualquier cobro. Sin esto, ni siquiera podemos cobrar formalmente.

**Componentes necesarios** (scope tentativo, no cerrado):

### 4.1 Schema de planes
- `plans` (id, name, monthly_credits, max_users_per_firm,
  max_firms_per_user, features_json, monthly_price_usd, currency)
- `firm_subscriptions` (id, firm_id, plan_id, current_period_start,
  current_period_end, status ENUM('active','past_due','cancelled'),
  external_subscription_id, created_at, updated_at)
- `credit_ledger` (id, firm_id, delta INTEGER, reason ENUM
  ('plan_grant','llm_call','refund','manual_adjustment'),
  llm_call_audit_id?, task_id?, created_at) — **append-only**,
  nunca UPDATE/DELETE, balance se computa con SUM(delta).
- `plan_changes` (audit log de upgrades/downgrades).

### 4.1.bis Wallet de créditos para uso extra-plan (P0 — confirmado por founder 2026-06-25)

**Concepto**: el modelo NO es solo "plan quota mensual". Es un sistema
**dual**:

- **Plan mensual** (recurring): grant de N credits cada periodo
  (ej: Pro = 1000 credits/mes, Enterprise = 10000 credits/mes).
  Reset al inicio de cada periodo. NO rollover.
- **Wallet de créditos** (one-time purchases): el user puede comprar
  paquetes de créditos adicionales que **no expiran** (o expiran
  a 12 meses, decisión abierta). Se usan **después** de que se
  acaba la quota del plan, como buffer.
- **Auto-recharge opcional** (configurable por firm): cuando el
  balance combinado (plan remaining + wallet) cae bajo un umbral,
  auto-compra X credits hasta un máximo mensual.

**Por qué es importante distinguirlo**:
- Si solo hay plan quota, el cliente que se pasa 1 día del mes se
  queda bloqueado. Mala UX. Los SaaS modernos (OpenAI, Anthropic,
  Notion, AWS) todos tienen wallet + plan.
- La wallet da control al cliente: paga extra solo si lo necesita.
- Auto-recharge convierte ansiedad en flujo: el cliente configura
  un techo ($200/mes) y se olvida.

**Componentes adicionales sobre §4.1**:
- `credit_packs` (id, name, credits_amount, price_usd, currency,
  enabled, sort_order) — paquetes de compra: "100 credits $10",
  "500 credits $45", "2000 credits $160".
- `wallet_purchases` (id, firm_id, credit_pack_id,
  external_payment_id, amount_usd, credits_granted,
  status ENUM('pending','completed','refunded','failed'),
  created_at, completed_at) — un row por compra.
- `auto_recharge_config` (id, firm_id, enabled, threshold_credits,
  recharge_credit_pack_id, max_per_month_usd, current_month_spent,
  created_at, updated_at) — UNIQUE por firm.
- `credit_ledger.reason` se extiende con: `wallet_purchase`,
  `auto_recharge`, `plan_grant`, `llm_call`, `refund`,
  `manual_adjustment`, `expiry_12mo` (si se decide expiración).
- API: `GET /api/billing/wallet` (balance, historial, packs
  disponibles), `POST /api/billing/wallet/purchase`,
  `PUT /api/billing/wallet/auto-recharge`.

**Decisiones abiertas**:
- ¿Créditos de wallet expiran a 12 meses? o ¿nunca? (regulatorio
  en Colombia: hay normas de saldo a favor del consumidor).
  **Recomendación provisional**: 12 meses para alinear con buenas
  prácticas; documentar claramente en T&C.
- ¿Auto-recharge ON por default o requiere opt-in explícito?
  **Recomendación provisional**: opt-in (compliance + evita
  sustos del cliente con tarjeta).
- ¿Se puede comprar wallet sin tener plan? (caso: cliente que
  solo quiere pay-as-you-go sin recurring). **Recomendación
  provisional**: sí, plan = $0 + wallet-only es válido.


### 4.2 LLM invoker con enforcement
- `OpenRouterLLMInvoker.chat()` chequea `credit_balance < estimated_cost`
  ANTES de llamar a OpenRouter. Si excede: throw `INSUFFICIENT_CREDITS`.
- Test obligatorio: firm con 0 credits → segunda llamada LLM rechaza.

### 4.3 Endpoints REST
- `GET /api/billing/plans` (público, lista planes disponibles).
- `GET /api/billing/me` (firm actual: plan, balance, próximo cobro).
- `POST /api/billing/subscribe` (cambia plan, crea
  `firm_subscriptions`).
- `POST /api/billing/cancel` (cancela, mantiene acceso hasta fin
  de periodo).
- `GET /api/billing/usage?from=&to=` (uso histórico por firm).

### 4.4 Webhook de pago
- `POST /api/webhooks/stripe` (o el provider elegido).
- Idempotente: cada `event.id` se procesa una sola vez.
- Forward-compat con **jobs system** (P0 #5): los webhooks
  encolan un job para no bloquear el response HTTP.

### 4.5 Decisión de provider de pagos (Steve re-investigación 2026-06-25)

**Recomendación**: **Wompi** (de Bancolombia), plan Avanzado
Agregador, 2.65% + $700 COP flat por transacción exitosa (todos
los métodos: PSE, Nequi, Daviplata, tarjetas, Botón Bancolombia).

**Por qué Wompi > Mercado Pago > ePayco > PayU > Bold > PlacetoPay para Worgena**:

1. **Cubre los 5 métodos de pago B2B colombianos en una integración**.
   PSE, Nequi, Daviplata, tarjetas Visa/MC/Amex, Botón Bancolombia.
   ePayco cubre 4 de 5 (sin Botón Bancolombia). PayU cubre 4 de 5
   (Daviplata no confirmado). Mercado Pago cubre los principales
   pero con fees opacos. **Wompi gana en cobertura local.**

2. **Tarifa plana más baja del grupo local**. 2.65% + $700 COP
   (todos los métodos, sin mínimos, sin escalonado). ePayco tiene
   2.64% en promo 3 meses, después sube a 2.99% + $900. **PayU
   cobra mínimo PSE $9,900 que destruye 30-50% del ingreso del
   primer mes** de un plan COP $20-30K. Wompi no tiene ese mínimo.

3. **Persona natural con RUT es suficiente para arrancar**. Worgena
   NO necesita SAS para tomar el primer cliente pagando. Wompi
   permite registro a persona natural con RUT o cédula + cuenta
   Bancolombia/Nequi +30 días. **Time-to-first-paying-customer:
   1-2 semanas** (vs 3-6 meses con Stripe + Atlas).

4. **Tokenización + REST API + español encaja 1:1 con el stack
   Worgena**. Worgena ya tiene `OpenRouterLLMInvoker` como cliente
   HTTP custom en TypeScript. Mismo patrón para `WompiClient`.
   Webhooks firmados con `events_secret`, IP allowlist, retry
   documentado. No hay SDK Node oficial pero tampoco dependencia
   comunitaria frágil.

5. **Respaldo Bancolombia = confianza para cliente B2B jurídico**.
   Cuando un bufete junior le pregunta al socio senior "le voy a
   dar la tarjeta de la firma a un proveedor SaaS", el socio
   pregunta "¿quién procesa el pago?". Si la respuesta es "Wompi,
   que es de Bancolombia", se acaba la objeción. **Cierra objeciones
   de procurement en venta enterprise.**

**Restricciones críticas que Worgena debe aceptar (no son blockers)**:

- **Wompi NO tiene API REST de "subscriptions"** tipo Stripe.
  La recurrencia se hace con tokenización + cobros manuales desde
  el backend de Worgena. **El `jobs` system de P0 #5 deja de ser
  nice-to-have y se vuelve BLOQUEANTE** del sprint de billing.
  Sin jobs, Wompi no funciona para SaaS con suscripción.

- **Wompi NO emite factura electrónica DIAN**. Cuando Worgena sea
  SAS, hay que cablear un operador autorizado (Factus, Lemp,
  EDICOM, Siigo, Alegra, Datium). Sprint adicional post-SAS,
  no bloqueante para v1.

- **Cobertura LatAm limitada a CO/PA/SV**. Si la expansión LatAm
  llega en <12 meses, hay que sumar PayU o Mercado Pago como
  segunda pasarela. **Documentar en HANDOFF cuando se tome la
  decisión de expansión.**

**Descartados explícitamente con razón**:

- **Paddle / LemonSqueezy**: NO soportan métodos de pago
  colombianos. El cliente no puede pagar.
- **Stripe Colombia como v1**: requiere SAS constituida (3-6
  meses), fees más altos (3.9% + $800 vs 2.65% + $700 Wompi).
  Revaluar post-SAS.
- **PayU LatAm**: fee mínimo PSE $9,900 destruye margen en
  planes pequeños.
- **Bold**: NO tiene API de pagos recurrentes ("estamos
  trabajando para que más adelante podamos contar con APIs
  independientes para pagos recurrentes y membresías").
  Descartado por deal-breaker.
- **PlacetoPay**: sin SDK Node oficial, tarifa más alta,
  enfoque enterprise.

**Mercado Pago condicional**: el fee Colombia NO es público
(solo se publica fee Argentina 6.29%). Steve recomienda abrir
sandbox MP CO en paralelo y validar fee antes de cerrar la
decisión final. Si MP resulta <2.5% con dunning, sube al #1.
Por ahora: Wompi gana por transparencia de pricing.

**Riesgo + mitigación**: si Wompi rechaza a Worgena en KYC
(raro para persona natural pero posible), fallback = **ePayco**
(mismo modelo, sin SAS, Davivienda). Acción: abrir sandbox
ePayco en paralelo a Wompi antes de comprometer el sprint.

**Deliverable Steve**: `C:\Users\acer\Downloads\asistente IA\untitled\Asesoría Steve\2026-06-25_decision_pasarela_pagos_colombia.md`
(57KB, ~700 líneas, 19 fuentes citadas con URL + fecha de
acceso, tabla comparativa 6×12, decisión + 5 razones + decision
framework de 5 preguntas + 6 anti-recomendaciones + lecciones
de la investigación anterior).

**Cambio de prioridad crítico** (Wozniak, post-Steve): **P0 #5
jobs system sube a bloqueante del sprint de billing**, no nice-to-have.
Sin jobs, Wompi no puede cobrar recurrentes. **Reordenar backlog**:
1. Jobs system (P0 #5) — abre el camino.
2. Billing (P0 #4) — usa jobs para cobros recurrentes.
3. Chat /goal (D3.4-bis) — nice-to-have, después.

**Decisión de email provider**: **Resend** (founder 2026-06-25).
Documentado en §5.4.

**Próximo paso propuesto** (orden de fundación):
1. Spec `AGENT_BILLING_V1_SPEC.md` con scope, no-objetivos,
   primitivas, tests, schema. **Antes de tocar código**.
2. Decisión del founder sobre provider de pagos.
3. Implementar schema (idempotente, Postgres-compatible).
4. LLM enforcement + tests.
5. Endpoints + webhook + jobs.

## 5. Jobs system (background async work) (P0 — no negociable)

Tags: #jobs #background #async #webhooks #cleanup #email

**Hallazgo** (Wozniak, sesión 2026-06-25 — falla del CTO al
construir D3.4 redesign sin jobs):
- Worgena no tiene jobs system. Todo es síncrono en el path HTTP.
- D3.4 rediseño crea invitaciones con `token` + `email` pero
  **no hay mecanismo para ENVIAR el email**. La invitación
  queda en la DB pero el destinatario nunca la recibe.
- Stripe webhooks (P0 #4) requieren procesamiento async:
  no se puede hacer DB write en el handler HTTP directo (riesgo
  de timeout, no idempotente).
- LLM credit enforcement (P0 #4) debería ejecutarse en un job
  periódico para alertas ("te queda 20% de tu plan"), no en
  cada llamada.
- Periodic cleanup: `audit_auth` (Habeas Data retention),
  `tenant_invitations` expiradas, `step_logs` viejos.
- Email de cost reports semanales para clientes (P0 #4).

**Riesgo si no se cierra**:
- Invitaciones de onboarding NO funcionan (sin email el
  destinatario nunca sabe que tiene un invite). El sprint
  D3.4 redesign que cerramos está **mitad funcional**:
  la lógica de token existe pero el envío no.
- Webhooks de pago NO se procesan en orden ni con retry.
  Si Stripe nos paga y fallamos el webhook, el cliente
  pagó pero la firma queda como `past_due` eternamente.
- Cleanup manual: cuando `audit_auth` llegue a 1M rows,
  hay que correr scripts a mano. Insostenible.
- El founder tiene que monitorear el sistema a ojo. No
  hay alertas automáticas.

**Componentes necesarios** (scope tentativo):

### 5.1 Schema
- `jobs` (id, type ENUM('send_invitation_email',
  'enforce_credit_warning','cleanup_audit','cleanup_invitations',
  'compute_cost_report','stripe_webhook','send_email_generic'),
  payload_json, scheduled_at INTEGER, status ENUM
  ('pending','running','completed','failed','dead_letter'),
  attempts INTEGER DEFAULT 0, last_error TEXT,
  started_at INTEGER, completed_at INTEGER, created_at INTEGER).
- Índices: `(status, scheduled_at)` para polling eficiente.
- `job_history` opcional si se quiere log separado de `audit_auth`.

### 5.2 Worker loop
- Loop en `server.ts` (o proceso separado cuando escale).
- Poll: `SELECT ... FROM jobs WHERE status='pending' AND
  scheduled_at <= ? ORDER BY scheduled_at LIMIT N`.
- Para cada job: UPDATE status='running' (atómico), ejecutar
  handler, UPDATE status='completed' o 'failed'.
- Retry: backoff exponencial (1m, 5m, 30m, 2h, 12h).
  Después de 5 intentos → `dead_letter`.
- Concurrency: max N jobs concurrentes (default 5). Configurable.

### 5.3 Job types (handlers)
- `send_invitation_email` — recibe `{invitationId}`. Genera el
  link con el token, lo manda via **Resend** (decidido por el
  founder 2026-06-25). Resend es developer-friendly, free tier
  generoso (3000 emails/mes, 100/día), SDK de Node, webhooks
  para tracking de delivery/bounce/spam. Forward-compat con
  SendGrid si el volumen crece.
- `enforce_credit_warning` — corre cada 24h. Si firm < 20%
  del plan, manda email de alerta.
- `cleanup_audit` — corre cada 7d. Borra `audit_auth` con
  `created_at < now - 1y` (Habeas Data retention).
- `cleanup_invitations` — corre cada 24h. Borra invitaciones
  expiradas + usadas hace más de 30 días.
- `compute_cost_report` — corre cada lunes 9am. Genera PDF
  con uso de la semana, lo manda al admin del firm.
- `stripe_webhook` — handler del webhook de P0 #4.

### 5.4 Decisión abierta
- **Provider de email**: **Resend** (decidido por founder 2026-06-25).
  - **Resend** = developer-friendly, SDK Node oficial, free tier
    3000 emails/mes, 100/día. Webhooks para delivery/bounce/spam.
  - **SendGrid** = enterprise, fees por email después del free
    tier, más complejo de configurar. Forward-compat si el
    volumen crece.
  - **SMTP genérico** = no vendor lock-in, pero operacionalmente
    más frágil (deliverability, IP reputation, DKIM/SPF/DMARC
    manual).
  - **Recomendación provisional**: Resend para MVP, mantener
    abstracción `EmailProvider` interface para migrar a
    SendGrid/SES si el volumen lo justifica.
  - **Bull**: requiere Redis. No tenemos Redis. Overhead
    operacional.
  - **Graphile Worker**: Postgres-only. Funciona perfecto
    con nuestra migración a Postgres (P0 #4.5 decisión).
  - **Custom in-house**: control total, sin dependencias,
    Postgres-compatible. El loop es ~100 líneas. Los handlers
    son pluggables.
  - **Recomendación provisional**: custom in-house mientras
    estamos en SQLite (no Redis, no Postgres todavía).
    Migrar a Graphile Worker cuando se haga el trigger de
    Postgres (P0 #4.5).

**Próximo paso propuesto**:
1. Spec `AGENT_JOBS_V1_SPEC.md`. **Antes de tocar código**.
2. Decisión del founder sobre provider de email.
3. Schema + worker loop + 2-3 handlers básicos
   (send_invitation_email, cleanup_invitations, stripe_webhook).
4. Test de regresión: encolar un job, verificar que se ejecuta
   y se marca como completed.
5. Backfill: cuando esté listo, todos los puntos que ya
   necesitamos async (emails de invitaciones, webhooks)
   se migran a jobs.

## Cómo trabajar estos items

Cuando se arranque D3 (o el sprint equivalente), leer primero:
- `AGENT_ROADMAP.md` (orden vigente)
- `HANDOFF.md` (estado al cierre)
- Las `references/` pobladas por Wozniak (las 8 que se actualizaron
  en esta sesión).

Cada item de este backlog debe tener, antes de construir:
1. Spec en formato `AGENT_Dx_<item>_SPEC.md` con scope, no-objetivos,
   primitivas, tests, riesgos.
2. ADR si la decisión toca una invariante dura (motor propio, 3
   capas, versionado, multi-tenant).
3. Test de regresión desde el día 1 — sin test, el item no se
   considera cerrado.

## Estado

- [x] Item 1 — scrub de secretos — ✅ CERRADO via commit `d3289dd` (2026-06-25). 13 tests nuevos pasan. `SecretScrubber` con 9 regex patterns + entropy-based para high-entropy strings.
- [x] Item 2 — auth real en el motor — ✅ CERRADO via D3.4 (commit `4af3e0c`) + audit fixes (commit `fe90ab7`)
- [x] Item 3 — atribución de costo por tenant — ✅ CERRADO via commit `XXXX` (2026-06-25). 6 tests nuevos pasan. `WorkflowAudit.recordLLMCall()` cableado en `OpenRouterLLMInvoker`. Backlog P0 cerrado completo.
- [ ] **Item 4 — planes + credits + billing — 🔴 PENDIENTE P0. Bloqueante para tomar el primer cliente pagando. Wompi seleccionada como pasarela (re-investigación Steve 2026-06-25). KYC en paralelo al sprint. Spec a escribir antes de código.**
- [ ] **Item 5 — jobs system — 🔴 PENDIENTE P0. SUBIÓ A BLOQUEANTE de billing (Wompi no tiene API subscriptions — Worgena programa los cobros con jobs). Bloqueante también para invitaciones de email + webhooks + cleanup. Resend seleccionada como email provider. Spec a escribir antes de código.**
