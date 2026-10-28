# 接入自己的 AI

按使用场景开始：[只有模型 Key 的用户教程](USER-GUIDE.md) · [已有 Agent 的接入手册](AGENT-GUIDE.md)。本页保留工具权限与完整协议，供接线开发者查阅。

共读数据由共读后端管理，AI 接入通过独立适配器完成。默认 Mock 用于验证页面与通信，不是真实模型。真实供应商/Agent 的兼容性需在使用者环境验证。

## 只有API Key：网页接入

设置→AI接入与人物预设→选DeepSeek或兼容接口→填Key→测试→保存。DeepSeek地址和模型预填，高级项可改模型、称呼和共读风格。人物预设可写身份、性格、语气和回复形式，模型在议题资料之前收到它；已有Webhook Agent仍使用自己的原身份。测试一般两次小型API请求，验证文字回复及强制原文工具调用；不发送私人书库。真实点击使用使用者自己的API余额。

只有匹配当前配置/当前用户且未过期的成功测试凭据才允许保存。配置变化需重测，凭据10分钟过期，revision防止跨窗口覆盖。Key在本实例DO中加密存储；GET只返回has_key，重开设置留空沿用。已保存配置优先于环境变量。具体首次部署见[从零开始](START-HERE.md)。

测试输入是一段原创短文：“这是一段用于验证共读接线的原创短文。”第一步要求模型调用 `read_source(start=0, limit=100)`；第二步把此短文作为工具结果交给模型，验证它能回复一句话。成功和失败都在设置表单显示结果；失败包括 Key 无效、余额不足、限流、超时或不支持工具。测试不发送现有书库，通常产生两次小型模型 API 请求。当前预设的人物与风格会绑定成功凭据，实际讨论才使用这些人物设定。

## AI 能否放书进书库？

本地新增候选另提供 `search_books` 和 `import_book`：在可选书库工具中独立开启“允许 AI 搜书并导入”，可检索开放书库并让后端下载完整原文。当前待发布，书源、流程、限制见 [开放书库说明](BOOK-CATALOG.md)。它与下方只保存文字的 `add_book` 分开授权。

书籍创建和文档上传的 HTTP 接口已经提供，见 [API](API.md)。已有 Agent 可以在自己的可信服务端接入这些接口，并使用该读者授权的服务端鉴权；阅读回合的 `source_access` token 只能读取当前议题原文，不能用来上传书。参考后端尚无专门的 Agent 限权上传 token 或网页授权入口；已有 Agent 在自己的可信服务器管理上传权限。

只填写模型 API Key 的共读模式默认仅开放 `read_source`。现在包中还提供可选的 `add_book(title, author?, content, format?)` 工具，在 **设置 → AI 接入 → 可选书库工具** 开启“允许模型新增文本书籍”，测试并保存后即可使用。例如在一个议题中说：“把上面整理的文字存成一本书，书名是《海边札记》。”模型决定调用工具，由自己的后端保存 TXT/Markdown 文本并返回书籍身份。它不具备联网找书、下载文件或读取电脑文件的能力，不能把生成的摘要假称为整本原书。

上传默认关闭；测试接口不上传书。每轮最多新增一本，正文最多100000字符，书籍和文档身份由后端生成；不能由模型选择 owner、已有 book_id、地址或凭据，也不提供覆盖或删除。写入按可信 owner 和 turn 幂等，新正文与版本继续通过现有冻结文档/R2流程；未完整保存的预约不会作为可读书出现在书架。定时议题不开放新增工具。已有 Agent 的 HTTP 上传和 Webhook 回调路径不受这个模型权限开关影响。

非 Cloudflare 宿主可复用 `src/core/model-adapter.mjs` 导出的 `ADD_BOOK_TOOL`，给 `runModel` 传入自己的 `addBook(args)` 回调；必须在可信服务器执行，并绑定已验证的读者和稳定回合身份。默认不传回调就不提供写入工具。使用纯服务端模型配置时，可设置 `MODEL_ALLOW_UPLOAD=true`；网页保存的配置及权限优先。

DeepSeek预设为官方Chat Completions完整地址和当前deepseek-flash模型，明确thinking disabled，适配当前文本工具循环。未提供思考模式历史reasoning_content持久化；不声明已支持该模式。说明与来源见[DeepSeek官方思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)。

## 已有 Agent：HTTPS Webhook

设置 `AI_MODE=webhook`、`AI_WEBHOOK_URL`、`PUBLIC_BASE_URL` 和独立 `AI_SHARED_SECRET`。每轮 POST 的协议为 `reading-turn-v1`，包括：

```json
{
  "protocol": "reading-turn-v1",
  "owner_id": "reader",
  "reader": { "user_id": "reader", "username": "海边读者" },
  "thread_id": "thread_demo",
  "turn_id": "turn_demo",
  "delivery_id": "delivery_demo",
  "session_id": "reading:reader:thread_demo",
  "book": { "title": "原创示例", "author": "示例作者" },
  "discussion": { "topic": "海边的告别", "status": "open" },
  "source": null,
  "source_link": "reading://source/thread_demo/doc_demo?version=1&sha=...",
  "user_message": { "message_id": "message_demo", "text": "你怎么看？" },
  "callback_url": "https://reading.example/api/reading/gateway/reply",
  "source_access": { "url": "https://reading.example/api/reading/gateway/source", "token": "scoped-capability" }
}
```

没有可读文档时 source_link 为 null；有摘录时 source 包含 exact、insight 和冻结版本身份。同一 turn 的书籍、议题与 reader 身份信息在首次准备时冻结，重试不随改名变化；升级前已冻结的旧回合可能不含 reader。新回合从后端登录归属及读者资料生成 reader，不采信消息正文里的身份字段。模型 API 同样收到 reader，用户名仅作为称呼资料，不能当作操作指令或授权。已有 Agent 使用 session_id 隔离短期议题会话，可用 reader.user_id 关联读者，继续使用自己的既有人格和长期记忆机制。

验证 `X-Webhook-Timestamp` 和 `X-Webhook-Signature-V2`：签名为 HMAC-SHA256(sharedSecret, `timestamp + "." + 原始UTF-8请求正文`)，输出小写十六进制；时间窗为300秒。不能先解析并重新序列化后再验签。

以 delivery_id 做持久化幂等：保存受理身份后返回 HTTP202：

```json
{ "status": "accepted", "delivery_id": "delivery_demo" }
```

网络失败可重试同一身份，Agent 必须返回同一受理结果，不能再次执行。原请求已受理但结果未知时先核查。参考后端对同一议题按用户消息顺序受理执行；前轮未知/未完成时后轮保留待处理。

完成后 POST callback_url，用相同规则签名。正文：

```json
{
  "protocol": "reading-reply-v1",
  "owner_id": "reader", "thread_id": "thread_demo",
  "turn_id": "turn_demo", "delivery_id": "delivery_demo",
  "actions": [{ "kind": "text", "index": 0, "count": 1, "text": "Markdown 回复正文" }],
  "terminal": { "status": "completed", "retryable": false }
}
```

回复消息和终态原子保存，完全相同的重复回调不会重复建消息。失败/cancelled 使用空 actions；终态要求 completed、failed 或 cancelled。每段文字最多12000字符。可选引用为 action.quote `{text,source_link}`，必须属于当前议题。可选 new_discussions 最多两项 `{title,opening,source_link?}`；它与普通引用分开，不把引用误当新议题。

可发送签名状态到 `/api/reading/gateway/status`，协议 `reading-status-v1`，包含 owner_id/thread_id/turn_id/status/retryable，不能用状态接口写 completed。旧回合状态不覆盖最新回合。

## 原文工具

适配器从已验证的 source_link 解析文档身份，将 source_access 的 token 放入 `Authorization: Bearer ...`，POST 固定 source_access.url：

```json
{ "thread_id":"thread_demo", "document_id":"doc_demo", "version":1, "sha":"...", "start":0, "limit":2000 }
```

token 绑定可信用户和单一议题，有效一小时。服务端再次验证该议题的文档、版本、摘要与范围；limit 上限4000。返回 text/start/end 等冻结范围信息。

模型只能提供 start/limit，不能自行设置服务地址、凭据、owner_id 或 thread_id。source_access 是宿主接线数据，不放进模型提示。书籍与摘录作为内容处理，不当成工具权限指令。

## Node Agent 接线示例

提供 [参考桥](../examples/agent-bridge/server.mjs)。在可信服务端设置环境变量 AI_SHARED_SECRET、READING_ORIGIN（共读HTTPS origin），可选 AGENT_DATA_DIR/PORT，然后运行：

```sh
node examples/agent-bridge/server.mjs
```

它只监听 loopback，通过自己的 HTTPS 反向代理暴露 `/reading/turn`。将 [replyWithYourAgent](../examples/agent-bridge/reply.mjs) 替换为对自己已有 Agent 的调用；默认函数明确返回模拟回复。

示例持久化受理和回复，重复投递使用缓存回复，回调重试不重新生成；重启仅恢复已有回复的回调。已经开始但没有结果的 Agent 调用需要宿主核查，不能自动再次生成。生产宿主应为它接入持久化任务系统、告警和人工协调机制。运行资料目录不提交 Git。

## 模型 API 适配

`AI_MODE=model` 使用 `src/core/model-adapter.mjs`，配置完整 MODEL_API_URL、MODEL_NAME 和服务端 MODEL_API_KEY。可配置 MODEL_SYSTEM_PROMPT。接口为 Chat Completions 的 messages/tools/tool_calls 文本协议，不使用供应商SDK。

发送当前议题与摘录，最多带回此前20条同议题消息。提供 read_source(start,limit) 工具，单轮最多4次/每次4000字符。调用后补入相应 assistant/tool 消息再继续生成。失败或结果不明不自动重复付费模型请求；新消息是新一轮明确请求。

该适配不是完整 Agent，不自动提供人格、长期记忆或其他工具，也未声明任意供应商已兼容。协议参考：[官方 Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[工具调用](https://developers.openai.com/api/docs/guides/function-calling)。发行验证使用替身，不调用真实或付费模型。
