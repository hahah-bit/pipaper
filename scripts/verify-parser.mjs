import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readBlocks } from '../server/store.js';
import { versionDir, listVersions } from '../server/parser/versions.js';
import { blocksToMd } from '../server/parser/mdblocks.js';
import { buildPaperTools } from '../server/harness.js';

// Read-only acceptance checks against the installed sample papers and server.
const base = process.env.PIPAPER_URL || 'http://127.0.0.1:4318';
const require = createRequire(import.meta.url);
const canvas = require(require.resolve('@napi-rs/canvas', { paths: [require.resolve('pdfjs-dist/legacy/build/pdf.mjs')] }));
const ids = process.argv.slice(2);
if (!ids.length) ids.push('lib_2b7cb5e628cd', 'zot_2GH8BH44', 'lib_f54c7b32e706');
const tool = buildPaperTools({ id: null }).find((t) => t.name === 'read_paper');
const json = async (url) => { const r = await fetch(base + url); assert.equal(r.status, 200, url); return r.json(); };
const reports = [];
for (const id of ids) {
  const doc = readBlocks(id);
  assert.equal(doc?.v, 4);
  assert.equal(doc.quality.errors.length, 0);
  const dir = versionDir(id, doc.meta.versionId);
  const file = path.join(dir, 'blocks.json');
  const before = fs.readFileSync(file, 'utf8'), mtime = fs.statSync(file).mtimeMs;
  const api = await json(`/api/papers/${id}/blocks`);
  assert.deepEqual(api.blocks, doc.blocks);
  assert.equal(listVersions(id).active, doc.meta.versionId);
  assert.equal(createHash('sha256').update(blocksToMd(doc.blocks)).digest('hex'), doc.meta.contentHash);
  const outline = await tool.execute('qa', { paper_id: id, mode: 'outline' });
  assert.ok(outline.content[0].text.includes(doc.meta.versionId));
  const heading = doc.blocks.find((b) => b.type === 'heading' && /^(?:\d+|[IVX]+)[.\s]/.test(b.text)) || doc.blocks.find((b) => b.type === 'heading');
  const section = await tool.execute('qa', { paper_id: id, mode: 'section', query: heading.text, max_chars: 80000 });
  assert.ok(section.content[0].text.includes(heading.id));
  assert.ok(section.content[0].text.includes(doc.meta.versionId));
  const attachment = await json('/api/file?path=' + encodeURIComponent(`paper:${id}/version/${doc.meta.versionId}/full.md`));
  assert.ok(attachment.content.includes(doc.meta.versionId));
  const figure = doc.blocks.find((b) => b.type === 'image' && b.src);
  if (figure) {
    const asset = await fetch(base + `/api/papers/${id}/${figure.src}`);
    assert.equal(asset.status, 200);
    assert.ok((await asset.arrayBuffer()).byteLength > 100);
    const image = await json('/api/file?path=' + encodeURIComponent(`paper:${id}/asset/${figure.src.replace(/^file\//, '')}`));
    assert.equal(image.kind, 'image');
  }
  const cropBlock = doc.blocks.find((b) => b.type === 'code') || heading;
  const crop = await fetch(base + `/api/papers/${id}/regions/${cropBlock.id}?version=${doc.meta.versionId}`);
  assert.equal(crop.status, 200);
  const bytes = Buffer.from(await crop.arrayBuffer());
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  assert.ok(bytes.length > 2000);
  const image = await canvas.loadImage(bytes);
  const surface = canvas.createCanvas(image.width, image.height);
  const ctx = surface.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
  let ink = 0;
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i] + pixels[i + 1] + pixels[i + 2] < 600 && pixels[i + 3] > 0) ink++;
  assert.ok(ink / (image.width * image.height) > 0.005, 'source crop is blank');
  for (const code of doc.blocks.filter((b) => b.algorithm && b.type === 'code')) {
    assert.equal(code.text.split('\n').length, code.lineCount);
    const header = doc.blocks.find((b) => b.algorithm && b.type === 'heading' && b.page === code.page);
    const context = await tool.execute('qa', { paper_id: id, mode: 'section', query: header.text, max_chars: 80000 });
    assert.ok(context.content[0].text.includes(code.text));
  }
  assert.equal(fs.statSync(file).mtimeMs, mtime);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  reports.push({ id, version: doc.meta.versionId, pages: doc.pages.length, blocks: doc.blocks.length, warnings: doc.quality.warnings.length, repairedContinuations: doc.blocks.filter((b) => b.provenance.repair === 'exact-page-continuation').length, doubleColumnPages: doc.pages.filter((p) => p.layout === 'double').length, readOnly: true, piMatchesReader: true, cropsAndAssets: 'pass' });
}
const files = await json('/api/files');
assert.ok(files.files.some((f) => f.path.includes('/version/')));
const pomo = ids.includes('zot_2GH8BH44') && readBlocks('zot_2GH8BH44');
if (pomo) {
  assert.equal(pomo.blocks.find((b) => b.type === 'heading' && b.text.startsWith('6 Conclusion')).page, 9);
  assert.equal(pomo.blocks.find((b) => b.type === 'heading' && b.text.startsWith('5.1')).page, 7);
  assert.ok(pomo.blocks.some((b) => b.page === 8 && b.issues.includes('table-numeric-mismatch')));
}
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), checks: 'passed', reports }, null, 2));
