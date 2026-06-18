// shot.mjs — Captura N frames de cada patrón.
//
// Uso:   node scripts/shot.mjs [pattern]
//   pattern = zoom (default) | pan-h | pan-v
// Salida: scripts/shots/<pattern>-<t>.png

import { chromium } from "file:///C:/Users/acer/AppData/Roaming/npm/node_modules/playwright/index.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT  = join(HERE, "shots");
mkdirSync(OUT, { recursive: true });

const PATTERN = process.argv[2] ?? "zoom";
const BASE    = "http://localhost:5180/";

// Cada patrón tiene su propio CYCLE_MS (definido en su archivo .tsx).
// Aquí definimos los frame-times a capturar: 6 instantes distribuidos
// por el ciclo para capturar el setup, los puntos de inflexión y el
// final del movimiento.
const CYCLES = {
  zoom:  8000,
  "pan-h": 9000,
  "pan-v": 7000,
};
const CYCLE = CYCLES[PATTERN] ?? 6000;

// Instantes representativos: inicio, ~20%, ~40%, ~50% (mid dramático),
// ~70% (post-mid), ~90% (cerca del final del loop).
const TIMES_MS = [
  0,
  Math.round(CYCLE * 0.20),
  Math.round(CYCLE * 0.40),
  Math.round(CYCLE * 0.50),
  Math.round(CYCLE * 0.70),
  Math.round(CYCLE * 0.90),
];

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();

for (const t of TIMES_MS) {
  const url = `${BASE}?pattern=${PATTERN}&t=${t}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  // Esperar a que la cámara esté en el DOM (cualquier patrón la monta).
  await page.waitForSelector("[data-camera='1']", { timeout: 10000 }).catch(() => {});
  // Esperar más para que useFrame setee progress y React re-rendere con
  // la transformación correcta. 150ms era muy poco — React 19 batchea
  // los setState de useEffect y a veces no llegaba el frame transformado.
  await page.waitForTimeout(800);

  const filename = join(OUT, `${PATTERN}-${String(t).padStart(4, "0")}ms.png`);
  await page.screenshot({ path: filename, type: "png" });
  console.log(`✓ ${filename}`);
}

await browser.close();
console.log("done.");