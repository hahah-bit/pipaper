import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export async function nativeHttpFixture({ port = 0 } = {}) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pipaper-http-"));
  const agent = path.join(directory, "agent"), data = path.join(directory, "data");
  fs.mkdirSync(path.join(agent, "extensions"), { recursive: true }); fs.mkdirSync(data);
  let retryCalls = 0; const modelRequests = [];
  const mock = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    let request; try { request = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
    modelRequests.push(request);
    const last = request.messages?.at(-1);
    const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content);
    if (text?.includes("retry-once") && retryCalls++ === 0) {
      res.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "Local fixture temporarily unavailable" } })); return;
    }
    if (text?.includes("slow")) await new Promise(r => setTimeout(r, 800));
    const delta = request.tools?.length && last?.role === "user" && text?.includes("ask-choice")
      ? { tool_calls: [{ index: 0, id: "choice-1", type: "function", function: { name: "request_user_input", arguments: JSON.stringify({ kind: "select", title: "选择阅读方式", options: ["摘要", "精读"] }) } }] }
      : { content: "论文阅读验证完成。\\n关键公式：$E=mc^2$。".replace("\\n", "\n") };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (content, finish_reason = null) => ({ id: "mock-completion", object: "chat.completion.chunk", created: 1, model: "native-test", choices: [{ index: 0, delta: content, finish_reason }] });
    res.write(`data: ${JSON.stringify(chunk({ role: "assistant", ...delta }))}\n\n`);
    res.write(`data: ${JSON.stringify({ ...chunk({}, delta.tool_calls ? "tool_calls" : "stop"), usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise(r => mock.listen(0, "127.0.0.1", r));
  const modelPort = mock.address().port;
  fs.writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${modelPort}/v1`, api: "openai-completions", apiKey: "test-only", models: [{ id: "native-test", name: "本地验收模型", input: ["text", "image"], reasoning: true, contextWindow: 10000, maxTokens: 1000, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }] } } }));
  fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "mock", defaultModel: "native-test", compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: true, baseDelayMs: 10, maxRetries: 2 } }));
  fs.writeFileSync(path.join(agent, "extensions", "audit.js"), `export default function(pi) {
    let count = 0;
    pi.registerCommand("audit-name", { description: "验证扩展隔离与原生命名", handler: () => pi.setSessionName("审计会话 " + (++count)) });
    pi.registerCommand("audit-input", { description: "验证扩展弹窗和输入框", handler: async (_args, ctx) => {
      const answer = await ctx.ui.select("扩展选择", ["摘要", "精读"]);
      ctx.ui.setStatus("audit", "选择：" + (answer || "取消"));
      ctx.ui.setWidget("阅读进度", ["扩展已接通", "等待下一条任务"]);
      ctx.ui.setEditorText(answer || "已取消");
      pi.sendMessage({ customType: "阅读记录", content: "选择结果：" + (answer || "取消"), display: true });
    } });
    pi.registerCommand("audit-new", { description: "验证原生新建", handler: (_args, ctx) => ctx.newSession() });
  }`);
  fs.writeFileSync(path.join(data, "config.json"), JSON.stringify({ zotero: { enabled: false } }));
  fs.writeFileSync(path.join(data, "papers.json"), JSON.stringify({ papers: [{ id: "fixture-paper", title: "本地验收论文", authors: ["PiPaper"], source: "local" }], collections: [] }));
  let chosenPort = port;
  if (!chosenPort) {
    const temp = http.createServer(); await new Promise(r => temp.listen(0, "127.0.0.1", r)); chosenPort = temp.address().port; await new Promise(r => temp.close(r));
  }
  let child, output = "";
  const url = `http://127.0.0.1:${chosenPort}`;
  async function startServer() {
    child = spawn(process.execPath, [path.join(root, "server", "index.js")], { cwd: root, windowsHide: true, env: { ...process.env, PORT: String(chosenPort), PIPAPER_DATA_DIR: data, PI_CODING_AGENT_DIR: agent }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => output += chunk);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode != null) throw new Error(output);
      try { if ((await fetch(url + "/api/health")).ok) return; } catch {}
      if (attempt === 99) throw new Error("Server failed to start: " + output);
      await new Promise(r => setTimeout(r, 100));
    }
  }
  async function stopServer() { child.kill(); await new Promise(r => { if (child.exitCode != null) r(); else child.once("exit", r); }); }
  await startServer();
  return { url, directory, agent, data, modelRequests, output: () => output,
    async restart() { await stopServer(); await startServer(); },
    async dispose() {
      await stopServer();
      mock.closeAllConnections(); await new Promise(r => mock.close(r));
      const full = path.resolve(directory);
      if (path.dirname(full) !== path.resolve(os.tmpdir()) || !path.basename(full).startsWith("pipaper-http-")) throw new Error("Invalid test path");
      fs.rmSync(full, { recursive: true, force: true });
    },
  };
}
