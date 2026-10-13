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

不同签名 `user_id` 对应不同 DO/R2 数据空间。参考后端不提供注册、用户管理和租户控制台，这些由宿主负责。

## 显示配置

后端 `AI_NAME` 决定回复作者的显示名，`THEME_ACCENT`、`THEME_ACCENT_TEXT` 控制未读提示颜色。默认返回共读首页。若要返回宿主，修改 `/api/config` 的 `returnUrl`，只允许服务端白名单内的同源路径；不要接收用户提供的任意跳转 URL。

首版没有跨域 Cookie/postMessage 登录桥、独立 npm 组件包或所有技术栈的接入验证。跨域 iframe 不能照搬同源 Cookie 示例；需要宿主单独完成 origin 校验及专用会话交接。
