# PiPaper · 论文精读工作台

以 [pi agent](https://github.com/badlogic/pi-mono)（`@earendil-works/pi-coding-agent`）为内核的论文精读工作台：文献库、解析阅读器、AI 对话、知识库与写作工具装进一个本地 Web 应用。

完全复用 pi 的会话管理与模型认证（`~/.pi/agent` 下的 `auth.json`、`models.json`、JSONL 会话）：**pi 里能用什么模型，这里就能用什么模型**——不引入额外账号体系，也不需要在应用里填模型密钥；会话文件与 pi TUI 互通，两边可无缝接力。

## 一次精读的工作流

```
导入 PDF / 同步 Zotero → 解析（MinerU 精排）→ 阅读器 + AI 对话
    → 一键生成 粗读笔记 / 思维导图 / 流程图
    → 图表分析（逐图逐表解读 + 复现大纲）
    → LaTeX·MD 编辑器整理知识库 → Dock 工作区组合输出
```

常用工作区在右侧 Dock 中；需要循序研读时，点击侧边栏「读论文」。

资源、版本、任务和回收站现在统一由 SQLite 清单管理。文献卡片「解析并入库」启动多模态清洗、标题分块、背景／问题扩写与 Milvus 入库；Dock 的「存储管理」控制任务与核对证据，「知识库检索」召回原文并还原图表公式。Embedding 使用独立的服务端百炼凭据，视觉与扩写沿用 Pi 认证。部署、迁移、API 和验证方法见 [统一存储与多模态知识库](docs/storage-rag.md)。

## 核心特性

### 🧭 Dock 工作区（功能导航中枢）

右侧一条 **macOS Dock 式图标栏**，全部功能按大分类分组（图表·知识库 / 创作·产出 / 检索·媒体 / 系统），悬浮放大并显示名称。点击图标在右侧打开**可拖动工作区**：

- 工作区由 [dockview](https://dockview.dev/) 驱动——每个功能是一个面板，**拖标签即可分栏、重排、组合**，布局自动保存、下次原样恢复
- **再点一次同一图标 = 收起该面板**；全部面板关闭自动回到默认的阅读器视图
- 侧栏 / 对话 / 阅读器折叠后保留 44px 窄条（图标 + 展开按钮），随时点回
- ⚙ 设置 → 界面字号：紧凑 / 标准 / 大 / 特大 四档，阅读正文 15~19.5px 同步缩放

### 📖 阅读器

- **两层解析管线**：MinerU（云端 API / 本地 CLI，公式表格精排）→ unstructured（云端 API / 本地 Docker）→ pdf.js 兜底（零配置，图注定位自动裁图）。中间态为带页码 + 坐标的 blocks.json v2，图表公式按原位置插回正文
- **双视图**：解析视图（KaTeX 公式、表格、图片原样排版，MinerU 表格自动补全外框与公式空格）与 pdf.js 原文（文字划选 + ⬚ 框选截图）；悬停任意块可「＋对话」
- 解析版本管理：预览 / 对比 / 采用 / 本地重建，质量报告标注待核对块
- 段落精确翻译与整篇双语：使用当前 Pi 模型，按原始解析块翻译、缓存，并检查公式、数值和表格结构；可暂停、继续和重试。

### 🎓 独立论文研读

- `/study/:taskId` 独立三栏页面：论文原文、研读引导、自由提问。默认宽度为 40%／32%／28%，支持调整、折叠和窄屏切换。
- 从文献库选择或上传一个 PDF，选择理解／复现／创新目标。同一论文可以创建多个独立任务，顶部可搜索、切换、入库或删除。
- 后端依次控制粗读 → 精读（引言与相关工作／方法／实验）→ 总结。逐段覆盖、带出处讲解、理解考查及补讲均持久化；答题未通过不能推进。粗读完成后，可自主选择继续精读或结束。
- 两侧使用独立 Pi 会话、模型和控制通道。自由提问获得论文及已确认成果，不改变引导进度。刷新、切换或重启后恢复已保存内容。
- 外部论文先进入暂存区。「注入知识库」纳管 PDF，并在「论文研读」分类保存该任务的成果、两侧对话、译文和实际附件快照。重复入库更新该任务的快照，其他任务的成果不受影响。
- 「删除」清理所属会话 JSONL、任务记录和独占暂存资源；已经入库的快照、原有文献和其他任务引用的解析缓存保留。失败会列出清理项，可重试。
- 方法阶段通过 Pi 的 `image_generate` 生成架构图和训练／验证／测试图。页面「生图设置」提供 `npm:@abhishek944/pi-image-gen@0.4.2` 安装、重新加载、配置与生成验证入口。服务路由、模型和凭证遵循该扩展的配置；未安装或生成失败时保留待生成步骤。
- 总结按论文缺口使用现有学术检索源查询真实论文链接，并设计复现、消融、破坏性实验。创新目标增加 baseline 改进计划；不会自动运行训练。

研读任务保存在 `data/studies/`，暂存 PDF 在 `data/study-papers/`，入库快照在 `knowledge/论文研读/`。解析版本固定到任务，主动切换版本会重置需要重新核对的检查点和译文。

验证方式：`npm test`、`npm run build`。`node scripts/study-smoke-server.mjs` 启动与个人数据隔离的浏览器验收环境；`node scripts/study-real-smoke.mjs --paper <已管理论文ID>` 可使用现有 Pi 配置验证真实论文讲解和翻译（会调用模型，测试数据自动清理）。真实图片生成需先完成生图服务配置。

### ◎ 一次选题与方向分析

- 文献栏「选题分析」进入 `/topics`；在当前标签页切换到 `/topics/:id`。独立三栏为分析报告、OpenAlex / arXiv 检索、选题方向对话，支持拖动或键盘调整栏宽，窄屏切换栏目。此版本只实现首次选题，暂不包含基于既有论文与技术栈的二次选题。
- 调查卡支持增删改，一次选题固定使用一张画像快照：硬件描述和卡数/单卡显存、研究范围、预计月份及实验结束/论文写完/完成投稿三档目标，并补充公开数据要求、编程阅读基础、每周投入、研究方式。方向分析不绑定画像；“分析细分方向”仅保存在本次任务。
- 分析先规划精准检索，再检索近期与高被引论文、跟踪引用关系、读取论文与代码中的数据/硬件证据，输出至少三个候选问题、大课题故事线、小论文切口、挑刺与验证路线。主 Baseline 和两个对照均限制在滚动近三年；有引用关系和原文明示改进的后续工作进入折叠胶囊。公开论文不能替代公开数据证明，硬件证据必须属于主 Baseline。
- 期刊阶段目标为12本期刊并兼顾会议：按检索表达式获取发文量、年度趋势、关键词和摘要；每刊展示可解释匹配分、折线图、雷达图、偏好及来源。关键词使用每个完整年度的前200项聚合，缺失年度不填零；当前年度另列。中科院分区只接受官方分区来源，CCF会议等级独立核验，SJR不冒充中科院分区。首次决定、外审、至录用周期分别标注；未核实的数据留空。
- 政策使用当前五年规划、最近两年的基金指南和相关官方指南公告。内置2026—2030规划及2025/2026指南入口；后续年份缺少入口时明确提示，可在「＋ 来源」补充官方原文。部分基金网页是图片或登录受限页面，无法读到可核验文字时不生成对应政策结论。
- 所有任务数据归属于 `data/topic-analysis/tasks/topic_<UUID>/`：画像快照、对话、记忆、运行状态在 `task.json`，检索、原文、模型分析记录和报告在 `files/`。画像库在 `data/topic-analysis/profiles.json`。浏览器可查看、下载和删除历史资料；删除资料同时清理依赖报告及对话，删除任务先取消全部操作，再删除整个任务目录。物理删除失败保留状态以便重试；重启将未完成操作标记为中断。
- 三个方向或10本期刊的证据不足时保留真实候选与缺口，不通过放宽过滤或补造数字凑数。模型沿用 Pi 配置，可按任务选择；可选 `OPENALEX_API_KEY` 或 `topicAnalysis.openalexApiKey` 提高检索额度。API文档：[OpenAlex](https://help.openalex.org/api/)、[arXiv](https://info.arxiv.org/help/api/user-manual.html)。

验证：`npm test`、`npm run build`；`node scripts/topic-smoke-server.mjs` 启动隔离的浏览器验收环境（所有论文与期刊均明确标为测试示例）；`node scripts/topic-real-smoke.mjs` 检查真实检索与聚合；`node scripts/topic-model-smoke.mjs` 用公开论文和当前Pi模型检查结构化输出，会调用模型，不创建个人画像或持久化任务。

### 💬 对话（原生 pi 能力）

- 原生 JSONL 会话：树状分支 / compaction / 自动重试，按项目分组；**多页面 / 多窗口打开同一会话时自动接管**（后连的页面成为操作端，原页面一键「重新连接」抢回，进行中的任务不中断）
- 交互提问：Agent 发起的确认、选择、文本提问显示为网页小窗（Pi 扩展 `ctx.ui.*`）
- 排队 / 插队、压缩、取消、重试、HTML / JSONL 导出；上下文占用、Token 与费用实时显示
- `@` 文件引用：论文解析全文、插图、工作区文件一键入上下文
- 论文域工具：`read_paper`（outline / section / search / full）、`list_library`、`search_library`、`get_paper_pages`（渲染论文页给视觉模型）

### 📚 知识沉淀

- **一键生成**：粗读解析、精读笔记、markmap 思维导图、mermaid 流程图 / 算法迭代图——生成走临时 pi 会话，过程实时可见，完成自动清理
- **图表分析三模块**：🖼 图解析（每张图原图在上、AI 逐图解读直接跟在图下方）、📊 表解析（原表在上、逐表解读在下）、🗺 复现大纲（mermaid 实验流水线 + 改进定位表）。生成文档的骨架按「图N / 表N」小节固化，渲染时自动挂到对应原图原表之下
- **LaTeX·MD 编辑器**：知识库 Markdown 分屏编辑（源码 + KaTeX 实时预览，与阅读器同一渲染管道）；「🤖 AI」展开模型辅助改稿——整篇或选中段落下发指令（润色 / 中译英 / LaTeX 纠错），行级 diff 确认后应用
- **LaTeX 编辑器**：`.tex` 工作区文件树 + 源码编辑 + pdflatex 编译 + PDF 预览
- 知识库按论文分目录（粗读 / 精读 / 图表分析三库），笔记管理支持预览与递归删除

### ◈ Archify 图解

- 右侧 Dock →「Archify 图解」，输入需求并选择架构／流程／时序／数据流／状态图；复用当前 Pi 对话和模型，思考与工具调用仍显示在对话中。
- 对话也可直接请求「用 Archify 画这篇论文的方法架构」。原生 `archify` 工具按需读取上游 schema 和示例，并通过 CLI 的 `deliver --quality showcase --json` 校验生成；失败返回诊断，不发布失败候选。
- 面板支持预览、独立打开、下载 HTML／JSON 源／校验记录、继续修改；修改保存为新版本。普通图解保存在 `data/archify/`，研读自由对话生成的图归属任务附件，入库时连同源文件与回执复制，删除任务后保留入库快照。
- 最小接入：复用 [Archify 官方仓库](https://github.com/tt-a1i/archify)，不复制渲染器、不增加 npm 依赖或模型服务。在面板「连接设置」填写已有仓库或其 `archify/` 技能目录，也可通过 `PIPAPER_ARCHIFY_DIR` 指定；环境变量优先。未配置时检测 `~/.agents/skills/archify` 与 `~/.pi/agent/skills/archify`。需要 Node.js 22.13+（与本应用相同）。
- `npm test` 覆盖原生工具调用、失败诊断、文件下载、重启和研读附件生命周期。设置 `PIPAPER_TEST_ARCHIFY_DIR` 后运行 `node --test tests/archify-http.test.mjs` 可用真实上游 CLI 验证接入。

### 🔍 文献管理

- 文献栏固定为 280px，可折叠；论文卡片默认显示两行标题，悬浮或键盘聚焦时放大并展开完整标题。笔记、资源和设置统一从右侧 Dock 打开。
- **Zotero 7 集成**：读取 `zotero.sqlite` 快照（自动探测数据目录，Zotero 开着也能同步），分类树 + 搜索，PDF 附件直读
- **学术检索**：多源聚合（OpenAlex / arXiv / Semantic Scholar / 学术镜像…），ReadScore 综合推荐排序，年份 / 分区 / 开放全文筛选会记忆；「＋待读」存元数据，「＋项目」下载开放 PDF 并导入

### 🎬 更多

- 视频：本地 / 链接播放，等间隔关键帧 AI 解析成时间轴 + 思维导图，截帧问 AI
- 框选批注：提示词模板（`{{选区}}` / `{{批注}}` 占位符可编辑）+ 批注输入直达模型
- 剪贴板面板：自动收集应用内复制与划选
- 6 套主题配色（默认 / Nord / GitHub Dark / Gruvbox / 纸白 / Solarized Light）
- 环境自检：首启自动检查依赖，逐项给出就绪状态与安装指引

## 界面布局

```
┌─────────┬────────────────────┬──────────────────────────┬─────────┬────┐
│ 文献库   │ 对话                │ 阅读器（默认视图）          │ 工作区   │Dock│
│ Zotero  │ pi 会话/模型/排队    │ 解析视图 ｜ PDF 原文        │ (抽屉，  │ 📖 │
│ 分类导入 │ 上下文 chips + 输入  │ 公式/表格/图片原样排版      │  可分栏) │ 📊 │
└─────────┴────────────────────┴──────────────────────────┴─────────┴────┘
```

Dock 图标一览：📖 阅读器（默认）· 📊 图表分析 · 📝 粗读解析 · 🧠 思维导图 · 🗺 流程图 · ✍️ LaTeX·MD 编辑 · 📄 LaTeX 编辑 · 📦 产出物 · 🔍 论文检索 · 🎬 视频解析 · 🗂 笔记管理 · 🧩 资源管理 · 🩺 环境检查 · ⚙ 设置

## 快速开始

前置：[Node.js](https://nodejs.org/) ≥ 22.13（用到内置 `node:sqlite`），pi CLI 登录一次：

```bash
npm install -g @earendil-works/pi-coding-agent   # 安装 pi CLI
pi                                               # 首次运行按提示登录模型
```

拉取并启动：

```bash
git clone https://github.com/hahah-bit/pipaper.git && cd piagent_ui_reading
npm ci
npm start        # 自动构建前端并启动（等价 npm run dev）
```

打开 **http://127.0.0.1:4318**（端口见 `data/config.json` 或环境变量 `PORT`）。首次进入自动弹出环境检查，缺什么给什么链接；之后在 ⚙ 设置 → 「环境检查」随时打开。

## 可选组件

| 组件 | 用途 | 获取方式 |
|---|---|---|
| Docker sidecar（可选） | unstructured 本地解析（:8000），`docker compose up -d unstructured`；精确翻译使用 Pi 模型 | [Docker Desktop](https://www.docker.com/products/docker-desktop/) |
| [Zotero 7](https://www.zotero.org/download/) | 文献库同步（自动探测数据目录） | https://www.zotero.org/download/ |
| [MinerU CLI](https://github.com/opendatalab/MinerU) | 公式 / 表格精排（本地模式），`pip install "mineru[core]"`；不装也可用云端 API | https://github.com/opendatalab/MinerU |
| MinerU token | 云端解析 API（⚙ 设置填写） | https://mineru.net/ |
| unstructured API key | 云端解析 API（⚙ 设置填写） | https://unstructured.io/ |
| Semantic Scholar key | 学术检索解除限速（⚙ 设置 → 检索源密钥） | https://www.semanticscholar.org/product-api |

> **隐私**：所有密钥与运行数据只存本机 `data/`，接口返回一律打码；`library/` 的 PDF、`knowledge/` 的笔记与解析缓存均已 gitignore，不会进入仓库。

## 目录结构

```
server/                  Node 服务端（Express + pi SDK 桥接）
  native-harness.js      会话、资源与项目绑定
  session-controller.js  原生运行时生命周期与连接接管
  session-routes.js      SSE、状态、会话树、队列、工具与导出接口
  paper-tools.js         论文工具和领域提示词
  latex-editor.js        LaTeX 工作区（文件树 / 编译 / PDF 预览）
  notes.js               知识库（粗读 / 精读 / 图表分析）
  zotero.js              Zotero 集成（sqlite 快照）
  parser/                两层解析管线 + merge（中间态 blocks.json v2）
  search/                多源学术检索 + ReadScore 排序
  assets/                期刊 SJR / 分区指标等数据资产
src/                     前端源码（esbuild 打包；marked + KaTeX + pdf.js + dockview）
  dock.js                Dock 导航与可拖动工作区
  figurePanel.js         图表分析（图解析 / 表解析 / 复现大纲）
  mdEditor.js            LaTeX·MD 编辑器（AI 辅助改稿）
  reader.js chat.js      阅读器与对话
public/                  构建产物与静态资源（KaTeX / dockview 样式 / pdf.worker）
data/ library/ knowledge/  运行数据 / 本地 PDF / 笔记（均不入库）
tests/                   node --test 套件（会话、解析、版本、UI 通道）
```

## 文档

- [Pi 原生接入说明](docs/pi-native-integration.md) — 会话、资源、扩展的完整使用规则与验收方式
- [解析管线说明](docs/pdf-parser.md)
- [原生能力审计](docs/pi-native-capability-audit.md)

## 测试

```bash
npm test        # node --test tests/*.test.mjs（会话生命周期 / 多页面接管 / 解析版本 / UI 通道）
```
