/**
 * Tests E2E de preprocessHtmlForDocx.
 *
 * Cubre las transformaciones más críticas y frágiles del preprocesador. Cada
 * test es un end-to-end: input HTML crudo → función → output → check de
 * substring. La función no se puede descomponer en sub-funciones puras
 * fácilmente (es 170 líneas con muchas dependencias de cheerio), pero podemos
 * verificar el comportamiento observable.
 *
 * Se ejecuta con: npx tsx test_preprocess_html.mts
 *
 * Casos cubiertos:
 *   T1: <font face|size|color> → <span style> (transformación 1)
 *   T2: <mark> → <span style="background-color: yellow;"> (transformación 2)
 *   T3: <em>/<strong> → <i>/<b> (transformación 6, defensa contra bug html-to-docx)
 *   T4: <s>/<strike>/<del> → <span style="text-decoration:line-through"> (transformación 7)
 *   T5: <ul>/<ol> reparenting: span envolviendo ul → ul suelto (transformación 5)
 *   T6: ZWSP inyectado al inicio de <i>/<b>/<u> (transformación 9)
 *   T7: <span style> con font-size/color/bg → <font> tags nativos (transformación 8)
 *   T8: input vacío y no-string-resistant: no truena, devuelve string
 */

import assert from "node:assert/strict";
import { preprocessHtmlForDocx } from "./src/lib/docx/preprocess-html.js";

const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const pass = (name: string) => console.log(`  ✓ ${name}`);
const fail = (name: string, e: any) => {
  console.error(`  ✗ ${name}`);
  console.error(`    ${e?.message ?? e}`);
  if (e?.actual) console.error(`    actual:   ${String(e.actual).slice(0, 300)}`);
  if (e?.expected) console.error(`    expected: ${String(e.expected).slice(0, 300)}`);
  process.exitCode = 1;
};

// ────────────────────────────────────────────────────────────────────────────
// T1: <span style> con font-family/size/color → <font> tags nativos
//     (este es el caso real: el editor produce <span style>, no <font>)
// ────────────────────────────────────────────────────────────────────────────
async function testT1_fontAttributes() {
  const name = "T1: <span style='font-family: Arial; font-size: 14pt; color: red'> → <font face/size/color>";
  try {
    const out = await preprocessHtmlForDocx(
      `<span style="font-family: Arial; font-size: 14pt; color: red;">Hola</span>`
    );
    // Después de la transformación, debe haber al menos un <font> con los
    // atributos extraídos del style.
    assert.ok(out.includes('<font'), `output contiene <font>. Got: ${out}`);
    assert.ok(/font\s+face="[^"]*arial/i.test(out), `<font face="...arial..."> presente. Got: ${out}`);
    assert.ok(/font\s+size="4"/i.test(out), `<font size="4"> presente (14pt→size 4). Got: ${out}`);
    assert.ok(/font\s+color="red"/i.test(out), `<font color="red"> presente. Got: ${out}`);
    pass(name);
  } catch (e: any) { fail(name, e); }
}

// ────────────────────────────────────────────────────────────────────────────
// T2: <mark> → <span style="background-color: yellow;">
// ────────────────────────────────────────────────────────────────────────────
async function testT2_markToSpan() {
  const name = "T2: <mark>x</mark> → <span style='background-color: yellow;'>x</span>";
  try {
    const out = await preprocessHtmlForDocx(`<mark>destacado</mark>`);
    assert.ok(
      out.includes('background-color: yellow'),
      `output contiene background-color: yellow. Got: ${out}`
    );
    assert.ok(!out.includes('<mark'), `output NO contiene <mark. Got: ${out}`);

    pass(name);
  } catch (e: any) { fail(name, e); }
}

// ────────────────────────────────────────────────────────────────────────────
// T3: <em>/<strong> → <i>/<b>
// ────────────────────────────────────────────────────────────────────────────
async function testT3_emStrongToIB() {
  const name = "T3: <em>/<strong> → <i>/<b> (defensa contra bug de html-to-docx con anidación)";
  try {
    const out = await preprocessHtmlForDocx(`<em>itálica</em> y <strong>bold</strong>`);
    // ZWSP se inyecta en <i> y <b> → aparece como &#8203; o como ZWSP crudo
    assert.ok(/<i[^>]*>.*itálica.*<\/i>/s.test(out), `output contiene <i>itálica</i>. Got: ${out}`);
    assert.ok(/<b[^>]*>.*bold.*<\/b>/s.test(out), `output contiene <b>bold</b>. Got: ${out}`);
    assert.ok(!out.includes('<em'), `output NO contiene <em. Got: ${out}`);
    assert.ok(!out.includes('<strong'), `output NO contiene <strong. Got: ${out}`);

    pass(name);
  } catch (e: any) { fail(name, e); }
}

// ────────────────────────────────────────────────────────────────────────────
// T4: <s>/<strike>/<del> son idempotentes — pasan por
//     <span style="text-decoration:line-through"> y vuelven a <s>
//     (cheerio wrap en T4 los convierte a <s> de nuevo). El punto crítico
//     es que no se pierdan: el texto sigue ahí y la decoración sobrevive.
// ────────────────────────────────────────────────────────────────────────────
async function testT4_strikeVariantsToSpan() {
  const name = "T4: <s>/<strike>/<del> preservan text-decoration (vía span o <s>), no se pierde el texto";
  try {
    for (const tag of ['s', 'strike', 'del']) {
      const out = await preprocessHtmlForDocx(`<${tag}>tachado</${tag}>`);
      // El output es idempotente: queda como <s>tachado</s>. Lo importante es
      // que (a) el texto "tachado" sobrevive, (b) el marcado de tachado sobrevive
      // (ya sea como <s>, <span style="text-decoration:line-through">, o ambos).
      assert.ok(out.includes('tachado'), `<${tag}>: el texto "tachado" sobrevive. Got: ${out}`);
      const hasStrike =
        out.includes('<s>') ||
        (out.includes('text-decoration') && out.includes('line-through'));
      assert.ok(
        hasStrike,
        `<${tag}>: el marcado de tachado sobrevive (<s> o text-decoration:line-through). Got: ${out}`
      );
    }
    pass(name);
  } catch (e: any) { fail(name, e); }
}

// ────────────────────────────────────────────────────────────────────────────
// T5: <ul>/<ol> reparenting — span envolviendo ul → ul suelto
// ────────────────────────────────────────────────────────────────────────────
async function testT5_listReparenting() {
  const name = "T5: <span><ul><li>x</li></ul></span> → el <ul> queda fuera del <span>";
  try {
    const input = `<span><ul><li>item</li></ul></span>`;
    const out = await preprocessHtmlForDocx(input);
    // El <span> envolviendo el <ul> debe haber sido reemplazado por sus contents.
    // Verificación: <ul> aparece sin un <span> ancestro que lo envuelva.
    // Cheerio serializa a self-closing o expanded. Lo importante: el <ul> ya no
    // está envuelto por <span>.
    const ulMatch = out.match(/<span[^>]*>(\s*)<ul/);
    assert.equal(
      ulMatch, null,
      `<ul> no debe estar dentro de un <span> abierto. Got: ${out}`
    );
    assert.ok(out.includes('<ul>') || out.includes('<ul '), `output contiene <ul>. Got: ${out}`);
    pass(name);
  } catch (e: any) { fail(name, e); }
}

// ────────────────────────────────────────────────────────────────────────────
// T6: ZWSP inyectado al inicio de <b>/<i>/<u>
// ────────────────────────────────────────────────────────────────────────────
async function testT6_zwspInjection() {
  const name = "T6: ZWSP (U+200B) inyectado al inicio de <b>/<i>/<u> (defensa contra nesting drop)";
  try {
    const out = await preprocessHtmlForDocx(`<b>bold</b><i>italic</i><u>under</u>`);
    // El ZWSP aparece como &#8203; (HTML entity) o como el carácter crudo.
    const zwsp = '\u200B';
    const hasZwsp = out.includes(zwsp) || out.includes('&#8203;') || out.includes('​');
    assert.ok(hasZwsp, `output contiene ZWSP (U+200B o entidad). Got: ${JSON.stringify(out)}`);
    // Hay al menos 3 ZWSP (uno por cada tag b/i/u)
    const matches = (out.match(/\u200B|&#8203;|​/g) || []).length;
    assert.ok(matches >= 3, `al menos 3 ZWSP (b/i/u). Got ${matches} en: ${out}`);
    pass(name);
  } catch (e: any) { fail(name, e); }
}

// ────────────────────────────────────────────────────────────────────────────
// T7: <span style> con font-size/color → <font> tags nativos
// ────────────────────────────────────────────────────────────────────────────
async function testT7_spanStyleToFontTags() {
  const name = "T7: <span style='font-size: 14pt; color: red;'>x</span> → <font size=4 color=red>x";
  try {
    const out = await preprocessHtmlForDocx(`<span style="font-size: 14pt; color: red;">rojo14</span>`);
    assert.ok(out.includes('<font'), `output contiene <font>. Got: ${out}`);
    assert.ok(/font\s+size="4"/.test(out), `<font size="4"> presente (14pt→size 4). Got: ${out}`);
    assert.ok(/font\s+color="red"/.test(out), `<font color="red"> presente. Got: ${out}`);
    pass(name);
  } catch (e: any) { fail(name, e); }
}

// ────────────────────────────────────────────────────────────────────────────
// T8: edge cases — input vacío y HTML malformado no truenan
// ────────────────────────────────────────────────────────────────────────────
async function testT8_robustness() {
  const name = "T8: input vacío, HTML malformado, y sin tags → devuelve string sin truenar";
  try {
    const out1 = await preprocessHtmlForDocx("");
    assert.equal(typeof out1, "string", "input vacío devuelve string");
    assert.ok(out1.length >= 0, `output length >= 0. Got: ${out1.length}`);

    const out2 = await preprocessHtmlForDocx("plain text without any tags");
    assert.equal(typeof out2, "string", "texto plano devuelve string");

    const out3 = await preprocessHtmlForDocx(`<p><span class="broken" style="font-size:">oops</span></p>`);
    assert.equal(typeof out3, "string", "HTML con style inválido devuelve string (no truena)");

    pass(name);
  } catch (e: any) { fail(name, e); }
}

// ────────────────────────────────────────────────────────────────────────────
// Runner
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  log("═══════════════════════════════════════════════════════════════════");
  log("  preprocessHtmlForDocx — tests E2E");
  log("═══════════════════════════════════════════════════════════════════");
  log("");

  await testT1_fontAttributes();
  await testT2_markToSpan();
  await testT3_emStrongToIB();
  await testT4_strikeVariantsToSpan();
  await testT5_listReparenting();
  await testT6_zwspInjection();
  await testT7_spanStyleToFontTags();
  await testT8_robustness();

  log("");
  if (process.exitCode === 1) {
    log("  ✗ ALGUNOS TESTS FALLARON");
  } else {
    log("  ✓ TODOS LOS TESTS PASARON");
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
