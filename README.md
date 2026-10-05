# PiPaper · 论文阅读与研究工作台

PiPaper 是基于 [Pi agent](https://github.com/badlogic/pi-mono) 的本地 Web 工作台，将文献管理、PDF 阅读、AI 对话、多模态知识库、独立论文研读、选题分析和写作放在同一套工作流程中。

对话复用 Pi 的模型配置、认证与 JSONL 会话，模型通过 `~/.pi/agent/` 配置。应用资源由 SQLite 清单统一管理，文件系统保存原文与成果，Milvus 保存检索索引。Embedding 与重排使用服务端百炼凭据。

## 快速开始

需要 **Node.js ≥ 22.13**，推荐 Node.js 24，以及 Git、npm。当前存储与 RAG 重构位于 `codex/unified-storage-rag` 分支，以下命令获取该版本：

```bash
git clone --branch codex/unified-storage-rag https://github.com/hahah-bit/pipaper.git
cd pipaper
npm ci
npm start
```

打开 [http://127.0.0.1:4318/](http://127.0.0.1:4318/)。`npm start` 会先构建前端再启动服务；`npm run dev` 使用相同流程，没有自动热更新。端口由环境变量 `PORT` 或 `data/config.json` 的 `port` 指定，启动日志显示实际地址。

AI 功能需要配置 Pi 模型。已经使用 Pi 的用户可以沿用现有配置；首次使用可安装与本项目 SDK 对应版本的 CLI，再按提示配置认证：

```bash
npm install -g @earendil-works/pi-coding-agent@0.84.4
pi
```

首次进入可通过环境诊断查看依赖状态，之后在 **设置 → 环境诊断** 打开。未配置云端解析器时，PDF 阅读可使用内置 PDF.js；多模态入库需要另外启用下文的 Milvus 和模型服务。

## 界面与工作流程

主界面由文献库、对话、阅读器和可分栏工作区组成。右侧提供八个入口：

| 入口 | 用途 |
| --- | --- |
| 阅读 | PDF 原文与结构化解析、批注、翻译、加入对话 |
| 检索 | 知识库证据检索；外部学术来源找论文、加入待读或导入项目 |
| 解读 | 粗读、逐图逐表分析、思维导图、流程图与 Archify 交互图解 |
| 视频 | 播放、截帧提问、时间轴、思维导图与批量分析 |
| 写作 | Markdown、LaTeX 与当前会话产出 |
| 资料 | 资源、笔记与成果、处理任务、待核对、回收站 |
| 选题 | 打开独立的 `/topics` 选题分析页面 |
| 设置 | 常规、知识库连接与模型、技能与扩展、环境诊断 |

工作区支持拖动标签分栏、调整尺寸与布局恢复。切换入口保留检索结果、筛选条件和编辑草稿；关闭标签才释放工作区。主界面、选题与视频共用六套主题和滚动条样式，支持跨页同步；字号可选紧凑、标准、大、特大。

文献列表负责选文献与显示简短状态。**解析操作在阅读器；解析并入库／重建在资料 → 资源；进度与暂停、继续、取消在资料 → 处理任务。**

常见流程：导入 PDF 或同步 Zotero → 解析与阅读 → 对话、研读或图表解读 → 保存笔记／报告 → 解析并入库 → 检索证据 → 整理写作。

## 统一存储、版本与回收站

统一清单位于 `data/storage/catalog.sqlite`，使用 Node 内置 SQLite、WAL 和事务。原始文件、解析版本、图表公式、笔记、研读与选题成果、会话附件、暂存及运维文件通过同一机制登记。

- **稳定身份与历史版本**：资源 ID 保持稳定，内容更新产生新版本；SHA-256 内容对象去重。更新使用修订号检测冲突，冲突返回 `409`，编辑器保留草稿。
- **状态分开管理**：生命周期为正常／回收站／清理中／已清理；内容记录可用、过期、待核对、缺失或损坏；后台任务单独记录排队、运行、暂停、等待配置、中断、成功、失败或取消。
- **依赖失效与恢复**：原文、解析或模型配置变化仅使受影响阶段及下游过期。新版本完成校验后才发布；重建失败保留上一个发布版本，并明确显示过期状态。后台任务持久化检查点，重启后可以继续。
- **删除与清理**：默认进入 30 天回收站，立即从检索排除并撤销旧任务发布权限。所属、共享资源和已保存的独立快照分别处理；物理清理失败保留可重试操作。
- **外部文件**：Zotero 原库、外部工作区与 Pi 全局认证不由回收站删除。应用仅管理自己的文件、快照与外部引用。

首次启动只为旧数据建立清单，不自动调用模型或全库入库。迁移保留既有文献 ID、解析版本、研读固定版本及附件链接；提供扫描、备份和回滚工具。迁移命令及生命周期 API 见 [统一存储与多模态知识库](docs/storage-rag.md)。

## 多模态入库

```mermaid
flowchart LR
    A[PDF / Markdown / 保存成果] --> B[结构化解析]
    B --> C[清洗与视觉补全]
    C --> D[元素目录与引用关联]
    D --> E[标题树分块]
    E --> F[背景与问题扩写]
    F --> G[百炼 Embedding]
    G --> H[Milvus 发布]
```

解析复用 MinerU → unstructured → PDF.js，保存 Markdown、结构化块、页码、坐标与引擎原始证据。扫描页、截图文字、图表、公式和算法由 Pi 视觉模型补全；候选经过结构、来源及数值等检查。疑点保存原图并进入待核对列表，可靠部分可继续入库，检索显示覆盖缺口。

文本、图片、表格、公式、代码／算法、科学脚注和参考文献分别管理。图片接口提供 base64 与 MIME，表格为 HTML，公式为 LaTeX。正文优先按图表／公式编号建立引用，支持跨页和多处引用，使用稳定占位符与邻接简述；页眉页脚等冗余从检索正文移除，科学注释在可确认的位置加入说明。

分块建立完整标题树，按最深实际标题归属，超限按段落、列表项、句子递归细分。同一标题下的块保留相同标题路径，默认目标 4500 UTF-8 字节、上限 6000 字节、重叠最多 300 字节。每块生成背景说明与四个问题，默认中文、英文各两个；扩写只用于检索，召回返回原文和对应版本的附件。

### 启用向量与模型服务

需要 Docker / Docker Compose。启动固定版本 **Milvus 3.0.2** 及其依赖：

```bash
docker compose --profile rag up -d milvus
docker compose --profile rag ps
```

Milvus、etcd、MinIO 使用持久化卷。向量服务默认 `127.0.0.1:19530`，健康检查为 `http://127.0.0.1:9091/healthz`；停止容器保留数据卷。Node SDK 固定为 `3.0.6`。

百炼密钥按以下顺序由服务端读取：`PIPAPER_EMBEDDING_API_KEY` → `DASHSCOPE_API_KEY` → `data/credentials/embedding.json` → Pi 百炼认证。使用本地文件时，手动创建以下内容，并替换占位值：

```json
{
  "apiKey": "填写你自己的百炼 API Key"
}
```

环境变量需在启动应用的终端中设置。服务不会自动读取 `.env`。密钥文件位于 Git 忽略的 `data/` 内；前端配置接口只返回凭据状态。

在 **设置 → 知识库** 检查百炼地域／业务空间接口地址、Milvus 地址及模型。默认值如下，Pi 模型需要已配置并可用：

| 功能 | 默认模型／参数 |
| --- | --- |
| Embedding | 百炼 `text-embedding-v4`，1024 维，每批最多 10 条，区分 document／query |
| 重排 | 百炼 `qwen3.7-text-rerank`，默认复用 Embedding 凭据，可用 `PIPAPER_RERANK_API_KEY` 单独配置 |
| 视觉清洗 | Pi `zai-coding-cn/glm-4.6v`，备用 `deepseek/deepseek-v4-flash-vision-exp` |
| 语义扩写与检索分析 | Pi `deepseek/deepseek-v4-flash` |
| 检索选区翻译 | Pi `zai-coding-cn/glm-4.7` |

然后在 **资料 → 资源** 选择资源启动「解析并入库」。缺少凭据、服务或可用额度时，任务进入等待配置，可修复配置后继续／重试。入库启动会先检查 Embedding 和 Milvus，再进行模型清洗与扩写。

## Self-RAG 检索与时间证据

知识库检索采用：**问题改写 → 多路召回 → 加权融合 → 专门重排 → 证据反思 → 必要时补检索一次 → 带引用分析与核对**。

- 原始问题与改写同时检索正文／元素的稠密向量和 BM25，并加入本地原文、标题元数据与精确图表编号召回。加权 RRF 融合后交给百炼重排，MMR 控制近重复结果；可查看各路排名、相关度与依据。
- 分析评估子问题覆盖与证据支持，最多两轮检索。模型输出引用原文及已核验元素；无法完成核对时展示原始证据和原因。重排不可用时明确显示降级。
- 支持相关性优先、近期优先、截至日期、日期区间和历史对比等策略。相似来源保留不同日期，结合任务比较适用性，提示未知日期、未来年份、时间精度与差异；论文发表时间和成果生成时间分别标注。
- 每条证据展示原文片段、完整标题路径、页码、来源、版本及日期依据，下方提供对应图表和独立公式。行内数学在原位置渲染，共享附件去重，大附件按预算加载。
- 在英文正文或元素说明中选中内容，可「翻译」或「添加进对话」。点击翻译才在当前文本块下方展开译文；默认 GLM，可收起、重试。加入对话保留来源信息，随用户下一条消息发送。

这里的 Self-RAG 使用通用 Pi 模型进行自反思检索，没有训练 reflection token 专用模型。**“最新”判断限于本地已入库资料**；未联网核验时无法确认全球最新。当前没有 GraphRAG，保留独立检索提供方接口，后续可接入图谱应用。

Pi 对话可通过 `search_knowledge` 和 `get_knowledge_element` 使用相同证据。参数、评分、时间策略、流式接口与评测见 [Self-RAG 检索说明](docs/self-rag-retrieval.md)。

## 阅读、研读与选题

**阅读器**支持 PDF 原文、文字划选、框选截图及结构化解析视图，使用 KaTeX 渲染数学，保留图表原文证据。解析版本可以预览、对比、采用与本地重建；已有采用版本时新结果先作为候选保存。段落与整篇双语翻译通过 Pi 模型执行，支持缓存、暂停和继续。复杂公式、表格与算法疑点仍需结合原文核对。详见 [PDF 解析说明](docs/pdf-parser.md)。

**独立论文研读**保留 `/study/:taskId` 三栏页面：原文、研读引导、自由提问。可以选择理解／复现／创新目标，按粗读、精读、总结推进，检查点与答题记录持久化。引导与自由提问使用独立会话，任务固定解析版本；保存到知识库的成果与附件作为独立快照保留。可选生图扩展在页面内安装与配置，不会自动运行实验训练。

**选题分析**从右侧「选题」进入 `/topics`，任务页面为 `/topics/:id`，保留独立报告、证据检索与方向对话。首次选题结合调查卡、真实文献、代码、硬件／数据证据及政策来源生成候选问题、验证路线与期刊分析；保留引用与来源，证据不足显示缺口。当前尚未实现基于既有论文与技术栈的二次选题。详见 [选题分析说明](docs/topic-analysis.md)。

## 对话、写作与视频

**Pi 原生对话**支持 JSONL 会话、分支、压缩、重试、排队／插队、扩展交互和导出。多页面打开同一会话时后连接的页面接管控制，原页面可以重新连接。每个问题结束后，思考、工具步骤与模型用量合并到一条默认折叠的「执行记录」，回答和失败提示保留；输入区的高级操作、快捷提问与剪贴板集中在「更多」。论文工具包括 `read_paper`、`list_library`、`search_library`、`get_paper_pages`。详见 [Pi 原生接入](docs/pi-native-integration.md)。

**知识与写作**支持粗读／精读笔记、逐图逐表解读、markmap、Mermaid、Markdown 分屏编辑与 AI 修改差异确认。LaTeX 工作区提供文件树、源码、`pdflatex` 编译和 PDF 预览，需要本机 TeX 环境。Archify 交互图解复用已有上游仓库或技能目录，路径在连接设置或 `PIPAPER_ARCHIFY_DIR` 中指定；产物校验后发布，并保存修改版本。

**视频**拥有右侧独立入口及 `/videos` 页面，可播放本地／远程视频、截帧提问、生成时间轴与思维导图，批量入口按实际视频数量出现。视频对话使用独立会话归属，不会接管主界面对话。当前本地视频是页面临时对象，刷新后需重新选择，持久化视频资料库尚未实现。

## 可选组件

| 组件 | 用途与启用方式 |
| --- | --- |
| [Zotero](https://www.zotero.org/download/) | 文献与分类同步，读取 SQLite 快照和附件引用 |
| [MinerU](https://github.com/opendatalab/MinerU) | 本地 CLI 或云端结构化解析，在设置配置模式与认证 |
| [unstructured](https://unstructured.io/) | 云端解析或 `docker compose up -d unstructured`，本地默认端口 8000 |
| Docker / Compose | 本地 Milvus 与可选解析服务 |
| TeX 发行版 | LaTeX 工作区的 `pdflatex` 编译 |
| [Archify](https://github.com/tt-a1i/archify) | 交互架构、流程、时序、数据流与状态图 |
| 学术检索服务凭据 | 可选 OpenAlex / Semantic Scholar 密钥，在设置配置 |

应用内容与状态主要保存在本机；云端解析、模型和向量 API 调用会将对应输入发送给所配置的服务。Pi 认证保存在 `~/.pi/agent/`，应用配置与百炼本地凭据保存在 `data/`。默认 `data/`、`knowledge/`、本地 `library/*.pdf` 与构建包已被 Git 忽略。

## 代码结构

```text
server/
  storage/              SQLite 清单、版本、文件操作、迁移、维护与状态 API
  rag/                  清洗、元素关联、分块、扩写、向量、检索、重排与翻译
  parser/               PDF 解析、结构化文档、证据与解析版本
  search/               外部学术检索与 ReadScore
  native-harness.js     Pi 会话与业务资源绑定
  session-controller.js 运行时、控制权与连接生命周期
  session-routes.js     会话、SSE、队列、工具与导出
src/
  dock.js taskWorkspace.js workspaceNavigation.js  导航、视图与布局迁移
  storagePanel.js       资源、任务、核对与回收站
  knowledge*.js         知识检索、证据展示与选区操作
  chat.js chatTurns.js   对话与执行记录
  themeTokens.js        共用主题与跨页同步
  study/ topics/        独立研读与选题页面
shared/                 服务端与前端共用的知识内容处理
public/                 页面、共用样式与构建产物
scripts/                构建、迁移与隔离验收脚本
tests/                  自动测试与检索评测夹具
docs/                   设计、操作与验证说明
data/ library/ knowledge/  默认运行数据、文献与知识成果
```

## 开发与验证

```bash
npm test
npm run build
```

自动测试覆盖存储与版本、生命周期、任务恢复、解析、元素关联、分块、检索时间策略、引用核对、选区翻译、Pi 会话和前端状态。真实 Milvus 测试需先启动本地服务，再显式启用：

```powershell
$env:PIPAPER_TEST_MILVUS = "1"
node --test tests/rag-milvus.test.mjs
```

已配置模型、百炼和 Milvus 时，可以运行隔离的真实检索评测，**会产生实际 API 用量**：

```bash
node --use-system-ca scripts/rag-recall.mjs
node --use-system-ca scripts/retrieval-evaluate.mjs
```

脚本使用专用评测数据与临时集合，不改动用户文献发布索引。固定 30 问夹具可验证连接、召回和不退步；当前满分结果不能证明扩写或重排提升了真实多文献检索质量，也没有覆盖所有时间冲突与困难负例。

`npm run build` 会更新页面资源版本戳。更多研读／选题的隔离验收和可选真实模型检查见相应文档。

## 文档

- [统一存储与多模态知识库](docs/storage-rag.md)：部署、凭据、迁移、版本、生命周期与 API
- [Self-RAG 检索](docs/self-rag-retrieval.md)：召回、重排、反思、日期、证据、翻译与扩展接口
- [工作区导航与前端状态](docs/workspace-navigation.md)：入口分工、主题、草稿与旧布局迁移
- [PDF 解析与恢复](docs/pdf-parser.md)：解析证据、版本采用、质量检查与限制
- [选题分析](docs/topic-analysis.md)：调查卡、真实来源、报告与任务恢复
- [Pi 原生接入](docs/pi-native-integration.md)：会话、资源、模型与扩展
- [Pi 原生能力审计](docs/pi-native-capability-audit.md)：接入范围与验证记录
