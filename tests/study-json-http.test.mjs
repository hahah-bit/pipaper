import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createSessionEventChannel } from "../src/sessionEventChannel.js";
import { studyFixture, mockStudyResponse } from "./helpers/study-fixture.mjs";

test("DeepSeek study requests enforce JSON, recover once, and never accept invalid mastery", { timeout: 60000 }, async t => {
  let mode = "markdown-once", attempts = 0, releaseRetry, retryStarted;
  const f = await studyFixture({ provider: "deepseek", respond: async (request, text) => {
    let prompt; try { prompt = JSON.parse(text); } catch { return; }
    if (!prompt.task) return "### 普通引导回答\n可以继续提问。";
    // Reproduce the real provider: without response_format it answers in Markdown.
    if (request.response_format?.type !== "json_object") return "### 问题与动机\n这是一篇多模态论文。";
    if (prompt.task === "study_lesson") {
      attempts++;
      if (mode === "markdown-always" || (mode === "markdown-once" && attempts === 1)) return "### 问题与动机\n这是一篇多模态论文。";
      if (mode === "cancel-retry") {
        if (attempts === 1) return "### 问题与动机";
        retryStarted();
        await new Promise(resolve => { releaseRetry = resolve; });
      }
      if (mode === "empty-once" && attempts === 1) return "";
      if (mode === "invalid-source-once" && attempts === 1) {
        const lesson = JSON.parse(mockStudyResponse(request, text));
        lesson.topics[0].sources = ["invented-block"];
        return JSON.stringify(lesson);
      }
      if (mode === "too-many-questions-once" && attempts === 1) {
        const lesson = JSON.parse(mockStudyResponse(request, text));
        lesson.questions.push(...structuredClone(lesson.questions));
        return JSON.stringify(lesson);
      }
    }
    if (prompt.task === "study_evaluation" && mode === "bad-evaluation") {
      return JSON.stringify({ evaluations: prompt.questions.map(q => ({ questionId: q.id, criteria: ["true", "true"], feedback: "通过" })) });
    }
    return mockStudyResponse(request, text);
  } });
  const state = {}, events = [];
  const channel = createSessionEventChannel({ state, fetch: (u, o) => fetch(f.url + u, o) });
  t.after(async () => { releaseRetry?.(); channel.closeSessionEvents(); await f.dispose(); });
  const api = async (route, body) => {
    const response = await fetch(f.url + "/api" + route, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", "X-Pi-Control": state.controlId || "" }, body: body ? JSON.stringify(body) : undefined });
    const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
  };
  let task;
  const refresh = async () => { task = (await api(`/studies/${task.id}`)).task; };
  const run = async (action, body = {}, error) => {
    const operation = await api(`/studies/${task.id}/${action}`, body);
    if (error) await assert.rejects(channel.waitOperation(operation.operationId), error);
    else await channel.waitOperation(operation.operationId);
    await refresh();
  };
  const create = async () => {
    channel.closeSessionEvents();
    const response = await fetch(f.url + "/api/studies/import", { method: "PUT", headers: { "Content-Type": "application/pdf", "X-Filename": "Routing.pdf" }, body: f.pdf });
    assert.equal(response.status, 201); task = await response.json();
    await channel.connectSessionEvents(task.guideSessionId, event => events.push(event));
    await run("prepare"); attempts = 0;
  };

  await create();
  await run("lesson", { checkpointId: "rough_0" });
  assert.equal(attempts, 2);
  assert.equal(task.checkpoints[0].status, "awaiting-answers");
  assert.equal(task.cursor, 0);
  assert.ok(events.some(event => event.t === "study_progress" && /重新校验/.test(event.text)));
  const lessonRequests = f.modelRequests.filter(request => request.messages.at(-1).content.includes('"study_lesson"'));
  assert.equal(lessonRequests.length, 2);
  assert.equal(lessonRequests[0].messages.at(-1).content, lessonRequests[1].messages.at(-1).content, "retry retains the original evidence and schema");
  assert.ok(lessonRequests.every(request => /只输出一个完整的 JSON 对象/.test(JSON.stringify(request.messages))));
  await run("messages", { checkpointId: "rough_0", text: "解释一下主线" });
  assert.equal(f.modelRequests.at(-1).response_format, undefined, "free guide discussion remains Markdown");
  assert.match(task.messages.at(-1).text, /普通引导回答/);
  mode = "bad-evaluation";
  const answers = Object.fromEntries(task.checkpoints[0].lesson.questions.map(q => [q.id, "我理解"]));
  const before = f.modelRequests.length;
  await run("answers", { checkpointId: "rough_0", answers }, /评估|评分/);
  assert.equal(f.modelRequests.length - before, 2);
  assert.equal(task.checkpoints[0].attempts.length, 0);
  await run("advance", { checkpointId: "rough_0" }, /考查/);

  mode = "markdown-always"; await create();
  await run("lesson", { checkpointId: "rough_0" }, /结构化/);
  assert.equal(attempts, 2, "invalid output cannot trigger an unbounded retry loop");
  assert.equal(task.checkpoints[0].lesson, undefined);
  const diagnostic = JSON.parse(fs.readFileSync(path.join(f.data, "studies", task.id, "model-failure.json"), "utf8"));
  assert.match(diagnostic.output, /^### 问题与动机/);
  assert.match(diagnostic.reason, /JSON|Unexpected/);
  assert.equal(diagnostic.attempt, 2);
  assert.equal(diagnostic.model.provider, "deepseek");
  assert.equal(task.modelDiagnostics, undefined, "raw output never appears in public task responses");

  for (const scenario of ["empty-once", "invalid-source-once", "too-many-questions-once"]) {
    mode = scenario; await create(); await run("lesson", { checkpointId: "rough_0" });
    assert.equal(attempts, 2); assert.equal(task.checkpoints[0].status, "awaiting-answers");
    assert.ok(task.checkpoints[0].lesson.topics.every(topic => !topic.sources.includes("invented-block")));
    if (scenario === "too-many-questions-once") {
      const retry = f.modelRequests.at(-1);
      assert.match(JSON.stringify(retry.messages), /实际返回 6 题/);
      const prompt = JSON.parse(retry.messages.at(-1).content);
      assert.equal(prompt.questionCount, 4); assert.equal(prompt.format.questions.length, 4);
    }
  }

  mode = "cancel-retry"; await create();
  const started = new Promise(resolve => { retryStarted = resolve; });
  const operation = await api(`/studies/${task.id}/lesson`, { checkpointId: "rough_0" });
  await started;
  await api(`/sessions/${task.guideSessionId}/abort`, {});
  await assert.rejects(channel.waitOperation(operation.operationId));
  releaseRetry(); await refresh();
  assert.equal(task.checkpoints[0].lesson, undefined);
  assert.equal(task.cursor, 0);
  assert.match(task.lastError, /暂停/);
});
