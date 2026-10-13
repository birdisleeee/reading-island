# Cloudflare 参考部署

本实现使用 Worker 提供 API、SQLite Durable Objects 保存元数据和讨论、R2 保存书籍原件及冻结文本；静态 UI 随 Worker assets 部署。其他后端需适配 [API](API.md)，不要求复制 Cloudflare 存储实现。

## 本地

运行 `npm ci`，将 `.dev.vars.example` 复制为 `.dev.vars`，然后 `npm run dev`。访问 `http://127.0.0.1:4187/reading-island/`。数据在本项目 `.wrangler/` 的隔离开发存储中，不连接线上书库。

## 部署自己的实例

1. 登录自己的 Cloudflare 账户：`npx wrangler login`。
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

模型：配置 `MODEL_API_URL`（完整 HTTPS Chat Completions 地址）、`MODEL_NAME`，并录入 `MODEL_API_KEY`。可选 `MODEL_SYSTEM_PROMPT` 只用于轻量模型适配，不修改外部 Agent。

Agent：配置 `AI_WEBHOOK_URL`（完整 HTTPS 接收地址）与 `PUBLIC_BASE_URL`（共读站点 HTTPS origin），并录入 `AI_SHARED_SECRET`。详见 [协议](AI-INTEGRATION.md)。初次先保留 Mock 验证书库，再测试所选真实接线。

## 数据与升级

元数据按可信 `user_id` 使用独立 DO；R2 前缀也按用户和书籍隔离。默认密码登录对应 `DEFAULT_USER_ID`，宿主集成可签发不同用户的受保护会话。

保存原件、规范文本、分块和 manifest 后才切当前版本。旧版本、旧引用和讨论保留。升级前由部署者保存现有资源和数据备份，保留 migration 历史及原 namespace/bucket；回退代码时不要删除书库资源或创建空库代替旧库。

首版没有自动备份/导出工具。Cloudflare 账户、云资源和模型调用费用由部署者承担；没有由项目维护者托管的共享在线服务。

实现依据：[Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/configuration/)、[SQLite Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)。
