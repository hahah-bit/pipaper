import test from "node:test";
import assert from "node:assert/strict";
import { UserInputBroker, userInputTool } from "../server/user-input.js";
import { composerAction } from "../src/chatKeys.js";

function setup() {
  const broker = new UserInputBroker();
  const events = [];
  broker.connect((event) => events.push(event));
  return { broker, events, lastId: () => events.findLast((e) => e.t === "ui_request").request.id };
}

test("confirm accepts explicit false; cancelled is distinct and duplicate replies fail", async () => {
  const { broker, events, lastId } = setup();
  const pending = broker.request({ kind: "confirm", title: "继续？" });
  const id = lastId();
  assert.equal(broker.pending.size, 1);
  assert.throws(() => broker.answer(id, { value: "true" }), /不匹配/);
  broker.answer(id, { value: false });
  assert.deepEqual(await pending, { cancelled: false, value: false });
  assert.equal(events.at(-1).t, "ui_resolved");
  assert.equal(broker.pending.size, 0);
  assert.throws(() => broker.answer(id, { value: true }), { status: 409 });
});

test("native selection restricts choices and cannot answer another session", async () => {
  const a = setup(), b = setup();
  const pending = a.broker.request({ kind: "select", title: "选哪个", options: ["A", "B"] });
  assert.throws(() => a.broker.answer(a.lastId(), { value: "C" }), { status: 400 });
  assert.throws(() => b.broker.answer(a.lastId(), { value: "A" }), { status: 409 });
  a.broker.answer(a.lastId(), { value: "B" });
  assert.equal((await pending).value, "B");
});

test("model tool waits for custom answers and exposes the answer to the model", async () => {
  const { broker, lastId } = setup();
  const pending = userInputTool(broker).execute("tool1", { kind: "select", title: "模式", options: ["摘要", "逐帧"] });
  broker.answer(lastId(), { value: "先看关键帧" });
  const result = await pending;
  assert.deepEqual(JSON.parse(result.content[0].text), { cancelled: false, value: "先看关键帧" });
  assert.deepEqual(result.details, JSON.parse(result.content[0].text));
});

test("native UI methods preserve SDK return types including cancellation and editor text", async () => {
  const { broker, lastId } = setup();
  const ui = broker.context({ getEditorText: () => "existing" });
  const confirm = ui.confirm("继续", "会启动解析");
  broker.answer(lastId(), { cancelled: true });
  assert.equal(await confirm, false);
  const selection = ui.select("选项", ["A"]);
  broker.answer(lastId(), { cancelled: true });
  assert.equal(await selection, undefined);
  const input = ui.input("路径");
  broker.answer(lastId(), { value: "E:\\研究\\paper.pdf" });
  assert.equal(await input, "E:\\研究\\paper.pdf");
  const editor = ui.editor("编辑", "原文");
  broker.answer(lastId(), { value: "第一行\n第二行" });
  assert.equal(await editor, "第一行\n第二行");
  assert.equal(ui.getEditorText(), "existing");
});

test("abort, timeout and disconnect release every pending request without approving", async () => {
  const { broker, lastId } = setup();
  const controller = new AbortController();
  const aborted = broker.request({ kind: "confirm", title: "停止" }, { signal: controller.signal });
  controller.abort();
  assert.deepEqual(await aborted, { cancelled: true, reason: "aborted" });
  const timed = broker.request({ kind: "input", title: "超时" }, { timeout: 10 });
  assert.deepEqual(await timed, { cancelled: true, reason: "timeout" });
  const one = broker.request({ kind: "confirm", title: "一" });
  const two = broker.request({ kind: "input", title: "二" });
  const id = lastId();
  broker.disconnect();
  assert.equal((await one).cancelled, true);
  assert.equal((await two).cancelled, true);
  assert.equal(broker.pending.size, 0);
  assert.throws(() => broker.answer(id, { value: "旧答案" }), { status: 409 });
  assert.deepEqual(await broker.request({ kind: "confirm", title: "离线" }), { cancelled: true, reason: "unavailable" });
});

test("composer separates steer/follow-up/newline and respects Chinese input composition", () => {
  assert.equal(composerAction({ key: "Enter" }), "steer");
  assert.equal(composerAction({ key: "Enter", altKey: true }), "followUp");
  assert.equal(composerAction({ key: "q", ctrlKey: true }), "followUp");
  for (const event of [{ key: "Enter", shiftKey: true }, { key: "Enter", isComposing: true }, { key: "Enter", keyCode: 229 }, { key: "Enter", repeat: true }, { key: "Enter", metaKey: true }]) {
    assert.equal(composerAction(event), null);
  }
});
