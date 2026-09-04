import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay, setImmediate as tick } from "node:timers/promises";
import { createSessionEventChannel } from "../src/sessionEventChannel.js";

function fixture(t, options = {}) {
  const state = { controlId: null }, events = [], requests = [];
  const transport = createSessionEventChannel({ state, ...options, fetch: async (url, { signal }) => {
    const request = { url, signal, sequence: 0 };
    const stream = new ReadableStream({ start(controller) {
      request.send = (event, sessionId = "a") => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ sessionId, seq: ++request.sequence, ...event })}\n\n`));
      request.end = () => controller.close();
      signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    } });
    requests.push(request);
    return new Response(stream);
  } });
  const handler = event => events.push(event);
  const startup = (r, sessionId = "a") => {
    r.send({ t: "connected", controlId: "owner-" + sessionId }, sessionId);
    r.send({ t: "snapshot", history: { messages: [] } }, sessionId);
    r.send({ t: "operation_end", kind: "startup", id: "startup-" + sessionId }, sessionId);
  };
  t.after(() => transport.closeSessionEvents());
  return { ...transport, state, events, requests, handler, startup };
}

test("reports connecting immediately, restores history, then waits for startup before ready", async t => {
  const f = fixture(t);
  const ready = f.connectSessionEvents("a", f.handler);
  assert.equal(f.events[0].phase, "connecting");
  assert.equal(f.state.controlId, null);
  f.startup(f.requests[0]); await ready;
  assert.deepEqual(f.events.filter(e => e.t === "connection_status").map(e => e.phase), ["connecting", "restoring", "starting", "ready"]);
  await f.connectSessionEvents("a", f.handler);
  assert.equal(f.requests.length, 1);
  const done = f.waitOperation("prompt-1");
  f.requests[0].send({ t: "operation_end", kind: "prompt", id: "prompt-1", result: "saved" });
  assert.equal(await done, "saved");
});

test("initial connection timeout closes the request and exposes a retryable error", async t => {
  const f = fixture(t, { connectTimeoutMs: 15 });
  await assert.rejects(f.connectSessionEvents("a", f.handler), /连接超时/);
  assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(f.state.controlId, null);
  assert.match(f.events.at(-1).message, /连接超时/);
  const ready = f.connectSessionEvents("a", f.handler);
  f.startup(f.requests[1]); await ready;
  assert.equal(f.state.controlId, "owner-a");
});

test("connected startup dialogs are not subject to the connection timeout", async t => {
  const f = fixture(t, { connectTimeoutMs: 15 });
  let ready = false;
  const pending = f.connectSessionEvents("a", f.handler).then(() => { ready = true; });
  f.requests[0].send({ t: "connected", controlId: "owner-a" });
  f.requests[0].send({ t: "snapshot", history: { messages: [] } });
  f.requests[0].send({ t: "ui_request", request: { title: "Startup choice" } });
  await delay(40);
  assert.equal(ready, false); assert.equal(f.requests[0].signal.aborted, false);
  f.requests[0].send({ t: "operation_end", kind: "startup", id: "startup-a" });
  await pending;
});

test("history renderer failure closes the physical stream and releases the owner for retry", async t => {
  const f = fixture(t);
  const ready = f.connectSessionEvents("a", event => {
    f.handler(event);
    if (event.t === "snapshot") throw new Error("history render failed");
  });
  f.startup(f.requests[0]);
  await assert.rejects(ready, /history render failed/);
  assert.equal(f.requests[0].signal.aborted, true); assert.equal(f.state.controlId, null);
  const retried = f.connectSessionEvents("a", f.handler);
  f.startup(f.requests[1]); await retried;
  assert.equal(f.state.controlId, "owner-a");
});

test("closing an old connection cannot clear the next session's owner or report stale errors", async t => {
  const f = fixture(t);
  const old = assert.rejects(f.connectSessionEvents("a", f.handler), /连接已关闭/);
  const next = f.connectSessionEvents("b", f.handler);
  f.startup(f.requests[1], "b"); await Promise.all([old, next]);
  assert.equal(f.state.controlId, "owner-b");
  assert.equal(f.events.some(e => e.t === "disconnected"), false);
});

test("startup errors and later stream loss reject waiters and expose the real error", async t => {
  const f = fixture(t);
  const ready = f.connectSessionEvents("a", f.handler);
  f.requests[0].send({ t: "connected", controlId: "owner-a" });
  f.requests[0].send({ t: "operation_end", kind: "startup", id: "startup-a", error: "extension failed" });
  await assert.rejects(ready, /extension failed/);
  assert.equal(f.requests[0].signal.aborted, true);
  const retried = f.connectSessionEvents("a", f.handler);
  f.startup(f.requests[1]); await retried;
  const pending = assert.rejects(f.waitOperation("pending"), /连接已断开/);
  f.requests[1].end(); await pending;
  assert.equal(f.state.controlId, null);
  assert.equal(f.events.at(-1).t, "disconnected");
});

test("an occupied page surfaces the server's 409 explanation", async () => {
  let signal;
  const state = {};
  const transport = createSessionEventChannel({ state, fetch: async (_url, options) => {
    signal = options.signal;
    return Response.json({ error: "此会话已在另一个页面中打开" }, { status: 409 });
  } });
  const events = [];
  await assert.rejects(transport.connectSessionEvents("a", e => events.push(e)), /另一个页面/);
  assert.match(events.at(-1).message, /另一个页面/);
  assert.equal(signal.aborted, true); assert.equal(state.controlId, null);
});

test("only an explicit replacement transfers the stream and unrelated events cannot advance its sequence", async t => {
  const f = fixture(t);
  const ready = f.connectSessionEvents("a", f.handler);
  f.startup(f.requests[0]); await ready;
  f.requests[0].send({ t: "connected", controlId: "wrong", seq: 1000 }, "b");
  f.requests[0].send({ t: "session_replaced", oldSessionId: "a", newSessionId: "b" }, "b");
  f.requests[0].send({ t: "state", state: { id: "b" } }, "b");
  await tick();
  assert.equal(f.state.controlId, "owner-a");
  assert.equal(f.events.at(-1).state.id, "b");
  await f.connectSessionEvents("b", f.handler);
  assert.equal(f.requests.length, 1);
});
