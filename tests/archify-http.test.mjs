import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { nativeHttpFixture } from "./helpers/native-http-fixture.mjs";
import { studyFixture } from "./helpers/study-fixture.mjs";
import { archifyModelResponse, fakeArchify } from "./helpers/archify-fixture.mjs";
import { createSessionEventChannel } from "../src/sessionEventChannel.js";

async function setup(t, studies = false) {
  const f = await (studies ? studyFixture : nativeHttpFixture)({ respond: archifyModelResponse, contextWindow: 64000 });
  const channels = [];
  t.after(async () => { channels.forEach(channel => channel.closeSessionEvents()); await f.dispose(); });
  const request = async (route, body, method = body ? "POST" : "GET", controlId) => {
    const response = await fetch(f.url + "/api" + route, { method, headers: { "Content-Type": "application/json", ...(controlId ? { "X-Pi-Control": controlId } : {}) }, body: body == null ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const installation = process.env.PIPAPER_TEST_ARCHIFY_DIR || fakeArchify(f.directory);
  assert.equal((await request("/archify/config", { path: installation }, "PUT")).body.ready, true);
  const connect = async id => {
    const state = {}, events = [];
    const channel = createSessionEventChannel({ state, fetch: (url, options) => fetch(f.url + url, options) }); channels.push(channel);
    await channel.connectSessionEvents(id, event => events.push(event));
    return { state, channel, events, async prompt(text) {
      const result = await request(`/sessions/${id}/prompt`, { text }, "POST", state.controlId);
      assert.equal(result.status, 202, JSON.stringify(result.body));
      await channel.waitOperation(result.body.operationId);
      return [...events].reverse().find(e => e.t === "tool_end" && e.name === "archify");
    } };
  };
  return { f, request, connect };
}

test("Archify native tool publishes validated files, preserves prior versions, reports errors and survives restart", { timeout: 60000 }, async t => {
  const { f, request, connect } = await setup(t);
  const id = (await request("/sessions", { paperId: "fixture-paper" })).body.id;
  const chat = await connect(id);
  const help = await chat.prompt("help diagram");
  assert.equal(help.isError, false);
  assert.ok(help.details.schema);
  const first = await chat.prompt("render diagram");
  assert.equal(first.isError, false, JSON.stringify(first));
  assert.equal(first.details.ok, true);
  const artifact = first.details.artifact;
  assert.equal(artifact.sessionId, id);
  assert.equal(artifact.paperId, "fixture-paper");
  const html = await fetch(f.url + artifact.previewUrl);
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-security-policy"), /sandbox allow-scripts allow-downloads/);
  assert.doesNotMatch(html.headers.get("content-security-policy"), /allow-same-origin/);
  assert.match(await html.text(), /<svg/);
  assert.equal((await fetch(f.url + artifact.sourceUrl)).status, 200);
  assert.match((await fetch(f.url + artifact.previewUrl + "?download=1")).headers.get("content-disposition"), /attachment/);
  const receipt = await (await fetch(f.url + artifact.receiptUrl)).json();
  assert.ok(receipt);
  const second = await chat.prompt("render diagram again");
  assert.notEqual(second.details.artifact.id, artifact.id);
  const bad = await chat.prompt("invalid diagram");
  assert.equal(bad.isError, true);
  assert.ok(JSON.parse(bad.content[0].text).diagnostics);
  assert.equal((await request("/archify/artifacts")).body.artifacts.length, 2);
  assert.equal((await fetch(f.url + artifact.previewUrl)).status, 200);
  assert.equal((await fetch(f.url + `/api/archify/artifacts/${artifact.id}/meta.json`)).status, 404);
  assert.equal((await request("/archify/config", { path: path.join(f.directory, "not-installed") }, "PUT")).body.ready, false);
  const missing = await chat.prompt("render diagram missing installation");
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /Archify/);
  chat.channel.closeSessionEvents(); await f.restart();
  assert.equal((await request("/archify/artifacts")).body.artifacts.length, 2);
  assert.equal((await fetch(f.url + artifact.previewUrl)).status, 200);
  assert.ok(f.modelRequests.some(req => req.tools?.some(tool => tool.function?.name === "archify")));
});

test("Archify study assets export with source and receipt, remain in snapshots, and are deleted with their task", { timeout: 60000 }, async t => {
  const { f, request, connect } = await setup(t, true);
  const upload = await fetch(f.url + "/api/studies/import", { method: "PUT", headers: { "Content-Type": "application/pdf", "X-Filename": "Routing.pdf" }, body: f.pdf });
  const task = await upload.json(); assert.equal(upload.status, 201);
  const chat = await connect(task.chatSessionId), guide = await connect(task.guideSessionId);
  const result = await chat.prompt("render diagram in study");
  assert.equal(result.details.ok, true, JSON.stringify(result));
  const artifact = result.details.artifact;
  assert.equal(artifact.studyId, task.id);
  const saved = (await request(`/studies/${task.id}`)).body.task;
  assert.ok(saved.artifacts.some(a => a.id === artifact.id));
  assert.equal(saved.cursor, 0, "free chat never advances the study");
  const exported = await request(`/studies/${task.id}/export`, {}, "POST", guide.state.controlId);
  await guide.channel.waitOperation(exported.body.operationId);
  const archive = path.join(f.directory, "knowledge", "论文研读", task.id, "assets", "archify", artifact.id);
  for (const file of ["diagram.html", "source.json", "receipt.json"]) assert.ok(fs.existsSync(path.join(archive, file)));
  assert.doesNotMatch(fs.readFileSync(path.resolve(archive, "../../../研读成果.md"), "utf8"), /!\[网站请求/);
  chat.channel.closeSessionEvents(); guide.channel.closeSessionEvents();
  assert.equal((await request(`/studies/${task.id}`, null, "DELETE")).status, 200);
  assert.equal(fs.existsSync(path.join(f.data, "studies", task.id)), false);
  assert.equal((await fetch(f.url + artifact.previewUrl)).status, 404);
  assert.equal((await fetch(f.url + `/api/study-library/${task.id}/assets/archify/${artifact.id}/diagram.html`)).status, 200);
  assert.equal((await request("/archify/artifacts")).body.artifacts.length, 0);
});

test("deleting a study during Archify generation cannot publish or recreate its task", { timeout: 30000, skip: !!process.env.PIPAPER_TEST_ARCHIFY_DIR }, async t => {
  const { f, request, connect } = await setup(t, true);
  const upload = await fetch(f.url + "/api/studies/import", { method: "PUT", headers: { "Content-Type": "application/pdf", "X-Filename": "Routing.pdf" }, body: f.pdf });
  const task = await upload.json(), chat = await connect(task.chatSessionId);
  const result = await request(`/sessions/${task.chatSessionId}/prompt`, { text: "slow diagram" }, "POST", chat.state.controlId);
  const completion = chat.channel.waitOperation(result.body.operationId).catch(() => {});
  for (let i = 0; i < 200 && !chat.events.some(e => e.t === "tool_start" && e.name === "archify"); i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(chat.events.some(e => e.t === "tool_start" && e.name === "archify"));
  assert.equal((await request(`/studies/${task.id}`, null, "DELETE")).status, 200);
  await completion;
  assert.equal(fs.existsSync(path.join(f.data, "studies", task.id)), false);
  assert.equal((await request("/archify/artifacts")).body.artifacts.length, 0);
  const pending = path.join(f.data, "archify", ".pending");
  assert.deepEqual(fs.existsSync(pending) ? fs.readdirSync(pending) : [], []);
});
