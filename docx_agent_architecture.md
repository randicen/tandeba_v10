# Plan de Arquitectura: Editor de Documentos Agéntico (DOCX)

## Perspectiva General
Para lograr un editor que permita a un Agente IA modificar texto y formato avanzado de un documento Word (`.docx`) de gran complejidad sin perder sus metadatos (firmas, membretes, macros, diseño estricto), abandonamos la conversión "DOCX -> HTML -> DOCX" que emplean los editores web tradicionales.
En su lugar, operaremos directamente sobre el código fuente del archivo: su árbol XML interno.

## Fase 1: Motor de Procesamiento (DOM/XML DOCX) - *Actual*
**Objetivo:** Leer, parsear y empaquetar archivos `.docx` aplicando manipulaciones quirúrgicas sobre su contenido y formato.
* Instalar herramientas de bajo nivel: `pizzip` (manipulación del contenedor ZIP del DOCX) y `@xmldom/xmldom` (manipulación segura del DOM XML en Node.js).
* Construir el servicio core `DocxEngine` capaz de abstraer la estructura interna (`word/document.xml`, `word/styles.xml`, `word/settings.xml`).
* Proveer primitivas para: extraer texto completo estructurado, reemplazar párrafos, o alterar configuraciones globales del layout (márgenes, tamaño de hoja).

## Fase 2: Interfaz de Usuario y Previsualización (Preview)
**Objetivo:** Mostrar al usuario el contenido del archivo mientras ocurre la magia.
* Dado que el documento fuente es ahora el "backend", el frontend solo necesita un modo de visualización fluida.
* Instalar `mammoth` para derivar una lectura ligera en HTML puramente con propósitos visuales (Preview mode), sin que esto altere el documento real.
* Extender la interfaz actual (que ya soporta descargas) para incorporar un panel doble o un modal de previsualización para archivos DOCX.

## Fase 3: Integración de Capacidades Agénticas (Tools)
**Objetivo:** Conectar el `DocxEngine` al sistema de herramientas del LLM.
* `read_docx_structure`: Para que el LLM pueda analizar la jerarquía y contenido actual de un documento cargado en la sesión.
* `edit_docx_content`: Para que el LLM ordene reemplazos exactos, inserciones o eliminaciones de párrafos en el XML.
* `update_docx_formatting`: Para que el LLM aplique comandos de formato profesionales ("ajusta los márgenes a modo estrecho", "cambia el tamaño de página a A4").

## Fase 4: Orquestación, Descarga y Testeo
**Objetivo:** Unir el flujo completo y asegurar la fiabilidad ofimática.
* Pruebas de estrés modificando contratos y plantillas complejas.
* Garantizar que los cambios aplicados en la sesión estén sincronizados cuando el usuario haga clic en "Descargar".
