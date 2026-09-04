# Pi 原生能力接入审计

## 实施后的状态（2026-09-04）

四阶段接入已落地，详细操作与接口见 [Pi 原生接入说明](pi-native-integration.md)。下方「初始审计快照」保留实施前的证据，旧代码行号和缺口描述仅用于追溯。

| 阶段 | 交付结果 | 验证 |
|---|---|---|
| 会话和资源 | 每会话独立加载器／模型运行时；资源版本及失败保留；技能选择迁移；原生项目包管理；绑定变化重算 | 隔离、显式关闭、忙时更新、失败恢复、多资源包安装和解绑 |
| 扩展和消息 | 持续 SSE 单控制连接；完整 commandContextActions；真实会话替换；统一消息／图片／工具结果／摘要映射；轻量 UI | 启动小窗、断连释放、新建与取消、原生分支、完整消息历史和浏览器交互 |
| 状态和导出 | 原生统计、压缩／重试结束状态、动态思考档位、原生命名、诊断及 HTML/JSONL 下载 | SDK 本地模型重试、压缩取消和统计、文件下载、服务重启恢复 |
| 会话树和队列 | 节点导航／标签／摘要、父任务结束后分支、附件草稿取回、原生队列模式、工具启停与项目默认 | 重复消息附件、已消费消息不重取、树取消、标签持久化、下一轮实际工具清单 |

合并检索器优化后的全量回归：`npm test` **44 项通过，0 失败**。构建通过；浏览器验证了普通回复与公式、命令菜单、扩展选择小窗、状态组件、输入回填、读取工具选择、节点标签和原生新建后的后续交互，以及检索筛选恢复、待读清单与原生对话同时工作，控制台无 error/warn。回归采用真实 SDK、本地模型桩及临时项目数据，无在线模型调用。

保留范围：MCP、子 Agent、后台运行、网页登录、跨 cwd 导入和完整 TUI 组件没有加入本轮。原生 JSONL 没有批量改写，现有论文数据和用户在搜索模块中的修改保留。

## 初始审计快照（实施前）

审计日期：2026-09-04。基线：项目锁定并实际安装的 `@earendil-works/pi-coding-agent@0.84.4`。

结论：核心对话已经接通，下一阶段应先补会话与扩展适配的正确性，再补对论文阅读有直接价值的原生功能。最优先的是会话间扩展状态隔离、资源更新生效、扩展命令生命周期和消息内容保真。

本次检查了工作区当前代码、已安装 SDK 的类型与实现，并对照上游官方文档；运行了已有交互测试和两个不调用外部模型的最小复现。这里只记录审计结果，没有实施下列功能修改。

## 1. 已经接通的能力

| 原生能力 | 当前实现 | 判断 |
|---|---|---|
| 模型与认证 | `ModelRuntime.create()`，复用 Pi 全局模型与认证配置 | 已接；网页登录、模型刷新与诊断另有缺口 |
| 原生会话持久化与恢复 | `SessionManager.create/open/list`、Pi JSONL | 已接；项目/论文关联与标题另存于应用元数据 |
| 工具执行 | `createAgentSession()` 不设置工具白名单，追加论文工具 | 已接；初始内置工具由 Pi `defaultTools` 配置或默认值决定 |
| 文本、思考、工具执行流 | `subscribe()` → SSE → 对话区 | 已接主要事件；内容类型与状态事件尚不完整 |
| 图片输入 | 提问与队列消息传入原生 `ImageContent` | 已接；历史显示与工具图片输出不完整 |
| 插队与排队 | `session.steer()`、`session.followUp()`、`queue_update` | 已接，有真实 SDK 测试；缺少队列取回与模式设置入口 |
| 用户交互 | 扩展 `confirm/select/input/editor/notify` 的 Web 桥接 | 已接，有真实 SDK 测试；`request_user_input` 是本项目增加的工具 |
| 技能、提示模板、扩展加载 | `DefaultResourceLoader`，会话 `prompt()` 原生展开 | 已接加载机制；资源作用域、缓存和命令展示仍有问题 |
| AGENTS.md 上下文 | 保留加载器原生 context files 发现 | 已沿用；所有应用项目共用 `APP_ROOT`，不等于每个项目都有独立文件工作区 |
| 自动压缩、自动重试 | 沿用 SDK/SettingsManager 策略 | 底层已接；网页缺完整状态与控制 |
| 手动压缩 | `/compact` → `session.compact()` | 已接；没有压缩指令输入、取消、摘要检查等完整交互 |
| 编辑重问与新分支 | `SessionManager.createBranchedSession()` | 部分接入；目前是新 JSONL 分支文件，不是完整的原生会话内树导航 |

主要证据：[harness.js](../server/harness.js)、[user-input.js](../server/user-input.js)、[chat.js](../src/chat.js)、[interaction-sdk.test.mjs](../tests/interaction-sdk.test.mjs)。

## 2. 应先修复的接入缺口

### P0：同一加载器下的扩展操作会串到其他会话

位置：`server/harness.js:190` 的 `projectLoaders/loaderKey()`、`:481` 的 `makeSessionOpts()`。

当前多个会话可能拿到同一个 `sharedLoader` 或同一个项目加载器。该对象持有的扩展结果包含可变 `runtime`；SDK 创建会话时会将扩展的 `sendMessage`、`setSessionName`、`setActiveTools` 等操作绑定到该会话。后创建的会话会覆盖这个共享绑定。

**已用实际安装的 SDK 复现**：创建 A、B 两个会话，共用一个加载器；在 A 执行扩展命令 `pi.setSessionName('audit-from-first')`，结果 A 名称未变、B 被改名。该验证没有外部模型调用。

建议：每个会话拥有独立加载器及扩展实例；共享认证、资源路径索引等不绑定具体会话的数据。不能仅靠禁止同时回复解决，因为顺序创建会话也能复现。

验收：A、B 的扩展消息、名称、工具开关和扩展局部状态互不串用；打开历史会话或新建分支也保持隔离。

### P0：资源保存、安装、解绑未形成生效闭环

位置：`server/harness.js:191`、`server/index.js:431`、`:586`、`src/resources.js:54`、`:69`、`:207` 附近。

- 项目资源更新仅保存数据，没有让缓存失效，也没有重载已存在会话；相同缓存键下的新会话同样可能使用旧配置。
- 项目加载器的 `loader.reload?.()` 未等待完成，存在首轮使用尚未加载完整资源的时序风险。
- 从普通会话切换为绑定论文或其他项目时，发送接口更新元数据，但不重新计算加载器与 gated skills；页面选择和会话实际资源可能不一致。
- `skillsEnabled: []` 同时被用作“全部启用”的默认状态，因此无法表达“全部关闭”。从默认全选取消一个技能时，处理器从空集合开始删，仍得到空集合；多次操作还使用旧闭包里的列表。
- 项目包“移除”只删 `resources.packages`，没有移除之前加入 `resources.extensions` 的入口。

建议：建立统一的会话资源刷新操作，按配置版本识别变化；在会话空闲时完成重载，忙时明确显示待生效。技能选择区分“继承默认”与“显式列表”。以包来源记录入口归属，解绑时一并更新实际加载资源。先完成会话隔离，再接热重载。

验收：安装、禁用、全部关闭、解绑、绑定论文后，展示的资源与该会话实际技能/工具/命令一致。

### P1：扩展命令可以执行，但部分宿主动作是假成功

位置：`server/harness.js:92`、`:835`、`src/chat.js:1036`。

- 命令菜单只读取共享加载器的 prompts/skills，没有列出扩展 `registerCommand()` 命令，也没有展示会话专属的 gated/project 资源。
- 用户手动输入扩展命令，空闲时确实会由 `session.prompt()` 原生执行，不能算完全未接。
- `bindExtensions()` 未传 `commandContextActions`。当前 SDK 的缺省 `ctx.newSession/fork/switchSession/navigateTree/reload` 为无操作实现。
- **实际 SDK 复现**：扩展执行 `ctx.newSession()` 返回 `{ cancelled: false }`，会话 ID 却没有改变。
- 运行中所有文字都走 `steer/followUp`；SDK 队列接口拒绝扩展命令，因此失去了原生 `prompt()` 可即时分发扩展命令的能力。

建议：绑定完整的命令上下文动作；基于当前会话合并扩展命令、技能和模板，显示描述及来源。会话替换优先采用本版已有的 `AgentSessionRuntime`，同步更新应用会话映射、UI broker、SSE 订阅和项目/论文元数据。命令分发与普通排队文字区分处理。

验收：命令发起的切换/分支/重载真实生效；返回取消与真实取消一致；新会话收到后续事件和问题弹窗。

### P1：原生消息在网页丢失图片和扩展内容

位置：`server/harness.js:566`、`:796`，`src/chat.js:101`。

- 历史仅映射 `user/assistant/toolResult`；扩展 custom message、bash execution、compaction summary、branch summary 等原生消息未显示。
- 工具结束事件只传 600 字预览，工具图片转换成 `[image]`；历史工具图片变成 `[图片]`。
- 用户历史图片虽然由后端返回，前端只显示“截图 ×N”。
- 当前就有 `get_paper_pages` 返回图片，模型可以看到，用户却无法在工具结果中查看同一张图；刷新后用户截图也无法直接查看。

建议：保留内容块类型、原生 entry ID、图片和必要 details；先做通用文本/图片/结构化结果展示，再按需增加专用 Web 卡片。扩展 custom message 应遵守原生 `display` 标记；TUI 专用渲染函数不应直接在网页执行。

验收：实时和重新打开历史后的内容一致；用户可核对模型实际看到的论文页；声明不展示的消息仍保持隐藏。

### P1：项目包只接了扩展入口，未完整复用 Pi 包机制

位置：`server/index.js:558` 的 `resolvePiEntries()` 与 `:586` 的项目安装流程。

- 全局路径使用 `pi install/remove`；项目路径使用另一套 npm 安装和入口扫描。
- 项目只扫描 `pi.extensions`，没有加载同包中的 skills/prompts，也未完整支持原生 manifest glob/过滤规则；纯技能或模板包会被判成没有入口。
- 项目路径使用包含版本后缀的 `npmName` 拼接包目录；指定 `foo@1.2.3` 或 `@scope/foo@1.2.3` 时，与实际 npm 目录不一致。
- 原生 `settings.packages` 允许对象条目；当前全局列表/移除逻辑主要按字符串处理。

建议：复用本版导出的 `DefaultPackageManager` 解析与来源信息；项目实际作用域适配在应用层完成。Pi 的原生“项目”以 cwd 为边界，本应用项目是数据库分组，直接在同一个 `APP_ROOT` 执行 `pi install -l` 不能自动得到多个项目的独立配置。

验收：同包的扩展、技能、模板均可正确发现；固定版本、带 scope 包、资源过滤及解绑都能按实际来源工作。

## 3. 值得补上的原生能力

相对成本仅按当前架构判断，不是工时承诺。

| 优先级 | 能力及原生接口 | 现状 | 论文工作台收益 | 相对成本 |
|---|---|---|---|---|
| P1 | 上下文与会话统计：`getContextUsage/getSessionStats` | 仅映射部分单条 usage，流中的 `usage` 分支也未利用 | 看上下文占用、累计 token/cache/费用，知道何时需要压缩 | 低 |
| P1 | 完整压缩与重试状态：`compaction_end/auto_retry_end`、取消接口 | 只有开始提示；重试开始误读 `event.error`，本版字段是 `errorMessage` | 分清处理中、重试等待、压缩失败与完成，避免误判卡死 | 低到中 |
| P1 | 工具与资源诊断：`getAllTools/getActiveToolNames`、loader diagnostics | 资源页不是会话实时视图；加载错误、模型回退信息未完整展示 | 确认某个搜索工具/技能是否真正可用，以及为什么未加载 | 低到中 |
| P1 | 模型能力驱动的思考档位：`getAvailableThinkingLevels` | 页面固定 off/low/medium/high | 可用模型支持的 minimal/xhigh/max 等档位；切换后显示实际值 | 低 |
| P1 | 原生命名：`setSessionName`、`session_info_changed` | 名称主要存在应用元数据，列表不优先使用原生名称 | Pi CLI 与网页命名同步，扩展自动命名可见 | 低 |
| P1 | HTML/JSONL 导出：`exportToHtml/exportToJsonl` | 无入口 | 保存阅读记录、离线查看、备份或转到 Pi 继续阅读 | 低到中 |
| P1 | 原生会话树：`getTree/navigateTree/appendLabelChange` | 只有分支文件层级和编辑重问 | 同一论文探索多个假设、给关键结论加标签、带摘要切回其他路径 | 中到高 |
| P1 | 扩展轻量 UI：`setStatus/setWidget/setEditorText/setTitle` | 弹窗之外多为 SDK no-op | 插件可显示进度、状态与文本组件，填入待编辑提示词 | 中 |
| P2 | 队列取回和处理模式：`clearQueue`、队列 getter、mode setter | 能发与显示，不能取回；模式沿用设置 | 提交了多项阅读问题后，可以撤回修改 | 低到中 |
| P2 | 工具启停与内置工具选择：`setActiveToolsByName`、`defaultTools` | 沿用 SDK/配置，无可见管理 | 提供“阅读”“复现”等工具组合；Windows 可选原生 powershell | 中 |
| P2 | 原生提示词文件兼容：`SYSTEM.md/APPEND_SYSTEM.md` | `systemPromptOverride` 固定替换，append override 返回空数组 | 用户的 Pi 自定义提示词可按明确规则与论文指令组合 | 低到中 |
| P2 | 登录/登出、模型刷新：`ModelRuntime.login/logout/refresh` | 使用已有认证，无 Web 管理 | 给不熟悉 CLI 的用户降低配置成本；当前个人环境已有认证，优先级较低 | 中 |
| P2 | 跨 cwd 会话导入与恢复：`AgentSessionRuntime.importFromJsonl/switchSession` | 会话列表仅查 APP_ROOT | 导入其他 Pi 工作区的研究记录并正确重建工作目录资源 | 中 |
| P3 | 用户直接执行 `!`/`!!`：`executeBash/abortBash` | 已有模型 bash 工具，未接用户 shell 输入 | 复现实验时有用，单纯论文阅读收益有限 | 中 |

补充边界：

- 上下文占用应使用原生当前上下文估计，不能拿会话累计 token 当占用；压缩后估计暂不可用时应显示未知。
- SDK 只有清空队列的现成接口；逐条删除/编辑需要应用层额外队列管理，不能当作直接映射原生功能。当前 `clearQueue()` 返回文本，若做附件取回还需保存原始附件。
- `powershell/grep/find/ls` 已属于该版本内置工具注册表，是否初始启用取决于 `defaultTools`。本次未检查用户私有设置，不能断言它们在实际环境中都未启用。
- 将工具限制为只读组合不构成沙箱，扩展工具仍需按自身行为判断。
- 当前分支实现还直接访问 SDK 的 `fileEntries/sessionFile` 内部字段；恢复与分支改造应收敛到公开 API，并保留原生扩展的 before/after 生命周期和取消语义。

## 4. 暂不建议投入的范围

| 范围 | 判断 |
|---|---|
| 完整搬运 TUI、自定义终端组件、终端输入与布局 | 网页已有专用阅读器。接文本状态和常用 UI 方法即可，完整终端兼容成本高 |
| 原生终端主题/编辑器/快捷键完全一致 | 项目已有 Web 主题与输入交互，收益不如内容保真和状态同步 |
| MCP、子 Agent、后台 bash | Pi 官方并不将其作为内置能力提供，需要扩展/包或宿主实现，应单列需求，不计入“漏接原生接口” |
| 自动重连后继续后台运行 | 当前断开连接就停止，是宿主执行生命周期设计。若未来确有需要，应专门设计任务持久化与重订阅，不是增加一个 SDK 按钮即可 |
| 整体改用 RPC/另起 Pi 进程 | 当前 SDK 路线适合已有 Node 项目，先修宿主适配即可；RPC 可作协议参照，无须为了接通能力全面重写 |

MCP 若有明确外部服务需求值得另做；本项目已经有论文搜索、下载和 Zotero 工具，先验证现有工具是否能满足工作流，再决定桥接范围。子 Agent 适合后续多篇文献并行任务，但依赖先完成会话隔离。

## 5. 建议实施顺序

1. **会话与资源正确性**：每会话独立加载器、等待加载完成、资源变更生效、项目/论文绑定一致性、技能选择与包解绑修复。
2. **扩展真正可用**：命令发现、commandContextActions、会话替换生命周期、custom message/图片内容保真、轻量状态和编辑器桥接。
3. **低成本高频功能**：上下文/费用统计、压缩与重试完整状态、动态思考档位、名称同步、HTML/JSONL 导出。
4. **研究路径管理**：会话内树导航、标签与分支摘要、队列取回、工具组合。
5. **按具体需求扩展**：网页登录、跨工作区导入、MCP、子 Agent、后台任务。

每一阶段都应以“实际会话状态、原生 JSONL 和网页显示一致”为验收标准，不以菜单里是否出现一个按钮为标准。

## 6. 验证记录与依据

已有测试：

```text
node --test tests/interaction-sdk.test.mjs tests/user-input.test.mjs
9 tests, 9 passed, 0 failed
```

额外最小复现复用了 `tests/helpers/interaction-session.mjs` 的真实 SDK 与本地模型桩，只在临时内存会话操作：

```json
{"check":"unbound command context","result":{"cancelled":false},"sessionChanged":false}
{"check":"shared loader cross-session extension state","firstName":null,"secondName":"audit-from-first"}
```

资源缓存、包接线、内容映射等问题依据代码静态检查；本次没有实际安装/删除包，没有登录账号，没有验证真实提供方调用，也没有进行浏览器端全量回归。工作区原有未提交修改已保留。

版本内接口依据：

- `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts`
- `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session-runtime.d.ts`
- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js`
- `node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.d.ts`
- `node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.d.ts`
- 包内 `docs/sdk.md`、`docs/rpc.md`、`docs/packages.md`、`docs/settings.md`

在线交叉核对：[官方 SDK 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)、[官方功能边界说明](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#philosophy)。在线 main 会变化，本报告实施判断以实际安装的 0.84.4 为准。
