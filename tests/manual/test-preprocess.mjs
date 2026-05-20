import * as cheerio from "cheerio";

async function preprocessHtmlForDocx(html) {
  let exportHtml = html;
  exportHtml = exportHtml.replace(/<font([^>]*) face="([^"]+)"([^>]*)>/gi, '<span style="font-family: $2;"$1$3>');
  exportHtml = exportHtml.replace(/<font([^>]*) size="([^"]+)"([^>]*)>/gi, (match, prefix, size, suffix) => {
    const sizeMap = { '1': '10pt', '2': '11pt', '3': '12pt', '4': '14pt', '5': '18pt', '6': '24pt', '7': '36pt' };
    return `<span style="font-size: ${sizeMap[size] || '12pt'};"${prefix}${suffix}>`;
  });
  exportHtml = exportHtml.replace(/<font([^>]*) color="([^"]+)"([^>]*)>/gi, '<span style="color: $2;"$1$3>');
  exportHtml = exportHtml.replace(/<\/font>/gi, '</span>');
  exportHtml = exportHtml.replace(/<mark([^>]*)>/gi, '<span style="background-color: yellow;"$1>');
  exportHtml = exportHtml.replace(/<\/mark>/gi, '</span>');

  const $ = cheerio.load(exportHtml, { decodeEntities: false });

  $('*[style]').each((_, el) => {
    const style = $(el).attr('style');
    if (!style) return;
    
    const tagName = el.tagName ? el.tagName.toLowerCase() : '';
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

  const inlineTags = ['span', 'font', 'b', 'i', 'u', 's', 'strong', 'em', 'mark'];
  let listsReparented = true;
  while (listsReparented) {
    listsReparented = false;
    $('ul, ol').each((_, el) => {
      const parent = $(el).parent();
      if (parent.length && parent[0]) {
        const tagName = (parent[0].name || parent[0].tagName || '').toLowerCase();
        if (tagName && inlineTags.includes(tagName)) {
           parent.replaceWith(parent.contents());
           listsReparented = true;
        }
      }
    });
  }

  $('em').each((_, el) => { el.tagName = 'i'; });
  $('strong').each((_, el) => { el.tagName = 'b'; });

  const formatTags = ['b', 'i', 'u', 's', 'strike', 'del'];
  for (const tag of formatTags) {
    $(tag).prepend('&#8203;');
  }

  return $.html();
}

const inputHtml = `<span style="background-color: yellow;">Yellow background</span>
<span style="color: rgb(37, 99, 235);">RGB Blue text</span>
<font color="#2563eb">Hex font</font>
<span style="color: yellow;">yellow text</span>
<div style="background-color: #ffff00">div yellow bg</div>
<p style="background-color: rgb(255, 255, 0);">p rgb yellow bg</p>
<p style="background-color: yellow;">p yellow bg</p>`;

preprocessHtmlForDocx(inputHtml).then(console.log);
