# 公共服务发布记录 · 2026-10-15

维护者已确认本地结果并明确授权部署和发布 APK。

- 入口：https://reading.nyachu.site/app
- APK：https://reading.nyachu.site/download/app.apk
- 运营入口：https://reading.nyachu.site/owner，使用独立运营密钥。
- 共读岛源码版本 0.5.0；Android 包名 site.nyachu.reading，客户端版本 1.0.0，Android 8.0+。
- 流程：先注册账号并提交申请，运营者批准并分配额度，使用者刷新后进入自己的书架。账号密码由申请者自行设置，没有独立申请码。
- 首次开放 3 个审批名额；上线校验后 0 个注册账号、0 个获批账号，临时零额度测试申请已移除。本地示例书库没有复制上线。
- 用户自备 AI Key。每账号建议配额为 20 本书、200 个议题、100 MiB 存储、600 次模型 HTTP 请求、每日 1000 次业务接口请求；须由运营者审批，扩容同样需要申请。
- 公共服务使用独立 Worker、Registry 与每账号的 HostedReadingLibraryDO，书籍按 SQLite 分块保存，不要求 R2 激活。默认自行部署版继续使用自己的 R2，不与公共服务共享资源。

验证：隔离冻结源码与准确 Worker 产物共 54 项测试通过；内容检查通过，依赖漏洞 0。线上 HTTPS、申请页、未登录/未获批拦截、注册/退出/密码登录、已发布 UI 字节及 APK 下载哈希通过。真实模型仅以协议替身测试；用户需要用自己的 Key 测试兼容性。Android 真机文件选择、下载、键盘和系统返回仍待实机验收。

APK SHA-256：`cfc9c1ba6040cfff93aa33c12258115854597985305c97bbc1d5d8702304a385`，大小 20,957 字节。APK v2/v3 签名验证通过；签名证书 SHA-256：`d4e07a17a60dc81f9e9bbbc63b4e89527313df08502ece50a9148fd4fac57ec6`。密钥不进入仓库或 APK。

运营与升级规则见 [公共服务文档](../public-service/README.md)。更新前备份该公共服务与审批/书库状态，保留现有 namespace、迁移历史和密钥。回滚应用代码时保留账号及书籍数据。
