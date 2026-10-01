# Web 版（lynse-desktop/apps/web）部署指南

将 lynse-desktop 的 Next.js Web 版部署到 `web.lynse.cn`，用户在浏览器里完成微信/短信登录后
即可直接使用会议、录音、聊天、知识库等功能，无需安装桌面端。

## 架构

```
用户浏览器 ──HTTPS──> web.lynse.cn (Caddy/nginx) ──> 127.0.0.1:3000 (next start)
                          │
                          └─ 页面内所有 API 请求走同源 /api/proxy/*，
                             由 Next 服务端转发到 api.lynse.cn（浏览器无跨域问题）
```

- Web 版自带 `/api/proxy/[...path]` 转发层，浏览器请求同源路径，服务端按
  `x-lynse-api-url` 头转发到 `api.lynse.cn`，因此 **api.lynse.cn 无需为 web 版加 CORS**。
- 登录页默认 API 地址已是 `https://gapp.lynse.cn`（`packages/core/config/index.ts` 的
  `DEFAULT_API_URL`），用户不需要手动填写。

## 一、构建

在开发机或 CI 上（pnpm 10 + Node 20+，monorepo 根目录执行）：

```bash
pnpm install
NEXT_PUBLIC_BUILD_CHANNEL=official \
NEXT_PUBLIC_API_URL=https://gapp.lynse.cn \
NEXT_PUBLIC_WECHAT_APP_ID=<微信开放平台 appid，与桌面端一致> \
NEXT_PUBLIC_WS_URL=<实时服务地址，如不用实时功能可留空> \
pnpm --filter @lynse/web build
```

产物在 `apps/web/.next` + `apps/web/public`。部署方式二选一：

- **方式 A（推荐）**：整个 monorepo 同步到服务器，服务器上 `pnpm --filter @lynse/web start`
  （需要 `.next`、`node_modules`、`packages/*` 完整存在）。
- **方式 B**：服务器上拉代码后执行上面的构建命令（服务器需要 Node 20+ 与 pnpm）。

## 二、systemd 单元

`/etc/systemd/system/lynse-web.service`：

```ini
[Unit]
Description=Lynse web app (Next.js)
After=network-online.target

[Service]
User=lynse
WorkingDirectory=/opt/lynse-desktop/apps/web
Environment=NODE_ENV=production
Environment=PORT=3000
# NEXT_PUBLIC_* 已在构建期注入，运行期无需重复
ExecStart=/usr/bin/pnpm start
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## 三、Caddy 反代（与 MCP 同机时）

```
web.lynse.cn {
    reverse_proxy 127.0.0.1:3000
}

mcp.lynse.cn {
    reverse_proxy 127.0.0.1:8000
}
```

DNS：`web.lynse.cn` A/AAAA 记录指向服务器。Caddy 自动签发 TLS。

## 四、运维检查清单

- [ ] 微信开放平台：授权回调域加入 `web.lynse.cn`（web 版自己的微信登录回调是
      `web.lynse.cn/auth/wechat`；与官网 MCP 授权流程用的 `www.lynse.cn/auth/wechat`
      相互独立，两个都登记即可，微信仅校验 host）
- [ ] `NEXT_PUBLIC_WECHAT_APP_ID` 与桌面端一致，否则微信登录报 appid 错误
- [ ] 官网 Header 已加"网页版"入口（指向 `https://web.lynse.cn`）
- [ ] 上线前自测：打开 web.lynse.cn → 短信登录 → 进入会议列表 → 播放一条录音

## 五、与 MCP 授权流程的关系

- 用户在官网 `/mcp/authorize` 授权 Agent 后，Agent 读到的数据和 web 版登录后看到的是
  同一个账号的数据（都走 api.lynse.cn）。
- web 版目前不提供"已授权应用管理"界面；撤销 Agent 授权暂时通过 MCP 客户端侧
  （RFC 7009 revoke）或清理服务端数据库操作，二期做"我的授权"页时统一管理。
