import { $, el } from "../../platform/dom.js";
import { workspaceContext } from "../../platform/workspace-context.js";
export function renderWelcome() {
  const msgs = $("#messages");
  if (workspaceContext.workspace === "video") {
    msgs.replaceChildren(el("div", { class: "welcome" }, el("h3", {}, "视频工作台"), el("p", {}, "在右侧添加视频，可以截帧提问或生成时间轴分析。", el("br"), "视频对话单独保存，也可以在这里直接提问。")));
    return;
  }
  msgs.replaceChildren(
    el("div", { class: "welcome" },
      el("div", { class: "big" }),
      el("h3"),
      el("p", {},
        "左侧选择论文 → 右侧阅读；划选文字或框选截图加入对话；", el("br"),
        "支持 Zotero 文献库管理与 MinerU / unstructured 精细解析。", el("br"),
        "发送第一条消息时会自动创建会话（pi 内核，可随时回来继续）。"
      )
    )
  );
}
