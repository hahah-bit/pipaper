// Distinct silhouettes keep book, chart and document tools recognizable on every platform.
const shapes = {
  topics: '<path d="M9 18h6m-5 3h4M8 14a6 6 0 1 1 8 0c-1 1-1 2-1 2H9s0-1-1-2Z"/><path d="M12 1v1M3 4l1 1m16-1-1 1M1 11h2m18 0h2"/>',
  reader:
    '<path d="M12 5v15M3 4c3-1 6 0 9 2 3-2 6-3 9-2v15c-3-1-6 0-9 2-3-2-6-3-9-2Z"/>',
  knowledge:
    '<ellipse cx="9" cy="5" rx="6" ry="3"/><path d="M3 5v11c0 2 3 3 6 3M3 10c2 2 5 3 8 2"/><circle cx="16" cy="15" r="4"/><path d="m19 18 3 3"/>',
  figana: '<path d="M3 3v18h18M7 17v-5M12 17V7M17 17V4"/>',
  note: '<path d="M5 3h13v18H5ZM2 7h5M2 12h5M2 17h5M10 7h5M10 12h5M10 17h3"/>',
  mindmap:
    '<circle cx="12" cy="12" r="3"/><circle cx="4" cy="4" r="2"/><circle cx="20" cy="4" r="2"/><circle cx="4" cy="20" r="2"/><circle cx="20" cy="20" r="2"/><path d="m6 6 4 4m4 0 4-4M6 18l4-4m4 0 4 4"/>',
  flow: '<rect x="8" y="2" width="8" height="5" rx="1"/><path d="M12 7v5M4 16v-4h16v4"/><rect x="1" y="16" width="6" height="5" rx="1"/><rect x="17" y="16" width="6" height="5" rx="1"/>',
  archify: '<path d="m12 2 10 5-10 5L2 7Zm-10 10 10 5 10-5M2 17l10 5 10-5"/>',
  mdedit:
    '<path d="M3 19V5h18v14M6 15V9l3 3 3-3v6m3-4h4m-2-2v6m-2-2 2 2 2-2"/>',
  latex: '<path d="M6 3H3v18h3m12-18h3v18h-3M16 5H8l5 7-5 7h8"/>',
  artifact:
    '<path d="m12 2 9 5v10l-9 5-9-5V7Zm-9 5 9 5 9-5M12 12v10m-5-18 9 5"/>',
  search: '<circle cx="10" cy="10" r="7"/><path d="m15 15 7 7M7 8h6M7 12h4"/>',
  video:
    '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 4v16m12-16v16M2 8h4m-4 8h4M18 8h4m-4 8h4"/><path d="m10 9 5 3-5 3Z"/>',
  storage:
    '<rect x="3" y="2" width="18" height="20" rx="2"/><path d="M3 9h18M3 16h18M9 5h6M9 12h6M9 19h6"/>',
  research:
    '<path d="M9 3h6M10 3v5.5L4.6 18a2 2 0 0 0 1.8 3h11.2a2 2 0 0 0 1.8-3L14 8.5V3"/><path d="M7.5 14h9"/>',
  notesmgr: '<path d="M3 7V4h7l2 3h9v13H3ZM7 11h10M7 15h7"/>',
  resources:
    '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 17h7m-3.5-3.5v7"/>',
  setup: '<path d="M3 4h18v13H3ZM8 21h8m-4-4v4M6 11h3l2-4 3 8 2-4h2"/>',
  settings:
    '<path d="M3 6h18M3 12h18M3 18h18"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/>',
};

export function dockIcon(key, fallback) {
  if (!shapes[key]) return document.createTextNode(fallback);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [name, value] of Object.entries({
    viewBox: "0 0 24 24",
    width: "22",
    height: "22",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.7",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  }))
    svg.setAttribute(name, value);
  svg.innerHTML = shapes[key];
  return svg;
}
