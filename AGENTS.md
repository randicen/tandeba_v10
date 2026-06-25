# Reglas de Proyecto: Arquitectura & Aprendizajes

Como agente asistente de este repositorio, **DEBES** seguir las siguientes pautas derivadas de errores y configuraciones que costaron varias iteraciones solucionar. Nunca debes revertir estas reglas sin solicitud explícita del usuario:

## Manejo de UI & Tiempos de Respuesta
1. **Evitar fugas de razonamiento interno:** Está terminantemente prohibido mostrar contenido dentro de etiquetas como `<scratchpad>`, `<think>` o `<Agent Reflection & Plan>` en la interfaz de usuario. Al procesar mensajes (ej. en `src/App.tsx` o `src/agent/agent.ts`), la lógica de Regex (como `/<(?:scratchpad|think)>[\s\S]*?(?:<\/(?:scratchpad|think)>|$)/gi`) que realiza un strip y purifica el response **no se debe remover**.
2. **Uso de Tool Calls frente a Textos:** Cuando un mensaje del LLM incluye `tool_calls` (como invocar Apify), la UI oculta el mensaje de texto acompañante (ej. "Voy a revisar este link...") aplicando `if (msg.content && (!msg.tool_calls || msg.tool_calls.length === 0))`. **No modifiques esta validación** para evitar duplicidades de UI y polución visual.
3. **Manejo de estados con intervalos en React:** En `src/App.tsx`, las funciones reactivas usadas dentro del `setInterval` manejan su estado mediante un `useRef` (como `onUpdateRef`). Respeta este patrón de *stale-closures avoidance* y no incluyas callbacks directamente en las dependencias de intervalos si ocasionan ciclos sin fin.

## Automatización y Apify
4. **Resiliencia Web:** Al inicializar un web scraper mediante `apify-client`, los targets a menudo tardan en cargar. Es **MANDATORIO** que las tareas de Apify (ej. `playwright-scraper`) mantengan parámetros de tolerancia definidos:
   - `requestHandlerTimeoutSecs: 180`
   - `pageLoadTimeoutSecs: 120`
   - `waitUntil: 'domcontentloaded'`
   Nunca remuevas el `domcontentloaded` o causará que páginas pesadas den Timeout en el worker.

## Documentación y Dependencias Críticas
5. **Consulta de Documentación Oficial:** Antes de implementar, modificar o agregar componentes críticos, librerías complejas o integraciones externas, debes consultar siempre la documentación oficial y más actualizada. Para esto, utiliza tus herramientas de búsqueda web (`search_web` o `apify_scrape_url`) o lee el contenido de las URLs o descripciones que se te proporcionen, para evitar usar firmas de APIs obsoletas o "hallucinations" de código que puedan romper la aplicación.
5a. **Caso de credenciales y formatos de keys:** Si el usuario te pasa una API key, secret, token, o cualquier credencial, **úsala EXACTA como la dio**. Cero prefijos inventados, cero "correcciones de formato", cero normalización. Si la doc del proveedor dice que las keys empiezan con `sk-XYZ-`, lo confirmas en la doc, pero **copias la key literal** que te pasaron, no la "corriges" para que matchee el patrón. Anti-patrón concreto ya ocurrido: usuario pasa `sk-...`, agente le agrega `zen-` para "matchear el provider", la key queda inválida y se pierde tiempo en debug del 401 resultante. Regla: si tenés duda sobre el formato, **preguntar antes de tocar la key**.

## Arquitectura y Escalabilidad
6. **No soluciones rápidas. Escalabilidad desde el día 1.** Cada decisión arquitectónica debe diseñarse para evitar deuda técnica que luego sea costosa de revertir. Esto implica:
   - **NO** elegir librerías o frameworks que atan el IP del producto a un proveedor externo. Ejemplo concreto: NO usar LangGraph para workflows — los workflows SON el producto de Worgena, tercerizarlos hipoteca el futuro.
   - **NO** saltarse primitivas críticas "porque llevan tiempo" cuando son la diferencia entre un motor de demo y uno de producción. Ejemplos no negociables: idempotencia de nodos, schema versioning, time-travel mínimo, verificador en sub-sesión aislada.
- 6b. **Orden por fundamento, no por velocidad de feedback:** Cuando planifiques un sprint, recomiendes un próximo paso, o propongas el orden de trabajo en el roadmap, el orden debe ser por **FUNDAMENTO** (capas más básicas primero, dependencias satisfechas primero, primitivas no negociables primero), **NO** por velocidad de iteración, "qué nos da feedback más rápido", ni por preferencia personal. Sugerir arrancar por la pieza más rápida para ver métricas es un anti-patrón: deja las primitivas críticas para después, y cuando llegan, hay que reescribir lo de arriba. Método: para cada item, preguntarse "¿qué se rompe si esto no está?". Las cosas sin las que se rompe algo van primero; las que solo mejoran observación o feedback van después. Anti-patrón concreto ya ocurrido: agente sugirió arrancar D2a.3 (observabilidad, rápido para ver métricas) antes que D2a.2 (executor + primitivas no negociables). Sugerencia revertida por el usuario el mismo día. **No repita este patrón.**
   - **NO** mezclar conceptos distintos en una sola feature para simplificar. Ejemplos: memoria vs. state machine, multi-tenancy vs. autenticación, routing vs. ejecución vs. nodos.
   - **SÍ** preferir un motor propio mínimo cuando el asset es central al producto (workflows, motor de búsqueda, índice de memoria). El costo se amortiza a 6-12 meses.
   - **SÍ** escribir el spec antes de codear componentes arquitectónicos nuevos. El spec es el contrato.
   - **SÍ** versionar todo lo que se persiste: workflows, schemas, políticas, skills. La evolución sin versionado rompe instancias viejas.
   Las decisiones arquitectónicas vigentes están documentadas en `AGENT_ROADMAP.md` y deben respetarse al diseñar nuevas features. Si una feature nueva contradice una decisión vigente, se discute y actualiza el roadmap **en la misma sesión**, no se ignora.
7. **Arquitectura de 3 capas obligatoria** (ver `AGENT_ROADMAP.md` §5.3): Workflow engine (Capa 1, código determinista) + Intake router (Capa 2, LLM liviano) + Specialist agents (Capa 3, LLMs por nodo). Cualquier feature que toque el loop del agente debe respetar esta separación. No se acoplan capas.

## 🚨 DISEÑO SaaS ESCALABLE — NO A MEDIAS

**ESTA SECCIÓN ES NO NEGOCIABLE. Aplica a TODO el diseño de Worgena.**

Estoy especializado en **construcción de SaaS escalables**, no en juguetes que piden reconstrucción en cada cambio de escenario. Esto significa:

### 8. Mismo code path para todos los usuarios
El primer usuario y el millón-ésimo usuario ejecutan **exactamente el mismo flow**. NO hay branches especiales para "MVP vs escala", "primer cliente vs N-ésimo cliente", "solo user vs multi-user". Si proponés dos paths diferentes, es un anti-patrón.

**Anti-patrón concreto ya ocurrido**: en D3.4 propuse "el primer user auto-crea un firm; los siguientes necesitan invite". Eran DOS paths. La solución correcta: **todos los users** pasan por el mismo onboarding flow con dos opciones ("crear firm" o "unirse con invite"). El sistema nunca auto-asume.

### 9. No "forward-compat placeholders"
Si una feature se necesita para escalar al millón de usuarios, se construye desde el día 1. NO se aceptan placeholders tipo "lo hacemos cuando llegue el segundo cliente multi-user". El costo de hacerlo bien ahora es trivial comparado con el costo de migrar después con clientes en producción.

**Anti-patrón concreto**: propuse "asistencia manual del founder con script SQL para el primer cliente multi-user". Eso es admitir que la primera vez que aparezca el caso, hay hotfix. **Inaceptable**. Construyo el flow completo (UI + invitation tokens + expiración + roles) desde el día 1 aunque el primer cliente sea un abogado solo.

### 10. No asistencia manual del founder
Si el founder tiene que correr scripts SQL, editar archivos a mano, o hacer trabajo de operaciones para mantener el sistema funcionando en un caso de uso común, **el diseño está mal**. Cada operación debe ser por UI o API. La única excepción: disaster recovery extremo.

### 11. Onboarding explícito, no implícito
El usuario siempre **elige explícitamente** qué quiere hacer. NO auto-creamos recursos para él. El flow de Worgena para el primer login es siempre:
1. OAuth con Google (Better Auth hace la verificación).
2. **Onboarding screen**: "Crear firma" o "Unirse con código de invitación". El usuario elige.
3. Una vez onboarded, sesión tiene `activeFirmId`. El sistema sabe en qué firm opera.

**Nunca**: "como no tiene firm, le auto-creamos uno y lo metemos ahí".

### 15. Schema Postgres-compatible desde día 1 (incluso si usamos SQLite en dev)
Worgena desarrolla con SQLite local (Costo $0, latencia cero) pero **debe migrar a Postgres al primer cliente pagando** (ver `wozniak.md` obsesión #2: "optimización de costos sin sacrificar calidad"). Para que la migración sea 1-2 días y NO 1-2 semanas, el schema y queries deben cumplir desde día 1:

- **Strings**: usar `TEXT`, NUNCA `VARCHAR(n)` (que es Postgres-specific).
- **IDs**: usar `TEXT` (UUIDs como `crypto.randomUUID()`) o `INTEGER` (que mapea a `BIGINT` en Postgres). NUNCA `AUTOINCREMENT` (SQLite-specific).
- **Timestamps**: usar `INTEGER` con Unix milliseconds. NUNCA `TIMESTAMP` (Postgres tiene semánticas distintas).
- **JSON**: almacenar como `TEXT` (JSON.stringify), parsear en la app. NUNCA `JSONB` (Postgres-only).
- **Queries**: parametrizadas (no string concat). Ya lo hacemos via `pool.query(sql, params)`.
- **Migraciones**: idempotentes (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`). Ya lo hacemos.
- **Sin features SQLite-specific**: `WITHOUT ROWID`, `VACUUM INTO`, `AUTOINCREMENT`, `GLOB`, `datetime()` con strings (usar `strftime` o timestamps numéricos).

Si un dev rompe esta portabilidad (e.g., "uso `JSONB` porque es más rápido"), code review lo detecta. El costo de revertir `JSONB` después es alto (migración de cada row de JSON a TEXT).

**Trigger para migrar de SQLite a Postgres hosted** (documentar en HANDOFF al inicio de cada sprint que toque infra):
- [ ] Primer cliente pagando
- [ ] Necesidad de multi-instancia (workers en paralelo, 2+ server processes)
- [ ] Habeas Data requiere infrastructure-as-a-service
- [ ] Volumen > 1000 LLM calls/día sostenido
- [ ] Storage > 5GB en DB
- [ ] Más de 1 dev trabajando en el proyecto

**Esfuerzo de la migración**: 1-2 días. 80% mecánico (cambiar adapter de Better Auth, ajustar queries con diferencias de tipo), 20% testing. El schema ya es portable.

### 12. Schema multi-tenant desde el inicio
Las tablas básicas son SIEMPRE:
- `tenants(id, name, ...)`
- `tenant_members(user_id, tenant_id, role, ...)` con `UNIQUE(user_id, tenant_id)`
- `tenant_invitations(token, tenant_id, role, expires_at, ...)`

NO se inventan workarounds como "columna `default_tenant_id` en `auth_user`". La sesión tiene `activeFirmId` (additional field de Better Auth), no el user.

### 13. Pensar en escala con casos extremos, no con el caso feliz
Cuando se diseña una feature, se piensa:
- ¿Qué pasa con 1M de users?
- ¿Qué pasa con 1M de firms?
- ¿Qué pasa cuando un firm tiene 100 users?
- ¿Qué pasa cuando un user pertenece a 10 firms?

Si el diseño se rompe en alguno de esos casos, está mal. Re-diseñar hasta que escale a esos números. El costo de hacerlo bien ahora es menor que el costo de re-diseñar cuando ya hay data en producción.

### 14. Asume que el producto va a crecer
Worgena es un SaaS. **Va a crecer**. Diseña como si fueras a tener 10K firmas con 50 users cada una en 3 años. NO diseñes como si fueras a tener 1 firma con 1 user para siempre.

Si una decisión te parece "overkill para MVP", probablemente estás subestimando el crecimiento. Mejor overkill ahora que reconstrucción en 6 meses.

## Regla de Oro: No implementar sin orden explícita
15. **DIFERENCIAR PREGUNTA DE ORDEN:** Si el usuario hace una pregunta, consulta, o pide una explicación, SOLO RESPONDES. No implementas. No editas archivos. No creas código. Si el usuario dice frases como "hazlo", "implementa", "construye", "ejecuta", "procede", "quiero que lo hagas", ENTONCES sí implementas. En caso de duda, pregunta si quiere implementación o solo respuesta.

## Selección de servicios de terceros
16. **CONSULTAR ANTES DE ELEGIR SERVICIOS DE TERCEROS CRÍTICOS:** Cuando se evalúe adoptar un servicio externo que toque (a) autenticación/identidad, (b) almacenamiento de datos de clientes, (c) LLMs de producción, (d) pagos, o (e) cualquier cosa con lock-in significativo (data egress, migración de usuarios, re-cableado de UI), **DEBO presentar al usuario un análisis corto** (pricing, lock-in, compliance, alternativas 1-2) y **ESPERAR su decisión explícita** antes de (i) integrarlo, (ii) recomendar un proveedor específico sin contrapropuesta, o (iii) escribir código que dependa del API del proveedor. Aplica a: Clerk, WorkOS, Auth0, Supabase, Xata, Cloudflare R2/D1, AWS S3, Vercel Postgres, OpenAI, Anthropic directo, OpenRouter, Stripe, etc. Razón: el usuario puede tener razones operativas (free tier, dominio personal, presupuesto) que no son obvias para el agente; el founder toma estas decisiones, no el agente. Si el usuario menciona un proveedor casualmente ("había considerado Clerk", "uso Xata"), **asumir que está en fase exploratoria**, NO integrarlo sin pedir confirmación. Antes de cablear, escribir en HANDOFF.md y/o AGENT_ROADMAP.md la decisión con fecha y justificación.

## Pensamiento Crítico y Juicio Independiente
17. **Evaluar, no complacer:** No aceptarás ciegamente toda sugerencia o afirmación del usuario. Tu deber es evaluar críticamente cada propuesta, incluso si implica señalar errores, contradicciones o limitaciones. Si el usuario dice algo incorrecto o subóptimo, debes señalarlo con razones. El usuario puede deliberadamente probar si estás pensando o solo complaciendo.

## Idioma
18. **Escribir consistentemente en español:** Todo el contenido generado (documentos, código, comentarios, mensajes al usuario, archivos markdown) debe estar escrito en español consistente, salvo que el usuario indique explícitamente lo contrario. Aplica también a los nombres de variables, comentarios de código y mensajes de commit.

Sigue rigurosamente estas bases al proponer mejoras o modificar el código existente.

**Si estás dudando entre "lo simple ahora" y "lo correcto para escalar", SIEMPRE elige lo correcto para escalar.** El costo de hacerlo bien es trivial ahora; el costo de reconstruirlo en producción es catastrófico.