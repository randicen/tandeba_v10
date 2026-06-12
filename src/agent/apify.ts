import { ApifyClient } from 'apify-client';
import fs from 'fs/promises';
import path from 'path';

// Silence ApifyClient informational logs to prevent console clutter
process.env.APIFY_LOG_LEVEL = 'ERROR';

import { getWorkspaceDir } from './tools.js';
import { logApifyUsage } from '../lib/apify-tracker.js';

// Retry helper with explicit timeout to prevent hanging forever
async function withRetryAndTimeout<T>(operation: () => Promise<T>, maxRetries = 2, timeoutMs = 180000): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await Promise.race([
        operation(),
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error('Operation timed out')), timeoutMs))
      ]);
      return result;
    } catch (error: any) {
      if (attempt === maxRetries) throw error;
      console.warn(`Apify attempt ${attempt} failed: ${error.message}. Retrying...`);
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt)); // Exponential(ish) backoff
    }
  }
  throw new Error("Failed after retries");
}

export async function apifyScrapeUrl(url: string, sessionId: string) {
  const WORKSPACE_DIR = getWorkspaceDir(sessionId);
  const token = process.env.APIFY_API_TOKEN;
  if (!token) {
    return "Error: APIFY_API_TOKEN is missing. Please configure it in your .env file.";
  }

  const client = new ApifyClient({ token });
  const callStart = Date.now();
  let resultSizeBytes: number | null = null;
  let lastError: string | null = null;

  try {
    const isUrlPdf = url.toLowerCase().includes(".pdf");
    
    // Wrapped execution in retry and timeout mechanism
    const run = await withRetryAndTimeout(async () => {
      return await client.actor("apify/playwright-scraper").call({
        startUrls: [{ url }],
        proxyConfiguration: {
            useApifyProxy: true,
        },
        preNavigationHooks: `[
          async ({ page }) => {
              // Intercept ALL requests to prevent native PDF downloading
              await page.route('**/*', async (route) => {
                  const request = route.request();
                  // If it's a direct PDF request
                  if (request.url() === "${url}" || request.url().toLowerCase().endsWith(".pdf")) {
                      try {
                          const response = await route.fetch();
                          const headers = response.headers();
                          const contentType = headers['content-type'] || '';
                          
                          if (contentType.includes('application/pdf') || contentType.includes('application/octet-stream')) {
                              // Send HTML back instead of the PDF so the page loads successfully
                              // And embed the base64 of the PDF into the page!
                              const body = await response.body();
                              const base64 = body.toString('base64');
                              
                              await route.fulfill({
                                  status: 200,
                                  contentType: 'text/html',
                                  body: '<html><body><script>window.__PDF_BASE64__ = "' + base64 + '";</script></body></html>'
                              });
                          } else {
                              // If it's the BunkerWeb captcha (text/html), let it through so JS executes!
                              await route.fulfill({ response });
                          }
                      } catch (e) {
                           route.continue();
                      }
                  } else {
                      route.continue();
                  }
              });
          }
        ]`,
        pageFunction: `
          async function pageFunction(context) {
              const { page, request } = context;
              
              // Wait up to 35s in case of BunkerWeb challenge
              try {
                  const content = await page.content();
                  if (content.includes('Bot Detection') || content.includes('Please wait while we check')) {
                      await page.waitForNavigation({ timeout: 60000, waitUntil: 'networkidle' }).catch(() => {});
                  }
              } catch(e) {}
              
              // Wait additional time for elements to load
              await page.waitForTimeout(5000);
              
              // If the PDF was grabbed directly by the route, it's stored in window.__PDF_BASE64__
              const interceptedBase64 = await page.evaluate(() => window.__PDF_BASE64__);
              
              if (interceptedBase64) {
                 return { base64: interceptedBase64, url: request.url, isPdf: true };
              }
              
              // If it wasn't intercepted (maybe it was a redirect?), fetch it natively
              try {
                  const responseBase64 = await page.evaluate(async (targetUrl) => {
                      const res = await fetch(targetUrl);
                      const isPdf = res.headers.get('content-type')?.includes('pdf');
                      const blob = await res.blob();
                      
                      return new Promise(resolve => {
                          const reader = new FileReader();
                          reader.onloadend = () => {
                              resolve({
                                  isPdf: isPdf || targetUrl.toLowerCase().endsWith('.pdf'),
                                  base64: reader.result.split(',')[1]
                              });
                          };
                          reader.readAsDataURL(blob);
                      });
                  }, request.url);
                  
                  return {
                      url: request.url,
                      base64: responseBase64.base64,
                      isPdf: responseBase64.isPdf
                  };
              } catch(e) {
                  return {
                      url: request.url,
                      base64: null,
                      isPdf: false,
                      error: e.message
                  };
              }
          }
        `,
        requestHandlerTimeoutSecs: 180,
        pageLoadTimeoutSecs: 120,
        waitUntil: 'domcontentloaded',
      });
    }, 2, 210000); // 210s total timeout for the actor run

    const dataset = await client.dataset(run.defaultDatasetId).listItems();
    if (dataset.items && dataset.items.length > 0) {
      const item = dataset.items[0] as any;
      
      if (item.error) {
          return `Error downloading URL: ${item.error}`;
      }
      
      if (!item.base64) {
          return `Error: Downloaded item contains no base64 content.`;
      }

      let filename = url.substring(url.lastIndexOf('/') + 1) || 'downloaded_file';
      if (filename.includes('?')) filename = filename.substring(0, filename.indexOf('?'));
      if (filename.includes('#')) filename = filename.substring(0, filename.indexOf('#'));
      if (!filename || filename === '') {
          filename = Object.keys(item).includes('isPdf') && item.isPdf ? 'downloaded.pdf' : 'downloaded.html';
      }

      const savePath = path.join(WORKSPACE_DIR, filename);
      const buffer = Buffer.from(item.base64, 'base64');
      await fs.mkdir(path.dirname(savePath), { recursive: true });
      await fs.writeFile(savePath, buffer);
      resultSizeBytes = buffer.length;

      return `Successfully bypassed proxy/WAF and downloaded target to workspace/${filename}`;
    } else {
      lastError = "No content found using Apify";
      return lastError;
    }
  } catch (e: any) {
    lastError = e.message;
    return `Error running Apify: ${e.message}`;
  } finally {
    // Log siempre (success o failure) para que el costo quede capturado.
    // await sin await explícito: logApifyUsage no debe bloquear el return.
    void logApifyUsage({
      sessionId,
      targetUrl: url,
      success: lastError === null,
      durationMs: Date.now() - callStart,
      resultSizeBytes,
      errorMessage: lastError,
    });
  }
}
