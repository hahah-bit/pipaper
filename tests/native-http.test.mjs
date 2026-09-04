import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { nativeHttpFixture } from "./helpers/native-http-fixture.mjs";
import { createSessionEventChannel } from "../src/sessionEventChannel.js";

test("disconnect during cold resource loading cannot leave a ghost SSE owner", { timeout: 20000 }, async t => {
  const fixture = await nativeHttpFixture();
  const state = {}, transport = createSessionEventChannel({ state, fetch: (route, options) => fetch(fixture.url + route, options) });
  t.after(async () => { transport.closeSessionEvents(); await fixture.dispose(); });
  const api = async (route, body) => {
    const res = await fetch(fixture.url + "/api" + route, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...(state.controlId ? { "X-Pi-Control": state.controlId } : {}) }, body: body ? JSON.stringify(body) : undefined });
    assert.equal(res.ok, true); return res.json();
  };
  const { id } = await api("/sessions", {});
  await transport.connectSessionEvents(id, () => {});
  await transport.waitOperation((await api(`/sessions/${id}/prompt`, { text: "persist local fixture" })).operationId);
  transport.closeSessionEvents();
  const started = path.join(fixture.directory, "load-started"), release = path.join(fixture.directory, "load-release");
  fs.writeFileSync(path.join(fixture.agent, "extensions", "slow-restore.js"), `import fs from "node:fs";
    export default async function() {
      fs.writeFileSync(${JSON.stringify(started)}, "started");
      while (!fs.existsSync(${JSON.stringify(release)})) await new Promise(r => setTimeout(r, 10));
    }`);
  await fixture.restart();
  const abort = new AbortController();
  const pending = assert.rejects(fetch(`${fixture.url}/api/sessions/${id}/events`, { signal: abort.signal }), { name: "AbortError" });
  for (let attempt = 0; attempt < 200 && !fs.existsSync(started); attempt++) await new Promise(r => setTimeout(r, 10));
  assert.equal(fs.existsSync(started), true, "resource loader must be waiting before disconnect");
  abort.abort(); await pending;
  await new Promise(r => setTimeout(r, 30));
  fs.writeFileSync(release, "continue");
  await api(`/sessions/${id}/state`);
  assert.equal((await api("/sessions")).sessions.find(s => s.id === id).connected, false);
  await transport.connectSessionEvents(id, () => {});
  assert.ok(state.controlId, "the next page can connect normally");
});

test("production HTTP harness: owner channel, model/tool dialogs, resource packages, fork and export", { timeout: 60000 }, async t => {
  const fixture = await nativeHttpFixture();
  let controlId, id;
  const request = async (route, body, method = body ? "POST" : "GET", owner = controlId) => {
    const res = await fetch(fixture.url + "/api" + route, { method, headers: { "Content-Type": "application/json", ...(owner ? { "X-Pi-Control": owner } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const project = (await request("/projects", { name: "Native integration" })).body;
  id = (await request("/sessions", { projectId: project.id })).body.id;
  const abort = new AbortController();
  let reading;
  t.after(async () => { abort.abort(); await reading?.catch(() => {}); await fixture.dispose(); });
  const stream = await fetch(`${fixture.url}/api/sessions/${id}/events`, { signal: abort.signal });
  assert.equal(stream.status, 200);
  const events = [], listeners = new Set();
  const wait = (predicate, timeout = 12000) => {
    const existing = events.find(predicate); if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const handler = event => { if (predicate(event)) { clearTimeout(timer); listeners.delete(handler); resolve(event); } };
      const timer = setTimeout(() => { listeners.delete(handler); reject(new Error("Timed out: " + events.slice(-4).map(e => JSON.stringify(e)).join("\n"))); }, timeout);
      listeners.add(handler);
    });
  };
  const reader = stream.body.getReader();
  reading = (async () => {
    const decoder = new TextDecoder(); let buffer = "";
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const pieces = buffer.split("\n\n"); buffer = pieces.pop();
      for (const piece of pieces) {
        if (!piece.startsWith("data: ")) continue;
        const event = JSON.parse(piece.slice(6)); events.push(event);
        if (event.t === "connected") controlId = event.controlId;
        if (event.t === "session_replaced") id = event.newSessionId;
        for (const listener of listeners) listener(event);
      }
    }
  })().catch(error => { if (error.name !== "AbortError") throw error; });
  reading.catch(() => {});
  await wait(e => e.t === "operation_end" && e.kind === "startup");
  assert.equal((await request(`/sessions/${id}/binding`, { paperId: "fixture-paper", projectId: project.id })).status, 200);
  assert.equal((await request(`/sessions/${id}/state`)).body.meta.paperId, "fixture-paper");
  assert.equal((await request(`/sessions/${id}/name`, { name: "bad" }, "POST", "wrong")).status, 409);
  const duplicate = await fetch(`${fixture.url}/api/sessions/${id}/events`); assert.equal(duplicate.status, 409); await duplicate.text();
  const complete = async (operation) => {
    assert.equal(operation.status < 400, true, JSON.stringify(operation.body));
    const end = await wait(e => e.t === "operation_end" && e.id === operation.body.operationId);
    assert.equal(end.error, undefined); return end;
  };
  const prompt = await request(`/sessions/${id}/prompt`, { text: "ask-choice" });
  const question = await wait(e => e.t === "ui_request");
  assert.equal((await request(`/sessions/${id}/ui/${question.request.id}`, { value: "精读" })).status, 200);
  await complete(prompt);
  const history = (await request(`/sessions/${id}`)).body;
  assert.ok(history.messages.some(m => m.role === "toolResult" && m.text.includes("精读")));
  assert.ok(history.stats.tokens.total > 0);
  assert.ok(history.thinkingLevels.includes("minimal"));
  const retryBefore = events.at(-1).seq;
  await complete(await request(`/sessions/${id}/prompt`, { text: "retry-once" }));
  assert.ok(events.some(e => e.seq > retryBefore && e.t === "state" && e.state.retry?.attempt === 1));
  assert.equal((await request(`/sessions/${id}/state`)).body.retry, null);
  const slow = await request(`/sessions/${id}/prompt`, { text: "slow parent" });
  await wait(e => e.t === "user_start" && e.text === "slow parent");
  const queued = await request(`/sessions/${id}/steer`, { text: "queued reading", mode: "followUp", images: [{ mimeType: "image/png", data: "aW1hZ2U=" }], draft: { text: "original reading" } });
  assert.equal(queued.status, 200);
  const taken = (await request(`/sessions/${id}/queue/take`, {})).body.items;
  assert.equal(taken[0].images[0].data, "aW1hZ2U="); assert.equal(taken[0].draft.text, "original reading");
  assert.equal((await request(`/sessions/${id}/queue/take`, {})).body.items.length, 0);
  await complete(slow);
  await complete(await request(`/sessions/${id}/compact`, { instructions: "保留论文结论" }));
  assert.ok((await request(`/sessions/${id}`)).body.messages.some(m => m.role === "compactionSummary" && m.text.length));

  // A local Pi package needs no registry/network and contains all three resource types.
  const pkg = path.join(fixture.directory, "package");
  fs.mkdirSync(path.join(pkg, "skills", "local-skill"), { recursive: true }); fs.mkdirSync(path.join(pkg, "prompts"));
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "local-audit", pi: { extensions: ["extension.js"], skills: ["skills"], prompts: ["prompts"] } }));
  fs.writeFileSync(path.join(pkg, "extension.js"), 'export default function(pi) { pi.registerCommand("package-check", {description:"local command", handler:()=>pi.setSessionName("package works")}); }');
  fs.writeFileSync(path.join(pkg, "skills", "local-skill", "SKILL.md"), '---\nname: local-skill\ndescription: local skill\n---\nRead the paper.');
  fs.writeFileSync(path.join(pkg, "prompts", "local-prompt.md"), '---\ndescription: local prompt\n---\nSummarize $1');
  const before = events.at(-1).seq;
  const installed = await request("/pi/packages/install", { spec: pkg, projectId: project.id, scope: "project" });
  assert.equal(installed.status, 200, JSON.stringify(installed.body));
  await wait(e => e.seq > before && e.t === "operation_end" && e.kind === "reload");
  const commands = (await request(`/pi/commands?sessionId=${id}`)).body;
  assert.ok(commands.skills.some(s => s.name === "local-skill"));
  assert.ok(commands.prompts.some(s => s.name === "local-prompt"));
  assert.ok(commands.extensions.some(s => s.name === "package-check"));
  await complete(await request(`/sessions/${id}/prompt`, { text: "/package-check" }));
  assert.equal((await request(`/sessions/${id}/state`)).body.name, "package works");
  const revisionBefore = events.at(-1).seq;
  await request(`/projects/${project.id}`, { resources: { schemaVersion: 2, skillsMode: "selected", skillsEnabled: [] } }, "PUT");
  await wait(e => e.seq > revisionBefore && e.t === "operation_end" && e.kind === "reload");
  assert.equal((await request(`/pi/commands?sessionId=${id}`)).body.skills.length, 0);
  const removeBefore = events.at(-1).seq;
  assert.equal((await request("/pi/packages/remove", { spec: pkg, projectId: project.id, scope: "project" })).status, 200);
  await wait(e => e.seq > removeBefore && e.t === "operation_end" && e.kind === "reload");
  assert.ok(!(await request(`/pi/commands?sessionId=${id}`)).body.extensions.some(s => s.name === "package-check"));

  await complete(await request(`/sessions/${id}/prompt`, { text: "second question" }));
  const original = id;
  const target = (await request(`/sessions/${id}`)).body.messages.find(m => m.role === "user" && m.text === "second question");
  await complete(await request(`/sessions/${id}/fork`, { entryId: target.entryId, title: "新路径" }));
  assert.notEqual(id, original);
  await complete(await request(`/sessions/${id}/prompt`, { text: "alternative" }));
  const tree = (await request(`/sessions/${id}/tree`)).body; assert.ok(tree.nodes.length);
  await request(`/sessions/${id}/tree/label`, { entryId: tree.leafId, label: "结论节点" });
  assert.equal((await request(`/sessions/${id}/tools`, { names: ["read", "grep", "find", "ls"], saveProjectDefault: true })).status, 200);
  await wait(e => e.t === "state" && e.state.resources.status === "applied" && e.state.resources.revision > 0 && e.seq > events.findLast(x => x.t === "operation_end" && x.kind === "prompt").seq);
  await complete(await request(`/sessions/${id}/prompt`, { text: "verify selected tools" }));
  assert.deepEqual(fixture.modelRequests.at(-1).tools.map(t => t.function.name).sort(), ["find", "grep", "ls", "read"]);
  for (const format of ["jsonl", "html"]) {
    const exported = await fetch(`${fixture.url}/api/sessions/${id}/export`, { method: "POST", headers: { "Content-Type": "application/json", "X-Pi-Control": controlId }, body: JSON.stringify({ format }) });
    const text = await exported.text(); assert.equal(exported.status, 200, text.slice(0,200));
    assert.ok(text.length > 100); assert.ok(exported.headers.get("content-disposition").includes("attachment"));
  }
  assert.ok((await request("/sessions")).body.sessions.some(s => s.id === original));
  // Restart the actual app process; the file and application bindings must agree.
  const persisted = path.join(fixture.data, "sessions-index.json");
  for (let attempt = 0; attempt < 20; attempt++) {
    if (fs.existsSync(persisted) && JSON.parse(fs.readFileSync(persisted, "utf8"))[id]?.title === "新路径") break;
    await new Promise(r => setTimeout(r, 25));
  }
  abort.abort(); await reading;
  await fixture.restart();
  const reopened = (await request(`/sessions/${id}`)).body;
  assert.equal(reopened.name, "新路径"); assert.equal(reopened.meta.paperId, "fixture-paper");
  assert.ok(reopened.messages.some(m => m.text === "alternative"));
  assert.deepEqual((await request(`/pi/resources?sessionId=${id}`)).body.tools.filter(x => x.enabled).map(x => x.name).sort(), ["find", "grep", "ls", "read"]);
  const findLabel = nodes => nodes.some(n => n.label === "结论节点" || findLabel(n.children));
  assert.ok(findLabel((await request(`/sessions/${id}/tree`)).body.nodes));
});
