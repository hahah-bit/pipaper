// Shared markdown -> block[] splitter used by MinerU and fallback engines.
// Block shapes:
//   {type:'heading', level, text}
//   {type:'para', md, page?}
//   {type:'table', md, html?, caption?}
//   {type:'image', src, caption?, page?}
//   {type:'formula', latex}
//   {type:'code', lang, text}

export function mdToBlocks(md, { assetMap } = {}) {
  const blocks = [];
  const lines = String(md || "").replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let para = [];
  let pageHint = null;

  const flushPara = () => {
    if (para.length) {
      const text = para.join("\n").trim();
      if (text) blocks.push({ type: "para", md: text, ...(pageHint != null ? { page: pageHint } : {}) });
      para = [];
    }
  };
  const mapAsset = (src) => {
    if (!assetMap) return src;
    const clean = src.split(/[?#]/)[0];
    const base = clean.split("/").pop();
    return assetMap[base] || assetMap[clean] || src;
  };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code
    const fence = line.match(/^```\s*(\S+)?\s*$/);
    if (fence) {
      flushPara();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      blocks.push({ type: "code", lang: fence[1] || "", text: buf.join("\n") });
      continue;
    }

    // display math $$...$$
    if (/^\s*\$\$/.test(line)) {
      const single = line.match(/^\s*\$\$(.+)\$\$\s*$/);
      if (single) {
        flushPara();
        blocks.push({ type: "formula", latex: single[1].trim() });
        i++;
        continue;
      }
      flushPara();
      const buf = [];
      const first = line.replace(/^\s*\$\$/, "");
      buf.push(first);
      i++;
      while (i < lines.length && !lines[i].includes("$$")) buf.push(lines[i++]);
      const last = (lines[i] || "").replace(/\$\$\s*$/, "");
      if (i < lines.length) {
        buf.push(last);
        i++;
      }
      const latex = buf.join("\n").trim();
      if (latex) blocks.push({ type: "formula", latex });
      continue;
    }

    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      blocks.push({ type: "heading", level: h[1].length, text: h[2].replace(/#+\s*$/, "").trim() });
      i++;
      continue;
    }

    // image line (possibly with caption after)
    const img = line.match(/^\s*!\[([^\]]*)\]\(([^)\s]+)[^)]*\)\s*$/);
    if (img) {
      flushPara();
      blocks.push({ type: "image", src: mapAsset(img[2]), caption: img[1] || "", ...(pageHint != null ? { page: pageHint } : {}) });
      i++;
      continue;
    }
    // html <img> tag (unstructured/mineru sometimes emit these)
    const himg = line.match(/^\s*<img[^>]*src=["']([^"']+)["'][^>]*>\s*$/);
    if (himg) {
      flushPara();
      blocks.push({ type: "image", src: mapAsset(himg[1]), caption: "" });
      i++;
      continue;
    }

    // markdown table
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flushPara();
      const buf = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) buf.push(lines[i++]);
      blocks.push({ type: "table", md: buf.join("\n") });
      continue;
    }

    // html table (single block)
    if (/^\s*<table/i.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && !/<\/table>/i.test(lines[i])) buf.push(lines[i++]);
      if (i < lines.length) buf.push(lines[i++]);
      blocks.push({ type: "table", md: "", html: buf.join("\n") });
      continue;
    }

    // hr
    if (/^\s*([-*_]\s*){3,}$/.test(line)) {
      flushPara();
      i++;
      continue;
    }

    // page marker comments  <!-- page:N --> (our fallback emits these)
    const pm = line.match(/^\s*<!--\s*page:(\d+)\s*-->\s*$/);
    if (pm) {
      flushPara();
      pageHint = Number(pm[1]);
      i++;
      continue;
    }

    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara();
  return blocks;
}

// Very small markdown table -> html (kept dependency-free)
export function mdTableToHtml(md) {
  const rows = md.split("\n").filter(Boolean).map((r) =>
    r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim())
  );
  if (rows.length < 2) return `<table><tr>${rows[0]?.map((c) => `<th>${c}</th>`).join("") || ""}</tr></table>`;
  const [head, , ...body] = rows;
  const th = head.map((c) => `<th>${c}</th>`).join("");
  const trs = body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
}

// Blocks -> full.md (for the agent / export). Images point at asset URLs rewritten by caller.
export function blocksToMd(blocks) {
  const out = [];
  for (const b of blocks || []) {
    switch (b.type) {
      case "heading":
        out.push("#".repeat(Math.min(6, b.level || 1)) + " " + b.text, "");
        break;
      case "para":
        out.push(b.md, "");
        break;
      case "table":
        out.push(b.html || b.md, "");
        break;
      case "image":
        out.push(`![${b.caption || ""}](${b.src})${b.caption ? "\n\n*" + b.caption + "*" : ""}`, "");
        break;
      case "formula":
        out.push("$$\n" + b.latex + "\n$$", "");
        break;
      case "code":
        out.push("```" + (b.lang || "") + "\n" + b.text + "\n```", "");
        break;
    }
  }
  return out.join("\n");
}
