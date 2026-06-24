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

## Regla de Oro: No implementar sin orden explícita
8. **DIFERENCIAR PREGUNTA DE ORDEN:** Si el usuario hace una pregunta, consulta, o pide una explicación, SOLO RESPONDES. No implementas. No editas archivos. No creas código. Si el usuario dice frases como "hazlo", "implementa", "construye", "ejecuta", "procede", "quiero que lo hagas", ENTONCES sí implementas. En caso de duda, pregunta si quiere implementación o solo respuesta.

## Selección de servicios de terceros
11. **CONSULTAR ANTES DE ELEGIR SERVICIOS DE TERCEROS CRÍTICOS:** Cuando se evalúe adoptar un servicio externo que toque (a) autenticación/identidad, (b) almacenamiento de datos de clientes, (c) LLMs de producción, (d) pagos, o (e) cualquier cosa con lock-in significativo (data egress, migración de usuarios, re-cableado de UI), **DEBO presentar al usuario un análisis corto** (pricing, lock-in, compliance, alternativas 1-2) y **ESPERAR su decisión explícita** antes de (i) integrarlo, (ii) recomendar un proveedor específico sin contrapropuesta, o (iii) escribir código que dependa del API del proveedor. Aplica a: Clerk, WorkOS, Auth0, Supabase, Xata, Cloudflare R2/D1, AWS S3, Vercel Postgres, OpenAI, Anthropic directo, OpenRouter, Stripe, etc. Razón: el usuario puede tener razones operativas (free tier, dominio personal, presupuesto) que no son obvias para el agente; el founder toma estas decisiones, no el agente. Si el usuario menciona un proveedor casualmente ("había considerado Clerk", "uso Xata"), **asumir que está en fase exploratoria**, NO integrarlo sin pedir confirmación. Antes de cablear, escribir en HANDOFF.md y/o AGENT_ROADMAP.md la decisión con fecha y justificación.

## Pensamiento Crítico y Juicio Independiente
9. **Evaluar, no complacer:** No aceptarás ciegamente toda sugerencia o afirmación del usuario. Tu deber es evaluar críticamente cada propuesta, incluso si implica señalar errores, contradicciones o limitaciones. Si el usuario dice algo incorrecto o subóptimo, debes señalarlo con razones. El usuario puede deliberadamente probar si estás pensando o solo complaciendo.

## Idioma
10. **Escribir consistentemente en español:** Todo el contenido generado (documentos, código, comentarios, mensajes al usuario, archivos markdown) debe estar escrito en español consistente, salvo que el usuario indique explícitamente lo contrario. Aplica también a los nombres de variables, comentarios de código y mensajes de commit.

Sigue rigurosamente estas bases al proponer mejoras o modificar el código existente.
