import { $, el, toast, addChip } from "./app.js";
import { streamPrompt } from "./chat.js";

// Self-contained video module (right panel tab): manager list + inline player
// + AI analysis (timeline / mindmap via markmap) + batch analysis + PiP with
// our own controls. Nothing leaks into the reader pane anymore.

const videos = []; // {name, url, file?, remote?}
let current = null;
let listCollapsed = false;
const selected = new Set();

const srcOf = (v) => (v.remote ? "/api/video/proxy?url=" + encodeURIComponent(v.url) : v.url);

export function initVideoPanel() {
  $("#btn-video-pick").addEventListener("click", () => $("#video-input").click());
  $("#video-input").addEventListener("change", (e) => {
    for (const f of [...e.target.files]) addVideo({ name: f.name, url: URL.createObjectURL(f), file: f });
    e.target.value = "";
  });
  $("#btn-video-url").addEventListener("click", () => {
    const row = $("#video-url-row");
    row.hidden = !row.hidden;
    if (!row.hidden) $("#video-url-input").focus();
  });
  $("#btn-video-url-add").addEventListener("click", () => {
    const url = $("#video-url-input").value.trim();
    if (!url) return;
    const name = decodeURIComponent(url.split("/").pop().split("?")[0]) || url;
    addVideo({ name, url, remote: true });
    $("#video-url-input").value = "";
    $("#video-url-row").hidden = true;
  });
  $("#video-url-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); $("#btn-video-url-add").click(); }
  });
  $("#video-list-head").addEventListener("click", (e) => {
    if (e.target.closest(".video-item") || e.target.closest("button") || e.target.closest("input")) return;
    listCollapsed = !listCollapsed;
    $("#video-list").hidden = listCollapsed;
    $("#video-list-head .vd-caret").textContent = listCollapsed ? "▸" : "▾";
  });
  $("#btn-va-run").addEventListener("click", () => {
    if (!current) return toast("先打开一个视频", true);
    analyzeOne(current, $("#va-mode").value);
  });
  $("#btn-va-batch").addEventListener("click", () => {
    if (!selected.size) return toast("先在列表勾选视频", true);
    analyzeBatch([...selected]);
  });
  $("#btn-va-pip").addEventListener("click", openPip);
  bindFrameButtons();
}

function addVideo(v) {
  videos.push(v);
  renderList();
  playVideo(v);
}

function removeVideo(i) {
  const v = videos[i];
  selected.delete(v);
  if (current === v) {
    const player = $("#video-el");
    if (player) { player.pause(); player.removeAttribute("src"); player.load(); }
    current = null;
    $("#video-player-card").hidden = true;
  }
  if (!v.remote) URL.revokeObjectURL(v.url);
  videos.splice(i, 1);
  renderList();
}

function renderList() {
  const box = $("#video-list");
  if (!box) return;
  box.replaceChildren();
  videos.forEach((v, i) => {
    const cb = el("input", { type: "checkbox", title: "批量解析勾选" });
    cb.checked = selected.has(v);
    cb.addEventListener("change", () => {
      cb.checked ? selected.add(v) : selected.delete(v);
      $("#va-batch-count").textContent = selected.size ? `（${selected.size}）` : "";
    });
    box.append(
      el("div", { class: "video-item" + (current === v ? " active" : "") },
        cb,
        el("span", { class: "vi-name", title: v.name, onclick: () => playVideo(v) }, (v.remote ? "🔗 " : "🎬 ") + v.name),
        el("button", { class: "vi-x", title: "移除", onclick: (e) => { e.stopPropagation(); removeVideo(i); } }, "✕")
      )
    );
  });
}

function playVideo(v) {
  current = v;
  renderList();
  $("#video-player-card").hidden = false;
  const player = $("#video-el");
  const src = srcOf(v);
  if (player.dataset.src !== src) {
    player.dataset.src = src;
    player.src = src;
  }
  $("#video-title").textContent = v.name;
  $("#va-timeline").replaceChildren();
  $("#va-summary").replaceChildren();
  $("#va-mindmap-card").hidden = true;
  $("#va-summary-card").hidden = true;
  player.play().catch(() => {});
  player.ontimeupdate = () => {
    const t = $("#video-ts");
    if (t) t.textContent = `⏱ ${fmt(player.currentTime)} / ${fmt(player.duration || 0)}`;
  };
}

function fmt(s) {
  s = Math.floor(s || 0);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// ---------- frame capture ----------
function captureFromEl(videoEl, count) {
  return new Promise(async (resolve) => {
    const frames = [];
    const dur = videoEl.duration;
    if (!dur || !isFinite(dur)) return resolve(frames);
    videoEl.muted = true;
    for (let i = 0; i < count; i++) {
      const t = Math.min(dur - 0.2, (dur * (i + 0.5)) / count);
      await new Promise((r) => {
        const on = () => { videoEl.removeEventListener("seeked", on); r(); };
        videoEl.addEventListener("seeked", on);
        try { videoEl.currentTime = t; } catch { r(); }
        setTimeout(r, 2500);
      });
      try {
        const c = document.createElement("canvas");
        const scale = Math.min(1, 1280 / (videoEl.videoWidth || 1280));
        c.width = Math.round((videoEl.videoWidth || 1280) * scale);
        c.height = Math.round((videoEl.videoHeight || 720) * scale);
        c.getContext("2d").drawImage(videoEl, 0, 0, c.width, c.height);
        frames.push({ ts: t, dataUrl: c.toDataURL("image/jpeg", 0.72) });
      } catch {}
    }
    resolve(frames);
  });
}

async function captureVideoFrames(v, count) {
  const live = $("#video-el");
  if (current === v && live && live.videoWidth) {
    const keep = live.currentTime;
    const frames = await captureFromEl(live, count);
    live.currentTime = keep;
    return frames;
  }
  const tmp = document.createElement("video");
  tmp.crossOrigin = "anonymous";
  tmp.preload = "auto";
  tmp.src = srcOf(v);
  await new Promise((r) => { tmp.onloadeddata = r; setTimeout(r, 20000); });
  const frames = await captureFromEl(tmp, count);
  tmp.removeAttribute("src");
  tmp.load();
  return frames;
}

// ---------- AI analysis ----------
function analysisPrompt(name, dur, frames, mode) {
  const m = mode === "auto" ? (dur < 180 ? "summary" : "full") : mode;
  const tsList = frames.map((f, i) => `帧${i + 1} @ ${fmt(f.ts)}`).join("，");
  const head = `请使用 video-use 技能分析视频《${name}》（时长 ${fmt(dur)}）。按时间顺序提供 ${frames.length} 个等间隔关键帧：${tsList}。请基于画面实际内容作答，不要编造。`;
  if (m === "summary") {
    return head + "\n\n请总结视频整体脉络：分 3-6 点，每点注明大致时间段，最后一句总评。";
  }
  return (
    head +
    "\n\n请严格按以下格式输出：\n===TIMELINE===\n纯 JSON 数组（不要代码块）：[{\"t\": 秒数, \"title\": \"章节名(≤8字)\", \"desc\": \"一句话内容\"}]，5-12 项按时间排序\n===OUTLINE===\nMarkdown 大纲（# 视频主题，## 一级分支，- 要点），用于 markmap 思维导图渲染\n===SUMMARY===\n3 句话概括整体脉络"
  );
}

function parseAnalysis(text) {
  const grab = (tag) => {
    // tolerate any number of '=' around markers (===X=== / ==X==)
    const m = text.match(new RegExp("=" + tag + "=+\\s*([\\s\\S]*?)(?==+[A-Z]+=+|$)"));
    return m ? m[1].replace(/```[a-z]*|```/g, "").trim() : "";
  };
  let timeline = null;
  const tlRaw = grab("TIMELINE");
  if (tlRaw) {
    try {
      const arr = JSON.parse(tlRaw);
      if (Array.isArray(arr)) timeline = arr.filter((x) => typeof x.t === "number");
    } catch {}
  }
  if (!timeline) {
    // fallback: first JSON array containing "t" anywhere in the text
    const m = text.match(/\[\s*\{[\s\S]{0,4000}?"t"\s*:[\s\S]*?\}\s*\]/);
    if (m) {
      try {
        const arr = JSON.parse(m[0]);
        if (Array.isArray(arr)) timeline = arr.filter((x) => typeof x.t === "number");
      } catch {}
    }
  }
  let outline = grab("OUTLINE");
  if (!outline) {
    const m = text.match(/^#{1,2} .+$/m);
    if (m) outline = text.slice(text.indexOf(m[0])).replace(/=+[A-Z]+=+[\s\S]*$/, "").trim();
  }
  return { timeline, outline, summary: grab("SUMMARY"), raw: text };
}

async function analyzeOne(v, mode) {
  const dur = await durationOf(v);
  const nFrames = mode === "summary" ? 4 : 8;
  setVaStatus(`抽取 ${nFrames} 个关键帧…`);
  const frames = await captureVideoFrames(v, nFrames);
  if (!frames.length) {
    setVaStatus("");
    return toast("抽帧失败（远程视频可能无法读取）", true);
  }
  setVaStatus(`AI 分析中（${frames.length} 帧）…`);
  const prompt = analysisPrompt(v.name, dur, frames, mode);
  await streamPrompt(
    prompt,
    frames.map((f) => ({ mimeType: "image/jpeg", data: f.dataUrl.split(",")[1] })),
    `🎬 AI 解析《${v.name}》`,
    [],
    (text) => { setVaStatus(""); renderAnalysis(parseAnalysis(text), v); }
  );
}

async function analyzeBatch(list) {
  const all = [];
  for (const v of list) {
    setVaStatus(`抽取《${v.name}》关键帧…`);
    const frames = await captureVideoFrames(v, 3);
    if (frames.length) all.push({ v, frames });
  }
  if (!all.length) { setVaStatus(""); return toast("全部抽帧失败", true); }
  const parts = [
    `请使用 video-use 技能，对 ${all.length} 个视频做综合分析（每个视频 3 个等间隔关键帧，按视频分组，每帧带时间戳）。请基于画面实际内容作答。`,
    "请严格按以下格式输出：",
    "===TIMELINE===\n纯 JSON 数组：[{\"video\":\"视频名\",\"t\":秒,\"title\":\"要点\"}]，每视频 2-4 项",
    "===OUTLINE===\nMarkdown 综合思维导图大纲（# 总主题，## 各视频，- 要点）",
    "===SUMMARY===\n各视频一句话脉络 + 它们之间的关系/对比",
  ];
  const images = [];
  for (const { v, frames } of all) {
    parts.push(`\n《${v.name}》：${frames.map((f, i) => `帧${i + 1}@${fmt(f.ts)}`).join("，")}`);
    for (const f of frames) images.push({ mimeType: "image/jpeg", data: f.dataUrl.split(",")[1] });
  }
  setVaStatus(`AI 综合分析中（${images.length} 帧）…`);
  await streamPrompt(
    parts.join("\n"),
    images.slice(0, 12),
    `🧠 批量解析 ${all.length} 个视频`,
    [],
    (text) => { setVaStatus(""); renderAnalysis(parseAnalysis(text), all[0].v); }
  );
}

function setVaStatus(t) {
  const n = $("#va-status");
  if (n) n.textContent = t;
}

async function durationOf(v) {
  const live = $("#video-el");
  if (current === v && live && isFinite(live.duration)) return live.duration;
  return await new Promise((resolve) => {
    const tmp = document.createElement("video");
    tmp.preload = "metadata";
    tmp.src = srcOf(v);
    tmp.onloadedmetadata = () => { resolve(tmp.duration || 0); tmp.removeAttribute("src"); };
    tmp.onerror = () => resolve(0);
    setTimeout(() => resolve(tmp.duration || 0), 15000);
  });
}

// ---------- result rendering ----------
async function renderAnalysis(parsed, v) {
  const tlBox = $("#va-timeline");
  tlBox.replaceChildren();
  if (parsed.timeline?.length) {
    tlBox.append(el("div", { class: "va-sec" }, "⏱ 时间轴（点击跳转）"));
    const wrap = el("div", { class: "va-tl" });
    for (const item of parsed.timeline) {
      wrap.append(
        el("button", {
          class: "va-chip",
          title: item.desc || item.video || "",
          onclick: () => {
            if (item.video) {
              const target = videos.find((x) => x.name === item.video);
              if (target) playVideo(target);
            } else playVideo(v);
            setTimeout(() => {
              const p = $("#video-el");
              if (p && isFinite(item.t)) p.currentTime = item.t;
            }, 700);
          },
        }, el("span", { class: "va-t" }, fmt(item.t)), el("span", {}, item.title || ""))
      );
    }
    tlBox.append(wrap);
  }
  if (parsed.outline) {
    $("#va-mindmap-card").hidden = false;
    await renderMindmap($("#va-mindmap-svg"), parsed.outline);
  }
  if (parsed.summary || parsed.raw) {
    const box = $("#va-summary");
    box.replaceChildren();
    box.textContent = parsed.summary || parsed.raw.slice(0, 1500);
    $("#va-summary-card").hidden = false;
  }
}

async function renderMindmap(svgEl, md) {
  try {
    const { Transformer } = await import("markmap-lib");
    const { Markmap } = await import("markmap-view");
    svgEl.replaceChildren();
    const tr = new Transformer();
    Markmap.create(svgEl, { autoFit: true, duration: 300, maxWidth: 260 }, tr.transform(md || "# 空").root);
  } catch (e) {
    svgEl.parentElement.append(el("div", { class: "res-note" }, "导图渲染失败: " + e.message));
  }
}

// ---------- PiP with our controls ----------
async function openPip() {
  const player = $("#video-el");
  if (!player || !player.src) return toast("先打开视频", true);
  if (!("documentPictureInPicture" in window)) {
    try { await player.requestPictureInPicture(); } catch { toast("浏览器不支持画中画", true); }
    return;
  }
  try {
    const pip = await documentPictureInPicture.requestWindow({ width: 560, height: 400 });
    for (const sheet of document.styleSheets) {
      try {
        if (sheet.href) {
          const link = pip.document.createElement("link");
          link.rel = "stylesheet";
          link.href = sheet.href;
          pip.document.head.append(link);
        }
      } catch {}
    }
    const stage = $("#video-stage");
    pip.document.body.style.cssText = "margin:0;background:#0f1117;display:flex;align-items:center;justify-content:center;";
    pip.document.body.append(stage);
    pip.addEventListener("pagehide", () => {
      const card = $("#video-player-card");
      if (card) card.prepend(stage);
    });
  } catch (e) {
    toast("画中画失败: " + e.message, true);
  }
}

// ---------- frame ask / chip ----------
function bindFrameButtons() {
  document.addEventListener("click", async (e) => {
    const ask = e.target.closest?.("#btn-frame-ask");
    const chip = e.target.closest?.("#btn-frame-chip");
    if (!ask && !chip) return;
    const video = $("#video-el");
    if (!video || !video.videoWidth) return toast("请先播放视频", true);
    const c = document.createElement("canvas");
    const scale = Math.min(1, 1600 / video.videoWidth);
    c.width = video.videoWidth * scale;
    c.height = video.videoHeight * scale;
    c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
    let dataUrl;
    try { dataUrl = c.toDataURL("image/jpeg", 0.9); } catch { return toast("跨域视频无法截帧", true); }
    const ts = fmt(video.currentTime);
    const name = current?.name || "video";
    if (ask) {
      await streamPrompt(
        `这是视频《${name}》在 ${ts} 处的一帧。请描述并分析画面内容（若是讲解/演示视频，解释当前讲到的要点）。`,
        [{ mimeType: "image/jpeg", data: dataUrl.split(",")[1] }],
        `📸 视频截帧 @${ts}（《${name}》）`
      );
    } else {
      addChip({ kind: "image", tag: "视频帧", body: `《${name}》@${ts}`, dataUrl, mimeType: "image/jpeg" });
      toast("当前帧已加入对话上下文");
    }
  });
}

