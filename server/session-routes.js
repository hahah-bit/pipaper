import fs from "node:fs";
import * as h from "./harness.js";

export function registerSessionRoutes(api) {
  const owner = req => req.get("x-pi-control");
  const route = handler => async (req, res) => {
    try { await handler(req, res); }
    catch (e) {
      if (res.headersSent) res.end();
      else res.status(e.status || 400).json({ error: String(e.message || e) });
    }
  };
  api.get("/models", route(async (req, res) => res.json(await h.modelList(req.query.sessionId))));
  api.get("/sessions", route(async (_req, res) => res.json({ sessions: await h.listSessions() })));
  api.post("/sessions", route(async (req, res) => res.json(await h.createChat(req.body))));
  api.get("/sessions/:id", route(async (req, res) => res.json(await h.sessionHistory(req.params.id))));
  api.get("/sessions/:id/state", route(async (req, res) => res.json(await h.sessionState(req.params.id))));
  api.get("/sessions/:id/tree", route(async (req, res) => res.json((await h.controllerFor(req.params.id)).tree())));
  api.get("/sessions/:id/events", route(async (req, res) => {
    const c = await h.controllerFor(req.params.id);
    // Restoring a cold session may outlive a tab navigation/connection timeout.
    // Do not claim an owner on a response whose close event already happened.
    if (res.destroyed || req.aborted) return;
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const connection = c.connect(event => res.write(`data: ${JSON.stringify(event)}\n\n`), () => res.end());
    const ping = setInterval(() => { if (!res.destroyed) res.write(": ping\n\n"); }, 15000);
    res.on("close", () => { clearInterval(ping); void connection.close(); });
  }));
  api.post("/sessions/:id/prompt", route(async (req, res) => {
    if (!String(req.body.text || "").trim() && !req.body.images?.length) throw new Error("空消息");
    res.status(202).json(await h.promptChat(req.params.id, req.body, owner(req)));
  }));
  api.post("/sessions/:id/steer", route(async (req, res) => res.json(await h.steerChat(req.params.id, req.body, owner(req)))));
  api.post("/sessions/:id/ui/:requestId", route(async (req, res) => res.json(await h.answerUserInput(req.params.id, req.params.requestId, req.body, owner(req)))));
  api.post("/sessions/:id/abort", route(async (req, res) => res.json(await h.abortChat(req.params.id, req.body.kind, owner(req)))));
  api.post("/sessions/:id/model", route(async (req, res) => res.json(await h.setChatModel(req.params.id, req.body, owner(req)))));
  api.post("/sessions/:id/compact", route(async (req, res) => res.status(202).json(await h.compactSession(req.params.id, req.body.instructions, owner(req)))));
  api.post("/sessions/:id/fork", route(async (req, res) => res.status(202).json(await h.forkChat(req.params.id, req.body, owner(req)))));
  api.delete("/sessions/:id", route(async (req, res) => { await h.deleteChat(req.params.id, owner(req)); res.json({ ok: true }); }));
  for (const action of ["binding", "name", "reload", "editor", "tree/navigate", "tree/label", "queue/take", "queue/mode", "tools"]) {
    api.post(`/sessions/:id/${action}`, route(async (req, res) => res.json(await h.operate(req.params.id, action, req.body, owner(req)))));
  }
  api.post("/sessions/:id/export", route(async (req, res) => {
    const file = await h.exportSession(req.params.id, req.body.format, owner(req));
    res.download(file, `PiPaper-${req.params.id}.${req.body.format}`, () => { fs.rm(file, { force: true }, () => {}); });
  }));
  api.get("/pi/commands", route(async (req, res) => res.json(await h.listCommands(req.query.sessionId, req.query.projectId))));
}
