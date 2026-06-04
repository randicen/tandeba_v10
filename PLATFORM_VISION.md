# Worgena — Visión de Plataforma

> Este documento captura la visión del producto y sirve como norte arquitectónico.  
> No es una especificación técnica final, sino el marco de diseño para iterar.

---

## 1. Filosofía del Producto

Una interfaz de agente LLM con hilos, especializada para firmas profesionales (abogados, contadores, consultoras) y compatible con cualquier negocio pequeño-mediano. No es un chat genérico. Es un sistema operativo de trabajo profesional.

---

## 2. Asistente (Chat + Lienzo)

### 2.1 En el chat (hilo)
- Razona, investiga y redacta.
- Citas rastreables: cada afirmación vinculada a su fuente (documento, web, base de datos).
- Soporta fuentes internas y externas siempre activas (ver §3). El usuario no elige entre buscar o no buscar: la búsqueda en la base de datos propietaria y en internet está siempre activa. El único switcher es para activar o desactivar el Modo Computador (§6).
- **Selector de modo Fast / Pro**: el usuario elige entre:
  - **Fast**: modelo más rápido y económico, adecuado para consultas cotidianas, redacción simple, búsquedas directas.
  - **Pro**: modelo con mayor profundidad y completitud de información, workflow más robusto. Ideal para análisis complejos, investigación profunda, documentos extensos.
  - Ambos modos mantienen la misma calidad de producto (Internal Quality Review y Citation Grounding siempre activos). La diferencia es de velocidad, costo y exhaustividad, no de precisión.
- **Adjuntar desde Bóveda**: el usuario puede adjuntar archivos desde las bóvedas asociadas a la carpeta actual, además de subir archivos directamente.

### 2.5 Monitores (Dashboard de actividad)
La pantalla principal incluye dos pestañas siempre visibles en la parte superior, independientes del saludo y del chat:

- **Monitor interno**: panel de actividad sobre la firma. Muestra uso de la IA por empleados, tareas completadas, productividad del equipo, métricas internas.
- **Monitor externo**: panel de novedades y cambios del mundo relevantes para la firma. Cambios normativos, tendencias del mercado, noticias del sector, actualizaciones legislativas.

### 2.2 En el lienzo (canvas)
- Visualización y edición de contenido producido por el asistente.
- Citas en formato estándar dentro del texto.
- El usuario puede editar manualmente o con IA.
- **Formatos soportados:**
  - HTML (dashboards interactivos) ✅ Ya implementado
  - Word (.docx) con editor visual ✅ Ya implementado
  - Excel (.xlsx) con editor visual ✅ Ya implementado
  - **Formato nativo de texto enriquecido tipo Notion** ✅ Decidido — editor de bloques, mejor UX.

### 2.3 Decisión sobre el formato nativo
- **Editor de bloques (ProseMirror/TipTap).** Mejor UX que markdown plano.
- **¿Complica la lectura del agente?** No, si se guarda en dos formatos:
  - `.blocks.json` — la representación nativa de ProseMirror para edición perfecta.
  - `.blocks.txt` — extracción de texto plano generada al guardar, para que el agente pueda leer sin parsear JSON.
- La extracción de texto se hace en el servidor al guardar, no en cada lectura. El agente siempre lee `.txt`.

### 2.4 Decisiones sobre el lienzo
- **Formato nativo:** editor de bloques (ProseMirror/TipTap), tipo Notion ✅
- **El lienzo es integrado** al chat (como el actual: despliega texto/hoja para visualizar/editar) ✅
- **Citas en el lienzo:** formato de texto estándar (APA7). Sin hipervínculos especiales. ✅
- **Citas en el chat/hilo:** sí llevan hipervínculo rastreable a la fuente ✅
- **Persistencia:** permanente. Se guarda como archivo en la bóveda ✅

---

## 3. Investigación del Asistente

### 3.1 Fuentes internas
- **Archivos adjuntos al hilo:** PDFs, DOCX, XLSX subidos en el chat o añadidos desde las bóvedas asociadas a la carpeta.
- **Bóvedas del usuario:** colecciones persistentes de documentos (ver §12.2).
- **Base de datos propietaria de la plataforma:** consultas estructuradas por el agente a los índices de la Arquitectura Híbrida Integrada.
- **Mecanismo:** Arquitectura Híbrida Integrada (§3.2). Siempre activa; el usuario no necesita activar la búsqueda manualmente.

### 3.2 Arquitectura Híbrida Integrada (búsqueda en bases masivas)
Diseñada para consultas sobre bóvedas y base de datos propietaria de Worgena con cientos de miles de documentos legales.

El modelo se compone de dos fases: (A) ingesta de documentos, que se ejecuta una sola vez por documento y genera tres índices paralelos, y (B) consulta agéntica, donde un LLM con herramientas ejecuta un proceso cíclico y adaptable por cada pregunta del usuario.

---

#### FASE A — INGESTA Y PREPARACIÓN DEL CORPUS (una vez por documento)

##### 1. Índice Documental (Resúmenes + Metadatos)
- **Metadatos básicos**: tipo de documento (acto legislativo, ley, decreto, resolución, sentencia), fecha, emisor, partes, identificador único.
- **Notas de vigencia**: cada documento normativo incluye metadatos explícitos sobre su estado jurídico actual:
  - **Derogación**: si fue derogado por una ley posterior, con indicación de la norma derogatoria (derogatoria expresa) o por incompatibilidad (derogatoria orgánica).
  - **Modificación**: si leyes posteriores sustituyen o adicionan contenido (ej. "Artículo 5 modificado por Ley 2080 de 2021, art. 3").
  - **Inexequibilidad**: si la Corte Constitucional declaró la norma inexequible, con el número de la sentencia que la retiró del ordenamiento jurídico.
  - **Vigencia actual**: derivado de los tres anteriores, un campo calculado que indica si la norma está vigente total, vigente parcial (algunos artículos caídos), o no vigente.
- **Referencias cruzadas**: enlaces entre normas relacionadas (ley original ↔ leyes modificatorias ↔ sentencias de inexequibilidad) para navegación rápida.
- **Mecanismo de actualización de metadatos**: las notas de vigencia no son estáticas. Funcionan así:
  1. Al descargar una norma de SUIN (Sistema Único de Información Normativa), los metadatos de vigencia vienen incluidos en la fuente.
  2. Cuando se ingiere una nueva norma que explícitamente modifica o deroga otra, el sistema detecta las referencias cruzadas en el campo anterior y re-descarga de SUIN las normas afectadas.
  3. Los metadatos antiguos de las normas afectadas se reemplazan por los nuevos (que ahora reflejan derogación, modificación o inexequibilidad).
  4. El campo `vigencia_actual` se recalcula automáticamente al actualizar cualquier nota de vigencia.
- **Resumen estructurado por secciones**: generado por un LLM durante la ingesta, aprovechando que BGE-M3 soporta hasta 8192 tokens de contexto. En lugar de un resumen genérico, el LLM recibe el mapa anatómico del documento y extrae las proposiciones jurídicas clave de cada sección con sus artículos correspondientes. Ejemplo:
```
LEY 610 DE 2000 — Régimen de responsabilidad fiscal

CAPÍTULO I (arts. 1-4): Ámbito y principios
  Art. 1: La responsabilidad fiscal se aplica a servidores públicos y
    particulares que administren o manejen bienes o fondos del Estado.
  Art. 4: Principios rectores: legalidad, debido proceso, economía,
    eficacia, equidad, imparcialidad.

CAPÍTULO II (arts. 5-8): Elementos de la responsabilidad fiscal
  Art. 5: Define la responsabilidad fiscal como el conjunto de
    actuaciones administrativas de las contralorías para determinar
    y establecer la responsabilidad de quien por acción u omisión
    cause daño patrimonial al Estado de forma dolosa o gravemente
    culposa.
  Art. 6: El proceso de responsabilidad fiscal es autónomo e
    independiente del penal y disciplinario.
```
El resumen contiene el contenido jurídico real de cada sección, no solo una descripción genérica. Esto hace que `search_docs("proceso fiscal autónomo penal")` encuentre directamente la proposición del art. 6.

- **Embedding del resumen**: vector denso (1024 dims) que BGE-M3 produce a partir del texto del resumen estructurado. Es el vector contra el cual `search_docs(query)` compara la pregunta del usuario para encontrar documentos relevantes por similitud semántica.
- **Dónde**: base de datos vectorial.
- **Función**: búsqueda semántica sobre resúmenes para consultas temáticas o generales. Herramienta: `search_docs(query, k=5)`.

##### 2. Índice de Unidades Estructurales (Chunking semántico-estructural)
El chunking no se aplica a ciegas sobre ventanas de tokens. Los documentos legales tienen una estructura jerárquica explícita e inviolable. Partir un artículo por la mitad, o fusionar el final de un artículo con el inicio del siguiente, destruye la unidad de cita jurídica y produce respuestas incompletas con citas falsamente válidas.

**Estrategia de chunking por tipo de documento:**

| Tipo de documento | Unidad mínima indivisible | ¿Cómo se chunkea? |
|---|---|---|
| Ley, decreto, resolución, acto legislativo | Artículo completo. Si el artículo tiene numerales/parágrafos, cada uno es sub-unidad con referencia al artículo padre. | Se respeta la unidad completa si cabe en ~800 tokens. Si excede, se aplica PAKTON: el artículo se divide en sub-chunks pero cada uno hereda `parent_unit_id`, `unit_number` y rango de caracteres del artículo padre. |
| Sentencia, auto, providencia | Considerando, Antecedentes, Resuelve como unidad. | Misma lógica: sección completa si cabe. Si excede (~2000+ tokens en considerandos extensos), PAKTON: sub-chunks con metadatos de sección y rango dentro del considerando. |
| Contrato, doctrina, concepto | Cláusula o sección lógica identificable (cláusula primera, cláusula segunda...). | Chunking semántico tradicional con solapamiento del 10%, respetando cláusulas como frontera. |

**Metadatos de cada unidad:**
- Todos los del Índice Documental (tipo, fecha, emisor, vigencia, referencias cruzadas).
- `unit_type`: `artículo`, `numeral`, `parágrafo`, `considerando`, `resuelve`, `cláusula`, `inciso`.
- `unit_number`: identificador normativo (ej. "3", "3.1", "4", "primera").
- `parent_unit_id`: referencia a la unidad contenedora (ej. un numeral apunta al artículo que lo contiene).
- `seccion`: sección del mapa anatómico a la que pertenece.
- `rango_inicio`, `rango_fin`: offsets de caracteres dentro del documento íntegro.

**Embeddings híbridos (dense + sparse):** misma configuración. BGE-M3 genera ambos tipos simultáneamente sin costo adicional:
- **Denso**: captura el significado semántico. Útil para encontrar ideas similares aunque usen palabras distintas (ej. "responsabilidad médica" encuentra también "mala praxis").
- **Sparse**: captura la presencia exacta de términos específicos. Útil para búsquedas léxicas precisas (ej. "artículo 234 del Código Penal" encuentra solo documentos que contienen literalmente esa cadena).

**Dónde**: base de datos vectorial con soporte híbrido (dense + sparse) y filtros por metadatos.

**Función**: recuperación precisa de unidades jurídicas completas. Una búsqueda devuelve el artículo íntegro, no un fragmento cortado. Si la unidad es muy extensa, los sub-chunks PAKTON preservan la trazabilidad al ancestro. Herramienta: `search_units(query, filtros_opcionales, k=20)`.

##### 3. Almacén de Texto Completo Estructurado
- **Texto íntegro**: el documento completo en texto plano, con marcadores de sección.
- **Mapa anatómico** en formato JSON:
```json
{
  "doc_id": "T-123-24",
  "secciones": [
    {"titulo": "Antecedentes", "inicio": 0, "fin": 5230, "resumen": "..."},
    {"titulo": "Considerando 4.3 - Precedente", "inicio": 15200, "fin": 17200, "resumen": "..."},
    {"titulo": "Resuelve", "inicio": 21800, "fin": 23500, "resumen": "..."}
  ]
}
```
- **Offsets de caracteres en lugar de números de línea**: cada sección se referencia por su posición de carácter inicial y final (`inicio`, `fin`). Es más simple, estándar y preciso que numerar líneas, y se implementa con una operación trivial de extracción de substring.
- **Dónde**: almacén de objetos o base de datos documental, indexado por `doc_id`.
- **Función**: lectura directa de secciones completas sin fragmentar. Herramientas: `get_structure(doc_id)` y `read_section(doc_id, inicio, fin)`.

---

#### FASE B — FLUJO DE CONSULTA AGÉNTICO (orquestado por un LLM con herramientas)

El agente ejecuta este proceso cíclico y adaptable por cada pregunta del usuario:

**Paso 0 — Análisis inicial**
El agente recibe la pregunta y la descompone en subconsultas si es compleja. Decide el plan de búsqueda. Siempre empieza con el radar más fino: el Índice de Unidades Estructurales. Además detecta si la pregunta requiere visión global (ver Paso 5).

Si el agente carga una skill que especifica fuentes directas (§7.1), el flujo toma un atajo: se saltan los Pasos 1-5 y el agente lee directamente las fuentes indicadas, luego procede a generación (Paso 6) y grounding (Paso 7). Si las fuentes directas no contienen la respuesta o la consulta se desborda del alcance de la skill, el agente escala automáticamente al flujo RAG completo.

El agente aplica los siguientes **principios de interpretación jurídica** (Código Civil colombiano, Ley 57 de 1887) como reglas internas de razonamiento:
- **Ley posterior prevalece sobre la anterior**: si identifica dos normas que regulan la misma materia de forma contradictoria, la más reciente deroga a la anterior en lo que le sea contraria.
- **Ley especial sobre ley general**: una norma específica sobre una materia (ej. CPACA para lo contencioso) prevalece sobre una general, salvo que la general sea posterior y pretenda regular íntegramente la materia.

**Paso 1 — Búsqueda profunda de unidades estructurales**
Herramienta: `search_units(query, filtros_opcionales, k=20)`.
El agente formula una o varias queries y obtiene las 20 unidades más relevantes con su texto, metadatos y ubicación exacta en el documento (rango de caracteres). Opcionalmente se aplica un reranker: un segundo filtro que lee realmente esas 20 unidades y las reordena del más al menos pertinente. Esto limpia el ruido cuando el corpus es muy grande.

**Paso 2 — Agrupación y selección de contextos relevantes**
El agente examina las 20 unidades y: agrupa por documento, identifica las secciones que las contienen, y evalúa si la unidad necesita más contexto (si el texto parece cortado o si la pregunta requiere la lógica completa de la sección).

**Paso 3 — Recuperación del mapa anatómico y lectura íntegra de secciones**
Herramientas: `get_structure(doc_id)` y `read_section(doc_id, inicio, fin)`.
Para los 2-3 documentos más relevantes: obtiene el mapa anatómico completo, cruza con las unidades halladas, amplía la lectura a la sección completa que contiene cada unidad, y lee secciones colindantes si el razonamiento lo exige.

**Paso 4 — Verificación dinámica de vigencia**
Antes de responder, el agente verifica que las normas recuperadas estén vigentes. Para cada documento normativo relevante:
- Consulta sus **notas de vigencia** en los metadatos del Índice Documental (derogación, modificación, inexequibilidad).
- Ejecuta una **verificación dinámica** adicional usando `search_units` y `search_docs` para detectar:
  - Leyes más recientes que hayan afectado los artículos citados.
  - Sentencias de la Corte Constitucional que hayan declarado inexequible total o parcialmente la norma.
  - Fallos de nulidad del Consejo de Estado sobre actos administrativos relevantes.
- Si encuentra que una norma fue derogada, modificada o declarada inexequible, incorpora esa información en la respuesta e indica la norma o sentencia que produjo el cambio.
- Si la verificación no es concluyente, lo advierte explícitamente y no afirma vigencia sin respaldo.

**Paso 5 — Visión global vía resúmenes (opcional)**
Se dispara cuando la pregunta es de alto nivel o comparativa (ej. "¿Cómo ha evolucionado la jurisprudencia sobre X?"). El agente usa `search_docs(resumen_query, k=5)` para obtener los resúmenes de los documentos más relevantes según el Índice Documental. Si un documento es fundamental, puede leerlo completo mediante `read_section(doc_id, 1, ultimo_caracter)`.

**Paso 6 — Generación de respuesta con citas verificables**
El agente entrega todo el contexto recuperado al LLM generador y le instruye:
- Responder usando exclusivamente la información recuperada.
- Incluir citas con el formato: `[Doc T-123/24, Considerando 4.3, caracteres 15200-17200]`.
- Si la información no es suficiente, indicarlo sin alucinar.
- Si la verificación de vigencia (Paso 4) detectó que una norma citada fue derogada, modificada o declarada inexequible, debe indicarlo explícitamente con la norma o sentencia que produjo el cambio.

**Paso 7 — Citation Grounding (verificación mecánica de citas)**
Antes de entregar la respuesta al usuario, cada cita es verificada mecánicamente:
1. Para cada cita en la respuesta, se extrae el texto real del rango citado usando `read_section(doc_id, inicio, fin)`.
2. Un LLM pequeño y barato de proveedor distinto al agente principal (ej. Gemini Flash si el agente usa DeepSeek) recibe la afirmación y el texto fuente real y determina si la afirmación se sostiene.
3. Si una cita no pasa la verificación, el agente principal recibe el flag y corrige (máximo 2 rondas).
4. Si tras 2 rondas una cita sigue sin pasar, se entrega con advertencia explícita: "Esta cita no pudo ser verificada mecánicamente contra la fuente."
Este paso elimina el sesgo de autocorrección: no es el mismo modelo revisándose a sí mismo, sino un modelo externo comparando dos textos objetivos.

##### Notas técnicas
- **Reranker**: después de recuperar 20 unidades, un modelo cross-encoder (ej. BGE-Reranker) los reordena por pertinencia real. Con corpus de 100K+ documentos, los 20 resultados iniciales pueden incluir ruido; el reranker filtra eso. Costo estimado: ~$0.0001 por consulta.
- **Resúmenes con LLM**: se generan durante la ingesta inicial, estructurados por sección con proposiciones jurídicas clave y sus artículos. Son parte integral del Índice Documental desde el día uno.
- **Modelo de embeddings**: BGE-M3 (568M params, 1024 dims, dense + sparse nativo, 8192 tokens de contexto).
- **Base vectorial**: Qdrant local o cloud, con soporte para vectores densos y dispersos, filtros por payload y RRF (Reciprocal Rank Fusion).

##### Métricas de evaluación integradas

El diseño incorpora dos métricas que miden automáticamente la calidad de cada respuesta sin requerir un gold set humano:

- **Citation Grounding (Paso 7)**: mide si cada cita respalda su afirmación comparando el rango citado contra el texto fuente real. Produce una métrica binaria por cita (pasa/no pasa) y un score agregado por respuesta (% de citas verificadas). Esta es la métrica principal de confiabilidad.
- **Vigencia de fuentes (Paso 4)**: mide si las normas citadas están vigentes, derogadas, modificadas o declaradas inexequibles. Detecta respuestas basadas en derecho no aplicable.

**Métricas pendientes (post-MVP)**: recall (¿se recuperó el documento correcto?) y satisfacción del usuario requieren un gold set de preguntas con respuestas verificadas por abogados y un sistema de feedback en la interfaz.

### 3.3 Fuentes externas
- **Web search:** DuckDuckGo (✅ implementado) o API de búsqueda. Siempre activa; el agente decide si necesita consultar internet según la pregunta.
- **Scraping curado:** fuentes públicas predefinidas (boletines oficiales, gacetas, diarios jurídicos).
- **Navegación interactiva:** modo Computador (§6) para investigación profunda. Único switcher a disposición del usuario.

### 3.4 Preguntas abiertas sobre investigación
- ¿Las fuentes externas curadas se definen a nivel de espacio/usuario o son globales de la plataforma?
- ¿El scraping curado requiere autenticación en fuentes (ej. vLex, Legis)?
- ¿La base de datos propietaria es una por cliente o una compartida con aislamiento?

---

## 4. Tabular Review

Procesamiento masivo de documentos con columnas predefinidas.

### 4.1 Mecanismo
1. **Columnas predefinidas:** el usuario crea prompts fijos (ej: "¿tiene cláusula de indemnización? Sí/No"). Mismas preguntas para todos los documentos.
2. **Batching:** documentos en lotes de 10-20. Cada lote = 1 llamada al LLM con preguntas + N documentos.
3. **Paralelismo masivo:** cientos de workers procesan lotes simultáneamente.
4. **Extracción estructurada:** el LLM devuelve JSON por documento (no texto libre).
5. **Agregación:** resultados en grilla. Fila = documento, columna = pregunta.

### 4.2 Salidas
- Exportar a Excel (.xlsx).
- Llevar resultados a un hilo con el asistente para análisis posterior.
- Visualizar como dashboard HTML interactivo (✅ ya implementado).

### 4.3 Preguntas abiertas sobre Tabular Review
- ¿Los resultados de Tabular Review se guardan como un artefacto persistente en el espacio?
- ¿Se puede re-ejecutar una Tabular Review con nuevas columnas sobre el mismo set?
- ¿El usuario puede editar celdas manualmente (corregir un "Sí" por un "No")?

---

## 5. Conexiones con Aplicaciones

Integraciones con servicios externos para leer/escribir datos:

| Categoría | Aplicaciones |
|---|---|
| **Email & Drive** | Gmail, Google Drive, Google Calendar |
| **Contabilidad** | Siigo, QuickBooks |
| **Redes sociales** | Instagram |
| **CRM** | HubSpot |
| **Comunicación** | Slack |
| **Gestión de proyectos** | Trello |
| **Firma digital** | DocuSign |
| **E-commerce** | Shopify |
| **POS** | Loyverse POS |
| **Registro de tiempo** | Clockify |

### 5.1 Preguntas abiertas sobre conexiones
- ¿Las conexiones se configuran a nivel de espacio (ej. un espacio-cliente tiene su propio Google Drive) o a nivel de cuenta de usuario?
- ¿El agente accede a estas conexiones proactivamente o solo bajo demanda explícita del usuario?
- ¿Prioridad de implementación? (ej. Google Drive primero, Shopify después)

---

## 6. Modo Computador

Agente con capacidad de crear mini-aplicaciones y navegar interactivamente.

### 6.1 Capacidades
- **Mini-aplicaciones:** conectadas a la base de datos interna del usuario. Ej: registrar tiempo en proyectos, programar equipos, generar reportes.
- **Navegación web interactiva:** browser real para formularios, portales, sistemas legacy.
- **Procesos largos:** dejar trabajando tareas complejas y notificar al terminar.
- **Tareas programadas (recurrentes o únicas):** el usuario puede programar trabajos para que el agente los ejecute automáticamente en segundo plano: tareas diarias, semanales, o con fecha y hora específica. El agente notifica al completar. Ejemplos: "cada lunes a las 8am, revisá las nuevas resoluciones de la DIAN", "el viernes 15 a las 3pm, generá el reporte mensual de horas facturables".

### 6.2 Decisiones sobre Modo Computador
- **Tecnología:** HTML/JS, como los dashboards actuales ✅
- **Ejecución:** en el cliente (navegador) ✅
- **Sincronización con bóveda (opcional):** las mini-apps pueden leer/escribir archivos de la bóveda para actualizar datos o reaccionar a cambios ✅

---

## 7. Skills (Habilidades)

Instrucciones y recursos en `.md` a demanda para procesos concretos repetibles o conocimiento de dominios específicos. Le dicen al agente **cómo debe trabajar** en un dominio o tarea.

### 7.1 Definición
Una skill es un archivo `.md` (como el estándar de agent skills) que contiene:
- Instrucciones de comportamiento para el agente.
- Recursos (referencias, templates, ejemplos).
- Tools habilitadas o restringidas para esa skill.
- Posiblemente un system prompt overlay.
- **Fuentes directas**: la skill puede especificar documentos o bóvedas concretas que el agente debe consultar para ese dominio, saltándose la búsqueda semántica (RAG). Ejemplo: una skill de "Demanda de reparación directa" indica `leyes/ley_80_1993.txt`, `jurisprudencia/ce_contratos/`, y el Código Contencioso Administrativo. Si la consulta se resuelve con esas fuentes, el agente no ejecuta los Pasos 1-5 del flujo RAG.

### 7.2 Características
- **Predefinidas:** vienen con la plataforma (ej. "Análisis de contrato", "Due diligence", "Redacción de demanda").
- **Creables:** el usuario crea un `.md` con instrucciones y lo registra como skill.
- **Componibles:** una skill puede referenciar otras skills.
- **Cargables a demanda:** el agente carga la skill cuando la tarea lo requiere, sin necesidad de mantenerla en contexto permanente.
- **Compartibles** entre miembros de una firma.
- **Categorizables:** cada skill tiene un metadato `categoria` configurable por el usuario (ej. "Contratación estatal", "Laboral", "Derecho penal"). La interfaz de Habilidades permite listar, filtrar y organizar las skills por estas categorías. También abarca los Playbooks: son skills cuyas instrucciones son procedurales (pasos a seguir) en lugar de solo comportamentales.

### 7.3 Decisiones sobre Skills
- **Almacenamiento:** en DB (por usuario). No en bóveda. Reutilizables y modificables ✅
- **Invocación:** dual. El usuario puede seleccionar manualmente, y el agente puede decidir autónomamente cuál cargar ✅
- **Playbooks como Skills:** no son un concepto separado. Son skills cuyas instrucciones definen pasos concretos en lugar de solo reglas de comportamiento ✅

### 7.4 Plugins (Paquetes de especialización)
- **Definición:** paquetes preconfigurados que combinan skills + conectores + workflows para una profesión o rol específico (ej. "Plugin Abogado Litigante", "Plugin Contador Público", "Plugin Consultor Empresarial").
- **Diferencia con una skill:** una skill es una instrucción individual. Un plugin es un conjunto integrado de varias skills, conectores a servicios externos (Google Drive, DocuSign, Siigo) y workflows predefinidos, todo empaquetado para un perfil profesional.
- **Origen:** algunos plugins vienen predefinidos con la plataforma. Los usuarios pueden crear los propios y compartirlos dentro de la firma.
- **Experiencia a nivel de rol:** al activar un plugin, el agente carga todo el conjunto (skills relevantes, conexiones configuradas, workflows) y adapta su comportamiento al rol profesional.

---

## 9. Agentes

### 9.1 Arquitectura: Agente único + skills dinámicas + sub-agentes ✅

**El usuario interactúa con un solo agente ("Worgena").** No elige entre múltiples agentes. La especialización se logra mediante skills cargadas a demanda, no mediante agentes separados.

**Sub-agentes:** sesiones temporales creadas solo para tareas pesadas en paralelo (ej: `delegate_task("due-diligence", input)`). Se crean, procesan, devuelven resultado, y se destruyen. No son persistentes ni visibles para el usuario.

**Recomendación técnica: agente único con personalidad dinámica.**

| | Agente único + skills | Múltiples agentes con memoria individual |
|---|---|---|
| **Simplicidad** | Un solo loop, una sola memoria | N loops, N memorias, orquestación compleja |
| **Contexto** | Skills cargan instrucciones a demanda, sin saturar el system prompt | Cada agente tiene su system prompt fijo en contexto siempre |
| **Memoria** | Unificada — el agente recuerda todo de todas las tareas | Fragmentada — el agente contable no sabe lo que hizo el legal |
| **Costo de implementación** | Skills son archivos `.md` (ya lo tienes con AGENTS.md) | Requiere sistema de orquestación multi-agente |
| **UX** | El usuario habla con "Worgena", no con 5 agentes distintos | El usuario tiene que elegir qué agente invocar |

**Conclusión:** Un solo agente con skills cargables a demanda + memoria unificada. Las skills definen personalidad y tools para cada tarea. Si en el futuro se necesita paralelismo real (múltiples agentes trabajando simultáneamente), se implementa como sub-agentes con delegación (ver §10), no como agentes independientes que el usuario debe gestionar.

### 9.2 Preguntas abiertas sobre Agentes
- ~~¿Agente único o múltiples?~~ → Agente único + skills dinámicas ✅
- ~~¿Los agentes se comparten dentro de la firma?~~ → Las skills sí. El agente es uno solo.
- ~~¿Un espacio puede tener múltiples agentes?~~ → No aplica. Un agente, múltiples skills.
- ~~¿La memoria es unificada o fragmentada?~~ → Unificada ✅

---

## 10. Flujos de Trabajo en Equipo

Coordinación de múltiples agentes para un objetivo complejo que requiere múltiples competencias.

Ejemplo: un agente "Investigador" busca jurisprudencia, un agente "Redactor" produce el documento, un agente "Revisor" verifica citas y formato. El usuario solo ve el resultado final.

### 10.1 Preguntas abiertas sobre Trabajo en Equipo
- ¿Se implementa como sub-agentes (sesiones independientes con delegación, como ya discutimos en §Forma 2)?
- ¿Los agentes en equipo comparten un workspace o tienen espacios aislados?
- ¿El usuario puede intervenir en pasos intermedios o solo ve el resultado final?

---

## 11. Workflow Engine

Orquestación de comportamiento por defecto de todos los agentes. No configurable por el usuario, sino por el software.

### 11.1 Investigación: PAKTON y L-MARS

#### PAKTON (arXiv:2506.00608, EMNLP 2025)
Framework multi-agente open-source para revisión de contratos largos con 3 agentes:

| Agente | Rol | Equivalente en nuestro engine |
|---|---|---|
| **Archivist** | Ingesta del documento, parsing jerárquico (árbol de secciones), 3 tipos de chunking (nodo, ancestro, descendiente), embeddings con metadatos | **Ingesta** — Arquitectura Híbrida Integrada Fase A |
| **Interrogator** | Loop iterativo de preguntas→respuestas→refinamiento. Genera reporte con: título, razonamiento jurídico, hallazgos, gaps de conocimiento, citas. Para cuando está seguro o alcanza max turns. | **Generación + Refinamiento** — nuestro agente principal con loop de steps |
| **Researcher** | Retrieval híbrido (BM25 + dense + RRF + LightRAG), reranker cross-encoder, MCP para fuentes externas | **Búsqueda** — nuestros tools de search_web, read_file, search_units |

**Hallazgos clave:**
- Model-independent: reduce la brecha entre LLMs a <4% F1. DeepSeek V3 con PAKTON = 81.9% F1.
- El loop iterativo del Interrogator genera follow-up questions hasta estar seguro.
- Chunking contextual (ancestor-aware + descendant-aware) supera a chunking plano.
- **Código abierto:** github.com/petrosrapto/PAKTON

#### L-MARS (arXiv:2509.00761)
Sistema multi-agente para QA legal con búsqueda web agéntica.

| Componente | Rol |
|---|---|
| **Query Decomposition** | Descompone la pregunta en sub-problemas estructurados |
| **Agentic Web Search** | Búsqueda web agéntica (no RAG pasivo sobre corpus fijo) |
| **Verification Agent** | **"Juez en el bucle"** — verifica cada pieza de evidencia antes de usarla |
| **Synthesis** | Sintetiza respuesta con citas verificables |

**Hallazgos clave:**
- 96% accuracy en LegalSearchQA (38% de mejora sobre zero-shot).
- La verificación es el diferenciador: sin el juez, el modelo alucina información desactualizada.
- En tareas de razonamiento puro (Bar Exam), el retrieval no ayuda. Solo sirve cuando se necesita información actualizada.
- **Código abierto:** github.com/boqiny/L-MARS

### 11.2 Diseño final para nuestro Workflow Engine

**No implementamos PAKTON ni L-MARS como frameworks. Extraemos 4 principios validados académicamente y los integramos en nuestro loop de agente existente:**

#### Principio 1: Internal Quality Review (de L-MARS, reinterpretado)

Antes de mostrar la respuesta al usuario, el agente ejecuta una revisión interna de calidad sobre su propio output. No es un agente separado — es un paso adicional en el loop:

```
Step N:   Agente genera respuesta con citas
Step N+1: [QUALITY REVIEW] El mismo agente recibe instrucción interna:
          "Revisa tu respuesta anterior. ¿Hay afirmaciones sin fuente?
           ¿Las citas son correctas en formato? ¿El tono es adecuado?
           ¿Hay contradicciones internas? Si encuentras errores, corrige."
Step N+2: Agente entrega respuesta revisada al usuario.
```

- **Modelo:** DeepSeek V4 Flash (mismo modelo, prompt distinto)
- **Costo adicional:** 1 llamada extra por respuesta (~$0.0008)
- **Máximo:** 2 intentos de revisión. Si tras 2 correcciones sigue con problemas, entrega con advertencia.

**Lo que SÍ detecta:** omisiones, errores de formato, contradicciones internas, tono inadecuado, afirmaciones sin fuente evidente.

**Lo que NO detecta:** citas cuyo formato es correcto pero cuyo contenido no respalda la afirmación. Ejemplo: el agente escribe "el artículo 234 establece que la sanción es de 5 años" y cita `caracteres 15200-17200`. El formato es correcto, parece real. Pero el rango 15200-17200 podría hablar de otra cosa. El modelo no lo verificará porque ya "cree" que su afirmación es correcta. Para eso existe el Principio 4.

#### Principio 2: Chunking Contextual Estructural (de PAKTON)

Para la Arquitectura Híbrida Integrada, usamos 3 niveles de chunking con metadatos de sección:

| Nivel | Qué contiene | Para qué |
|---|---|---|
| Nodo aislado | El texto de un artículo/considerando/cláusula individual | Búsqueda precisa de unidades específicas |
| Ancestro + nodo | La sección + su título padre y contexto jerárquico | Desambiguación y comprensión de estructura |
| Descendientes | Una sección con todas sus subsecciones | Razonamiento sobre provisiones compuestas |

Cada unidad lleva metadatos: `doc_id`, `seccion`, `rango_inicio`, `rango_fin`, `tribunal`, `fecha`, `unit_type`, `unit_number`, `parent_unit_id`.

#### Principio 3: Confidence Gating (de PAKTON Interrogator)

El agente evalúa su propio nivel de confianza antes de responder. Si no está seguro:

1. **Confianza alta:** entrega respuesta directamente.
2. **Confianza media:** busca más información (más unidades, web search).
3. **Confianza baja:** pide clarificación al usuario. No adivina.

El agente ya tiene `<scratchpad>` para razonar. Agregamos un paso: después del scratchpad, asigna un nivel de confianza explícito (HIGH/MEDIUM/LOW) y actúa según la regla.

#### Principio 4: Citation Grounding — Verificación mecánica de citas

Este principio ataca el error más grave en investigación legal: citar un rango de caracteres que existe, que parece correcto, pero cuyo contenido real no respalda lo que el agente afirma. El modelo no puede detectarlo solo con autorrevisión (Principio 1) porque ya "cree" que su afirmación es correcta.

**Qué hace:** un proceso automático que, para cada cita en la respuesta, extrae mecánicamente el rango citado y compara afirmación contra fuente real.

```
Para cada cita en la respuesta del agente:
  1. Extraer el texto real del rango citado:
     read_section(doc_id, inicio, fin) → texto fuente
  2. Comparar la afirmación del agente contra el texto fuente real:
     Se envía a un LLM (modelo pequeño/barato, proveedor distinto):
     "Afirmación: [texto de la afirmación]
      Fuente real (caracteres 15200-17200): [texto extraído del almacén]
      ¿La afirmación se sostiene con el texto fuente? Responde SÍ/NO y explica."
  3. Si la afirmación no se sostiene → flag de error.
     El agente principal recibe el flag y corrige la cita o la afirmación.
```

**Decisiones de implementación:**
- **Modelo:** un LLM pequeño y barato de proveedor distinto al agente principal (ej. Gemini Flash si el agente usa DeepSeek). Esto elimina el sesgo de autocorrección del mismo modelo.
- **Costo:** ~$0.00005 por cita verificada. Con ~3 citas por respuesta, ~$0.00015 adicionales.
- **Máximo:** 2 rondas de corrección. Si tras 2 rondas una cita sigue sin pasar, se entrega con advertencia explícita: "Esta cita no pudo ser verificada mecánicamente contra la fuente."
- **Integración en Fase B:** Paso 7 del flujo de consulta (ver §3.2, Fase B).

**Lo que SÍ detecta:** citas cuyo rango existe pero cuyo contenido no respalda la afirmación; citas a rangos que pertenecen a otro documento; afirmaciones factualmente incorrectas sobre el contenido de una fuente.

### 11.3 ¿Por qué no implementamos PAKTON ni L-MARS completos?

PAKTON usa 3 agentes con ReAct loops separados = 3x llamadas por consulta. Contradice nuestra decisión de arquitectura (agente único + skills). L-MARS está diseñado para web search legal, no para análisis documental interno. El 80% de su código no aplica. Ambos son académicos, no production-ready.

Tomamos la evidencia científica de lo que funciona (verificación mecánica de citas reduce alucinaciones graves, chunking jerárquico mejora retrieval, refinamiento iterativo produce mejores respuestas, revisión de calidad corrige omisiones) y lo implementamos como ~120 líneas en nuestro loop.

---

## 12. Sidebar y Organización

### 12.1 Carpetas y subcarpetas
**Las carpetas reemplazan completamente el concepto actual de "Espacios".** Migración: la tabla `spaces` evoluciona a `folders` con `parent_id` para jerarquía. Dentro de cualquier carpeta el usuario puede hacer dos cosas fundamentales:
1. **Crear hilos:** abrir conversaciones con el agente sobre temas específicos. Ejemplo: dentro de "Clientes > Juan" abrir un hilo preguntando "¿cuáles son las deudas pendientes?".
2. **Crear subcarpetas:** anidar carpetas hijas para refinar la organización. Ejemplo: dentro de "Clientes" crear las subcarpetas "Juan", "Alberto", "María".

```
📁 Clientes            ← carpeta con hilos (consultas generales sobre clientes)
  📁 Juan              ← subcarpeta con sus propios hilos y bóvedas
  📁 Alberto
  📁 María
📁 Litigios
  📁 Caso XYZ          ← subcarpeta con hilos, bóvedas y skills del caso
  📁 Caso ABC
```

Cada carpeta/subcarpeta puede tener:
- Sus propias reglas de trabajo (system prompt heredable).
- Sus propias bóvedas/archivos/artefactos.
- Sus propias skills asignadas.
- Sus propias tareas programadas.

### 12.2 Bóvedas (Vaults)
- **Colecciones de documentos y artefactos**, no contenedores organizacionales. Mientras las carpetas organizan la jerarquía de trabajo (clientes, proyectos, litigios), las bóvedas agrupan los archivos que el agente y el usuario consultan y producen.
- Cada carpeta puede tener una o más bóvedas asociadas.
- Accesibles desde el sidebar o desde dentro de carpetas/proyectos.
- Los artefactos creados por el agente (docs, excels, dashboards, tabular reviews) viven en las bóvedas, con una etiqueta de origen (`usuario` o `agente`) pero sin ubicación separada.
- Se pueden destacar con **bookmarks** (acceso rápido a dashboards, plantillas, lo que sea).
- **Sincronización bidireccional** con sistemas externos: Google Drive, SharePoint, Dropbox, OneDrive.

**Vistas de bóveda:**
- **Vista de bloques (grid):** tarjetas con previsualización del contenido (miniatura del documento, nombre, tipo, fecha). Más visual y navegable. Al hacer clic en una tarjeta se abre el detalle completo del documento o artefacto.
- **Vista de lista:** formato tabla tradicional con columnas (nombre, tipo, fecha, origen, tamaño). Más densa y adecuada para búsquedas rápidas.
- **Organización:** por defecto ordenado por fecha. Filtrable por categoría: diapositiva, documento, imágenes, hojas de cálculo, tablas (tabular review), o categorías personalizadas.
- **Fijar elementos:** el usuario puede anclar documentos o artefactos al tope de la bóveda para acceso rápido permanente.

### 12.3 Decisiones sobre Sidebar
- **Carpetas reemplazan Espacios** ✅
- **Bóvedas**: colecciones de documentos asociadas a carpetas ✅
- **Artefactos del agente**: viven dentro de las bóvedas, distinguibles por metadatos ✅
- **Bookmarks:** por carpeta (no globales) ✅
- **Sincronización externa:** bajo demanda — se sincroniza cada vez que el usuario hace una consulta con la función de sincronización activa ✅

---

## 13. Resumen de estado actual vs. visión

| Funcionalidad | Estado actual | Meta | Decisión |
|---|---|---|---|
| Chat con agente | ✅ Implementado | Agente único + skills dinámicas | Opción A ✅ |
| Lienzo Word/Excel | ✅ Implementado | OK | — |
| Lienzo HTML (dashboards) | ✅ Implementado | OK | — |
| Lienzo texto nativo | ❌ | Editor de bloques (ProseMirror/TipTap) | ✅ |
| Tabular Review | ✅ Batch básico | Workers paralelos, UI dedicada | — |
| Investigación web | ✅ DuckDuckGo + Apify | + scraping curado | — |
| Investigación interna | ✅ read_file | Arquitectura Híbrida Integrada | — |
| Memoria | ✅ 3 tiers | Unificada (agente único) | ✅ |
| Espacios | ✅ | Migrar a carpetas jerárquicas | ✅ |
| Bóvedas | ❌ | Colecciones de docs/artefactos asociadas a carpetas. Sync bajo demanda | ✅ |
| Conexiones externas | ❌ | 12 integraciones planeadas | — |
| Skills | ❌ | .md en DB, invocación dual (manual/auto) | ✅ |
| Workflows | ❌ | Orquestación con verification steps | — |
| Workflow Engine | ❌ | 4 principios (quality review + chunking + confidence gating + citation grounding) | ✅ |
| Modo Computador | ❌ Parcial | Mini-apps + browser persistente + tareas programadas | ✅ |
| Monitores | ❌ | Dashboard interno (actividad) y externo (novedades) | ✅ |
| Plugins | ❌ | Paquetes de skills + conectores + workflows por rol profesional | ✅ |
| Fast / Pro | ❌ | Selector de modo: rápido/económico vs profundo/completo | ✅ |
| Bookmarks | ❌ | Por carpeta | ✅ |
| Multi-tenancy | ❌ | Datos aislados por firma, servidor compartido | ✅ |

---

## 14. Prioridades sugeridas para próximas iteraciones

1. **Formato nativo de texto enriquecido** en el lienzo (lo más urgente).
2. **Bóvedas** con upload masivo y previsualización.
3. **Especialización del agente:** skills predefinidas para firmas legales.
4. **Arquitectura Híbrida Integrada** para búsqueda en bóvedas.
5. **Conexiones** (empezando por Google Drive).
6. **Workflows** simples (primer workflow: "Analizar contrato").
7. **Tabular Review UI** dedicada.

---

## 15. Decisiones finales de la sesión de planeación

| Decisión | Dirección |
|---|---|
| **Decomposer** | Solo cuando el usuario da tarea compleja multi-paso ✅ |
| **Workflows y versionado** | Modifican el original. Siempre hay versionado de documentos ✅ |
| **Fuentes externas** | Compartidas por defecto para toda la firma. Con prioridades y lista negra, no exhaustivo ✅ |
| **Onboarding de documentos** | Manual (upload). El agente puede traer de email a petición ✅ |
| **Sincronización externa** | Bajo demanda (ya decidido) ✅ |

### Pendiente: Multi-tenancy ✅

**Decisión: Opción A — Datos completamente aislados por firma.**

No implica necesariamente "un servidor por firma". Implica:

- **Base de datos:** cada firma tiene su propia DB en Xata (o schema separado). Los datos de la Firma Pérez nunca tocan los de la Firma Gómez.
- **Servidor:** uno solo en Railway ($5/mes) alcanza para múltiples firmas en MVP. El servidor se conecta a la DB correcta según la firma autenticada.
- **Archivos (R2):** buckets o prefijos separados por firma.
- **Si una firma crece mucho:** se le puede dedicar su propio servidor sin tocar a las demás.

---

## 16. Futuras expansiones (post-MVP)

Funcionalidades reconocidas como valiosas pero cuyo costo de implementación las excluye del MVP. Quedan documentadas para no perder el norte.

### 16.1 Grafo de citaciones / Red de precedentes

Una sentencia no se entiende aislada: cita otras sentencias, sigue líneas jurisprudenciales, distingue precedentes. Hoy el sistema encuentra documentos por similitud semántica y fecha, pero no conoce la relación explícita entre ellos (A es leading case de B, C sigue a B, D distingue a A).

**Valor**: preguntas como *"¿hay línea jurisprudencial consolidada sobre X desde 2020?"* o *"¿cuál es el leading case sobre Y?"* se responderían con precisión quirúrgica.

**Costo**: extraer, desambiguar y clasificar citas en 100K+ documentos colombianos con formatos inconsistentes requiere NLP avanzado y validación. No es viable en MVP.

**Referencias**: GraphRAG (Microsoft), extractor de citas de PAKTON.

**Estado**: documentado para fase posterior. No modifica la arquitectura de ingesta actual.

**No es un "servidor por firma". Es "datos aislados por firma con servidor compartido."**
