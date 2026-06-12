/**
 * preprocess-html.ts
 * -----------------------------------------------------------------------------
 * Preprocesador de HTML para exportación a DOCX.
 *
 * Transforma HTML producido por el editor visual (Jodit/Quill) en HTML
 * compatible con `html-to-docx`, que es muy estricto con formatos legacy
 * (font, mark, em/strong, etc.) y con la anidación de listas/inline tags.
 *
 * Transformaciones aplicadas, en orden:
 *   1.  `<font face|size|color>` → `<span style="font-family|font-size|color">`
 *       y `</font>` → `</span>`.
 *   2.  `<mark>` → `<span style="background-color: yellow">`.
 *   3.  Reescala `font-size` semánticos (xx-small, small, etc.) a pt exactos.
 *   4.  Para elementos block con style, envuelve su contenido en `<i>/<b>/<u>/<s>`
 *       si la style los declara. Para inline, los envuelve (wrap) en esos tags.
 *   5.  Saca `<ul>/<ol>` fuera de cualquier inline tag (span, font, b, i, u, etc.)
 *       que los estuviera envolviendo (fix para listas que desaparecen tras
 *       execCommand del navegador).
 *   6.  Convierte `<em>` → `<i>` y `<strong>` → `<b>` (defensa contra un bug
 *       conocido de html-to-docx con anidación).
 *   7.  Convierte `<s>/<strike>/<del>` a `<span style="text-decoration:line-through">`
 *       para no depender de un node_modules parcheado.
 *   8.  Para cada `<span style>`, extrae font-family / font-size / color /
 *       background-color / text-decoration y los convierte a tags `<font>`
 *       nativos que html-to-docx entiende. Elimina esas props del style
 *       resultante y deja las no manejadas intactas.
 *   9.  Inyecta ZWSP (U+200B) al inicio de cada `<b>/<i>/<u>` para evitar un
 *       bug de html-to-docx donde se cae la anidación de formatos.
 *  10.  Decodifica `&quot;` → `"` dentro de atributos `style` que cheerio
 *       re-encodifica al serializar.
 *
 * Función pura: no toca DB, filesystem, ni estado global. La única dependencia
 * externa es `cheerio` (import dinámico para no inflar el bundle del server).
 *
 * Exportado por separado del server.ts para:
 *   - Hacerse testeable de forma aislada (ver `test_preprocess_html.mts`).
 *   - Permitir su reutilización desde otros puntos de exportación (futuro
 *     export desde el chat agent, etc.).
 *   - Reducir la superficie del server.ts (33KB → menos después del split).
 */

/**
 * Aplica las 10 transformaciones descritas en el JSDoc del módulo.
 *
 * @param html HTML crudo tal como sale del editor.
 * @returns HTML compatible con html-to-docx.
 */
export async function preprocessHtmlForDocx(html: string): Promise<string> {
  let exportHtml = html;
  exportHtml = exportHtml.replace(/<font([^>]*) face="([^"]+)"([^>]*)>/gi, '<span style="font-family: $2;"$1$3>');
  exportHtml = exportHtml.replace(/<font([^>]*) size="([^"]+)"([^>]*)>/gi, (match, prefix, size, suffix) => {
    const sizeMap: Record<string, string> = { '1': '10pt', '2': '11pt', '3': '12pt', '4': '14pt', '5': '18pt', '6': '24pt', '7': '36pt' };
    return `<span style="font-size: ${sizeMap[size] || '12pt'};"${prefix}${suffix}>`;
  });
  exportHtml = exportHtml.replace(/<font([^>]*) color="([^"]+)"([^>]*)>/gi, '<span style="color: $2;"$1$3>');
  exportHtml = exportHtml.replace(/<\/font>/gi, '</span>');
  exportHtml = exportHtml.replace(/<mark([^>]*)>/gi, '<span style="background-color: yellow;"$1>');
  exportHtml = exportHtml.replace(/<\/mark>/gi, '</span>');

  const cheerio = await import("cheerio");
  const $ = cheerio.load(exportHtml, { decodeEntities: false });

  // Fix generic font sizes inside style attributes (e.g., styleWithCSS browser output)
  $('*[style]').each((_, el) => {
    let style = $(el).attr('style');
    if (!style) return;

    // Map browser semantic font sizes to exact pt values so html-to-docx parses them correctly
    const sizeMap = {
       'xx-small': '8pt',
       'x-small': '10pt',
       'small': '11pt',
       'medium': '12pt',
       'large': '14pt',
       'x-large': '18pt',
       'xx-large': '24pt',
       // standard sizes mapping matching Jodit dropdown if generated
       '1': '10pt', '2': '11pt', '3': '12pt', '4': '14pt', '5': '18pt', '6': '24pt', '7': '36pt'
    };

    let updatedStyle = style.replace(/font-size:\s*([^;]+);?/gi, (match, sizeValue) => {
       const cleanSize = sizeValue.trim().toLowerCase();
       if (sizeMap[cleanSize]) {
          return `font-size: ${sizeMap[cleanSize]};`;
       }
       return match;
    });

    if (updatedStyle !== style) {
       $(el).attr('style', updatedStyle);
       style = updatedStyle;
    }

    const tagName = (el as any).tagName ? (el as any).tagName.toLowerCase() : '';
    const isBlock = ['p', 'div', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'tbody', 'tr', 'td', 'th'].includes(tagName);

    if (isBlock) {
      if (/italic/i.test(style)) { $(el).html(`<i>${$(el).html()}</i>`); }
      if (/underline/i.test(style)) { $(el).html(`<u>${$(el).html()}</u>`); }
      if (/line-through/i.test(style)) { $(el).html(`<s>${$(el).html()}</s>`); }
      if (/(700|800|900|bold)/i.test(style)) { $(el).html(`<b>${$(el).html()}</b>`); }
    } else {
      if (/italic/i.test(style) && tagName !== 'i' && tagName !== 'em') { $(el).wrap('<i></i>'); }
      if (/underline/i.test(style) && tagName !== 'u') { $(el).wrap('<u></u>'); }
      if (/line-through/i.test(style) && tagName !== 's' && tagName !== 'strike') { $(el).wrap('<s></s>'); }
      if (/(700|800|900|bold)/i.test(style) && tagName !== 'b' && tagName !== 'strong') { $(el).wrap('<b></b>'); }
    }
  });

  // Pull ul/ol out of any inline tags like span, font, b, i, etc.
  // This solves lists disappearing or not rendering bullets when wrapped by browser's execCommand
  const inlineTags = ['span', 'font', 'b', 'i', 'u', 's', 'strong', 'em', 'mark'];
  let listsReparented = true;
  while (listsReparented) {
    listsReparented = false;
    $('ul, ol').each((_, el) => {
      const parent = $(el).parent();
      if (parent.length && parent[0]) {
        const tagName = ((parent[0] as any).name || (parent[0] as any).tagName || '').toLowerCase();
        if (tagName && inlineTags.includes(tagName)) {
           parent.replaceWith(parent.contents());
           listsReparented = true;
        }
      }
    });
  }

  // Convert em/strong to i/b as html-to-docx sometimes fails on em/strong depending on nesting
  $('em').each((_, el) => { (el as any).tagName = 'i'; });
  $('strong').each((_, el) => { (el as any).tagName = 'b'; });

  // Convert <s>, <strike>, <del> to <span style="text-decoration:line-through">
  // so html-to-docx handles them without requiring patched node_modules.
  $('s, strike, del').each((_, el) => {
    const $el = $(el);
    const existingStyle = $el.attr('style') || '';
    const mergedStyle = existingStyle ? `${existingStyle}; text-decoration: line-through` : 'text-decoration: line-through';
    $el.replaceWith($(`<span style="${mergedStyle}">${$el.html()}</span>`));
  });

  // Convert CSS font/size/color spans to <font> tags that html-to-docx understands natively.
  // Done inside cheerio DOM to handle nesting correctly (no regex on raw HTML).
  const SIZE_TO_HTML: Record<string, string> = {
    '8pt': '1', '10pt': '2', '11pt': '2', '12pt': '3', '14pt': '4',
    '16pt': '4', '18pt': '5', '20pt': '5', '22pt': '6', '24pt': '6',
    '28pt': '7', '36pt': '7'
  };

  $('span[style]').each((_, el) => {
    const $el = $(el);
    const style = ($el.attr('style') || '').toLowerCase().replace(/&quot;/g, '"');
    if (!style) return;

    // Extract font-family
    const ffMatch = style.match(/font-family:\s*([^;"]+)/i);
    // Extract font-size
    const fsMatch = style.match(/font-size:\s*(\d+pt)/i);
    // Extract text color
    const colorMatch = style.match(/(?:^|[^-])color:\s*([^;]+)/i);
    // Extract background-color
    const bgMatch = style.match(/background-color:\s*([^;]+)/i);
    // Extract text-decoration
    const tdMatch = style.match(/text-decoration:\s*line-through/i);

    let innerContent = $el.html() || '';

    if (ffMatch) {
      innerContent = `<font face="${ffMatch[1].trim()}">${innerContent}</font>`;
    }
    if (fsMatch && SIZE_TO_HTML[fsMatch[1]]) {
      innerContent = `<font size="${SIZE_TO_HTML[fsMatch[1]]}">${innerContent}</font>`;
    }
    if (colorMatch) {
      innerContent = `<font color="${colorMatch[1].trim()}">${innerContent}</font>`;
    }
    if (bgMatch) {
      innerContent = `<font style="background-color: ${bgMatch[1].trim()};">${innerContent}</font>`;
    }

    // Build remaining style (anything not handled above)
    let remaining = style
      .replace(/font-family:\s*[^;]+;?/gi, '')
      .replace(/font-size:\s*\d+pt;?/gi, '')
      .replace(/(?:^|[^-])color:\s*[^;]+;?/gi, '')
      .replace(/background-color:\s*[^;]+;?/gi, '')
      .replace(/text-decoration:\s*line-through;?/gi, '')
      .replace(/&quot;/g, '')
      .replace(/;{2,}/g, ';')
      .replace(/^\s*;\s*/, '')
      .replace(/;\s*$/, '')
      .trim();

    if (tdMatch) {
      innerContent = `<s>${innerContent}</s>`;
    }

    if (remaining) {
      $el.attr('style', remaining);
      $el.html(innerContent);
    } else {
      $el.replaceWith($(innerContent));
    }
  });

  // Inject ZWSP to prevent html-to-docx nesting drop bug
  const formatTags = ['b', 'i', 'u'];
  for (const tag of formatTags) {
    $(tag).prepend('&#8203;');
  }

  let resultHtml = $.html();

  // Fix cheerio re-encoding: decode &quot; back to " inside style attributes
  resultHtml = resultHtml.replace(/style="([^"]*&quot;[^"]*)"/g, (_, content) => {
    return `style="${content.replace(/&quot;/g, '"')}"`;
  });

  return resultHtml;
}
