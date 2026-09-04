# PiPaper · 论文精读工作台

以 [pi agent](https://github.com/badlogic/pi-mono)（`@earendil-works/pi-coding-agent`）为内核的论文阅读 / 对话 Web UI。**完全复用 pi 的会话管理与模型认证**（`~/.pi/agent` 下的 `auth.json`、`models.json`、JSONL 会话），只是为「读论文」这个任务套了一层专用界面。

## 启动（新机器：从 clone 到跑起来）

### ① 必选：Node + pi 登录（对话内核）

- [Node.js](https://nodejs.org/) ≥ 22.13（用到内置 `node:sqlite`；24 LTS 已验证）
- 安装 [pi agent](https://github.com/badlogic/pi-mono) 并完成**一次登录**——本应用直接复用 pi 的模型认证（`~/.pi/agent/auth.json`），**不需要在这里填任何模型密钥**：

```bash
npm install -g @earendil-works/pi-coding-agent   # pi CLI
pi                                               # 首次运行按提示登录模型
```

然后拉取并启动：

```bash
git clone <本仓库> && cd piagent_ui_reading
npm ci            # 安装依赖
npm start         # 首次会自动构建前端并启动（等价 npm run dev）
```

打开 **http://127.0.0.1:4318**（端口可在 `data/config.json` 或环境变量 `PORT` 修改）。首次进入会自动弹出**环境检查**面板，逐项显示就绪状态并附下载链接与安装命令；之后可在 ⚙ 设置 → 「环境检查」随时打开。

### ② 可选：Docker sidecar（解析 / 翻译增强）

```bash
docker compose up -d      # unstructured(解析,:8000) + libretranslate(翻译,:5001)
```

- **unstructured 本地解析** → `http://localhost:8000`，⚙ 设置里模式选「本地服务」即可，无需密钥
- **LibreTranslate 翻译** → `http://localhost:5001`，阅读器段落悬停「译」即时翻译，无需密钥
- 没装 Docker？[下载 Docker Desktop](https://www.docker.com/products/docker-desktop/)；不装也能用——解析有 pdf.js 本地兜底，翻译可走 LLM 模板「翻译选区」

### ③ 可选：本地下载安装（Zotero / MinerU CLI）

| 组件 | 用途 | 获取链接 | 说明 |
|---|---|---|---|
| [Zotero 7](https://www.zotero.org/download/) | 文献库同步 | https://www.zotero.org/download/ | 装好建库后**自动探测**数据目录，无需填路径 |
| [MinerU CLI](https://github.com/opendatalab/MinerU) | 公式/表格精排（本地模式） | https://github.com/opendatalab/MinerU | `pip install "mineru[core]"`；不装也可用云端 API |

### ④ 可选：申请密钥（全部只存本机）

| 密钥 | 用途 | 申请入口 | 填写位置 |
|---|---|---|---|
| MinerU token | MinerU 云端解析 API | https://mineru.net/ | ⚙ 设置 |
| unstructured API key | unstructured 云端解析 API | https://unstructured.io/ | ⚙ 设置 |
| Semantic Scholar key | 学术检索解除限速 | https://www.semanticscholar.org/product-api | ⚙ 设置 → 检索源密钥 |
| 学术镜像 Cookie | Google 学术镜像检索 | 浏览器过一次验证后复制 Cookie | ⚙ 设置 → 检索源密钥 |

> **密钥安全**：所有密钥只保存在本机 `data/` 目录（已在 `.gitignore`），接口返回一律打码，**不会进入 git 仓库**。请勿把 `data/` 目录打包分享给他人。

## 界面

```
┌──────────┬──────────────────────┬───────────────────────────┐
│ 侧边栏    │ 会话（左）             │ 阅读器（右）                │
│ Zotero   │ pi 会话列表/新建/删除   │ 解析视图 ｜ PDF 原文         │
│ 分类/文献 │ 模型/思考深度切换       │ 解析、框选、状态            │
│ 导入/搜索 │ 上下文 chips + 输入    │ 公式/表格/图片原样排版       │
└──────────┴──────────────────────┴───────────────────────────┘
```

- **侧边栏**：Zotero 文献库（分类树 + 搜索）与本地导入的 PDF。点 ⚙ 可设置 Zotero 数据目录、MinerU、unstructured。
- **会话**：原生 pi 会话（`~/.pi/agent/sessions/<本项目>/…jsonl`），你在 pi TUI 里打开同一目录也能继续这些会话。发送第一条消息时自动创建会话。
- **阅读器**：
  - 解析视图：公式（KaTeX）、表格、图片按原大小排版，悬停任意块可「＋对话」。
  - PDF 原文：pdf.js 渲染，支持文字划选与 ⬚框选截图。
- **加入对话**：划选文字（解析视图 / PDF 文本层）→「✂ 加入对话」；框选 → 自动截图；图片/表格/公式块一键加入。chips 显示在输入框上方，随消息作为引用文本 / 附图发给模型（视觉模型可读截图）。

## 论文解析（两层管线，中间态：blocks.json v2）

中间态是一组带 `page`（页码）+ `bbox`（页面坐标）的内容块流（标题/段落/图/表/公式），两层结果按「页码 + 纵向位置」交织，图表公式插回原文原位置：

| 层 | 产物 | 来源 |
|---|---|---|
| 第一层 文本流 | 带页码坐标的标题/段落 | MinerU md、unstructured 文本元素、pdf.js 兜底抽取 |
| 第二层 元素 | 带坐标的图/表/公式 | MinerU middle.json、unstructured 元素坐标、兜底图注定位 + 页面裁剪（@napi-rs/canvas） |

| 引擎 | 说明 | 配置 |
|---|---|---|
| **MinerU**（推荐） | 公式/表格/图片精排；本地部署会读 `middle.json` 做块级坐标对齐 | 云端 API（mineru.net token）或本地 CLI（`mineru` / `magic-pdf`） |
| **unstructured.io** | 元素级解析（text_as_html / image_base64 / coordinates） | 云端 API key 或本地 Docker（`http://localhost:8000`） |
| **本地兜底** | pdf.js 文本抽取 + **图注定位自动裁图**（Figure N 上方区域，含矢量图），零配置 | 无需配置 |

⚙ 设置里选择模式并填入 token/key 即可；解析时选「自动」按 MinerU → unstructured → 兜底 取第一个已配置的引擎。

## pi 深度复用

检索器优化已整合到同一应用：检索面板默认按 ReadScore 综合推荐排序，也可按与当前论文／本地文献的相关度排序，悬停分数可查看六个评分维度。年份、分区范围和开放全文筛选会记忆；「＋待读」只保存元数据，在待读清单点击「＋项目」才下载开放 PDF 并导入。

- **会话**：原生 pi JSONL 会话（树状分支 / compaction / 自动重试全保留），按**项目**分组管理（侧边栏顶部切换，会话下拉按项目分组）
- **交互提问**：Agent 通过 `request_user_input` 发起确认、选择或文本提问；Pi 扩展的 `ctx.ui.confirm/select/input/editor` 同样显示网页小窗。提交后继续执行，Esc 取消；选择题支持扩展原始选项，模型提问还可填写其他答案。普通回复文字不会自动转换成弹窗。停止、关闭页面或连接断开会取消等待。
- **排队 / 插队**：回复过程中 `Enter`（或“插队”按钮）在当前轮工具结束后介入；`Alt+Enter` / `Ctrl+Q`（或“排队”按钮）等当前任务完成后处理。`Shift+Enter` 换行；空闲时 Enter 发送。待处理消息显示在输入框下方；回答小窗中的问题后才能继续排队。
- **模型认证**：`ModelRuntime` 直接用你 `~/.pi/agent` 的 auth.json / models.json，pi 里能用这里就能用
- **技能 / 提示模板 / 扩展**：每个会话独立加载 `~/.pi/agent/skills`、prompts、扩展与项目资源；输入 `/` 查看应用命令、原生扩展命令、模板及 `/skill:xxx`，并显示来源。
- **原生状态与导出**：对话上方显示当前上下文占用、累计 Token、缓存和费用；支持附加说明压缩、取消、重试状态及 HTML/JSONL 下载。思考档位随实际模型能力变化。
- **会话树与工具**：「会话树」查看同一 JSONL 内的节点、保存标签、带摘要切换路径；历史问题旁的 ✎ 另建分支会话。通过「工具」启停下一轮可用工具，可选择仅内置读取工具或 Windows PowerShell，并显式保存项目默认值。
- **队列取回**：「取回待发送消息」清空原生待发送队列并恢复为草稿列表，保留文字、截图和插队／排队类型；已消费消息不会再次取回。
- **扩展 UI**：支持状态、文本组件、工作提示、标题及编辑器文字。自定义终端组件会明确报不支持。一个会话同时只允许一个控制页面，关闭页面会停止执行；重新打开读取原生状态和历史，不自动重发。
- **@ 文件**：输入 `@` 弹出文件列表（论文解析全文、论文插图、工作区文件、library PDF），选中即加入对话上下文
- **论文域工具**：`read_paper`（outline/section/search/full）、`list_library`、`search_library`、`get_paper_pages`（渲染论文页给视觉模型看）
- **思考过程**：ZCode 式一行显示——思考中单行滚动尾部内容，输出后折叠为「✻ 已深度思考 Ns ▸」，点击展开

## 自托管服务（docker compose）

`docker-compose.yml` 统一管理自托管服务，后续新增服务都写进这一份：

```bash
docker compose up -d      # 启动 unstructured + libretranslate
docker compose ps         # 状态
```

- **unstructured-api**（quay.io 官方镜像，自带 Poppler/Tesseract/模型）→ `http://localhost:8000`；设置里 unstructured 模式选「本地服务」即可
- **libretranslate**（开源翻译，中英模型）→ `http://localhost:5001`；阅读器中每段悬停「译」按钮即时翻译

## 插件 / 技能管理

侧边栏 🧩 打开资源管理。技能可「继承默认」或「只启用勾选技能」，显式空清单关闭全部候选技能。扩展可追加绝对路径；Packages 使用 Pi 原生 `DefaultPackageManager`，支持 `npm:包名@版本`、`npm:@scope/包名@版本`、Git 来源及本地绝对路径，自动发现包内扩展、技能和模板。每个项目有独立包管理目录，工具工作目录仍为应用目录。资源修改在空闲时生效，运行中显示待更新，失败时保留当前可用配置。

首次升级会备份项目和会话索引并迁移资源配置；原生 JSONL 不批量重写。完整使用规则、接口和验收方式见 [Pi 原生接入说明](docs/pi-native-integration.md)。

## 目录

```
server/          Node 服务端（Express + pi SDK 桥接）
  harness.js     业务兼容入口（导出原生接入与论文工具）
  native-harness.js      会话、资源与项目绑定
  session-controller.js  原生运行时生命周期和单控制连接
  session-routes.js      SSE、状态、会话树、队列、工具与导出接口
  paper-tools.js        论文工具和领域提示词
  setup-status.js   环境自检（能力注册表 + 探测，首启引导数据源）
  assets/        随仓库分发的数据资产（期刊 SJR/分区指标，clone 即有）
  zotero.js      Zotero 集成（zotero.sqlite 快照，Zotero 关着也能同步）
  parser/        两层解析管线 + merge（中间态 blocks.json v2）
  parser/render.js  pdf.js + @napi-rs/canvas 服务端光栅化（图裁剪/页截图）
src/  public/    前端（esbuild 打包，marked + KaTeX + pdf.js）
data/            运行数据（config.json、papers.json、projects.json、解析缓存）
library/         本地导入的 PDF
```

## 说明

- Zotero 集成读取 `zotero.sqlite` 快照（自动从 profile prefs.js 探测数据目录），Zotero 是否开着都能同步；PDF 附件直接从 `storage/` 读取。
- 端口在 `data/config.json` 的 `port`，或环境变量 `PORT`。

## 框选批注 · 剪贴板 · 主题 · 视频（v0.8）
- **框选批注**：PDF 框选/解析视图块"＋对话"弹出批注卡片 —— 提示词模板（⚙ 可编辑，支持 {{选区}}/{{批注}} 占位符）+ 批注输入，「▶ 问 AI」直达模型（含原图），「＋加入对话」进上下文
- **图/表/公式专用模板**：分析图片（流程框架/专业数据/论证任务）、分析表格（实验设计/趋势/结论局限）、分析公式（变量/目的/推导/算法本质）；配套 gated 技能 `paper-element-analysis`；对话中会显示原表格/原图
- **上下文图片保真**：上下文文本里的图片引用自动抓取为真实图片附件
- **剪贴板管理**：📋 浮动面板（拖动/缩放/折叠），自动收集应用内复制与划选，**2 天自动清理**
- **主题**：🎨 一键切换 6 套配色（默认/Nord/GitHub Dark/Gruvbox/纸白/Solarized Light）
- **视频**：本地或链接视频打开，可折叠管理列表，截帧问 AI；全局 `video-use` 技能 + `video-subtitle-sync` 字幕同步插件（第一个注册的本地插件）
