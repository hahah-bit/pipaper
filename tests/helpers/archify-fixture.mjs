import fs from "node:fs";
import path from "node:path";

export const archifySpec = {
  schema_version: 1, diagram_type: "architecture",
  meta: { title: "网站请求流程 · 接入示例", locale: "zh-CN", quality_profile: "showcase", viewBox: [960, 440] },
  components: [
    { id: "browser", type: "frontend", label: "浏览器", pos: [60, 170], size: [160, 72] },
    { id: "api", type: "backend", label: "API 服务", pos: [400, 170], size: [160, 72] },
    { id: "database", type: "database", label: "数据库", pos: [740, 170], size: [160, 72] },
  ],
  connections: [
    { id: "request", from: "browser", to: "api", label: "HTTP 请求" },
    { id: "query", from: "api", to: "database", label: "查询" },
  ],
  cards: [{ dot: "cyan", title: "示例说明", items: ["浏览器向 API 请求数据，API 查询数据库。", "这是接入演示，不代表当前论文的方法。"] }],
};

export function fakeArchify(directory) {
  const dir = path.join(directory, "archify-installation");
  for (const folder of ["bin", "schemas", "examples"]) fs.mkdirSync(path.join(dir, folder), { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), '---\nname: archify\nmetadata:\n  version: "test"\n---');
  fs.writeFileSync(path.join(dir, "schemas/common.schema.json"), JSON.stringify({ $defs: { test: {} } }));
  fs.writeFileSync(path.join(dir, "schemas/architecture.schema.json"), JSON.stringify({ type: "object", required: ["components"] }));
  fs.writeFileSync(path.join(dir, "examples/web-app.architecture.json"), JSON.stringify(archifySpec));
  fs.writeFileSync(path.join(dir, "bin/archify.mjs"), `import fs from 'node:fs';
    const [command, type, input, output] = process.argv.slice(2);
    const spec = JSON.parse(fs.readFileSync(input, 'utf8'));
    if (!spec.components?.length) { console.log(JSON.stringify({ ok: false, diagnostics: [{ rule: 'empty-components', subject: 'components' }] })); process.exit(1); }
    if (spec.meta.title === 'slow diagram') await new Promise(r => setTimeout(r, 3000));
    fs.writeFileSync(output, '<!doctype html><html lang="zh-CN"><title>Archify test</title><body><h1>网站请求流程</h1><svg><text x="10" y="30">浏览器 → API → 数据库</text></svg></body></html>');
    console.log(JSON.stringify({ ok: true, command, type, checks: 9 }));`);
  return dir;
}

export function archifyModelResponse(request, text) {
  if (request.messages.at(-1)?.role !== "user") return "图解工具调用完成，请查看 Archify 图解面板。";
  const action = text.includes("help diagram") ? "help" : text.includes("read diagram") ? "read" : "render";
  const spec = structuredClone(archifySpec);
  if (text.includes("invalid diagram")) spec.components = [];
  if (text.includes("slow diagram")) spec.meta.title = "slow diagram";
  return { tool_calls: [{ index: 0, id: "archify-call", type: "function", function: { name: "archify", arguments: JSON.stringify({ action, type: "architecture", ...(action === "render" ? { spec: JSON.stringify(spec), prompt: text } : {}) }) } }] };
}
