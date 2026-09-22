// Isolated browser acceptance server; never reads or writes the user's Pi account/data.
import fs from "node:fs";
import path from "node:path";
import { studyFixture, mockStudyResponse } from "../tests/helpers/study-fixture.mjs";
const fixture = await studyFixture({ thinkingText: "验收记录：先阅读原文，再核对论断与证据。", respond: (req, text) => {
  if (req.messages.at(-1).role === "user" && text === "调用论文工具") return { tool_calls: [{ index: 0, id: "read-browser", type: "function", function: { name: "read_paper", arguments: JSON.stringify({ mode: "outline" }) } }] };
  return mockStudyResponse(req, text) ?? "已调用 read_paper 阅读论文结构，可以继续讨论。";
} });
const blocksFile = path.join(fixture.parsed, "blocks.json"), parsed = JSON.parse(fs.readFileSync(blocksFile));
parsed.blocks.push({ id: "figure", type: "image", page: 1, caption: "Figure 1. Routing pipeline.", src: "file/figure.png" });
fs.writeFileSync(blocksFile, JSON.stringify(parsed));
fs.writeFileSync(path.join(fixture.parsed, "figure.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64"));
const response = await fetch(fixture.url + "/api/studies/import", { method: "PUT", headers: { "Content-Type": "application/pdf", "X-Filename": "Robust Routing.pdf", "X-Study-Options": encodeURIComponent(JSON.stringify({ goal: "理解鲁棒性训练的主线，找到可验证的 baseline 改进", goalType: "innovate" })) }, body: fixture.pdf });
const task = await response.json();
if (!response.ok) throw new Error(JSON.stringify(task));
// Optional image fixture is a Pi extension that exercises the real extension bridge.
const images = path.join(fixture.data, "fixture-images"); fs.mkdirSync(images, { recursive: true });
const settingsFile = path.join(fixture.agent, "settings.json");
const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, "pi-image-gen": { defaultProvider: "fixture", defaultModel: "fixture", outputDir: images } }));
fs.writeFileSync(path.join(fixture.agent, "extensions", "study-image.js"), `import fs from 'node:fs'; import path from 'node:path';
export default function(pi) { pi.registerTool({ name: 'image_generate', label: 'Fixture image', description: 'Local acceptance image', parameters: { type: 'object', properties: { prompt: {type:'string'}, filename:{type:'string'} }, required:['prompt','filename'] },
  async execute(_id, args) { const file = path.join(${JSON.stringify(images)}, args.filename + '.png'); fs.writeFileSync(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64')); return { content:[{type:'text',text:'Fixture image generated'}],details:{images:[{path:file}]} }; } }); }`);
await fixture.restart();
console.log(JSON.stringify({ url: fixture.url, study: fixture.url + "/study/" + task.id, directory: fixture.directory, taskId: task.id }));
const close = async () => { await fixture.dispose(); process.exit(0); };
process.on("SIGINT", close); process.on("SIGTERM", close);
