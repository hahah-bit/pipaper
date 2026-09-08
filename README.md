# PiPaper · 论文精读工作台

以 [pi agent](https://github.com/badlogic/pi-mono)（`@earendil-works/pi-coding-agent`）为内核的论文阅读 / 对话 Web UI：把「读论文」所需的一切——文献库、解析阅读器、AI 对话、笔记与知识库——装进一个本地应用。

完全复用 pi 的会话管理与模型认证（`~/.pi/agent` 下的 `auth.json`、`models.json`、JSONL 会话）：pi 里能用什么模型，这里就能用什么模型，不引入任何额外账号体系，也不需要在本应用填写模型密钥。

## 功能一览

### 阅读

- **两层解析管线**：MinerU（云端 API / 本地 CLI，公式表格精排）→ unstructured（云端 API / 本地 Docker）→ pdf.js 兜底（零配置，图注定位自动裁图）。中间态为带页码 + 坐标的 blocks.json v2，图表公式按原位置插回正文
- **双视图阅读器**：解析视图（KaTeX 公式、表格、图片按原大小排版）与 pdf.js 原文（文字划选 + ⬚ 框选截图），悬停任意块可「＋对话」
- **段落即时翻译**：LibreTranslate 本地 Docker，或 LLM 模板「翻译选区」

### 对话（原生 pi 能力）

- 原生 JSONL 会话：树状分支 / compaction / 自动重试全保留，按项目分组，在 pi TUI 打开同一目录可无缝接力
- 交互提问：Agent 发起的确认、选择、文本提问显示为网页小窗（含 Pi 扩展 `ctx.ui.*`），Esc 取消
- 排队 / 插队：回复中介入或等任务完成后处理，待处理消息显示在输入框下方
- 原生状态：上下文占用、累计 Token、缓存与费用实时显示；支持压缩、取消、重试与 HTML / JSONL 导出
- `@` 文件引用：论文解析全文、插图、工作区文件、library PDF 一键入上下文
- 论文域工具：`read_paper`（outline/section/search/full）、`list_library`、`search_library`、`get_paper_pages`（渲染论文页给视觉模型）
- 思考过程单行滚动、完成后折叠可展开；会话树查看节点 / 标签 / 分支切换

### 知识沉淀

- **沉浸式模块化工作台**：模块注册表 + 可组合布局（两栏 / 一大两小），栏位随时切换模块，组合与栏宽持久化；首批模块含论文阅读器、对话、粗读解析、思维导图、流程图
- **一键生成**：精读 / 粗读笔记、markmap 思维导图、mermaid 流程图（生成走临时 pi 会话，过程实时可见，完成自动清理）
- 知识库按论文分目录管理（粗读 / 精读分库），笔记管理弹窗支持预览与递归删除

### 文献管理

- **Zotero 7 集成**：读取 `zotero.sqlite` 快照（自动探测数据目录，Zotero 开着也能同步），分类树 + 搜索，PDF 附件直读
- **学术检索**：ReadScore 综合推荐排序（悬停查看六个评分维度），年份 / 分区 / 开放全文筛选会记忆；「＋待读」只存元数据，点「＋项目」才下载开放 PDF 并导入

### 其他

- 框选批注：提示词模板（⚙ 可编辑，支持 `{{选区}}`/`{{批注}}` 占位符）+ 批注输入，「▶ 问 AI」直达模型；图 / 表 / 公式各有专用分析模板
- 剪贴板管理面板：自动收集应用内复制与划选，2 天自动清理
- 6 套主题配色（默认 / Nord / GitHub Dark / Gruvbox / 纸白 / Solarized Light）
- 本地 / 链接视频播放，截帧问 AI
- 环境自检：首启自动检查依赖，逐项给出就绪状态与安装指引
- 技能 / 提示模板 / 扩展 / Packages 管理（Pi 原生 `DefaultPackageManager`，支持 npm / Git / 本地路径来源）

## 快速开始

前置：[Node.js](https://nodejs.org/) ≥ 22.13（用到内置 `node:sqlite`）+ pi 登录一次：

```bash
npm install -g @earendil-works/pi-coding-agent   # 安装 pi CLI
pi                                               # 首次运行按提示登录模型
```

拉取并启动：

```bash
git clone <本仓库> && cd piagent_ui_reading
npm ci
npm start        # 自动构建前端并启动（等价 npm run dev）
```

打开 **http://127.0.0.1:4318**（端口见 `data/config.json` 或环境变量 `PORT`）。首次进入自动弹出环境检查面板，缺什么会有下载链接与安装命令；之后可在 ⚙ 设置 → 「环境检查」随时打开。

## 可选组件

| 组件 | 用途 | 获取方式 |
|---|---|---|
| Docker sidecar | unstructured 本地解析（:8000）+ LibreTranslate 翻译（:5001），`docker compose up -d` | [Docker Desktop](https://www.docker.com/products/docker-desktop/) |
| [Zotero 7](https://www.zotero.org/download/) | 文献库同步（自动探测数据目录） | https://www.zotero.org/download/ |
| [MinerU CLI](https://github.com/opendatalab/MinerU) | 公式 / 表格精排（本地模式），`pip install "mineru[core]"`；不装也可用云端 API | https://github.com/opendatalab/MinerU |
| MinerU token | 云端解析 API（⚙ 设置填写） | https://mineru.net/ |
| unstructured API key | 云端解析 API（⚙ 设置填写） | https://unstructured.io/ |
| Semantic Scholar key | 学术检索解除限速（⚙ 设置 → 检索源密钥） | https://www.semanticscholar.org/product-api |

> **隐私**：所有密钥与运行数据只存本机 `data/`，接口返回一律打码；`library/` 的 PDF、`knowledge/` 的笔记与解析缓存均已 gitignore，**不会进入仓库**。

## 界面

```
┌──────────┬──────────────────────┬───────────────────────────┐
│ 侧边栏    │ 会话（左）             │ 阅读器（右）                │
│ Zotero   │ pi 会话列表/新建/删除   │ 解析视图 ｜ PDF 原文         │
│ 分类/文献 │ 模型/思考深度切换       │ 解析、框选、状态            │
│ 导入/搜索 │ 上下文 chips + 输入    │ 公式/表格/图片原样排版       │
└──────────┴──────────────────────┴───────────────────────────┘
```

## 目录结构

```
server/                  Node 服务端（Express + pi SDK 桥接）
  native-harness.js      会话、资源与项目绑定
  session-controller.js  原生运行时生命周期和单控制连接
  session-routes.js      SSE、状态、会话树、队列、工具与导出接口
  paper-tools.js         论文工具和领域提示词
  setup-status.js        环境自检（能力注册表 + 探测）
  zotero.js              Zotero 集成（sqlite 快照）
  parser/                两层解析管线 + merge（中间态 blocks.json v2）
  assets/                随仓库分发的数据资产（期刊 SJR / 分区指标）
src/ public/             前端（esbuild 打包，marked + KaTeX + pdf.js）
data/ library/ knowledge/   运行数据 / 本地 PDF / 笔记（均不入库）
```

## 文档

- [Pi 原生接入说明](docs/pi-native-integration.md) — 会话、资源、扩展的完整使用规则与验收方式
- [解析管线说明](docs/pdf-parser.md)
- [原生能力审计](docs/pi-native-capability-audit.md)

## 测试

```bash
npm test        # node --test tests/*.test.mjs
```
