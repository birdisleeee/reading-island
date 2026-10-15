# 共读岛公共服务适配器

独立于默认单人部署的可选托管入口。目标域名 `reading.nyachu.site`，提供网页、APK、注册申请、人工审核与限额存储。申请默认待审核、零额度。用户填写自己的模型 Key，服务端按用户以 AES-GCM 加密保存；运营者不提供公共模型余额。

## 审批和额度

沿用同系列公共服务的申请、审核、预算和扩容规则：初始最多 3 个 active 账号、30 个注册账号、10 个待审核申请，公共接口每日 3000 次。待审核和暂停账号不能进入书库；已有会话实时检查状态。运营入口 `/owner` 使用独立密钥，不占每日业务请求预算。

| 额度 | 每账号建议值 | 总分配预算 | 计量方式 |
| --- | ---: | ---: | --- |
| 书籍 | 20 | 60 | 包含归档和未完成导入的预留 |
| 议题 | 200 | 600 | 包括已结束的历史议题 |
| 存储 | 100 MiB | 300 MiB | SQL UTF-8、原件、冻结全文、分块、manifest、封面，每记录/对象加 256 字节预留 |
| AI 请求 | 600 | 1800 | 每次向模型发送 HTTP 前计数，含测试、失败、工具续答；累计不重置 |
| 每日业务请求 | 1000 | 3000 | UTC 零点，即北京时间 08:00 重置 |

运营者批准时可在总预算内调整额度。扩容申请填写新的总额度，申请本身不授予额度。暂停保留数据和预算。书库按可信 UUID 使用独立 SQLite DO，原件和冻结文本按账号、书籍前缀隔离存入该 DO 的 SQLite 分块表。SQL 写入和对象预留在同一 DO 内校验；失败上传保留预留，同键重试不重复计量。逻辑配额不等于平台索引、日志和网络等实际计费；同一平台账户的服务上限仍共享。

## 部署与维护

1. `npm ci && npm run build`，先验证本地申请、审核与书库。
2. 修改本目录 `wrangler.jsonc` 中 Worker、域名和速率限制 namespace ID，使用独立新资源；公共版使用已有可用的 SQLite DO 能力，不要求额外激活 R2。
3. 为本配置设置不同的随机 Secret：INTERNAL_KEY、OWNER_KEY、SESSION_SECRET，每个至少 32 字符。不配置默认读者密码或共享模型 Key。长期保留 SESSION_SECRET，变更它会使已有模型 Key 不可读。
4. 本地验收后 `npx wrangler deploy --config public-service/wrangler.jsonc`；缺少密钥时服务拒绝开放。
5. 设置环境变量 PUBLIC_SERVICE_URL、PUBLIC_OWNER_KEY，运行 `node public-service/bootstrap.mjs`，只为首次空服务初始化政策；既有实例拒绝重复初始化。
6. 在 `/owner` 审核真实申请。本地演示账号和数据不能复制到生产。
7. 按 `../android-app/README.md` 构建 APK，复制到构建产物 `dist/assets/download/reading-island.apk`，与静态资源一同发布，下载入口 `/download/app.apk`。

升级前备份公共代码、审批状态和存储，保留既有绑定、迁移及密钥；回滚不删除 namespace。默认自部署配置保持独立。公共版不启用 Agent Webhook；自部署版已有 Agent 接口保持。未配置模型时显示明确的 Mock 演示；真实兼容性由使用者连接测试验证。定时任务默认关闭，运行时仍检查审批和 AI 额度。暂停取消 Alarm；重新启用后需重新保存定时计划。

会话使用 HttpOnly、Secure、SameSite=Strict Cookie。注册、登录、下载和业务有请求体上限及限流。运营密钥不可放入 URL、APK 或仓库。申请不触发通知。

注册保存账号、称呼、联系方式、用途和密码哈希；获批后保存书籍、讨论和加密模型设置。AI 调用会将共读上下文发送给用户选择的模型服务商。请只上传有权使用的内容，并联系运营者处理账号或数据删除。

registry.js、security.js 和 Android 外壳从同作者的 MIT 项目 photo-booking 公共服务实现改编，完整许可见 THIRD-PARTY-LICENSE.txt。Android 键盘、系统文件选择器和系统返回仍需实机验收。
