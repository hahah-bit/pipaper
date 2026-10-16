// Isolated UI acceptance environment. Every displayed paper/journal is labelled TEST.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { topicFixtureData, topicProfile } from "../tests/helpers/topic-fixture.mjs";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pipaper-topic-preview-"));
process.env.PIPAPER_DATA_DIR = path.join(temp, "data"); process.env.PIPAPER_LIBRARY_DIR = path.join(temp, "library");
const { registerTopicRoutes } = await import("../server/topics/routes.js");
const store = await import("../server/topics/store.js");
const { analyze } = await import("../server/topics/pipeline.js");
const data = topicFixtureData(), profile = store.saveProfile(topicProfile);
const task = store.create({ mode: "topic", profileId: profile.id, title: "测试示例 · 工业异常检测选题" });
await analyze(task.id, data);
const app = express(), api = express.Router(); app.use(express.json()); registerTopicRoutes(api, data); app.use("/api", api);
const pub = path.resolve("public"); app.use(express.static(pub)); app.get(["/topics", "/topics/:id"], (_req, res) => res.sendFile(path.join(pub, "topics.html")));
const server = app.listen(Number(process.env.TOPIC_PREVIEW_PORT || 4327), "127.0.0.1", () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/topics/${task.id}`, temp })));
const close = () => { server.closeAllConnections(); server.close(() => { fs.rmSync(temp, { recursive: true, force: true }); process.exit(0); }); };
process.on("SIGINT", close); process.on("SIGTERM", close);
