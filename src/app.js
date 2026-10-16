import { api } from "./platform/api.js";
import { state } from "./shell/state.js";
import { $, el, toast } from "./platform/dom.js";
import { renderWelcome } from "./features/chat/welcome.js";
import { updateZoteroFoot } from "./features/library/status.js";
import { persistence } from "./persistence.js";
import { initPersistence } from "./persistence.js";
// Application composition: shared capabilities live in platform/ and features/.
import { initSettings } from "./settings.js";
import { initResources, loadResources } from "./resources.js";
import { initPanes } from "./panes.js";
import { initSidebar, renderPapers, renderCollections, renderProjects, reloadPapers } from "./sidebar.js";
import { initChat, refreshSessions, loadCommands, syncModelSelect, syncSessionBinding, updateComposerHint } from "./chat.js";
import { renderSessionConnection } from "./sessionPanel.js";
import { initReader, readerLoadPaper } from "./reader.js";
import { initSearchPanel } from "./searchPanel.js";
import { initVideoPanel as initVideoTab } from "./videoPanel.js";
import { initTheme } from "./theme.js";
import { initClipboard } from "./clipPanel.js";
import { initSetupPanel, refreshSetup } from "./setupPanel.js";
import { initArtifacts } from "./artifacts.js";
import { registerBuiltinModules } from "./modules.js";
import { registerNoteModules } from "./notesPanel.js";
import { registerLatexModule } from "./latexEditor.js";
import { registerMdEditorModule } from "./mdEditor.js";
import { initDock, openWorkspace } from "./dock.js";
import { openStudyCreate } from "./study/create.js";

import { configureWorkspace } from "./platform/workspace-context.js";
// ---------------- boot ----------------
async function boot() {
  configureWorkspace(location.pathname === "/videos" ? "video" : "main");
  await initPersistence();
  $("#btn-study")?.addEventListener("click", () => openStudyCreate({ paperId: state.currentPaper?.id, projectId: state.projectId }).catch(e => toast(e.message, true)));
  // 界面字号在最早时机应用，避免正文先小后大的闪烁
  try {
    const { applyFontSize } = await import("./settings.js");
    applyFontSize(persistence.getItem("pipaper.fontSize") || "cozy");
  } catch {}
  window.__bootStage = "start"; window.__initErrors = [];
  try { initPanes(); } catch (e) { window.__initErrors.push("initPanes: " + (e.message||e)); }
  try { initResources(); } catch (e) { window.__initErrors.push("initResources: " + (e.message||e)); }
  try { initSidebar({
    onProjectChange: async () => { await syncSessionBinding(); await refreshSessions(); },
    onPaperSelection: async paper => { readerLoadPaper(paper); updateComposerHint(); await syncSessionBinding(); },
  }); } catch (e) { window.__initErrors.push("initSidebar: " + (e.message||e)); }
  try { initChat({ bindingSnapshot: paper => { renderProjects(); renderPapers(); if (paper) void readerLoadPaper(paper); } }); } catch (e) { window.__initErrors.push("initChat: " + (e.message||e)); }
  try { initReader({ reloadLibrary: reloadPapers }); } catch (e) { window.__initErrors.push("initReader: " + (e.message||e)); }
  try { initArtifacts(); } catch (e) { window.__initErrors.push("initArtifacts: " + (e.message||e)); }
  window.__bootStage = "modules";
  try { registerLatexModule(); } catch (e) { window.__initErrors.push("registerLatexModule: " + (e.message||e)); }
  try { registerMdEditorModule(); } catch (e) { window.__initErrors.push("registerMdEditorModule: " + (e.message||e)); }
  try { registerBuiltinModules(); registerNoteModules(); } catch (e) { window.__initErrors.push("initModules: " + (e.message||e)); }
  window.__bootStage = "dock"; try { initDock(); } catch (e) { window.__initErrors.push("initDock: " + (e.message||e)); }
  try { initSettings({ refreshDiagnostics: refreshSetup, refreshResources: loadResources, reloadLibrary: reloadPapers }); } catch (e) { window.__initErrors.push("initSettings: " + (e.message||e)); }
  try { initSetupPanel(); } catch (e) { window.__initErrors.push("initSetupPanel: " + (e.message||e)); }
  initTheme();
  initClipboard();
  window.__bootStage = "search"; try { initSearchPanel(); } catch (e) { window.__initErrors.push("initSearchPanel: " + (e.message||e)); }
  window.__bootStage = "video"; try { initVideoTab(); } catch (e) { window.__initErrors.push("initVideoTab: " + (e.message||e)); }
  if (location.pathname === "/videos") {
    document.body.classList.add("video-page");
    document.title = "视频 · PiPaper";
    openWorkspace("media", "video");
  }
  try {
    const [paperData, models, projects] = await Promise.all([api.papers(), api.models(), api.projects()]);
    state.papers = paperData.papers;
    state.collections = paperData.collections;
    state.zotero = paperData.zotero;
    state.models = models;
    syncModelSelect();
    state.projects = projects.projects || [];
    renderPapers();
    renderCollections();
    renderProjects();
    updateZoteroFoot();
    await refreshSessions();
    if (!state.sessionId) {
      // show welcome state; session is created on first message
      renderWelcome();
      void loadCommands();
    }
  } catch (e) {
    window.__bootStage = "error:" + (e.message || e);
    renderSessionConnection("disconnected", "初始化失败：" + (e.message || e));
    toast("初始化失败: " + (e.message || e), true);
  }
}


boot().catch((e) => { window.__bootErr = String(e && e.stack || e); console.error(e); });
