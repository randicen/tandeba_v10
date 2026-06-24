# Worgena — Visión de Plataforma

> Este documento captura la visión del producto y sirve como norte arquitectónico.  
> No es una especificación técnica final, sino el marco de diseño para iterar.
>
> Las **decisiones arquitectónicas vigentes** del sistema agéntico (motor de workflows, 3 capas, multi-modelo, memoria 4 tipos, verificador en sub-sesión, custom DSL) están en [`AGENT_ROADMAP.md`](./AGENT_ROADMAP.md). Este doc describe QUÉ construimos como producto; el roadmap describe CÓMO.

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
  - Ambos modos mantienen la misma calidad de producto. La diferencia es de velocidad, costo y exhaustividad, no de precisión. El routing interno multi-modelo por nodo (qué modelo se usa en cada paso del workflow) es decisión técnica del motor, invisible al usuario (ver §11).
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
  - **Vigencia actual**: derivado de los tres anteriores, un campo calculado que indica si la norma está vigente total, vigente parcial (algunos artículos caídos), o no vigente. **Se computa a query time por traversal del grafo de derogaciones**, no se almacena como flag estático. La cadena de derogación puede tener varios eslabones: A → derogada por B → derogada por C. Si C está vigente, A está derogada. Si C está derogada, la derogación de B cae, y la derogación de A también cae (B no puede haber derogado nada si está muerta). La traversal garantiza que cualquier cambio en la cadena se propague automáticamente sin actualizar flags manualmente.
- **Referencias cruzadas**: enlaces entre normas relacionadas (ley original ↔ leyes modificatorias ↔ sentencias de inexequibilidad) para navegación rápida.
- **Mecanismo de actualización de metadatos**: las notas de vigencia no son estáticas. Funcionan así:
  1. Al descargar una norma de SUIN (Sistema Único de Información Normativa), los metadatos de vigencia vienen incluidos en la fuente.
  2. Cuando se ingiere una nueva norma que explícitamente modifica o deroga otra, el sistema detecta las referencias cruzadas en el campo anterior y re-descarga de SUIN las normas afectadas.
  3. Los metadatos antiguos de las normas afectadas se reemplazan por los nuevos (que ahora reflejan derogación, modificación o inexequibilidad).
  4. El campo `vigencia_actual` se recalcula automáticamente al actualizar cualquier nota de vigencia. En la práctica, la vigencia se resuelve a query time siguiendo la cadena de derogadores en el grafo — un solo `UPDATE` de un eslabón (ej. marcar C como derogada) se propaga automáticamente al estado de A y B sin escrituras adicionales.
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

**Contexto en el embedding (PAKTON completo).** El chunk a secas — "Artículo 5. Modifíquese el art. 234 del CPenal" — es ambiguo: ¿qué art. 234? ¿de qué versión? Sin contexto, el vector denso solo captura una oración corta y la similitud semántica se degrada. El chunk que se embebe, y se almacena, viaja con contexto prefijado de tres niveles:

1. **Ancestor (jerárquico)**: prefijo de la cadena de contenedores, de raíz a hoja.
   ```
   [LEY 2080/2021]
   [CAPÍTULO II — Reforma procesal]
   [Artículo 3 — Modificaciones al CPACA]
   Artículo 5. Modifíquese el artículo 234 del Código Penal.
   ```
   ~50–100 tokens. **Siempre** se incluye.

2. **Sibling (artículos vecinos, "por contraste")**: el agente que lee el chunk necesita saber qué hace el artículo anterior y el siguiente para entender el patrón. Para una unidad de 800 tokens, se incluyen los 1–2 vecinos inmediatos en forma resumida.
   ```
   Previo: Art. 4 — Modifica art. 233 CPACA
   Actual: Art. 5 — Modifica art. 234 CPenal
   Siguiente: Art. 6 — Modifica art. 235 CPACA
   ```
   ~100–200 tokens. **Siempre** se incluye si los vecinos existen.

3. **Predecessor (texto referenciado)**: si el chunk es una *modificación* ("modifíquese el art. X de la Ley Y"), se incluye el texto original del art. X al que modifica, para que el vector entienda QUÉ se está cambiando. Si el chunk es una *sentencia*, se incluye el enunciado del problema jurídico y la tesis del considerando anterior.
   ```
   El art. 5 modifica: Art. 234 del Código Penal —
     "El prestador de salud responderá por los daños
     al paciente derivados de la atención médica."
   ```
   ~200–500 tokens. **Condicional**: solo si el chunk contiene referencias explícitas a otras normas/secciones.

Coste total de contexto embebido: 350–800 tokens extra sobre el chunk de ~800. Es decir, el embedding consume ~1200–1600 tokens de los 8192 disponibles. Todavía entra holgadamente.

El chunk almacenado en el vector store es `contexto + unidad`, con `rango_inicio/rango_fin` apuntando únicamente al texto de la unidad (excluyendo el contexto prefijo). Las citas del agente citan la unidad, no el contexto. El contexto es solo para retrieval.

**Metadatos de cada unidad:**
- Todos los del Índice Documental (tipo, fecha, emisor, vigencia, referencias cruzadas).
- `unit_type`: `artículo`, `numeral`, `parágrafo`, `considerando`, `resuelve`, `cláusula`, `inciso`.
- `unit_number`: identificador normativo (ej. "3", "3.1", "4", "primera").
- `parent_unit_id`: referencia a la unidad contenedora (ej. un numeral apunta al artículo que lo contiene).
- `seccion`: sección del mapa anatómico a la que pertenece.
- `rango_inicio`, `rango_fin`: offsets de caracteres del texto de la unidad dentro del documento íntegro (excluye el contexto prefijo, que no se cita).
- `context_token_count`: tokens del contexto prefijo (ancestor + sibling + predecessor), útil para auditoría y debugging.

**Embeddings híbridos (dense + sparse):** misma configuración. BGE-M3 genera ambos tipos simultáneamente sin costo adicional sobre el chunk expandido:
- **Denso**: captura el significado semántico del chunk + contexto. Útil para encontrar ideas similares aunque usen palabras distintas (ej. "responsabilidad médica" encuentra también "mala praxis").
- **Sparse**: captura la presencia exacta de términos específicos. Útil para búsquedas léxicas precisas (ej. "artículo 234 del Código Penal" encuentra solo documentos que contienen literalmente esa cadena).

**Dónde**: base de datos vectorial con soporte híbrido (dense + sparse) y filtros por metadatos.

**Función**: recuperación precisa de unidades jurídicas completas con su contexto jerárquico. Una búsqueda devuelve el artículo íntegro más el suficiente contexto para entender de dónde viene y qué hace. Si la unidad es muy extensa, los sub-chunks PAKTON preservan la trazabilidad al ancestro. Herramienta: `search_units(query, filtros_opcionales, k=20)`.

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

**Paso 4 — Verificación de vigencia**
Antes de responder, el agente verifica que las normas recuperadas estén vigentes. La verificación opera en dos niveles, del más confiable al más probabilístico:

1. **SQL precalculado (camino rápido, 95% de casos)**: el agente consulta los campos `derogado_por`, `modificado_por`, `inexequible_por` del Índice Documental. La traversal del grafo de derogación resuelve el estado actual de cada norma. Si la cadena dice "Vigente", se reporta. Si dice "Derogada por X" o "Modificada por Y", se reporta con la referencia. La respuesta del SQL refleja los datos de la última sincronización con SUIN.
2. **Safety net vectorial (solo si el SQL es ambiguo o antiguo)**: si el SQL dice "Vigente" pero la última sync de SUIN es de hace más de N días, o si la consulta del usuario tiene keywords que sugieren "esta norma podría haber cambiado" (ej. "última reforma", "norma vigente actualmente"), el agente ejecuta `search_units` + `search_docs` con queries como "Ley X derogada modificada inexequible" para detectar cambios no reflejados en el SQL. El resultado se verifica con `read_section` antes de afirmar.

**Residual conocido (5-10% de casos)**: el sistema no detecta automáticamente la **derogación implícita** (una ley nueva que cubre la misma materia sin decir explícitamente "deroga X") ni las **modificaciones no declaradas** (un cambio de redacción que SUIN no marcó). El mecanismo de sync periódico de SUIN cubre las derogaciones **explícitas** (que SUIN sí registra); este gap es independiente. Para el residual se ejecuta un job de detección que se dispara al ingestar cada ley nueva:

1. La ley nueva se indexa normalmente (ingesta Fase A: TXT, metadatos, embedding híbrido, chuncking PAKTON — todo el pipeline existente). Como parte de la ingesta, se genera por primera vez su resumen estructural (Fase A aplica también a la nueva ley, no solo a las viejas).
2. Una vez indexada, se hace una búsqueda libre de normas vigentes cuya materia se solape con la nueva. La búsqueda usa los mismos mecanismos de retrieval del sistema (Índice 1 + Índice 2, dense + sparse, sin reglas rígidas de sector ni umbrales arbitrarios). Lo que determine el retrieval como más cercano es lo que se revisa. Es un retrieval normal, no un detector con reglas especiales.
3. Para cada candidata del top-k, un LLM lee el resumen estructural de la nueva + el resumen estructural de la candidata + las fechas de expedición + (si están disponibles) los marcadores de "general" o "especial" de cada una. Aplica la **jerarquía de derogación del derecho colombiano** (Código Civil art. 3, Ley 153/1887 art. 2) y clasifica: `deroga` | `modifica` | `complementa` | `sin_relación`. Orden de evaluación que el LLM debe seguir:

   a. **¿Derogación expresa?** La nueva dice "deroga X". Si sí, FIN. Aplica aunque sea general deroga especial (la derogación expresa prevalece sobre la regla invertida del art. 3 CC).
   b. **¿Hay incompatibilidad material?** Comparar resúmenes. Si la nueva contradice la materia de la anterior sin decirlo, hay derogación tácita. Si no hay incompatibilidad, el resultado es `complementa` o `sin_relación` y termina el análisis.
   c. **Naturaleza y temporalidad**: identificar si cada norma es general o especial (de la metadata o inferida del resumen) y cuál es posterior por fecha de expedición.
   d. **Aplicar la regla**:
      - **General posterior + especial anterior sin derogación expresa**: la especial sobrevive. **No deroga**. Es la regla invertida del art. 3 CC colombiano (a diferencia de España y otros sistemas, en Colombia la lex specialis derogat legi generali solo es la regla en sentido inverso, salvo derogación expresa de la general).
      - **Especial posterior + general anterior con incompatibilidad**: la especial posterior SÍ deroga a la general en el punto de contradicción (art. 3 CC: la preferencia de la especial incluye la derogación tácita en lo contradictorio, no solo complementariedad).
      - **Misma naturaleza con incompatibilidad**: la posterior deroga a la anterior en lo incompatible (art. 2 Ley 153/1887: "La ley posterior deroga tácitamente a la anterior, en todo o en parte, cuando sean incompatibles").
   e. **Alcance**: determinar si la derogación es total (toda la materia) o parcial (solo lo incompatible).
   f. **Si hay duda entre las reglas o la incompatibilidad es ambigua**: marcar para revisión humana en lugar de decidir automáticamente.

4. Si el LLM clasifica `deroga` o `modifica`, se setea un flag `posible_derogacion_implicita_por` en la norma vieja. El Paso 4 del RAG lo lee y lo reporta como advertencia al usuario, indicando la cadena lógica: qué tipo de derogación se detectó y por qué.

Costo: el pipeline de ingesta completo para la ley nueva más una ronda de LLM por cada candidata del top-k. Típicamente ~$0.50-1.00 por ley nueva. Las leyes de SUIN son ~50/mes → ~$25-50/mes en API. Se ejecuta en background sin intervención del usuario. Falsos positivos son aceptables (es solo una advertencia, no una derogación automática). Falsos negativos: el disclaimer de "última sync" los cubre parcialmente.

El SQL se prefiere sobre el vector search porque es determinista: si SUIN dice "derogada por Ley 2297", eso viene de un texto jurídico explícito. El vector search es probabilístico y puede confundir una mención casual con una derogación real. El vector solo se usa como safety net, no como fuente primaria de vigencia.

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

**Citation Grounding v2: verifica texto Y metadatos.**

Una cita en una respuesta jurídica puede referirse a dos cosas distintas:
- **El texto de la unidad citada** (ej. "el Artículo 5 establece que..."): se extrae del Índice 2 con `read_section(doc_id, inicio, fin)`.
- **Un metadato del documento** (ej. "el Decreto 1080 fue derogado por la Ley 2297"): se extrae del Índice 1 consultando `derogado_por`, `modificado_por`, `inexequible_por` en la base de datos.

El verificador determina de qué tipo es cada cita y valida contra la fuente correspondiente. Si la afirmación dice "fue derogada por X", no busca "derogada" en el texto del artículo — busca el flag `derogado_por` en el metadato. Esto cierra la grieta de poder afirmar correctamente algo que el Citation Grounding v1 (solo texto) rechazaba.

**Mecanismo de verificación:**

1. Para cada cita en la respuesta, se determina el tipo (texto vs metadato) según el `field` que cita: si la cita es `[Doc X, rango 1234-5678]` → texto; si es `[Doc X, derogado_por: 'Ley 2297']` → metadato.
2. Se extrae la fuente real: `read_section(doc_id, inicio, fin)` para texto, o `db.query(metadato)` para el flag.
3. Un LLM en **sub-sesión limpia** (mismo modelo, contexto nuevo sin el razonamiento previo del agente principal) recibe la afirmación y la fuente real, y determina si la afirmación se sostiene. La sub-sesión limpia evita el sesgo autoconfirmatorio del modelo que ya razonó la respuesta — no es un modelo distinto, es el mismo modelo sin memoria de su propio razonamiento anterior.
4. Si una cita no pasa la verificación, el agente principal recibe el flag y corrige (máximo 2 rondas).
5. Si tras 2 rondas una cita sigue sin pasar, se entrega con advertencia explícita: "Esta cita no pudo ser verificada mecánicamente contra la fuente."

**Decisión de implementación**: el verificador corre en el mismo proveedor y modelo que el agente principal, pero en una sub-sesión sin contexto. Esto elimina el sesgo autoconfirmatorio sin duplicar la complejidad operacional (1 sola API, 1 sola factura, 1 sola SDK).

##### Notas técnicas
- **Research informing this design**: el flujo de 7 pasos de Fase B incorpora evidencia de PAKTON (arXiv:2506.00608, EMNLP 2025) sobre chunking contextual y refinamiento iterativo, y de L-MARS (arXiv:2509.00761) sobre verificación por juez en el bucle. No implementamos ninguno como framework; extrajimos los principios y los integramos en nuestro RAG y en el verificador. Detalle en `AGENT_ROADMAP.md` y §11.3.
- **Reranker**: después de recuperar 20 unidades, un modelo cross-encoder (ej. BGE-Reranker) los reordena por pertinencia real. Con corpus de 100K+ documentos, los 20 resultados iniciales pueden incluir ruido; el reranker filtra eso. Costo estimado: ~$0.0001 por consulta.
- **Resúmenes con LLM**: se generan durante la ingesta inicial, estructurados por sección con proposiciones jurídicas clave y sus artículos. Son parte integral del Índice Documental desde el día uno.
- **Modelo de embeddings**: BGE-M3 (568M params, 1024 dims, dense + sparse nativo, 8192 tokens de contexto).
- **Hosting de embeddings** (decisión 2026-06-15, ver `HANDOFF.md` §Decisiones-de-embedding): **BGE-M3 corre local en el hardware del founder** (Acer Nitro V15, 4GB VRAM, ONNX fp16, ~50 chunks/seg, ~5.6 horas para ingesta inicial de 100k docs). Costo: $0. Forward-compat: la interface `OpenRouterClient.embeddings()` (`src/agent/llm/openrouter-client.ts:287`) queda como ruta alternativa para D5+ si el volumen lo justifica (self-host GPU cloud o HF Inference).
- **Base vectorial**: Qdrant local o cloud, con soporte para vectores densos y dispersos, filtros por payload y RRF (Reciprocal Rank Fusion).

##### Decisión de costo de ingesta inicial (100k docs legales institucionales)

Razón por la que se eligió este plan: los 100k documentos legales son **institucionales** (no de clientes), no hay restricción de compliance ni de secreto profesional.

| Fase | Modelo / método | Costo | Tiempo |
|---|---|---|---|
| Embeddings (1M chunks × 1200 tokens) | BGE-M3 local (ONNX fp16 en Nitro) | **$0** | ~5.6h bloqueadas |
| Resúmenes estructurados (0.6B in + 0.4B out) | `deepseek-v4-flash-free` vía OpenCode Zen, durante la ventana promocional | **$0** | 1-3h background |
| **Total ingesta inicial** | | **$0** | 1-3h + 5.6h |

**Trigger de migración** (registrado en `HANDOFF.md`): si OpenCode desactiva el tier free o la ingesta de resúmenes supera la ventana promocional, migrar a `deepseek-v4-flash` pagado ($0.14/M in, $0.28/M out, mismo modelo sin cláusula de entrenamiento) = **~$420 one-time** para la ingesta completa. Si el embedding local en Nitro se vuelve cuello de botella, migrar a self-host GPU cloud = ~$0.30 + 30 minutos para la misma ingesta.

**Costo por query RAG** (post-ingesta, 1 cliente activo, 50 queries/día):
- Embedding query (50 tokens): ~$0.000001 (BGE-M3 local, despreciable).
- Retrieval (pgvector local): $0.
- LLM generación (top-5 chunks = ~6k in + 800 out): **~$0.001** con `deepseek/deepseek-chat` (Tier 3 liviano, ya en `pricing-catalog.ts`).
- **Total por query: ~$0.001** (un décimo de centavo).
- **Proyección 10 clientes activos, 200 queries/día, 30 días**: ~$6/mes operativo total.

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

### 9.1 Arquitectura: 3 capas, 1 agente cara al usuario

**El usuario interactúa con un solo agente ("Worgena").** No elige entre múltiples agentes cara al usuario. Pero la implementación interna es una arquitectura de 3 capas, cada una con un rol distinto.

| Capa | Nombre | Quién la implementa | Cuándo corre |
|---|---|---|---|
| **1 — Workflow engine** | Ejecuta workflows ya definidos. Recorre el grafo, persiste estado, maneja transiciones, reintenta. | Código determinista en TypeScript | Mientras la tarea esté activa |
| **2 — Intake router** | Recibe input nuevo, decide QUÉ workflow instanciar y con qué parámetros. Clasifica + configura. | LLM liviano (DeepSeek Flash) | Una vez al recibir input |
| **3 — Specialist agents** | Ejecutan nodos específicos del workflow. Cada uno con prompt corto, tools acotadas, contexto limpio. | LLMs por nodo (liviano o robusto) | Cuando un nodo los requiere |

**Analogía del restaurante**: Capa 2 = el mesero (decide qué se pide y lo manda a la línea correcta), Capa 1 = la cocina con sus protocolos (sigue la receta paso a paso), Capa 3 = los cocineros especialistas (fogonero, salsero, parrillero).

El usuario ve un solo "Worgena" — la complejidad de las 3 capas es interna. Los specialists existen solo como parte de la ejecución de un workflow; no son persistentes ni visibles al usuario final.

**Workflows como el producto**: cada firma configura sus propios workflows sobre el motor común. Por eso el motor es propio (no LangGraph) y el DSL es versionable. Detalles completos en `AGENT_ROADMAP.md` §5.3, §5.4, §6.1.

### 9.2 Tool, Skill y Subagente: tres cosas distintas

| Concepto | Qué es | Tiene LLM propio |
|---|---|---|
| **Tool** | Función pura, sin razonamiento. Recibe input, devuelve output. | No |
| **Skill** | Paquete versionado de instrucciones + código + recursos. Cargado bajo demanda cuando la tarea lo requiere. | No |
| **Subagente** | Agente hijo con contexto limpio, hace su trabajo y reporta al padre. | Sí (liviano o robusto) |

Los specialists de Capa 3 son subagentes. Las topic-based policies son skills. Las funciones en `src/agent/tools.ts` son tools. Detalles en `AGENT_ROADMAP.md` §5.7.

### 9.3 Memoria: 4 tipos, no 1

| Tipo | Alcance | Persistencia |
|---|---|---|
| **Working** | Conversación actual, en el context window | En runtime, no se persiste |
| **Episodic** | Sesiones previas sobre el mismo caso | Por caso, recuperable por similitud |
| **Semantic** | Perfil de firma/cliente, preferencias | Por tenant, editable por usuario |
| **Procedural** | Cómo hace las cosas esta firma (templates, checklists) | Por tenant, editable, versionado |

Cada tipo tiene su propia infraestructura, política de retención y caso de uso. No se mezclan en una sola "memoria unificada". Detalles en `AGENT_ROADMAP.md` §5.1.

### 9.4 Preguntas abiertas sobre Agentes
- ~~¿Agente único o múltiples?~~ → 1 cara al usuario + 3 capas internas (engine, intake, specialists) ✅
- ~~¿Los agentes se comparten dentro de la firma?~~ → Las skills sí. El motor y los specialists los comparte el sistema.
- ~~¿Un espacio puede tener múltiples agentes?~~ → No aplica. Un agente cara al usuario, múltiples skills y workflows.
- ~~¿La memoria es unificada o fragmentada?~~ → **4 tipos separados**, no una sola memoria unificada ✅

### 9.5 Referencias

Detalles arquitectónicos completos en `AGENT_ROADMAP.md`:
- §5.1 Memoria 4 tipos
- §5.3 Arquitectura 3 capas
- §5.4 Custom DSL (no LangGraph)
- §5.5 Multi-model routing
- §5.6 Verificador en sub-sesión
- §5.7 Tool vs Skill vs Subagente

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

Motor que ejecuta los workflows de la firma cuando el agente los invoca. Es uno de los componentes del sistema agéntico (junto con memoria, herramientas, modelos). El usuario no interactúa con él directamente — interactúa con el agente Worgena, que usa workflows cuando la tarea lo requiere.

**Nota**: este §11 describe QUÉ hace el motor de workflows. El detalle arquitectónico (DSL, executor, primitivas no negociables, sprints) está en `AGENT_ROADMAP.md` §5 y §6. Acá se documenta la responsabilidad, los límites, y la investigación previa que informó las decisiones.

### 11.1 Responsabilidad del motor

- Ejecutar workflows registrados, uno por tarea activa.
- Recorrer el grafo de nodos, persistir el estado entre pasos.
- Manejar transiciones explícitas, reintentos con idempotencia, y pausa para HITL.
- Producir logs estructurados por nodo (para audit, observabilidad, debugging).
- Atribuir costo por Agent ID, Task ID, Tenant ID.
- Versionar el schema de workflows (migraciones al cargar workflows viejos).

### 11.2 Lo que el motor NO hace (fronteras explícitas)

Para evitar ambigüedad con el resto del sistema:

- **No clasifica el input ni decide qué workflow correr.** Eso es trabajo del Intake Router (Capa 2 de la arquitectura agéntica).
- **No ejecuta los pasos de cada nodo.** Eso es trabajo de los Specialist Agents (Capa 3).
- **No ingiere documentos ni hace retrieval.** Eso es trabajo de la Arquitectura Híbrida Integrada (§3.2).
- **No verifica la corrección sustantiva de las salidas.** Eso es trabajo del verificador en sub-sesión (ver §3.2 Paso 7 Citation Grounding v2 y `AGENT_ROADMAP.md` §5.6).

### 11.3 Investigación previa: PAKTON y L-MARS (referencia, no diseño)

Antes de diseñar el motor, estudiamos dos frameworks académicos sobre RAG multi-agente para legal. **No implementamos ninguno como framework**; extrajimos la evidencia válida y la integramos en el lugar correcto del sistema.

#### PAKTON (arXiv:2506.00608, EMNLP 2025)

Framework multi-agente para revisión de contratos largos con 3 agentes (Archivist, Interrogator, Researcher).

**Qué aprendimos y dónde aplicarlo**:

- **Chunking contextual** (ancestor-aware + descendant-aware) → integrado en §3.2 Fase A (chunking PAKTON con ancestor + sibling + predecessor).
- **Refinamiento iterativo** (el Interrogator genera follow-ups hasta estar seguro) → integrado en §3.2 Fase B (loop de 7 pasos con Pasos 1-5 de búsqueda y refinamiento).
- **3 agentes con loops separados** → NO aplicamos. Contradice nuestra decisión de 3 capas (engine / intake / specialists) que es arquitectónicamente distinta.
- **Código abierto:** github.com/petrosrapto/PAKTON

#### L-MARS (arXiv:2509.00761)

Sistema multi-agente para QA legal con búsqueda web agéntica.

**Qué aprendimos y dónde aplicarlo**:

- **Verification Agent como "juez en el bucle"** → integrado en §3.2 Paso 7 (Citation Grounding v2) y en `AGENT_ROADMAP.md` §5.6 (verificador en sub-sesión).
- **96% accuracy en LegalSearchQA** cuando se combina retrieval + verificación → confirma que la verificación es el diferenciador sobre zero-shot.
- **El retrieval no ayuda en razonamiento puro** (Bar Exam sin contexto actualizado) → el motor solo dispara retrieval cuando es necesario, no siempre.
- **Código abierto:** github.com/boqiny/L-MARS

#### Lo que NO tomamos de PAKTON ni L-MARS

- **Internal Quality Review** (LLM que se autocorrige en el mismo contexto): L-MARS lo proponía, nosotros lo **rechazamos** por sesgo confirmatorio. El LLM que ya razonó una respuesta, al revisarla en el mismo contexto, valida lo que dijo, no lo que la fuente dice. En su lugar usamos un **verificador en sub-sesión** sin acceso al contexto del productor.
- **3x llamadas por consulta**: ambos frameworks usan agentes con ReAct loops separados. Multiplica el costo y la latencia. Nuestro diseño mantiene el patrón producer/verifier (1 sesión productor + 1 sesión verificador) sin replicar loops completos.

### 11.4 Configuración por la firma

Los workflows son el producto: cada firma configura los suyos (en D6, post-MVP). Hoy Worgena viene con un set mínimo. El catálogo es versionable y editable — los workflows se guardan en DB, no en código, y se modifican sin redeploy. Detalles del DSL y de la UI de configuración en `AGENT_ROADMAP.md` §5.4 y §6.3.

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
| Chat con agente | ✅ Implementado | 1 cara al usuario + 3 capas internas (engine, intake, specialists) | ✅ |
| Lienzo Word/Excel | ✅ Implementado | OK | — |
| Lienzo HTML (dashboards) | ✅ Implementado | OK | — |
| Lienzo texto nativo | ❌ | Editor de bloques (ProseMirror/TipTap) | ✅ |
| Tabular Review | ✅ Batch básico | Workers paralelos, UI dedicada | — |
| Investigación web | ✅ DuckDuckGo + Apify | + scraping curado | — |
| Investigación interna | ✅ read_file | Arquitectura Híbrida Integrada | — |
| Memoria | ✅ 3 tiers | 4 tipos separados (working, episodic, semantic, procedural) | ✅ |
| Espacios | ✅ | Migrar a carpetas jerárquicas | ✅ |
| Bóvedas | ❌ | Colecciones de docs/artefactos asociadas a carpetas. Sync bajo demanda | ✅ |
| Conexiones externas | ❌ | 12 integraciones planeadas | — |
| Skills | ❌ | .md en DB, invocación dual (manual/auto) | ✅ |
| Workflows | ❌ | Motor propio con DSL, configurables por firma | — |
| Workflow Engine | ❌ | Motor propio, 3 capas, producer/verifier en sub-sesión, multi-model | ✅ |
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
