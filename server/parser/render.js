// Server-side PDF rasterization via pdf.js legacy + the @napi-rs/canvas copy
// that ships INSIDE pdfjs-dist (must be the same native module instance —
// mixing two copies crashes natively).
// Used by the fallback element extractor (figure crops) and the agent's
// get_paper_pages tool (page images for vision models).

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const PDFJS_ENTRY = require.resolve("pdfjs-dist/legacy/build/pdf.mjs");
// resolve @napi-rs/canvas from pdfjs-dist's own node_modules
const napi = require(require.resolve("@napi-rs/canvas", { paths: [PDFJS_ENTRY] }));

let globalsReady = false;
function ensureGlobals() {
  if (globalsReady) return;
  globalThis.Path2D ||= napi.Path2D;
  globalThis.ImageData ||= napi.ImageData;
  globalThis.DOMMatrix ||= napi.DOMMatrix;
  globalThis.Image ||= napi.Image;
  globalsReady = true;
}

let pdfjsMod = null;
async function getPdfjs() {
  if (!pdfjsMod) {
    ensureGlobals();
    pdfjsMod = await import("pdfjs-dist/legacy/build/pdf.mjs");
  }
  return pdfjsMod;
}

export function canvasAvailable() {
  return true;
}

let fontsUrl;
function getFontsUrl() {
  if (fontsUrl === undefined) {
    const dir = path.join(process.cwd(), "node_modules", "pdfjs-dist", "standard_fonts");
    // NodeStandardFontDataFactory reads filesystem paths, not file:// strings.
    fontsUrl = fs.existsSync(dir) ? dir + path.sep : null;
  }
  return fontsUrl;
}

const docs = new Set();

export async function openDocument(pdfPath) {
  const pdfjs = await getPdfjs();
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjs.getDocument({
    data,
    useSystemFonts: false,
    disableFontFace: true,
    isEvalSupported: false,
    standardFontDataUrl: getFontsUrl(),
  }).promise;
  docs.add(doc);
  return doc;
}

export function closeDocument(doc) {
  try {
    doc?.destroy?.();
  } catch {}
  docs.delete(doc);
}

// Render one page; caller must call r.cleanup() and then closeDocument(doc).
export async function renderPage(doc, pageNo, scale = 2) {
  const page = await doc.getPage(pageNo);
  const viewport = page.getViewport({ scale });
  const canvas = napi.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return {
    page,
    canvas,
    viewport,
    width: canvas.width,
    height: canvas.height,
    toPngBuffer: () => canvas.toBuffer("image/png"),
    cleanup: () => page.cleanup?.(),
  };
}

// Render a sub-rectangle (viewport-space bbox at scale 1, top-left origin).
export async function renderPageCrop(pdfPath, pageNo, bbox, { scale = 2, minW = 0, minH = 0 } = {}) {
  const doc = await openDocument(pdfPath);
  try {
    const page = await doc.getPage(pageNo);
    const viewport = page.getViewport({ scale });
    const sx = Math.max(0, Math.floor(bbox[0] * scale));
    const sy = Math.max(0, Math.floor(bbox[1] * scale));
    const sw = Math.min(Math.ceil((bbox[2] - bbox[0]) * scale), Math.ceil(viewport.width) - sx);
    const sh = Math.min(Math.ceil((bbox[3] - bbox[1]) * scale), Math.ceil(viewport.height) - sy);
    if (sw < minW || sh < minH || sw < 8 || sh < 8) return null;
    const canvas = napi.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const out = napi.createCanvas(sw, sh);
    out.getContext("2d").drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    return { buffer: await out.encode("png"), width: sw, height: sh };
  } finally {
    closeDocument(doc);
  }
}
