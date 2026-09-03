import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { TMP_DIR, fileHash } from "./store.js";

// Zotero integration via a sqlite snapshot of <dataDir>/zotero.sqlite.
// Works whether or not Zotero is running (WAL files are copied alongside).

export function detectDataDir(cfgDir) {
  const candidates = [];
  if (cfgDir) candidates.push(cfgDir);
  // Zotero profile prefs.js records the actual data dir if it was moved
  try {
    const appData = process.env.APPDATA;
    const profRoot = path.join(appData || "", "Zotero", "Zotero", "Profiles");
    for (const prof of fs.existsSync(profRoot) ? fs.readdirSync(profRoot) : []) {
      const prefs = path.join(profRoot, prof, "prefs.js");
      if (!fs.existsSync(prefs)) continue;
      const m = fs.readFileSync(prefs, "utf8").match(/extensions\.zotero\.dataDir",\s*"([^"]+)"/);
      if (m) candidates.push(m[1].replace(/\\\\/g, "\\"));
    }
  } catch {}
  candidates.push(path.join(os.homedir(), "Zotero"));
  candidates.push(path.join(os.homedir(), ".zotero", "Zotero")); // linux-ish layout
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, "zotero.sqlite"))) return c;
  }
  return null;
}

function snapshotDb(dataDir) {
  const stamp = Date.now();
  const copy = path.join(TMP_DIR, `zotero-${stamp}.sqlite`);
  fs.copyFileSync(path.join(dataDir, "zotero.sqlite"), copy);
  for (const ext of ["-wal", "-shm"]) {
    const src = path.join(dataDir, "zotero.sqlite" + ext);
    if (fs.existsSync(src)) {
      try {
        fs.copyFileSync(src, copy + ext);
      } catch {}
    }
  }
  return copy;
}

const FIELD_QUERY = `SELECT f.fieldName AS name, v.value AS value
  FROM itemData d JOIN fields f ON d.fieldID=f.fieldID
  JOIN itemDataValues v ON d.valueID=v.valueID WHERE d.itemID=?`;

function findPdfAttachment(db, dataDir, itemID) {
  const rows = db.prepare(
    `SELECT ia.itemID AS attID, i.key AS attKey, ia.path AS p, ia.linkMode AS lm, ia.contentType AS ct
     FROM itemAttachments ia JOIN items i ON ia.itemID=i.itemID
     LEFT JOIN deletedItems d ON d.itemID=ia.itemID
     WHERE ia.parentItemID=? AND d.itemID IS NULL AND ia.linkMode IN (0,1)`
  ).all(itemID);
  let best = null;
  for (const r of rows) {
    let p = null;
    if (r.lm === 0 && r.p && r.p.startsWith("storage:")) {
      p = path.join(dataDir, "storage", r.attKey, r.p.slice("storage:".length));
    } else if (r.lm === 1 && r.p) {
      p = r.p.replace(/^attachments?:/, "");
      if (!path.isAbsolute(p)) p = path.join(dataDir, p);
    }
    if (!p) continue;
    const isPdf = /\.pdf$/i.test(p) || (r.ct || "").includes("pdf");
    if (!isPdf || !fs.existsSync(p)) continue;
    const size = fs.statSync(p).size;
    if (!best || (size > best.size)) best = { path: p, size, attKey: r.attKey };
  }
  return best;
}

export function syncZotero(cfg) {
  const dataDir = detectDataDir(cfg?.dataDir);
  if (!dataDir) {
    throw new Error("未找到 Zotero 数据目录（zotero.sqlite）。请在设置中指定，例如 C:\\Users\\fbl\\Zotero");
  }
  const dbFile = snapshotDb(dataDir);
  let db;
  try {
    db = new DatabaseSync(dbFile, { readOnly: false });

    const collections = db
      .prepare(`SELECT collectionID AS id, collectionName AS name, parentCollectionID AS parentId FROM collections`)
      .all()
      .map((c) => ({ id: c.id, key: "C" + c.id, name: c.name, parentId: c.parentId ?? null }));

    const collMap = {}; // itemID -> [collectionID]
    for (const r of db.prepare(`SELECT itemID, collectionID FROM collectionItems`).all()) {
      (collMap[r.itemID] ||= []).push(r.collectionID);
    }

    const SKIP_TYPES = new Set(["attachment", "note", "annotation"]);
    const typeRows = db.prepare(`SELECT itemTypeID, typeName FROM itemTypes`).all();
    const typeName = Object.fromEntries(typeRows.map((t) => [t.itemTypeID, t.typeName]));

    const items = db
      .prepare(
        `SELECT i.itemID AS id, i.key AS key, i.itemTypeID AS tid
         FROM items i LEFT JOIN deletedItems d ON i.itemID=d.itemID
         WHERE d.itemID IS NULL`
      )
      .all();

    const creatorsStmt = db.prepare(
      `SELECT c.firstName AS fn, c.lastName AS ln, c.fieldMode AS fm, ic.orderIndex AS ord
       FROM itemCreators ic JOIN creators c ON ic.creatorID=c.creatorID
       WHERE ic.itemID=? ORDER BY ic.orderIndex`
    );

    const papers = [];
    for (const it of items) {
      const t = typeName[it.tid];
      if (!t || SKIP_TYPES.has(t)) continue;
      const fields = {};
      for (const f of db.prepare(FIELD_QUERY).all(it.id)) fields[f.name] = f.value;
      if (!fields.title && !fields.shortTitle) continue;
      const creators = creatorsStmt.all(it.id).map((c) =>
        c.fm === 1 ? c.ln : `${c.ln || ""}${c.fn ? " " + c.fn : ""}`.trim()
      );
      const date = fields.date || "";
      const year = (date.match(/(\d{4})/) || [])[1] ? Number((date.match(/(\d{4})/))[1]) : null;
      const att = findPdfAttachment(db, dataDir, it.id);
      papers.push({
        id: "zot_" + it.key,
        zoteroKey: it.key,
        itemType: t,
        title: fields.title || fields.shortTitle,
        creators,
        year,
        doi: fields.doi || "",
        url: fields.url || "",
        publication: fields.publicationTitle || fields.proceedingsTitle || "",
        abstract: fields.abstractNote || "",
        collectionIds: collMap[it.id] || [],
        source: "zotero",
        pdfPath: att ? att.path : null,
        contentHash: att ? fileHash(att.path) : null,
        added: fields.dateAdded || null,
      });
    }

    return { items: papers, collections, syncedAt: new Date().toISOString(), dataDir };
  } finally {
    try {
      db?.close();
    } catch {}
    try {
      fs.rmSync(dbFile, { force: true });
      fs.rmSync(dbFile + "-wal", { force: true });
      fs.rmSync(dbFile + "-shm", { force: true });
    } catch {}
  }
}
