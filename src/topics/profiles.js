import { node, request, button, dialog, notify, confirmDelete } from "../study/ui.js";
const field = (label, control, help) => node("label", { class: "topic-field" }, node("span", {}, label), control, help && node("small", {}, help));
export const stageNames = { experiment: "实验结束", manuscript: "论文写完", submission: "完成投稿" };
export function profileEditor(old, onSaved) {
  const input = (key, attrs = {}) => node("input", { name: key, value: old?.[key] ?? "", ...attrs });
  const select = (key, options) => { const s = node("select", { name: key }, options.map(([value, text]) => node("option", { value }, text))); s.value = old?.[key] || options[0][0]; return s; };
  const hardware = node("textarea", { name: "hardware", rows: 2, required: true, placeholder: "例如：1张 RTX 4090 24GB；64GB 内存；可用学校服务器…", value: old?.hardware || "" });
  const area = node("textarea", { name: "researchArea", rows: 3, required: true, placeholder: "专业、导师介绍、感兴趣的应用场景都可以。越具体，检索越有效。", value: old?.researchArea || "" });
  const openData = input("openData", { type: "checkbox", checked: old?.openData ?? true });
  const form = node("form", { class: "topic-form" },
    field("画像名称", input("name", { required: true, maxlength: 80, placeholder: "例如：硕士一年级 · 工业视觉" })),
    field("硬件范围", hardware), node("div", { class: "form-grid" }, field("可用 GPU 卡数", input("gpuCount", { type: "number", min: 0, max: 1024, placeholder: "CPU 方案填0" })), field("单卡显存 / GB", input("vramGB", { type: "number", min: 0, max: 2000, placeholder: "CPU 方案填0" }))),
    field("研究大方向 / 专业 / 导师介绍", area),
    node("div", { class: "form-grid" }, field("预期周期 / 月", input("months", { type: "number", required: true, min: 1, max: 120, value: old?.months ?? 6 })), field("到这个时间，希望完成", select("deadlineStage", Object.entries(stageNames)), "投稿结束指完成提交，不代表录用。")),
    node("h3", {}, "再了解你一点"),
    node("label", { class: "topic-check" }, openData, node("span", {}, "只考虑有公开数据集的方向", node("small", {}, "需要公开声明 / 许可证及可访问的数据入口。"))),
    field("01 · 编程与论文阅读基础", select("experience", [["beginner", "刚起步，需要从复现入门"], ["basic", "会编程，读过相关论文"], ["experienced", "能独立实现算法，但首次写论文"]])),
    field("02 · 每周可投入多少小时", input("weeklyHours", { type: "number", required: true, min: 1, max: 168, value: old?.weeklyHours ?? 20 })),
    field("03 · 更想从哪类工作开始", select("contribution", [["undecided", "还没想好，帮助我判断"], ["application", "在真实应用中发现和解决问题"], ["method", "复现方法，再做改进与消融"], ["theory", "理论、机制分析与可解释性"]])),
    node("button", { type: "submit", class: "tool-btn primary" }, "保存调查卡"));
  const dlg = dialog(old ? "编辑调查卡" : "新建调查卡", form);
  form.addEventListener("submit", async e => { e.preventDefault(); const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
    try { const values = Object.fromEntries(new FormData(form)); values.openData = openData.checked;
      await request("/api/topics/profiles" + (old ? `/${old.id}` : ""), { method: old ? "PUT" : "POST", body: values }); dlg.close(); await onSaved?.();
    } catch (e) { notify(e.message, true); } finally { submit.disabled = false; }
  });
}
export async function manageProfiles(onChange) {
  const content = node("div", { class: "profile-list" });
  const draw = async () => {
    const { profiles } = await request("/api/topics/profiles"); content.replaceChildren(node("p", { class: "muted" }, "画像可自由增删改。已建立的分析保留当时那一张快照，编辑画像不会改写历史报告。"));
    for (const p of profiles) content.append(node("article", { class: "profile-card" }, node("strong", {}, p.name), node("p", {}, p.researchArea), node("small", {}, `${p.hardware} · ${p.months}个月内${stageNames[p.deadlineStage]}`),
      node("div", { class: "topic-actions" }, button("编辑", () => profileEditor(p, async () => { await draw(); await onChange?.(); })), button("删除", async () => {
        if (!await confirmDelete("删除调查卡", `删除「${p.name}」？已有分析中的画像快照会保留。`)) return;
        await request(`/api/topics/profiles/${p.id}`, { method: "DELETE" }); await draw(); await onChange?.();
      }, "tool-btn danger"))));
    if (!profiles.length) content.append(node("p", { class: "muted" }, "还没有调查卡，先记录你的研究条件。"));
    content.append(button("＋ 新建调查卡", () => profileEditor(null, async () => { await draw(); await onChange?.(); }), "tool-btn primary"));
  };
  dialog("我的调查卡", content); await draw();
}
export async function createAnalysis(onCreated) {
  const mode = node("select", { name: "mode", "aria-label": "分析类型" }, node("option", { value: "topic" }, "一次选题 · 结合一张画像"), node("option", { value: "direction" }, "方向分析 · 先探索研究领域"));
  const profile = node("select", { name: "profileId", "aria-label": "本次唯一画像" });
  const load = async () => { const previous = profile.value; const r = await request("/api/topics/profiles"); profile.replaceChildren(node("option", { value: "" }, "选择一张调查卡"), ...r.profiles.map(p => node("option", { value: p.id }, p.name))); profile.value = previous || r.profiles.at(-1)?.id || ""; };
  await load();
  const area = node("textarea", { name: "researchArea", rows: 3, placeholder: "例如：面向工业设备的多模态异常检测", "aria-label": "方向分析研究范围" });
  const explore = node("input", { name: "exploreSubfields", type: "checkbox", checked: true });
  const profileFields = node("div", {}, field("这次使用哪张画像", profile), button("＋ 建立调查卡", () => profileEditor(null, load)));
  const areaField = field("想探索的研究大方向", area); areaField.hidden = true;
  mode.addEventListener("change", () => { const isTopic = mode.value === "topic"; profileFields.hidden = !isTopic; areaField.hidden = isTopic; profile.required = isTopic; area.required = !isTopic; }); profile.required = true;
  const form = node("form", { class: "topic-form" }, node("p", { class: "muted" }, "先建立分析任务，再开始真实数据检索。方向分析不保存或使用用户画像。"), field("分析类型", mode), profileFields, areaField,
    node("label", { class: "topic-check" }, explore, node("span", {}, "需要分析研究细分方向", node("small", {}, "仅用于本次分析，不写入画像。关闭后沿指定方向寻找具体问题。"))),
    node("button", { type: "submit", class: "tool-btn primary" }, "进入分析工作台 →"));
  const dlg = dialog("从一个好问题开始", form);
  form.addEventListener("submit", async e => { e.preventDefault(); const btn = form.querySelector('[type="submit"]'); btn.disabled = true;
    try { const { task } = await request("/api/topics", { method: "POST", body: { mode: mode.value, profileId: mode.value === "topic" ? profile.value : null, researchArea: area.value, exploreSubfields: explore.checked } }); dlg.close(); await onCreated(task.id); }
    catch (e) { notify(e.message, true); } finally { btn.disabled = false; }
  });
}
