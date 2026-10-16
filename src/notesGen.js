import { api } from "./platform/api.js";
import { state } from "./shell/state.js";
import { runTempPrompt, removeTempSession } from "./tempSession.js";
import { buildPrompt, noteFilePath, NOTE_FILES } from "./noteTemplates.js";

// 粗读笔记生成：前端自动创建一个临时 pi 会话跑生成任务，结束后自动删除该会话，
// 主对话完全不受影响；产物是落在 knowledge/粗读/<slug>/ 下的文件。

const running = new Map(); // `${paperId}/${file}` → Promise，防止同一产物重复触发

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
    const { sessionId, controlId, assistantText } = await runTempPrompt({
      title: `粗读生成 · ${String(paper.title || "").slice(0, 36)}`,
      paperId: paper.paperId, projectId: state.projectId || null,
      prompt: buildPrompt(kind, { title: paper.title || "", slug }),
      onStatus,
    });

    if (await fileExists("粗读", slug, def.file)) {
      await removeTempSession(sessionId, controlId);
      onStatus?.("");
      return { ok: true };
    }
    if (/^\s*\[\[无需生成\]\]/m.test(assistantText)) {
      await removeTempSession(sessionId, controlId);
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
