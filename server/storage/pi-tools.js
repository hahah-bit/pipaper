import fs from "node:fs/promises";
import path from "node:path";
import {
  createWriteToolDefinition,
  createEditToolDefinition,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { APP_ROOT, DATA_DIR, LIBRARY_DIR } from "../config.js";
import { resourceAt } from "./catalog.js";
import { writeFile, registerFile, infer } from "./files.js";
import { registerKnowledge } from "./migration.js";

const knowledgeRoot = path.resolve(
  process.env.PIPAPER_KNOWLEDGE_DIR || path.join(APP_ROOT, "knowledge"),
);
const within = (root, file) => {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return !rel.startsWith("..") && !path.isAbsolute(rel);
};
const sensitive = (file) =>
  within(path.join(DATA_DIR, "credentials"), file) ||
  path.resolve(file).toLowerCase() ===
    path.resolve(getAgentDir(), "auth.json").toLowerCase();

// Keep Pi's schemas, mutation queue, exact-edit behavior and tool receipts.
// Only file operations are adapted; files outside application roots stay references.
export function managedPiTools(context = {}) {
  const revisions = new Map();
  const managed = (file) =>
    !sensitive(file) &&
    [DATA_DIR, LIBRARY_DIR, knowledgeRoot].some((root) => within(root, file));
  const save = async (file, content, expectedRevision) => {
    if (!managed(file)) {
      await fs.writeFile(file, content, "utf8");
      if (!sensitive(file))
        registerFile(file, { kind: "external-workspace", owned: false });
      return;
    }
    const prior = resourceAt(file),
      note = within(knowledgeRoot, file) && /\.md$/i.test(file);
    const metadata = note
      ? {
          kind: "knowledge",
          sourceType: prior?.sourceType || "note",
          independent: true,
          owner: null,
          sourcePaperId: prior?.sourcePaperId || context.paperId || null,
        }
      : {
          owner:
            prior?.owner ||
            infer(file).owner ||
            (context.id ? "session:" + context.id : null),
        };
    writeFile(file, content, { ...metadata, expectedRevision });
    if (note) registerKnowledge(file);
  };
  const write = createWriteToolDefinition(APP_ROOT, {
    operations: {
      mkdir: async (dir) => {
        await fs.mkdir(dir, { recursive: true });
      },
      writeFile: (file, content) => save(file, content),
    },
  });
  const edit = createEditToolDefinition(APP_ROOT, {
    operations: {
      access: (file) => fs.access(file, fs.constants.R_OK | fs.constants.W_OK),
      readFile: async (file) => {
        if (managed(file)) {
          const current = registerFile(file);
          revisions.set(file, current.revision);
        }
        return fs.readFile(file);
      },
      writeFile: async (file, content) => {
        try {
          await save(file, content, revisions.get(file));
        } finally {
          revisions.delete(file);
        }
      },
    },
  });
  return [write, edit];
}
