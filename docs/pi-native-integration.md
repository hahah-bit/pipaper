# Pi 原生能力接入说明

实现基线：Pi SDK `0.84.4`。继续使用 SDK 嵌入方式，项目仍是论文分组，工具 cwd 始终为应用目录。

## 使用方式

1. 新建项目并选择论文。打开会话后建立持续事件连接；选择论文／项目时重新计算资源，运行中的绑定调整等待当前任务结束。
2. 在 🧩 资源页选择技能、增加扩展路径或安装包。「继承默认」沿用默认技能及按绑定加入的论文技能；「只启用勾选技能」精确指定候选列表，空列表代表全部关闭。资源页同时显示当前实际启用项和配置生效状态。
3. 输入 `/` 使用应用命令、原生扩展命令、提示模板和技能。重名扩展命令使用 SDK 分配的调用名。扩展的新建、切换、分支、树导航和重载会执行真实原生操作，取消保持原会话。
4. 回复期间 Enter 插队，Alt+Enter／Ctrl+Q 排队。「取回待发送消息」将尚未消费的消息恢复为草稿列表；点击草稿恢复输入框和附件，现有输入会另存为草稿。可设置逐条或合并处理；暂不支持服务端逐条删除、重排。
5. 「压缩」可填写需要保留的结论。压缩摘要显示在历史中，取消按钮停止压缩或树摘要；「停止」同时覆盖回复、用户提问等待、重试及摘要。统计区分别呈现上下文占用和累计用量，SDK 无法估计的上下文显示未知。
6. 「会话树」查看当前 JSONL 内的路径、定位节点、保存标签、带摘要切换路径。✎ 编辑重问创建新的分支会话，保留父会话。阅读器／视频在父任务执行期间提出的分支请求会记录原节点，并在父任务结束后创建。
7. 「工具」显示实际启用项及来源。仅内置读取工具选择 `read/grep/find/ls`，关闭其他内置、论文及扩展工具；这不提供文件系统沙箱。Windows 可勾选 `powershell`。默认只修改当前会话，勾选「同时保存为当前项目默认」才持久化。
8. 「导出 HTML／JSONL」下载原生导出结果。HTML 可离线阅读，JSONL 可由 Pi 打开。导出先写到应用临时目录，下载结束清理，不覆盖原会话。

## 资源及生命周期

- 每个会话独享 `DefaultResourceLoader`、扩展闭包、`ModelRuntime`、设置快照和交互代理；认证从原有磁盘配置读取。
- 项目包位于 `data/pi-projects/<projectId>` 对应的原生管理目录。包声明保存在应用项目资源记录中，解析后的绝对路径交给会话加载器。包入口不混入手动扩展路径列表。解绑去掉该包贡献的资源，保留独立路径。
- 项目资源有递增 `revision`，会话记录已生效版本和 `applied/pending/failed`。空闲已连接会话立即刷新，运行中等待结束，未连接会话在下一次打开时刷新。加载失败保留旧实例并显示原因；新版本保存或手动重载可重试。
- 替换使用 `AgentSessionRuntime`；加载失败导致原生旧实例被释放时，从公开运行时服务及原 SessionManager 恢复。不会访问私有字段或手写 JSONL。
- 同一会话只允许一个控制连接。额外页面收到占用提示；断开取消等待并停止当前执行。再次打开先恢复状态和历史，不自动重发原任务。
- 消息通过统一映射保留原生条目 ID、图片、完整工具结果、自定义消息、bash 历史及摘要。自定义消息遵守 `display`。网页不执行 TUI 专用渲染器；终端组件工厂明确报不支持。
- 轻量 UI 支持 `setStatus`、文本行数组 `setWidget`、`setWorkingMessage/setWorkingVisible`、`setTitle`、`setEditorText/getEditorText/pasteToEditor` 和常用提问小窗。
- 会话名称以原生名称为准；旧应用名称仅在原生名称缺失时写入。空会话遵循 SDK 延迟持久化语义，当前进程内仍可在列表中看到；尚未写入原生文件的空会话不会凭空在重启后恢复。

## 配置迁移

首次启动在写入前备份 `projects.json` 和 `sessions-index.json` 为相邻的 `.pre-pi-v2.bak` 文件，并写入 `pi-resources-v2.json` 版本标记。论文数据和原生会话文件保持原存储方式。

旧 `skillsEnabled: []` 迁移为继承默认；旧非空清单保留原基座选择与按绑定加入的论文技能。用户重新明确选择后，清单对全部候选技能生效。旧项目包的裸 npm 名称规范为 `npm:` 来源；旧托管目录中的自动扩展入口按包来源排除，后续使用独立项目包解析结果。

## HTTP 接口

已有业务入口保留，执行统一经过会话控制层。先打开事件通道，收到 `connected.controlId` 后，操作请求携带 `X-Pi-Control`。该值用于控制连接归属，沿用本机应用的访问方式。

| 接口 | 行为 |
|---|---|
| `GET /api/sessions/:id/events` | 持续 SSE，含启动交互、回复、资源刷新、摘要及状态 |
| `GET /api/sessions/:id/state` | 原生统计、模型／思考能力、队列、资源状态和 UI |
| `GET /api/sessions/:id` | 同一映射生成的完整历史和状态 |
| `POST /api/sessions/:id/prompt` | 返回接收结果及 operationId；结果由 SSE 传递 |
| `GET /api/pi/commands`、`GET /api/pi/resources` | 支持 sessionId；未打开会话时可按 projectId 预览 |
| `POST /api/sessions/:id/binding`、`/reload`、`/name` | 绑定、重载及原生命名 |
| `GET /api/sessions/:id/tree` | 原生节点树与当前叶节点 |
| `POST /api/sessions/:id/tree/navigate`、`/tree/label` | 路径切换和标签 |
| `POST /api/sessions/:id/fork`、`/compact` | 原生分支和压缩，返回操作 ID |
| `POST /api/sessions/:id/steer`、`/queue/take`、`/queue/mode` | 队列提交、全部取回和消费模式 |
| `POST /api/sessions/:id/tools`、`/abort` | 工具启停和操作取消 |
| `POST /api/sessions/:id/export` | format 为 html 或 jsonl，返回文件下载 |

每个事件带 `sessionId`、`operationId`（无所属操作时为 null）和连接内单调递增 `seq`。`session_replaced` 明确告知前端新旧会话 ID。客户端只有在替换事件后才接受新 ID；旧连接的数据和完成事件不会覆盖当前会话。

## 验证与维护

```bash
npm test
npm run build
node scripts/smoke-chat.mjs
```

自动测试使用真实 Pi SDK 和本地模型桩，无需在线模型。生产 HTTP 验收覆盖新建项目、论文绑定、扩展提问、带附件队列取回、重试、压缩、多资源包安装／解绑、技能禁用、分支、工具选择、两类导出和服务重启恢复。控制层测试补充隔离、启动弹窗断连、取消、事务式重载、替换加载失败恢复、重复文字和原生条目 ID。

`node scripts/native-smoke-server.mjs` 启动临时浏览器验收环境，默认端口 4320，使用独立临时数据和认证目录。浏览器验证过普通回复／公式、扩展命令及小窗、文本组件、输入回填、工具组合、树标签、原生新建后继续交互和取消。测试数据不会写入日常项目索引。

本轮未增加 MCP、子 Agent、后台执行、网页登录、跨 cwd 导入或完整终端组件。在线模型供应商及远程 npm/Git 网络状态不属于本地桩回归范围；包的来源、版本、过滤和安装语义由锁定 SDK 的原生包管理器负责。
