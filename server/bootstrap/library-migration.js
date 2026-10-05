import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import { listPapers, attachHash } from "../store.js";
import { relocate } from "../storage/files.js";
export function migrateLibrary() {
  const moved = [];
  for (const p of listPapers()) {
    if (!p.pdfPath || !fs.existsSync(p.pdfPath)) continue;
    const before = p.contentHash;
    attachHash(p);
    if (!before && p.contentHash) {
      const oldDir = path.join(DATA_DIR, "parsed", p.id);
      const newDir = path.join(DATA_DIR, "parsed", "h_" + p.contentHash.slice(0, 24));
      if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
        try {
          relocate(oldDir, newDir);
          moved.push(p.id);
        } catch {}
      }
    }
  }
  if (moved.length) console.log(`[migrate] parse cache re-keyed for ${moved.length} papers`);
}
