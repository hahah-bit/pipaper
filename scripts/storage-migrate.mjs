import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
const data = path.resolve(process.env.PIPAPER_DATA_DIR || "data"),
  root = path.join(data, "storage");
const mode = process.argv[2] || "--scan";
if (mode === "--rollback") {
  // Restore only the catalog; original files and pre-migration mirrors are untouched.
  const backup = path.join(
      root,
      "migration-backup",
      "catalog-before-migration.sqlite",
    ),
    target = path.join(root, "catalog.sqlite");
  if (!fs.existsSync(backup)) throw new Error("没有迁移前备份，不能回滚");
  const db = new DatabaseSync(target);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  fs.copyFileSync(target, path.join(root, "catalog-before-rollback.sqlite"));
  fs.copyFileSync(backup, target);
  console.log(
    "已回滚清单。原文件与迁移后清单快照均保留；请使用兼容版本启动应用。",
  );
} else {
  const papersFile = path.join(data, "papers.json");
  const papers = fs.existsSync(papersFile)
    ? JSON.parse(fs.readFileSync(papersFile, "utf8")).papers || []
    : [];
  if (mode === "--scan") {
    const { scanLayout } = await import("../server/storage/scan.js");
    console.log(
      JSON.stringify(
        scanLayout({
          dataDir: data,
          libraryDir: path.resolve(
            process.env.PIPAPER_LIBRARY_DIR || "library",
          ),
          knowledgeDir: path.resolve(
            process.env.PIPAPER_KNOWLEDGE_DIR || "knowledge",
          ),
          papers,
        }),
        null,
        2,
      ),
    );
  } else if (mode === "--apply") {
    const { migrateStorage } = await import("../server/storage/migration.js");
    const { closeCatalog } = await import("../server/storage/catalog.js");
    console.log(JSON.stringify(migrateStorage(papers), null, 2));
    closeCatalog();
  } else
    throw new Error(
      "用法：node scripts/storage-migrate.mjs --scan | --apply | --rollback；回滚前停止应用",
    );
}
