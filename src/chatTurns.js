// A user question owns all following assistant/tool steps until the next question.
// Archive once settled; reconnecting to a busy session keeps its current turn live.
export class ChatTurns {
  constructor(archive) { this.archive = archive; this.reset(); }
  reset() { this.turns = []; this.current = null; }
  begin() {
    this.finish();
    this.current = { nodes: [], archived: 0, record: null };
    this.turns.push(this.current);
  }
  add(node) {
    if (!this.current) this.begin();
    this.current.nodes.push(node);
  }
  finish({ keepCurrent = false } = {}) {
    for (const turn of this.turns) {
      if (keepCurrent && turn === this.current) continue;
      if (turn.nodes.length === turn.archived) continue;
      this.archive(turn);
      turn.archived = turn.nodes.length;
    }
  }
}

export function turnRecordLabel(nodes) {
  const tools = nodes.reduce((n, node) => n + (node.activity?.steps || 0), 0);
  const thinking = nodes.some(node => node.activity?.thinkShown);
  return ["执行记录", thinking && "思考", tools && `${tools} 次工具调用`, `${nodes.length} 次模型调用`].filter(Boolean).join(" · ");
}
