import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createSessionEventChannel } from "../src/sessionEventChannel.js";
import { studyFixture, mockStudyResponse } from "./helpers/study-fixture.mjs";

test("study lifecycle: isolated sessions, mastery, restart, translations, snapshot and physical deletion", { timeout: 120000 }, async t => {
  let malformed = false;
  const f = await studyFixture({ respond: (req, text) => malformed ? "not valid JSON" : mockStudyResponse(req, text) });
  const channels = [];
  t.after(async () => { channels.forEach(c => c.closeSessionEvents()); await f.dispose(); });
  const api = async (route, body, method = body ? "POST" : "GET", owner) => {
    const res = await fetch(f.url + "/api" + route, { method, headers: { "Content-Type": "application/json", ...(owner ? { "X-Pi-Control": owner } : {}) }, body: body == null ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  const upload = async goal => {
    const res = await fetch(f.url + "/api/studies/import", { method: "PUT", headers: { "Content-Type": "application/pdf", "X-Filename": "Routing.pdf", "X-Study-Options": encodeURIComponent(JSON.stringify({ goal, goalType: "innovate" })) }, body: f.pdf });
    const data = await res.json(); assert.equal(res.status, 201, JSON.stringify(data)); return data;
  };
  let task = await upload("理解鲁棒性并设计改进");
  const second = await upload("独立复现目标");
  assert.notEqual(task.id, second.id); assert.equal(task.paperId, second.paperId);
  assert.ok(!(await api("/papers")).data.papers.some(p => p.id === task.paperId));
  assert.ok(!(await api("/sessions")).data.sessions.some(s => s.id === task.guideSessionId));
  const state = {}, chatState = {};
  const channel = createSessionEventChannel({ state, fetch: (url, init) => fetch(f.url + url, init) });
  const chatChannel = createSessionEventChannel({ state: chatState, fetch: (url, init) => fetch(f.url + url, init) }); channels.push(channel, chatChannel);
  await channel.connectSessionEvents(task.guideSessionId, () => {}); await chatChannel.connectSessionEvents(task.chatSessionId, () => {});
  assert.notEqual(state.controlId, chatState.controlId);
  assert.equal((await api(`/studies/${task.id}/prepare`, {}, "POST", chatState.controlId)).status, 409, "the right-side control token cannot operate the guide");
  const guideThinking = (await api(`/sessions/${task.guideSessionId}/state`)).data.thinkingLevel;
  await api(`/sessions/${task.chatSessionId}/model`, { thinkingLevel: "low" }, "POST", chatState.controlId);
  assert.equal((await api(`/sessions/${task.guideSessionId}/state`)).data.thinkingLevel, guideThinking);
  const run = async (action, body = {}, expectedError) => {
    const result = await api(`/studies/${task.id}/${action}`, body, "POST", state.controlId);
    assert.equal(result.status, 202, JSON.stringify(result.data));
    if (expectedError) await assert.rejects(channel.waitOperation(result.data.operationId), expectedError);
    else await channel.waitOperation(result.data.operationId);
    task = (await api(`/studies/${task.id}`)).data.task;
  };
  await run("prepare"); assert.ok(task.versionId); assert.equal(task.checkpoints.length, 5);
  assert.equal((await api(`/sessions/${task.guideSessionId}/prompt`, { text: "skip to summary" }, "POST", state.controlId)).status, 409);
  assert.equal((await api(`/sessions/${task.chatSessionId}/binding`, { paperId: "other" }, "POST", chatState.controlId)).status, 409);
  await run("advance", { checkpointId: "rough_0" }, /考查/);
  await run("advance", { checkpointId: "summary_0" }, /检查点/);
  malformed = true; await run("lesson", { checkpointId: "rough_0" }, /结构化/); malformed = false;
  assert.equal(task.checkpoints[0].lesson, undefined);
  const overlapping = await api(`/sessions/${task.chatSessionId}/prompt`, { text: "slow: explain the baseline" }, "POST", chatState.controlId);
  await run("lesson", { checkpointId: "rough_0" });
  await chatChannel.waitOperation(overlapping.data.operationId);
  assert.equal(task.checkpoints[0].lesson.questions[0].rubric, undefined, "answer keys are not exposed in task responses");
  const answers = Object.fromEntries(task.checkpoints[0].lesson.questions.map(q => [q.id, "不知道"]));
  await run("answers", { checkpointId: "rough_0", answers: {} }, /完整回答/);
  malformed = true; await run("answers", { checkpointId: "rough_0", answers }, /结构化/); malformed = false;
  assert.equal(task.checkpoints[0].attempts.length, 0, "a model failure is never accepted as mastery");
  await run("answers", { checkpointId: "rough_0", answers }); assert.equal(task.checkpoints[0].status, "awaiting-answers");
  await run("answers", { checkpointId: "rough_0", answers }, /已经评估/);
  Object.keys(answers).forEach(key => answers[key] = "我理解：方法用扰动训练提高泛化，对照实验验证提升，但大规模图边界尚未证明。");
  await run("answers", { checkpointId: "rough_0", answers }); assert.equal(task.checkpoints[0].status, "passed");
  const freePrompt = await api(`/sessions/${task.chatSessionId}/prompt`, { text: "explain the baseline" }, "POST", chatState.controlId);
  await chatChannel.waitOperation(freePrompt.data.operationId);
  assert.equal((await api(`/studies/${task.id}`)).data.task.cursor, 0, "free discussion cannot advance mastery");
  await run("translate", { blockId: "abstract" });
  assert.ok(task.translations.abstract.translated.includes("$x_1=2$")); assert.ok(task.translations.abstract.translated.includes("95%"));
  const translationCount = f.modelRequests.length;
  await run("translate", { blockId: "abstract" }); assert.equal(f.modelRequests.length, translationCount, "repeating a translated block uses the model/version cache");
  await run("advance", { checkpointId: "rough_0" }); assert.equal(task.cursor, 1);
  const prevVersion = task.versionId, prevSessions = [task.guideSessionId, task.chatSessionId];
  assert.equal((await api(`/studies/${task.id}/ui`, { page: 3, pdfOffset: 0.42, readerScroll: 120, tab: "pdf" }, "PATCH")).status, 200);
  channel.closeSessionEvents(); chatChannel.closeSessionEvents(); await f.restart();
  task = (await api(`/studies/${task.id}`)).data.task;
  assert.equal(task.ui.page, 3); assert.equal(task.ui.pdfOffset, 0.42); assert.equal(task.ui.readerScroll, 120);
  assert.equal(task.versionId, prevVersion); assert.deepEqual([task.guideSessionId, task.chatSessionId], prevSessions); assert.equal(task.cursor, 1);
  await channel.connectSessionEvents(task.guideSessionId, () => {});
  await run("export");
  const archive = path.join(f.directory, "knowledge", "论文研读", task.id);
  assert.ok(fs.existsSync(path.join(archive, "论文.pdf"))); assert.ok(fs.existsSync(path.join(archive, "自由对话.md")));
  assert.ok((await api("/papers")).data.papers.some(p => p.id === task.paperId));
  channel.closeSessionEvents();
  const sessionFiles = JSON.parse(fs.readFileSync(path.join(f.data, "sessions-index.json"), "utf8"));
  assert.ok(sessionFiles[task.guideSessionId]);
  assert.equal((await api(`/studies/${task.id}`, undefined, "DELETE")).status, 200);
  assert.ok(!fs.existsSync(path.join(f.data, "studies", task.id))); assert.ok(fs.existsSync(archive));
  assert.equal((await fetch(f.url + `/api/study-library/${task.id}/论文.pdf`)).status, 200);
  assert.ok(fs.existsSync(f.parsed), "managed/shared parse cache survives task deletion");
  assert.equal((await api(`/studies/${second.id}`, undefined, "DELETE")).status, 200);
  assert.ok(fs.existsSync(f.parsed), "materialized library paper retains its parse cache");
});

test("unpromoted duplicate PDF is removed only after its last task; deleted sessions cannot return", { timeout: 60000 }, async t => {
  const f = await studyFixture(); t.after(() => f.dispose());
  const create = async () => {
    const res = await fetch(f.url + "/api/studies/import", { method: "PUT", headers: { "Content-Type": "application/pdf", "X-Filename": "Routing.pdf" }, body: f.pdf }); assert.equal(res.status, 201); return res.json();
  };
  const first = await create(), second = await create();
  const del = async id => { const res = await fetch(f.url + `/api/studies/${id}`, { method: "DELETE" }); assert.equal(res.status, 200, await res.text()); };
  await del(first.id); assert.ok(fs.existsSync(f.parsed));
  await del(second.id); assert.ok(!fs.existsSync(f.parsed));
  assert.equal(fs.readdirSync(path.join(f.data, "study-papers")).length, 0);
  await f.restart();
  const res = await fetch(f.url + `/api/sessions/${second.chatSessionId}`); assert.equal(res.status, 404);
});

test("full deep-reading flow exercises Pi image failures, downloads, research and confirmed experiment plan", { timeout: 120000 }, async t => {
  let offline = true;
  const f = await studyFixture({ searchResponse: () => offline ? { status: 503, body: "unavailable" } : { body: '<div class="gs_r"><h3 class="gs_rt"><a href="https://example.org/paper">Verified research fixture</a></h3><div class="gs_a">Author - Venue, 2026</div><div class="gs_rs">Robustness evidence.</div><a href="https://example.org/paper.pdf">PDF</a></div>' } });
  const state = {}, chatState = {}, channels = [];
  t.after(async () => { channels.forEach(c => c.closeSessionEvents()); await f.dispose(); });
  const request = async (route, body, method = body ? "POST" : "GET") => {
    const res = await fetch(f.url + "/api" + route, { method, headers: { "Content-Type": "application/json", "X-Pi-Control": state.controlId || "" }, body: body == null ? undefined : JSON.stringify(body) });
    const data = await res.json(); assert.ok(res.ok, JSON.stringify(data)); return data;
  };
  const upload = await fetch(f.url + "/api/studies/import", { method: "PUT", headers: { "Content-Type": "application/pdf", "X-Filename": "Routing.pdf", "X-Study-Options": encodeURIComponent(JSON.stringify({ goalType: "innovate" })) }, body: f.pdf });
  let task = await upload.json();
  const guide = createSessionEventChannel({ state, fetch: (u, o) => fetch(f.url + u, o) }), chat = createSessionEventChannel({ state: chatState, fetch: (u, o) => fetch(f.url + u, o) }); channels.push(guide, chat);
  await guide.connectSessionEvents(task.guideSessionId, () => {}); await chat.connectSessionEvents(task.chatSessionId, () => {});
  const run = async (action, body = {}, error) => {
    const { operationId } = await request(`/studies/${task.id}/${action}`, body);
    if (error) await assert.rejects(guide.waitOperation(operationId), error); else await guide.waitOperation(operationId);
    task = (await request(`/studies/${task.id}`)).task;
  };
  const answer = async () => {
    const cp = task.checkpoints[task.cursor];
    await run("answers", { checkpointId: cp.id, answers: Object.fromEntries(cp.lesson.questions.map(q => [q.id, "我理解机制、对照与证据边界。"])) });
  };
  await run("prepare");
  for (const checkpointId of ["rough_0", "introduction_0"]) { await run("lesson", { checkpointId }); await answer(); await run("advance", { checkpointId }); }
  await run("lesson", { checkpointId: "method_0" }); await answer();
  await run("image/generate", { checkpointId: "method_0", kind: "architecture" }, /未加载/);
  assert.equal(task.artifacts.length, 0);
  const outputDir = path.join(f.data, "study-image-output"), failFile = path.join(f.data, "image-fail");
  fs.mkdirSync(outputDir, { recursive: true }); fs.writeFileSync(failFile, "fail");
  fs.writeFileSync(path.join(f.agent, "extensions", "image-fixture.js"), `import fs from 'node:fs'; import path from 'node:path'; export default function(pi) {
    pi.registerTool({name:'image_generate',label:'Image fixture',description:'fixture',parameters:{type:'object',properties:{prompt:{type:'string'},filename:{type:'string'}},required:['prompt','filename']},
    async execute(_id,args) { if(fs.existsSync(${JSON.stringify(failFile)})) throw new Error('fixture image failed');
    const file=path.join(${JSON.stringify(outputDir)},args.filename+'.png');fs.writeFileSync(file,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64'));
    return {content:[{type:'text',text:'created'}],details:{images:[{path:file}]}};}}); }`);
  await run("image/config", { provider: "fixture", model: "fixture" });
  assert.equal((await request(`/studies/${task.id}/image/status`)).loaded, true);
  await run("image/generate", { checkpointId: "method_0", kind: "architecture" }, /fixture image failed/);
  assert.equal(task.artifacts.length, 0);
  fs.rmSync(failFile);
  await run("image/generate", { checkpointId: "method_0", kind: "architecture" });
  await run("advance", { checkpointId: "method_0" }, /流程图/);
  await run("image/generate", { checkpointId: "method_0", kind: "pipeline" });
  assert.equal(task.artifacts.length, 2); assert.equal(fs.readdirSync(outputDir).length, 0, "extension output is transferred into owned task assets");
  const imageUrl = f.url + `/api/studies/${task.id}/${task.artifacts[0].file}`;
  assert.equal((await fetch(imageUrl)).headers.get("content-type"), "image/png");
  await run("advance", { checkpointId: "method_0" });
  await run("lesson", { checkpointId: "experiments_0" }); await answer(); await run("advance", { checkpointId: "experiments_0" });
  await run("lesson", { checkpointId: "summary_0" }); await answer();
  assert.ok(task.checkpoints.at(-1).research.errors.length);
  await run("advance", { checkpointId: "summary_0", confirmPlan: true }, /检索/);
  offline = false; await run("research", { checkpointId: "summary_0" });
  assert.equal(task.checkpoints.at(-1).research.results[0].pdfUrl, "https://example.org/paper.pdf");
  await run("plan", { checkpointId: "summary_0", text: "增加图规模的破坏性实验" });
  assert.equal(task.checkpoints.at(-1).status, "awaiting-answers");
  await answer(); await run("advance", { checkpointId: "summary_0", confirmPlan: true });
  assert.equal(task.status, "completed");
  await run("export");
  const archivedFile = f.url + `/api/study-library/${task.id}/${task.artifacts[0].file}`;
  assert.ok(fs.existsSync(path.join(f.directory, "knowledge", "论文研读", task.id, task.artifacts[0].file)), JSON.stringify({ message: "snapshot must physically contain the diagram", artifacts: task.artifacts, exported: task.exports, files: fs.readdirSync(path.join(f.directory, "knowledge"), { recursive: true }) }));
  assert.equal((await fetch(archivedFile)).status, 200, "snapshot asset should be served before deletion");
  guide.closeSessionEvents(); chat.closeSessionEvents();
  await request(`/studies/${task.id}`, undefined, "DELETE");
  assert.equal((await fetch(imageUrl)).status, 404);
  assert.equal((await fetch(archivedFile)).status, 200, "snapshot diagrams remain usable after deleting the task");
});

test("deleting while a model is running aborts the operation and prevents late file recreation", { timeout: 60000 }, async t => {
  const f = await studyFixture({ respond: async (req, text) => { if (text.includes('"task":"study_lesson"')) await new Promise(r => setTimeout(r, 900)); return mockStudyResponse(req, text); } });
  const state = {}, channel = createSessionEventChannel({ state, fetch: (u, o) => fetch(f.url + u, o) });
  t.after(async () => { channel.closeSessionEvents(); await f.dispose(); });
  const response = await fetch(f.url + "/api/studies/import", { method: "PUT", headers: { "Content-Type": "application/pdf", "X-Filename": "Routing.pdf" }, body: f.pdf });
  const task = await response.json(); await channel.connectSessionEvents(task.guideSessionId, () => {});
  const post = async action => (await fetch(f.url + `/api/studies/${task.id}/${action}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Pi-Control": state.controlId }, body: JSON.stringify({ checkpointId: "rough_0" }) })).json();
  await channel.waitOperation((await post("prepare")).operationId);
  const operation = await post("lesson");
  const stopped = channel.waitOperation(operation.operationId).catch(() => {});
  const deletion = await fetch(f.url + `/api/studies/${task.id}`, { method: "DELETE" });
  assert.equal(deletion.status, 200); await stopped;
  await new Promise(r => setTimeout(r, 1100));
  assert.equal(fs.existsSync(path.join(f.data, "studies", task.id)), false);
  assert.equal(fs.existsSync(f.parsed), false);
});

test("whole-paper translation pauses, resumes cached blocks and retries structural failures", { timeout: 60000 }, async t => {
  let slowed = false, breakTable = true, firstSaved;
  const saved = new Promise(resolve => firstSaved = resolve);
  const f = await studyFixture({ respond: async (req, text) => {
    let input; try { input = JSON.parse(text); } catch { return; }
    if (input.task === "precise_translation" && input.source === "Abstract" && !slowed) { slowed = true; await new Promise(r => setTimeout(r, 1000)); }
    if (input.task === "precise_translation" && input.source.includes("Baseline") && input.source.includes("⟦PIPAPER_") && breakTable) return JSON.stringify({ translation: "A table with its numbers removed", terms: {} });
    return mockStudyResponse(req, text);
  } });
  const state = {}, channel = createSessionEventChannel({ state, fetch: (u, o) => fetch(f.url + u, o) });
  t.after(async () => { channel.closeSessionEvents(); await f.dispose(); });
  const response = await fetch(f.url + "/api/studies/import", { method: "PUT", headers: { "Content-Type": "application/pdf", "X-Filename": "Routing.pdf" }, body: f.pdf });
  const task = await response.json();
  await channel.connectSessionEvents(task.guideSessionId, event => { if (event.t === "study_translation" && event.blockId === "title") firstSaved(); });
  const post = async (route, body = {}) => {
    const res = await fetch(f.url + "/api" + route, { method: "POST", headers: { "Content-Type": "application/json", "X-Pi-Control": state.controlId }, body: JSON.stringify(body) }); const value = await res.json(); assert.ok(res.ok, JSON.stringify(value)); return value;
  };
  const run = async (action, body) => channel.waitOperation((await post(`/studies/${task.id}/${action}`, body)).operationId);
  await run("prepare");
  const initial = await post(`/studies/${task.id}/translate`), stopped = channel.waitOperation(initial.operationId);
  const stoppedCheck = assert.rejects(stopped);
  await saved; await post(`/sessions/${task.guideSessionId}/abort`); await stoppedCheck;
  const restored = await (await fetch(f.url + `/api/studies/${task.id}`)).json();
  assert.ok(restored.task.translations.title.translated); assert.ok(Object.keys(restored.task.translations).length < 12);
  const titleCalls = () => f.modelRequests.filter(r => { try { return JSON.parse(r.messages.at(-1).content).source === "A Robust Routing Baseline"; } catch { return false; } }).length;
  const before = titleCalls();
  await run("translate");
  const resumed = (await (await fetch(f.url + `/api/studies/${task.id}`)).json()).task;
  assert.equal(titleCalls(), before, "already saved blocks are not translated again after pause");
  assert.ok(resumed.translations.table.error); assert.ok(resumed.translations.conclusion.translated);
  breakTable = false; await run("translate", { blockId: "table", retry: true });
  const retried = (await (await fetch(f.url + `/api/studies/${task.id}`)).json()).task.translations.table;
  assert.ok(!retried.error); assert.ok(retried.translated.includes("<table>")); assert.ok(retried.translated.includes("95"));
});

test("a failed physical session cleanup stays visible and deletion can be retried", { timeout: 60000 }, async t => {
  const f = await studyFixture(); t.after(() => f.dispose());
  const response = await fetch(f.url + "/api/studies/import", { method: "PUT", headers: { "Content-Type": "application/pdf", "X-Filename": "Routing.pdf" }, body: f.pdf });
  const task = await response.json();
  const sessionRoot = path.join(f.agent, "sessions");
  const relative = fs.readdirSync(sessionRoot, { recursive: true }).find(p => p.endsWith(".jsonl") && fs.readFileSync(path.join(sessionRoot, p), "utf8").includes(task.guideSessionId));
  assert.ok(relative);
  const file = path.join(sessionRoot, relative), bytes = fs.readFileSync(file);
  // Simulate an on-disk failure without changing permissions on user files.
  fs.rmSync(file); fs.mkdirSync(file);
  const remove = () => fetch(f.url + `/api/studies/${task.id}`, { method: "DELETE" });
  const failed = await remove(); assert.equal(failed.status, 500); assert.match((await failed.json()).error, /删除会话/);
  const listing = await (await fetch(f.url + "/api/studies")).json();
  assert.equal(listing.studies.find(s => s.id === task.id).status, "delete-failed");
  fs.rmdirSync(file); fs.writeFileSync(file, bytes);
  const retry = await remove(); assert.equal(retry.status, 200, await retry.text());
  assert.ok(!fs.existsSync(file)); assert.ok(!fs.existsSync(path.join(f.data, "studies", task.id)));
});
