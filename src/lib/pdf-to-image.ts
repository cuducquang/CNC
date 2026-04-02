/**
 * PDF → PNG base64 for Next.js server routes.
 *
 * 1) pdftoppm (poppler) when available — fast, used in Docker/Linux.
 * 2) pdfjs-dist + @napi-rs/canvas — all pages on Windows or when poppler is missing.
 * 3) Python microservice /convert-pdf — fallback for Vercel (no poppler, no native canvas).
 *
 * Non-PDF buffers are returned as a single "page" (raw base64).
 */

import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

export function isPdfBuffer(buffer: Buffer): boolean {
  return buffer.length > 4 && buffer.slice(0, 4).toString("ascii") === "%PDF";
}

function maxPdfPages(): number {
  const n = parseInt(process.env.PDF_MAX_PAGES_FOR_VISION || "32", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 64) : 32;
}

function skipFirstPdfPage(): boolean {
  const v = (process.env.PDF_SKIP_FIRST_PAGE || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function naturalPngSort(a: string, b: string): number {
  const na = parseInt(a.replace(/\D/g, "") || "0", 10);
  const nb = parseInt(b.replace(/\D/g, "") || "0", 10);
  return na - nb;
}

/** Render PDF pages to PNG base64 strings via pdftoppm (pages 1..last, capped). */
function pdfViaPoppler(pdfBuffer: Buffer, maxPages: number): string[] {
  const tmpId = `cnc_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const tmpPdf = path.join(os.tmpdir(), `${tmpId}.pdf`);
  const tmpOutPrefix = path.join(os.tmpdir(), tmpId);

  fs.writeFileSync(tmpPdf, pdfBuffer);

  try {
    execFileSync(
      "pdftoppm",
      ["-png", "-r", "150", "-f", "1", "-l", String(maxPages), tmpPdf, tmpOutPrefix],
      { timeout: 120_000 },
    );

    const baseName = path.basename(tmpOutPrefix);
    const outFiles = fs
      .readdirSync(os.tmpdir())
      .filter((f) => f.startsWith(baseName) && f.endsWith(".png"))
      .sort(naturalPngSort);

    if (outFiles.length === 0) throw new Error("pdftoppm produced no PNG output");

    const out: string[] = [];
    for (const f of outFiles) {
      const pngPath = path.join(os.tmpdir(), f);
      out.push(fs.readFileSync(pngPath).toString("base64"));
      fs.unlinkSync(pngPath);
    }
    return out;
  } finally {
    if (fs.existsSync(tmpPdf)) fs.unlinkSync(tmpPdf);
  }
}

/** Render PDF pages with pdfjs + napi canvas (no poppler). */
async function pdfViaPdfJs(pdfBuffer: Buffer, maxPages: number): Promise<string[]> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas } = await import("@napi-rs/canvas");

  const data = new Uint8Array(pdfBuffer);
  const loadingTask = getDocument({
    data,
    useSystemFonts: true,
    standardFontDataUrl: undefined,
  });
  const doc = await loadingTask.promise;
  const numPages = Math.min(doc.numPages, maxPages);
  const out: string[] = [];
  const scale = 150 / 72;

  try {
    for (let i = 1; i <= numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale });
      const w = Math.ceil(viewport.width);
      const h = Math.ceil(viewport.height);
      const canvas = createCanvas(w, h);
      const ctx = canvas.getContext("2d");

      await page.render({
        canvas: null,
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;

      out.push(canvas.toBuffer("image/png").toString("base64"));
      page.cleanup();
    }
  } finally {
    await doc.destroy().catch(() => {});
  }

  return out;
}

function applySkipFirstPage(pages: string[]): string[] {
  if (skipFirstPdfPage() && pages.length > 1) {
    console.log("[pdf-to-image] Skipping PDF page 1 (PDF_SKIP_FIRST_PAGE)");
    return pages.slice(1);
  }
  return pages;
}

/** Convert PDF via the Python microservice (Railway), which has pdftoppm. */
async function pdfViaPythonService(pdfBuffer: Buffer): Promise<string[]> {
  const serviceUrl = (process.env.PYTHON_SERVICE_URL || "").trim();
  if (!serviceUrl) throw new Error("PYTHON_SERVICE_URL not configured");

  const form = new FormData();
  const ab = pdfBuffer.buffer.slice(pdfBuffer.byteOffset, pdfBuffer.byteOffset + pdfBuffer.byteLength) as ArrayBuffer;
  form.append("file", new Blob([ab], { type: "application/pdf" }), "drawing.pdf");

  const response = await fetch(`${serviceUrl}/convert-pdf`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Python service /convert-pdf returned ${response.status}: ${text.slice(0, 200)}`);
  }

  const json = await response.json() as { pages: string[]; count: number };
  if (!Array.isArray(json.pages) || json.pages.length === 0) {
    throw new Error("Python service returned no pages");
  }
  return json.pages;
}

/**
 * Returns one base64 image per PDF page (or a single entry for raster uploads).
 *
 * On Vercel Lambda: pdftoppm is absent and @napi-rs/canvas renders blank pages
 * silently (no error). Skip local methods entirely and delegate to the Python
 * service which has poppler-utils via Docker.
 */
export async function drawingBufferToBase64Pages(buffer: Buffer): Promise<string[]> {
  if (!isPdfBuffer(buffer)) {
    return [buffer.toString("base64")];
  }

  const maxPages = maxPdfPages();
  const onVercel = process.env.VERCEL === "1";

  if (!onVercel) {
    // Local / Docker: try fast native methods first
    try {
      const pages = pdfViaPoppler(buffer, maxPages);
      console.log(`[pdf-to-image] PDF → ${pages.length} page(s) via pdftoppm`);
      return applySkipFirstPage(pages);
    } catch (err) {
      console.warn("[pdf-to-image] pdftoppm failed, trying pdfjs:", (err as Error).message);
    }

    try {
      const pages = await pdfViaPdfJs(buffer, maxPages);
      if (pages.length > 0) {
        console.log(`[pdf-to-image] PDF → ${pages.length} page(s) via pdfjs`);
        return applySkipFirstPage(pages);
      }
    } catch (err2) {
      console.warn("[pdf-to-image] pdfjs render failed, trying Python service:", (err2 as Error).message);
    }
  }

  // Vercel (or local last resort): delegate to Python service (has pdftoppm via Docker)
  try {
    const pages = await pdfViaPythonService(buffer);
    console.log(`[pdf-to-image] PDF → ${pages.length} page(s) via Python service`);
    return applySkipFirstPage(pages);
  } catch (err3) {
    const msg = (err3 as Error).message;
    console.warn("[pdf-to-image] Python service failed:", msg);
    throw new Error(
      `PDF conversion failed: ${msg}. Try uploading a PNG or JPG instead of a PDF.`
    );
  }
}

/**
 * First page only — backward compatible for callers that expect one image.
 */
export async function drawingBufferToBase64(buffer: Buffer): Promise<string> {
  const pages = await drawingBufferToBase64Pages(buffer);
  return pages[0] || "";
}
