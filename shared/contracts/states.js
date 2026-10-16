export const lifecycleStates = Object.freeze(["active", "trashed", "purging", "deleted"]);
export const availabilityStates = Object.freeze(["generating", "ready", "stale", "needs_review", "missing", "damaged"]);
export const jobStates = Object.freeze(["queued", "running", "paused", "blocked", "interrupted", "succeeded", "failed", "cancelled"]);
export const terminalJobStates = Object.freeze(["succeeded", "failed", "cancelled"]);
export const stateLabels = Object.freeze({
  active: "正常", trashed: "回收站", purging: "清理中", deleted: "已清理",
  generating: "生成中", ready: "可用", damaged: "损坏", missing: "缺失", stale: "过期", needs_review: "待核对",
  queued: "排队", running: "运行", paused: "暂停", blocked: "等待配置", interrupted: "中断",
  succeeded: "成功", failed: "失败", cancelled: "取消",
});
