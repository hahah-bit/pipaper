import { fault } from "../errors.js";

const registries = new Set();

// Process-local execution ownership. Durable job records and domain checkpoints
// remain in their repositories; releasing an old run cannot evict its successor.
export class ExecutionRegistry {
  #entries = new Map();
  constructor(name) { this.name = name; registries.add(this); }
  claim(key, { controller = new AbortController(), ...metadata } = {}) {
    if (this.#entries.has(key)) throw fault("同类操作正在运行", 409);
    const entry = { ...metadata, controller, startedAt: Date.now() };
    this.#entries.set(key, entry);
    return entry;
  }
  has(key) { return this.#entries.has(key); }
  get(key) { return this.#entries.get(key); }
  values() { return this.#entries.values(); }
  release(key, entry) {
    if (this.#entries.get(key) !== entry) return false;
    return this.#entries.delete(key);
  }
  abort(key, reason) { this.get(key)?.controller.abort(reason); }
  abortAll(reason) { for (const entry of this.values()) entry.controller.abort(reason); }
  dispose() { this.abortAll(); registries.delete(this); }
}

export function abortExecutions(reason = new Error("服务正在退出，任务可在重启后恢复")) {
  for (const registry of registries) registry.abortAll(reason);
}
