// Clipboard history: captures text selections/copies inside the app.
// Entries auto-expire after 2 days (pruned on access + on a timer).
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";

const FILE = path.join(DATA_DIR, "clipboard.json");
const TTL_MS = 2 * 24 * 60 * 60 * 1000; // 2 days
let entries = [];

function load() {
  try {
    entries = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    entries = [];
  }
}
load();

function prune() {
  const cutoff = Date.now() - TTL_MS;
  const before = entries.length;
  entries = entries.filter((e) => e.at >= cutoff);
  if (entries.length !== before) persist();
  return before - entries.length;
}

function persist() {
  fs.writeFileSync(FILE, JSON.stringify(entries, null, 1));
}

setInterval(prune, 6 * 60 * 60 * 1000).unref?.();

export function clipAdd(text) {
  text = String(text || "").trim();
  if (!text) return null;
  prune();
  const dup = entries.find((e) => e.text === text);
  if (dup) {
    dup.at = Date.now();
    persist();
    return dup;
  }
  const e = { id: "cl_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), text: text.slice(0, 20000), at: Date.now() };
  entries.unshift(e);
  if (entries.length > 300) entries.length = 300;
  persist();
  return e;
}

export function clipList() {
  prune();
  return entries;
}

export function clipDelete(id) {
  entries = entries.filter((e) => e.id !== id);
  persist();
}

export function clipClear() {
  entries = [];
  persist();
}
