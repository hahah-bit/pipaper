import { api, state } from "./app.js";
import { createSessionEventChannel } from "./sessionEventChannel.js";
import { buildPrompt, noteFilePath, NOTE_FILES } from "./noteTemplates.js";

// 粗读笔记生成：前端自动创建一个临时 pi 会话跑生成任务，结束后自动删除该会话，
// 主对话完全不受影响；产物是落在 knowledge/粗读/<slug>/ 下的文件。

const running = new Map(); // `${paperId}/${file}` → Promise，防止同一产物重复触发

function tmpFetch(holder, url, opts = {}) {
  return fetch(url, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(holder.controlId ? { "X-Pi-Control": holder.controlId } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  });
}

// 在临时会话里跑一条 prompt。成功返回 { sessionId, holder, assistantText }；
// 会话的删除由调用方根据结果决定（成功删、失败保留回查）。
async function runInTempSession({ paper, prompt, onStatus }) {
  // 独立的 state 对象：临时会话的 controlId 不能污染主对话的全局 state
  const holder = { controlId: null };
  const channel = createSessionEventChannel({ state: holder });
  const created = await api.createSession(paper.paperId, state.projectId || null, `粗读生成 · ${String(paper.title || "").slice(0, 36)}`);
  const sessionId = created.id;
  let assistantText = "";
  try {
    await channel.connectSessionEvents(sessionId, (ev) => {
      if (ev.t === "connected") holder.controlId = ev.controlId;
      else if (ev.t === "delta") assistantText += ev.text || "";
      else if (ev.t === "tool_start" && ev.name === "write") onStatus?.("正在写入 " + (ev.args?.path || "文件") + " …");
      else if (ev.t === "tool_start" && ["read", "read_paper"].includes(ev.name)) onStatus?.("正在阅读论文…");
    });
    const res = await tmpFetch(holder, `/api/sessions/${encodeURIComponent(sessionId)}/prompt`, {
      method: "POST",
      body: { text: prompt, paperId: paper.paperId, projectId: state.projectId || null },
    });
    const op = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(op.error || `HTTP ${res.status}`);
    await channel.waitOperation(op.operationId);
  } finally {
    channel.closeSessionEvents();
  }
  return { sessionId, holder, assistantText };
}

async function removeTempSession(sessionId, holder) {
  try { await tmpFetch(holder, `/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }); } catch {}
}

async function fileExists(category, slug, file) {
  try {
    const data = await api.notes();
    const cat = data.categories.find((c) => c.category === category);
    const paper = cat?.papers.find((p) => p.slug === slug);
    return !!paper?.files.some((f) => f.name === file);
  } catch { return false; }
}

/**
 * 生成一个粗读产物。paper: {paperId, title}；kind ∈ NOTE_FILES 的 key。
 * 返回 { ok:true } 或 { noop:true, reason }；失败抛错（临时会话保留，便于回查）。
 */
export async function generateArtifact(paper, kind, { onStatus } = {}) {
  const def = NOTE_FILES.find((f) => f.key === kind);
  if (!def) throw new Error("未知的笔记类型");
  if (!paper?.paperId) throw new Error("请先选择论文");
  const key = `${paper.paperId}/${def.file}`;
  if (running.has(key)) return running.get(key);

  const job = (async () => {
    onStatus?.("准备知识目录…");
    const meta = await api.notesEnsure({ paperId: paper.paperId, title: paper.title, category: "粗读" });
    const slug = meta.slug;
    const filePath = noteFilePath(slug, def.file);

    onStatus?.("启动临时会话…");
    const { sessionId, holder, assistantText } = await runInTempSession({
      paper,
      prompt: buildPrompt(kind, { title: paper.title || "", slug }),
      onStatus,
    });

    if (await fileExists("粗读", slug, def.file)) {
      await removeTempSession(sessionId, holder);
      onStatus?.("");
      return { ok: true };
    }
    if (/^\s*\[\[无需生成\]\]/m.test(assistantText)) {
      await removeTempSession(sessionId, holder);
      onStatus?.("");
      return { noop: true, reason: assistantText.replace(/^\s*\[\[无需生成\]\]\s*/m, "").split("\n").filter(Boolean)[0] || "本文不涉及该内容" };
    }
    // 生成失败：保留临时会话供回查，并带上 AI 的解释
    const tail = assistantText.trim().slice(-260);
    throw new Error(`生成结束但未产出 ${def.file}，已保留临时会话「粗读生成 · ${String(paper.title || "").slice(0, 20)}」可供回查。${tail ? " AI 说明：" + tail : ""}`);
  })().catch((e) => { onStatus?.(""); throw e; }).finally(() => running.delete(key));

  running.set(key, job);
  return job;
}

export function isGenerating(paper, kind) {
  const def = NOTE_FILES.find((f) => f.key === kind);
  return !!(paper?.paperId && def && running.has(`${paper.paperId}/${def.file}`));
}
