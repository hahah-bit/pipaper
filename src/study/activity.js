import { node } from "./ui.js";

const labels = { lesson: "讲解生成", answers: "理解考查", message: "引导对话", prepare: "论文解析", translation: "精确翻译", research: "相关论文检索", image: "图示生成", plan: "实验计划", prompt: "对话过程" };
const tools = { read_paper: "读论文", list_library: "文献库列表", search_library: "检索文献库", search_papers: "学术检索", get_paper_pages: "论文截图", parse_paper: "解析论文", image_generate: "生成图示" };
const statuses = { running: "运行中", completed: "已完成", error: "失败", cancelled: "已停止" };
export function createActivityView(initial) {
  const title = node("summary"), body = node("div", { class: "study-activity-body" });
  const root = node("details", { class: "study-activity" }, title, body);
  function update(activity) {
    const expanded = new Set([...body.querySelectorAll("details[open]")].map(d => d.dataset.step));
    const steps = activity.steps || [], thinking = steps.some(s => s.thinking), count = steps.filter(s => s.type === "tool").length;
    title.textContent = `✻ ${labels[activity.kind] || "执行过程"} · ${statuses[activity.status] || "已结束"}${thinking ? " · 深度思考" : ""}${count ? ` · ${count} 次工具调用` : ""}`;
    root.classList.toggle("running", activity.status === "running"); body.replaceChildren();
    for (const step of steps) {
      const name = step.type === "tool" ? tools[step.name] || step.name : `${step.model?.id || "模型"} · ${step.thinking ? "深度思考" : "生成回答"}`;
      const card = node("details", { class: "study-activity-step", "data-step": step.id, open: expanded.has(step.id) }, node("summary", {}, `${step.type === "tool" ? "⚙" : "✧"} ${name} · ${statuses[step.status] || "已结束"}`));
      if (step.args) card.append(node("small", {}, "调用参数"), node("pre", {}, JSON.stringify(step.args, null, 2)));
      if (step.thinking) card.append(node("pre", { class: "study-thinking" }, step.thinking));
      if (step.type === "model" && !step.thinking) card.append(node("small", {}, step.status === "running" ? "等待模型输出…" : "本次模型未返回可展示的思考内容"));
      for (const part of step.content || []) {
        if (part.type === "text") card.append(node("pre", {}, part.text));
        if (part.type === "image") card.append(node("img", { class: "study-chat-image", src: `data:${part.mimeType};base64,${part.data}`, alt: "工具返回图片" }));
      }
      if (step.error) card.append(node("p", { class: "study-error" }, step.error));
      if (step.usage) card.append(node("small", {}, `输入 ${step.usage.input ?? "—"} · 输出 ${step.usage.output ?? "—"} tokens`));
      body.append(card);
    }
    if (activity.error) body.append(node("p", { class: "study-error" }, activity.error));
    if (!steps.length) body.append(node("small", {}, activity.status === "running" ? "正在准备…" : "操作已结束"));
  }
  update(initial); return { root, update };
}
