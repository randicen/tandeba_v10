---
created: 2026-06-16 00:10
updated: 2026-06-16 00:10
tags: [asesoria-steve, comercial, pricing, icp, wip]
---

# Asesoría Steve — Sesión 2026-06-15 / 2026-06-16

> Punto de partida: Jesús (founder) lleva menos de 1 mes con Worgena. Pide a Steve
> una lectura honesta del estado comercial del proyecto. Esta nota consolida
> las decisiones de producto/comercial que se tomaron en la sesión y deja
> explícito lo que está validado, lo que está pendiente, y los siguientes pasos.

---

## 1. Lo que el founder me corrigió en la sesión

A. **Worgena no se limita a lo legal.** Es un sistema operativo agéntico
   para firmas de consultoría legal, contable y empresarial, con foco
   principal pero no exclusivo en Colombia. Steve tenía una lectura más
   estrecha y debe corregirla en futuras asesorías.

B. **El pricing exacto NO se cierra hasta tener costos operativos completos**
   con Wozniak. Hay dependencia técnica: el stack final de modelos
   (DeepSeek V4 Flash + M3 Thinking + Sonar 2 + embeddings aún por fijar)
   y los costos de ingestión/queries de RAG no están consolidados. Citar
   precios específicos hoy es especulación.

C. **El código actual NO es el producto.** Es infraestructura: motor
   agéntico, multi-tenancy, specialists, storage, RAG pendiente, auth
   pendiente, base documental pendiente. El founder me corrigió cuando
   insinué que se podía llevar a discovery. **No se puede. La pieza
   "usable para un cliente" no existe todavía.**

D. **El plan individual a $20/mes no se ofrece.** Solo planes corporativos
   de equipos. Decisión del founder, alineada con mi recomendación.

E. **Las skills NO se generan por la UI automáticamente.** El autor de la
   skill es el abogado, que la crea desde una descripción propia. La IA
   asiste. **La responsabilidad civil/penal del material generado y de
   su uso es del usuario**, no de Worgena. Esta cláusula de
   responsabilidad debe quedar explícita en los términos del servicio.

F. **Steve se retractó de afirmaciones de pricing sin fuente.** Mi
   respuesta anterior tiró cifras ("$80-150/mes por Licencia SHD",
   "$30-80 por usuario/mes en VisualFiles", "firma de 5-15 paga sin
   problema $150-300/mes") sin respaldo verificable. Error explícito.
   Lo correcto es: (1) declarar el dato como intuición, no como cifra,
   o (2) citar la fuente. Esta retractación queda en la nota para
   auditoría futura.

---

## 2. Decisiones comerciales cerradas en la sesión

### 2.1. ICP tentativo (pendiente de validar con datos primarios)

> "Firma legal, contable o consultora, de 5-15 personas, en
> Bogotá/Medellín/Cali, con 2+ años operando, que ya paga al menos un
> SaaS (no exclusivamente Excel), y cuyo socio principal entiende
> tecnología al nivel de 'uso ChatGPT para trabajar'."

Razón: alguien que ya paga un SaaS ya está educado en la categoría, ya
tiene presupuesto asignado a software, y ya pasó el umbral cultural de
"comprar vs construir a mano".

**Estado de validación:** hipótesis. Falta cruzar con datos primarios
(MinTIC, Cámaras de Comercio, CIPE) y con discovery real.

### 2.2. Pricing

- **No se ofrece plan individual.** Solo corporativo.
- **El número exacto se cierra cuando Wozniak entregue costos operativos.**
- **Regla de costo estructural:** congelar las decisiones de stack que
  afectan costo estructural (ej. modelo de embeddings), no las que
  afectan funcionalidad.
- **Regla de orden de magnitud:** para cuando estén los costos,
  tener al menos un order of magnitude por plan, no el número exacto.
  Costo esperado por query RAG (post-ingesta) según Wozniak: ~$0.001
  (un décimo de centavo). Ingesta de 100k docs legales institucionales:
  costo $0.

### 2.3. Skills — política de autoría y responsabilidad

- El **autor real** de la skill es el abogado, no "la UI".
- La IA **asiste** la creación, no la produce de cero sin supervisión.
- La **responsabilidad civil/penal del uso** del material generado es
  del usuario final. Worgena provee herramienta, no consejo jurídico.
- Esto debe quedar **explícito en los Términos del Servicio** y en la
  UI al momento de crear/usar una skill.
- **Las primeras 30-50 skills de D6 NO son auto-generadas.** Son
  curadas por abogados senior. La UI de auto-creación es feature
  posterior, no del MVP.

### 2.4. Diferenciador regional — honestidad sobre los límites

Jesús afirma que Worgena ofrece:
1. **Base documental legal regional propietaria.**
2. **Skills para procesos regionales.**
3. **Pricing ajustado al contexto socioeconómico regional.**

Lo que Steve añadió como advertencia:
- **(1) y (2) son caros de construir y mantener.** Ingesta masiva es
  barata por documento ($0.001/query post-ingesta), pero la decisión
  de **qué base documental construir primero debe venir de un cliente
  que pague por eso**, no de la intuición. Si la primera base no
  resuelve un problema validado, no es base, es gasto.
- **(3) no es una muralla, es una ventana.** Si Worgena funciona,
  Harvey ajusta su pricing regional en 18 meses. Pricing regional
  compra tiempo, no lealtad.
- **Skills "regionales"** (3-5 ejemplos que mencionó el founder)
  probablemente son 30-60 cuando se cuente la diversidad de áreas
  de práctica de una firma mediana (reparación directa tiene 5
  subtipos, laboral tiene 8, comercial tiene 12, etc.). Esto
  **no es problema si la UI permite que el abogado las cree**, pero
  sí es problema si se lanzan sin gatekeeper en el MVP. Compliance
  > velocidad de catálogo.

---

## 3. Lo que NO se cerró (pendientes explícitos)

| # | Pendiente | Quién | Cuándo |
|---|---|---|---|
| P1 | Costos operativos consolidados del stack de modelos (DeepSeek V4 Flash + M3 Thinking + Sonar 2 + embeddings) | Wozniak | Antes de fijar pricing |
| P2 | "MVP vendible" definido con Wozniak (qué tiene que poder hacer el producto para justificar un discovery call) | Jesús + Wozniak | Antes de salir a discovery |
| P3 | Validación de ICP con datos primarios (MinTIC apropiación digital MIPYME 2024, CIPE caracterización MiPyME, Cámara de Comercio Bogotá) | Steve | Esta semana |
| P4 | 3-5 discovery calls con firmas que matcheen el ICP tentativo | Jesús | Después de P2 |
| P5 | Auth real (D3.4) — bloquea piloto | Wozniak | Antes del primer pilot |
| P6 | Decisión de Base documental legal #1 a construir | Jesús (con input de discovery) | Después de P4 |
| P7 | Cláusula de responsabilidad civil/penal en ToS sobre uso de skills y outputs del agente | Jesús + Wozniak | Antes de salir a producción |

---

## 4. Estado de la investigación de fuentes primarias

**Fuentes identificadas y consultadas (parcialmente, sesión 2026-06-16):**

1. **MinTIC — Estudios del Sector 2025** (https://colombiatic.mintic.gov.co/679/w3-multipropertyvalues-36370-963710.html)
   - Índice de Brecha Digital 2024 (publicado 2025) — relevante para
     apropiación digital por departamento.
   - Encuesta EnTIC 2019pr (empresas) — la más reciente para empresas.
   - Caracterización de las MiPyME colombianas y su relación con las TIC.
   - **Pendiente:** bajar el PDF del Índice de Brecha Digital 2024 y
     la caracterización MiPyME para extraer datos específicos.

2. **CIPE — "Caracterización de las Mipymes en Colombia y su Apropiación Digital"** (https://www.cipe.org/resources/characterization-of-smes-in-colombia-and-their-digital-adoption/)
   - Encuesta de CNC, 4.000+ empresarios, publicada 2024-05-31.
   - **Fuente anglosajona confiable con datos crudos sobre adopción
     digital PYME Colombia.** Pendiente bajar PDF extendido.

3. **Bind (vendor AI legal CLM) — comparativa de pricing 2026**
   (https://bindlegal.com/resources/comparisons/harvey-pricing-2026/
   y spellbook-pricing-2026/)
   - **Harvey AI 2026 pricing triangulado (industry estimates, no
     publicado):**
     - Small/specialized firms (25-50 abogados): $1,500-$2,000+/user/month
     - Mid-market (50-200): $1,200-$1,500/user/month
     - Am Law 100 (200+): $100-$200/user/month (volume discount)
     - Mínimo típico: 25-50 seats, contratos anuales
     - **NO publican pricing en website.** Todo es custom.
   - **Spellbook 2026 pricing triangulado:**
     - Entry/individual: ~$99/user/month
     - Professional/team (2-9 abogados): ~$149/user/month
     - Enterprise (10+ seats, 6 meses mínimo): $199-$350/user/month
     - Subió precios en late 2025 (de ~$179 a ~$350 enterprise).
     - **NO publican pricing en website.** Todo es custom.
   - **Implicación para Worgena:** en el segmento que Worgena podría
     atacar (firma 5-15 personas, Colombia), los precios en USD de
     mercado son $99-350/mes. La pregunta es: ¿una firma
     colombiana paga eso en pesos colombianos, o el techo es más
     bajo por contexto socioeconómico? Eso requiere datos
     colombianos, no extrapolación.

4. **Cámaras de Comercio Bogotá** — no localizado el dataset
   público granular por tamaño de firma en sector jurídico/contable.
   Pendiente buscar.

**Fuentes que NO se usaron y por qué:**
- Datos de "max.book118.com" y similares: contenido duplicado,
  no original. Descartado.
- Datos de tianyancha.com (empresa china): irrelevante.
- Notícias de Tencent News, OFweek: marketing, no data.

---

## 5. Recomendación al founder para los próximos 7 días

1. **No construir features esta semana.** Jesús y Wozniak deben
   sentarse a definir el "MVP vendible" (P2). Sin ese hito, no
   hay a dónde ir con discovery.

2. **Steve completa P3** (investigación de fuentes primarias) en
   los próximos 2-3 días. Entrega al founder un brief de:
   - Adopción digital real de MIPYME colombianas por tamaño y sector.
   - Distribución de firmas legales/contables por tamaño en Bogotá.
   - Comparativa de pricing regional (Latam, no solo US) cuando se
     consiga data.

3. **Jesús confirma acceso** a 3 personas que trabajen en firmas
   con el ICP tentativo. Si tiene acceso, definimos juntos el
   script de discovery call y la matriz de calificación.

4. **Wozniak arranca D3.4** (auth real con Better Auth) en
   paralelo, porque sin auth no hay piloto posible.

---

## 6. Honestidad sobre lo que NO sé

- **No tengo datos colombianos verificables** sobre willingness to
  pay en SaaS legal/contable para empresas de 5-15 personas.
  Citar cifras como "$150-300/mes sin problema" fue error. Queda
  retractado.
- **No tengo acceso al detalle del plan de Woz** ni a la decisión
  final de stack de modelos. Esto bloquea el pricing.
- **No tengo visibilidad de si Jesús tiene red de firmas** para
  los discovery calls. Esto bloquea el avance comercial.

Lo que sí sé:
- El código de Worgena tiene una base sólida para un proyecto de
  <1 mes. Los 291 tests pasando, el motor con idempotencia, el
  multi-tenant enforcement y el verifier en sub-sesión son
  decisiones arquitectónicas que no se ven en proyectos
  legales-colombianos de este tamaño.
- El founder tiene claridad sobre el producto a nivel conceptual
  (PLATFORM_VISION.md, AGENT_ROADMAP.md están bien pensados).
- El founder **reconoce públicamente** que aún no tiene
  conversaciones con clientes. Eso es honestidad, y la honestidad
  es la base de la próxima decisión correcta.
