# 共读 HTTP 接口

参考后端统一前缀 `/api/reading/`。浏览器使用 HttpOnly 会话 Cookie；服务端可用已签名会话的 Bearer token。身份由后端验证，请求体里的 owner/user 字段不决定归属。修改请求拒绝跨源浏览器 Origin。

| 请求 | 行为 |
| --- | --- |
| GET/PATCH `/profile` | 本人的登录资料 `user_id,username,revision`；PATCH 仅接收 `username`（1–60字符）和当前 revision，不能改用户 ID |
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

AI设置另有：GET `/api/ai-settings`（无Key正文），POST `/api/ai-settings/test`（provider/api_url/model/api_key/name/system_prompt/persona/allow_upload），PUT `/api/ai-settings`（相同字段+proof+revision）。persona最多12000字符，为模型在议题资料之前收到的人物预设。只允许已登录读者访问，写入拒绝跨源；空api_key表示沿用本人已保存的Key。test使用小型合成内容调用所填服务，返回短时测试凭据；save校验当前配置及用户，未测试或更改配置返回409。测试会使用所填服务的余额，不自动重试。

定时设置：GET/PUT `/api/topic-schedule`，仅读者本人可读写。字段 `enabled,frequency:daily/weekly,time:HH:mm,weekday:0..6,timezone,scope:all/reading/group/books,group_id,book_ids,instruction,revision`；空group_id表示堆放。返回 `next_run`（UTC毫秒）和最近 `runs`。启用需已配置AI及有效书籍范围，revision冲突返回409；暂停删除后端闹钟。执行语义见[定时议题](TOPIC-SCHEDULE.md)。

TXT/Markdown 规范换行；HTML 提取正文；DOCX/EPUB 解析无加密正文及章节，复杂文件可能退回原件模式。PDF、旧 DOC 和 Kindle 格式只保留原件，没有 OCR、DRM 解密或精准阅读承诺。

偏移使用 UTF-16 code unit，范围不切开代理字符。R2 保存原始字节、冻结规范文本、摘要和分块清单，旧版本引用不随新上传重解释。

独立元数据实现位于 `src/cloudflare/`。其他后端可以实现上述接口与身份/冻结/幂等语义，不要求使用相同数据库结构。
