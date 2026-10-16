// 研究概览的纯计算（A01.5）：时间线只汇总真实记录时间，不推断进度百分比。
const ACTION_STATUS_LABEL = { todo: "待办", doing: "进行中", done: "已完成", blocked: "受阻" };

export const actionStatusLabel = (status) => ACTION_STATUS_LABEL[status] || status || "待办";

export function buildTimeline(profile, { limit = 8 } = {}) {
  if (!profile) return [];
  const events = [];
  if (profile.updatedAt)
    events.push({ at: profile.updatedAt, kind: "profile", label: "研究档案更新" });
  for (const action of profile.actions || []) {
    if (action.status === "done" && action.doneAt)
      events.push({ at: action.doneAt, kind: "action", label: "完成行动：" + action.text });
    if (action.status === "blocked")
      events.push({ at: action.createdAt, kind: "action", label: "受阻行动：" + action.text });
  }
  for (const outcome of profile.outcomes || [])
    if (outcome.linkedAt)
      events.push({ at: outcome.linkedAt, kind: "outcome", label: "关联成果：" + (outcome.title || outcome.refId) });
  return events
    .filter((event) => event.at)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}

export function openActions(profile) {
  return (profile?.actions || []).filter((action) => action.status !== "done");
}
