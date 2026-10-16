import fs from "node:fs";
import path from "node:path";
export function scanLayout({ dataDir, libraryDir, knowledgeDir, papers = [] }) {
  const files = [],
    warnings = [];
  const scan = (root, kind, owner = null) => {
    if (!fs.existsSync(root)) return;
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      const file = path.join(root, e.name);
      if (e.isSymbolicLink()) {
        warnings.push({ file, issue: "linked-path" });
        continue;
      }
      if (e.isDirectory()) scan(file, kind, owner);
      else files.push({ file, kind, owner });
    }
  };
  for (const p of papers) {
    files.push({
      file: p.pdfPath,
      id: "paper:" + p.id,
      kind: "original",
      title: p.title,
      sourceType: "original",
      paperId: p.id,
      versionId: p.contentHash,
      owned: p.source !== "zotero",
      metadata: p,
    });
    const key = p.contentHash ? "h_" + p.contentHash.slice(0, 24) : p.id;
    scan(path.join(dataDir, "parsed", key), "parsed", "parse:" + key);
  }
  scan(libraryDir, "original");
  scan(knowledgeDir, "knowledge");
  for (const [folder, kind] of [
    ["studies", "study"],
    ["study-papers", "original"],
    ["topic-analysis", "topic"],
    ["archify", "diagram"],
    ["tmp", "temporary"],
    ["backups", "backup"],
    ["qa", "qa"],
    ["parsed", "parsed"],
  ])
    scan(path.join(dataDir, folder), kind);
  const unique = [
    ...new Map(
      files
        .filter((v) => v.file)
        .reverse()
        .map((v) => [path.resolve(v.file), v]),
    ).values(),
  ];
  const missing = files.filter((v) => !v.file || !fs.existsSync(v.file)),
    damaged = [];
  for (const item of unique)
    if (
      item.kind === "original" &&
      /\.pdf$/i.test(item.file) &&
      !item.paperId
    ) {
      item.availability = "needs_review";
      item.orphan = true;
      warnings.push({ file: item.file, issue: "unassigned-original" });
    }
  for (const v of unique)
    if (/\.json$/i.test(v.file))
      try {
        JSON.parse(fs.readFileSync(v.file, "utf8"));
      } catch {
        damaged.push({ ...v, issue: "damaged-json" });
      }
  return {
    schemaVersion: 2,
    scannedAt: new Date().toISOString(),
    counts: unique.reduce(
      (v, item) => ((v[item.kind] = (v[item.kind] || 0) + 1), v),
      {},
    ),
    files: unique,
    missing,
    damaged,
    warnings,
  };
}
