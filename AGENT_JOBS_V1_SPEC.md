# P0 #5 — Jobs System v1 Spec

> Cierra: **P0 #5 (jobs system)** de `BACKLOG_P0.md`.
> Spec vivo: se actualiza durante implementación si se descubre scope que faltaba.
> Sprint corto, estimado 3-4 días de un dev.

---

## 1. Contexto

Worgena tiene **3 lugares donde el sistema actual es "mitad funcional"** sin un sistema de jobs:

1. **D3.4 invitación por email**: cuando un owner crea una invitación (`POST /api/firms/:id/invitations`), el `tenant_invitations` row se crea con `token` y `email`, pero **el destinatario nunca recibe el email** — no hay mecanismo. El fundador tiene que copiar el link manualmente.
2. **Credit warning**: cuando un firm tiene <20% de su plan, el sistema no avisa. El cliente descubre que se quedó sin créditos cuando ya está bloqueado.
3. **Periodic cleanup**: `audit_auth` (Habeas Data), `tenant_invitations` expiradas, `step_logs` viejos. Sin cron, hay que hacerlo a mano. Insostenible a escala.

**Lo que habilita este sprint**:
- Onboarding D3.4 completo (emails automáticos).
- Alertas proactivas de balance.
- Cumplimiento Habeas Data automatizado (cleanup anual de audit_auth).
- Webhook processing async (forward-compat: si latency del webhook de ePayco > 5s, los jobs pueden moverlo a un queue).

**Lo que bloquea si no se hace**: **P0 #5 sigue abierto**. Backlog P0 completo se logra cuando esto se cierre.

---

## 2. Objetivos (qué SÍ se hace)

- **O1. Schema Postgres-compatible para jobs**. Tabla `jobs` (id, type, payload_json, scheduled_at, status ENUM, attempts, last_error, started_at, completed_at, created_at). Índices `(status, scheduled_at)` para polling eficiente. Migrations idempotentes en `src/lib/db.ts`.

- **O2. Repository de jobs** (`src/lib/jobs/repository.ts`). Funciones: `enqueueJob(type, payload, options?)`, `claimPendingJobs(limit, dbInstance?)`, `markJobCompleted(id)`, `markJobFailed(id, error, willRetry)`, `markJobDeadLetter(id, error)`, `getJobById(id)`, `listJobs(filter)`. Todas con `dbInstance?` opcional. Source of truth: tabla `jobs`.

- **O3. Worker loop** (`src/lib/jobs/worker.ts`). Loop asíncrono que:
  - Poll cada N segundos (default 1s).
  - `claimPendingJobs(limit=5)` con transición atómica pending→running.
  - Para cada job: dispatch al handler correspondiente.
  - Backoff exponencial con jitter en retries: `5s, 30s, 2min, 10min, 1h` (configurable).
  - Después de 5 intentos → `dead_letter`.
  - Concurrencia máxima: `MAX_CONCURRENCY=5` (default configurable).
  - Graceful shutdown: SIGTERM → espera a que los jobs running terminen.

- **O4. Email provider con Resend** (`src/lib/email/provider.ts` + `resend-client.ts`). Interface `EmailProvider` con método `sendEmail({to, subject, html, text?})`. Impl `ResendProvider` que usa el SDK `resend` (Node oficial). `RESEND_API_KEY` en `.env`. Forward-compat: swap a SendGrid/SES cambiando impl. **Manejo de error tipado** (`EmailProviderError`).

- **O5. 5 handlers de jobs** (`src/lib/jobs/handlers/`):
  - `send_invitation_email` — recibe `{invitationId}`. Resuelve tenant + inviter + email, genera URL con token, manda email. **Cierra la mitad funcional del onboarding D3.4**.
  - `enforce_credit_warning` — recibe `{firmId}`. Lee balance, si < 20% del plan, manda email al admin del firm.
  - `cleanup_audit` — recibe `{olderThanMs}` (default 1 año = 365 días). DELETE `audit_auth WHERE created_at < ?`. **Habeas Data retention**.
  - `cleanup_invitations` — recibe `{olderThanMs}` (default 30 días). DELETE `tenant_invitations WHERE expires_at < ? AND (used_at IS NOT NULL OR expires_at < ?)`.
  - `send_email_generic` — recibe `{to, subject, html, text?}` para casos ad-hoc (forward-compat con onboarding emails, magic links, etc.).

- **O6. Integración con D3.4**: cuando un owner crea una invitación via `POST /api/firms/:id/invitations`, después de crear el row en `tenant_invitations`, automáticamente encolar un `send_invitation_email`. Cierra la mitad funcional de D3.4.

- **O7. Integración con P0 #4 billing**: cuando un firm se queda < 20% del plan, encolar `enforce_credit_warning`. Trigger: después de cada `consumeCredit` que baje el balance por debajo del threshold. Idempotente: no encolar 2 veces en el mismo día.

- **O8. Scheduler de cleanup** (no cron externo, parte del worker loop). Al startup, si el worker arranca:
  - Encolar `cleanup_audit` con `scheduled_at = now`.
  - Encolar `cleanup_invitations` con `scheduled_at = now`.
  - Re-encolar cada 24h (en handler, con `nextRunAt = now + 24h`).

- **O9. Tests E2E** (en `test_jobs_v1.mts`): 18+ tests cubriendo schema, repository, worker, handlers, email mock, retries, dead letter, multi-tenant isolation.

---

## 3. No-objetivos (qué NO se hace)

- **NO-1. Bull (Redis)**. Requiere infra externa. Costo operacional. Diferible. Razón: SQLite con `db.transaction()` da el mismo comportamiento atómico.
- **NO-2. Graphile Worker (Postgres)**. Requiere migración a Postgres (P0 trigger). Diferible a cuando se haga la migración.
- **NO-3. UI de jobs / dashboard de dead letter**. El operador puede ver `SELECT * FROM jobs WHERE status='dead_letter'` directamente en DB. UI es sprint separado.
- **NO-4. Multi-region worker**. v1 corre en el mismo proceso que el server. Forward-compat: el worker se puede mover a un proceso separado sin cambios de código.
- **NO-5. Streaming de output del job**. Jobs son fire-and-forget; no exponen progress via SSE/WebSocket.
- **NO-6. Job cancellation API**. `DELETE /api/jobs/:id` no existe. Si un operador quiere cancelar, UPDATE manual en DB.
- **NO-7. Webhook async de ePayco**. v1 sigue procesando in-process (P0 #4 spec §11.D3). El sistema de jobs está **listo** para absorber el webhook si latency > 5s en producción, pero la migración es un cambio aparte.
- **NO-8. Auto-recharge del wallet**. Schema listo en P0 #4, lógica NO. Diferible a billing v2.
- **NO-9. DIAN facturación electrónica**. Post-SAS.
- **NO-10. Retry policy configurable por job type**. v1 hardcodea `5s, 30s, 2min, 10min, 1h` para todos. Forward-compat: agregar `retry_policy` field en jobs table si hace falta.

---

## 4. Primitivas no negociables

- **P1. Atomicidad del claim**. `claimPendingJobs` usa `UPDATE jobs SET status='running', started_at=? WHERE id IN (SELECT id FROM jobs WHERE status='pending' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT ?) RETURNING *`. Si el subquery no encuentra rows, retorna array vacío. **No race condition entre workers concurrentes**.
- **P2. Idempotencia por `idempotency_key`**. Campo opcional en jobs. Si dos enqueues con mismo `(type, idempotency_key)` se ejecutan, el segundo es no-op (INSERT OR IGNORE). Útil para no mandar el mismo email dos veces.
- **P3. Retries con backoff exponencial + jitter**. Falla → `markJobFailed` calcula `nextRunAt = now + 5s * 2^attempts + random(0, 5s)`. Default: 5 intentos antes de dead_letter. Configurable via `MAX_JOB_ATTEMPTS=5`.
- **P4. Dead letter queue con visibilidad**. `status='dead_letter'` es persistente. Operador ve `SELECT * FROM jobs WHERE status='dead_letter'`. Forward-compat: UI en sprint aparte.
- **P5. Multi-tenant isolation**. Handlers que tocan firm data filtran por `firm_id`. El job payload DEBE incluir `firmId` cuando toca data de firm. Validación: `getJobFirmId(job)` retorna el firmId o lanza si falta.
- **P6. Schema Postgres-compatible**. Tabla `jobs`: `id TEXT`, `payload_json TEXT`, `scheduled_at INTEGER`, `attempts INTEGER`, `last_error TEXT`, etc. Sin `AUTOINCREMENT`, sin `VARCHAR(n)`, sin `JSONB`. Forward-compat: cuando se migre a Postgres, agregar `nextRunAt` como `TIMESTAMP` o `INTEGER` Unix ms.
- **P7. Graceful shutdown**. `SIGTERM` → el worker deja de aceptar nuevos jobs, espera a que los running terminen (max 30s), luego cierra. Test: SIGTERM durante un job running → el handler completa antes del exit.
- **P8. Audit del job lifecycle**. Cada cambio de status se loguea (debug level). `last_error` se persiste en la tabla. Forward-compat: `job_events` table si necesitamos re-runs.
- **P9. Concurrencia configurable**. `MAX_CONCURRENCY=5` default. Si 5 jobs ya están running, el poll no encola más. Backpressure natural.
- **P10. Email NO bloqueante**. Un job que falla al mandar email NO debe tirar el handler. `try { ... } catch { mark failed }`. Si el provider está down, el job reintenta con backoff. Después de 5 intentos → dead_letter. Operador puede re-encolar manualmente.

---

## 5. Diseño (alto nivel)

```
┌──────────────────────────────────────────────────────────────────┐
│                          WORGENA STACK                           │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────┐   ┌────────────┐   ┌────────────────┐            │
│  │  server.ts │──▶│  handlers  │──▶│  jobs (table)   │            │
│  │  (D3.4 +   │   │ (firm,     │   │  (Postgres-     │            │
│  │  P0 #4)    │   │  billing)  │   │   compatible)   │            │
│  └────────────┘   └─────┬──────┘   └────────┬───────┘            │
│       │                 │                   │                    │
│       │ enqueue         │ INSERT job         │ poll (every 1s)   │
│       ▼                 ▼                   ▼                    │
│  ┌──────────────────────────────────────────────────┐            │
│  │            worker.ts (async loop)                │            │
│  │  - claimPendingJobs(5)                          │            │
│  │  - dispatch(type) → handler[type](payload)     │            │
│  │  - markJobCompleted / Failed / DeadLetter       │            │
│  │  - backoff con jitter                            │            │
│  └────────────────────┬─────────────────────────────┘            │
│                       │                                           │
│                       ▼                                           │
│  ┌──────────────────────────────────────────────────┐            │
│  │            handlers/ (5 impls)                   │            │
│  │  - send_invitation_email → EmailProvider         │            │
│  │  - enforce_credit_warning → EmailProvider        │            │
│  │  - cleanup_audit → DELETE audit_auth            │            │
│  │  - cleanup_invitations → DELETE invitations     │            │
│  │  - send_email_generic → EmailProvider            │            │
│  └────────────────────┬─────────────────────────────┘            │
│                       │                                           │
│                       ▼                                           │
│  ┌──────────────────────────────────────────────────┐            │
│  │            email/ (provider abstraction)          │            │
│  │  - EmailProvider (interface)                    │            │
│  │  - ResendProvider (impl, uses resend SDK)        │            │
│  │  - EmailProviderError (typed errors)            │            │
│  └──────────────────────────────────────────────────┘            │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**Flujo: invitación por email** (cierra D3.4 mitad funcional):

```
1. Owner POST /api/firms/:id/invitations {email, role}
2. handler actual: createInvitation() crea row en tenant_invitations
3. NUEVO: enqueueJob('send_invitation_email', {invitationId}, {idempotencyKey: 'invite-' + invitationId})
4. server responde 200 al owner con el link (forward-compat: UI muestra "we'll send the email")
5. Worker poll, claim, dispatch
6. send_invitation_email handler:
   a. Lee tenant_invitations row.
   b. Resuelve firm + inviter.
   c. Genera URL: https://worgena.com/onboarding?token=XYZ
   d. EmailProvider.sendEmail({to, subject, html})
   e. markJobCompleted
7. Si email falla: markJobFailed, retry con backoff, después de 5 → dead_letter.
```

**Flujo: cleanup periódico** (Habeas Data):

```
1. Worker startup → enqueueJob('cleanup_audit', {olderThanMs: 365*24*3600*1000}, {scheduledAt: now})
2. Worker también re-encola este job cada 24h (en el handler, con scheduledAt: now + 24h)
3. Handler: DELETE FROM audit_auth WHERE created_at < ?
4. Idempotente: si se corre 2 veces el mismo día, no hace nada nuevo.
```

---

## 6. Archivos a tocar / crear

| Archivo | Acción | Razón |
|---|---|---|
| `src/lib/db.ts` | modificar | Agregar tabla `jobs` + 3 índices. Migrations additive. |
| `src/lib/jobs/repository.ts` | crear | CRUD de jobs: enqueue, claim, mark completed/failed/dead_letter, list. |
| `src/lib/jobs/worker.ts` | crear | Loop asíncrono con claim + dispatch. SIGTERM handling. |
| `src/lib/jobs/handlers/index.ts` | crear | Registry de handlers (Map<type, Handler>). |
| `src/lib/jobs/handlers/send-invitation-email.ts` | crear | Lee invitation, genera URL, manda email. |
| `src/lib/jobs/handlers/enforce-credit-warning.ts` | crear | Lee balance, si < 20% manda email. |
| `src/lib/jobs/handlers/cleanup-audit.ts` | crear | DELETE audit_auth older than. |
| `src/lib/jobs/handlers/cleanup-invitations.ts` | crear | DELETE tenant_invitations expiradas. |
| `src/lib/jobs/handlers/send-email-generic.ts` | crear | Email ad-hoc. |
| `src/lib/jobs/index.ts` | crear | Barrel exports + `startWorker()` helper. |
| `src/lib/email/provider.ts` | crear | Interface `EmailProvider` + `EmailProviderError`. |
| `src/lib/email/resend-client.ts` | crear | `ResendProvider` impl. |
| `src/lib/email/index.ts` | crear | Barrel. |
| `src/lib/auth/firm.ts` | modificar | Después de `createInvitation()`, encolar `send_invitation_email`. |
| `src/lib/billing/billing.ts` | modificar | Después de `consumeCredit()` que baje balance < 20%, encolar `enforce_credit_warning` (idempotent). |
| `server.ts` | modificar | Iniciar el worker al startup. Forward-compat: flag para deshabilitar en tests. |
| `package.json` | modificar | Agregar `resend` (SDK oficial). |
| `.env.example` | modificar | Agregar `RESEND_API_KEY`, `MAX_JOB_ATTEMPTS`, `MAX_CONCURRENCY`, `JOB_POLL_INTERVAL_MS`. |
| `test_jobs_v1.mts` | crear | 18+ tests E2E. |
| `BACKLOG_P0.md` | modificar | Marcar P0 #5 cerrado al completar. |
| `HANDOFF.md` | modificar | Documentar sprint. |
| `AGENT_BILLING_V1_SPEC.md` | modificar | Marcar jobs como no-bloqueante (ya está). Sin cambios. |

---

## 7. Tests

- **18+ tests nuevos** en `test_jobs_v1.mts` (estructura similar a `test_firm_membership.mts`):
  - **Bloque A: Schema** (3 tests). Tabla `jobs` existe con columnas. UNIQUE en `idempotency_key` cuando está presente. Índices `(status, scheduled_at)` existen.
  - **Bloque B: Repository** (5 tests). enqueue crea row. claimPendingJobs retorna los más viejos pending. claimPendingJobs no retorna running. markJobCompleted/failed/dead_letter cambian status correctamente. listJobs filtra por type/status.
  - **Bloque C: Atomicidad** (3 tests). Dos claimPendingJobs concurrentes no retornan los mismos jobs. UPDATE atómico pending→running via SQL. Backoff calcula `nextRunAt` correcto.
  - **Bloque D: Worker** (3 tests). Worker procesa un job end-to-end (mocked handler). Worker reintenta con backoff en fallo. Worker marca dead_letter después de MAX_ATTEMPTS.
  - **Bloque E: Handlers** (4 tests). `send_invitation_email` lee invitation, llama EmailProvider con args correctos. `enforce_credit_warning` no manda email si balance > 20%. `cleanup_audit` borra rows old y deja nuevas. `cleanup_invitations` borra expired+used y deja active.
  - **Bloque F: Multi-tenancy** (2 tests). Handler con `firmId` filtra correctamente. Job sin `firmId` que toca firm data falla loud.
  - **Bloque G: Integración D3.4** (1 test). `createInvitation()` encola `send_invitation_email` automáticamente. Verifica que el job está en la tabla.
  - **Bloque H: Email mock** (1 test). `EmailProvider` interface se puede mockear. Tests no llaman a Resend real.

- **Regression**: 455 tests acumulados deben seguir pasando. Backward-compat: D3.4 sigue funcionando aunque `enqueueJob` esté no disponible (envoltorio seguro).

- **Smoke opcional**: con `RESEND_API_KEY` real, un test E2E que manda un email a una dirección de prueba. Skip si no hay key.

---

## 8. Riesgos

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| Email provider (Resend) rate limit o downtime | media | medio | **P3 backoff** + **P10 dead_letter**. Operador ve en DB y reintenta. Forward-compat: swap a SendGrid sin cambio de código. |
| Jobs duplicados (worker corre 2 veces) | baja | medio | **P1 atomicity** (claim SQL atómico). Test C1 verifica. |
| Worker crash mid-job | media | medio | `claimPendingJobs` solo retorna `status='pending'`. Si un job queda `running` (crash), hay 2 opciones: (a) timeout (job > N minutos running se considera fallido), (b) operador interviene. v1 deja que el operador intervenga. Forward-compat: agregar `started_at` check. |
| `cleanup_audit` borra rows que no debería | baja | alto | La query usa `created_at < ?` con threshold explícito. Test E3 verifica. Operator ve qué se va a borrar con `SELECT count(*)` antes de ejecutar. |
| Email sale del sender y entra en spam | media | medio | Resend maneja deliverability + webhooks. Doc en onboarding: "usá tu propio dominio verificado". |
| Habeas Data violation: cleanup borra antes de tiempo | baja | alto | Threshold default 1 año. Configurable. Spec documenta el threshold y la justificación legal. **Compliance review** del founder antes de poner en producción. |
| Worker consume CPU con poll cada 1s | baja | bajo | `JOB_POLL_INTERVAL_MS=1000` default. Si DB tiene >10k pending jobs, el poll se vuelve caro. Forward-compat: usar LISTEN/NOTIFY (Postgres) o notificaciones (SQLite no soporta nativamente). |
| Backoff con jitter genera tiempos muy largos | baja | bajo | Max backoff = 1h. Después de 5 intentos: dead_letter. Operador puede intervenir. |
| `send_email_generic` se usa como vector de spam | media | medio | NO-exposure. El handler no se invoca directamente desde un endpoint público. Solo desde otros handlers. Forward-compat: rate limiting por firm si se expone. |

---

## 9. Orden de ejecución

> Por FUNDAMENTO, no por velocidad de feedback. Schema y primitivas antes que handlers.

1. **Schema + repository** (Día 1 mañana). Tabla `jobs` en `db.ts`. Repository con enqueue, claim, mark. Tests A + B + C. **Sin schema, nada más se puede testear.**
2. **Email provider** (Día 1 tarde). Interface `EmailProvider` + `ResendProvider` impl. Mock para tests. Test H.
3. **Handlers** (Día 2 mañana). Los 5 handlers, uno por uno. Tests E. Empezar por `send_invitation_email` (cierra D3.4 mitad funcional).
4. **Worker loop** (Día 2 tarde). Loop asíncrono, claim, dispatch, retries. Tests D.
5. **Integración D3.4** (Día 3 mañana). `createInvitation()` encola automáticamente. Test G.
6. **Integración P0 #4 billing** (Día 3 tarde). `consumeCredit()` que baje balance < 20% encola warning. Forward-compat: idempotencia por día.
7. **Startup del worker** (Día 4 mañana). `server.ts` arranca el worker. Graceful shutdown. Test de integración E2E.
8. **Regression + cleanup** (Día 4 tarde). Correr 455 tests acumulados. HANDOFF + AGENT_ROADMAP actualizados. Commit + push.

**Tiempo total estimado**: 4 días. Si se atrasa, los puntos críticos son 1, 3, 4 (schema, handlers, worker). Integraciones 5-6 son nice-to-have para el cierre.

---

## 10. Definition of Done

- [ ] O1: Tabla `jobs` en `db.ts` con 3 índices, migrations idempotentes.
- [ ] O2: Repository con 6 funciones, todas con tests B1-B5.
- [ ] O3: Worker loop con backoff, retries, dead_letter, SIGTERM handling. Tests D1-D3.
- [ ] O4: EmailProvider interface + ResendProvider impl. Test H1.
- [ ] O5: 5 handlers implementados y testeados (E1-E4 mínimo).
- [ ] O6: D3.4 `createInvitation()` encola `send_invitation_email` automáticamente. Test G1.
- [ ] O7: Billing `consumeCredit()` encola `enforce_credit_warning` cuando balance < 20%.
- [ ] O8: Worker al startup encola cleanup jobs.
- [ ] O9: 18+ tests en `test_jobs_v1.mts`.
- [ ] Cero objetivo de §3 implementado.
- [ ] P1-P10 (primitivas) todas en el código + testeadas.
- [ ] `tsc` limpio.
- [ ] 455 tests acumulados + 18 nuevos = 473+ tests pasando, 0 regresiones.
- [ ] `BACKLOG_P0.md` actualizado: **P0 #5 marcado cerrado. BACKLOG P0 COMPLETO.**
- [ ] `HANDOFF.md` actualizado.
- [ ] `package.json` actualizado con `resend`.
- [ ] `.env.example` con las nuevas variables.

---

## 11. Decisiones abiertas (a resolver durante implementación)

- **D1. Resend SDK vs fetch directo**. Resend SDK es ~3KB, Node oficial, soporta webhooks de delivery. Probablemente SDK. **Default**: SDK. Si fricción, swap a fetch.
- **D2. ¿Cómo saber si un firm está en < 20% del plan?** Opción A: trigger en `consumeCredit` que chequee threshold. Opción B: cron job que recorra todos los firms cada 24h. **A** es más proactivo (avisa en el momento), pero requiere idempotencia. **Default**: A con idempotency_key = `credit-warning-{firmId}-{YYYY-MM-DD}`.
- **D3. ¿Cleanup cada cuánto?** v1 hardcodea 24h. Forward-compat: configurable por job type.
- **D4. ¿Threshold de credit warning 20% o 10%?** Spec dice 20%. Forward-compat: configurable por plan.
- **D5. ¿Los jobs usan el mismo DB que billing/firm?** Sí. Forward-compat: jobs pueden tener su propio DB si crecen mucho (>100k jobs/día). Por ahora mismo DB.

---

## 12. Referencias

- **Contexto del backlog**: `BACKLOG_P0.md` §5 (jobs system).
- **Decisión email provider (Resend)**: `BACKLOG_P0.md` §5.4 (founder 2026-06-25).
- **Decision framework Bull/Graphile/Custom**: `BACKLOG_P0.md` §5.4 (custom in-house durante SQLite; Graphile cuando se migre a Postgres).
- **Multi-tenant D3.4 redesign**: `AGENT_D3_4_REDESIGN_SPRINT_SPEC.md` (commit `fd80b1d`).
- **Billing P0 #4**: `AGENT_BILLING_V1_SPEC.md` (commit `aac1c77`). Cross-ref: webhook de ePayco puede migrar a jobs si latency > 5s.
- **Cost attribution P0 #3**: `BACKLOG_P0.md` §3. `enforce_credit_warning` se enchufa en el mismo punto que `consumeCredit`.
- **Habeas Data retention**: `BACKLOG_P0.md` §5.3 (`cleanup_audit`). Ley 1581/2012 + decretos.
- **Audit auth D3.5**: `src/lib/auth/audit.ts`. Tabla `audit_auth` con `created_at`.
- **Invitaciones D3.4**: `src/lib/auth/firm.ts`. Tabla `tenant_invitations` con `expires_at` y `used_at`.
- **Patrón de cliente HTTP con transport inyectable**: `src/agent/llm/openrouter-client.ts`, `src/lib/billing/epayco-client.ts`. Mismo patrón para `ResendProvider` (transport para tests).
