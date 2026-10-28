# 共读岛 Android 客户端

直接安装使用：[下载 APK](https://reading.nyachu.site/download/app.apk) · [申请与共读教程](../docs/USER-GUIDE.md)。下文面向自行构建 APK 的维护者。

原生 Java WebView 外壳，默认连接 https://reading.nyachu.site/app。网页版和 APK 共用账户、审批和数据；安装后联网申请，获批后填写自己的模型 Key。不提供离线提交或原生系统推送。

客户端关闭 WebView 原生横向、纵向滚动条，网页也统一隐藏滚动条；仍可正常触摸滚动。源码变更需重新构建 APK 后才会进入客户端版本。

包名 site.nyachu.reading，Android 8.0+。已发布的 1.1.1（versionCode 3）增加应用内更新，申请 INTERNET 和 REQUEST_INSTALL_PACKAGES；安装仍由用户在系统界面确认。无 JavaScript 原生桥接、明文流量或混合内容，证书错误直接拒绝。书籍通过系统文档选择器读取临时 content URI，不申请全盘存储权限。更新包只保存在本应用缓存，安装器通过临时只读 content URI 读取，不能访问其他文件。服务器仍检查书籍格式、签名和大小。

APK 不保留原生“账户 / 分享 / 刷新”工具栏；登录页也不显示网页宣传区或 APK 下载入口。默认显示登录，下方注册链接进入注册申请；独立自行部署仍使用自己的访问密码，不走公共服务审批。

## 应用内更新

应用启动/回到前台时最多每 6 小时检查一次，账号页面底部“检查应用更新”可随时手动检查。发现更高 versionCode 后显示版本、更新说明和大小，用户确认后才下载；“稍后”暂停该版本自动提醒 24 小时。下载显示进度并可取消，不静默安装、不自动重试失败下载。

下载仅允许同一 HTTPS origin 的固定 APK 路径，拒绝跳转；文件最多 32 MiB，严格校验实际大小、SHA-256、包名、版本号及与已安装应用相同的签名证书。首次安装授权由本人在安卓系统设置中开启；拒绝、取消、校验失败或网络断开都可继续阅读。缓存安装包可再次校验后重试安装。

更新信息为公开的 `/download/android-update.json`，无需获批账号，不消耗 AI 请求或账号业务配额。元数据缺失、离线或检查失败时自动检查安静退出，手动检查会提示原因。网页功能依旧随服务更新，不必每次重新安装。

旧版 1.0.0 尚无原生检查能力；公共账号网页会为旧 Android WebView 提示下载新版。用户需先下载并覆盖安装一次 1.1.1，此后才有原生检查入口。网页提示只在公共账户页显示；新版客户端以 User-Agent 版本标记避免重复提醒。

构建后输出 `build/reading-island.apk` 和 `build/android-update.json`。必须保留原签名并递增 versionCode；签名或包名改变不能按本流程覆盖升级。将经过签名验证的一对产物同时放入公共服务 assets：

```sh
node tools/stage-android-release.mjs /path/to/reading-island.apk /path/to/android-update.json dist/assets
```

先运行网页构建，再执行此命令，最后从同一冻结目录部署公共服务。勿手工填写文件哈希或单独发布“未来版本”信息，否则客户端会拒绝不匹配的下载。发布前需要安卓真机验证授权、系统安装确认、取消后重试和覆盖安装后的账号/书库。

构建需要 Python 3、JDK 17、Android API 35 与 build-tools 35.0.0，无 Gradle 依赖。设置 ANDROID_SDK_ROOT，可选 ANDROID_PLATFORM_JAR 和 ANDROID_BUILD_TOOLS；设置 APK_KEYSTORE、APK_KEY_ALIAS=reading-island、APK_STORE_PASSWORD、APK_KEY_PASSWORD，执行 python3 build.py，输出 build/reading-island.apk。签名密钥必须放在仓库外并长期备份，后续升级沿用同一签名。

自行部署时修改 BASE_URL、包名、图标并使用自己的签名。许可见 ../public-service/THIRD-PARTY-LICENSE.txt。发布前校验包名、域名和 v2/v3 签名；键盘、文件上传和系统返回需要安卓真机验收。
