import { api, state } from "./app.js";
import { runTempPrompt, removeTempSession } from "./tempSession.js";
import { buildFigurePrompt, figureFilePath, FIGURE_FILES } from "./figureTemplates.js";

// 图表分析生成引擎：与粗读 notesGen 同机制——临时 pi 会话跑生成（read_paper + write），
// 完成后自动删除临时会话；产物落 knowledge/图表分析/<slug>/。
// 会话执行复用 tempSession.js（LaTeX·MD 编辑器的 AI 辅助改稿同款）。
// 用户可控：三份文档独立触发，running 表防重复。

const running = new Map(); // `${paperId}/${file}` → Promise

async function fileExists(slug, file) {
  try {
    const data = await api.notes();
    const paper = data.categories.find((c) => c.category === "图表分析")?.papers.find((p) => p.slug === slug);
    return !!paper?.files.some((f) => f.name === file);
  } catch { return false; }
}

/**
 * 生成一份图表分析文档。paper: {paperId, title}；kind ∈ FIGURE_FILES 的 key。
 * 返回 { ok:true }；失败抛错（临时会话保留供回查）。
 */
export async function generateFigureDoc(paper, kind, { onStatus } = {}) {
  const def = FIGURE_FILES.find((f) => f.key === kind);
  if (!def) throw new Error("未知的图表分析文档类型");
  if (!paper?.paperId) throw new Error("请先选择论文");
  const key = `${paper.paperId}/${def.file}`;
  if (running.has(key)) return running.get(key);

  const job = (async () => {
    onStatus?.("准备图表分析目录…");
    const meta = await api.notesEnsure({ paperId: paper.paperId, title: paper.title, category: "图表分析" });
    const slug = meta.slug;
    const filePath = figureFilePath(slug, def.file);

    onStatus?.("启动临时会话…");
    const { sessionId, controlId, assistantText } = await runTempPrompt({
      title: `图表分析 · ${String(paper.title || "").slice(0, 32)}`,
      prompt: buildFigurePrompt(kind, { title: paper.title || "", slug }),
      paperId: paper.paperId,
      projectId: state.projectId || null,
      onStatus,
    });

    if (await fileExists(slug, def.file)) {
      await removeTempSession(sessionId, controlId);
      onStatus?.("");
      return { ok: true };
    }
    const tail = assistantText.trim().slice(-260);
    throw new Error(`生成结束但未产出 ${def.file}，已保留临时会话「图表分析 · ${String(paper.title || "").slice(0, 20)}」可供回查。${tail ? " AI 说明：" + tail : ""}`);
  })().catch((e) => { onStatus?.(""); throw e; }).finally(() => running.delete(key));

  running.set(key, job);
  return job;
}

export function isFigureGenerating(paper, kind) {
  const def = FIGURE_FILES.find((f) => f.key === kind);
  return !!(paper?.paperId && def && running.has(`${paper.paperId}/${def.file}`));
}
