import { stateLabels } from "../../shared/contracts/states.js";
import { el, toast } from "./dom.js";
import { requestJson } from "./http.js";
export const labels = {
  ...stateLabels,
  configuration: "连接检查",
  parse: "结构化解析",
  repair: "视觉补全",
  normalize: "清洗与关联",
  chunk: "标题分块",
  expand: "语义扩写",
  embed: "生成向量",
  index: "写入索引",
  publish: "发布索引",
  original: "原始文献",
  knowledge: "知识成果",
  "research-profile": "研究档案",
  "research-evidence": "证据卡",
};
export const storageApi = (url, body, method) => requestJson("/api/" + url, { body, method: method || (body ? "POST" : "GET") });
export const button = (name, action) =>
  el(
    "button",
    {
      class: "tool-btn",
      onclick: async () => {
        try {
          await action();
        } catch (e) {
          toast(e.message, true);
        }
      },
    },
    name,
  );
