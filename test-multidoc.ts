import dotenv from "dotenv";
dotenv.config();

import fs from "fs/promises";
import path from "path";
import mammoth from "mammoth";
import PDFParser from "pdf2json";

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const DOCS_DIR = "recursos/documentos";
const API_URL = "https://api.deepseek.com/v1/chat/completions";
const PRICE_IN = 0.112 / 1_000_000;
const PRICE_OUT = 0.224 / 1_000_000;

async function call(messages: any[], label: string) {
  const t0 = Date.now();
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${DEEPSEEK_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v4-flash", messages, temperature: 0, max_tokens: 3000 }),
  });
  const json = await res.json();
  const ms = Date.now() - t0;
  const u = json.usage || {};
  const cost = (u.prompt_tokens||0)*PRICE_IN + (u.completion_tokens||0)*PRICE_OUT;
  return {
    label, ms,
    in: u.prompt_tokens||0, out: u.completion_tokens||0,
    cost,
    content: json.choices?.[0]?.message?.content || ""
  };
}

async function readRealText(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf") {
    return new Promise((resolve, reject) => {
      const p = new PDFParser(null, 1);
      p.on("pdfParser_dataReady", () => resolve(p.getRawTextContent().replace(/\s+/g, " ").trim().slice(0, 30000)));
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
    .slice(0, 10);

  console.log(`\n═══ TEST 3: Consulta libre sobre MÚLTIPLES documentos ═══`);
  console.log(`10 documentos. Pregunta: "¿Qué sentencias mencionan comunidad indígena o pueblo étnico? Extrae la cita textual."\n`);

  const docs: { file: string; text: string }[] = [];
  for (const f of allFiles) {
    docs.push({ file: f, text: await readRealText(path.join(DOCS_DIR, f)) });
  }

  const block = docs.map((d, i) =>
    `[DOC ${i+1}: ${d.file}]\n${d.text}`
  ).join("\n===\n");

  const r = await call([
    { role: "system", content: "Eres un investigador legal que analiza múltiples documentos. Para cada documento que mencione comunidades indígenas, pueblos étnicos, o derechos de minorías, extrae la cita textual exacta. Si no menciona nada, omítelo. Responde en formato:\n\nDOC: nombre_del_archivo\nCITA: \"texto exacto de la sentencia\"\n---" },
    { role: "user", content: `${block}\n\nPREGUNTA: ¿Qué sentencias mencionan comunidades indígenas o pueblos étnicos? Extrae la cita textual.` }
  ], "LOTE (10 docs, consulta libre)");

  const pricePerDoc = (r.cost / docs.length).toFixed(6);
  
  console.log(`  ═══════════════════════════════════════`);
  console.log(`  ${r.label} | ${r.ms}ms | in:${r.in} out:${r.out} | $${r.cost.toFixed(5)}`);
  console.log(`  ${docs.length} docs | $${pricePerDoc}/doc`);
  console.log(`  ═══════════════════════════════════════`);
  console.log(`\n  ── Respuesta del modelo ──`);
  
  // Show first 1500 chars of response
  const resp = r.content.replace(/\n/g, "\n  ");
  console.log(`  ${resp.slice(0, 2000)}${resp.length > 2000 ? "\n  ...[truncado]" : ""}`);

  console.log(`\n──────────────────────────────────────────`);
  console.log(`RESUMEN COMPARATIVO`);
  console.log(`──────────────────────────────────────────`);
  console.log(`Modelo: deepseek-v4-flash`);
  console.log(`Precio: $${PRICE_IN}/tk in | $${PRICE_OUT}/tk out`);
  console.log(`──────────────────────────────────────────`);
  console.log(`Consulta libre 10 docs: in:${r.in} out:${r.out} | $${r.cost.toFixed(5)} | $${pricePerDoc}/doc`);
  console.log(`──────────────────────────────────────────`);
  console.log(`Proyección 100 docs:  $${(r.cost/10*100).toFixed(3)}`);
  console.log(`Proyección 1000 docs: $${(r.cost/10*1000).toFixed(2)}`);
  console.log(`──────────────────────────────────────────`);
}

main().catch(e => console.error("FATAL:", e));
