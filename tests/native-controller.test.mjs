import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { SessionController } from "../server/session-controller.js";
import { selectSkills, normalizeResources } from "../server/resource-config.js";
import { sessionTranscript } from "../server/session-messages.js";
import { userInputTool } from "../server/user-input.js";

async function fixture(t, extension, reply = () => [{ type: "text", text: "回答" }]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipaper-native-"));
  const controllers = [];
  let broken = false, revision = 0;
  const model = { id: "local", name: "Local", api: "openai-completions", provider: "test", input: ["text", "image"], reasoning: false, contextWindow: 10000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const build = async (options, c) => {
    if (broken) throw new Error("resource failed");
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: extension ? [extension] : [] });
    await resourceLoader.reload();
    const modelRuntime = { getModel: () => model, getAvailable: async () => [model], hasConfiguredAuth: () => true, isUsingOAuth: () => false, getAuth: async () => ({ apiKey: "test" }), streamSimple: (_m, context, opts) => {
      let message;
      return { async *[Symbol.asyncIterator]() {
        const content = await reply(context, opts);
        message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content, stopReason: content.some(x => x.type === "toolCall") ? "toolUse" : "stop", usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } } };
        yield { type: "start", partial: message };
        for (const [contentIndex, p] of content.entries()) if (p.type === "text") yield { type: "text_delta", contentIndex, delta: p.text, partial: message };
        yield { type: "done", reason: message.stopReason, message };
      }, result: async () => message };
    } };
    const result = await createAgentSession({ ...options, cwd: dir, agentDir: dir, model, modelRuntime, settingsManager, resourceLoader, noTools: "builtin", customTools: [userInputTool(c.ui)] });
    return { ...result, services: { cwd: dir, agentDir: dir, settingsManager, resourceLoader, modelRuntime }, diagnostics: [], revision };
  };
  const create = async (persist = false) => {
    const c = await SessionController.create({ cwd: dir, agentDir: dir, sessionManager: persist ? SessionManager.create(dir) : SessionManager.inMemory(dir), build });
    controllers.push(c); return c;
  };
  t.after(async () => {
    for (const c of controllers) await c.dispose();
    const full = path.resolve(dir);
    assert.equal(path.dirname(full), path.resolve(os.tmpdir())); assert.ok(path.basename(full).startsWith("pipaper-native-"));
    fs.rmSync(full, { recursive: true, force: true });
  });
  return { create, dir, setBroken: value => broken = value, setRevision: value => revision = value };
}

test("failed native replacement restores a usable outgoing session", async t => {
  const f = await fixture(t); const c = await f.create(true); await c.connect(() => {}).ready;
  await c.submit("original").completion;
  const id = c.id, file = c.session.sessionFile;
  f.setBroken(true); await assert.rejects(c.replace("newSession"), /resource failed/);
  assert.equal(c.id, id); assert.equal(c.session.sessionFile, file);
  await c.submit("after failure").completion;
  assert.equal(c.history().messages.filter(m => m.role === "user").length, 2);
});

test("busy resource changes apply after the prompt settles", async t => {
  let release, entered;
  const gate = new Promise(r => release = r), started = new Promise(r => entered = r);
  const f = await fixture(t, null, async () => { entered(); await gate; return [{ type: "text", text: "done" }]; });
  const c = await f.create(); const events = []; let reloaded;
  const ready = new Promise(r => reloaded = r);
  await c.connect(e => { events.push(e); if (e.t === "operation_end" && e.kind === "reload") reloaded(e); }).ready;
  const old = c.session, run = c.submit("busy"); await started;
  f.setRevision(2); c.markResourcesPending();
  assert.equal(c.resourceState.status, "pending"); assert.equal(c.session, old);
  release(); await run.completion; await ready;
  assert.notEqual(c.session, old); assert.equal(c.resourceState.revision, 2);
  assert.ok(events.filter(e => e.t === "operation_end").every(e => e.operationId === e.id));
});

test("startup dialogs are released on disconnect", async t => {
  const f = await fixture(t, pi => pi.on("session_start", async (_e, ctx) => { await ctx.ui.confirm("启动确认", "继续吗？"); }));
  const c = await f.create(); let asked;
  const question = new Promise(r => asked = r);
  const connection = c.connect(e => { if (e.t === "ui_request") asked(e); });
  await question; assert.equal(c.ui.pending.size, 1);
  await connection.close(); await connection.ready;
  assert.equal(c.ui.pending.size, 0); assert.equal(c.busy, false);
  const again = c.connect(() => {}); await again.ready;
  await c.submit("connected again").completion;
});

test("compaction stats and cancelled tree summaries preserve native state", async t => {
  let cancelTree = true, started, abortCompact = false;
  const f = await fixture(t, pi => {
    pi.on("session_before_compact", async e => {
      if (abortCompact) {
        started(); await new Promise(r => e.signal.addEventListener("abort", r, { once: true }));
        return { cancel: true };
      }
      return { compaction: { summary: e.customInstructions || "摘要", firstKeptEntryId: e.preparation.firstKeptEntryId, tokensBefore: e.preparation.tokensBefore } };
    });
    pi.on("session_before_tree", () => cancelTree ? { cancel: true } : { summary: { summary: "旧路径摘要" }, label: "保留结论" });
  });
  const c = await f.create(); await c.connect(() => {}).ready;
  c.session.settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 1 } });
  await c.submit("one").completion; await c.submit("two").completion;
  const stats = c.state().stats;
  const result = await c.start("compaction", () => c.session.compact("保留研究结论")).completion;
  assert.equal(result.summary, "保留研究结论"); assert.equal(c.state().compacting, false);
  assert.equal(c.state().stats.tokens.total, stats.tokens.total);
  assert.ok(c.history().messages.some(m => m.role === "compactionSummary"));
  const leaf = c.tree().leafId, target = c.history().messages.find(m => m.role === "assistant").entryId;
  assert.equal((await c.navigate(target, { summarize: true })).cancelled, true); assert.equal(c.tree().leafId, leaf);
  cancelTree = false; await c.navigate(target, { summarize: true });
  assert.ok(c.history().messages.some(m => m.role === "branchSummary" && m.text.includes("旧路径摘要")));
  await c.submit("three").completion;
  abortCompact = true; const entered = new Promise(r => started = r);
  const op = c.start("compaction", () => c.session.compact()); await entered;
  const beforeCancel = c.tree().leafId; await c.abort("compaction");
  await assert.rejects(op.completion, /cancel/i);
  assert.equal(c.tree().leafId, beforeCancel); assert.equal(c.busy, false);
});

test("duplicate queue texts retain only the remaining attachment", async t => {
  const releases = [], entered = []; let calls = 0;
  const f = await fixture(t, null, async () => {
    const index = calls++;
    await new Promise(r => { releases[index] = r; entered[index]?.(); });
    return [{ type: "text", text: "done" }];
  });
  const waitCall = index => releases[index] ? Promise.resolve() : new Promise(r => entered[index] = r);
  const c = await f.create(); await c.connect(() => {}).ready;
  c.session.setFollowUpMode("one-at-a-time");
  const run = c.submit("first"); await waitCall(0);
  await c.enqueue({ mode: "followUp", text: "same", images: [{ data: "first" }] });
  await c.enqueue({ mode: "followUp", text: "same", images: [{ data: "second" }] });
  releases[0](); await waitCall(1);
  const remaining = c.takeQueue().items;
  assert.equal(remaining.length, 1); assert.equal(remaining[0].images[0].data, "second");
  assert.equal(c.takeQueue().items.length, 0);
  releases[1](); await run.completion;
});

test("resource selection migrates inherited/selected/gated and supports explicitly empty", () => {
  const base = [{ name: "a" }, { name: "b" }], gated = [{ name: "paper" }];
  assert.equal(normalizeResources({ skillsEnabled: [] }).skillsMode, "inherit");
  assert.deepEqual(normalizeResources({ packages: ["@scope/pkg@1.2.3", "npm:valid"] }).packages, ["npm:@scope/pkg@1.2.3", "npm:valid"]);
  assert.deepEqual(selectSkills(base, gated, { skillsEnabled: ["a"] }).map(s => s.name), ["a", "paper"]);
  assert.deepEqual(selectSkills(base, gated, { schemaVersion: 2, skillsMode: "selected", skillsEnabled: [] }), []);
});

test("separate native runtimes isolate extension closures, names and messages", async t => {
  const f = await fixture(t, pi => {
    let count = 0;
    pi.registerCommand("count", { handler: () => { pi.setSessionName(`count-${++count}`); pi.sendMessage({ customType: "audit", content: `count ${count}`, display: true }); } });
  });
  const a = await f.create(), b = await f.create();
  await a.connect(() => {}).ready; await b.connect(() => {}).ready;
  await a.submit("/count").completion; await b.submit("/count").completion; await a.submit("/count").completion;
  assert.equal(a.session.sessionName, "count-2"); assert.equal(b.session.sessionName, "count-1");
  assert.notEqual(a.session.resourceLoader, b.session.resourceLoader);
  assert.notEqual(a.session.modelRuntime, b.session.modelRuntime);
  assert.equal(sessionTranscript(b.session).filter(m => m.role === "custom").length, 1);
});

test("command newSession replaces runtime, honors cancellation and keeps event ownership", async t => {
  let cancel = true;
  const f = await fixture(t, pi => {
    pi.on("session_before_switch", () => cancel ? { cancel: true } : undefined);
    pi.registerCommand("new-test", { handler: (_args, ctx) => ctx.newSession() });
  });
  const c = await f.create(), events = [];
  await c.connect(e => events.push(e)).ready;
  const old = c.id;
  await c.submit("/new-test").completion; assert.equal(c.id, old);
  cancel = false; await c.submit("/new-test").completion; assert.notEqual(c.id, old);
  assert.ok(events.some(e => e.t === "session_replaced" && e.oldSessionId === old));
  assert.ok(events.every((e, i) => !i || e.seq > events[i - 1].seq));
  assert.throws(() => c.connect(() => {}), /另一个页面/);
  assert.throws(() => c.assertOwner("wrong"));
});

test("resource reload is transactional, and can retry after failure", async t => {
  const f = await fixture(t); const c = await f.create(); await c.connect(() => {}).ready;
  const old = c.session;
  f.setBroken(true); await assert.rejects(c.reload(), /resource failed/);
  assert.equal(c.session, old); assert.equal(c.resourceState.status, "failed");
  await c.submit("still works").completion;
  f.setBroken(false); f.setRevision(3); await c.reload();
  assert.notEqual(c.session, old); assert.equal(c.resourceState.revision, 3);
  assert.ok(sessionTranscript(c.session).some(m => m.text === "still works"));
});

test("transcript keeps image, custom visibility, long output and exact duplicate entry IDs", async t => {
  const f = await fixture(t); const c = await f.create(); const sm = c.session.sessionManager;
  const one = sm.appendMessage({ role: "user", content: [{ type: "text", text: "same" }, { type: "image", data: "abc", mimeType: "image/png" }], timestamp: 1 });
  const two = sm.appendMessage({ role: "user", content: "same", timestamp: 2 });
  sm.appendCustomMessageEntry("shown", "custom", true); sm.appendCustomMessageEntry("hidden", "secret", false);
  sm.appendMessage({ role: "toolResult", toolCallId: "tool", toolName: "read", content: [{ type: "text", text: "x".repeat(20000) }, { type: "image", data: "abc", mimeType: "image/png" }], timestamp: 3 });
  const messages = sessionTranscript(c.session);
  assert.deepEqual(messages.slice(0, 2).map(m => m.entryId), [one, two]);
  assert.equal(messages[0].parts[1].data, "abc"); assert.equal(messages.at(-1).text.length, 20000);
  assert.ok(!messages.some(m => m.customType === "hidden"));
});

test("queued drafts retain images and only unconsumed messages are retrieved", async t => {
  let release, entered;
  const gate = new Promise(r => release = r), started = new Promise(r => entered = r);
  const f = await fixture(t, null, async () => { entered(); await gate; return [{ type: "text", text: "done" }]; });
  const c = await f.create(); await c.connect(() => {}).ready;
  const run = c.submit("first"); await started;
  await c.enqueue({ mode: "followUp", text: "later", images: [{ data: "abc", mimeType: "image/png" }], draft: { text: "original" } });
  const taken = c.takeQueue(); assert.equal(taken.items.length, 1); assert.equal(taken.items[0].images[0].data, "abc");
  assert.equal(c.takeQueue().items.length, 0);
  release(); await run.completion;
  assert.equal(c.session.getSessionStats().userMessages, 1);
});

test("native fork and tree navigation keep source and export reopens in Pi", async t => {
  const f = await fixture(t); const c = await f.create(true); await c.connect(() => {}).ready;
  await c.submit("one").completion; await c.submit("two").completion;
  const messages = sessionTranscript(c.session), entry = messages.find(m => m.role === "user" && m.text === "two");
  const file = c.session.sessionFile, old = c.id;
  await c.runtime.fork(entry.entryId); assert.notEqual(c.id, old); assert.ok(fs.existsSync(file));
  await c.submit("alternative").completion;
  const output = path.join(f.dir, "export.jsonl"); c.session.exportToJsonl(output);
  const restored = SessionManager.open(output); assert.equal(restored.getSessionId(), c.id);
  assert.ok(restored.getEntries().length > 0);
  const target = c.session.sessionManager.getBranch().find(e => e.type === "message" && e.message.role === "assistant");
  const result = await c.navigate(target.id, { summarize: false }); assert.equal(result.cancelled, false);
  assert.equal(c.tree().leafId, target.id);
});
