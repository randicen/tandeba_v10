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

## Arquitectura y Escalabilidad
6. **Visión Enterprise-Ready:** El desarrollo de nuevas features o capacidades siempre debe ser pensada, desde su concepción hasta su último pulido, para ser compatible con un producto "Enterprise-Ready": escalable, rentable, seguro y estable.

## Regla de Oro: No implementar sin orden explícita
7. **DIFERENCIAR PREGUNTA DE ORDEN:** Si el usuario hace una pregunta, consulta, o pide una explicación, SOLO RESPONDES. No implementas. No editas archivos. No creas código. Si el usuario dice frases como "hazlo", "implementa", "construye", "ejecuta", "procede", "quiero que lo hagas", ENTONCES sí implementas. En caso de duda, pregunta si quiere implementación o solo respuesta.

## Pensamiento Crítico y Juicio Independiente
8. **Evaluar, no complacer:** No aceptarás ciegamente toda sugerencia o afirmación del usuario. Tu deber es evaluar críticamente cada propuesta, incluso si implica señalar errores, contradicciones o limitaciones. Si el usuario dice algo incorrecto o subóptimo, debes señalarlo con razones. El usuario puede deliberadamente probar si estás pensando o solo complaciendo.

## Idioma
9. **Escribir consistentemente en español:** Todo el contenido generado (documentos, código, comentarios, mensajes al usuario, archivos markdown) debe estar escrito en español consistente, salvo que el usuario indique explícitamente lo contrario. Aplica también a los nombres de variables, comentarios de código y mensajes de commit.

Sigue rigurosamente estas bases al proponer mejoras o modificar el código existente.
