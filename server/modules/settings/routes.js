import fs from "node:fs";
import path from "node:path";
import { APP_ROOT, getConfig, saveConfig, redactedConfig } from "../../config.js";
import { listProjects } from "../../store.js";
import * as harness from "../../harness.js";
import { changePackage } from "../../pi-packages.js";
import { setupStatus, setupTest } from "../../setup-status.js";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { zoteroStatus } from "../library/metadata.js";

export function registerSettingsRoutes(api) {
  api.get("/health", (_req, res) => res.json({ ok: true, name: "PiPaper", time: new Date().toISOString() }));

  // ---- setup：环境自检（首次使用引导数据源） ----
  api.get("/setup/status", async (_req, res) => {
    try { res.json(await setupStatus()); }
    catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
  api.post("/setup/test/:id", async (req, res) => {
    try { res.json(await setupTest(req.params.id)); }
    catch (e) { res.status(e.status || 400).json({ error: String(e.message || e) }); }
  });

  // ---- config ----
  api.get("/config", (_req, res) => res.json({ config: redactedConfig(), zotero: zoteroStatus() }));
  api.put("/config", (req, res) => {
    try {
      const patch = req.body || {};
      // ignore masked secrets coming back
      const cur = getConfig();
      if (patch.parse?.mineru?.token?.includes("***")) patch.parse.mineru.token = cur.parse.mineru.token;
      if (patch.parse?.unstructured?.apiKey?.includes("***")) patch.parse.unstructured.apiKey = cur.parse.unstructured.apiKey;
      saveConfig(patch);
      res.json({ ok: true, config: redactedConfig(), zotero: zoteroStatus() });
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });


  // ---- resource manager: skills / extensions / packages / MCP ----
  // local plugin registry: skills/*/.codex-plugin/plugin.json
  function scanLocalPlugins() {
    const out = [];
    const skillsRoot = path.join(getAgentDir(), "skills");
    try {
      for (const d of fs.readdirSync(skillsRoot)) {
        const mf = path.join(skillsRoot, d, ".codex-plugin", "plugin.json");
        if (!fs.existsSync(mf)) continue;
        try {
          const j = JSON.parse(fs.readFileSync(mf, "utf8"));
          out.push({
            id: d,
            name: j.interface?.displayName || j.name || d,
            version: j.version || "",
            description: j.description || j.interface?.shortDescription || "",
            category: j.interface?.category || "",
            dir: path.join(skillsRoot, d),
            skillPath: path.join(skillsRoot, d, "skills"),
          });
        } catch {}
      }
    } catch {}
    return out;
  }

  api.get("/pi/resources", async (req, res) => {
    try {
      const out = { ...(await harness.resourceInfo(req.query.sessionId, req.query.projectId)), packages: [], mcp: [] };
      out.plugins = scanLocalPlugins();
      try {
        const settingsPath = path.join(getAgentDir(), "settings.json");
        if (fs.existsSync(settingsPath)) {
          out.packages = JSON.parse(fs.readFileSync(settingsPath, "utf8")).packages || [];
        }
      } catch {}
      // MCP: pi has no native MCP by design; scan common config files read-only
      const candidates = [
        path.join(process.env.USERPROFILE || "", ".claude", "claude_desktop_config.json"),
        path.join(process.env.USERPROFILE || "", ".codeium", "windsurf", "mcp_config.json"),
        path.join(APP_ROOT, ".mcp.json"),
      ];
      for (const f of candidates) {
        try {
          if (!fs.existsSync(f)) continue;
          const cfg = JSON.parse(fs.readFileSync(f, "utf8"));
          for (const [name, def] of Object.entries(cfg.mcpServers || {})) {
            out.mcp.push({ name, command: def.command || def.url || "", args: (def.args || []).slice(0, 4), config: f });
          }
        } catch {}
      }
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  api.get("/projects/resources/:id", (req, res) => {
    const p = listProjects().find((x) => x.id === req.params.id);
    res.json(p?.resources || {});
  });

  // Native package management; project installs are isolated from the tool cwd.
  for (const [endpoint, remove, globalOnly] of [["install", false, false], ["remove", true, false], ["remove-global", true, true]]) {
    api.post("/pi/packages/" + endpoint, async (req, res) => {
      try {
        const body = { ...req.body, remove, ...(globalOnly ? { scope: "global" } : {}) };
        const result = await changePackage(body);
        harness.refreshProjectResources(body.scope === "global" ? undefined : body.projectId);
        res.json(result);
      } catch (error) { res.status(400).json({ error: error.message }); }
    });
  }

  // ---- versioned Pi translation and guided paper studies ----

}
