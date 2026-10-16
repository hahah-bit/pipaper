import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { EventEmitter } from "node:events";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipaper-academic-test-"));
process.env.PIPAPER_DATA_DIR = path.join(dir, "data");
process.env.PIPAPER_LIBRARY_DIR = path.join(dir, "library");
const { aggregateSearch, createSearchAdapters, dedupe, validatedJournalMetrics } = await import("../server/search/engines.js");
const { remote } = await import("../server/platform/academic/transport.js");
const { proxyDNSHosts } = await import("../server/platform/academic/network.js");
const { closeCatalog } = await import("../server/storage/catalog.js");
test.after(() => { closeCatalog(); fs.rmSync(dir, { recursive: true, force: true }); });

const response = value => ({ buffer: Buffer.from(JSON.stringify(value)) });
const paper = (extra = {}) => ({ id: "test:1", source: "good", title: "Industrial anomaly detection", authors: [], year: 2025,
  doi: "10.1234/paper", citations: 0, oa: true, abstract: "Industrial anomaly detection research", keywords: [], ...extra });

test("shifted journal catalog columns never create decimal partition badges or guessed SJR values", () => {
  assert.deepEqual(validatedJournalMetrics({ sjr: 0, q: "1.336", cat: "Materials Science (Q1)" }), { sjr: null, quartile: null });
  assert.deepEqual(validatedJournalMetrics({ sjr: 0, q: "1.889", cat: "Renewable Energy" }), { sjr: null, quartile: null });
  for (const q of ["SJR", " Monitoring", "1.0", "", "5", null]) assert.equal(validatedJournalMetrics({ sjr: 0, q }).quartile, null);
  assert.deepEqual(validatedJournalMetrics({ sjr: 1.514, q: "1" }), { sjr: 1.514, quartile: "Q1" });
  assert.deepEqual(validatedJournalMetrics({ sjr: 0.719, q: 2 }), { sjr: 0.719, quartile: "Q2" });
  assert.deepEqual(validatedJournalMetrics({ sjr: NaN, q: "3" }), { sjr: null, quartile: "Q3" });
});

function proxyEnvironment(t, value) {
  const before = { PIPAPER_HTTPS_PROXY: process.env.PIPAPER_HTTPS_PROXY, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
  process.env.PIPAPER_HTTPS_PROXY = value; process.env.NO_PROXY = ""; delete process.env.no_proxy;
  t.after(() => { for (const [key, val] of Object.entries(before)) if (val == null) delete process.env[key]; else process.env[key] = val; });
}

test("trusted academic APIs use proxy DNS despite local fake-IP answers, while custom documents remain protected", async t => {
  const sockets = new Set(), targets = [];
  const server = http.createServer();
  server.on("connect", (req, socket) => { targets.push(req.url); sockets.add(socket); socket.on("end", () => socket.destroy()); socket.on("close", () => sockets.delete(socket)); socket.resume(); });
  server.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  proxyEnvironment(t, `http://127.0.0.1:${server.address().port}`);
  let lookups = 0;
  t.mock.method(dns, "lookup", async () => { lookups++; return [{ address: "198.18.0.37", family: 4 }]; });
  for (const host of ["api.openalex.org", "api.semanticscholar.org", "eutils.ncbi.nlm.nih.gov", "api.crossref.org", "export.arxiv.org"]) {
    assert.ok(proxyDNSHosts.has(host));
    await assert.rejects(remote(`https://${host}/`, { timeoutMs: 60 }), { code: "ETIMEDOUT" });
  }
  assert.equal(lookups, 0);
  assert.deepEqual(targets, ["api.openalex.org:443", "api.semanticscholar.org:443", "eutils.ncbi.nlm.nih.gov:443", "api.crossref.org:443", "export.arxiv.org:443"]);
  t.mock.method(dns, "lookup", async () => { lookups++; return [{ address: "10.0.0.1", family: 4 }]; });
  await assert.rejects(remote("https://publisher.example/paper.pdf"), /内部网络/);
  await assert.rejects(remote("https://api.openalex.org.evil.example/works"), /内部网络/);
  assert.equal(lookups, 2);
  assert.equal(targets.length, 5);
});

function mockHttpsResponses(t, callback) {
  t.mock.method(https, "request", (url, options, respond) => {
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => {
      const value = callback(url, options);
      const res = new EventEmitter(); res.resume = () => {};
      res.statusCode = value.status || 200; res.headers = value.headers || {};
      respond(res);
      if (res.statusCode < 300 || res.statusCode >= 400) {
        res.emit("data", Buffer.from(typeof value.body === "string" ? value.body : JSON.stringify(value.body)));
        res.emit("end");
      }
    });
    return req;
  });
}

test("fake-IP publisher DNS is verified over fixed HTTPS resolvers before using the public address", async t => {
  proxyEnvironment(t, "http://127.0.0.1:10000");
  t.mock.method(dns, "lookup", async () => [{ address: "198.18.0.16", family: 4 }]);
  const urls = [];
  mockHttpsResponses(t, (url, options) => {
    urls.push(url);
    if (url.hostname === "1.1.1.1") {
      assert.equal(url.searchParams.get("name"), "publisher.example");
      assert.equal(options.headers.Accept, "application/dns-json");
      assert.equal(options.headers.Cookie, undefined, "publisher cookies must not be sent to DNS resolver");
      return { body: { Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }, { type: 1, data: "1.1.1.1" }] } };
    }
    let answers;
    options.lookup(url.hostname, { all: true }, (_error, records) => { answers = records; });
    assert.deepEqual(answers.map(record => record.address), ["93.184.216.34", "1.1.1.1"]);
    assert.equal(url.hostname, "publisher.example", "original hostname must remain the HTTPS Host/SNI identity");
    return { body: "verified content" };
  });
  assert.equal((await remote("https://publisher.example/paper.pdf", { headers: { Cookie: "publisher=session" } })).buffer.toString(), "verified content");
  assert.deepEqual(urls.map(url => url.hostname), ["1.1.1.1", "publisher.example"]);
});

test("fake-IP publisher CONNECT pins a verified public IP rather than trusting arbitrary proxy DNS", async t => {
  let target; const sockets = new Set();
  const server = http.createServer();
  server.on("connect", (req, socket) => { target = req.url; sockets.add(socket); socket.on("end", () => socket.destroy()); socket.on("close", () => sockets.delete(socket)); socket.resume(); });
  server.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  proxyEnvironment(t, `http://127.0.0.1:${server.address().port}`);
  t.mock.method(dns, "lookup", async () => [{ address: "198.19.0.16", family: 4 }]);
  const originalRequest = https.request;
  t.mock.method(https, "request", (url, options, respond) => {
    if (url.hostname !== "1.1.1.1") return originalRequest(url, options, respond);
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter(); res.statusCode = 200; res.headers = {};
      respond(res); res.emit("data", Buffer.from(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] }))); res.emit("end");
    });
    return req;
  });
  await assert.rejects(remote("https://publisher.example/paper.pdf", { timeoutMs: 70 }), { code: "ETIMEDOUT" });
  assert.equal(target, "93.184.216.34:443");
});

test("fake-IP publisher with missing records, mixed private answers or invalid A records is never connected", async t => {
  proxyEnvironment(t, "http://127.0.0.1:10000");
  t.mock.method(dns, "lookup", async () => [{ address: "198.18.0.16", family: 4 }]);
  let payload, calls;
  mockHttpsResponses(t, url => { calls++; assert.ok(["1.1.1.1", "1.0.0.1"].includes(url.hostname)); return { body: payload }; });
  for (const answer of [{ Status: 3 }, { Status: 0, Answer: [] }, { Status: 0, Answer: [{ type: 5, data: "other.example" }] }]) {
    payload = answer; calls = 0;
    await assert.rejects(remote("https://publisher.example/paper.pdf"), /没有可验证的公开 IPv4/);
    assert.equal(calls, 2);
  }
  for (const address of ["127.0.0.1", "10.0.0.1", "192.168.0.1", "172.16.0.1", "169.254.169.254", "100.64.0.1", "198.18.0.1", "not-an-ip"]) {
    payload = { Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }, { type: 1, data: address }] }; calls = 0;
    await assert.rejects(remote("https://publisher.example/paper.pdf"), /公开 DNS 核验未通过/);
    assert.equal(calls, 1, "private records must not be bypassed by trying a different resolver");
  }
});

test("resolver redirects cannot recurse into fake-IP DNS and resolution shares the original deadline", async t => {
  proxyEnvironment(t, "http://127.0.0.1:10000");
  t.mock.method(dns, "lookup", async () => [{ address: "198.18.0.16", family: 4 }]);
  let calls = 0;
  mockHttpsResponses(t, url => { calls++; assert.ok(["1.1.1.1", "1.0.0.1"].includes(url.hostname)); return { status: 302, headers: { location: "https://fake-resolver.example/dns-query" } }; });
  await assert.rejects(remote("https://publisher.example/paper.pdf"), /不允许重定向/); assert.equal(calls, 2);
  t.mock.method(https, "request", (_url, options) => {
    const req = new EventEmitter(); req.end = () => {};
    options.signal.addEventListener("abort", () => req.emit("error", options.signal.reason), { once: true });
    return req;
  });
  const start = Date.now();
  await assert.rejects(remote("https://publisher.example/paper.pdf", { timeoutMs: 25 }), { code: "ETIMEDOUT" });
  assert.ok(Date.now() - start < 500, "DoH must not create a fresh independent timeout");
});

test("only fake-IP DNS with a configured proxy may use DoH; literal private and mixed local answers stay blocked", async t => {
  proxyEnvironment(t, "http://127.0.0.1:10000");
  t.mock.method(https, "request", () => { throw new Error("no outbound request expected"); });
  t.mock.method(dns, "lookup", async () => [{ address: "198.18.0.16", family: 4 }, { address: "10.0.0.1", family: 4 }]);
  await assert.rejects(remote("https://publisher.example/"), /内部网络/);
  await assert.rejects(remote("https://198.18.0.16/"), /内部网络/);
  process.env.PIPAPER_HTTPS_PROXY = "direct";
  t.mock.method(dns, "lookup", async () => [{ address: "198.18.0.16", family: 4 }]);
  await assert.rejects(remote("https://publisher.example/"), /内部网络/);
});

test("explicit local HTTP Scholar mirrors still work and cannot forward cookies across a redirect origin", async t => {
  let redirect = false;
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.cookie, "session=local");
    if (redirect) { res.writeHead(302, { Location: "http://127.0.0.1:1/steal-cookie" }); res.end(); return; }
    res.end('<div class="gs_r gs_or gs_scl"><h3 class="gs_rt"><a href="https://example.org/paper">Local paper</a></h3></div>');
  });
  server.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const adapters = createSearchAdapters();
  const definition = { id: "local-scholar", url: `http://127.0.0.1:${server.address().port}`, cookie: "session=local" };
  assert.equal((await adapters["scholar-mirror"]("local", {}, definition))[0].title, "Local paper");
  redirect = true;
  await assert.rejects(adapters["scholar-mirror"]("local", {}, definition), /不能重定向到其他来源/);
});

test("trusted source direct mode still validates DNS and blocks private addresses", async t => {
  proxyEnvironment(t, "direct");
  t.mock.method(dns, "lookup", async () => [{ address: "127.0.0.1", family: 4 }]);
  await assert.rejects(remote("https://api.openalex.org/works"), /内部网络/);
});

test("cross-origin redirects never forward academic API authorization or mirror cookies", async t => {
  proxyEnvironment(t, "direct");
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  const requests = [];
  t.mock.method(https, "request", (url, options, respond) => {
    requests.push({ url: url.href, headers: options.headers });
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter(); res.resume = () => {};
      res.statusCode = requests.length === 1 ? 302 : 200;
      res.headers = requests.length === 1 ? { location: "https://other-publisher.example/paper" } : {};
      respond(res);
      if (res.statusCode === 200) { res.emit("data", Buffer.from("{}")); res.emit("end"); }
    });
    return req;
  });
  await remote("https://api.openalex.org/works", { headers: { Authorization: "Bearer secret", cookie: "session=secret", "X-Client": "PiPaper" } });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].headers.Authorization, "Bearer secret");
  assert.equal(requests[1].headers.Authorization, undefined); assert.equal(requests[1].headers.cookie, undefined);
  assert.equal(requests[1].headers["X-Client"], "PiPaper");
});

test("aggregation distinguishes partial source failures, total failures, legitimate empty results and no selected source", async () => {
  const sourceDefs = [{ id: "good", type: "good", enabled: true }, { id: "limited", name: "Limited", type: "limited", enabled: true, apiKey: "hidden-secret" }];
  const deps = { sourceDefs, adapters: { good: async () => [paper()], limited: async () => { throw Object.assign(new Error("HTTP 429"), { remoteStatus: 429 }); } } };
  const partial = await aggregateSearch("anomaly", {}, deps);
  assert.equal(partial.status, "partial"); assert.equal(partial.results.length, 1);
  assert.deepEqual(partial.sourceStatus.map(s => [s.id, s.status, s.count]), [["good", "ok", 1], ["limited", "error", 0]]);
  assert.equal(partial.sourceStatus[1].code, "rate_limited"); assert.match(partial.sourceStatus[1].action, /密钥/);
  assert.ok(partial.sourceStatus.every(s => Number.isFinite(s.elapsedMs)));
  assert.ok(!JSON.stringify(partial).includes("hidden-secret"));
  const failed = await aggregateSearch("anomaly", { sources: ["limited"] }, deps);
  assert.equal(failed.status, "error"); assert.equal(failed.total, 0); assert.equal(failed.errors.length, 1);
  const empty = await aggregateSearch("anomaly", { sources: ["good"] }, { ...deps, adapters: { good: async () => [] } });
  assert.equal(empty.status, "ok"); assert.equal(empty.total, 0); assert.deepEqual(empty.errors, []);
  const none = await aggregateSearch("anomaly", { sources: [] }, deps);
  assert.equal(none.status, "no_sources"); assert.deepEqual(none.sourcesUsed, []); assert.deepEqual(none.sourceStatus, []);
  assert.equal((await aggregateSearch("anomaly", {}, { ...deps, sourceDefs: sourceDefs.map(s => ({ ...s, enabled: false })) })).status, "no_sources");
});

test("unsupported sources and malformed successful payloads are reported as errors rather than zero results", async () => {
  const unknown = await aggregateSearch("anomaly", { sources: ["unknown"] }, { sourceDefs: [], adapters: {} });
  assert.equal(unknown.status, "error"); assert.equal(unknown.sourceStatus[0].code, "unsupported");
  const malformed = await aggregateSearch("anomaly", { sources: ["bad"] }, { sourceDefs: [{ id: "bad", type: "bad" }], adapters: { bad: async () => ({ error: "failure" }) } });
  assert.equal(malformed.sourceStatus[0].code, "invalid_response");
  for (const payload of [{ error: "quota exceeded" }, null, [], { results: null }]) {
    const adapters = createSearchAdapters({ request: async () => response(payload), env: {}, config: () => ({}) });
    await assert.rejects(adapters.openalex("anomaly"), { code: "EINVALIDRESPONSE" });
  }
  const adapters = createSearchAdapters({ request: async () => ({ buffer: Buffer.from("<html>verification required</html>") }), env: {}, config: () => ({}) });
  await assert.rejects(adapters.crossref("anomaly"), { code: "EINVALIDRESPONSE" });
});

test("OpenAlex reuses environment, research configuration and per-source keys as secret headers", async () => {
  const seen = [], request = async (url, options) => { seen.push({ url, options }); return response({ results: [{ id: "https://openalex.org/W1", title: "Anomaly detection", open_access: { is_oa: true }, best_oa_location: { landing_page_url: "https://example.org/landing" } }] }); };
  const adapters = createSearchAdapters({ request, env: { OPENALEX_API_KEY: "env-secret" }, config: () => ({ topicAnalysis: { openalexApiKey: "config-secret" } }) });
  const papers = await adapters.openalex("anomaly");
  await adapters.openalex("anomaly", {}, { apiKey: "source-secret" });
  await createSearchAdapters({ request, env: {}, config: () => ({ topicAnalysis: { openalexApiKey: "config-secret" } }) }).openalex("anomaly");
  assert.deepEqual(seen.map(s => s.options.headers.Authorization), ["Bearer env-secret", "Bearer source-secret", "Bearer config-secret"]);
  assert.ok(seen.every(s => !s.url.includes("secret")));
  assert.equal(papers[0].pdfUrl, ""); // A landing page is not a downloadable PDF.
});

test("Semantic Scholar uses the selected source key and does not retry a quota or long rate limit", async () => {
  let calls = 0, captured;
  const adapters = createSearchAdapters({ request: async (_url, options) => { calls++; captured = options; throw Object.assign(new Error("HTTP 429"), { remoteStatus: 429, retryAfter: 60 }); }, env: {} });
  await assert.rejects(adapters.semanticscholar("anomaly", {}, { id: "custom-s2", apiKey: "source-secret" }), /429/);
  assert.equal(calls, 1); assert.equal(captured.headers["x-api-key"], "source-secret");
  const quota = createSearchAdapters({ request: async () => { calls++; throw Object.assign(new Error("quota"), { remoteStatus: 429, quota: true }); }, env: {} });
  await assert.rejects(quota.openalex("anomaly"), /quota/); assert.equal(calls, 2);
});

test("arXiv encodes phrase spaces safely and applies year bounds before retrieving the limited page", async () => {
  let captured;
  const adapters = createSearchAdapters({ schedule: work => work(), request: async url => { captured = url; return { buffer: Buffer.from('<feed xmlns="http://www.w3.org/2005/Atom"><totalResults>0</totalResults></feed>') }; } });
  assert.deepEqual(await adapters.arxiv("industrial anomaly detection", { yearFrom: 2024, yearTo: 2025, limit: 7 }), []);
  assert.ok(captured.includes("%20")); assert.ok(!captured.includes("+"));
  const url = new URL(captured); assert.match(url.searchParams.get("search_query"), /submittedDate:\[202401010000 TO 202512312359\]/);
  assert.equal(url.searchParams.get("max_results"), "7");
});

test("Crossref and PubMed apply upper date bounds even without a start year", async () => {
  const seen = [], request = async url => { seen.push(new URL(url)); return response(url.includes("crossref") ? { message: { items: [] } } : { esearchresult: { idlist: [] } }); };
  const adapters = createSearchAdapters({ request });
  await adapters.crossref("anomaly", { yearTo: 2024 }); await adapters.pubmed("anomaly", { yearTo: 2024 });
  assert.equal(seen[0].searchParams.get("filter"), "until-pub-date:2024-12-31");
  assert.equal(seen[1].searchParams.get("datetype"), "pdat"); assert.equal(seen[1].searchParams.get("maxdate"), "2024");
});

test("aggregation respects shared date and OA filters, clamps limits, deduplicates source selection and preserves long distinct titles", async () => {
  let captured;
  const result = await aggregateSearch("anomaly", { sources: ["good", "good"], yearFrom: 2024, yearTo: 2025, oa: true, limit: 10000 }, {
    sourceDefs: [{ id: "good", type: "good" }], adapters: { good: async (_q, options) => { captured = options; return [paper(), paper({ id: "test:2", doi: "10.1234/old", year: 2020 }), paper({ id: "test:3", doi: "10.1234/closed", oa: false })]; } },
  });
  assert.equal(captured.limit, 50); assert.deepEqual(result.sourcesUsed, ["good"]); assert.equal(result.results.length, 1);
  const shared = "A very long scientific title that shares more than sixty characters with another paper ";
  assert.equal(dedupe([paper({ doi: "", title: shared + "first" }), paper({ doi: "", title: shared + "second" })]).length, 2);
  assert.equal(dedupe([paper({ oa: false }), paper({ oa: true, source: "other" })])[0].oa, true);
});

test("cancellation propagates to academic adapters and cannot return stale search results", async () => {
  const controller = new AbortController(); let received;
  await assert.rejects(aggregateSearch("anomaly", { sources: ["good"], signal: controller.signal }, {
    sourceDefs: [{ id: "good", type: "good" }], adapters: { good: async (_q, options) => { received = options.signal; controller.abort(); return [paper()]; } },
  }), { name: "AbortError" });
  assert.equal(received, controller.signal);
});
