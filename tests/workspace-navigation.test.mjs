import test from "node:test";
import assert from "node:assert/strict";
import {
  migrateWorkspace,
  moduleDestination,
} from "../src/workspaceNavigation.js";
import { storageSummary } from "../src/storageEvents.js";

const panel = (id, moduleId) => ({
  id,
  contentComponent: "module",
  params: { moduleId },
});
const leaf = (id, views, activeView = views[0]) => ({
  type: "leaf",
  size: 420,
  data: { id, views, activeView },
});
test("旧工作区保留活动功能和分栏尺寸，同类工具不会重复挂载", () => {
  const original = {
    activeGroup: "right",
    grid: {
      width: 900,
      height: 600,
      orientation: "HORIZONTAL",
      root: {
        type: "branch",
        data: [
          leaf("left", ["knowledge", "latex"]),
          leaf("right", ["search"], "search"),
        ],
      },
    },
    panels: {
      knowledge: panel("knowledge", "knowledge"),
      search: panel("search", "search"),
      latex: panel("latex", "latex"),
    },
  };
  const saved = JSON.stringify(original),
    migrated = migrateWorkspace(original);
  assert.equal(JSON.stringify(original), saved);
  assert.deepEqual(Object.keys(migrated.panels).sort(), ["latex", "search"]);
  assert.deepEqual(migrated.panels.search.params, {
    workspaceId: "discover",
    activeView: "search",
  });
  assert.equal(migrated.grid.root.data[0].size, 420);
  assert.deepEqual(migrated.grid.root.data[0].data.views, ["latex"]);
  assert.equal(migrated.activeGroup, "right");
  assert.deepEqual(migrateWorkspace(migrated), migrated);
});
test("浮动窗口中的活动图解保留表达方式，空组清除", () => {
  const source = {
    activeGroup: "float",
    panels: {
      mind: panel("mind", "mindmap"),
      arch: panel("arch", "archify"),
      note: panel("note", "note"),
    },
    grid: { root: { type: "branch", data: [leaf("main", ["mind", "note"])] } },
    floatingGroups: [
      {
        data: leaf("float", ["arch"]).data,
        position: { left: 5, top: 5, width: 450, height: 400 },
      },
    ],
  };
  const migrated = migrateWorkspace(source);
  assert.equal(migrated.panels.arch.params.diagramKind, "archify");
  assert.equal(migrated.panels.arch.params.activeView, "diagram");
  assert.deepEqual(migrated.grid.root, { type: "branch", data: [] });
  assert.equal(migrated.activeGroup, "float");
  assert.equal(migrated.floatingGroups[0].position.width, 450);
});
test("功能归属保持明确，设置资源不混入文件资料", () => {
  assert.deepEqual(moduleDestination("notesmgr"), {
    workspaceId: "library",
    activeView: "storage",
    libraryView: "notes",
  });
  assert.equal(moduleDestination("mdedit").workspaceId, "writing");
  assert.equal(moduleDestination("resources"), null);
});
test("资料提醒只采用每个资源的最新任务，不让历史失败一直报警", () => {
  const jobs = [
    { resourceId: "paper-a", status: "succeeded" },
    { resourceId: "paper-b", status: "running" },
    { resourceId: "paper-c", status: "blocked" },
    { resourceId: "paper-a", status: "failed" },
  ];
  assert.deepEqual(storageSummary(jobs, [{ id: "r1" }, { id: "r2" }]), {
    running: 1,
    failed: 1,
    reviews: 2,
  });
});
