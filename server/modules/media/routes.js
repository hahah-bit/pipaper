

export function registerMediaRoutes(api) {
  api.get("/video/proxy", async (req, res) => {
    const target = String(req.query.url || "");
    if (!target.startsWith("http://") && !target.startsWith("https://")) return res.status(400).end("bad url");
    try {
      const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) PiPaper/0.8" };
      const ref = String(req.query.referer || "");
      if (ref && ref.startsWith("http")) headers.Referer = ref;
      if (req.headers.range) headers.Range = req.headers.range;
      const upstream = await fetch(target, { headers, redirect: "follow", signal: AbortSignal.timeout(600000) });
      const h = {
        "content-type": upstream.headers.get("content-type") || "video/mp4",
        "access-control-allow-origin": "*",
      };
      for (const k of ["content-length", "content-range", "accept-ranges"]) {
        const v = upstream.headers.get(k);
        if (v) h[k] = v;
      }
      res.writeHead(upstream.status, h);
      const { Readable } = await import("node:stream");
      Readable.fromWeb(upstream.body).pipe(res);
    } catch (e) {
      res.status(502).end(String(e.message || e).slice(0, 200));
    }
  });

  // ---- bilibili resolver (official public APIs, per bilibili-API-collect) ----
  api.get("/video/bili", async (req, res) => {
    const pageUrl = String(req.query.url || "");
    const bv = (pageUrl.match(/BV[0-9A-Za-z]{10}/) || [])[0];
    if (!bv) return res.status(400).json({ error: "未找到 BV 号" });
    const H = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Referer": "https://www.bilibili.com/" };
    try {
      const vj = await (await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`, { headers: H, signal: AbortSignal.timeout(20000) })).json();
      if (vj.code !== 0) throw new Error("view API: " + (vj.message || vj.code));
      const d = vj.data;
      let mp4 = null;
      try {
        const pj = await (await fetch(`https://api.bilibili.com/x/player/playurl?bvid=${bv}&cid=${d.cid}&qn=64&platform=html5&high_quality=1`, { headers: H, signal: AbortSignal.timeout(20000) })).json();
        if (pj.code === 0 && pj.data?.durl?.[0]?.url) mp4 = pj.data.durl[0].url;
      } catch {}
      res.json({
        ok: true,
        bv,
        title: d.title,
        duration: d.duration,
        cover: d.pic,
        desc: (d.desc || "").slice(0, 2000),
        owner: d.owner?.name || "",
        pages: d.videos || 1,
        mp4: mp4 ? "/api/video/proxy?referer=" + encodeURIComponent("https://www.bilibili.com/") + "&url=" + encodeURIComponent(mp4) : null,
      });
    } catch (e) {
      res.status(502).json({ error: "B站解析失败: " + String(e.message || e).slice(0, 160) });
    }
  });

  // ---- clipboard history (2-day TTL) ----

}
