import { writeFile as managedWrite, trashPath, registerTree, commitDirectory, registerFile } from "./storage/files.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { DATA_DIR, getConfig, saveConfig } from "./config.js";
import { sessionMeta } from "./store.js";
import { inside, listTasks, readTask, saveTask, taskDir } from "./study-store.js";

export const ARCHIFY_TYPES = ["architecture", "workflow", "sequence", "dataflow", "lifecycle"];
const examples = { architecture: "web-app.architecture.json", workflow: "agent-tool-call.workflow.json", sequence: "cache-miss-request.sequence.json", dataflow: "event-stream.dataflow.json", lifecycle: "agent-run.lifecycle.json" };
const ROOT = path.join(DATA_DIR, "archify");
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const json = file => JSON.parse(fs.readFileSync(file, "utf8"));
const active = task => !["deleting", "delete-failed"].includes(task.status);

// Use the upstream installation in place; no renderer copies or extra service.
export function archifyStatus() {
  const configured = process.env.PIPAPER_ARCHIFY_DIR || getConfig().archify?.path;
  const candidates = configured ? [configured] : [
    path.join(os.homedir(), ".agents/skills/archify"),
    path.join(os.homedir(), ".pi/agent/skills/archify"),
  ];
  for (const candidate of candidates) for (const dir of [path.resolve(candidate), path.resolve(candidate, "archify")]) {
    if (["bin/archify.mjs", "SKILL.md", "schemas/common.schema.json"].every(file => fs.existsSync(path.join(dir, file)))) {
      const skill = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
      return { ready: true, path: dir, version: skill.match(/version:\s*["']?([^\s"']+)/)?.[1] || "unknown", types: ARCHIFY_TYPES };
    }
  }
  return { ready: false, path: configured || "", types: ARCHIFY_TYPES, error: "尚未连接 Archify，请设置已有仓库或技能目录。" };
}
function installation() {
  const status = archifyStatus();
  if (!status.ready) throw fail(status.error, 503);
  return status.path;
}
function validType(type) {
  if (!ARCHIFY_TYPES.includes(type)) throw fail("不支持的图解类型");
  return type;
}
export function archifyHelp(type = "architecture") {
  validType(type);
  const dir = installation();
  return {
    type,
    instructions: "根据用户需求和已读取的论文证据编写新 JSON，不要复制示例事实。默认中文、静态、classic；meta.locale=zh-CN，meta.quality_profile=showcase。最多 12 个主节点，先用自动路由。新 workflow 使用 schema_version=2。调用 archify action=render，spec 传完整 JSON 字符串。失败仅按 diagnostics 的 subject、evidence、supportedFixes 修复；两轮不改善则报告，不伪称成功。修改已有图先 action=read，再提交完整的新版本，旧版本保留。论文未说明的内容标为假设，出处放说明卡片。",
    schema: json(path.join(dir, "schemas", `${type}.schema.json`)),
    common: json(path.join(dir, "schemas/common.schema.json")),
    example: json(path.join(dir, "examples", examples[type])),
  };
}
function baseFor(studyId) {
  if (!studyId) return ROOT;
  const task = readTask(studyId);
  if (!active(task)) throw fail("研读任务正在删除，无法读取或生成图解", 409);
  return path.join(taskDir(studyId), "assets", "archify");
}
function artifactDir(id, studyId) {
  if (!/^[a-f0-9-]{36}$/.test(id || "")) throw fail("无效的图解 ID");
  return inside(baseFor(studyId), id);
}
function publicItem(item) {
  const base = `/api/archify/artifacts/${item.id}`;
  const query = item.studyId ? `?studyId=${encodeURIComponent(item.studyId)}` : "";
  return { ...item, previewUrl: `${base}/diagram.html${query}`, sourceUrl: `${base}/source.json${query}`, receiptUrl: `${base}/receipt.json${query}` };
}
export function listArchify({ paperId, sessionId, studyId } = {}) {
  const scopes = studyId ? [studyId] : [null, ...listTasks().filter(active).map(t => t.id)];
  const items = [];
  for (const scope of scopes) {
    const base = baseFor(scope);
    if (!fs.existsSync(base)) continue;
    for (const id of fs.readdirSync(base)) {
      if (!/^[a-f0-9-]{36}$/.test(id)) continue;
      try {
        const item = json(path.join(artifactDir(id, scope), "meta.json"));
        if ((!paperId || item.paperId === paperId) && (!sessionId || item.sessionId === sessionId)) items.push(publicItem(item));
      } catch { /* An interrupted candidate is never a published artifact. */ }
    }
  }
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function readArchify(id, studyId) {
  const dir = artifactDir(id, studyId);
  if (!fs.existsSync(path.join(dir, "meta.json"))) throw fail("图解不存在", 404);
  return { ...publicItem(json(path.join(dir, "meta.json"))), spec: json(path.join(dir, "source.json")) };
}
function runCli(dir, args, signal) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(dir, "bin/archify.mjs"), ...args], {
      cwd: dir, windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024, signal,
      env: { ...process.env, ARCHIFY_UPDATE_CHECK_DISABLED: "1" },
    }, (error, stdout, stderr) => {
      if (signal?.aborted || error?.name === "AbortError") return reject(fail("图解生成已取消", 409));
      let receipt;
      try { receipt = JSON.parse(stdout); } catch {}
      if (error || !receipt) return resolve({ ok: false, error: error?.killed ? "Archify 生成超时" : "Archify 校验未通过", diagnostics: receipt || { message: String(stderr || error?.message || stdout).slice(0, 6000) } });
      resolve({ ok: true, receipt });
    });
  });
}
export async function renderArchify({ type, spec, prompt = "" }, owner = {}, signal) {
  validType(type);
  const dir = installation();
  const source = typeof spec === "string" ? spec : JSON.stringify(spec);
  if (!source || Buffer.byteLength(source) > 1024 * 1024) throw fail("图解 JSON 不能为空或超过 1 MB");
  let parsed;
  try { parsed = JSON.parse(source); } catch { throw fail("图解源数据不是有效 JSON"); }
  if (parsed?.diagram_type !== type || !parsed.meta?.title) throw fail("图解类型或标题与源数据不一致");
  if (parsed.meta.quality_profile !== "showcase") throw fail("请设置 meta.quality_profile=showcase 后生成");
  if (signal?.aborted) throw fail("图解生成已取消", 409);
  baseFor(owner.studyId); // Refuse deleted tasks before starting the CLI.
  const pending = path.join(ROOT, ".pending"); fs.mkdirSync(pending, { recursive: true });
  const id = randomUUID(), temp = inside(pending, id);
  fs.mkdirSync(temp);
  try {
    managedWrite(path.join(temp, "source.json"), source);
    const result = await runCli(dir, ["deliver", type, path.join(temp, "source.json"), path.join(temp, "diagram.html"), "--quality", "showcase", "--json"], signal);
    if (!result.ok) return result;
    if (signal?.aborted) throw fail("图解生成已取消", 409);
    if (!fs.existsSync(path.join(temp, "diagram.html"))) throw fail("Archify 没有输出 HTML", 500);
    // No await between rechecking the task and publishing: deletion cannot race
    // with commit or recreate a task after its files have been removed.
    const destination = artifactDir(id, owner.studyId);
    const task = owner.studyId ? readTask(owner.studyId) : null;
    const item = { id, type, title: parsed.meta.title, createdAt: new Date().toISOString(),
      paperId: owner.paperId || null, sessionId: owner.sessionId || null, studyId: owner.studyId || null,
      prompt: String(prompt).slice(0, 16000), versionId: task?.versionId || null };
    managedWrite(path.join(temp, "receipt.json"), JSON.stringify(result.receipt, null, 2));
    managedWrite(path.join(temp, "meta.json"), JSON.stringify(item, null, 2));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    registerTree(temp,{kind:"diagram",owner:owner.studyId?"study:"+owner.studyId:owner.sessionId?"session:"+owner.sessionId:null,expiresAt:null});
    commitDirectory(temp,destination);
    registerFile(destination,{id:"diagram:"+id,kind:"diagram",title:item.title,owner:owner.studyId?"study:"+owner.studyId:owner.sessionId?"session:"+owner.sessionId:null,metadata:item,expiresAt:null});
    if (task) {
      task.artifacts.push({ id, kind: "archify", label: item.title, file: `assets/archify/${id}/diagram.html`, prompt: item.prompt, at: item.createdAt });
      try { saveTask(task); } catch (error) { trashPath(destination); throw error; }
    }
    return { ok: true, artifact: publicItem(item) };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

export function archifyTool(idHolder) {
  return defineTool({
    name: "archify", label: "Archify 图解",
    description: "生成可交互的架构图、流程图、时序图、数据流图或状态图。先 help(type) 获取上游 schema/示例，再 render(type,spec,prompt) 校验生成；list 查已有图，read(id) 读取源文件以修改。成功返回 HTML 预览/下载和 JSON 源链接，失败返回真实校验诊断。",
    parameters: Type.Object({
      action: Type.Union(["help", "render", "list", "read"].map(v => Type.Literal(v))),
      type: Type.Optional(Type.Union(ARCHIFY_TYPES.map(v => Type.Literal(v)))),
      spec: Type.Optional(Type.String({ description: "完整的 Archify Typed JSON 字符串，仅 render 必填" })),
      id: Type.Optional(Type.String()),
      prompt: Type.Optional(Type.String({ description: "本次图解需求和论文出处" })),
    }),
    execute: async (_callId, args, signal) => {
      try {
        const meta = sessionMeta(idHolder.id) || {};
        const owner = { sessionId: idHolder.id, paperId: meta.paperId, studyId: meta.studyId };
        let result;
        if (args.action === "help") result = archifyHelp(args.type);
        else if (args.action === "list") result = { artifacts: listArchify(meta.studyId ? { studyId: meta.studyId } : { paperId: meta.paperId, sessionId: meta.paperId ? undefined : idHolder.id }) };
        else if (args.action === "read") result = readArchify(args.id, meta.studyId);
        else result = await renderArchify(args, owner, signal);
        // Pi marks a tool as failed only when execute throws; returning an
        // isError property is ignored by its native tool executor.
        if (result.ok === false) throw new Error(JSON.stringify(result));
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      } catch (error) {
        throw error;
      }
    },
  });
}

export function registerArchifyRoutes(api) {
  const route = fn => async (req, res) => { try { await fn(req, res); } catch (error) { res.status(error.status || 400).json({ error: error.message }); } };
  api.get("/archify/status", route((_req, res) => res.json(archifyStatus())));
  api.put("/archify/config", route((req, res) => {
    const dir = String(req.body?.path || "").trim();
    if (dir && !path.isAbsolute(dir)) throw fail("请输入 Archify 的绝对目录");
    saveConfig({ archify: { path: dir } }); res.json(archifyStatus());
  }));
  api.get("/archify/artifacts", route((req, res) => res.json({ artifacts: listArchify(req.query) })));
  api.get("/archify/artifacts/:id/:file", route((req, res) => {
    if (!["diagram.html", "source.json", "receipt.json"].includes(req.params.file)) throw fail("文件不存在", 404);
    readArchify(req.params.id, req.query.studyId);
    const file = inside(artifactDir(req.params.id, req.query.studyId), req.params.file);
    if (req.query.download === "1") return res.download(file);
    if (req.params.file === "diagram.html") {
      res.set("Content-Security-Policy", "sandbox allow-scripts allow-downloads; default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'");
      res.set("X-Content-Type-Options", "nosniff");
    }
    res.sendFile(file);
  }));
}
