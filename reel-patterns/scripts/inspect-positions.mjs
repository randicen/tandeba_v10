// inspect-positions.mjs v2 — buscar badges con substring y color.
import { chromium } from "file:///C:/Users/acer/AppData/Roaming/npm/node_modules/playwright/index.mjs";

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();

await page.goto("http://localhost:5180/?pattern=zoom&t=7200", { waitUntil: "domcontentloaded" });
await page.waitForSelector("[data-camera='1']", { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(800);

const info = await page.evaluate(() => {
  const cam = document.querySelector("[data-camera='1']");
  const camRect = cam.getBoundingClientRect();

  // Buscar cualquier elemento cuyo textContent contenga "TUTELA" o "NULIDAD"
  // y tenga un background de color (los badges tienen bg-emerald-100, etc.)
  const all = Array.from(document.querySelectorAll("*"));
  const candidates = all.filter(el => {
    const t = (el.textContent ?? "").trim();
    if (t !== "TUTELA" && t !== "NULIDAD" && t !== "INHIBE" && t !== "CONCEDE") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.width < 200 && r.height < 80;
  }).map(el => {
    const r = el.getBoundingClientRect();
    return {
      text: el.textContent.trim(),
      tag: el.tagName,
      cls: el.className,
      x: r.x, y: r.y, w: r.width, h: r.height,
      cx: r.x + r.width/2, cy: r.y + r.height/2,
    };
  });

  // También buscar filas de la tabla (elementos con grid layout)
  // Buscar todos los divs y reportar los que tengan width razonable
  // dentro del camera viewport
  const insideCamera = all.filter(el => {
    const r = el.getBoundingClientRect();
    return r.x >= camRect.x && r.x + r.width <= camRect.x + camRect.width
        && r.y >= camRect.y && r.y + r.height <= camRect.y + camRect.height
        && r.width > 30 && r.width < 200
        && r.height > 10 && r.height < 50;
  }).map(el => {
    const r = el.getBoundingClientRect();
    return {
      text: (el.textContent ?? "").trim().slice(0, 30),
      cls: el.className.slice(0, 80),
      cx: r.x + r.width/2, cy: r.y + r.height/2,
    };
  }).slice(0, 50);

  return {
    camera: { x: camRect.x, y: camRect.y, w: camRect.width, h: camRect.height,
              cx: camRect.x + camRect.width/2, cy: camRect.y + camRect.height/2 },
    badges: candidates,
    elements: insideCamera,
  };
});

console.log(JSON.stringify(info, null, 2));
await browser.close();
