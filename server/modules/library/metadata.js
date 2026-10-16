import { getPapers } from "../../store.js";
export function zoteroStatus() {
  const papers = getPapers();
  return { syncedAt: papers.zoteroSyncedAt || null, dataDir: papers.zoteroDataDir || null, papers: papers.papers.filter((p) => p.source === "zotero").length };
}
