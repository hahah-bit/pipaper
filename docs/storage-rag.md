# 统一存储与多模态知识库

PiPaper 使用 SQLite 清单统一管理资源、版本、引用、任务和状态；内容保存在原有目录与内容寻址对象库；Milvus 只保存检索表示。文献、解析、笔记、研读、选题、附件、会话、外部工作区和暂存文件均经适配层接入。

## 使用

需要 Node >= 22.13，推荐 Node 24。安装依赖后启动本地向量服务：

```powershell
npm ci
docker compose --profile rag up -d milvus
npm start
```

Milvus 固定为 3.0.2，Node SDK 固定为 3.0.6；etcd、MinIO 与 Milvus 使用独立持久化卷。19530 与健康检查端口 9091 只监听本机。停止容器不清空卷。

百炼凭据由服务端依次从 `PIPAPER_EMBEDDING_API_KEY`、`DASHSCOPE_API_KEY`、`data/credentials/embedding.json`、Pi 的百炼认证中读取。本地 JSON 格式为 `{ "apiKey": "你的密钥" }`；整个 `data/` 已被 Git 忽略。密钥不写入前端或知识库连接配置。

默认配置：

- Embedding：百炼 `text-embedding-v4`，1024 维，每批最多 10 条，文档／查询分别使用 document／query。
- 视觉：通过 Pi 运行时调用 `zai-coding-cn/glm-4.6v`，备用 `deepseek/deepseek-v4-flash-vision-exp`。模型须出现在 Pi 可用清单中并声明图片输入能力，成功的图片调用才记录验证状态。
- 扩写：通过 Pi 调用 `deepseek/deepseek-v4-flash`（本机可用模型）。可在连接配置中更换已配置的 Pi 模型。
- 分块：目标 4500 UTF-8 字节、最大 6000 字节，同标题重叠最多 300 字节。

右侧 Dock 的 **🗄 存储管理** 包含资源、回收站、历史版本、失败操作、任务控制和待核对列表。点击「连接配置」可更改百炼业务空间地址、模型、Milvus 地址和分块预算，只返回是否已读取凭据。

文献卡片或存储管理中的 **解析并入库** 启动全流程。任务先实际检查 Embedding 和 Milvus；缺少凭据、额度或服务时进入「等待配置」，不会先消耗视觉和扩写调用。排队、运行中的任务可暂停／取消，暂停、中断、失败或等待配置的任务可继续／重试。资源删除、版本变化或取消会撤销旧任务的发布权限。

**📚 知识库检索** 支持原始文献、笔记、研读成果、选题报告与元素类型筛选，也可限定当前项目。Pi 对话内可使用 `search_knowledge` 和 `get_knowledge_element` 工具获取原文、标题路径、页码、版本以及原位置图表。单独命中的元素同时返回引用它的正文。

旧数据首次启动只纳管，不调用模型，不自动全库入库。只有点击入库的资源会启用后续增量重建。

## 存储及一致性

核心实现位于 `server/storage/`：

| 文件 | 职责 |
| --- | --- |
| catalog.js | SQLite WAL、资源修订、历史版本、引用、任务、操作日志、发布代次和事件 |
| files.js | 受管读写、SHA-256 对象去重、目录发布、回收／恢复／清理和对象回收 |
| scan.js / migration.js | 只读扫描、备份迁移、业务目录纳管和重启恢复 |
| maintenance.js | 暂存与日志期限、30 天回收站、失败操作重试 |
| routes.js | 管理 API、核对入口、命名空间状态和 SSE |
| pi-tools.js | Pi 原生 write／edit 的文件操作适配，保留原生工具语义与历史版本 |

清单位于 `data/storage/catalog.sqlite`。对象位于 `data/storage/objects/<哈希前缀>/<哈希>`。现有文献、解析版本、知识库和附件路径仍可使用，SQLite 为业务状态的权威记录，JSON 作为兼容镜像。

资源的 ID 与修订号独立于内容哈希。写入保存上一版本的不可变对象；相同字节共享对象，资源拥有不同生命周期。更新需要修订号，冲突返回 409；编辑器保留草稿。文件内容变化、解析采用或配置变化触发依赖失效。入库失败不切走旧发布代次，过期结果明确标记版本和状态。

三个状态维度分别记录：

| 维度 | 内部值 |
| --- | --- |
| 生命周期 | active、trashed、purging、deleted |
| 内容 | ready、stale、needs_review、missing、damaged（生产阶段另由任务表示） |
| 执行 | queued、running、paused、blocked、interrupted、succeeded、failed、cancelled |

研读检查点、选题阶段保留原业务状态，使用统一持久化和修订记录。偏好、布局、草稿分别进入服务端命名空间，浏览器镜像保留离线待同步变更。发生并发状态冲突时重新读取服务端并合并本地待提交项。

删除先在 SQLite 隐藏资源、取消任务，再移动应用拥有的文件。SQLite 生命周期校验会立即排除检索命中，即使 Milvus 离线也不返回回收站内容。回收站保留 30 天；恢复会检测目标路径冲突，文件、数据库或向量清理失败保留可重试操作。清理未完成时状态为 purging，不能假报删除成功。

所属资源随任务处理；共享解析在仍有活跃引用时保留；已保存研读笔记、选题报告和导出成果是独立快照。删除项目只解除文献归属，项目可恢复。Zotero 附件和外部工作区仅登记引用，生命周期操作不会改动原文件；解析时可保存受管原始证据快照。Pi 全局认证不纳入删除范围。

Pi 的 write／edit 工具通过同一存储服务保存应用目录内的文件；生成笔记立即进入知识成果清单，精确编辑检查读取时的修订号。外部工作区写入仍由 Pi 操作，仅登记外部引用；认证文件与本地凭据目录不登记为资源。

暂存文件默认 24 小时、日志 7 天，无引用才过期。证据、解析输出、用户成果和迁移备份不作为普通暂存回收。每小时执行维护，物理对象回收保留活跃／回收站资源的历史版本及未完成写入所需内容。

启动与定时维护会检查文件是否缺失并更新清单。存在完整内容对象的缺失受管文件可在存储管理中恢复，恢复同样检查修订号和内容哈希。未登记的原始 PDF 可从异常列表登记为文献；外部文件保持引用管理。

## 流水线和检索

`server/rag/ingestion.js` 持久化 parse → repair → normalize → chunk → expand → embed → index → publish 各阶段。输入版本、解析配置、视觉／人工修订、分块、扩写、Embedding 和 Milvus 配置依次形成指纹；改动仅使对应阶段及下游检查点失效。重启中断的任务重新取得执行代次并复用检查点。

解析复用 MinerU → unstructured → PDF.js 链，保存 Markdown、结构化块、页码、坐标和引擎证据。Markdown 笔记与保存成果可以直接进入结构化解析。缺失页文字、问题表格／公式／算法和科学图片通过 Pi 的图片调用补全。候选内容保存原图和模型诊断；结构、来源、公式语法、表格数字检查不通过的区域不进入正式索引，可靠部分继续发布并显示覆盖缺口。

候选与核对证据在分块阶段即持久化，整篇都需要核对时也能从待核对列表处理。列表只显示当前资源版本的最新候选，资源更新后的旧候选不能被采用。

文本、图、表、公式、代码／算法、科学脚注和参考文献分别保存。图片底层去重，接口返回 base64 与 MIME；表格保存 HTML，公式保存 LaTeX。重复页眉／页脚、页码和无信息区域从检索正文移除；科学脚注在可确认的引用位置加入 `（注：…）`；原始证据保留。

图、表、公式、算法的关联优先使用编号，支持中英文、范围、列表、子图和跨页引用。同一章节、连续页面且明确注明 continued／续表的表格分页，会在引用位置按页序一起还原；重复的独立编号仍进入待核对列表。人工修订正文时可添加 `references` 映射消歧，例如 `{ "image:3": "原始图块ID", "image:3a": "子图块ID" }`；必须结合来源核验，采用后从修订阶段重建。

正文使用稳定元素占位符和邻接简述，例如 `[[image:元素ID]]（图 3：模块关系）`。行内公式也进入元素目录并由占位符引用。已被正文引用的元素不会又复制成独立正文块；未被引用的元素保留自己的位置。

标题树按真实层级建稳定节点，最深标题内递归细分，父标题引导段和无标题段保留。所有递归块继承原标题节点与路径；预算包含标题和说明，保持 Unicode、占位符、公式与代码边界。超过预算的不可拆科学元素进入核对列表，完整内容仍由元素目录保存。

每块扩写一段背景、两条中文问题与两条英文问题。扩写基于原文和标题背景，不得添加来源没有的数值；模型、提示版本和输入指纹参与缓存。格式或数值校验不通过时保存拒绝候选并反馈原因，最多尝试三次；配置错误直接进入等待配置。原文、背景、问题和元素说明分别索引，均指向同一原文块／元素，最终返回原文证据。

Milvus 按 Embedding 配置指纹分配正文和元素集合。集合包含 COSINE 稠密向量、BM25 稀疏向量及版本引用；每路取 50 个候选，先按正文／元素去重，再 RRF 融合，默认返回 10 个结果。创建时实际验证 jieba 中英文分词。确定性向量 ID 和持久化批次保证失败续传与重复提交不产生重复索引。

新索引校验完成后才事务切换发布代次。检索按对应发布版本还原占位符，返回图片、HTML 表格、LaTeX 公式、标题路径、页码、来源与过期标记。附件超出响应预算时返回待加载 ID，前端和 Pi 可按需读取。

## 迁移与 API

应用首次启动会保存迁移报告并执行纳管。手动操作时应先停止应用：

```powershell
node scripts/storage-migrate.mjs --scan
node scripts/storage-migrate.mjs --apply
node scripts/storage-migrate.mjs --rollback
```

`--scan` 只读文件系统，不创建清单。`--apply` 可重复执行，保留文献 ID、解析版本 ID、固定研读版本和现有附件链接。报告记录缺失、损坏、无归属或链接异常。迁移前清单位于 `data/storage/migration-backup/catalog-before-migration.sqlite`，旧索引镜像也有单独备份。

`--rollback` 恢复迁移前清单，同时保留迁移后清单副本与所有原文件。它用于回退纳管；后续资源删除、内容编辑和模型结果需分别按版本／回收站恢复，不能用迁移回滚撤销这些业务操作。回滚后使用兼容应用版本，避免新版本启动重新迁移。

| API | 用途 |
| --- | --- |
| GET /api/storage/resources | 按类型、生命周期、归属、名称／路径列资源 |
| GET /api/storage/resources/:id | 资源、版本、依赖、任务和索引代次 |
| GET /api/storage/resources/:id/content?revision=N | 查看当前或不可变历史内容 |
| PUT /api/storage/resources/:id | 文本更新，传 content 与 revision |
| PUT /api/storage/resources/:id/file | PDF 更新，application/pdf，X-Resource-Revision |
| DELETE /api/storage/resources/:id | 回收资源 |
| POST /api/storage/resources/:id/{restore,purge,rebuild} | 恢复、永久清理、重建 |
| POST /api/storage/resources/:id/repair | 以 revision 恢复缺失文件的受管内容 |
| POST /api/storage/resources/:id/adopt | 将未登记原始 PDF 登记为文献 |
| GET /api/storage/migration | 只读扫描报告 |
| GET /api/storage/operations；POST /:id/retry | 未完成操作及重试 |
| GET /api/ingestion/jobs；POST 同路径 | 列任务／使用 resourceId 启动 |
| POST /api/ingestion/jobs/:id/{pause,resume,cancel,retry} | 控制任务 |
| POST /api/rag/search | query、resourceIds、projectId、sourceType、elementType、limit |
| GET /api/rag/elements/:id?generationId=… | 指定版本元素 |
| GET /api/rag/reviews；GET /:id/evidence；PUT /:id | 核对列表、原图证据、采用／丢弃候选 |
| GET /api/rag/config；PUT 同路径 | 非敏感连接配置 |
| GET /api/storage/state/:namespace；PUT 同路径 | 偏好／草稿／布局，更新附 revision |
| GET /api/storage/events | 资源与任务变化 SSE |

原有论文、笔记、研读、选题与会话 API 仍然可用，由适配层执行受管操作。

## 验证与当前限制

```powershell
npm test
$env:PIPAPER_TEST_MILVUS='1'
node --test tests/rag-milvus.test.mjs
npm run build
```

存储／RAG 测试使用隔离临时目录，覆盖版本与 CAS、共享引用、外部文件保护、删除恢复、清理失败、取消及迟到响应、配置等待、检查点恢复、迁移回滚、目录发布、标题分块、脚注、公式和编号关联。Milvus 测试使用专用集合，完成后只清理测试集合。

`tests/fixtures/rag-recall.json` 包含 30 个固定中英文问题。真实 Milvus 的确定性词法向量与人工核验扩写夹具测试中，原文 Recall@10 为 0.8333，扩写后为 1.0。这证明索引、去重、混合召回和扩写表示的路径可用；它不代表真实百炼向量或科学文献的召回质量评估。

2026-10-05 恢复百炼付费调用后，真实 `text-embedding-v4` 请求成功返回 1024 维向量。随后使用 RRNCO 25 页论文已有的结构化解析版本，完成 GLM-4.6V 图片清洗、编号关联、35 个正文块的 DeepSeek 扩写、百炼向量、Milvus 写入及发布。当前发布有 210 条正文检索表示、147 条可用元素表示，另有 16 处公式、表格或引用疑点隔离在待核对列表。整篇仍属于部分覆盖，未宣称完成全部科学审校。

真实检索已核验中英文问题、标题路径和页码、图二原图、表二 HTML、公式占位符顺序与版本；Pi 的 `search_knowledge` 和 `get_knowledge_element` 实际执行成功，图二返回 80,729 字节 JPEG。默认 GLM-4.6V 和备用 DeepSeek 视觉模型均已完成真实图片调用。表五的第 18–21 页全部跟随正文编号引用还原。验收证据保存在 `data/validation/rrnco-rag-e2e.json`，界面截图位于 `data/rag-search-interface.jpg`。这次复用了已有原始解析，不代表重新评估全部 PDF 解析引擎。

真实百炼向量、DeepSeek 生成扩写和 Milvus 的 30 问对比已完成：原文 Recall@10 = 1.0，扩写 Recall@10 = 1.0，没有退步。测试问题未发送给扩写模型。该固定技术夹具基线已达到满分，尚不能证明扩写提升了真实文献召回率；后续需扩大科学文献评测集及难例。报告保存在 `data/validation/rag-recall-1791180195698.json`。

可显式重跑这项真实服务验收（会使用已配置的模型与 Embedding，产生实际 API 用量）：

```powershell
node --use-system-ca scripts/rag-recall.mjs
```

脚本只创建和清理专用 `pipaper_eval_` 集合，不改动文献发布索引。全量测试（含真实本地 Milvus）138 项通过，构建通过。

接口依据：[Milvus 部署](https://milvus.io/docs/install_standalone-docker-compose.md)、[百炼 Embedding](https://help.aliyun.com/zh/model-studio/text-embedding-synchronous-api)、[GLM 视觉](https://docs.z.ai/guides/vlm/glm-4.6v)、[DeepSeek 视觉](https://api-docs.deepseek.com/guides/vision/)。
