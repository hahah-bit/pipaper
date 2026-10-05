import path from "node:path";
export function safeJoin(base, rel) {
  const target = path.resolve(base, rel);
  const relative = path.relative(path.resolve(base), target);
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative) ? target : null;
}
