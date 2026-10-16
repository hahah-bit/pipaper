import test from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { EventEmitter } from "node:events";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { proxyFor, createResilientRequest, decodeResponse, readableCachedText } from "../server/topics/network.js";
import { remote, createSources } from "../server/topics/sources.js";
import { withDeadline } from "../server/topics/deadline.js";

test("HTTPS proxy selection respects explicit direct mode, environment, Windows protocol mapping and exclusions", () => {
  const url = "https://export.arxiv.org/api/query";
  assert.equal(proxyFor(url, { env: {}, system: () => "127.0.0.1:7897" }).href, "http://127.0.0.1:7897/");
  assert.equal(proxyFor(url, { env: {}, system: () => "http=localhost:80;https=localhost:90" }).port, "90");
  assert.equal(proxyFor(url, { env: { HTTPS_PROXY: "http://localhost:100" }, system: () => "localhost:90" }).port, "100");
  assert.equal(proxyFor(url, { env: { PIPAPER_HTTPS_PROXY: "direct" }, system: () => "localhost:90" }), null);
  assert.equal(proxyFor(url, { env: { NO_PROXY: ".arxiv.org" }, system: () => "localhost:90" }), null);
  assert.notEqual(proxyFor("https://notarxiv.org/", { env: { NO_PROXY: ".arxiv.org" }, system: () => "localhost:90" }), null);
});

test("compressed publisher content is decoded within size limits and old binary caches are rejected", async () => {
  const body = Buffer.from('<meta name="citation_title" content="真实论文标题">正文与发表证据');
  for (const [encoding, compress] of [["gzip", gzipSync], ["deflate", deflateSync], ["br", brotliCompressSync]]) {
    assert.deepEqual(await decodeResponse(compress(body), encoding, 10000), body);
    await assert.rejects(decodeResponse(compress(Buffer.alloc(20000, 65)), encoding, 100));
  }
  assert.deepEqual(await decodeResponse(brotliCompressSync(gzipSync(body)), "gzip, br", 10000), body);
  assert.deepEqual(await decodeResponse(gzipSync(body), undefined, 10000), body);
  await assert.rejects(decodeResponse(body, "unknown", 10000), /压缩格式/);
  assert.equal(readableCachedText(gzipSync(body).toString("utf8")), false);
  assert.equal(readableCachedText(body.toString("utf8")), true);
});

test("consecutive transport failures pause a host, successful responses reset it, and another source still works", async () => {
  let calls = 0, fail = true;
  const request = createResilientRequest(async () => { calls++; if (fail) throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }); return "ok"; });
  for (let i = 0; i < 2; i++) await assert.rejects(request("https://api.openalex.org/works"));
  fail = false; assert.equal(await request("https://api.openalex.org/works"), "ok");
  fail = true;
  for (let i = 0; i < 3; i++) await assert.rejects(request("https://api.openalex.org/works"));
  await assert.rejects(request("https://api.openalex.org/sources"), { code: "ESOURCEPAUSED" });
  assert.equal(calls, 6);
  fail = false; assert.equal(await request("https://api.crossref.org/works"), "ok");
});

test("source circuits are fresh on retry and cancellation is not counted as a source outage", async () => {
  let calls = 0;
  const request = async () => { calls++; throw Object.assign(new Error("socket failure"), { code: "ECONNRESET" }); };
  const sources = createSources({ request });
  for (let i = 0; i < 5; i++) await assert.rejects(sources.works("test"));
  assert.equal(calls, 3);
  await assert.rejects(createSources({ request }).works("test")); assert.equal(calls, 4);
  const c = new AbortController(); c.abort();
  await assert.rejects(sources.works("test", { signal: c.signal }), { name: "AbortError" });
  assert.equal(calls, 4);
});

test("parallel requests contribute to the same host failure count", async () => {
  let calls = 0;
  const request = createResilientRequest(async () => { calls++; await delay(5); throw Object.assign(new Error("unreachable"), { code: "ECONNREFUSED" }); });
  await Promise.allSettled(Array.from({ length: 3 }, () => request("https://api.openalex.org/works")));
  await assert.rejects(request("https://api.openalex.org/sources"), { code: "ESOURCEPAUSED" });
  assert.equal(calls, 3);
});

test("repeated gateway refusals pause a source without turning the errors into zero results", async () => {
  let calls = 0;
  const request = createResilientRequest(async () => { calls++; throw Object.assign(new Error("HTTP 406"), { remoteStatus: 406 }); });
  for (let i = 0; i < 3; i++) await assert.rejects(request("https://export.arxiv.org/api/query"), /406/);
  await assert.rejects(request("https://export.arxiv.org/api/query"), { sourcePaused: true });
  assert.equal(calls, 3);
});

test("DNS is covered by the deadline and a late lookup cannot start a request", async t => {
  let resolve;
  t.mock.method(dns, "lookup", () => new Promise(r => { resolve = r; }));
  await assert.rejects(remote("https://example.org/", { timeoutMs: 25 }), { code: "ETIMEDOUT" });
  resolve([{ address: "127.0.0.1", family: 4 }]); await delay(10);
});

test("private document addresses are rejected even when a local proxy is configured", async t => {
  t.mock.method(dns, "lookup", async () => [{ address: "127.0.0.1", family: 4 }]);
  await assert.rejects(remote("https://example.org/"), /内部网络/);
});

test("HTTP response handling decodes unlabelled gzip but never decompresses a HEAD body", async t => {
  const oldProxy = process.env.PIPAPER_HTTPS_PROXY; process.env.PIPAPER_HTTPS_PROXY = "direct";
  t.after(() => { if (oldProxy == null) delete process.env.PIPAPER_HTTPS_PROXY; else process.env.PIPAPER_HTTPS_PROXY = oldProxy; });
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  const body = Buffer.from("<html>Publication title and evidence</html>");
  t.mock.method(https, "request", (_url, options, respond) => {
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter(); res.statusCode = 200;
      res.headers = { "content-type": "text/html", ...(options.method === "HEAD" ? { "content-encoding": "gzip" } : {}) };
      respond(res);
      if (options.method !== "HEAD") res.emit("data", gzipSync(body));
      res.emit("end");
    });
    return req;
  });
  assert.deepEqual((await remote("https://example.org/")).buffer, body);
  assert.equal((await remote("https://example.org/", { method: "HEAD" })).buffer.length, 0);
});

test("proxy tunnel timeouts close the socket without leaving a hanging request", async t => {
  const sockets = new Set(); let target;
  const server = http.createServer();
  server.on("connect", (req, socket) => { target = req.url; sockets.add(socket); socket.on("end", () => socket.destroy()); socket.on("close", () => sockets.delete(socket)); socket.resume(); });
  server.listen(0, "127.0.0.1"); await new Promise(r => server.once("listening", r));
  const prior = process.env.PIPAPER_HTTPS_PROXY, priorBypass = process.env.NO_PROXY;
  process.env.PIPAPER_HTTPS_PROXY = `http://127.0.0.1:${server.address().port}`; process.env.NO_PROXY = "";
  t.after(async () => { if (prior == null) delete process.env.PIPAPER_HTTPS_PROXY; else process.env.PIPAPER_HTTPS_PROXY = prior; if (priorBypass == null) delete process.env.NO_PROXY; else process.env.NO_PROXY = priorBypass; for (const s of sockets) s.destroy(); await new Promise(r => server.close(r)); });
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  await assert.rejects(remote("https://example.org/", { timeoutMs: 80 }), { code: "ETIMEDOUT" });
  assert.equal(target, "93.184.216.34:443");
  await delay(20); assert.equal(sockets.size, 0);
});

test("deadline rejects providers that ignore abort and marks their child signal aborted", async () => {
  let child;
  await assert.rejects(withDeadline(s => { child = s; return new Promise(() => {}); }, { ms: 20 }), { code: "ETIMEDOUT" });
  assert.equal(child.aborted, true);
});

test("arXiv phrase/date queries encode spaces as percent escapes and reject non-feed responses", async () => {
  let url;
  const sources = createSources({ request: async value => { url = value; return { buffer: Buffer.from('<feed xmlns="http://www.w3.org/2005/Atom"><totalResults>0</totalResults></feed>') }; } });
  const result = await sources.arxiv('"cross-modal alignment" AND "RGB-infrared fusion"');
  assert.ok(url.includes("%20")); assert.ok(!url.includes("+")); assert.ok(new URL(url).searchParams.get("search_query").includes("submittedDate:["));
  assert.equal(result.sourceUrl, url); assert.equal(result.papers.length, 0);
  await assert.rejects(createSources({ request: async () => ({ buffer: Buffer.from("<html>Access denied</html>") }) }).arxiv("test"), /Atom/);
});
