import fs from "fs/promises";
import path from "path";
import PDFParser from "pdf2json";
import mammoth from "mammoth";
import * as xlsxLib from "xlsx";

const CONCURRENCY = 8; // parallel LLM calls
const BATCH_SIZE = 15; // docs per LLM call

export interface ColumnPrompt {
  label: string;        // column header
  question: string;     // what to ask the LLM for each doc
  format: "yesno" | "text" | "number" | "date";
}

export interface BatchResult {
  columns: ColumnPrompt[];
  rows: Record<string, string>[];  // { filename, col1, col2, ... }
  totalDocs: number;
  totalBatches: number;
  durationMs: number;
}

async function readDocumentText(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  const buffer = await fs.readFile(filePath);

  if (ext === ".pdf") {
    return new Promise((resolve, reject) => {
      const parser = new PDFParser(null, 1 as any);
      parser.on("pdfParser_dataReady", () => resolve(parser.getRawTextContent()));
      parser.on("pdfParser_dataError", (err: any) => reject(err));
      parser.parseBuffer(buffer as any);
    });
  }

  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (ext === ".xlsx" || ext === ".xls" || ext === ".csv") {
    const wb = xlsxLib.read(buffer, { type: "buffer" });
    let text = "";
    for (const name of wb.SheetNames) {
      text += `Sheet: ${name}\n${xlsxLib.utils.sheet_to_csv(wb.Sheets[name])}\n`;
    }
    return text;
  }

  return buffer.toString("utf-8");
}

async function processBatch(
  openai: any,
  batch: { filename: string; content: string }[],
  columns: ColumnPrompt[]
): Promise<Record<string, string>[]> {
  const docsBlock = batch.map((d, i) =>
    `[DOC ${i + 1}: ${d.filename}]\n${d.content}\n`
  ).join("---\n");

  const columnsBlock = columns.map((c, i) =>
    `COLUMN ${i + 1}: "${c.label}" → ${c.question} (format: ${c.format})`
  ).join("\n");

  const response = await openai.chat.completions.create({
    model: "deepseek-v4-flash",
    temperature: 0,
    messages: [{
      role: "system",
      content: `You are a document analysis engine. You extract structured information from legal/business documents.\n\nFor each document below, answer EVERY column question.\nRespond ONLY in JSON format: [{ "filename": "...", "answers": { "column_label": "answer" } }, ...]\n\nIMPORTANT:\n- For Yes/No questions: answer ONLY "Sí" or "No".\n- For numbers: answer ONLY the number (e.g. "5000000").\n- For dates: use YYYY-MM-DD format.\n- If not found: answer "N/A".\n- Do NOT explain, do NOT add commentary.`
    }, {
      role: "user",
      content: `=== COLUMNS ===\n${columnsBlock}\n\n=== DOCUMENTS ===\n${docsBlock}\n\nExtract data for all documents. Return JSON.`
    }],
    response_format: { type: "json_object" },
    max_tokens: 4000,
  });

  const text = response.choices[0].message.content || "{}";
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Try to extract from code block
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    parsed = match ? JSON.parse(match[1]) : {};
  }

  const items = Array.isArray(parsed) ? parsed : (parsed.results || parsed.data || []);
  
  return items.map((item: any) => {
    const row: Record<string, string> = { filename: item.filename || "unknown" };
    if (item.answers) {
      for (const col of columns) {
        row[col.label] = item.answers[col.label] || "N/A";
      }
    }
    return row;
  });
}

async function processWithConcurrency<T>(
  items: T[],
  fn: (item: T) => Promise<any>,
  concurrency: number
): Promise<any[]> {
  const results: any[] = [];
  const queue = [...items];
  
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()!;
      const result = await fn(item);
      results.push(...result);
    }
  });

  await Promise.all(workers);
  return results;
}

export async function batchReviewDocuments(
  spaceId: string,
  columns: ColumnPrompt[],
  openai: any
): Promise<BatchResult> {
  const startTime = Date.now();
  const dir = path.join(process.cwd(), "workspace", "spaces", spaceId);
  
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    // Fallback: try session workspace
    const sessDir = path.join(process.cwd(), "workspace", spaceId);
    entries = await fs.readdir(sessDir);
  }

  const validExts = [".pdf", ".docx", ".txt", ".xlsx", ".xls", ".csv", ".doc", ".rtf"];
  const files = entries.filter(f => validExts.some(ext => f.toLowerCase().endsWith(ext)));

  // Read all documents
  const docs: { filename: string; content: string }[] = [];
  for (const f of files) {
    try {
      const content = await readDocumentText(path.join(dir, f));
      if (content.trim()) docs.push({ filename: f, content });
    } catch { /* skip unreadable files */ }
  }

  if (docs.length === 0) throw new Error("No readable documents found in workspace");

  // Create batches
  const batches: { filename: string; content: string }[][] = [];
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    batches.push(docs.slice(i, i + BATCH_SIZE));
  }

  // Process in parallel
  const rows = await processWithConcurrency(
    batches,
    (batch) => processBatch(openai, batch, columns),
    CONCURRENCY
  );

  return {
    columns,
    rows: rows.flat(),
    totalDocs: docs.length,
    totalBatches: batches.length,
    durationMs: Date.now() - startTime,
  };
}

export function generateDashboardHtml(result: BatchResult): string {
  const headers = `<tr><th>Documento</th>${result.columns.map(c => `<th>${c.label}</th>`).join("")}</tr>`;
  const body = result.rows.map(r =>
    `<tr><td class="doc-name">${r.filename || ""}</td>${result.columns.map(c =>
      `<td class="cell-${c.format}">${r[c.label] || "N/A"}</td>`
    ).join("")}</tr>`
  ).join("");

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Tabular Review</title>
<style>
  body{font-family:system-ui,sans-serif;padding:20px;background:#f5f5f5}
  h1{font-size:20px;margin-bottom:5px}
  .meta{color:#666;font-size:12px;margin-bottom:20px}
  table{border-collapse:collapse;width:100%;background:white;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)}
  th{background:#1a1a2e;color:white;padding:10px 12px;text-align:left;font-size:13px}
  td{padding:8px 12px;border-bottom:1px solid #eee;font-size:13px}
  .doc-name{font-weight:600;color:#333}
  .cell-yesno{text-align:center;font-weight:700}
  td:has(span.si){color:#059669}
  td:has(span.no){color:#dc2626}
  tr:hover{background:#fafaff}
</style></head>
<body>
  <h1>Tabular Review</h1>
  <p class="meta">${result.totalDocs} documentos · ${result.totalBatches} lotes · ${(result.durationMs/1000).toFixed(1)}s · ${result.columns.length} columnas</p>
  <table>${headers}${body}</table>
  <script>
    document.querySelectorAll('.cell-yesno').forEach(td => {
      const v = td.textContent.trim().toLowerCase();
      const span = document.createElement('span');
      span.className = v === 'sí' || v === 'si' ? 'si' : 'no';
      span.textContent = td.textContent.trim();
      td.textContent = ''; td.appendChild(span);
    });
  </script>
</body></html>`;
}
