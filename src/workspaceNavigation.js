// Navigation follows the user's task; module IDs remain stable for saved documents.
export const WORKSPACES = [
  {
    id: "discover",
    name: "检索",
    icon: "search",
    views: [
      {
        id: "knowledge",
        name: "知识库",
        hint: "查已入库的正文、图表和知识成果",
      },
      {
        id: "search",
        name: "找论文",
        hint: "检索外部学术来源，找到后导入文献库",
      },
    ],
  },
  {
    id: "insight",
    name: "解读",
    icon: "figana",
    contextual: true,
    views: [
      { id: "note", name: "粗读", hint: "梳理论文的问题、方法与结论" },
      { id: "figana", name: "图表", hint: "结合原图原表解读方法与实验" },
      {
        id: "diagram",
        name: "图解",
        hint: "把知识结构、方法流程和架构关系画清楚",
      },
    ],
  },
  {
    id: "research",
    name: "研究",
    icon: "research",
    views: [
      { id: "research", name: "研究概览", hint: "项目研究问题、成果关联与下一步" },
    ],
  },
  {
    id: "media",
    name: "视频",
    icon: "video",
    page: "/videos",
    views: [{ id: "video", name: "视频解析", hint: "播放视频、截帧提问与时间轴解析" }],
  },
  {
    id: "writing",
    name: "写作",
    icon: "mdedit",
    views: [
      { id: "mdedit", name: "Markdown", hint: "整理笔记，编辑正文与公式" },
      { id: "latex", name: "LaTeX", hint: "编辑论文源文件并编译 PDF" },
      { id: "artifact", name: "会话产出", hint: "查看当前对话生成的文件" },
    ],
  },
  {
    id: "library",
    name: "资料",
    icon: "storage",
    views: [
      {
        id: "storage",
        name: "资料",
        hint: "管理资源、处理任务、待核对与回收站",
      },
    ],
  },
];
export const workspaceById = (id) => WORKSPACES.find((w) => w.id === id);
export function moduleDestination(id) {
  if (["mindmap", "flow", "archify"].includes(id))
    return { workspaceId: "insight", activeView: "diagram", diagramKind: id };
  if (id === "notesmgr")
    return {
      workspaceId: "library",
      activeView: "storage",
      libraryView: "notes",
    };
  const area = WORKSPACES.find((w) => w.views.some((v) => v.id === id));
  return area ? { workspaceId: area.id, activeView: id } : null;
}

// Keep surviving groups' geometry while collapsing duplicate tools into one task workspace.
export function migrateWorkspace(source) {
  const layout = structuredClone(source);
  if (!layout?.panels) return layout;
  const preferred = [];
  const visit = (object) => {
    if (!object || typeof object !== "object") return;
    if (object.id === layout.activeGroup && object.activeView)
      preferred.push(object.activeView);
    for (const value of Object.values(object))
      if (typeof value === "object") visit(value);
  };
  visit(layout);
  const entries = Object.entries(layout.panels).sort(
    ([a], [b]) => Number(preferred.includes(b)) - Number(preferred.includes(a)),
  );
  const areas = new Map(),
    keep = new Set();
  for (const [id, panel] of entries) {
    const destination = panel.params?.workspaceId === "insight" && panel.params.activeView === "video"
      ? { ...panel.params, workspaceId: "media" }
      : panel.params?.workspaceId
      ? panel.params
      : moduleDestination(panel.params?.moduleId);
    if (!destination || !workspaceById(destination.workspaceId)) {
      keep.add(id);
      continue;
    }
    const existing = areas.get(destination.workspaceId);
    if (existing) {
      delete layout.panels[id];
      continue;
    }
    areas.set(destination.workspaceId, id);
    panel.params = { ...destination };
    delete panel.params.moduleId;
    panel.title = workspaceById(destination.workspaceId).name;
    keep.add(id);
  }
  function prune(object) {
    if (!object || typeof object !== "object") return object;
    if (Array.isArray(object))
      return object.map(prune).filter((v) => v != null);
    if (object.type === "branch") {
      object.data = prune(object.data);
      return object.data.length ? object : null;
    }
    if (Array.isArray(object.views)) {
      object.views = object.views.filter((id) => keep.has(id));
      if (!object.views.length) return null;
      if (!object.views.includes(object.activeView))
        object.activeView = object.views[0];
    }
    for (const [key, value] of Object.entries(object))
      if (value && typeof value === "object") {
        object[key] = prune(value);
        if ((key === "data" || key === "grid") && object[key] == null)
          return null;
      }
    if (Object.hasOwn(object, "root") && object.root == null)
      object.root = { type: "branch", data: [] };
    return object;
  }
  layout.grid = prune(layout.grid);
  for (const key of ["floatingGroups", "popoutGroups", "edgeGroups"])
    if (layout[key]) layout[key] = prune(layout[key]);
  const groups = [];
  const surviving = (object) => {
    if (!object || typeof object !== "object") return;
    if (Array.isArray(object.views) && object.id) groups.push(object.id);
    for (const value of Object.values(object))
      if (typeof value === "object") surviving(value);
  };
  surviving(layout);
  if (!groups.includes(layout.activeGroup)) layout.activeGroup = groups[0];
  return layout;
}
