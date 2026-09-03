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

## 论文解析

| 引擎 | 说明 | 配置 |
|---|---|---|
| **MinerU**（推荐） | 公式/表格/图片精排，恢复 LaTeX 与原图 | 云端 API（mineru.net token）或本地部署 CLI（`mineru` / `magic-pdf`） |
| **unstructured.io** | 元素级解析（标题/表格 text_as_html/图片坐标） | 云端 API key 或本地 Docker（`unstructured-api`，地址 `http://localhost:8000`） |
| **本地兜底** | pdf.js 纯文本抽取，零配置始终可用 | 无需配置 |

⚙ 设置里选择模式并填入 token/key 即可；解析时选「自动」会按 MinerU → unstructured → 兜底 的顺序取第一个已配置的引擎。

## 会话绑定的 agent 工具

每个会话内置论文域工具（`read_paper` / `list_library` / `search_library`），系统提示词为论文精读助手。会话选中论文后，agent 不带参数的 `read_paper` 默认读当前论文；支持 `outline / section / search / full` 四种模式。另有只读的 `read` / `grep` / `ls`。

## 目录

```
server/          Node 服务端（Express + pi SDK 桥接）
  harness.js     pi 内核：会话/模型/流式事件/论文工具
  zotero.js      Zotero 集成（zotero.sqlite 快照，Zotero 关着也能同步）
  parser/        MinerU / unstructured / 兜底 三引擎 + markdown→块切分
src/  public/    前端（esbuild 打包，marked + KaTeX + pdf.js）
data/            运行数据（config.json、papers.json、解析缓存）
library/         本地导入的 PDF
```

## 说明

- Zotero 集成读取 `zotero.sqlite` 快照（自动从 profile prefs.js 探测数据目录），Zotero 是否开着都能同步；PDF 附件直接从 `storage/` 读取。
- 会话即 pi 会话：支持树状分支 / compaction / 自动重试等 pi 全部能力（经 SDK 透传）。
- 端口在 `data/config.json` 的 `port`，或环境变量 `PORT`。
