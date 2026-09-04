import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { UserInputBroker, userInputTool } from "../../server/user-input.js";

// Exercise the real Pi runtime with a deterministic local model, no credentials/network.
export async function interactionSession(reply, extension) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pipaper-interaction-test-"));
  const model = { id: "local-test", name: "Local test", provider: "test", api: "openai-completions", baseUrl: "http://127.0.0.1:1", input: ["text"], reasoning: false, contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const runtime = {
    getModel: () => model,
    hasConfiguredAuth: () => true,
    isUsingOAuth: () => false,
    getAuth: async () => ({ apiKey: "test-only" }),
    streamSimple: (_model, context, options) => {
      let message;
      return {
        async *[Symbol.asyncIterator]() {
          const content = await reply(context, options);
          message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content, stopReason: content.some((c) => c.type === "toolCall") ? "toolUse" : "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          yield { type: "start", partial: message };
          for (const [contentIndex, part] of content.entries()) if (part.type === "text") yield { type: "text_delta", contentIndex, delta: part.text, partial: message };
          yield { type: "done", reason: message.stopReason, message };
        },
        result: async () => message,
      };
    },
  };
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: extension ? [extension] : [] });
  await loader.reload();
  const broker = new UserInputBroker();
  const { session } = await createAgentSession({ cwd: directory, agentDir: directory, model, modelRuntime: runtime, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(directory), noTools: "builtin", customTools: [userInputTool(broker)] });
  return {
    session, broker, model,
    async dispose() {
      const aborted = session.abort();
      broker.disconnect("aborted");
      await aborted;
      session.dispose();
      const resolved = path.resolve(directory);
      if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("pipaper-interaction-test-")) throw new Error("Invalid temporary test directory");
      fs.rmSync(resolved, { recursive: true, force: true });
    },
  };
}
