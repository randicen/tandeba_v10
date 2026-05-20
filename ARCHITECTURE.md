# Arquitectura de la Aplicación y Lecciones Aprendidas

Este documento sirve como registro de las decisiones arquitectónicas clave y los aprendizajes obtenidos durante las iteraciones de desarrollo, garantizando la estabilidad y robustez del sistema.

## 1. Procesamiento y Limpieza de Mensajes del Agente (UI / Frontend)
Los modelos de IA (Gemini y otros) a menudo incluyen su proceso de razonamiento interno dentro de la respuesta.
- **Problema encontrado:** Las reflexiones del agente (`<scratchpad>`, `<think>`, `<Agent Reflection & Plan>`) se "escapaban" hacia la interfaz de chat de usuario.
- **Solución implementada:** Se añadieron filtros estrictos con expresiones regulares globales (`/[\s\S]*?/gi`) tanto para remover estos bloques de razonamiento (usando `replace` en `agent.ts` y `App.tsx`), así como cualquier bloque de código markdown redundante.
- **Mensajes vinculados a *Action Tools*:** Muchas veces el modelo genera un texto como "Voy a hacer click en..." seguido de un *tool call*. Para evitar ensuciar la interfaz, se condicionó el renderizado del texto `msg.content` de manera que no se renderice texto sobrante si el mensaje contiene llamadas a herramientas (`!msg.tool_calls || msg.tool_calls.length === 0`).

## 2. Resiliencia en Scraping y Automatización (Backend / Apify)
Al raspar páginas web, especialmente portales académicos o sitios pesados, ocurren bloqueos y timeouts.
- **Problema encontrado:** `playwright-scraper` arrojaba errores `net::ERR_TIMED_OUT` (Navigation timed out).
- **Solución implementada:** En la configuración de Apify Actor (`src/agent/apify.ts`), se introdujeron configuraciones clave para mayor resiliencia:
  - `pageLoadTimeoutSecs: 120`
  - `requestHandlerTimeoutSecs: 180`
  - `waitUntil: 'domcontentloaded'` (en lugar de esperar que la red se quede ociosa).

## 3. Estados en React y Polling con Intervalos
- **Problema encontrado:** Evitar _stale closures_ o múltiples re-renderizados al manejar llamadas repetitivas de actualización al backend para revisar el estado del *session / step*.
- **Solución implementada:** En `src/App.tsx`, las funciones reactivas como `onUpdate` se mantienen dentro de un ciclo `setInterval` mediante el uso de un `useRef` reactivo (por ejemplo, `onUpdateRef.current = onUpdate`), haciendo que el intervalo acceda a la versión más actualizada de la función de estado sin tener que reiniciarse el componente a cada instante.

*Nota:* Adicionalmente se ha registrado también en el archivo `AGENTS.md` para que prevalezca como regla base para futuras modificaciones del sistema.
