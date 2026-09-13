# PiPaper · 论文精读工作台

以 [pi agent](https://github.com/badlogic/pi-mono)（`@earendil-works/pi-coding-agent`）为内核的论文精读工作台：文献库、解析阅读器、AI 对话、知识库与写作工具装进一个本地 Web 应用。

完全复用 pi 的会话管理与模型认证（`~/.pi/agent` 下的 `auth.json`、`models.json`、JSONL 会话）：**pi 里能用什么模型，这里就能用什么模型**——不引入额外账号体系，也不需要在应用里填模型密钥；会话文件与 pi TUI 互通，两边可无缝接力。

## 一次精读的工作流

```
导入 PDF / 同步 Zotero → 解析（MinerU 精排）→ 阅读器 + AI 对话
    → 一键生成 粗读笔记 / 思维导图 / 流程图
    → 图表分析（逐图逐表解读 + 复现大纲）
    → LaTeX·MD 编辑器整理知识库 → 沉浸工作台组合输出
```

每一环都在右侧 Dock 里，点击即用。

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
- 段落即时翻译（LibreTranslate 本地 Docker）

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
- **沉浸式工作台**：模块注册表 + 两栏 / 一大两小布局，全屏组合输出

### 🔍 文献管理

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
| Docker sidecar | unstructured 本地解析（:8000）+ LibreTranslate 翻译（:5001），`docker compose up -d` | [Docker Desktop](https://www.docker.com/products/docker-desktop/) |
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
