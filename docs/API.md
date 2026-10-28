# 共读 HTTP 接口

公共服务的 Android 更新候选另有公开 GET/HEAD `/download/android-update.json`：schemaVersion、packageName、versionCode、versionName、minSdk、apkUrl、bytes、sha256、signerSha256、notes。返回 no-store；尚未准备元数据时返回 503 updates_unavailable，其他方法为 405。它不授予书库访问权限。发布与签名校验见 [Android 说明](../android-app/README.md#应用内更新)。

参考后端统一前缀 `/api/reading/`。浏览器使用 HttpOnly 会话 Cookie；服务端可用已签名会话的 Bearer token。身份由后端验证，请求体里的 owner/user 字段不决定归属。修改请求拒绝跨源浏览器 Origin。

| 请求 | 行为 |
| --- | --- |
| GET/PATCH `/profile` | 本人资料 `user_id,username,avatar_data,revision`；PATCH 接收 `username`（1–60字符）、当前 revision 和可选头像，不能改用户 ID |
| GET `/{groups,books,documents,annotations,threads,messages}` | 游标分页；`after`、`limit`（默认50/最多100），可筛选 `book_id`；messages 可筛选 `thread_id` |
| GET `/{resource}/{id}` | 单条读取 |
| POST `/{groups,books,annotations,threads}` | 创建，稳定 id 支持同请求幂等重试 |
| PATCH `/books/{id}` | 修改资料，需要当前 revision |
| PUT `/documents/{id}?book_id=...&filename=...` | 上传原始字节，最多25MiB；发布不可变文档版本 |
| GET `/documents/{id}/{original,text}` | 原件或规范正文 |
| GET `/documents/{id}/source?book_id=...&version=...&sha=...&start=...&limit=...` | 已登录读者范围读取，上限4000个UTF-16单位 |
| POST `/annotations` | `annotation_id,book_id,document_id,start,end,exact,insight,purpose`；服务器回读验证 exact，purpose 可为 excerpt/discussion |
| POST `/threads` | `thread_id,book_id,title,opening,opening_message_id,turn_id,delivery_id`，可附 annotation_id/document_id |
| POST `/threads/{id}/messages` | `message_id,turn_id,delivery_id,text`，同一 turn 不重复建消息 |
| POST `/threads/{id}/retry` | `turn_id`，重用原投递身份；模型失败终态不自动重生成 |
| PATCH `/threads/{id}` | `status: open/closed` 和 revision；结束与重开保留历史 |
| GET `/threads/{id}/context` | 当前书籍、议题、摘录和冻结原文引用 |
| GET `/unread`；POST `/threads/{id}/read` | 未读摘要；read 使用已加载的 message_id |
| PUT `/books/{id}/cover?revision=...` | 上传PNG/JPEG/WebP封面，最多8MiB |
| PATCH `/documents/{id}/chapters` | revision 和章节范围 |
| POST `/documents/{id}/progress` | `start` 阅读位置 |

错误返回 `{ "error": "code" }`：401 未登录、403 无权限/跨源、404 不存在、409 版本/幂等/摘录冲突、413 超限、415 格式、503 未配置/暂不可用。修改时使用返回的 revision；冲突后刷新，不覆盖其他客户端修改。

网页首次导入时，POST `/books` 可附 `import_document_id`：书籍先作为隐藏预约保存，只有该文档完成冻结上传后才原子出现在书架。失败时可用原 book/document ID 和相同内容重试；换文档 ID 返回409。已有不带此字段的 Agent 创建/上传保持原行为。文档 PUT 的成功响应附 `book_snapshot`，包含该上传后书籍的当前资料与 revision，客户端无需依赖后续列表读取来确认保存结果。

## 格式边界

搜书候选另有 POST `/api/book-catalog/search` 和 `/api/book-catalog/import`；账号隔离、书源及额度见 [开放书库说明](BOOK-CATALOG.md)。AI 设置可选布尔字段 `allow_catalog`，默认关闭，修改后需要重新测试。

AI设置另有：GET `/api/ai-settings`（无Key正文），POST `/api/ai-settings/test`（provider/api_url/model/api_key/name/system_prompt/persona/allow_upload），PUT `/api/ai-settings`（相同字段+proof+revision）。persona最多12000字符，为模型在议题资料之前收到的人物预设。只允许已登录读者访问，写入拒绝跨源；空api_key表示沿用本人已保存的Key。test使用小型合成内容调用所填服务，返回短时测试凭据；save校验当前配置及用户，未测试或更改配置返回409。测试会使用所填服务的余额，不自动重试。

定时设置：GET/PUT `/api/topic-schedule`，仅读者本人可读写。字段 `enabled,frequency:daily/weekly,time:HH:mm,weekday:0..6,timezone,scope:all/reading/group/books,group_id,book_ids,instruction,revision`；空group_id表示堆放。返回 `next_run`（UTC毫秒）和最近 `runs`。启用需已配置AI及有效书籍范围，revision冲突返回409；暂停删除后端闹钟。执行语义见[定时议题](TOPIC-SCHEDULE.md)。

TXT/Markdown 规范换行；HTML 提取正文；DOCX/EPUB 解析无加密正文及章节，复杂文件可能退回原件模式。PDF、旧 DOC 和 Kindle 格式只保留原件，没有 OCR、DRM 解密或精准阅读承诺。

偏移使用 UTF-16 code unit，范围不切开代理字符。R2 保存原始字节、冻结规范文本、摘要和分块清单，旧版本引用不随新上传重解释。

独立元数据实现位于 `src/cloudflare/`。其他后端可以实现上述接口与身份/冻结/幂等语义，不要求使用相同数据库结构。

## 持久搜书任务（公共服务于2026-10-24上线）

GET `/api/book-catalog/jobs` 读取本人最近 20 条任务。POST 同一路径提交 `{job_id,type:"search",query,language?}` 或 `{job_id,type:"import",candidate_id,group_id?,search_job_id}`。稳定 job_id 去重，不同内容复用 ID 返回409；最多同时三个未完成任务。返回 queued/running/succeeded/failed，成功附 result，失败附错误码，不自动重发网络请求。关闭客户端不取消已接收任务。旧同步 search/import 与模型工具保持兼容。

2026-10-25已上线只读 GET `/api/book-catalog/usage`，返回 `day`（UTC日期）、`reset_at`（下次UTC零点ISO时间）、`searches/imports: {used,limit,remaining}`；GET jobs 同时附 `usage`。读取不重写前一日预算，缓存命中或已完成的重复导入不扣次数，实际失败尝试仍按原规则计数。页面自动同步真实数值，不预估扣次。`catalog_timeout` 表示书源响应超时，`catalog_unavailable` 表示未取得有效连接/响应；成功的空 `items` 才表示本次未找到可导入版本。本段已随2026-10-25公共服务更新上线。

同日上线的维护版本把新失败分为 `catalog_timeout`、`catalog_network_error`、`catalog_http_error`、`catalog_rate_limited`、`catalog_redirect_rejected`、`catalog_invalid_response` 和 `catalog_service_error`。失败任务附 `diagnostic`：固定枚举 `source/phase/reason`、可选上游 HTTP `status` 和 0–180000 毫秒的 `elapsed_ms`。网络阶段包括 request/headers/body/decode/validate；服务阶段包括 grant_before/search/import/grant_after/persist。仅在运行时实际提供 DNS/TLS 错误代码时才使用相应分类，否则标为连接失败，不从异常文本猜测。

诊断与任务一同持久化，只能由该读者读取；不包含原始异常、堆栈、完整请求地址、响应正文、Cookie 或 Key，不新增日志平台或定时检查。`updated_at` 是故障记录时间，`created_at` 仅表示提交时间。旧 `catalog_unavailable` 记录没有补造诊断，无法追溯其具体原因。等待时限、人工重试和失败计次规则保持。这些维护变更已随2026-10-25公共服务更新上线。

公共版登录资料额外返回 `login_id`（注册账号），`user_id` 保留原内部身份以维持数据归属；公共 `/api/session` 另附 `hosted:true`。AI 议题上下文同时保留内部身份与注册账号。

头像只接收不超过49152字符、256×256的规范 JPEG data URI；省略 `avatar_data` 保留旧头像，空字符串清除。原图留在本地裁剪器，不进入 Agent 上下文。公共版另返回固定 `login_id`。

## 静态书目检索（2026-10-27 已上线）

公共服务已于 **2026-10-27** 发布静态书目检索，保持 `/api/book-catalog/search`、`/import`、`/jobs` 和 `/usage` 的身份、输入、队列、计次及幂等语义，改用打包在 `ASSETS` 中的官方书目快照检索。快照日期为 `2026-10-25`，包含官方 CSV 中 `Type=Text` 的 78,423 条元数据，共 7,941,383 字节；只包含 ID、标题、作者和语言。

`search` 及 search 类型的任务在本人 Durable Object 内检索快照，不向外部书源发送 query。成功结果保留 `query/language/items/notice`，另附 `catalog_snapshot: "2026-10-25"`；快照候选附 `metadata_snapshot: true` 和 `requires_verification: true`，提示其下载格式及权利尚待导入时核验。`candidate_id` 仍为 `gutenberg_<ID>`。大小写、重音和关键词按标题/作者匹配；部分中文别名会展开为外文作品名称。“面纱”可匹配 `gutenberg_64682 / The Painted Veil / languages:["en"]`，不是中文译本；`language:"zh"` 不会返回该英文候选。仅标点、规范化后无有效关键词的查询返回 400 `invalid_catalog_input`。

`ASSETS` 资源返回 404 才使用旧 Gutendex 固定接口回退；资源读取失败、损坏或记录校验失败返回 503 `catalog_service_error`，不会把损坏索引解释为空结果。快照搜索成功但 `items:[]` 表示该快照下没有匹配版本，不表示所有书源都没有此书。

快照候选导入时，服务仅请求所选 ID 的 RDF，验证该记录的 ID、`dcterms:rights` 中的 `Public domain in the USA.` 和 `dcterms:format` 中的 UTF-8 TXT 声明，再请求该 ID 的 TXT；不抓取网页搜索结果，不接收用户传入的下载 URL。RDF 最多 256 KiB、20 秒，TXT 最多 10 MiB、60 秒；正文仍检查 UTF-8 与完整起止标记。版本权利/格式不满足时返回 422 `catalog_version_unavailable`，其他网络和文件错误保留既有安全诊断分类；不会自动重试。

RDF 验证和后续 TXT 下载合计一次导入尝试，每日 10 次新检索/3 次导入尝试、失败计次、缓存免重复扣次、原有任务上限和跨用户隔离保持。正常构建只复制静态文件，不联网、不安装搜索引擎或数据库、不新增 cron。维护者手动更新方法与来源署名见 [catalog/README.md](../catalog/README.md)，使用说明见 [开放书库说明](BOOK-CATALOG.md#static-catalog)。
