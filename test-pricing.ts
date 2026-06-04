import dotenv from "dotenv";
dotenv.config();

import fs from "fs/promises";
import path from "path";
import mammoth from "mammoth";
import PDFParser from "pdf2json";

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
if (!DEEPSEEK_KEY) { console.error("Missing DEEPSEEK_API_KEY"); process.exit(1); }

const DOCS_DIR = "recursos/documentos";
const API_URL = "https://api.deepseek.com/v1/chat/completions";
const PRICE_IN = 0.112 / 1_000_000;
const PRICE_OUT = 0.224 / 1_000_000;

let totalPrompt = 0, totalComp = 0, totalCost = 0;

async function call(messages: any[], label: string) {
  const t0 = Date.now();
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${DEEPSEEK_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v4-flash", messages, temperature: 0, response_format: { type: "json_object" }, max_tokens: 2000 }),
  });
  const json = await res.json();
  const ms = Date.now() - t0;
  if (json.error) { console.error(`  ${label} ERROR: ${json.error.message}`); return null; }
  const u = json.usage || {};
  totalPrompt += u.prompt_tokens || 0;
  totalComp += u.completion_tokens || 0;
  const cost = (u.prompt_tokens||0)*PRICE_IN + (u.completion_tokens||0)*PRICE_OUT;
  totalCost += cost;
  
  const content = json.choices?.[0]?.message?.content || "{}";
  let parsed: any = {};
  try { parsed = JSON.parse(content); } catch { parsed = { raw: content.slice(0, 200) }; }
  
  console.log(`  ${label} | ${ms}ms | in:${u.prompt_tokens||0} out:${u.completion_tokens||0} | $${cost.toFixed(5)}`);
  return parsed;
}

async function readRealText(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  
  if (ext === ".pdf") {
    return new Promise((resolve, reject) => {
      const p = new PDFParser(null, 1);
      p.on("pdfParser_dataReady", () => {
        const text = p.getRawTextContent().replace(/\s+/g, " ").trim();
        resolve(text.slice(0, 30000));
      });
      p.on("pdfParser_dataError", (e: any) => reject(e));
      p.parseBuffer(buf);
    });
  }
  
  if (ext === ".docx") {
    const r = await mammoth.extractRawText({ buffer: buf });
    return r.value.replace(/\s+/g, " ").trim().slice(0, 30000);
  }
  
  return buf.toString("utf-8").replace(/\s+/g, " ").trim().slice(0, 30000);
}

async function main() {
  const allFiles = (await fs.readdir(DOCS_DIR))
    .filter(f => /\.(pdf|docx)$/i.test(f))
    .slice(0, 20);
  
  console.log(`\nAuditoría con ${allFiles.length} docs (PDF + DOCX) usando extracción real\n`);
  
  // ──── TEST 1: Sueltas (solo 5 docs para referencia) ────
  console.log("═══ TEST 1: Consultas sueltas (5 docs) ═══");
  console.log("Columna: ¿La sentencia protege el medio ambiente? Sí/No");
  
  const sample = allFiles.slice(0, 5);
  for (const f of sample) {
    const text = await readRealText(path.join(DOCS_DIR, f));
    await call([
      { role: "system", content: 'Eres un analista legal. Responde SOLO en JSON: {"protege_ambiente":"Sí"|"No","cita_frase":"..."}' },
      { role: "user", content: `DOCUMENTO: ${f}\n\n${text}\n\nPREGUNTA: ¿Esta sentencia protege el medio ambiente?` }
    ], f.slice(0, 50));
  }
  
  const sIn = totalPrompt, sOut = totalComp, sCost = totalCost;
  console.log(`\n  ▶ Sueltas 5 docs: in:${sIn} out:${sOut} | $${sCost.toFixed(5)}\n`);
  
  // Reset
  totalPrompt = 0; totalComp = 0; totalCost = 0;
  
  // ──── TEST 2: Tabular Review real (10 docs en batch, 4 columnas) ────
  console.log("═══ TEST 2: Tabular Review (10 docs, 4 columnas) ═══");
  
  const batchDocs = allFiles.slice(0, 10);
  const docsText: string[] = [];
  for (const f of batchDocs) {
    docsText.push(await readRealText(path.join(DOCS_DIR, f)));
  }
  
  const block = batchDocs.map((f, i) =>
    `[DOC ${i+1}: ${f}]\n${docsText[i]}`
  ).join("\n===\n");
  
  const result = await call([
    { role: "system", content: `Eres un analizador masivo de sentencias judiciales. Extrae de cada documento:\n- protege_ambiente: ¿La decisión protege el medio ambiente? ("Sí"/"No")\n- tribunal: ¿Qué tribunal la emitió? (nombre)\n- año: Año de la sentencia (número)\n- derecho_vulnerado: ¿Qué derecho se alega como vulnerado?\n\nResponde SOLO en JSON: [{"doc":"...","protege_ambiente":"...","tribunal":"...","año":...,"derecho_vulnerado":"..."}]` },
    { role: "user", content: block }
  ], `LOTE (${batchDocs.length} docs)`);
  
  const bIn = totalPrompt, bOut = totalComp, bCost = totalCost;
  
  // Show actual answers
  if (Array.isArray(result)) {
    console.log(`\n  ── Muestra de respuestas reales ──`);
    for (const r of result.slice(0, 5)) {
      console.log(`  ${r.doc?.slice(0,30)}... | ${r.protege_ambiente} | ${r.tribunal} | ${r.año}`);
    }
  }
  
  console.log(`\n  ▶ Batch 10 docs: in:${bIn} out:${bOut} | $${bCost.toFixed(5)}`);
  
  // ──── RESUMEN ────
  console.log(`\n══════════════════════════════════════════`);
  console.log(`RESUMEN`);
  console.log(`══════════════════════════════════════════`);
  console.log(`Modelo: deepseek-v4-flash`);
  console.log(`Precio: $${PRICE_IN}/tk in | $${PRICE_OUT}/tk out`);
  console.log(`Docs totales: ${allFiles.length}`);
  console.log(`──────────────────────────────────────────`);
  console.log(`Sueltas 5 docs : in:${sIn} out:${sOut} | $${sCost.toFixed(5)} | ~${(sCost/5*1000).toFixed(2)}/1000docs`);
  console.log(`Batch 10 docs  : in:${bIn} out:${bOut} | $${bCost.toFixed(5)} | ~${(bCost/10*1000).toFixed(2)}/1000docs`);
  console.log(`──────────────────────────────────────────`);
  console.log(`Por documento (promedio): $${((sCost/5 + bCost/10)/2).toFixed(6)}`);
  console.log(`Proyección 1,000 docs: $${((sCost/5 + bCost/10)/2 * 1000).toFixed(2)}`);
  console.log(`Proyección 100,000 docs: $${((sCost/5 + bCost/10)/2 * 100000).toFixed(0)}`);
  console.log(`══════════════════════════════════════════`);
}

main().catch(e => console.error("FATAL:", e));
