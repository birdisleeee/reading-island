# 共读岛 Android 客户端

原生 Java WebView 外壳，默认连接 https://reading.nyachu.site/app。网页版和 APK 共用账户、审批和数据；安装后联网申请，获批后填写自己的模型 Key。不提供离线提交或原生系统推送。

包名 site.nyachu.reading，Android 8.0+，仅 INTERNET 权限。无 JavaScript 原生桥接、文件系统访问、明文流量或混合内容，证书错误直接拒绝。通过系统文档选择器读取临时 content URI，不申请全盘存储权限。服务器仍检查文件格式、签名和大小。

构建需要 Python 3、JDK 17、Android API 35 与 build-tools 35.0.0，无 Gradle 依赖。设置 ANDROID_SDK_ROOT，可选 ANDROID_PLATFORM_JAR 和 ANDROID_BUILD_TOOLS；设置 APK_KEYSTORE、APK_KEY_ALIAS=reading-island、APK_STORE_PASSWORD、APK_KEY_PASSWORD，执行 python3 build.py，输出 build/reading-island.apk。签名密钥必须放在仓库外并长期备份，后续升级沿用同一签名。

自行部署时修改 BASE_URL、包名、图标并使用自己的签名。许可见 ../public-service/THIRD-PARTY-LICENSE.txt。发布前校验包名、域名和 v2/v3 签名；键盘、文件上传和系统返回需要安卓真机验收。
