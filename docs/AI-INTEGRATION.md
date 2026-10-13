# 接入自己的 AI

共读数据由共读后端管理，AI 接入通过独立适配器完成。默认 Mock 用于验证页面与通信，不是真实模型。真实供应商/Agent 的兼容性需在使用者环境验证。

## 只有API Key：网页接入

书架点击“连接自己的AI”→选DeepSeek或兼容接口→填Key→测试→保存。DeepSeek地址和模型预填，高级项可改模型、称呼和共读风格。测试一般两次小型API请求，验证文字回复及强制原文工具调用；不发送私人书库。真实点击使用使用者自己的API余额。

只有匹配当前配置/当前用户且未过期的成功测试凭据才允许保存。配置变化需重测，凭据10分钟过期，revision防止跨窗口覆盖。Key在本实例DO中加密存储；GET只返回has_key，重开设置留空沿用。已保存配置优先于环境变量。具体首次部署见[从零开始](START-HERE.md)。

DeepSeek预设为官方Chat Completions完整地址和当前deepseek-flash模型，明确thinking disabled，适配当前文本工具循环。未提供思考模式历史reasoning_content持久化；不声明已支持该模式。说明与来源见[DeepSeek官方思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)。

## 已有 Agent：HTTPS Webhook

设置 `AI_MODE=webhook`、`AI_WEBHOOK_URL`、`PUBLIC_BASE_URL` 和独立 `AI_SHARED_SECRET`。每轮 POST 的协议为 `reading-turn-v1`，包括：

```json
{
  "protocol": "reading-turn-v1",
  "owner_id": "reader",
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

没有可读文档时 source_link 为 null；有摘录时 source 包含 exact、insight 和冻结版本身份。同一 turn 的书籍与议题信息在首次准备时冻结。已有 Agent 使用 session_id 隔离短期议题会话，继续使用自己的既有人格和长期记忆机制。

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
