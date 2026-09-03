const base = "http://127.0.0.1:4318";
const s = await (
  await fetch(base + "/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paperId: "lib_b6819c96aa62", title: "smoke-test" }),
  })
).json();
console.log("session:", JSON.stringify(s));

await fetch(`${base}/api/sessions/${s.id}/model`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ thinkingLevel: "low" }),
});

const t0 = Date.now();
const res = await fetch(`${base}/api/sessions/${s.id}/prompt`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    text: "请调用 read_paper 的 outline 模式看一下当前论文的结构，然后只回复一句话概括这是篇什么论文。",
  }),
});
console.log("SSE status", res.status);
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "", events = 0, textLen = 0;
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const parts = buf.split("\n\n");
  buf = parts.pop();
  for (const part of parts) {
    const line = part.split("\n").find((l) => l.startsWith("data: "));
    if (!line) continue;
    try {
      const ev = JSON.parse(line.slice(6));
      events++;
      if (ev.t === "delta") textLen += ev.text.length;
      else console.log("ev:", ev.t, ev.name || "", (ev.preview || ev.usage ? JSON.stringify(ev.preview ?? ev.usage) : "").slice(0, 140));
    } catch {}
  }
}
console.log("total events:", events, "| assistant text chars:", textLen, "| elapsed", ((Date.now() - t0) / 1000).toFixed(1) + "s");

// verify history round-trip
const h = await (await fetch(`${base}/api/sessions/${s.id}`)).json();
console.log("history msgs:", h.messages?.length, "| model:", JSON.stringify(h.model));
for (const m of h.messages || []) console.log(" -", m.role, JSON.stringify((m.parts ? m.parts.map((p) => p.text || p.name).join("|") : m.text || "").slice(0, 80)));
