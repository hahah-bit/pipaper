import { writeFile as managedWrite, readJsonState, writeJsonState, trashPath, registerFile } from "./storage/files.js";
import fs from "node:fs";
import path from "node:path";
import { blockText } from "./study-flow.js";
import { fault, hashOf, inside, taskDir, saveTask } from "./study-store.js";
import { parsedDir } from "./store.js";
import { KNOWLEDGE_DIR } from "./notes.js";
import { registerKnowledge } from "./storage/migration.js";
import { link } from "./storage/catalog.js";

export const notesFor = task => task.notes || { markdown: "", revision: 0, updatedAt: null };
function checkRevision(task, revision) {
  if (revision !== notesFor(task).revision) throw fault("笔记已在其他页面更新，本地草稿已保留。请先核对已保存版本再合并。", 409);
}
export function saveStudyNotes(task, { markdown, revision }) {
  checkRevision(task, revision);
  if (typeof markdown !== "string" || markdown.length > 1000000) throw fault("笔记内容无效或超过 100 万字符");
  task.notes = { markdown, revision: revision + 1, updatedAt: new Date().toISOString() };
  saveTask(task);
  const root=path.join(KNOWLEDGE_DIR,"论文研读",task.id),file=path.join(root,"阅读笔记.md");
  const snapshot=markdown.replace(new RegExp(`/api/studies/${task.id}/assets/([^\\s)]+)`,"g"),(_all,name)=>{
    const original=inside(path.join(taskDir(task.id),"assets"),name),target=inside(root,"assets/"+name);
    if(fs.existsSync(original))managedWrite(target,fs.readFileSync(original),{kind:"knowledge-asset",independent:true,owner:null});return "assets/"+name;
  });
  managedWrite(file,snapshot,{kind:"knowledge",sourceType:"study",title:task.title+" · 阅读笔记",owner:null,independent:true});
  const r=registerKnowledge(file,{sourceType:"study",sourcePaperId:task.paperId,projectId:task.projectId,owner:null,independent:true});link("study:"+task.id,r.id,"snapshot");
  return task.notes;
}
export function appendStudyNotes(task, doc, input) {
  checkRevision(task, input.revision);
  const ids = [...new Set(input.blockIds || [])];
  if (ids.length > 60 || ids.some(id => !doc.blocks.some(b => b.id === id))) throw fault("笔记选区包含无效原文块");
  const blocks = doc.blocks.filter(b => ids.includes(b.id));
  if (!blocks.length && (!input.text?.trim() || input.translated)) throw fault("请先选择原文段落、图片或表格");
  if (input.text != null && (typeof input.text !== "string" || input.text.length > 100000)) throw fault("选区文本过长");
  if (input.translated && blocks.some(b => !task.translations[b.id]?.translated || task.translations[b.id].error)) throw fault("所选内容尚未全部翻译成功，请完成翻译后添加笔记", 409);
  const asset = block => {
    const source = inside(parsedDir(task.paperId), String(block.src).replace(/^file\//, ""));
    const ext = path.extname(source).toLowerCase();
    if (![".png", ".jpg", ".jpeg", ".webp", ".svg"].includes(ext)) throw fault("不支持的原文图片格式");
    const content = fs.readFileSync(source), file = `note-${hashOf(content).slice(0, 24)}${ext}`;
    const folder = path.join(taskDir(task.id), "assets"); fs.mkdirSync(folder, { recursive: true });
    managedWrite(inside(folder, file), content);
    return `/api/studies/${task.id}/assets/${file}`;
  };
  const parts = blocks.map(block => {
    const label = `[原文 p.${block.page}](#block:${block.id}) · ${task.versionId}`;
    const original = block.type === "image" && block.src
      ? `![${String(block.caption || "论文插图").replace(/[\[\]\n]/g, " ")}](${asset(block)})\n\n${block.caption || ""}`
      : block.type === "formula" ? `$$\n${block.latex || blockText(block)}\n$$`
      : block.type === "code" ? `\`\`\`\n${blockText(block)}\n\`\`\`` : blockText(block);
    const tr = task.translations[block.id];
    return `${label}\n\n${original}${input.translated ? `\n\n**中文译文**\n\n${tr.translated}${tr.warnings?.length ? "\n\n> " + tr.warnings.join("；") : ""}` : ""}`;
  });
  // Text selections keep exactly the selected text; translated selections retain
  // whole source blocks so a whole-block translation is never paired with a fragment.
  const fragment = input.text?.trim() && !input.translated && blocks.every(b => !["image", "table"].includes(b.type))
    ? `${blocks.length ? parts.map((_, i) => `[原文 p.${blocks[i].page}](#block:${blocks[i].id})`).join(" · ") : `原文 p.${Number(input.page) || 1}`}\n\n${input.text.trim()}`
    : parts.join("\n\n");
  const current = notesFor(task).markdown;
  return saveStudyNotes(task, { revision: input.revision, markdown: current + (current.trim() ? "\n\n---\n\n" : "") + fragment + "\n" });
}
