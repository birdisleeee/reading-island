# 嵌入自己的项目

首版提供同源页面/iframe 接入。将 `/reading-island/` 静态页面与 `/api/` 代理到共读参考后端，保留 Cookie、请求方法和正文。可使用 [最小 iframe 示例](../examples/embed.html)。已有项目的服务器、登录和主界面仍由宿主维护。

## 登录接线

独立部署可使用默认密码登录。接入已有登录时，宿主后端在验证用户后签发会话，使用 `src/core/auth.mjs` 的 `issueToken`：

```js
const token = await issueToken(sessionSecret, {
  purpose: 'session',
  user_id: verifiedUserId
}, 3600);
```

`verifiedUserId` 必须是服务端已验证的 ASCII 字母、数字、下划线或连字符（1–100 个字符），不要直接采信浏览器提交的用户 ID。宿主与参考后端使用同一个独立 `SESSION_SECRET`。这个密钥只能保存在可信服务器上。

宿主在共读所在 origin 设置 `reading_session` Cookie，属性为 `Path=/; HttpOnly; Secure; SameSite=Strict`，并根据实际会话时长设置 Max-Age。iframe 依靠同源 Cookie 登录。服务端 API 客户端也可用 `Authorization: Bearer <signed-session-token>`；不要把令牌放在 URL 或 iframe 查询参数中。

不同签名 `user_id` 对应不同 DO/R2 数据空间。默认单人参考后端不提供注册、用户管理和租户控制台，这些由宿主负责。另有带注册申请、人工审批和配额的独立 [公共服务适配器](../public-service/README.md)，不与默认部署配置混用。

`GET /api/session` 返回当前已验证的 `user_id`、`username` 和资料 revision。读者可通过 `GET/PATCH /api/reading/profile` 查看或更新自己的用户名；宿主也可在可信服务端使用该用户的签名会话初始化用户名。用户 ID 始终取自鉴权，不接受浏览器正文改写。独立密码登录仍对应一个固定用户（默认 reader），不是输入不同名字就注册多个账号。电脑左下角显示登录资料，原返回宿主的跳转仍由页面返回行为和 returnUrl 配置控制。

## 显示配置

后端 `AI_NAME` 决定回复作者的显示名，`THEME_ACCENT` 提供首次进入时的默认强调色。用户已保存的本地美化主题优先，并按对比度选取按钮前景色；`/api/config`仍提供 accent/accentText 供宿主使用。默认返回共读首页。若要返回宿主，修改 `/api/config` 的 `returnUrl`，只允许服务端白名单内的同源路径；不要接收用户提供的任意跳转 URL。

电脑端（宽度641px起）使用分类侧栏和宽幅面板，主题强调色也用于侧栏选中态和按钮。手机布局独立保留。桌面插图的替换/恢复默认记录在本实例浏览器的 `reading-island-appearance-v1` IndexedDB，只影响该设备的外观；书籍、摘录、讨论及 AI 配置仍由后端管理。公开版本使用仓库内原创 SVG 默认素材，宿主可以替换自己的素材。

主题背景、美化与阅读排版也保存在该浏览器的外观数据库，分类折叠只存本地偏好。人物预设随加密模型配置保存；定时议题由后端Alarm执行，其他后端接线需实现[定时接口](API.md)和[执行语义](TOPIC-SCHEDULE.md)。

首版没有跨域 Cookie/postMessage 登录桥、独立 npm 组件包或所有技术栈的接入验证。跨域 iframe 不能照搬同源 Cookie 示例；需要宿主单独完成 origin 校验及专用会话交接。
