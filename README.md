# PiPaper · 论文精读工作台

以 [pi agent](https://github.com/badlogic/pi-mono)（`@earendil-works/pi-coding-agent`）为内核的论文阅读 / 对话 Web UI。**完全复用 pi 的会话管理与模型认证**（`~/.pi/agent` 下的 `auth.json`、`models.json`、JSONL 会话），只是为「读论文」这个任务套了一层专用界面。

## 启动

```bash
npm run dev        # 首次：构建前端 + 启动
# 之后日常：
npm start          # 直接启动（端口见 data/config.json，默认 4318）
```

打开 **http://127.0.0.1:4318**

> 模型与密钥：无需额外配置，直接复用你 pi CLI 的已登录模型（`pi` 里能用，这里就能用）。右上角可切换模型与思考深度。

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

- **会话**：原生 pi JSONL 会话（树状分支 / compaction / 自动重试全保留），按**项目**分组管理（侧边栏顶部切换，会话下拉按项目分组）
- **模型认证**：`ModelRuntime` 直接用你 `~/.pi/agent` 的 auth.json / models.json，pi 里能用这里就能用
- **技能 / 提示模板 / 扩展**：DefaultResourceLoader 自动发现 `~/.pi/agent/skills`、prompts、扩展（含 settings.json 里的 packages）；输入框打 `/` 弹出全部命令（内置 /model /thinking /new /compact /paper + pi 模板 + /skill:xxx）
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

侧边栏 🧩 打开资源管理：Skills（项目级勾选）、扩展（项目级路径）、Packages（带 [pi.dev/packages](https://pi.dev/packages) 商店链接；填包名可全局 `pi install` 或装到当前项目，项目级经 npm 安装后自动接线到该项目会话）、MCP（pi 不内置，只读扫描说明）。

## 目录

```
server/          Node 服务端（Express + pi SDK 桥接）
  harness.js     pi 内核：会话/模型/流式事件/论文工具/命令发现
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
