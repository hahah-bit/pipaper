// Browser dialogs for both Pi extensions and the model's request_user_input tool.
export function createUserInputUI(answer, stop) {
  const requests = new Map();
  let active = null;
  const make = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };

  function close(id) {
    requests.delete(id);
    if (active?.request.id === id) {
      clearInterval(active.timer);
      active.dialog.close();
      active.dialog.remove();
      active = null;
    }
    showNext();
  }

  function showNext() {
    if (active || !requests.size) return;
    const { sessionId, request } = requests.values().next().value;
    const dialog = make("dialog", null, "agent-question");
    const form = make("form");
    const caption = make("div", "需要你的回答", "agent-question-caption");
    const title = make("h2", request.title);
    title.id = "agent-question-title";
    dialog.setAttribute("aria-labelledby", title.id);
    const message = make("p", request.message || "请选择或填写后提交，助手会继续执行。", "agent-question-message");
    message.id = "agent-question-description";
    dialog.setAttribute("aria-describedby", message.id);
    const body = make("div", null, "agent-question-fields");
    const error = make("div", "", "agent-question-error");
    error.setAttribute("role", "alert");
    const foot = make("div", null, "agent-question-foot");
    const hint = make("span", "Esc 取消", "agent-question-hint");
    const help = make("div", null, "agent-question-help");
    help.append(hint);
    if (stop) {
      const stopButton = make("button", "停止任务", "tool-btn");
      stopButton.type = "button";
      stopButton.onclick = async () => {
        if (current.submitting) return;
        current.submitting = true;
        for (const control of form.elements) control.disabled = true;
        try { await stop(sessionId); close(request.id); }
        catch (err) {
          if (active !== current) return;
          current.submitting = false;
          for (const control of form.elements) control.disabled = false;
          error.textContent = "停止失败：" + err.message;
        }
      };
      help.append(stopButton);
    }
    const cancel = make("button", "取消", "tool-btn");
    cancel.type = "button";
    const buttons = make("div", null, "agent-question-actions");
    buttons.append(cancel);
    foot.append(help, buttons);
    form.append(caption, title, message, body, error, foot);
    dialog.append(form);
    const current = active = { sessionId, request, dialog, submitting: false, timer: null };
    let readValue;

    async function submit(payload) {
      if (current !== active || current.submitting) return;
      current.submitting = true;
      error.textContent = "";
      for (const control of form.elements) control.disabled = true;
      try {
        await answer(sessionId, request.id, payload);
        close(request.id);
      } catch (err) {
        if (current !== active) return;
        current.submitting = false;
        for (const control of form.elements) control.disabled = false;
        error.textContent = "提交失败：" + err.message + "。请重试。";
      }
    }
    cancel.onclick = () => submit({ cancelled: true });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      submit({ cancelled: true });
    });
    if (request.kind === "confirm") {
      for (const [label, value] of [["不继续", false], ["确认继续", true]]) {
        const button = make("button", label, "tool-btn" + (value ? " primary" : ""));
        button.type = "button";
        button.onclick = () => submit({ value });
        buttons.append(button);
      }
    } else {
      if (request.kind === "select") {
        const group = make("fieldset");
        group.append(make("legend", "选择一项"));
        for (const [index, option] of request.options.entries()) {
          const row = make("label", null, "agent-question-option");
          const radio = make("input");
          radio.type = "radio";
          radio.name = "choice";
          radio.value = String(index);
          radio.required = true;
          row.append(radio, make("span", option));
          group.append(row);
        }
        let custom;
        if (request.allowCustom) {
          const row = make("label", null, "agent-question-option");
          const radio = make("input");
          radio.type = "radio"; radio.name = "choice"; radio.value = "custom";
          custom = make("input");
          custom.type = "text";
          custom.placeholder = "其他，请填写";
          custom.setAttribute("aria-label", "其他答案");
          custom.maxLength = 20000;
          custom.addEventListener("input", () => { radio.checked = true; });
          radio.addEventListener("change", () => custom.focus());
          row.append(radio, custom);
          group.append(row);
        }
        body.append(group);
        readValue = () => {
          const selected = form.querySelector('input[name="choice"]:checked');
          if (!selected) return undefined;
          return selected.value === "custom" ? custom.value.trim() || undefined : request.options[Number(selected.value)];
        };
      } else {
        const input = make(request.kind === "editor" ? "textarea" : "input");
        if (request.kind !== "editor") input.type = "text";
        input.setAttribute("aria-label", request.title);
        input.placeholder = request.placeholder || "请输入答案";
        input.value = request.prefill || "";
        input.maxLength = 20000;
        if (request.kind === "editor") input.rows = 8;
        body.append(input);
        readValue = () => input.value;
      }
      const send = make("button", "提交答案", "tool-btn primary");
      send.type = "submit";
      buttons.append(send);
    }
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!readValue) return;
      const value = readValue();
      if (value === undefined) { error.textContent = "请选择一项或填写其他答案。"; return; }
      void submit({ value });
    });
    if (request.expiresAt) {
      const tick = () => {
        hint.textContent = `剩余 ${Math.max(0, Math.ceil((request.expiresAt - Date.now()) / 1000))} 秒 · Esc 取消`;
      };
      tick();
      current.timer = setInterval(tick, 1000);
    }
    document.body.append(dialog);
    dialog.showModal();
    (body.querySelector("input, textarea") || cancel).focus();
  }

  return {
    show(sessionId, request) {
      if (requests.has(request.id)) return;
      requests.set(request.id, { sessionId, request });
      showNext();
    },
    resolve: close,
    clear() {
      requests.clear();
      if (active) close(active.request.id);
    },
    get pending() { return requests.size > 0; },
  };
}
