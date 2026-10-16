import fs from "node:fs";
import path from "node:path";
import { fault } from "../errors.js";

export function inside(root, relative) {
  const file = path.resolve(root, String(relative));
  const rel = path.relative(path.resolve(root), file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw fault("路径越界");
  // Refuse linked ancestors as well as lexical traversal.
  let cursor = file;
  while (cursor !== path.resolve(root)) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw fault("不支持符号链接");
    cursor = path.dirname(cursor);
  }
  return file;
}
