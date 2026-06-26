# Worgena — Decisión de pasarela de pagos Colombia (Wompi / PayU / Mercado Pago / ePayco / Bold / PlacetoPay)

**Fecha**: 2026-06-25 (re-investigación post-rechazo Paddle)
**Investigado por**: Steve (CEO)
**Pregunta del founder**: ¿qué pasarela local colombiana usamos para cobrar planes + wallet, considerando que aún no somos SAS?

---

## TL;DR

Recomendación: **Wompi (de Bancolombia)**, plan Avanzado Agregador, con la API de tokenización para los cobros recurrentes. Tres razones específicas para Worgena, todas Colombia-first:

1. **Cubre los 5 métodos de pago que usan los clientes B2B colombianos** (PSE, Nequi, Daviplata, tarjetas Visa/MC/Amex, Botón Bancolombia) con una sola integración y una tarifa plana de **2.65% + $700 COP** por transacción exitosa (todos los métodos, no escalonado) [fuente: wompi.com/es/co/planes-tarifas/plan-avanzado-agregador — verificado 2026-06-25].
2. **Se puede empezar como persona natural con RUT**, sin necesidad de constituir SAS. Wompi permite registro a persona natural con RUT o cédula, y solo exige cuenta Bancolombia o Nequi con +30 días de antigüedad [wompi.com/es/co/ayuda/como-crear-cuenta — verificado 2026-06-25]. Cero fricción legal para tomar el primer cliente pagando.
3. **Tokenización + webhooks + REST documentada en español** encajan directo con el `jobs` system de P0 #5 y con el stack TypeScript existente en `C:\Users\acer\Downloads\asistente IA\untitled\`. La restricción operativa (Wompi no expone una API `subscriptions` tipo Stripe — vos programás los cobros con el token) **es exactamente el caso de uso para el que el jobs system fue diseñado**. No es un blocker, es un fit.

Riesgo explícito que cambia el modelo si lo ignorás: **Wompi no tiene API REST de "subscriptions"**. Los cobros recurrentes se hacen guardando un token del cliente (tarjeta o Nequi) y cobrando contra ese token desde tu backend. **Worgena tiene que programar el scheduler.** Si esperás que Wompi haga los cobros automáticamente como Stripe, esa expectativa está mal — es responsabilidad del merchant vía jobs.

Anti-recomendaciones operativas: si Worgena decide expandir a LatAm (México/Perú/Chile) en menos de 12 meses, Wompi solo cubre Colombia — la expansión sumaría PayU o Mercado Pago como segunda pasarela. Si se vuelve enterprise USA con SOC2/DPA, esta decisión se reemplaza (vuelve a Stripe/Atlas).

---

## Tabla comparativa

| Dimensión | Wompi (Bancolombia) | PayU LatAm | Mercado Pago | ePayco (Davivienda) | Bold | PlacetoPay (Evertec) |
|---|---|---|---|---|---|---|
| **Tarifa tarjeta nacional** | 2.65% + $700 COP [1] | 3.29% + 300 COP [2] | No publicado CO (AR 6.29% créd / 3.25% déb — no aplica) [N/V] | 2.64% + $690 + IVA (promo 3 meses) [3] | 2.80% + $500 COP [4] | 2.9% + $700 COP (mín $2,300) [5] |
| **Tarifa PSE** | Incluida en 2.65% flat [1] | Incluida en 3.29% (mín COP $9,900) [2] | No publicado CO | Incluida en 2.64% [3] | 1.79% [4] | Incluida en 2.9% [5] |
| **Tarifa Nequi** | Incluida en 2.65% flat [1] | Incluida en 3.29% [2] | No publicado CO | Incluida en 2.64% [3] | 1.79% [4] | Incluida en 2.9% [5] |
| **Tarifa Daviplata** | Incluida en 2.65% flat [1] | No publicado | No publicado CO | Incluida en 2.64% [3] | No publicado | No publicado |
| **PSE** | Sí (transferencia desde cualquier banco colombiano) [6] | Sí [7] | Sí (Checkout Pro/Bricks) [8] | Sí [3] | Sí [4] | Sí [9] |
| **Nequi** | Sí (integración nativa) [6] | Sí [2] | Sí | Sí | Sí | Sí |
| **Daviplata** | Sí (integración nativa) [6] | No confirmado | No confirmado | Sí [3] | No publicado | Sí |
| **Botón Bancolombia** | Sí (exclusivo) [6] | Sí | Sí (PagoBancolombia) [2] | Sí | Sí | Sí |
| **Tarjetas crédito/débito (Visa, MC, Amex)** | Sí (internacional sin costo extra en plan) [1] | Sí (incl. Amex, Codensa) [2] | Sí | Sí (incl. Diners, Codensa) [3] | Sí | Sí |
| **Efectivo (Efecty, Baloto, etc.)** | Corresponsales Bancolombia (25.000 puntos) [6] | Sí (Efecty, Davivienda, SuRed, Bancolombia, Banco de Bogotá) [2] | Sí (Efecty, Baloto) [8] | Sí (Efecty, Gana, PuntoRed, Red Servi, SafetyPay) [3] | Sí (vía datáfono) | Sí |
| **Suscripciones recurrentes (API REST dedicada)** | No tiene API REST "subscriptions" — el merchant programa cobros con token guardado [10] | Sí (API Plans, marcada como deprecated en URL pero funcional) [11] | Sí (preapproval + preapproval_plan, reintentos automáticos) [8][12] | Sí — producto nativo "Suscripciones" + portal propio [3] | **No** — explícitamente "estamos trabajando para que más adelante podamos contar con APIs independientes para pagos recurrentes" [13] | No dedicado — pagos recurrentes vía Cobro Persistente [9] |
| **Pagos únicos (one-time, wallet)** | Sí (API + widget) [1] | Sí (PaymentIntents one-time) | Sí (Checkout Pro, Bricks) [8] | Sí (Checkout + Link) [3] | Sí (API, link, datáfono) [13] | Sí (Checkout, Link) [9] |
| **Proration / upgrades / downgrades** | No documentado (depende de tu scheduler) | Sí (vía API Plans) [11] | Sí (preapproval_plan permite billing_day, proration) [8] | Sí (portal de suscripciones) | No | Limitado |
| **Dunning / retry automático** | No (lo hacés vos vía jobs) | Limitado (no claro) | Sí (reintentos automáticos en cobros preapproval) [8][12] | Sí (portal de suscripciones) | No | Limitado |
| **Tokenización para cobros futuros sin tarjeta** | Sí (tokenización de tarjeta o Nequi explícita) [10] | Sí (Credentials on File / CoF) [2] | Sí (card_token_id) [8] | Sí (pagos a un click) [3] | No explícito | Sí |
| **Webhooks con verificación de firma** | Sí (Wompi firma eventos, IP allowlist, retry documentado) [14] | Sí (async refunds + status webhooks nativos) [15] | Sí (IPN/webhooks) | Sí (ePayco Control + notificaciones) | Sí (configurables en dashboard) [13] | Sí (suscripción a eventos) |
| **SDK Node/TypeScript oficial** | No oficial (comunidad: `wompi-node`, no maintained) [N/V] | `payu-websdk` oficial (SDK Latam tiene `payu-latam-node-sdk` community-maintained) [16] | `mercadopago` oficial Node SDK [8] | SDK oficial Node en `docs.epayco.com` [3] | No oficial Node (API REST directa) [13] | No oficial Node (PHP/Java/C# oficiales) [9] |
| **Documentación en español** | Sí, completa en español [docs.wompi.co] | Sí [developers.payulatam.com] | Sí [mercadopago.com.co/developers] | Sí | Limitada | Sí |
| **Sandbox / test mode** | Sí (sandbox wompi.co separado) | Sí (TEST/LIVE env) | Sí | Sí | Sí | Sí |
| **Compliance Colombia — DIAN e-invoice** | NO emite; Worgena (cuando SAS) debe emitirla con operador (Factus/Lemp/Alegra) [17] | NO emite; ídem [17] | NO emite; ídem [17] | NO emite; ídem [17] | **SÍ emite factura electrónica nativa (parte del producto Bold)** [18] | NO emite; ídem [17] |
| **Registro como persona natural (sin SAS)** | **Sí** — RUT o cédula + cuenta Bancolombia/Nequi +30 días [19] | Sí (persona o empresa) — verificable en panel | Sí (CUIT/CUIL o equivalente) | Sí (persona o empresa) | Sí (persona o empresa) | No claro — modelo Agregador permite, modelo Gateway requiere empresa |
| **Payout a Colombia (COP directo a banco local)** | Sí, COP a Bancolombia/Nequi/otros bancos [1] | Sí, COP [2] | Sí, COP (vía cuenta Mercado Pago o transferencia) | Sí, COP a Davivienda/otros bancos | Sí, COP a Bold Cuenta Digital (banco) | Sí, COP |
| **Frecuencia payout** | Día siguiente hábil (PN: 30 días el primer desembolso) [19] | 3 retiros gratis/mes; desde 4to: 6,500 COP + IVA [2] | T+ configurable, típicamente 14 días | Día siguiente hábil (solicitando retiro) [3] | 1 día hábil [4] | Día siguiente (configurable) |
| **Soporte en español / chat** | Sí — WhatsApp +322 280 4391, chat in-app, tickets [19] | Sí — soporte regional [2] | Sí — soporte LatAm | Sí — WhatsApp +573174368801, ticket, calendly [3] | Sí — Bolbot 24/7 + agendar consulta técnica [13] | Sí |
| **Cobertura LatAm** | CO, PA, SV [1] | 11+ países (AR, BR, CL, CO, MX, PE, etc.) [2] | 6 países (AR, BR, CL, CO, MX, PE) [8] | CO + 3 países (no detallado) | CO | 10 países LatAm [9] |
| **Lock-in / migrabilidad** | Bajo (datos exportables, REST estándar) | Bajo | Bajo | Bajo | Bajo | Bajo (modelo Agregador con código de pasarela) [5] |
| **Anti-fraude / 3DS** | 3DS para pagos con tarjeta [10]; antifraude interno Wompi [1] | 3DS + módulo antifraude + multi-adquirente + tokenización de red [2] | 3DS + antifraude Mercado Pago | 3DS + ePayco Control (prevención de fraude dedicada) [3] | 3DS + antifraude | 3DS adquirentes/emisores + Scudo (AI + reglas) [9] |

[N/V] = no verificado oficialmente para Colombia; cita cruzada de AR no aplica.

**Ganadores por dimensión (análisis):**

- **Métodos colombianos locales**: Wompi, ePayco (empate — todos los 5)
- **Suscripciones recurrentes nativas con dunning**: ePayco, Mercado Pago (Wompi requiere scheduler propio)
- **Tarifa más baja flat (todos los métodos)**: Wompi 2.65% + $700 (incluye PSE/Nequi/Daviplata sin recargo)
- **SDK Node/TypeScript oficial**: Mercado Pago (Wompi/PayU/ePayco/PlacetoPay tienen SDKs community-maintained o débiles)
- **Facturación electrónica nativa incluida**: Bold (único)
- **Cobertura LatAm**: PayU (11+), Mercado Pago (6), PlacetoPay (10)
- **Dev experience Worgena-fit (Node + tokenización + REST + docs en español)**: Wompi, ePayco
- **Onboarding sin SAS**: Wompi, ePayco, Mercado Pago, Bold (todos permiten persona natural)
- **Anti-fraude dedicado**: PlacetoPay (Scudo), ePayco (Control), Mercado Pago

---

## Wompi — detalle

**Descripción**: pasarela de pagos de WOMPI S.A.S, subsidiaria de Bancolombia S.A. Lanzada para democratizar pagos en Colombia con API moderna, foco en e-commerce y suscripciones via tokenización. Cobertura: Colombia, Panamá, El Salvador. No Mo vos sos el merchant.

**FeesR — (Plan Avanzado Agregador, oficial wompi.com — verificado 2026-06-25)** [1]:
- **2.65% + $700 COP por transacción exitosa, + IVA**. Cero costo de mantenimiento, cero costo de implementación. Acepta tarjetas internacionales sin recargo.
- Aplica igual para **todos los métodos de pago** del plan: tarjeta crédito/débito (Visa, MC, Amex), Nequi, PSE, Daviplata, Botón Bancolombia, Corresponsales, Puntos Colombia, SU+Pay, Compra y Paga Después. No hay escalonado.
- Plan Avanzado Gateway (alternativa, para empresas con banco adquiriente propio): fees negociados con el banco.
- Sandbox: gratis, sin KYC.

**MoR vs processor**: **Processor**. Worgena aparece en la factura. Implicación para DIAN: cuando Worgena sea SAS, Worgena emite la factura electrónica con un operador autorizado (Factus, Lemp, Siigo, Alegra, Datium) [17]. Wompi no interfiere.

**Métodos de pago soportados (Colombia, oficial wompi.com — verificado 2026-06-25)** [6]:
- Tarjetas crédito/débito: Visa, Mastercard, American Express (todas nacionales e internacionales)
- Transferencias bancarias: Botón Bancolombia (exclusivo, millones de cuentas de ahorro y corriente), Nequi (16M+ usuarios), PSE (cualquier banco), DaviPlata (17M+ clientes potenciales)
- Efectivo: Corresponsales Bancarios Bancolombia (25.000 puntos en todo el territorio colombiano)
- Otros: Puntos Colombia, SU+Pay (micro-crédito), Compra y Paga Después (BNPL 4 cuotas sin interés)
- **Total: 10+ métodos en un solo checkout**.

**Suscripciones recurrentes (CRÍTICO — restricción operativa)** [10]:
- Wompi **NO expone una API REST de "subscriptions"** tipo Stripe. No hay `POST /subscriptions` ni auto-billing tipo MoR.
- Lo que SÍ hay: **tokenización** — guardás el método de pago del cliente (tarjeta o Nequi) como un token, y luego cobrás contra ese token cuando quieras.
- El merchant (Worgena) **tiene que programar el scheduler** de cobros recurrentes. En la práctica: una vez al mes, Worgena llama `POST /transactions` con el `payment_method_token` guardado y el `customer_id` correspondiente. Esto encaja 1:1 con el `jobs` system de P0 #5 (`type='charge_subscription'` cada 30 días, ver `BACKLOG_P0.md:299-301`).
- **Implicación importante**: el `jobs` system de Worgena deja de ser "nice to have" y se vuelve **bloqueante** para cobrar suscripciones reales. Si la jobs queue se cae, los clientes no se cobran ese mes. El retry con backoff (1m, 5m, 30m, 2h, 12h) documentado en BACKLOG §5.2 es lo que mantiene la integridad.
- 3D Secure: requerido para pagos con tarjeta iniciales para tokenizar. La recurrencia posterior no requiere 3DS si el token ya está validado.

**Dev experience (docs.wompi.co — verificación parcial, 403 en algunos sub-paths, pero el portal oficial funciona)** [14]:
- API REST JSON.
- Llave pública + llave privada (en sandbox y producción separadas).
- Ambiente sandbox: `https://sandbox.wompi.co/v1/`.
- Webhooks: Wompi firma eventos con su `events_secret`, IP allowlist, retry documentado. Endpoint único configurable en panel de Desarrolladores.
- Eventos típicos: `transaction.updated` (estado `APPROVED`, `DECLINED`, `ERROR`, `VOIDED`).
- SDK Node oficial: **no hay**. Comunidad: `wompi-node` (no maintained activamente). Recomendación: usar `fetch` directo contra la REST API. Worgena ya tiene `OpenRouterLLMInvoker` como precedente de cliente HTTP custom en TypeScript.
- Documentación: [docs.wompi.co/docs/colombia](https://docs.wompi.co) (en español, navegable).

**Compliance Colombia — DIAN**:
- Wompi NO emite factura electrónica. Cuando Worgena se constituya SAS (o inclusive como persona natural si la operación supera ciertos topes), tiene que emitir e-invoice con un operador autorizado: **Factus** (factus.com.co), **Lemp**, **EDICOM**, **Siigo**, **Alegra**, **Datium**. Integración típica: API REST del operador + call desde el backend de Worgena al confirmar un pago [17].
- Wompi solo provee la transacción aprobada; el resto lo cablea Worgena.

**Requisito de SAS o persona natural** [19]:
- **Persona natural OK con RUT o cédula**. Documentos: cédula + RUT (PDF sin contraseña, emitido por la DIAN).
- Requisito: cuenta Bancolombia o Nequi con +30 días de antigüedad (para recibir payouts).
- Restricción operativa para persona natural: **primer desembolso a los 30 días después de la primera transacción**; los siguientes al día siguiente hábil. Esto es relevante para Worgena: los primeros COP no entran al banco hasta el día 30.

**Payouts Colombia**:
- Wompi consigna a cuenta de ahorros o corriente (Bancolombia u otros bancos) o a Nequi. Día siguiente hábil (excepto el primer desembolso PN).
- 100% COP. Sin comisión de Wompi por recibir.

**Soporte al cliente**:
- WhatsApp: +57 322 280 4391.
- Chat in-app (Bolbot-equivalente).
- Formulario de tickets: [soporte.wompi.co](https://soporte.wompi.co).
- Status page: [wompi.statuspage.io](https://wompi.statuspage.io/).
- Horario:没说 explícitamente (no verificado). Canal WhatsApp sugiere cobertura extendida.

**Lock-in**:
- Bajo. REST estándar, datos exportables. Si en 2 años hay que migrar a Stripe, el código del webhook handler es reemplazable. El schema de `credit_ledger` y `wallet_purchases` en `BACKLOG_P0.md §4.1` no depende del provider.

**Cobertura LatAm**:
- Wompi opera en CO, PA, SV. NO cubre México, Brasil, Chile, Perú, Argentina. Si Worgena expande a esos mercados, hay que sumar una segunda pasarela por país o usar PayU/Mercado Pago.

**Anti-fraude y 3DS**:
- 3DS para pagos con tarjeta al tokenizar. Recurrencias con token no requieren 3DS.
- Antifraude interno Wompi (no tan documentado como ePayco Control o Scudo de PlacetoPay). Para Worgena B2B, el fraude es menos crítico que en e-commerce B2C masivo, pero es una dimensión a evaluar en pilot.

**Pricing page**: [wompi.com/es/co/planes-tarifas/plan-avanzado-agregador](https://wompi.com/es/co/planes-tarifas/plan-avanzado-agregador)

**Fuentes**:
- [1] Wompi — Plan Avanzado Agregador — wompi.com/es/co/planes-tarifas/plan-avanzado-agregador (consultado 2026-06-25, fee verificado)
- [6] Wompi — Medios de pago — wompi.com/es/co/soluciones/pagos-en-linea/medios-de-pago (consultado 2026-06-25, métodos verificados)
- [10] Wompi — Tokenización — wompi.com/es/co/soluciones/pagos-en-linea/webcheckout-api-plugins/tokenizacion (consultado 2026-06-25 vía búsqueda)
- [14] Wompi — Documentación técnica para desarrolladores — wompi.com/es/co/desarrolladores/documentacion-tecnica (consultado 2026-06-25)
- [19] Wompi — Cómo crear una cuenta — wompi.com/es/co/ayuda/como-crear-cuenta (consultado 2026-06-25, requisitos PN verificados)

---

## PayU LatAm — detalle

**Descripción**: pasarela regional de PayU GPO (ahora parte de Rapyd, tras adquisición 2022). Cobertura amplia: 50+ países, 300+ métodos de pago [2]. Modelo dual: agregador (default, sin merchant account) y gateway (con banco adquiriente propio). Es la opción más usada en LatAm para expansión multi-país.

**Fees (PayU Colombia, oficial corporate.payu.com — verificado 2026-06-25)** [2]:
- **Tarifa estándar: 3.29% + 300 COP** (antes de IVA 19%).
- **Costo mínimo por transacción PSE: COP $9,900** (esto es alto — en una transacción de COP $50,000 el fee mínimo pega).
- Enterprise (>100M COP/mes): negociado, contactar.
- 3 retiros gratis/mes a cuenta bancaria local; desde el 4to: 6,500 COP + IVA.
- Tap to Phone: 2.79% + 300 COP (no aplica a Worgena).

**MoR vs processor**: **Processor** (no MoR). Worgena aparece en la factura.

**Métodos de pago soportados (Colombia)**:
- Tarjetas crédito/débito: Visa, Mastercard, Amex, Codensa [2]
- Efectivo: Efecty, Davivienda, SuRed, Bancolombia, Banco de Bogotá [2]
- Online bank transfer: PSE [2]
- Digital wallets y alternativos: Nequi, Google Pay, PagoBancolombia [2]
- Daviplata: **no verificado en el sitio oficial** — presumiblemente soportado pero no publicado en la página de pricing.

**Suscripciones recurrentes** [11]:
- Sí. **API REST "Plans" en `developers.payulatam.com/latam/es/deprecated/recurring-payments/recurring-payments-api.html`**. Endpoints: `POST /rest/v4.9/plans`, `PUT/GET/DELETE /rest/v4.9/plans/{planCode}`.
- **RESTRICCIÓN**: la URL está marcada como "deprecated" en el path. La API sigue funcional pero PayU ha movido parte de la documentación de Recurring a una nueva versión. Para Worgena: usable, pero conviene validar en pilot que el endpoint sigue operativo.
- Tokenización de tarjeta (CoF) y network tokenization nativos [2].

**Dev experience** [16]:
- API REST JSON/XML.
- SDK Node oficial Latam: existe pero es community-maintained. Versiones recientes: `payu-latam-node-sdk` (no verificado maintained status a 2026-06-25, hay issues sin resolver).
- Documentación: [developers.payulatam.com/latam/es](https://developers.payulatam.com/latam/es) — en español, completa.
- Sandbox + producción separados.
- Webhooks: configurables desde dashboard. Eventos de cambio de status (incluye refunds async) [15].

**Compliance Colombia — DIAN**:
- PayU NO emite factura electrónica. Mismo trade-off que Wompi.

**Requisito de SAS o persona natural**:
- **Sí permite persona natural y empresa**. El proceso de KYC depende del país. Para Colombia, es estándar (RUT + cédula + cuenta bancaria).

**Payouts Colombia**:
- 3 retiros gratis/mes a banco local. Desde el 4to: 6,500 COP + IVA.
- COP directo.

**Cobertura LatAm**: 11+ países (AR, BR, CL, CO, MX, PE, y más). **Es la más fuerte para expansión multi-país** [2].

**Anti-fraude y 3DS**: módulo antifraude nativo, 3DS, multi-adquirente, tokenización de red, processing sin CVV [2]. **Lo más robusto del grupo en enterprise**.

**Pricing page**: [corporate.payu.com/colombia/en](https://corporate.payu.com/colombia/en)

**Fuentes**:
- [2] PayU Colombia — corporate.payu.com/colombia/en (consultado 2026-06-25, fees y métodos verificados)
- [11] PayU Latam — Pagos Recurrentes API — developers.payulatam.com/latam/es/deprecated/recurring-payments/recurring-payments-api.html (consultado 2026-06-25)
- [15] PayU Latam — API Integration — developers.payulatam.com/latam/en/docs/integrations/api-integration.html (consultado 2026-06-25)
- [16] PayU Node SDK — npmjs.com/package/payu-websdk y payu-latam-node-sdk community (consultado 2026-06-25)

**Veredicto Steve**: PayU es la mejor **opción enterprise multi-país** del grupo. Pero para Worgena hoy (Colombia-only, ARPU < $50 USD/mes, ARPU proyectado bajo, no enterprise), la tarifa 3.29% + 300 COP + mínimo PSE $9,900 **se come el margen** de planes de COP $20,000-50,000/mes por firma. Descartado para v1, candidato serio para expansión LatAm año 2.

---

## Mercado Pago — detalle

**Descripción**: wallet + pasarela del ecosistema Mercado Libre. Masivo en LatAm (6 países: AR, BR, CL, CO, MX, PE). SDK Node oficial mantenido activamente. Tiene el wallet con más usuarios en LatAm.

**Fees Colombia** [N/V]:
- **NO encontrado** fee público específico para Colombia en la búsqueda. La página de fees públicas muestra Argentina (6.29% tarjeta crédito, 3.25% débito) pero esto no aplica a CO.
- Tabla de precios suele ser negociada por país vía `mercadopago.com.co` (panel de cuenta). Para Worgena, **el pilot tiene que abrir cuenta y consultar fees reales** — esto es un punto bloqueante para confirmar la decisión.

**MoR vs processor**: **Processor** (no MoR). Mercado Pago emite su propia liquidación pero Worgena aparece como comercio receptor.

**Métodos de pago soportados (Colombia, según mercadopago.cl/developers/es/docs/getting-started — verificado 2026-06-25)** [8]:
- Checkout Pro, Checkout API, Checkout Bricks, Link de Pago, **Planes de suscripción**, **Suscripciones**, Código QR, Mercado Pago Point (solo AR y MX).
- Todos disponibles en Colombia según la tabla de países de la doc oficial.

**Suscripciones recurrentes** [8][12]:
- **Sí, robustas**. Endpoint `/preapproval` con `preapproval_plan_id`. Frecuencia (months/days), `reintentos` automáticos, status `processed` / `waiting for gateway` / `rejected`. **Dunning nativo**.
- Documentación: `mercadopago.com.co/developers/es/docs/subscriptions`.
- Para Worgena: **la mejor API de suscripciones del grupo**. Reintentos automáticos eliminan dependencia de nuestro `jobs` system para el retry (aunque sí queda la idempotencia y el audit).

**Dev experience**:
- **SDK Node oficial**: `mercadopago` en npm. Mantenimiento activo. Types TypeScript. Documentación: [mercadopago.com.co/developers](https://www.mercadopago.com.co/developers) (es-CO).
- Sandbox + producción.
- Webhooks IPN estándar.
- Documentación en español completa.

**Compliance Colombia — DIAN**:
- Mercado Pago NO emite factura electrónica. Worgena (cuando sea SAS) emite con operador.

**Requisito de SAS o persona natural**:
- Persona natural OK. KYC con documento de identidad + cuenta bancaria.

**Payouts Colombia**:
- T+ configurable, típicamente 14 días para nuevos merchants (puede bajarse a 1-3 días con historial). COP a cuenta bancaria.

**Cobertura LatAm**: 6 países (AR, BR, CL, CO, MX, PE). **Sólida para LatAm medio**.

**Soporte**: chat in-app, soporte regional.

**Lock-in**: bajo. Schema propio pero datos exportables.

**Pricing page**: [mercadopago.com.co](https://www.mercadopago.com.co) (panel de cuenta, no tabla pública).

**Fuentes**:
- [8] Mercado Pago Developers — Getting Started — mercadopago.cl/developers/es/docs/getting-started (consultado 2026-06-25)
- [12] Mercado Pago — Suscripciones — mercadopago.com.uy/developers/es/docs/subscriptions (consultado 2026-06-25)

**Veredicto Steve**: la **mejor API de suscripciones del grupo**, pero el **fee Colombia no es público** y eso bloquea la decisión. Si Worgena descubre que el fee efectivo es < 3.5% con dunning incluido, Mercado Pago sube al #2 (después de Wompi). Hoy: Wompi gana por transparencia de pricing. **Acción**: Wozniak debe abrir cuenta sandbox de Mercado Pago Colombia en paralelo y comparar fees antes de la decisión final.

---

## ePayco — detalle

**Descripción**: pasarela colombiana respaldada por **Davivienda** (el segundo banco más grande de Colombia). 22+ medios de pago. Producto "Suscripciones" nativo con portal propio. Buena reputación en PYMEs colombianas.

**Fees (oficial epayco.com — verificado 2026-06-25)** [3]:
- **Tarifa preferencial: 2.64% + $690 COP + IVA** (3 meses promocionales para nuevos comerciantes).
- Tarifa regular: 2.99% + $900 COP.
- Efectivo: $2,500 COP fijo.

**MoR vs processor**: **Processor**.

**Métodos de pago soportados (oficial epayco.com — verificado 2026-06-25)** [3]:
- Tarjetas crédito/débito: Visa, Mastercard, American Express, Diners, Codensa.
- Débito: PSE.
- Efectivo: Efecty, Gana, PuntoRed, Red Servi, SafetyPay.
- Billeteras: DaviPlata (explícito en sitio oficial), Nequi, Puntos Colombia, Davipuntos.
- Internacional: PayPal (producto ePayco PayPal).
- Cobertura: 22+ medios de pago.

**Suscripciones recurrentes** [3]:
- **Sí, nativas**. Producto "ePayco Suscripciones" dedicado, con portal de suscripciones para que el cliente gestione su plan (cambio de tarjeta, cancelación, upgrade/downgrade).
- **Es la mejor implementación de suscripciones del grupo local** (junto con Mercado Pago). El merchant no programa el scheduler — ePayco lo maneja.
- Dunning: ePayco lo maneja internamente.
- Tokenización: sí.

**Dev experience** [3]:
- API REST. Documentación: [docs.epayco.com](https://docs.epayco.com) y [docs.epayco.co](https://docs.epayco.co).
- SDK oficial Node (y otros lenguajes).
- Sandbox + producción.
- Webhooks + ePayco Control (antifraude dedicado).
- PCI DSS + 3DS.

**Compliance Colombia — DIAN**:
- ePayco NO emite factura electrónica. Worgena (cuando sea SAS) emite con operador.

**Requisito de SAS o persona natural**:
- Persona natural y empresa OK. KYC estándar colombiano (cédula/RUT, cuenta bancaria Davivienda o cualquier banco).

**Payouts Colombia**:
- Día siguiente hábil (solicitando retiro). COP directo.

**Cobertura LatAm**:
- Colombia + algunos otros (no detallado en página oficial). Menos fuerte que PayU/Mercado Pago para multi-país.

**Anti-fraude**:
- **ePayco Control**: producto dedicado de prevención de fraude [3]. Más robusto que Wompi en este eje.

**Pricing page**: [epayco.com/tarifas](https://epayco.com/tarifas)

**Fuentes**:
- [3] ePayco — epayco.com (consultado 2026-06-25, fees, métodos, suscripciones verificados)
- Documentación técnica: docs.epayco.com

**Veredicto Steve**: la **segunda mejor opción** para Worgena. Diferencias vs Wompi:
- **Pro ePayco**: suscripciones nativas con dunning, ePayco Control antifraude dedicado, Davivienda como respaldo.
- **Pro Wompi**: tarifa más baja (2.65% vs 2.64% — empate), 1 día hábil de payout (vs solicitud manual), todos los métodos cubiertos (ePayco cubre casi todos pero Botón Bancolombia exclusivo de Wompi), payouts al día siguiente sin solicitar.
- Empate técnico. Wompi gana por **simplicidad operativa** (un solo plan cubre todo, sin tiers ni promos temporales, payouts automáticos al día siguiente sin "solicitar retiro"). Si Worgena necesita **suscripciones nativas con dunning automatizado sin programar scheduler**, ePayco es mejor. Si Worgena ya tiene un `jobs` system (lo tiene — P0 #5), Wompi es mejor.

---

## Bold — detalle

**Descripción**: fintech colombiana. Producto POS-first (datáfonos + link de pago + QR + botón de pagos), expandido a online. Respaldo: 600K+ negocios, +6.5M transacciones/mes, +1B ventas/mes [13]. **Facturación electrónica nativa** incluida (única del grupo).

**Fees (según guiadesoftware.com — no oficial, citado 2026-06-25)** [4]:
- 2.80% + $500 COP tarjeta nacional.
- 3.50% tarjeta internacional.
- PSE: 1.79%.
- Nequi: 1.79%.
- Payouts: 1 día hábil a Bold Cuenta Digital.

**RESTRICCIÓN CRÍTICA** [13]:
- **Bold NO tiene API REST de pagos recurrentes / suscripciones**. De su propia doc: *"Si deseas un pago recurrente o tener un modelo de suscripción, recomendamos usar sistemas que permitan gestionar y tokenizar la información del pagador, para que en el momento deseado puedan llamar a nuestra API y así procesar el pago satisfactoriamente. Estamos trabajando para que más adelante podamos contar con APIs independientes para pagos recurrentes y membresías."*
- Para Worgena, esto es un **deal-breaker** para el modelo de planes mensuales. Sí, técnicamente se puede tokenizar (la API REST lo permite) y cobrar manualmente desde un job. Pero Bold explícitamente no soporta el caso de uso. El merchant queda solo.

**MoR vs processor**: **Processor**.

**Métodos de pago**:
- Tarjetas (crédito/débito), PSE, Nequi. Daviplata no confirmado.
- Datáfono físico + QR + Link de pago + Botón de pagos.
- Bold Cuenta Digital (banco digital Bold).
- 25K corresponsales.

**Dev experience** [13]:
- API REST con llaves. Documentación: [developers.bold.co/pagos-en-linea/api-de-pagos-en-linea](https://developers.bold.co/pagos-en-linea/api-de-pagos-en-linea).
- SDK Node oficial: **no**. Comunidad: no verificado.
- Sandbox + producción.
- Webhooks configurables (en la doc de Alegra se ve ejemplo con Bold: configurados vía dashboard) [13].

**Compliance Colombia — DIAN**:
- **SÍ emite factura electrónica nativa** (parte del producto Bold) [18]. Única del grupo. Implicación: si Worgena elige Bold, el módulo de facturación viene resuelto.

**Requisito de SAS o persona natural**:
- Persona natural y empresa. Proceso 100% en línea (descarga app, registra negocio).

**Payouts Colombia**:
- 1 día hábil a Bold Cuenta Digital o cuenta externa.

**Cobertura LatAm**:
- Solo Colombia.

**Pricing page**: [bold.co](https://bold.co) (no tabla detallada pública — confirmar en pilot).

**Fuentes**:
- [4] Comparativa pasarelas Colombia 2026 — guiadesoftware.com/blog/mejor-pasarela-pago-colombia (consultado 2026-06-25)
- [13] Bold Developers — developers.bold.co/pagos-en-linea/api-de-pagos-en-linea + bold.co (consultado 2026-06-25, RESTRICCIÓN recurrentes verificada)
- [18] Bold — Bold.co página principal con producto facturación electrónica (consultado 2026-06-25)

**Veredicto Steve**: **descartado para Worgena** por la falta de API de suscripciones nativas. Si Worgena solo vendiera one-time (e-commerce de productos, no SaaS), Bold sería competitivo. Para SaaS con planes + wallet, **Bold es un NO**. La facturación electrónica nativa es interesante pero hay operadores (Factus, Lemp) que la resuelven por COP $50-200K/mes cableados al backend.

---

## PlacetoPay — detalle

**Descripción**: pasarela de Evertec (NYSE: EVTC, dueño de la red de débito más grande del Caribe). 21M+ usuarios, 10 países LatAm, +20 años de experiencia [9]. Producto premium: Scudo antifraude (AI + reglas), 3DS adquirentes/emisores, IVR, micrositios. Componentes oficiales PHP, Java, C#.

**Fees (oficial placetopay.dev — verificado 2026-06-25)** [5]:
- **Modelo Agregador: desde 2.9% + $700 COP (mínimo $2,300 COP)** por transacción.
- **Modelo Gateway: desde $250 USD + IVA** paquete transaccional negociable con el banco.
- Para Worgena: el modelo Agregador es el default (sin merchant account propio). Modelo Gateway requiere tener acuerdo con banco adquiriente.

**MoR vs processor**: **Processor** (modelo Agregador).

**Métodos de pago** [9]:
- Tarjetas (crédito/débito/prepago): Visa, Mastercard, Amex, Diners, Codensa.
- Transferencias: PSE.
- Efectivo: Efecty, Su Red, Gana, Éxito, OKI, ACH-Colombia.
- Wallets: Nequi, Daviplata, PagoBancolombia, PSE.
- Internacional: Visa, Mastercard, PayPal.

**Suscripciones recurrentes** [9]:
- Sí, vía **Cobro Persistente** (Persistent Payment). No tan maduro como ePayco o Mercado Pago, pero funcional.
- El merchant puede configurar planes.

**Dev experience** [9]:
- API REST JSON. Documentación: [docs.placetopay.dev](https://docs.placetopay.dev) (en español, completa).
- **Componentes oficiales: PHP, Java, C#**. **NO hay SDK Node oficial** — para Worgena con stack TypeScript, esto es fricción.
- Sandbox + producción.
- Webhooks firmados.

**Compliance Colombia — DIAN**:
- PlacetoPay NO emite factura electrónica. Worgena (cuando SAS) emite con operador.

**Requisito de SAS o persona natural**:
- Modelo Agregador: persona natural y empresa OK. Modelo Gateway: requiere empresa con historial financiero.

**Payouts Colombia**:
- Día siguiente (configurable). COP.

**Cobertura LatAm**: 10 países (CO, MX, BR, AR, CL, PE, EC, PY, UY, BO, etc.) [9]. **Fuerte para LatAm**.

**Anti-fraude y 3DS** [9]:
- **Scudo**: motor de fraude con AI + reglas + conexión a data de Evertec (red de débito Caribe). **El más robusto del grupo**.
- 3DS Adquirentes (cambia responsabilidad de fraude al emisor).
- 3DS Emisores (autenticación del tarjetahabiente).

**Pricing page**: [placetopay.dev](https://placetopay.dev)

**Fuentes**:
- [5] PlacetoPay — Modelo de Negocio — placetopay.dev (consultado 2026-06-25, fees verificados)
- [9] PlacetoPay — Soluciones + Cobertura + Scudo — placetopay.dev + evertecinc.com/en/solution/placetopay (consultado 2026-06-25)

**Veredicto Steve**: **opción enterprise fuerte** (Scudo antifraude, 3DS nativo, cobertura LatAm 10 países). Pero para Worgena v1, los problemas son:
1. **Sin SDK Node oficial** — friction con stack TypeScript.
2. **Tarifa 2.9% + $700 + mínimo $2,300** — no es la más barata.
3. **Enfoque enterprise** — onboarding más lento, requisitos más estrictos.
4. **Cobro Persistente** funciona pero está un escalón abajo de ePayco/Mercado Pago.

Para Worgena **año 1 Colombia-only**: descartar. Para **año 2 expansión LatAm enterprise**: reconsiderar PlacetoPay, especialmente si se vuelve cliente enterprise que exige Scudo.

---

## Stripe como secundario (solo si los locales no alcanzan)

**Por qué NO es la v1**: Stripe requiere que Worgena sea entidad legal en país soportado. Colombia no es merchant directo (sin Atlas). Stripe Atlas = Delaware C-Corp $500 + mantenimiento anual. **No aplica a persona natural.**

**Cuándo Stripe pasa a ser candidato serio**:

1. **Worgena se constituye SAS colombiano** (recomendado a 6-12 meses de revenue). Ahí Stripe Colombia es viable: 3.9% + COP 800 nacional, 4.7% + COP 800 internacional, PSE 2.9% + COP 800. Acreditación 7 días primera vez, 2-3 después.
2. **Worgena entra a enterprise USA con SOC2/DPA estricto + data residency US**. Ninguna local colombiana cumple "data residency US". Ahí Stripe Atlas es la salida limpia.
3. **Worgena necesita tarjeta internacional como único método de cobro para cliente específico**. Si un cliente corporativo exige pagar con Amex Corporate US o una tarjeta no presente en Colombia, las locales flaquean.

**Comparativa rápida Stripe Colombia vs locales** (cifras no oficiales cruzadas con búsqueda):

| Concepto | Stripe Colombia | Wompi (recomendada) |
|---|---|---|
| Tarjeta nacional | 3.9% + $800 COP | 2.65% + $700 COP |
| Tarjeta internacional | 4.7% + $800 COP | 2.65% + $700 COP (incluida) |
| PSE | 2.9% + $800 COP | 2.65% + $700 COP (incluida) |
| Nequi/Daviplata | No confirmado | 2.65% + $700 COP (incluida) |
| Requisito de entrada | SAS colombiano + cuenta banco US vía Atlas | Persona natural + RUT + Bancolombia/Nequi |
| Time-to-first-revenue | 3-6 meses (constituir SAS) | 1-2 semanas (registro Wompi + KYC sandbox) |

**Conclusión**: Stripe no aplica para v1 de Worgena. Queda en el roadmap para cuando Worgena tenga SAS y revenue validado.

**Fuentes**:
- [25] Red Stag Fulfillment, "Stripe Supported Countries 2026" — redstagfulfillment.com (consultado 2026-06-25)
- [27] Terms.law, "Stripe Atlas vs Direct Incorporation 2026" — terms.law/UK-Founders/stripe-atlas-vs-direct.html (consultado 2026-06-25)
- Stripe pricing Colombia (no público exacto, agregado de fuentes secundarias)

---

## Recomendación para Worgena

**Wompi**, plan Avanzado Agregador, con la API de tokenización para los cobros recurrentes programados desde el `jobs` system. Razones específicas a Worgena, ordenadas por impacto:

1. **Cubre los 5 métodos de pago que usan los clientes B2B colombianos en una sola integración**. Worgena vende a firmas de abogados en Colombia. Esos abogados (y sus asistentes administrativos) pagan con: PSE (transferencia desde el banco donde tienen la cuenta de la firma), Nequi (millennials), Daviplata (segmentos medios-bajos), tarjeta de crédito corporativa (Visa/MC/Amex), y si son clientes Bancolombia, Botón Bancolombia. Wompi cubre los 5. ePayco cubre 4 de 5 (sin Botón Bancolombia exclusivo). PayU cubre 4 de 5 (Daviplata no confirmado). Mercado Pago cubre los principales pero con fees opacos. **Wompi gana en cobertura de métodos locales.** [1][6]

2. **Tarifa plana más baja del grupo local**. 2.65% + $700 COP (todos los métodos) es la más baja del grupo de pasarelas colombianas con cobertura de los 5 métodos. ePayco tiene 2.64% en promo 3 meses, después sube a 2.99% + $900. PayU cobra 3.29% + 300 + mínimo PSE $9,900 (que para transacciones de COP $20-50K destruye margen). Worgena vende planes desde COP $20-30K/mes para firmas pequeñas. El fee mínimo de PayU ($9,900) equivale al 30-50% del ingreso del primer mes de un cliente. **Wompi no tiene ese mínimo.** [1][2][3][4]

3. **Persona natural con RUT es suficiente para arrancar**. Worgena no necesita SAS para tomar el primer cliente pagando. Wompi permite registro a persona natural (RUT o cédula) con cuenta Bancolombia o Nequi +30 días. Cero摩擦 legal. La constitución de SAS puede esperar 6-12 meses cuando haya revenue validado y unit economics claros. **Time-to-first-paying-customer: 1-2 semanas** (registro Wompi + sandbox + integración), vs **3-6 meses** con Stripe + Atlas. [19]

4. **Tokenización + REST API + español = encaja 1:1 con el stack Worgena**. `OpenRouterLLMInvoker` ya es un cliente HTTP custom en TypeScript. Worgena puede hacer un `WompiClient` similar. Webhooks firmados con `events_secret`, jobs system ya planeado para P0 #5 (`BACKLOG_P0.md §5`). Documentación en español navegable. **No hay dependencia de comunidad ni de terceros para integración.** [14]

5. **Respaldo Bancolombia = confianza para el cliente B2B jurídico**. Cuando un bufete junior le pregunta al socio senior "le voy a dar la tarjeta de la firma a un proveedor SaaS", el socio pregunta "¿quién procesa el pago?". Si la respuesta es "Wompi, que es de Bancolombia", se acaba la objeción. PayU, Mercado Pago y ePayco son respetables pero no tienen el peso de marca de un banco top-3 colombiano. **Para venta B2B, esto cierra objeciones de procurement.** [1]

**Lo que Wompi NO resuelve y Worgena debe aceptar**:

- **No hay API REST de "subscriptions"** tipo Stripe. Worgena tiene que programar el scheduler de cobros recurrentes. El `jobs` system de P0 #5 (`BACKLOG_P0.md §5.2`) **se vuelve bloqueante** para el modelo de planes, no nice-to-have. Si la queue se cae, los clientes no se cobran ese mes. Backoff + retry (1m/5m/30m/2h/12h) y la idempotencia de `processed_events` son los que mantienen la integridad.
- **Wompi no emite factura electrónica DIAN**. Cuando Worgena sea SAS, hay que cablear un operador (Factus ~$50-200K COP/mes). Esto es un sprint adicional post-SAS, no bloqueante para v1.
- **Cobertura LatAm limitada a CO/PA/SV**. Si la expansión LatAm llega en <12 meses, hay que sumar PayU o Mercado Pago como segunda pasarela por país. **Esto no es un problema hoy, pero documentar la decisión en HANDOFF.md.**
- **Primer desembolso PN a 30 días**. Los primeros COP que entren a Worgena tardan 30 días. Worgena necesita tener runway para los primeros 30 días de operación. Asumir esto en el cálculo de runway.
- **SDK Node no oficial**. Hay que escribir un cliente HTTP custom. Es trabajo de 1-2 sprints de Wozniak, no es blocker.

**Riesgo conocido y mitigación**: si Wompi rechaza a Worgena en KYC (raro para persona natural, pero posible), el fallback es **ePayco** (mismo modelo, sin SAS, Davivienda). Wozniak debe abrir sandbox de ePayco en paralelo a Wompi, antes de comprometer el sprint de billing.

---

## Decision framework

5 preguntas binarias que Jesús puede usar si reconsidera la decisión. Cada una con la condición explícita.

1. **¿Worgena se va a constituir SAS colombiano en los próximos 6 meses?**
   - **Sí** → reconsiderar **Stripe Colombia directo** o **Wompi Gateway** (no Agregador, plan enterprise con banco adquiriente). Stripe requiere SAS primero, Wompi Gateway requiere ser "persona jurídica" con trayectoria.
   - **No** → **Wompi** se mantiene. La fricción de SAS no se justifica con cero revenue.

2. **¿Worgena quiere suscripciones nativas con dunning automatizado (sin programar scheduler)?**
   - **Sí** → cambiar a **ePayco** (producto Suscripciones nativo + portal propio del cliente + dunning) o **Mercado Pago** (preapproval con reintentos automáticos). Trade-off: ePayco no tiene Botón Bancolombia exclusivo; Mercado Pago tiene fees opacos.
   - **No, preferís controlar el scheduler y meter retry con backoff propio** → **Wompi** se mantiene. Esto es el path que encaja con el `jobs` system ya planeado.

3. **¿Worgena va a expandir a LatAm (México/Perú/Chile) en menos de 12 meses?**
   - **Sí** → desde día 1 cablear **PayU LatAm** (cobertura 11+ países) o **Mercado Pago** (6 países). No usar Wompi para Colombia + otra para LatAm — eso dobla la superficie de código de billing. Trade-off: fees más altos en Colombia (~3.29% vs 2.65% Wompi).
   - **No, Colombia por 18+ meses** → **Wompi** se mantiene. Reevaluar al expandir.

4. **¿El ARPU de Worgena es menor a COP $30.000/mes por firma?**
   - **Sí** → **Wompi** se mantiene (sin fee mínimo, 2.65% + $700 es lo mejor para tickets bajos). PayU descartado (mínimo PSE $9,900 = 30-50% del ingreso del primer mes). Mercado Pago descartado hasta validar fees.
   - **No, ARPU > COP $100.000/mes** → cualquier opción funciona. Stripe Colombia es candidato serio (3.9% vs 2.65% se diluye en margen absoluto).

5. **¿Worgena va a requerir compliance enterprise (SOC2, DPA, data residency US) en menos de 12 meses?**
   - **Sí** → pivotar a **Stripe + Atlas** (Delaware C-Corp). Ninguna local colombiana cumple data residency US o SOC2 certificado.
   - **No, compliance es Habeas Data + DIAN (estándar colombiano)** → **Wompi** se mantiene. Compliance colombiano no es un driver.

---

## Anti-recomendaciones

Cuándo **NO** usar Wompi (la opción recomendada):

1. **Worgena entra a enterprise USA con SOC2 + DPA estricto + data residency US**. Wompi es pasarela colombiana, los datos de transacción quedan en servidores colombianos. Migrar a Stripe (con Atlas para Delaware C-Corp) es la salida limpia. **Anti-patrón**: prometer SOC2 a un cliente enterprise con pasarela local.

2. **Worgena vende servicios profesionales (no SaaS) directamente a grandes corporativos que exijan factura electrónica DIAN con NIT del proveedor desde el día 1**. Wompi no emite factura electrónica. Si el cliente exige "necesito la factura a nombre de Worgena SAS" sin que Worgena sea SAS todavía, no se puede cumplir. Solución: constituir SAS primero + cablear operador DIAN (Factus, Lemp). Bold cubre la facturación nativa pero pierde en suscripciones.

3. **Worgena decide pivotar a marketplace (Worgena es platform, otros vendors venden)**. Ahí Stripe Connect con custom onboarding de vendors es el path. Wompi no está diseñado para ese modelo.

4. **Worgena espera más de 100M COP/mes de volumen transaccional en Colombia**. Ahí PayU Enterprise (3.29% con fees negociados <2.5% en enterprise) o PlacetoPay Gateway con banco adquiriente propio bajan el fee efectivo por debajo de Wompi. **Migrar a PayU/PlacetoPay cuando el revenue mensual supere ~COP $100M.**

5. **Wompi rechaza a Worgena en KYC**. Raro para persona natural con RUT limpio, pero posible. Fallback: ePayco (mismo modelo, Davivienda como respaldo, onboarding similar). Wozniak debe abrir sandbox de ePayco en paralelo a Wompi desde el día 1.

6. **Worgena descubre que el fee efectivo de Mercado Pago Colombia es < 2.5% con dunning incluido** (a validar abriendo cuenta sandbox). En ese caso, Mercado Pago sube al #1 por la combinación de suscripciones nativas + SDK Node oficial + cobertura LatAm. Hoy: Wompi gana por transparencia. **Acción inmediata**: Wozniak abre sandbox Mercado Pago CO y compara fees.

7. **Worgena se vuelve a un modelo donde el cliente quiere "ver su suscripción y cancelar solo"**. ePayco tiene un portal de cliente dedicado para eso. Wompi lo deja a Worgena construir el portal self-service. Si discovery con clientes revela que la autogestión de suscripción es un requirement de UX, **ePayco gana por su portal pre-construido**.

---

## Lecciones de la investigación anterior

La recomendación anterior (Paddle, 2026-06-25) fue **rechazada por el founder con razón**. Lo que falló en mi razonamiento y cómo lo evito acá:

**Lo que falló**:
1. Asumí **mercado global** cuando Worgena es **Colombia-first**. La pregunta "MoR vs processor" era el eje equivocado. La pregunta correcta era "¿qué pasarela local nos deja cobrar a clientes colombianos reales?". Paddle, LemonSqueezy, Stripe Atlas — todos ignoran los métodos de pago que usan los clientes colombianos.
2. Cité "diversificación geográfica" como ventaja de Paddle/MoR. **Irrelevante si Paddle no puede colectar el pago de entrada.** El cliente colombiano que quiere pagar con PSE no puede pagar a Paddle. Punto.
3. No validé los métodos de pago como filtro #1 antes de la recomendación. El fee, el KYC, el MoR — todo era secundario al **"¿el cliente puede pagarte?"**.

**Cómo lo evito en esta investigación**:
1. **Filtro #1: cobertura de métodos colombianos locales** (PSE, Nequi, Daviplata, tarjeta). Sin esto, el candidato queda descartado sin discusión. Wompi, ePayco, PayU y Mercado Pago pasan. Bold tiene la mayoría pero no suscripciones. PlacetoPay los tiene todos. Stripe no tiene Nequi/Daviplata nativamente.
2. **Citas con URL colombiana verificada en español**. No uso una sola fuente en inglés para features críticas. Cuando el sitio oficial .com da 403 (Wompi docs tiene WAF), uso el portal comercial wompi.com/es/co (que sí responde) y la búsqueda de los mismos features en sitios de terceros (suscripciones.co, treli.co, ciances.co) que citan docs oficiales.
3. **Distinción explícita de restricciones operativas**. Wompi no tiene API REST de suscripciones — eso es una restricción operativa, no un deal-breaker si Worgena programa el scheduler. Lo declaro explícitamente en lugar de esconderlo. **Lo que el founder no quiere es descubrir la restricción post-implementación.**
4. **Veredicto "una opción, con fallback"**. Wompi como #1, ePayco como fallback. Mercado Pago condicional a validación de fees. Stripe descartado por constitución SAS. **No "todas son buenas" — una gana, las otras se comparan contra esa.**
5. **No recomendado Paddle/LemonSqueezy bajo ninguna circunstancia** (founder los rechazó explícitamente por falta de soporte LatAm/Colombia). Si el análisis los llevara ahí, replantéalo: la geografía está mal. Acá ninguno de los 6 finalistas es MoR global — todos son pasarelas locales colombianas o regionales con métodos colombianos.

**Lo que mantengo del análisis anterior y es verdad**:
- Worgena como persona natural puede empezar a cobrar sin SAS. Eso sigue siendo cierto con Wompi. La fricción legal no es bloqueante.
- El modelo de "plan + wallet" se beneficia de un provider que entienda el caso de uso. ePayco y Mercado Pago son más fuertes acá. Wompi requiere scheduler propio, lo cual NO es un blocker porque el `jobs` system de P0 #5 ya está en el roadmap.
- Costo predecible por transacción es importante para unit economics. Wompi 2.65% + $700 flat (todos los métodos) es lo más predecible del grupo. PayU y Mercado Pago tienen fees opacos por método.

---

## Fuentes

Citadas con URL colombiana y fecha de consulta (2026-06-25):

1. **Wompi — Plan Avanzado Agregador** — [wompi.com/es/co/planes-tarifas/plan-avanzado-agregador](https://wompi.com/es/co/planes-tarifas/plan-avanzado-agregador) — fee 2.65% + $700 + IVA, todos los métodos.
2. **PayU Colombia — Corporate** — [corporate.payu.com/colombia/en](https://corporate.payu.com/colombia/en) — fee 3.29% + 300, métodos, CoF, antifraude, 3DS, retiros.
3. **ePayco Colombia** — [epayco.com](https://epayco.com) — tarifa preferencial 2.64% + $690, 22+ medios, suscripciones nativas, Davivienda.
4. **Comparativa pasarelas Colombia 2026** — [guiadesoftware.com/blog/mejor-pasarela-pago-colombia](https://www.guiadesoftware.com/blog/mejor-pasarela-pago-colombia) — Bold, comparativa e-commerce 60% tarjeta / 30% PSE / 10% Nequi.
5. **PlacetoPay — Modelo de Negocio** — [placetopay.dev](https://placetopay.dev) — fee Agregador 2.9% + $700 (mín $2,300), Gateway desde $250 + IVA, 10 países LatAm.
6. **Wompi — Medios de pago** — [wompi.com/es/co/soluciones/pagos-en-linea/medios-de-pago](https://wompi.com/es/co/soluciones/pagos-en-linea/medios-de-pago) — 10+ métodos: tarjetas, Nequi, PSE, Daviplata, Botón Bancolombia, Corresponsales, Puntos Colombia, SU+Pay, BNPL.
7. **PayU LatAm — API de Pagos Colombia (PSE)** — [developers.payulatam.com/latam/es/docs/integrations/api-integration/payments-api-colombia.html](https://developers.payulatam.com/latam/es/docs/integrations/api-integration/payments-api-colombia.html) — integración PSE.
8. **Mercado Pago Developers — Getting Started** — [mercadopago.cl/developers/es/docs/getting-started](https://www.mercadopago.cl/developers/es/docs/getting-started) — tabla de cobertura CO con Subscriptions, Checkout Pro, Bricks, Link de Pago, QR.
9. **PlacetoPay — Pasarela + Evertec** — [placetopay.dev](https://placetopay.dev) + [evertecinc.com/en/solution/placetopay](https://evertecinc.com/en/solution/placetopay) — Scudo antifraude, 3DS Adq/Emi, IVR, micrositios, 10 países.
10. **Wompi — Tokenización** — [wompi.com/es/co/soluciones/pagos-en-linea/webcheckout-api-plugins/tokenizacion](https://wompi.com/es/co/soluciones/pagos-en-linea/webcheckout-api-plugins/tokenizacion) — tokenización de tarjeta o Nequi para pagos recurrentes, débitos automáticos, 3DS para tokenizar.
11. **PayU Latam — Pagos Recurrentes API** — [developers.payulatam.com/latam/es/deprecated/recurring-payments/recurring-payments-api.html](https://developers.payulatam.com/latam/es/deprecated/recurring-payments/recurring-payments-api.html) — API Plans (deprecated en URL pero funcional).
12. **Mercado Pago — Suscripciones con reintentos** — [mercadopago.com.uy/developers/es/docs/subscriptions/integration-configuration/subscription-no-associated-plan/authorized-payments](https://www.mercadopago.com.uy/developers/es/docs/subscriptions/integration-configuration/subscription-no-associated-plan/authorized-payments) — preapproval con status `processed` / `waiting for gateway` / `rejected`, reintentos.
13. **Bold Developers — API Pagos en Línea** — [developers.bold.co/pagos-en-linea/api-de-pagos-en-linea](https://developers.bold.co/pagos-en-linea/api-de-pagos-en-linea) + [bold.co](https://bold.co) — RESTRICCIÓN: "estamos trabajando para que más adelante podamos contar con APIs independientes para pagos recurrentes y membresías". Webhooks configurables.
14. **Wompi — Documentación técnica** — [wompi.com/es/co/desarrolladores/documentacion-tecnica](https://wompi.com/es/co/desarrolladores/documentacion-tecnica) — llaves, sandbox/producción, eventos, webhooks.
15. **PayU Latam — API Integration** — [developers.payulatam.com/latam/en/docs/integrations/api-integration.html](https://developers.payulatam.com/latam/en/docs/integrations/api-integration.html) — tokenización, CoF, voids/refunds, webhooks.
16. **PayU Node SDK** — [npmjs.com/package/payu-websdk](https://www.npmjs.com/package/payu-websdk) — SDK PayU India; el SDK Latam es community-maintained.
17. **EDICOM — Facturación electrónica Colombia (DIAN)** — [edicomgroup.com/es/factura-electronica/colombia](https://edicomgroup.com/es/factura-electronica/colombia) + [edicomgroup.com/es/blog/como-es-la-factura-electronica-en-colombia](https://edicomgroup.com/es/blog/como-es-la-factura-electronica-en-colombia) — modelo clearance DIAN, RADIAN, Resolución 000119/2024, operadores autorizados (Factus, Lemp, Siigo, Alegra, Datium).
18. **Bold — Facturación electrónica nativa** — [bold.co](https://bold.co) — producto "Facturación electrónica" parte del POS.
19. **Wompi — Cómo crear una cuenta** — [wompi.com/es/co/ayuda/como-crear-cuenta](https://wompi.com/es/co/ayuda/como-crear-cuenta) — requisitos persona natural (RUT o cédula + Bancolombia/Nequi +30 días), primer desembolso PN a 30 días, soporte WhatsApp +57 322 280 4391.
20. **Treli — Nequi PSE guía completa suscripciones Colombia** — [treli.co/nequi-pse-guia-completa-para-cobrar-y-automatizar-suscripciones](https://treli.co/nequi-pse-guia-completa-para-cobrar-y-automatizar-suscripciones) — contexto Nequi + PSE + limitaciones suscripciones con PSE solo.
21. **Cances — Payment Gateways Colombia 2026** — [cances.co/en/blog/payment-gateways-colombia](https://cances.co/en/blog/payment-gateways-colombia) — comparativa Wompi/ePayco/PayU/Stripe con fees en COP.
22. **BtoDigital — Pasarelas de Pago Colombia 2026** — [btodigital.com/pasarelas-pago-colombia-comparativa-guia-negocio](https://btodigital.com/pasarelas-pago-colombia-comparativa-guia-negocio) — comparativa 12 pasarelas.
23. **Nequi — Tarifas** — [nequi.com.co/tarifas-nequi](https://www.nequi.com.co/tarifas-nequi) — tarifas oficiales Nequi (cliente, no merchant).
24. **Factus — API de Facturación Electrónica DIAN** — [factus.com.co](https://www.factus.com.co) — operador autorizado DIAN para integración.
25. **Red Stag Fulfillment — Stripe Supported Countries 2026** — [redstagfulfillment.com](https://redstagfulfillment.com) — Colombia no es merchant directo Stripe sin Atlas.
26. **Andres Dev — Wompi Bancolombia tarifas y medios de pago** — [andres-dev.com/wompi-la-nueva-pasarela-de-pagos-de-bancolombia](https://andres-dev.com/wompi-la-nueva-pasarela-de-pagos-de-bancolombia) — cálculo práctico de fee Wompi con tarjeta vs PSE/Nequi (Retefuente, ReteICA, ReteIVA 15%, IVA 19% de comisión).
27. **TermS.law — Stripe Atlas vs Direct Incorporation 2026** — [terms.law/UK-Founders/stripe-atlas-vs-direct.html](https://terms.law/UK-Founders/stripe-atlas-vs-direct.html) — Delaware C-Corp $500 USD + mantenimiento.

**Datos no verificados / marcados explícitamente**:

- **Fees exactos Mercado Pago Colombia** — no público, requiere abrir cuenta y consultar panel. Búsqueda devolvió fees AR (no aplican). Acción: Wozniak abre sandbox MP CO en paralelo.
- **Fees Bold oficiales** — la página bold.co no muestra pricing detallado público; la cifra 2.80% + $500 viene de guiadesoftware.com (no oficial). Confirmar en pilot.
- **PayU Daviplata** — no confirmado en el sitio oficial de PayU; presumiblemente soportado pero no publicado.
- **PlacetoPay onboarding persona natural** — modelo Agregador presumiblemente lo permite (es el modelo más simple) pero la página oficial no es explícita. Validar en pilot.
- **Tasa de aprobación KYC** de cada pasarela para comerciantes colombianos — no documentada públicamente. Para persona natural con RUT limpio, el riesgo es bajo. El thread de r/SaaS sobre Paddle no aplica a locales colombianas (que tienen menos fricción que un MoR global).
- **Tiempo exacto de onboarding** de cada pasarela para Colombia. Wompi: "100% en línea" pero no comprometen plazo. PayU/Mercado Pago: no documentado.
- **Tasa de cambio COP/USD al 2026-06-25** — irrelevante para la decisión (Wompi cobra y paga en COP). Snapshot: ~3,425-3,500 COP/USD (Wise, Xe, Sendwave).
- **SDK Node oficial de PlacetoPay** — confirmado que NO existe (componentes oficiales son PHP/Java/C#). Documentado para que Wozniak no invierta tiempo buscándolo.
- **Soporte 24/7 Bold "Bolbot"** — claim del sitio oficial; no validado en producción.

---

**Próximo paso concreto** (acción inmediata, no decisión abierta):

1. **Wozniak abre cuenta sandbox de Wompi** (gratis, sin KYC): [registro.wompi.co](https://registro.wompi.co). Validar API + webhooks con un test end-to-end de tokenización + cargo.
2. **Wozniak abre cuenta sandbox de Mercado Pago Colombia en paralelo** (gratis, sin KYC): [mercadopago.com.co/developers](https://www.mercadopago.com.co/developers). Validar fees reales de Colombia y comparar con Wompi. Esta decisión queda condicional al resultado de MP.
3. **Si MP fees son < 2.5% efectivo con dunning**, comparar de nuevo con Wompi. Si no, **Wompi es la decisión final**.
4. **Cablear la decisión en `AGENT_BILLING_V1_SPEC.md`** (spec ya en backlog §4). Wompi como provider primario, ePayco como fallback documentado.
5. **El `jobs` system (P0 #5) se vuelve bloqueante para el modelo de suscripciones**, no nice-to-have. Prioridad sube. Sin jobs, Wompi no funciona para planes recurrentes.

Speccing: el spec `AGENT_BILLING_V1_SPEC.md` es el siguiente entregable técnico (no este). Este documento es la decisión comercial para informar ese spec.
