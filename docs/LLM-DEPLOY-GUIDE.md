# 把这份说明交给你的 LLM

可以把下面的指令复制给你自己的 ChatGPT、其他聊天模型或有终端/浏览器能力的编程助手。普通聊天模型负责逐步教学；能操作电脑的助手可执行你授权的步骤。账户注册、支付/订阅确认和授权页面由你本人完成。

```text
请协助我把共读岛部署到我自己的 Cloudflare 账户：
https://github.com/birdisleeee/reading-island

先读取仓库当前 README、docs/START-HERE.md、docs/DEPLOYMENT.md、wrangler.jsonc、package.json 和 .dev.vars.example。不要按过时模型名、旧 Cloudflare 菜单或你记忆中的部署方法猜测。需要确认的平台行为，查其官方当前文档。

我的目标：独立部署一次，以后在网页选择 DeepSeek，填写我自己的 API Key，测试成功后保存，用它与我共读。优先使用仓库“Deploy to Cloudflare”按钮。不要让我先配置 Agent、Webhook、Tunnel、自定义域名或服务器。

请先确认我现在用电脑还是手机，以及是否已有自己的 GitHub 和 Cloudflare 账户。按当前环境选择浏览器部署或命令行备用流程，每次给一个可操作步骤和成功标志，不一次丢给我大量术语。

我本人完成注册、GitHub/Cloudflare授权与R2订阅/支付确认。只使用我选定的账户，不能使用项目作者、助手或其他人的账户、凭据和资源。不购买域名或开通额外付费产品来绕过错误。R2若要求支付信息，应先说明实际页面要求，由我决定并完成。

密码/密钥由我直接填写在自己的 Cloudflare Secrets 或部署表单中，不发给你、不写到聊天、Git或截图。READER_TOKEN是网站访问密码，SESSION_SECRET是独立随机密钥，不是DeepSeek Key。SESSION_SECRET用于登录和配置加密，应保留；默认数据空间的DEFAULT_USER_ID不要随意修改。

仓库使用 Worker + SQLite ReadingLibraryDO + R2 BOOK_BUCKET + ASSETS。按实际 Wrangler 配置创建自己的资源，保留binding名。先检查是否已存在同名资源，重用本实例已有资源；不要覆盖其他项目或删除旧书库。若选择命令行，先用whoami核验账户，再安装/构建、创建明确的新bucket并部署；模型Key仍由我在网站填写。

部署成功后，帮我找到自己的workers.dev地址，登录并打开“设置 → AI 接入与人物预设”。DeepSeek预设地址和模型名称以当前仓库及官方文档为准。我本人在网页输入API Key，点击“测试连接”，这会使用少量我自己的API余额；成功后保存。不要读取或回显我输入的Key，不自动反复测试或重试付费请求。

验收：自己的账户中有正确Worker/bindings；网站可登录；配置测试验证文字与原文工具；保存后刷新仍显示已连接且不回显Key；上传原创样例书，发起一轮真实讨论并收到回复，刷新后历史保留。未经这轮实际验证，不说“已完全部署成功”或“真实DeepSeek已通过”。

若报错，先记录脱敏状态码和所在步骤，逐项排查账户、R2、构建或模型配置。绝不reset/删除资源、公开密钥或更换账户凑结果；遇到需要新增付费服务或影响其他项目的操作，向我说明并取得具体授权。
```

使用手机且浏览器部署受阻时，可在有电脑后使用备用命令行流程；不要为了迁就手机把服务部署到别人的账户。网站部署成功后，日常共读可以在手机上进行。
