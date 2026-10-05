import fs from "node:fs";
import path from "node:path";
import { readJsonState, writeJsonState, registerFile } from "../../storage/files.js";
import { fault } from "../errors.js";

// SQLite is authoritative; JSON and resource metadata are compatibility
// projections. A domain supplies identity and state policy, not another writer.
export function createTaskRepository({ directoryFor, kind, missingMessage }) {
  return {
    read(id) {
      const file = path.join(directoryFor(id), "task.json");
      if (!fs.existsSync(file)) throw fault(missingMessage, 404);
      const value = readJsonState(file, null);
      if (!value) throw fault(missingMessage, 404);
      return value;
    },
    save(task) {
      task.revision = (task.revision || 0) + 1;
      task.updatedAt = new Date().toISOString();
      const directory = directoryFor(task.id);
      writeJsonState(path.join(directory, "task.json"), task);
      registerFile(directory, { id: kind + ":" + task.id, kind, title: task.title, metadata: task });
      return task;
    },
  };
}
