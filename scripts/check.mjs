import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(m?js)$/.test(file)) files.push(file);
  }
}
for (const directory of ["src", "server", "shared", "scripts", "tests"]) walk(path.join(root, directory));
const relative = file => path.relative(root, file).replaceAll("\\", "/");
const errors = [], graph = new Map(files.map(file => [file, []]));
for (const file of files) {
  const checked = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (checked.status !== 0) errors.push(relative(file) + ": " + checked.stderr);
  const source = fs.readFileSync(file, "utf8"), name = relative(file);
  // Fixtures contain subprocess programs inside strings, resolved from a
  // different cwd. Boundary analysis covers application modules only.
  if (name.startsWith("tests/") || name.startsWith("scripts/")) continue;
  // Literal static and dynamic imports; computed plugin imports are runtime-owned.
  for (const [, specifier] of source.matchAll(/(?:from\s*|import\s*\(?\s*)["']([^"']+)["']/g)) {
    if (!specifier.startsWith(".")) continue;
    const target = path.resolve(path.dirname(file), specifier), destination = relative(target);
    if (!fs.existsSync(target)) errors.push(`${name}: missing import ${specifier}`);
    if (graph.has(target)) graph.get(file).push(target);
    if (name.startsWith("src/") && destination.startsWith("server/")) errors.push(`${name}: frontend imports server ${destination}`);
    if (name.startsWith("src/") && destination === "src/app.js") errors.push(`${name}: feature imports bootstrap`);
    if (name.startsWith("server/platform/") && /^server\/(modules|topics|study[^/]*\.js|studies\.js)/.test(destination))
      errors.push(`${name}: platform imports business ${destination}`);
    if (name === "server/native-harness.js" && destination === "server/studies.js") errors.push("Pi runtime imports study business");
  }
}

// No frontend cycles: bootstrap supplies callbacks for cross-feature actions.
let next = 0;
const ids = new Map(), low = new Map(), stack = [], pending = new Set();
function visit(file) {
  ids.set(file, next); low.set(file, next++); stack.push(file); pending.add(file);
  for (const target of graph.get(file).filter(value => relative(value).startsWith("src/"))) {
    if (!ids.has(target)) { visit(target); low.set(file, Math.min(low.get(file), low.get(target))); }
    else if (pending.has(target)) low.set(file, Math.min(low.get(file), ids.get(target)));
  }
  if (low.get(file) !== ids.get(file)) return;
  const component = []; let target;
  do { target = stack.pop(); pending.delete(target); component.push(relative(target)); } while (target !== file);
  if (component.length > 1) errors.push("frontend import cycle: " + component.join(" -> "));
}
for (const file of files.filter(value => relative(value).startsWith("src/"))) if (!ids.has(file)) visit(file);
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log(`check ok: ${files.length} JavaScript files; frontend cycles = 0; architecture boundaries passed`);
