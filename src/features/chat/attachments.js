import { state } from "../../shell/state.js";
import { $, el, toast } from "../../platform/dom.js";
// ---------------- chips (context to attach to next message) ----------------
export function addChip(chip) {
  // dedupe identical text chips
  if (chip.kind === "text" && state.chips.some((c) => c.kind === "text" && c.body === chip.body)) {
    toast("该选区已在对话上下文中");
    return;
  }
  state.chips.push(chip);
  renderChips();
}

export function removeChip(i) {
  state.chips.splice(i, 1);
  renderChips();
}

export function renderChips() {
  const wrap = $("#chips");
  wrap.replaceChildren();
  state.chips.forEach((c, i) => {
    const body =
      c.kind === "image"
        ? el("img", { src: c.dataUrl, alt: "截图" })
        : el("span", { class: "c-body" }, c.body.slice(0, 80) || "(空)");
    wrap.append(
      el("span", { class: "chip" },
        el("span", { class: "c-tag" }, c.tag),
        body,
        el("button", { class: "c-x", title: "移除", onclick: () => removeChip(i) }, "✕")
      )
    );
  });
}
