import { clipAdd, clipList, clipDelete, clipClear } from "../../clip.js";

export function registerClippingRoutes(api) {
  api.get("/clip", (_req, res) => res.json({ entries: clipList() }));
  api.post("/clip", (req, res) => {
    const e = clipAdd(req.body?.text);
    res.json(e ? { ok: true, entry: e } : { ok: false });
  });
  api.delete("/clip/:id", (req, res) => { clipDelete(req.params.id); res.json({ ok: true }); });
  api.post("/clip/clear", (_req, res) => { clipClear(); res.json({ ok: true }); });
}
