# Cloudflare 参考部署

本实现使用 Worker 提供 API、SQLite Durable Objects 保存元数据和讨论、R2 保存书籍原件及冻结文本；静态 UI 随 Worker assets 部署。其他后端需适配 [API](API.md)，不要求复制 Cloudflare 存储实现。

普通使用者优先阅读 [浏览器部署流程](START-HERE.md)，或让自己的 LLM 按 [操作指引](LLM-DEPLOY-GUIDE.md)教学。下方保留命令行备用流程。

定时共读使用同一ReadingLibraryDO的Alarm，无需新增Cron/binding或改既有migration。更新自己的实例到新版后，可在“设置 → 议题设置”启用；默认暂停。见[定时说明](TOPIC-SCHEDULE.md)。

## 本地

运行 `npm ci`，将 `.dev.vars.example` 复制为 `.dev.vars` 并填入两个不同随机值 READER_TOKEN/SESSION_SECRET，然后 `npm run dev`。访问 `http://127.0.0.1:4187/reading-island/`。数据在本项目 `.wrangler/` 的隔离开发存储中，不连接线上书库。

## 部署自己的实例

1. 登录自己的 Cloudflare 账户：`npx wrangler login`。
   随后运行 `npx wrangler whoami` 核对选中自己的账户；先在自己的Dashboard开通R2，订阅/支付确认由本人完成。
2. 调整 `wrangler.jsonc` 的 Worker 名和 R2 bucket 名，确保它们是自己为共读创建的独立资源。
3. 创建 bucket：`npx wrangler r2 bucket create reading-island-books`（按你的实际名字替换）。
4. 运行 `npm run deploy`，创建 Worker 和独立 `ReadingLibraryDO` SQLite namespace。首次缺少登录密钥时，登录 API 会返回 503。
5. 使用下列命令分别录入强随机密码/密钥，值通过交互输入，不写入 Git：

```sh
npx wrangler secret put READER_TOKEN
npx wrangler secret put SESSION_SECRET
```

已有 Agent 接线还需 `npx wrangler secret put AI_SHARED_SECRET`。模型 API 接线还需 `npx wrangler secret put MODEL_API_KEY`。

登录的 `READER_TOKEN` 是本实例默认读者访问密码。`SESSION_SECRET` 签发 HttpOnly 会话 Cookie，应该独立于密码和 Agent 密钥。推荐使用密码管理器生成至少 32 字符随机值。示例文件中的本地值不能用于线上。

在 `wrangler.jsonc` 的 `vars` 设置 `AI_MODE`、`AI_NAME` 和相关非敏感配置，运行 `npm run deploy` 更新。`THEME_ACCENT` 和 `THEME_ACCENT_TEXT` 可配置六位十六进制颜色。浏览器不会收到模型 key 或服务共享密钥。

API Key用户可保留默认Mock，部署后在书架“连接自己的AI”选择DeepSeek/兼容接口，测试成功再保存。无需设置MODEL_API_KEY等环境变量。Key连同模型设置在本人的DO中以AES-GCM加密保存，SESSION_SECRET派生加密密钥；旋转SESSION_SECRET后需要重新填写模型Key，书库/讨论不删除。修改DEFAULT_USER_ID会进入不同数据空间，不应为更新随意更改。

模型：配置 `MODEL_API_URL`（完整 HTTPS Chat Completions 地址）、`MODEL_NAME`，并录入 `MODEL_API_KEY`。可选 `MODEL_SYSTEM_PROMPT` 只用于轻量模型适配，不修改外部 Agent。

Agent：配置 `AI_WEBHOOK_URL`（完整 HTTPS 接收地址）与 `PUBLIC_BASE_URL`（共读站点 HTTPS origin），并录入 `AI_SHARED_SECRET`。详见 [协议](AI-INTEGRATION.md)。初次先保留 Mock 验证书库，再测试所选真实接线。

## 数据与升级

元数据按可信 `user_id` 使用独立 DO；R2 前缀也按用户和书籍隔离。默认密码登录对应 `DEFAULT_USER_ID`，宿主集成可签发不同用户的受保护会话。

保存原件、规范文本、分块和 manifest 后才切当前版本。旧版本、旧引用和讨论保留。升级前由部署者保存现有资源和数据备份，保留 migration 历史及原 namespace/bucket；回退代码时不要删除书库资源或创建空库代替旧库。

首版没有自动备份/导出工具。Cloudflare 账户、云资源和模型调用费用由部署者承担；可选公共托管方案及独立部署边界见 [公共服务适配器](../public-service/README.md)。

实现依据：[Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/configuration/)、[SQLite Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)。
