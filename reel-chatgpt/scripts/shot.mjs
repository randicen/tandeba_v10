// Capture 6 screenshots — one per scene — of the Worgena reel running at
// http://127.0.0.1:5179. Run with: node scripts/shot.mjs
//
// Uses Playwright from the global npm install (chromium already cached in
// %LOCALAPPDATA%\ms-playwright). Writes PNGs to scripts/shots/.

import { chromium } from "file:///C:/Users/acer/AppData/Roaming/npm/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT  = join(HERE, "shots");
mkdirSync(OUT, { recursive: true });

const SCENES = [
  { idx: 0, name: "1-boveda"     },
  { idx: 1, name: "2-prompt"     },
  { idx: 2, name: "3-procesando" },
  { idx: 3, name: "4-resultados" },
  { idx: 4, name: "5-exportar"   },
  { idx: 5, name: "6-cierre"     },
];

// Wait long enough for the per-scene animation to settle.
const WAIT_MS = [3500, 3500, 4500, 6000, 3500, 1500];

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 500, height: 888 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
await page.goto("http://127.0.0.1:5179/?pause=1", { waitUntil: "networkidle" });
await page.waitForSelector('button[aria-label^="Ir a escena"]');

// Pause the auto-advance so we can dwell on each scene.
await page.evaluate(() => {
  // The sequencer uses setTimeout keyed on `idx`; we can't easily cancel that
  // from outside, so we just navigate by clicking the dot — clicking also
  // resets the timer (see App.tsx goTo).
});

for (let i = 0; i < SCENES.length; i++) {
  const s = SCENES[i];
  // Click the progress dot for this scene (stops the current auto-advance)
  await page.locator(`button[aria-label="Ir a escena ${s.idx + 1}"]`).click();
  // Wait for the per-scene animations to settle
  await page.waitForTimeout(WAIT_MS[i]);
  const out = join(OUT, `${s.name}.png`);
  await page.screenshot({ path: out, fullPage: false });
  console.log(`✓ ${s.name}`);
}

await browser.close();
console.log("\nDone — frames written to:", OUT);
