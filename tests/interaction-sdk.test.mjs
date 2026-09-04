import test from "node:test";
import assert from "node:assert/strict";
import { interactionSession } from "./helpers/interaction-session.mjs";

test("real Pi tool execution suspends, receives an answer, and continues the model", { timeout: 10000 }, async (t) => {
  let calls = 0;
  const fixture = await interactionSession((context) => {
    if (++calls === 1) return [{ type: "toolCall", id: "q1", name: "request_user_input", arguments: { kind: "select", title: "选哪种阅读模式？", options: ["摘要", "逐帧"] } }];
    const result = context.messages.findLast((m) => m.role === "toolResult");
    assert.equal(JSON.parse(result.content[0].text).value, "逐帧");
    return [{ type: "text", text: "收到，继续逐帧阅读。" }];
  });
  t.after(() => fixture.dispose());
  const { session, broker } = fixture;
  let question;
  const shown = new Promise((resolve) => broker.connect((event) => { if (event.t === "ui_request") { question = event.request; resolve(); } }));
  await session.bindExtensions({ mode: "rpc", uiContext: broker.context(session.extensionRunner.getUIContext()) });
  const running = session.prompt("请让我选择阅读模式");
  await shown;
  assert.equal(calls, 1);
  assert.equal(session.isStreaming, true);
  broker.answer(question.id, { value: "逐帧" });
  await running;
  assert.equal(calls, 2);
  assert.equal(session.messages.at(-1).content[0].text, "收到，继续逐帧阅读。");
});

test("native extension startup and command UI get hasUI=true and typed answers", { timeout: 10000 }, async (t) => {
  let confirmed, selection, input, editor;
  const fixture = await interactionSession(() => { throw new Error("No model calls expected"); }, (pi) => {
    pi.on("session_start", async (_event, ctx) => {
      assert.equal(ctx.hasUI, true);
      assert.equal(ctx.mode, "rpc");
      confirmed = await ctx.ui.confirm("是否继续", "启动阅读");
    });
    pi.registerCommand("ask-test", { description: "UI test", handler: async (_args, ctx) => {
      selection = await ctx.ui.select("选择", ["A", "B"]);
      input = await ctx.ui.input("路径");
      editor = await ctx.ui.editor("编辑", "原文");
    } });
  });
  t.after(() => fixture.dispose());
  const { session, broker } = fixture;
  const values = [true, "B", "paper.pdf", "修改后的文字"];
  broker.connect((event) => {
    if (event.t === "ui_request") queueMicrotask(() => broker.answer(event.request.id, { value: values.shift() }));
  });
  await session.bindExtensions({ mode: "rpc", uiContext: broker.context(session.extensionRunner.getUIContext()), onError: (error) => assert.fail(error.error) });
  await session.prompt("/ask-test");
  assert.deepEqual([confirmed, selection, input, editor], [true, "B", "paper.pdf", "修改后的文字"]);
});

test("real Pi delivers steering before follow-up and emits queue state", { timeout: 10000 }, async (t) => {
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const firstStarted = new Promise((resolve) => { started = resolve; });
  const seen = [];
  const fixture = await interactionSession(async (context) => {
    const users = context.messages.filter((m) => m.role === "user").map((m) => m.content[0].text);
    seen.push(users);
    if (seen.length === 1) { started(); await gate; }
    return [{ type: "text", text: `完成 ${users.at(-1)}` }];
  });
  t.after(() => fixture.dispose());
  const queue = [];
  fixture.session.subscribe((event) => { if (event.type === "queue_update") queue.push(event); });
  const running = fixture.session.prompt("原任务");
  await firstStarted;
  await fixture.session.followUp("排队任务");
  await fixture.session.steer("插队要求");
  release();
  await running;
  assert.deepEqual(seen, [["原任务"], ["原任务", "插队要求"], ["原任务", "插队要求", "排队任务"]]);
  assert.ok(queue.some((e) => e.followUp.includes("排队任务") && e.steering.includes("插队要求")));
  assert.equal(queue.at(-1).followUp.length + queue.at(-1).steering.length, 0);
});
