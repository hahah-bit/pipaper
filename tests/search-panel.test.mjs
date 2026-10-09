import test from "node:test";
import assert from "node:assert/strict";

// 只实现面板使用的 DOM 接口，让真实事件处理器与 fetch 生命周期参与回归。
class Node {
  constructor(tag = "div", text = "") { this.tagName = tag; this.nodeType = 1; this.children = []; this.attrs = {}; this.style = {}; this.dataset = {}; this.listeners = {}; this.value = ""; this.checked = false; this._text = text; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this._text = ""; this.append(...children); }
  setAttribute(key, value) { this.attrs[key] = value; if (["id", "value"].includes(key)) this[key] = value; if (["checked", "hidden", "disabled"].includes(key)) this[key] = true; }
  getAttribute(key) { return this.attrs[key]; }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  async fire(type, extra = {}) { for (const handler of this.listeners[type] || []) await handler({ currentTarget: this, target: this, preventDefault() {}, ...extra }); }
  click() { return this.fire("click"); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const [head, ...tail] = selector.split(/\s+/);
    const all = [];
    const visit = node => { for (const child of node.children) { all.push(child); visit(child); } };
    visit(this);
    const match = node => head.startsWith("#") ? node.id === head.slice(1)
      : head.startsWith(".") ? (node.className || "").split(" ").includes(head.slice(1))
      : /^option\[value=/.test(head) ? node.tagName === "option" && node.value === head.match(/value=['"]([^'"]+)/)[1]
      : node.tagName === head.replace(":checked", "") && (!head.includes(":checked") || node.checked);
    return all.filter(match).flatMap(node => tail.length ? node.querySelectorAll(tail.join(" ")) : [node]);
  }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const response = data => ({ ok: true, json: async () => data });

test("真实搜索面板保留异步手选源、拒绝迟到结果并展示分类证据与来源错误", async t => {
  const original = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  const values = new Map(), body = new Node("body"), events = new Node("window");
  const localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  globalThis.window = { localStorage, addEventListener: (...args) => events.addEventListener(...args), dispatchEvent: event => events.fire(event.type) };
  globalThis.document = { body, createElement: tag => new Node(tag), createTextNode: text => new Node("#text", text), querySelector: selector => body.querySelector(selector), querySelectorAll: selector => body.querySelectorAll(selector), getElementById: id => body.querySelector("#" + id) };
  const nodes = {};
  for (const id of ["sch-q", "sch-sort", "sch-purpose", "sch-quartile", "sch-year-from", "sch-year-to", "sch-oa", "sch-research", "sch-research-context", "sch-sources", "sch-toread", "sch-status", "sch-results", "sch-result-count", "btn-search", "btn-sch-cancel", "btn-sch-sources"]) {
    nodes[id] = new Node(); nodes[id].id = id; body.append(nodes[id]);
  }
  nodes["sch-sort"].value = "recommended";
  const researchOption = new Node("option"); researchOption.value = "research"; nodes["sch-sort"].append(researchOption);
  let sourceDeferred, entries = [], patchBody, patchDeferred;
  const importBodies = [];
  const searches = [];
  const sources = [{ id: "openalex", name: "OpenAlex", enabled: true }, { id: "arxiv", name: "arXiv", enabled: true }];
  globalThis.fetch = async (url, options = {}) => {
    if (url === "/api/search/sources") return sourceDeferred ? sourceDeferred.promise : response({ sources });
    if (url === "/api/search/toread") return response({ entries });
    if (url.startsWith("/api/search/toread/") && options.method === "PATCH") { patchBody = JSON.parse(options.body); return patchDeferred ? patchDeferred.promise : response({ entry: entries[0] }); }
    if (url === "/api/search/import") { importBodies.push(JSON.parse(options.body)); return new Promise(() => {}); }
    if (url.startsWith("/api/search?")) { const pending = deferred(); searches.push({ ...pending, url, options }); return pending.promise; }
    throw new Error("Unexpected fetch " + url);
  };
  const { state } = await import("../src/shell/state.js");
  state.projectId = "project-1";
  state.projects = [{ id: "project-1", paperIds: [] }];
  state.currentPaper = { id: "foreign-paper" };
  const panel = await import("../src/searchPanel.js");
  t.after(async () => { await nodes["btn-sch-cancel"].click(); Object.assign(globalThis, original); });
  panel.initSearchPanel();
  await tick();
  assert.equal(nodes["sch-research"].checked, true);
  assert.equal(nodes["sch-sources"].querySelectorAll("input").length, 2);

  sourceDeferred = deferred();
  panel.onShow();
  const selected = nodes["sch-sources"].querySelectorAll("input")[1];
  selected.checked = false;
  await selected.fire("change");
  sourceDeferred.resolve(response({ sources }));
  await tick();
  sourceDeferred = null;
  assert.equal(nodes["sch-sources"].querySelectorAll("input")[1].checked, false, "刷新响应不能覆盖刚手选的源");

  nodes["sch-q"].value = "old query";
  const oldSearch = nodes["btn-search"].click();
  nodes["sch-q"].value = "photovoltaic forecasting multimodal";
  const newSearch = nodes["btn-search"].click();
  assert.equal(searches.length, 2);
  assert.equal(searches[0].options.signal.aborted, true);
  const params = new URL(searches[1].url, "http://fixture.test").searchParams;
  assert.equal(params.get("sources"), "openalex");
  assert.equal(params.get("research"), "1");
  assert.equal(params.get("projectId"), "project-1");
  assert.equal(params.has("anchor"), false, "空项目检索不能借用其他项目的当前论文");
  const match = { score: 76, level: "moderate", confidence: "low", basis: "研究档案与项目全文", reasons: ["待改融合模块相近"], categories: [{ id: "module", label: "改模块", reason: "核对融合接口" }], evidence: [{ resourceId: "paper:p1", generationId: "g1", title: "基线论文", pages: [3, 5], sectionPath: ["Method"], text: "Observed fusion baseline" }] };
  searches[1].resolve(response({ status: "ok", total: 1, results: [{ title: "New photovoltaic paper", researchMatch: match }], researchContext: { enabled: true, projectId: "project-1", question: "多模态时序光伏预测", questionSource: "profile", profileAvailable: true, indexReady: false } }));
  await newSearch;
  searches[0].resolve(response({ status: "ok", total: 1, results: [{ title: "Old irrelevant paper" }] }));
  await oldSearch;
  assert.match(nodes["sch-results"].textContent, /New photovoltaic paper/);
  assert.doesNotMatch(nodes["sch-results"].textContent, /Old irrelevant paper/);
  assert.match(nodes["sch-results"].textContent, /改模块/);
  assert.match(nodes["sch-results"].textContent, /第 3、5 页/);
  assert.match(nodes["sch-results"].textContent, /证据有限/);
  assert.match(nodes["sch-research-context"].textContent, /多模态时序光伏预测/);
  assert.match(nodes["sch-research-context"].textContent, /元数据匹配/);
  assert.equal(nodes["sch-results"].getAttribute("aria-busy"), "false");
  assert.equal(nodes["btn-sch-cancel"].hidden, true);

  nodes["sch-purpose"].value = "topic";
  await nodes["sch-purpose"].fire("change");
  assert.match(nodes["sch-results"].textContent, /暂无该用途建议/);
  assert.equal(searches.length, 2, "用途切换应直接筛当前结果，无需再次请求");
  nodes["sch-purpose"].value = "";
  await nodes["sch-purpose"].fire("change");

  const failedSearch = nodes["btn-search"].click();
  searches[2].resolve(response({ status: "error", total: 0, results: [], errors: ["source failed"], sourceStatus: [{ id: "openalex", name: "OpenAlex", status: "error", message: "quota exceeded", action: "在设置中配置 API 密钥" }] }));
  await failedSearch;
  assert.match(nodes["sch-status"].textContent, /检索源失败/);
  assert.match(nodes["sch-results"].textContent, /quota exceeded/);
  assert.match(nodes["sch-results"].textContent, /配置 API 密钥/);
  assert.doesNotMatch(nodes["sch-results"].textContent, /换英文关键词/);

  entries = [{ id: "saved-1", title: "Saved paper", researchMatch: match }];
  values.set("pipaper.sch.toreadOpen", "1");
  await panel.renderToRead();
  const purposeSelect = nodes["sch-toread"].querySelector(".tr-purpose-select");
  purposeSelect.value = "innovation";
  await purposeSelect.fire("change");
  assert.deepEqual(patchBody, { purposeCategories: ["innovation"] });
  await tick();
  assert.match(nodes["sch-toread"].textContent, /收录时匹配/);

  entries = [{ id: "automatic", title: "Automatic suggestion", pdfUrl: "https://fixture.test/paper.pdf", researchMatch: match }];
  await panel.renderToRead();
  void nodes["sch-toread"].querySelectorAll("button").find(button => button.textContent === "＋项目").click();
  await tick();
  assert.equal(Object.hasOwn(importBodies[0], "purposeCategories"), false, "自动建议不能在导入时被改为手工用途");
  assert.deepEqual(importBodies[0].researchMatch, match);
  entries = [{ ...entries[0], purposeCategories: ["topic"] }];
  await panel.renderToRead();
  void nodes["sch-toread"].querySelectorAll("button").find(button => button.textContent === "＋项目").click();
  await tick();
  assert.deepEqual(importBodies[1].purposeCategories, ["topic"]);
  entries = [{ ...entries[0], purposeCategories: [] }];
  await panel.renderToRead();
  void nodes["sch-toread"].querySelectorAll("button").find(button => button.textContent === "＋项目").click();
  await tick();
  assert.deepEqual(importBodies[2].purposeCategories, [], "显式恢复自动的空数组必须保留");

  entries = [{ id: "classification-race", title: "Changing purpose", pdfUrl: "https://fixture.test/paper.pdf", purposeCategories: ["module"] }];
  await panel.renderToRead();
  const changingSelect = nodes["sch-toread"].querySelector(".tr-purpose-select");
  const changingImport = nodes["sch-toread"].querySelectorAll("button").find(button => button.textContent === "＋项目");
  const changingRemove = nodes["sch-toread"].querySelectorAll("button").find(button => button.textContent === "✕");
  patchDeferred = deferred();
  changingSelect.value = "topic";
  const purposeSave = changingSelect.fire("change");
  assert.equal(changingImport.disabled, true, "分类保存期间不能导入旧用途");
  assert.equal(changingRemove.disabled, true, "分类保存期间不能移除正在更新的条目");
  await changingImport.click();
  await changingRemove.click();
  assert.equal(importBodies.length, 3);
  entries = [{ ...entries[0], purposeCategories: ["topic"] }];
  patchDeferred.resolve(response({ entry: entries[0] }));
  await purposeSave;
  patchDeferred = null;
  assert.equal(nodes["sch-toread"].querySelector(".tr-purpose-select").value, "topic");
  void changingImport.click();
  await tick();
  assert.deepEqual(importBodies[3].purposeCategories, ["topic"], "保存完成后旧行闭包也必须携带新用途");

  const switchedSearch = nodes["btn-search"].click();
  state.currentPaper = { id: "another-paper" };
  await window.dispatchEvent(new Event("pipaper:paper-changed"));
  assert.equal(searches[3].options.signal.aborted, true);
  searches[3].resolve(response({ status: "ok", results: [{ title: "Old anchor result" }] }));
  await switchedSearch;
  assert.match(nodes["sch-status"].textContent, /当前论文已切换/);
  assert.doesNotMatch(nodes["sch-results"].textContent, /Old anchor result/);

  const cancelledSearch = nodes["btn-search"].click();
  await nodes["btn-sch-cancel"].click();
  searches[4].resolve(response({ status: "ok", results: [{ title: "Cancelled result" }] }));
  await cancelledSearch;
  assert.match(nodes["sch-status"].textContent, /已取消检索/);
  assert.equal(nodes["sch-results"].getAttribute("aria-busy"), "false");
  assert.doesNotMatch(nodes["sch-results"].textContent, /Cancelled result/);
});
