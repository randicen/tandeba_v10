import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs/promises";
import path from "path";
import PDFParser from "pdf2json";
import mammoth from "mammoth";
import * as xlsx from "xlsx";
import { DocxEngine } from '../lib/docx/DocxEngine.js';
import { batchReviewDocuments, generateDashboardHtml } from './batch-processor.js';
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";

const r2AccountId = process.env.R2_ACCOUNT_ID;
const r2AccessKeyId = process.env.R2_ACCESS_KEY_ID;
const r2SecretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const r2BucketName = process.env.R2_BUCKET_NAME || "agent-workspace";

export let s3Client: S3Client | null = null;
const sandboxes = new Map<string, { sandbox: any, lastUsed: number }>();
const browsers = new Map<string, { browser: any, page: any, lastUsed: number }>();

// Run cleanup every 10 minutes
setInterval(() => {
  const now = Date.now();
  const TEN_MINUTES = 10 * 60 * 1000;
  
  for (const [sessionId, bSession] of browsers.entries()) {
    if (now - bSession.lastUsed > TEN_MINUTES) {
      try { bSession.browser.close().catch(() => {}); } catch(e) {}
      browsers.delete(sessionId);
    }
  }

  for (const [sessionId, sSession] of sandboxes.entries()) {
    if (now - sSession.lastUsed > TEN_MINUTES) {
      // E2B sandboxes auto-close, just remove from map
      sandboxes.delete(sessionId);
    }
  }
}, 60 * 1000).unref();

if (r2AccountId && r2AccessKeyId && r2SecretAccessKey) {
  s3Client = new S3Client({
    region: "auto",
    endpoint: `https://${r2AccountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: r2AccessKeyId,
      secretAccessKey: r2SecretAccessKey,
    },
  });
}

export function getWorkspaceDir(sessionId?: string): string {
  const base = path.join(process.cwd(), 'workspace');
  if (sessionId) return path.join(base, sessionId);
  return base;
}

export async function syncWorkspaceFromR2() {
  if (!s3Client) return;
  try {
    const data = await s3Client.send(new ListObjectsV2Command({ Bucket: r2BucketName }));
    if (data.Contents) {
      for (const obj of data.Contents) {
        if (!obj.Key) continue;
        const res = await s3Client.send(new GetObjectCommand({ Bucket: r2BucketName, Key: obj.Key }));
        if (res.Body) {
          const byteArray = await res.Body.transformToByteArray();
          const fullPath = path.resolve(getWorkspaceDir(), obj.Key);
          await fs.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.writeFile(fullPath, byteArray);
        }
      }
    }
    console.log("Workspace synced from R2 successfully.");
  } catch(e: any) {
    if (e?.Code === 'NoSuchBucket') {
      console.warn(`R2 bucket "${r2BucketName}" not found. Workspace files will be stored locally only.`);
    } else {
      console.error("Error syncing workspace from R2:", e.message || e);
    }
  }
}

export async function syncToR2(filePath: string, buffer: Uint8Array | string | Buffer, sessionId?: string) {
  if (!s3Client) return;
  try {
    const fullPath = sessionId ? path.join(sessionId, filePath) : filePath;
    const s3Path = fullPath.replace(/\\/g, '/');
    await s3Client.send(new PutObjectCommand({
      Bucket: r2BucketName,
      Key: s3Path,
      Body: buffer
    }));
  } catch(e) {
    console.error("Failed to sync to R2", e);
  }
}

export async function deleteFromR2(filePath: string, sessionId?: string) {
  if (!s3Client) return;
  try {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const fullPath = sessionId ? path.join(sessionId, filePath) : filePath;
    const s3Path = fullPath.replace(/\\/g, '/');
    await s3Client.send(new DeleteObjectCommand({
      Bucket: r2BucketName,
      Key: s3Path
    }));
  } catch(e) {
    console.error("Failed to delete from R2", e);
  }
}

export async function deleteWorkspaceFile(sessionId: string, filePath: string) {
  const dir = getWorkspaceDir(sessionId);

  const tryDelete = async (name: string) => {
    const fullPath = path.resolve(dir, name);
    if (!fullPath.startsWith(dir)) return;
    try { await fs.unlink(fullPath); } catch(e) {}
    try { await deleteFromR2(name, sessionId); } catch(e) {}
  };

  await tryDelete(filePath);

  if (filePath.endsWith('.docx')) {
    await tryDelete(filePath.replace(/\.docx$/, '.doc.html'));
  }
}

export async function renameWorkspaceFile(sessionId: string, oldPath: string, newName: string) {
  const dir = getWorkspaceDir(sessionId);

  // Helper for renaming a specific extension variant
  const tryRename = async (fromName: string, toName: string) => {
    const oldFullPath = path.resolve(dir, fromName);
    const newFullPath = path.resolve(dir, toName);
    if (!oldFullPath.startsWith(dir) || !newFullPath.startsWith(dir)) throw new Error("Access denied");
    try {
      await fs.access(oldFullPath); // Check if it exists
      await fs.rename(oldFullPath, newFullPath);
      const content = await fs.readFile(newFullPath);
      await syncToR2(toName, content, sessionId);
      await deleteFromR2(fromName, sessionId);
      return true;
    } catch (e) {
      return false;
    }
  };

  const renamedBasic = await tryRename(oldPath, newName);
  
  if (oldPath.endsWith('.docx') && newName.endsWith('.docx')) {
    const fromHtml = oldPath.replace(/\.docx$/, '.doc.html');
    const toHtml = newName.replace(/\.docx$/, '.doc.html');
    await tryRename(fromHtml, toHtml);
  }
  
  if (!renamedBasic && !oldPath.endsWith('.docx')) {
      throw new Error(`File not found: ${oldPath}`);
  }
}

import * as docx from "docx";

export async function createBlankDocx(): Promise<Buffer> {
  const doc = new docx.Document({
    sections: [{
      properties: {},
      children: [
        new docx.Paragraph({
          children: [
            new docx.TextRun("Documento nuevo"),
          ],
        }),
      ],
    }],
  });
  const b64string = await docx.Packer.toBase64String(doc);
  return Buffer.from(b64string, 'base64');
}

export async function getWorkspaceFiles(sessionId: string) {
  const mergedFiles = new Map<string, any>();

  try {
    const dir = getWorkspaceDir(sessionId);
    await fs.mkdir(dir, { recursive: true });
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.endsWith('.meta.html') || e.name.endsWith('.comments.json')) continue; // Skip internal files unless needed later
      let mappedName = e.name;
      if (mappedName.endsWith('.doc.html')) mappedName = mappedName.replace(/\.doc\.html$/, '.docx');
      
      const stats = await fs.stat(path.join(dir, e.name));
      mergedFiles.set(mappedName, {
        name: mappedName,
        isDirectory: e.isDirectory(),
        path: mappedName,
        updatedAt: stats.mtimeMs
      });
    }
  } catch(e) {
    // ignore
  }

  try {
    if (s3Client) {
      const prefix = sessionId + '/';
      // Get session specific files
      const dataSession = await s3Client.send(new ListObjectsV2Command({ Bucket: r2BucketName, Prefix: prefix }));
      if (dataSession.Contents) {
        dataSession.Contents.filter(c => c.Key && c.Key !== prefix).forEach(c => {
          const name = c.Key!.replace(prefix, '');
          let mappedName = name;
          if (mappedName.endsWith('.doc.html')) mappedName = mappedName.replace(/\.doc\.html$/, '.docx');
          if (mergedFiles.has(mappedName)) return; // Already from local scan
          mergedFiles.set(mappedName, {
            name: mappedName,
            isDirectory: false,
            path: mappedName,
            updatedAt: c.LastModified?.getTime() || 0
          });
        });
      }
    }
  } catch(e) {
    console.warn("Failed to list R2 files:", e);
  }

  return Array.from(mergedFiles.values());
}

export async function ensureFileLocal(sessionId: string, fileName: string) {
  let actualFileName = fileName;
  if (actualFileName.endsWith('.docx')) actualFileName = actualFileName.replace(/\.docx$/, '.doc.html');
  const dir = getWorkspaceDir(sessionId);
  let fullPath = path.resolve(dir, actualFileName);
  try {
    await fs.access(fullPath);
    return fullPath; // Exists locally
  } catch(e) {
    // missing locally
  }
  
  // Helper to convert docx to doc.html
  const convertDocxToHtml = async (sourcePath: string, destPath: string) => {
      try {
          const mammoth = await import("mammoth");
          const buffer = await fs.readFile(sourcePath);
          const result = await mammoth.convertToHtml({ buffer });
          await fs.writeFile(destPath, result.value, "utf8");
          return true;
      } catch(err) {
          console.error("Mammoth conversion failed during ensureFileLocal:", err);
          return false;
      }
  };
  
  // Try original .docx if actual local .doc.html failed
  if (fileName.endsWith('.docx')) {
      try {
          const originalPath = path.resolve(dir, fileName);
          await fs.access(originalPath);
          if (await convertDocxToHtml(originalPath, fullPath)) {
             return fullPath; // Successfully converted
          }
      } catch(e) {}
  }
  
  if (!s3Client) return fullPath;
  
  try {
     const s3Path = sessionId + '/' + actualFileName;
     const res = await s3Client.send(new GetObjectCommand({ Bucket: r2BucketName, Key: s3Path.replace(/\\/g, '/') }));
     
     if (res.Body) {
        const byteArray = await res.Body.transformToByteArray();
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, byteArray);
     }
     return fullPath;
  } catch(e: any) {
     if (fileName.endsWith('.docx')) {
        // Fallback to fetching .docx from S3 and converting it
        try {
           const s3PathOriginal = sessionId + '/' + fileName;
           const resOriginal = await s3Client.send(new GetObjectCommand({ Bucket: r2BucketName, Key: s3PathOriginal.replace(/\\/g, '/') }));
           if (resOriginal.Body) {
              const byteArray = await resOriginal.Body.transformToByteArray();
              const originalPath = path.resolve(dir, fileName);
              await fs.mkdir(path.dirname(originalPath), { recursive: true });
              await fs.writeFile(originalPath, byteArray);
              if (await convertDocxToHtml(originalPath, fullPath)) {
                 return fullPath;
              }
              return originalPath; // fallback if conversion fails
           }
        } catch(e2: any) {}
     }
     
     if (e.name !== "NoSuchKey" && e.name !== "NotFound") {
        console.error("Could not fetch file from R2:", e);
     }
     throw new Error("File not found");
  }
}

export async function getWorkspaceFileContent(filePath: string, sessionId: string) {
  let actualFilePath = filePath;
  if (actualFilePath.endsWith('.docx')) actualFilePath = actualFilePath.replace(/\.docx$/, '.doc.html');
  const dir = getWorkspaceDir(sessionId);
  const fullPath = path.resolve(dir, actualFilePath);
  if (!fullPath.startsWith(dir)) throw new Error("Access denied");
  return await fs.readFile(fullPath, "utf-8");
}

import { getCoreMemory, setCoreMemory, deleteCoreMemory, addEpisodicMemory, searchEpisodicMemory } from "./memory.js";
import { apifyScrapeUrl } from "./apify.js";

export async function executeTool(name: string, args: any, sessionId: string): Promise<any> {
  if (name === "ai_document_editor") {
    return await aiDocumentEditor(args.path, args.instruction, sessionId);
  }
  if (name === "apify_scrape_url") {
    return await apifyScrapeUrl(args.url, sessionId);
  }
  if (name === "read_url") {
    return await readUrl(args.url);
  }
  if (name === "create_docx") {
    try {
      let filename = args.filename;
      if (filename.endsWith('.docx')) {
        filename = filename.replace('.docx', '.doc.html');
      }
      
      const blankHtml = `<p>Documento nuevo</p>`;
      const dbuf = Buffer.from(blankHtml, 'utf8');

      const dir = getWorkspaceDir(sessionId);
      const fullPath = path.resolve(dir, filename);
      if (!fullPath.startsWith(dir)) throw new Error("Access denied");
      await fs.writeFile(fullPath, dbuf);
      await syncToR2(filename, dbuf, sessionId);
      return `Created blank docx at ${args.filename}`;
    } catch(e: any) {
      return `Error creating DOCX: ${e.message}`;
    }
  }
  if (name === "rename_file") {
    try {
      await renameWorkspaceFile(sessionId, args.old_path, args.new_name);
      return `Renamed ${args.old_path} to ${args.new_name}`;
    } catch(e: any) {
      return `Error renaming file: ${e.message}`;
    }
  }
  if (name === "delete_file") {
    try {
      await deleteWorkspaceFile(sessionId, args.path);
      return `Deleted ${args.path}`;
    } catch(e: any) {
      return `Error deleting file: ${e.message}`;
    }
  }
  if (name === "browser_action") {
    return await browserAction(args.action, args, sessionId);
  }
  if (name === "execute_code") {
    return await executeCode(args.code, args.language, sessionId);
  }
  if (name === "search_web") {
    return await searchWeb(args.query);
  }
  if (name === "list_files") {
    return await listFiles(args.path, sessionId);
  }
  if (name === "read_file") {
    return await readFile(args.path, sessionId);
  }
  if (name === "write_file") {
    return await writeFile(args.path, args.content, sessionId);
  }
  if (name === "download_file") {
    return await downloadFile(args.url, args.filename, sessionId);
  }
  if (name === "set_core_memory") {
    setCoreMemory(args.key, args.value);
    return `Core memory updated: ${args.key}`;
  }
  if (name === "delete_core_memory") {
    deleteCoreMemory(args.key);
    return `Core memory deleted: ${args.key}`;
  }
  if (name === "save_episodic_memory") {
    await addEpisodicMemory(args.content);
    return `Saved to episodic memory.`;
  }
  if (name === "sandbox_upload") {
    const sSession = sandboxes.get(sessionId);
    const activeSandbox = sSession ? sSession.sandbox : null;
    if (sSession) sSession.lastUsed = Date.now();
    if (!activeSandbox) return "Error: Sandbox not initialized. Run execute_code first to initialize it.";
    try {
      let actualPath = args.path;
      // We do not override .docx here anymore, so the sandbox gets the binary docx file 
      // if it exists. If they request doc.html, they get the text version.
      const dir = getWorkspaceDir(sessionId);
      const fullPath = path.resolve(dir, actualPath);
      if (!fullPath.startsWith(dir)) return "Access denied.";
      const content = await fs.readFile(fullPath);
      await activeSandbox.files.write(`/home/user/${path.basename(actualPath)}`, content);
      return `File ${args.path} uploaded to sandbox at /home/user/${path.basename(actualPath)}`;
    } catch(e: any) {
      return "Error uploading to sandbox: " + e.message;
    }
  }
  if (name === "sandbox_download") {
    const sSession = sandboxes.get(sessionId);
    const activeSandbox = sSession ? sSession.sandbox : null;
    if (sSession) sSession.lastUsed = Date.now();
    if (!activeSandbox) return "Error: Sandbox not initialized.";
    try {
      let actualFilename = args.local_filename;
      const dir = getWorkspaceDir(sessionId);
      const content = await activeSandbox.files.read(args.sandbox_path, { format: 'bytes' });
      const fullPath = path.resolve(dir, actualFilename);
      if (!fullPath.startsWith(dir)) return "Access denied.";
      await fs.writeFile(fullPath, content as any);
      await syncToR2(actualFilename, content as any, sessionId);
      return `File downloaded from sandbox and saved as ${args.local_filename} in workspace.`;
    } catch(e: any) {
      return "Error downloading from sandbox: " + e.message;
    }
  }
  if (name === "search_episodic_memory") {
    const results = await searchEpisodicMemory(args.query);
    if (!results || results.length === 0) return "No relevant episodic memories found.";
    return "Relevant Episodic Memories found:\n" + results.map(r => "- " + r).join("\n");
  }
  if (name === "read_docx_structure") {
    return await readDocxStructure(args.path, args.component, sessionId);
  }
  if (name === "edit_docx_content") {
    return await editDocxContent(args.path, args.component, args.targetXml, args.replacementXml, sessionId);
  }
  if (name === "find_replace_text") {
    return await findReplaceDocxText(args.path, args.searchText, args.replaceText, sessionId);
  }
  if (name === "update_docx_formatting") {
    return await updateDocxFormatting(args.path, args.settings, sessionId);
  }
  if (name === "batch_review") {
    return await executeBatchReview(args.columns, sessionId);
  }
  throw new Error(`Unknown tool: ${name}`);
}

import fsStream from "fs";

async function downloadFile(url: string, filename: string, sessionId: string) {
  try {
    let actualFilename = filename;
    const dir = getWorkspaceDir(sessionId);
    const fullPath = path.resolve(dir, actualFilename);
    if (!fullPath.startsWith(dir)) return "Access denied outside workspace.";
    
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    
    // Download using axios stream to avoid file corruption
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream',
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36"
      }
    });

    const contentType = response.headers['content-type'];
    let warning = "";
    if (actualFilename.toLowerCase().endsWith(".pdf") && typeof contentType === 'string' && !contentType.includes("pdf")) {
      warning = ` (Warning: Server returned content-type ${contentType}, this might not be a valid PDF. You might have hit a captcha page or anti-bot protection.)`;
    }

    const writer = fsStream.createWriteStream(fullPath);
    response.data.pipe(writer);

    await new Promise<void>((resolve, reject) => {
      writer.on('finish', () => resolve());
      writer.on('error', reject);
    });

    const fileData = await fs.readFile(fullPath);
    await syncToR2(actualFilename, fileData, sessionId);

    return `File downloaded successfully to ${filename}${warning}`;
  } catch(e: any) {
    return `Error downloading file: ${e.message}`;
  }
}

async function writeFile(filePath: string, content: string, sessionId: string) {
  try {
    let actualFilePath = filePath;
    if (actualFilePath.endsWith('.docx')) actualFilePath = actualFilePath.replace(/\.docx$/, '.doc.html');
    const dir = getWorkspaceDir(sessionId);
    const fullPath = path.resolve(dir, actualFilePath);
    if (!fullPath.startsWith(dir)) return "Access denied outside workspace.";
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf-8");
    await syncToR2(actualFilePath, content, sessionId);

    // Also regenerate the .docx if we wrote to a .doc.html
    if (filePath.endsWith('.docx')) {
      try {
        const docxName = filePath;
        const docxBuffer = await (await import("../lib/html-to-docx-custom.js")).customHtmlToDocx(content);
        const docxPath = path.resolve(dir, docxName);
        await fs.writeFile(docxPath, Buffer.from(docxBuffer as ArrayBuffer));
        await syncToR2(docxName, Buffer.from(docxBuffer as ArrayBuffer), sessionId);
      } catch(e: any) {
        console.error("Failed to regenerate DOCX after writeFile:", e);
      }
    }

    return `File written successfully to ${filePath}`;
  } catch(e: any) {
    return `Error writing file: ${e.message}`;
  }
}

async function listFiles(dirPath: string, sessionId: string) {
  try {
    const dir = getWorkspaceDir(sessionId);
    const fullPath = path.resolve(dir, dirPath);
    if (!fullPath.startsWith(dir)) return "Access denied outside workspace.";
    const files = await fs.readdir(fullPath, { withFileTypes: true });
    return files.map(f => `${f.isDirectory() ? '[DIR] ' : '[FILE]'} ${f.name}`).join("\n");
  } catch(e: any) {
    return `Error reading directory: ${e.message}`;
  }
}

async function readFile(filePath: string, sessionId: string) {
  try {
    const dir = getWorkspaceDir(sessionId);
    let actualFilePath = filePath;
    if (actualFilePath.endsWith('.docx')) actualFilePath = actualFilePath.replace(/\.docx$/, '.doc.html');
    const fullPath = path.resolve(dir, actualFilePath);
    if (!fullPath.startsWith(dir)) return "Access denied outside workspace.";
    
    // We must act like a .docx file if the user asked for one.
    // If it's a doc.html being treated as docx:
    let ext = path.extname(actualFilePath).toLowerCase();
    if (ext === ".html" && filePath.endsWith(".docx")) {
       ext = ".docx"; 
    }
    if (ext === ".pdf") {
      const dataBuffer = await fs.readFile(fullPath);
      return await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("PDF parsing timed out after 30 seconds")), 30000);
        const pdfParser = new PDFParser(null, 1 as any);
        pdfParser.on("pdfParser_dataError", (errData: any) => {
          clearTimeout(timeout);
          reject(errData.parserError);
        });
        pdfParser.on("pdfParser_dataReady", (pdfData: any) => {
          clearTimeout(timeout);
          resolve(pdfParser.getRawTextContent());
        });
        try {
          pdfParser.parseBuffer(dataBuffer as any);
        } catch(e) {
          clearTimeout(timeout);
          reject(e);
        }
      });
    } else if (ext === ".docx") {
      const dataBuffer = await fs.readFile(fullPath);
      const result = await mammoth.extractRawText({ buffer: dataBuffer });
      return result.value;
    } else if (ext === ".xlsx" || ext === ".xls" || ext === ".csv") {
      const dataBuffer = await fs.readFile(fullPath);
      const workbook = xlsx.read(dataBuffer, { type: 'buffer' });
      let result = "";
      for (const sheetName of workbook.SheetNames) {
        result += `=== Sheet: ${sheetName} ===\n`;
        const worksheet = workbook.Sheets[sheetName];
        result += xlsx.utils.sheet_to_csv(worksheet) + "\n\n";
      }
      return result;
    }
    
    // Default: text read
    return await fs.readFile(fullPath, "utf-8");
  } catch(e: any) {
    return `Error reading file: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function searchWeb(query: string) {
  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');
    
    await page.goto(`https://search.yahoo.com/search?p=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    
    // Evaluate to extract Yahoo results
    const resultsData = await page.evaluate(() => {
      const results: string[] = [];
      const elements = document.querySelectorAll('#web > ol > li');
      for (let i = 0; i < Math.min(5, elements.length); i++) {
        const el = elements[i];
        const titleEl = el.querySelector('.compTitle a');
        const snippetEl = el.querySelector('.compText');
        
        if (titleEl && snippetEl) {
          const title = titleEl.textContent?.trim() || '';
          const url = titleEl.getAttribute('href') || '';
          const snippet = snippetEl.textContent?.trim() || '';
          if (title && url) {
            results.push(`Title: ${title}\nURL: ${url}\nSnippet: ${snippet}`);
          }
        }
      }
      return results;
    });

    if (!resultsData || resultsData.length === 0) {
      return "No results found.";
    }

    return resultsData.join("\n\n");
  } catch(e: any) {
    return `Search failed: ${e.message}`;
  } finally {
    if (browser) await browser.close();
  }
}

import puppeteer from 'puppeteer';

async function readUrl(url: string) {
  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    
    // Provide a recognizable user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');
    
    // Navigate to the URL and wait for DOM content
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    
    // Extract innerText of the body
    const textContent = await page.evaluate(() => {
      // Remove unwanted tags before extracting text
      const elementsToRemove = document.querySelectorAll('script, style, noscript, iframe, svg');
      elementsToRemove.forEach(el => el.remove());
      return document.body.innerText;
    });
    
    return textContent.replace(/\s+/g, ' ').trim().slice(0, 15000);
  } catch(e: any) {
    throw new Error(`Failed to fetch URL using browser: ${e.message}`);
  } finally {
    if (browser) await browser.close();
  }
}

import { Sandbox } from '@e2b/code-interpreter';

async function executeCode(code: string, language: string, sessionId: string) {
  if (!process.env.E2B_API_KEY) {
    return "Error: Missing E2B_API_KEY environment variable. You must configure an E2B API Key in order to use this feature (E2B Sandbox execution). Please ask the user to provide their E2B_API_KEY.";
  }
  
  try {
    let sSession = sandboxes.get(sessionId);
    let activeSandbox = sSession ? sSession.sandbox : null;
    if (!activeSandbox) {
      activeSandbox = await Sandbox.create({ timeoutMs: 30_000 }); // Wait max 30s to create
      sandboxes.set(sessionId, { sandbox: activeSandbox, lastUsed: Date.now() });
    } else {
      sSession!.lastUsed = Date.now();
    }
    let result = '';
    
    // Fallback language identifier if needed
    const langOpts = language === 'javascript' ? 'js' : language;
    
    // Using E2B runCode to evaluate the python/js code.
    let execution: any;
    try {
      execution = await activeSandbox.runCode(code, { language: langOpts, timeoutMs: 120_000 });
    } catch(err: any) {
      if (err.message && err.message.toLowerCase().includes("not found")) {
         // Sandbox expired, spawn a new one
         activeSandbox = await Sandbox.create({ timeoutMs: 30_000 });
         sandboxes.set(sessionId, { sandbox: activeSandbox, lastUsed: Date.now() });
         execution = await activeSandbox.runCode(code, { language: langOpts, timeoutMs: 120_000 });
      } else {
         throw err;
      }
    }
    
    if ((execution as any).text) {
      result += (execution as any).text + '\n';
    }
    if (execution.logs) {
      if (execution.logs.stdout && execution.logs.stdout.length > 0) {
        result += execution.logs.stdout.join('');
      }
      if (execution.logs.stderr && execution.logs.stderr.length > 0) {
        result += execution.logs.stderr.join('');
      }
    }
    if (execution.results && execution.results.length > 0) {
      for (const r of execution.results) {
         if (r.text) result += '\n' + r.text;
         if (r.error) result += '\n' + r.error.name + ': ' + r.error.value;
         if (r.png || r.jpeg || r.svg) {
             result += '\n[Image output generated but cannot be displayed directly as text]';
         }
      }
    }
    if (execution.error) {
      result += '\nError: ' + execution.error.name + ': ' + execution.error.value;
    }
    
    // Reset idle timeout so it doesn't expire prematurely between calls
    await activeSandbox.setTimeout(10 * 60 * 1000);
    
    return result.trim() || "Script executed silently.";
  } catch (e: any) {
    return "Error in Sandbox execution: " + e.message;
  }
}

async function browserAction(action: string, params: any, sessionId: string) {
  try {
    let bSession = browsers.get(sessionId);
    if (!bSession) {
        let browserInstance = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        let browserPage = await browserInstance.newPage();
        
        await browserPage.setViewport({ width: 1280, height: 800 });
        await browserPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');
        
        bSession = { browser: browserInstance, page: browserPage, lastUsed: Date.now() };
        browsers.set(sessionId, bSession);
    } else {
        bSession.lastUsed = Date.now();
    }
    
    let { browser: browserInstance, page: browserPage } = bSession;
    
    const client = await browserPage.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: path.resolve(getWorkspaceDir(sessionId)),
    });

    const page = browserPage!;
    
    if (action === "goto") {
        await page.goto(params.url, { waitUntil: 'networkidle2', timeout: 15000 });
    } else if (action === "click" && params.x !== undefined && params.y !== undefined) {
        await page.mouse.click(params.x, params.y);
        await new Promise(r => setTimeout(r, 2000));
    } else if (action === "type" && params.x !== undefined && params.y !== undefined) {
        await page.mouse.click(params.x, params.y);
        await page.keyboard.type(params.text || "");
    } else if (action === "scroll") {
        await page.mouse.wheel({ deltaY: params.deltaY || 500 });
        await new Promise(r => setTimeout(r, 1000));
    } else if (action === "screenshot") {
        // Just proceed to taking screenshot below
    }

    // Identify interactables for the agent
    const interactables = await page.evaluate(() => {
        const elements = document.querySelectorAll('a, button, input, textarea, select, [role="button"], [tabindex="0"]');
        const results: any[] = [];
        elements.forEach((el, index) => {
            const rect = el.getBoundingClientRect();
            // Basic visibility check
            if (rect.width > 0 && rect.height > 0 && rect.x >= 0 && rect.y >= 0 && rect.x <= window.innerWidth && rect.y <= window.innerHeight) {
                // Add a small red box with ID to the DOM to "Set-of-Mark" it visually for the LLM
                // Because we're modifying the DOM *before* taking the screenshot
                const overlay = document.createElement('div');
                overlay.style.position = 'absolute';
                overlay.style.top = rect.y + 'px';
                overlay.style.left = rect.x + 'px';
                overlay.style.border = '2px solid red';
                overlay.style.color = 'red';
                overlay.style.backgroundColor = 'rgba(255, 255, 255, 0.7)';
                overlay.style.fontSize = '12px';
                overlay.style.fontWeight = 'bold';
                overlay.style.zIndex = '999999';
                overlay.style.pointerEvents = 'none';
                overlay.innerText = String(index);
                document.body.appendChild(overlay);

                results.push({
                    id: index,
                    tag: el.tagName,
                    text: (el as HTMLElement).innerText?.trim().slice(0, 30) || (el as HTMLInputElement).value?.slice(0, 30) || '',
                    x: Math.round(rect.x + rect.width / 2),
                    y: Math.round(rect.y + rect.height / 2),
                });
            }
        });
        return results;
    });

    const screenshotB64 = await page.screenshot({ encoding: 'base64' });

    // Remove the overlays after taking the screenshot
    await page.evaluate(() => {
        const overlays = document.querySelectorAll('div[style*="border: 2px solid red"]');
        overlays.forEach(el => el.remove());
    });

    return {
        _isBrowserActionResult: true,
        url: page.url(),
        interactables: interactables,
        screenshot: `data:image/png;base64,${screenshotB64}`
    };
    
  } catch(e: any) {
    return { error: `Browser action failed: ${e.message}` };
  }
}

async function readDocxStructure(filePath: string, component: string, sessionId: string) {
  try {
    const dir = getWorkspaceDir(sessionId);
    const fullPath = path.resolve(dir, filePath);
    if (!fullPath.startsWith(dir)) return "Access denied outside workspace.";
    const fileBuf = await fs.readFile(fullPath);
    const engine = new DocxEngine(fileBuf);
    const xml = engine.getComponentXml(component);
    const structured = engine.getStructuredText();
    return `=== STRUCTURED TEXT (paragraphs) ===\n${structured}\n\n=== RAW XML (${component}) ===\n${xml}`;
  } catch(e: any) {
    return `Error reading DOCX structure: ${e.message}`;
  }
}

async function editDocxContent(filePath: string, component: string, targetXml: string, replacementXml: string, sessionId: string) {
  try {
    const dir = getWorkspaceDir(sessionId);
    const fullPath = path.resolve(dir, filePath);
    if (!fullPath.startsWith(dir)) return "Access denied outside workspace.";
    
    const fileBuf = await fs.readFile(fullPath);
    const engine = new DocxEngine(fileBuf);
    
    const replaced = engine.replaceInComponent(component, targetXml, replacementXml);
    if (!replaced) return `Failed to find target XML substring in '${component}'. Use read_docx_structure to review the exact XML content.`;
    
    const newBuf = engine.generateBuffer();
    await fs.writeFile(fullPath, newBuf);
    
    // Regenerate the .doc.html preview from the updated DOCX
    try {
      const mammoth = await import('mammoth');
      const result = await mammoth.convertToHtml({ buffer: newBuf });
      const htmlPath = fullPath.replace(/\.docx$/, '.doc.html');
      await fs.writeFile(htmlPath, result.value);
      await syncToR2(filePath.replace(/\.docx$/, '.doc.html'), Buffer.from(result.value, 'utf8'), sessionId);
    } catch(e: any) {
      console.error("Failed to regenerate preview after editDocxContent", e);
    }
    
    await syncToR2(filePath, newBuf, sessionId);
    
    return `Successfully updated DOCX component '${component}'. Replaced text and synced to workspace. The document preview has been regenerated.`;
  } catch(e: any) {
    return `Error editing DOCX: ${e.message}`;
  }
}

async function findReplaceDocxText(filePath: string, searchText: string, replaceText: string, sessionId: string) {
  try {
    const dir = getWorkspaceDir(sessionId);
    const fullPath = path.resolve(dir, filePath);
    if (!fullPath.startsWith(dir)) return "Access denied outside workspace.";

    const fileBuf = await fs.readFile(fullPath);
    const engine = new DocxEngine(fileBuf);

    const count = engine.findAndReplaceText(searchText, replaceText);
    if (count === 0) return `Text '${searchText}' not found in the document. Try using read_docx_structure to inspect the document content.`;

    const newBuf = engine.generateBuffer();
    await fs.writeFile(fullPath, newBuf);

    // Regenerate the .doc.html preview
    try {
      const mammoth = await import('mammoth');
      const result = await mammoth.convertToHtml({ buffer: newBuf });
      const htmlPath = fullPath.replace(/\.docx$/, '.doc.html');
      await fs.writeFile(htmlPath, result.value);
      await syncToR2(filePath.replace(/\.docx$/, '.doc.html'), Buffer.from(result.value, 'utf8'), sessionId);
    } catch(e: any) {
      console.error("Failed to regenerate preview after findReplaceDocxText", e);
    }

    await syncToR2(filePath, newBuf, sessionId);

    return `Replaced '${searchText}' with '${replaceText}' in ${count} location(s). Document preview regenerated.`;
  } catch(e: any) {
    return `Error replacing text in DOCX: ${e.message}`;
  }
}

async function updateDocxFormatting(filePath: string, settings: { margins?: { top?: number; right?: number; bottom?: number; left?: number }; pageSize?: { width?: number; height?: number } }, sessionId: string) {
  try {
    const dir = getWorkspaceDir(sessionId);
    const fullPath = path.resolve(dir, filePath);
    if (!fullPath.startsWith(dir)) return "Access denied outside workspace.";

    const fileBuf = await fs.readFile(fullPath);
    const engine = new DocxEngine(fileBuf);

    const modified = engine.updateFormatting(settings);
    if (!modified) return "No formatting changes were applied. The document may not have the expected structure.";

    const newBuf = engine.generateBuffer();
    await fs.writeFile(fullPath, newBuf);
    await syncToR2(filePath, newBuf, sessionId);

    const parts: string[] = [];
    if (settings.margins) parts.push(`margins: ${JSON.stringify(settings.margins)}`);
    if (settings.pageSize) parts.push(`page size: ${JSON.stringify(settings.pageSize)}`);
    return `Updated document formatting (${parts.join(', ')}). Note: some formatting changes may only be visible after downloading and opening the DOCX in Word.`;
  } catch(e: any) {
    return `Error updating DOCX formatting: ${e.message}`;
  }
}

export async function aiDocumentEditor(filePath: string, instruction: string, sessionId: string) {
  try {
    const dir = getWorkspaceDir(sessionId);
    let actualFilePath = filePath;
    if (filePath.endsWith('.docx')) {
      actualFilePath = filePath.replace('.docx', '.doc.html');
    }
    
    const fullPath = path.resolve(dir, actualFilePath);
    if (!fullPath.startsWith(dir)) return "Access denied outside workspace.";

    const htmlContent = await fs.readFile(fullPath, "utf8");

    const { openai } = await import("./agent.js");
    console.log("Calling Sub-LLM for document HTML editing...");
    const response = await openai.chat.completions.create({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: "You are an expert Document editor. Your task is to modify the provided semantic HTML document exactly as requested by the user's instruction. Keep the semantic structure perfectly intact. IMPORTANT: When applying styles (such as font family, font size, highlights, strike-through, colors), you MUST use inline CSS styles (e.g. `<span style=\"font-family: 'Times New Roman'; font-size: 16pt; background-color: yellow;\">`). Do NOT use deprecated tags like `<font>`. Use `<b>` and `<i>` for bold and italic. If the instruction asks for GLOBAL styles (e.g. 'make the whole document Times New Roman size 16'), you MUST wrap the entire document content inside a `<div style=\"font-family: 'Times New Roman'; font-size: 16pt;\">`. DO NOT add any markdown formatting like ```html, return ONLY the raw HTML string." },
        { role: "user", content: `Instruction: ${instruction}\n\nExisting HTML:\n${htmlContent}` }
      ],
      temperature: 0.1
    });

    let newHtml = response.choices[0].message.content || "";
    newHtml = newHtml.replace(/^```html\s*/i, "").replace(/```\s*$/, "").trim();

    const newBuf = Buffer.from(newHtml, "utf8");
    await fs.writeFile(fullPath, newBuf);
    await syncToR2(actualFilePath, newBuf, sessionId);

    // Regenerate the .docx from the updated .doc.html
    if (filePath.endsWith('.docx') || actualFilePath.endsWith('.doc.html')) {
      try {
        const docxName = filePath.endsWith('.docx') ? filePath : filePath.replace('.doc.html', '.docx');
        const docxBuffer = await (await import("../lib/html-to-docx-custom.js")).customHtmlToDocx(newHtml);

        const docxPath = path.resolve(dir, docxName);
        await fs.writeFile(docxPath, Buffer.from(docxBuffer as ArrayBuffer));
        await syncToR2(docxName, Buffer.from(docxBuffer as ArrayBuffer), sessionId);
      } catch(e: any) {
        console.error("Failed to regenerate DOCX after AI edit:", e);
      }
    }

    return "Successfully edited Document using AI HTML modification. The document layout is preserved precisely, and both the preview (.doc.html) and the DOCX file have been updated.";
  } catch(e: any) {
    return `Error editing Document: ${e.message}`;
  }
}

async function executeBatchReview(columns: Array<{label: string; question: string; format: string}>, sessionId: string) {
  try {
    const { openai } = await import("./agent.js");
    const result = await batchReviewDocuments(sessionId, columns as any, openai);

    // Generate and save dashboard
    const dashboardHtml = generateDashboardHtml(result);
    const dir = path.join(process.cwd(), "workspace", sessionId);
    await fs.mkdir(dir, { recursive: true });
    const filename = `review_${Date.now()}.html`;
    await fs.writeFile(path.join(dir, filename), dashboardHtml, "utf-8");
    await syncToR2(filename, Buffer.from(dashboardHtml, "utf-8"), sessionId);

    return JSON.stringify({
      dashboard: filename,
      totalDocs: result.totalDocs,
      totalBatches: result.totalBatches,
      durationMs: result.durationMs,
      columns: result.columns.length,
      preview: result.rows.slice(0, 5).map(r => ({
        filename: r.filename,
        ...Object.fromEntries(result.columns.map(c => [c.label, r[c.label] || "N/A"]))
      }))
    });
  } catch(e: any) {
    return `Error in batch review: ${e.message}`;
  }
}

