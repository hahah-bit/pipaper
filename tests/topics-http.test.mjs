import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { setTimeout as delay } from "node:timers/promises";
import { topicProfile, topicFixtureData } from "./helpers/topic-fixture.mjs";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipaper-topic-test-"));
process.env.PIPAPER_DATA_DIR = path.join(dir, "data"); process.env.PIPAPER_LIBRARY_DIR = path.join(dir, "library");
const { registerTopicRoutes } = await import("../server/topics/routes.js");
const store = await import("../server/topics/store.js");
const { closeCatalog, resource } = await import("../server/storage/catalog.js");
test.after(() => {closeCatalog();fs.rmSync(dir, { recursive: true, force: true });});
async function fixture(t, overrides = {}) {
  const data = topicFixtureData(), app = express(); app.use(express.json()); registerTopicRoutes(app, { ...data, ...overrides });
  const server = app.listen(0, "127.0.0.1"); await new Promise(r => server.once("listening", r));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { api: async (url, body, method = body ? "POST" : "GET") => {
    const r = await fetch(base + url, { method, headers: { "Content-Type": "application/json" }, body: body == null ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json() };
  }, base, data };
}
async function waitIdle(api, id) { for (let i = 0; i < 300; i++) { const r = await api(`/topics/${id}`); if (!r.body.operations?.length) return r.body.task; await delay(20); } throw new Error("operation timeout"); }
test("first-topic profile snapshot, 3 conclusions, 10+ journals, independent chat, evidence deletion and complete removal", async t => {
  const { api } = await fixture(t);
  const p = (await api("/topics/profiles", topicProfile)).body.profile;
  assert.equal((await api("/topics", { mode: "topic", profileIds: [p.id] })).status, 400);
  const task = (await api("/topics", { mode: "topic", profileId: p.id })).body.task;
  await api(`/topics/profiles/${p.id}`, { ...topicProfile, name: "已修改" }, "PUT");
  assert.equal((await api(`/topics/${task.id}`)).body.task.profile.name, topicProfile.name);
  const result = await api(`/topics/${task.id}/analyze`, {}); assert.equal(result.status, 202);
  const ready = await waitIdle(api, task.id); assert.equal(ready.status, "completed", ready.lastError);
  const report = (await api(`/topics/${task.id}/files/${ready.reportId}`)).body.data;
  assert.equal(report.conclusions.length, 3); assert.ok(report.journals.length >= 10); assert.equal(report.journals[0].cas, null); assert.equal(report.journals[0].review, null);
  assert.ok(report.conclusions[0].baselines[0].code.length); assert.equal(report.profile.name, topicProfile.name);
  await api(`/topics/${task.id}/chat`, { text: "哪个方向先做？" }); const chatted = await waitIdle(api, task.id); assert.equal(chatted.chat.length, 2); assert.equal(chatted.chat[1].status, "complete");
  const evidence = ready.artifacts.find(a => a.kind === "document");
  const removed = await api(`/topics/${task.id}/files/${evidence.id}`, null, "DELETE"); assert.equal(removed.status, 200); assert.ok(removed.body.removed.includes(ready.reportId));
  const cleared = (await api(`/topics/${task.id}`)).body.task; assert.equal(cleared.chat.length, 0); assert.equal(cleared.memory, ""); assert.equal(cleared.reportId, null);
  assert.equal((await api(`/topics/${task.id}`, { ui: { chatDraft: "deleted text must not return" }, chatEpoch: 0 }, "PATCH")).status, 409);
  assert.equal((await api(`/topics/${task.id}`)).body.task.ui.chatDraft, "");
  assert.equal((await api(`/topics/${task.id}/files/${ready.reportId}`)).status, 404);
  await api(`/topics/${task.id}`, null, "DELETE"); assert.equal(fs.existsSync(store.folder(task.id)), false); assert.equal((await api(`/topics/${task.id}`)).status, 404);
  assert.ok((await api("/topics/profiles")).body.profiles.some(x => x.id === p.id));
});
test("direction exploration ignores profiles; stop and deletion cannot allow late results to recreate task files", async t => {
  const data = topicFixtureData();
  let entered; const started = new Promise(r => { entered = r; });
  const model = async options => {
    if (options.input.task === "topic_concepts") { entered(); await new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })); }
    return data.model(options);
  };
  const { api } = await fixture(t, { model });
  const task = (await api("/topics", { mode: "direction", researchArea: "工业异常检测", profileId: "must-ignore" })).body.task;
  assert.equal(task.profile, null); await api(`/topics/${task.id}/analyze`, {}); await started;
  assert.equal((await api(`/topics/${task.id}/analyze`, {})).status, 409);
  assert.equal((await api(`/topics/${task.id}`, { title: "不能运行中改写" }, "PATCH")).status, 409);
  assert.equal((await api(`/topics/${task.id}`, null, "DELETE")).status, 200); await delay(30); assert.equal(fs.existsSync(store.folder(task.id)), false);
});
test("persisted interrupted work recovers and insufficient evidence never claims a finished report", async t => {
  const data = topicFixtureData();
  const { api } = await fixture(t, { sources: { ...data.sources, works: async () => ({ papers: [], total: 0 }), arxiv: async () => ({ papers: [] }) } });
  const task = (await api("/topics", { mode: "direction", researchArea: "没有数据的领域" })).body.task;
  await api(`/topics/${task.id}/analyze`, {}); const done = await waitIdle(api, task.id); assert.equal(done.status, "insufficient"); assert.ok(done.reportId);
  const diagnostic = (await api(`/topics/${task.id}/files/${done.reportId}`)).body.data;
  assert.equal(diagnostic.phase, "evidence"); assert.equal(diagnostic.conclusions.length, 0); assert.ok(diagnostic.warnings.some(w => /不足/.test(w)));
  store.change(task.id, t => { t.status = "running"; t.chatBusy = true; t.chat = [{ role: "assistant", text: "半条回复", status: "streaming" }]; }); store.recover();
  const recovered = store.read(task.id); assert.equal(recovered.status, "interrupted"); assert.equal(recovered.chatBusy, false); assert.equal(recovered.chat[0].status, "interrupted");
  await api(`/topics/${task.id}`, null, "DELETE");
});

test("directions are readable while journals are pending and survive stopping an unresponsive provider", async t => {
  const data = topicFixtureData();
  let entered; const waiting = new Promise(resolve => { entered = resolve; });
  const { api } = await fixture(t, { model: options => {
    if (options.input.task === "topic_venues") { entered(); return new Promise(() => {}); }
    return data.model(options);
  } });
  const p = (await api("/topics/profiles", topicProfile)).body.profile;
  const task = (await api("/topics", { mode: "topic", profileId: p.id })).body.task;
  await api(`/topics/${task.id}/analyze`, {}); await waiting;
  const working = (await api(`/topics/${task.id}`)).body;
  assert.equal(working.task.status, "running"); assert.ok(working.task.reportId);
  const report = (await api(`/topics/${task.id}/files/${working.task.reportId}`)).body.data;
  assert.equal(report.status, "partial"); assert.equal(report.conclusions.length, 3); assert.equal(report.journals.length, 0);
  assert.equal((await api(`/topics/${task.id}/stop`, {})).status, 200);
  const stopped = await waitIdle(api, task.id);
  assert.equal(stopped.status, "interrupted"); assert.equal(stopped.reportId, working.task.reportId);
  await api(`/topics/${task.id}`, null, "DELETE");
});

test("analysis deadline releases the operation and rejects late model writes", async t => {
  let release;
  const { api } = await fixture(t, { analysisTimeoutMs: 60, model: () => new Promise(resolve => { release = resolve; }) });
  const task = (await api("/topics", { mode: "direction", researchArea: "超时恢复测试" })).body.task;
  await api(`/topics/${task.id}/analyze`, {});
  const done = await waitIdle(api, task.id);
  assert.equal(done.status, "failed"); assert.match(done.lastError, /时限/);
  const revision = done.revision;
  release({ value: {}, model: { provider: "test", id: "late" } }); await delay(30);
  assert.equal((await api(`/topics/${task.id}`)).body.task.revision, revision);
  await api(`/topics/${task.id}`, null, "DELETE");
});

test("chat receives actual analysis progress and successful evidence even after recent source failures", async t => {
  const data = topicFixtureData(); let input;
  const { api } = await fixture(t, { model: options => { input = options.input; return data.model(options); } });
  const task = (await api("/topics", { mode: "direction", researchArea: "检索进度" })).body.task;
  store.artifact(task.id, "search", "successful search", { status: "ok", query: "anomaly detection", papers: [{ title: "Saved evidence", url: "https://example.org/paper" }] });
  for (let i = 0; i < 2; i++) store.artifact(task.id, "search", "failed search", { status: "error", error: "ETIMEDOUT" });
  store.change(task.id, t => { t.stage = "search"; t.progress = { text: "来源请求超时" }; });
  await api(`/topics/${task.id}/chat`, { text: "为什么还没出报告？" }); await waitIdle(api, task.id);
  assert.equal(input.analysisState.savedSearches, 3); assert.equal(input.analysisState.progress.text, "来源请求超时");
  assert.equal(input.searches[0].papers[0].title, "Saved evidence"); assert.equal(input.report, null);
  await api(`/topics/${task.id}`, null, "DELETE");
});
test("failed physical deletion retains a retryable lifecycle record and blocks new writes", async t => {
  const { api } = await fixture(t);
  const task = (await api("/topics", { mode: "direction", researchArea: "删除重试测试" })).body.task;
  const evidence = store.artifact(task.id, "evidence", "locked evidence", { text: "test evidence" });
  const report = store.artifact(task.id, "report", "dependent report", { test: true }, [evidence]);
  store.change(task.id, x => { x.reportId = report; });
  const original = fs.renameSync;
  const mock = t.mock.method(fs, "renameSync", (file, options) => {
    if (String(file).endsWith(`${evidence}.json`)) throw Object.assign(new Error("simulated file lock"), { code: "EPERM" });
    return original(file, options);
  });
  assert.equal((await api(`/topics/${task.id}/files/${evidence}`, null, "DELETE")).status, 400);
  assert.ok(store.read(task.id).cleanupError); assert.equal((await api(`/topics/${task.id}/chat`, { text: "不能写入" })).status, 409);
  mock.mock.restore();
  assert.equal((await api(`/topics/${task.id}/files/${evidence}`, null, "DELETE")).status, 200); assert.equal(store.read(task.id).cleanupError, null);
  store.artifact(task.id, "search", "new file", { test: true });
  const failure = t.mock.method(fs, "renameSync", (file, options) => {
    if (String(file) === store.folder(task.id)) throw Object.assign(new Error("simulated directory lock"), { code: "EPERM" });
    return original(file, options);
  });
  assert.equal((await api(`/topics/${task.id}`, null, "DELETE")).status, 400); assert.equal(resource("topic:"+task.id).lifecycle, "trashed");
  failure.mock.restore(); assert.equal((await api(`/topics/${task.id}`, null, "DELETE")).status, 200); assert.equal(fs.existsSync(store.folder(task.id)), false);
});
