import { DOMParser } from "@xmldom/xmldom";

export function tableStructure(html) {
  if (!html) return null;
  const doc = new DOMParser({ onError: (level, message) => { if (level !== "warning") throw new Error(message); } }).parseFromString(html, "text/html");
  const rows = Array.from(doc.getElementsByTagName("tr"));
  const cells = [], occupied = [], issues = new Set();
  for (const [row, tr] of rows.entries()) {
    let col = 0;
    occupied[row] ||= [];
    for (const td of Array.from(tr.childNodes).filter((n) => ["td", "th"].includes(n.localName))) {
      while (occupied[row][col]) col++;
      const size = (name) => {
        const v = Number(td.getAttribute(name) || 1);
        if (!Number.isInteger(v) || v < 1 || v > 100) { issues.add("table-invalid-span"); return 1; }
        return v;
      };
      const rowspan = size("rowspan"), colspan = size("colspan");
      cells.push({ row, col, rowspan, colspan, text: td.textContent.trim(), header: td.localName === "th" });
      for (let y = row; y < row + rowspan; y++) {
        occupied[y] ||= [];
        for (let x = col; x < col + colspan; x++) {
          if (occupied[y][x]) issues.add("table-overlap");
          occupied[y][x] = true;
        }
      }
      col += colspan;
    }
  }
  const columns = Math.max(0, ...occupied.map((r) => r.length));
  if (!cells.length) issues.add("empty-table");
  if (occupied.length > rows.length || occupied.some((r) => r.length !== columns || Array.from({ length: columns }, (_, c) => r[c]).some((v) => !v))) issues.add("table-grid-incomplete");
  return { rows: rows.length, columns, cells, issues: [...issues] };
}
