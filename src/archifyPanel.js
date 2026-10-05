import { persistence } from "./persistence.js";
import { el, toast } from "./platform/dom.js";
import { state } from "./shell/state.js";
import { streamPrompt } from "./chat.js";

const TYPES = { architecture: "架构图", workflow: "流程图", sequence: "时序图", dataflow: "数据流图", lifecycle: "状态图" };
const draftKey = "pipaper.archify.draft";
async function request(route, options = {}) {
  const response = await fetch("/api/archify" + route, { headers: { "Content-Type": "application/json" }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Archify 请求失败");
  return data;
}
const download = url => url + (url.includes("?") ? "&" : "?") + "download=1";

export function archifyModule() {
  let dispose;
  return {
    id: "archify", name: "Archify 图解", icon: "◈",
    mount(container) {
      let alive = true, sequence = 0, items = [], activeId = null, editId = null, working = false;
      const status = el("span", { class: "res-note", role: "status", "aria-live": "polite" }, "连接中…");
      const type = el("select", { "aria-label": "图解类型" }, ...Object.entries(TYPES).map(([key, title]) => el("option", { value: key }, title)));
      const input = el("textarea", { rows: 3, maxlength: 16000, "aria-label": "图解需求", placeholder: "描述想看懂的结构或流程，也可以粘贴 Mermaid…" });
      try { input.value = persistence.getItem(draftKey) || ""; } catch {}
      input.addEventListener("input", () => { try { persistence.setItem(draftKey, input.value); } catch {} });
      const selection = el("select", { "aria-label": "已保存图解", onchange: () => show(selection.value) });
      const scope = el("select", { "aria-label": "图解范围", onchange: () => refresh() }, el("option", { value: "paper" }, "当前论文"), el("option", { value: "all" }, "全部图解"));
      if (!state.currentPaper) scope.value = "all";
      const preview = el("div", { class: "archify-preview" });
      const links = el("div", { class: "archify-links" });
      const editHint = el("span", { class: "res-note" });
      const path = el("input", { type: "text", "aria-label": "Archify 目录", placeholder: "已有 Archify 仓库或技能的绝对目录" });
      const connect = el("button", { class: "tool-btn", type: "button", onclick: async () => {
        connect.disabled = true;
        try { updateStatus(await request("/config", { method: "PUT", body: JSON.stringify({ path: path.value }) })); }
        catch (error) { status.textContent = error.message; }
        finally { if (alive) connect.disabled = false; }
      } }, "连接");
      const config = el("details", { class: "archify-config" }, el("summary", {}, "连接设置"),
        el("p", { class: "res-note" }, "复用本机 Archify，无需另配模型。未安装时下载官方仓库，再填写目录。"),
        el("div", { class: "archify-row" }, path, connect),
        el("a", { href: "https://github.com/tt-a1i/archify", target: "_blank", rel: "noopener noreferrer" }, "Archify 项目与安装说明 ↗"));
      let ready = false;
      function updateStatus(data) {
        if (!alive) return;
        ready = data.ready; path.value = data.path || "";
        status.textContent = ready ? `已连接 · Archify ${data.version}` : data.error;
        config.open = !ready; generate.disabled = !ready || working;
      }
      const generate = el("button", { class: "tool-btn primary", type: "submit", disabled: true }, "生成图解");
      const reset = el("button", { class: "tool-btn", type: "button", onclick: () => {
        editId = null; editHint.textContent = ""; generate.textContent = "生成图解"; input.focus();
      } }, "新建");
      const form = el("form", { class: "archify-form", onsubmit: async event => {
        event.preventDefault();
        const text = input.value.trim();
        if (!text) return input.focus();
        if (state.streaming) return toast("当前对话正在生成，请完成或停止后再试", true);
        const before = new Set(items.map(item => item.id));
        const requestType = type.value, edit = items.find(item => item.id === editId);
        if (edit?.studyId) return toast("这张图属于研读任务，请在该任务的自由对话中修改", true);
        const prompt = `请用 Archify ${edit ? `修改《${edit.title}》（图解 ID：${edit.id}），类型为${TYPES[requestType]}，保留旧版本` : `生成一张${TYPES[requestType]}`}。\n${text}${state.currentPaper ? "\n涉及当前论文时请先阅读原文，在图中注明章节或页码，未说明的内容标为假设。" : ""}\n请给出可交互预览和下载链接。`;
        working = true; generate.disabled = true; status.textContent = "正在生成，思考与工具调用显示在当前对话中…";
        try {
          await streamPrompt(prompt);
          if (!alive) return;
          await refresh();
          const newest = items.find(item => !before.has(item.id));
          if (newest) { show(newest.id); status.textContent = "图解已生成并保存"; }
          else status.textContent = "本轮未生成新图解，请查看对话中的说明或校验结果";
        } catch (error) { if (alive) status.textContent = error.message; }
        finally { working = false; if (alive) generate.disabled = !ready; }
      } }, input, el("div", { class: "archify-row" }, type, generate, reset, editHint));
      container.append(el("div", { class: "archify-panel" },
        el("div", { class: "archify-heading" }, el("strong", {}, "◈ Archify 图解"), status),
        form, config,
        el("div", { class: "archify-row archify-library" }, scope, selection,
          el("button", { class: "tool-btn", title: "刷新图解", onclick: () => refresh() }, "↻")),
        links, preview));

      function show(id) {
        if (!alive) return;
        const item = items.find(row => row.id === id);
        activeId = item?.id || null; selection.value = activeId || ""; links.replaceChildren();
        if (!item) {
          preview.replaceChildren(el("div", { class: "archify-empty" }, el("div", {}, "◈"),
            el("h3", {}, "把论文里的关系画清楚"), el("p", {}, "架构、方法流程、调用时序、数据流与状态转换。"),
            el("p", { class: "res-note" }, "输入需求生成；也可以在对话里直接说“用 Archify 画这篇论文的方法架构”。")));
          return;
        }
        links.append(el("span", { class: "archify-caption", title: item.title }, item.title),
          el("a", { class: "tool-btn", href: item.previewUrl, target: "_blank", rel: "noopener" }, "打开 ↗"),
          el("a", { class: "tool-btn", href: download(item.previewUrl), download: true }, "下载 HTML"),
          el("a", { class: "tool-btn", href: download(item.sourceUrl), download: true }, "JSON 源"),
          el("a", { class: "tool-btn", href: download(item.receiptUrl), download: true }, "校验记录"),
          el("button", { class: "tool-btn", disabled: !!item.studyId, onclick: () => {
            editId = item.id; type.value = item.type; editHint.textContent = "修改将保存为新版本";
            generate.textContent = "保存修改"; input.focus();
          } }, "继续修改"));
        preview.replaceChildren(el("iframe", { src: item.previewUrl, title: item.title, sandbox: "allow-scripts allow-downloads", referrerpolicy: "no-referrer" }));
      }
      async function refresh(preferredId) {
        const seq = ++sequence;
        try {
          const query = scope.value === "paper" && state.currentPaper ? "?" + new URLSearchParams({ paperId: state.currentPaper.id }) : "";
          const data = await request("/artifacts" + query);
          if (!alive || seq !== sequence) return;
          items = data.artifacts;
          selection.replaceChildren(...(items.length ? items.map(item => el("option", { value: item.id }, `${item.title} · ${new Date(item.createdAt).toLocaleString("zh-CN")}`)) : [el("option", { value: "" }, "暂无图解")]));
          show(items.some(item => item.id === preferredId) ? preferredId : items.some(item => item.id === activeId) ? activeId : items[0]?.id);
        } catch (error) { if (alive && seq === sequence) status.textContent = error.message; }
      }
      const changed = event => refresh(event.detail?.id);
      window.addEventListener("pipaper:archify-changed", changed);
      window.addEventListener("pipaper:paper-changed", changed);
      void request("/status").then(updateStatus).catch(error => { if (alive) status.textContent = error.message; });
      void refresh();
      dispose = () => { alive = false; sequence++; window.removeEventListener("pipaper:archify-changed", changed); window.removeEventListener("pipaper:paper-changed", changed); };
    },
    unmount() { dispose?.(); dispose = null; },
  };
}
