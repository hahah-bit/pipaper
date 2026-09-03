import { $, el, toast, addChip } from "./app.js";

// Video panel: open local videos or video URLs, play in the reader pane,
// capture frames to ask the AI. The list doubles as a collapsible manager.

const videos = []; // {name, url, file?, remote?}
let current = null;
let listCollapsed = false;

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
    if (e.target.closest(".video-item") || e.target.closest("button")) return;
    listCollapsed = !listCollapsed;
    $("#video-list").hidden = listCollapsed;
    $("#video-list-head .vd-caret").textContent = listCollapsed ? "▸" : "▾";
  });
  initFrameButtons();
}

function addVideo(v) {
  videos.push(v);
  try { openVideo(v); } catch (e) { window.__vidErr = String(e && e.stack || e); return; }
  renderList();
  openVideo(v);
}

function removeVideo(i) {
  const v = videos[i];
  if (current === v) {
    const video = document.getElementById("video-el");
    if (video) video.removeAttribute("src"), video.load();
    current = null;
    $("#tab-video-reader")?.classList.remove("active");
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
    box.append(
      el("div", { class: "video-item" + (current === v ? " active" : "") },
        el("span", { class: "vi-name", title: v.name, onclick: () => openVideo(v) }, (v.remote ? "🔗 " : "🎬 ") + v.name),
        el("button", { class: "vi-x", title: "移除", onclick: (e) => { e.stopPropagation(); removeVideo(i); } }, "✕")
      )
    );
  });
}

function openVideo(v) {
  current = v;
  renderList();
  // reader pane: switch to video mode
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  let tv = $("#tab-video-reader");
  if (!tv) {
    tv = el("button", { id: "tab-video-reader", class: "tab", onclick: () => showVideoView() }, "视频");
    $("#reader-head .tabs").append(tv);
  }
  let view = $("#video-reader-view");
  if (!view) {
    const holder = el("div", { id: "video-reader-view", class: "reader-view", hidden: "hidden" });
    holder.innerHTML = `
      <div class="video-wrap">
        <video id="video-el" controls style="max-width:100%; max-height:78vh; background:#000; border-radius:8px;"></video>
        <div class="video-bar">
          <span id="video-ts" class="res-note" style="margin:0"></span>
          <button id="btn-frame-ask" class="tool-btn primary">📸 截帧问 AI</button>
          <button id="btn-frame-chip" class="tool-btn">截帧加入对话</button>
        </div>
      </div>`;
    $("#reader-body").append(holder);
    view = document.getElementById("video-reader-view");
  }
  const video = view.querySelector("#video-el");
  if (video.src !== v.url) video.src = v.url;
  tv.hidden = false;
  showVideoView();
  video.addEventListener("timeupdate", () => {
    const t = video.currentTime;
    const el2 = document.querySelector("#video-ts");
    if (el2) el2.textContent = `⏱ ${fmt(t)} / ${fmt(video.duration || 0)} · ${v.name}`;
  });
}

function showVideoView() {
  for (const id of ["parsed-view", "pdf-view", "video-reader-view"]) {
    const n = document.getElementById(id);
    if (n) n.hidden = id !== "video-reader-view";
  }
  document.querySelectorAll("#reader-head .tab").forEach((t) => t.classList.toggle("active", t.id === "tab-video-reader"));
}

function fmt(s) {
  s = Math.floor(s || 0);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function captureFrame() {
  const video = $("#video-el") || document.getElementById("video-el");
  if (!video || !video.videoWidth) {
    toast("请先播放视频", true);
    return null;
  }
  const c = document.createElement("canvas");
  const scale = Math.min(1, 1600 / video.videoWidth);
  c.width = video.videoWidth * scale;
  c.height = video.videoHeight * scale;
  c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
  let dataUrl;
  try {
    dataUrl = c.toDataURL("image/jpeg", 0.9);
  } catch {
    toast("跨域视频无法截帧 — 请下载到本地后打开", true);
    return null;
  }
  return { dataUrl, ts: video.currentTime, name: current?.name || "video" };
}

function initFrameButtons() {
  document.addEventListener("click", async (e) => {
    const ask = e.target.closest?.("#btn-frame-ask");
    const chip = e.target.closest?.("#btn-frame-chip");
    if (!ask && !chip) return;
    const frame = captureFrame();
    if (!frame) return;
    const ts = fmt(frame.ts);
    if (ask) {
      const { streamPrompt } = await import("./chat.js");
      await streamPrompt(
        `这是本地视频《${frame.name}》在 ${ts} 处的一帧画面。请描述并分析这一帧的内容（如果是论文讲解/演示视频，请解释当前讲到的要点）。`,
        [{ mimeType: "image/jpeg", data: frame.dataUrl.split(",")[1] }],
        `📸 视频截帧 @${ts}（《${frame.name}》）`
      );
    } else {
      addChip({ kind: "image", tag: "视频帧", body: `《${frame.name}》@${ts}`, dataUrl: frame.dataUrl, mimeType: "image/jpeg" });
      toast("当前帧已加入对话上下文");
    }
  });
}

export function initVideoTab() {
  initVideoPanel();
}
