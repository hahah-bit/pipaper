export function mapMessage(m, entryId) {
  const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content || []);
  const parts = content.map(c => c.type === "thinking" ? { ...c, text: c.thinking || "" }
    : c.type === "toolCall" ? { ...c, args: c.arguments } : c);
  const usage = m.usage ? { ...m.usage, cost: m.usage.cost?.total } : undefined;
  return { ...m, entryId, parts, usage, model: m.model ? `${m.provider || ""}/${m.model}` : undefined,
    error: m.errorMessage, text: content.filter(c => c.type === "text").map(c => c.text).join("\n") };
}

export function mapEntry(entry) {
  let message;
  if (entry.type === "message") message = entry.message;
  else if (entry.type === "custom_message") message = { ...entry, role: "custom" };
  else if (entry.type === "compaction") message = { ...entry, role: "compactionSummary", content: entry.summary };
  else if (entry.type === "branch_summary") message = { ...entry, role: "branchSummary", content: entry.summary };
  if (!message || (message.role === "custom" && !message.display)) return null;
  return mapMessage(message, entry.id);
}

export function sessionTranscript(session) {
  // The selected branch includes the original (possibly compacted) transcript.
  // It is deliberately separate from session.messages, the LLM context.
  return session.sessionManager.getBranch().map(mapEntry).filter(Boolean);
}

export function sessionTree(session) {
  const visit = node => ({ id: node.entry.id, parentId: node.entry.parentId, type: node.entry.type,
    role: node.entry.message?.role, label: node.label || session.sessionManager.getLabel(node.entry.id),
    text: (mapEntry(node.entry)?.text || node.entry.summary || node.entry.name || node.entry.type).slice(0, 160),
    children: node.children.map(visit) });
  return { leafId: session.sessionManager.getLeafId(), nodes: session.sessionManager.getTree().map(visit) };
}
