# www.lynse.cn web 应用部署（/app/ 子路径，CN 版）

国内服生产部署：Next standalone 跑在阿里云 ECS（47.101.165.66，实例 i-uf6j5zu4kakq7pwsnxpt）的 systemd 服务（127.0.0.1:3103），nginx 从 gw.conf 的 443 块反代 /app/。后端 api.lynse.cn（生产账号系统）。

首次部署：2026-11-11（release /opt/lynse-web-cn/releases/20261111-0218，bundle sha256 89a1e57a…）。

后续发版记录：
- Web 0.1.1 于 2026-11-19 发布。版本目录为 `releases/20261119-185530-web-0.1.1`，bundle SHA-256 为 `f2efdd2a7488b73d9eca90a27bc5d13ae5b2c94e9093a041619088a873c94df4`。更新 MCP 0.2.2 和 CLI 1.8.12 接入指引，在「我的授权」与 CLI 指南中提供设备授权入口。
- 2026-11-18：releases/20261118-1443，bundle sha256 683aba51…（620f1dce + 工作区 locales 两文案：静默自停 60s→90s、录音卡插件描述改设备页入口；Apple 登录全量代码随包，Apple 后台 Return URL 已绑定 api.lynse.cn。本次 SSH 直传 ECS，未走 OSS 中转——安全组 22 已开）。
- 2026-11-18：releases/20261118-1204，bundle sha256 8b5bd03f…（3007163d：微信扫码 web 闸门修复 + 绑定 landing authType/跳转；构建于干净 worktree，避开并行会话未提交的 locales 改动）。

## 构建与上传

```sh
# 1. CN 版构建（basePath /app + 生产后端）
NEXT_PUBLIC_LYNSE_EDITION=cn NEXT_PUBLIC_API_URL=https://api.lynse.cn \
  NEXT_PUBLIC_BASE_PATH=/app NEXT_PUBLIC_BUILD_CHANNEL=official pnpm --filter @lynse/web build

# 2. 组装 standalone bundle
BUNDLE=/tmp/lynse-cn-prod-bundle
rsync -a apps/web/.next/standalone/ "$BUNDLE"/
mkdir -p "$BUNDLE/apps/web/.next"
cp -R apps/web/.next/static "$BUNDLE/apps/web/.next/static"
# 小灵助手头像 GIF：next.config.ts 已把 apps/tauri/public/assistant 镜像到
# apps/web/public/assistant；standalone 不会自带 public/，必须手动带上
# （next 会按 basePath 前缀在 /app/assistant/ 下伺服）。
mkdir -p "$BUNDLE/apps/web"
cp -R apps/web/public "$BUNDLE/apps/web/public"

# 3. 打包 → OSS 中转 → ECS 下载（云助手 SendFile 上限 32KiB，大文件走 OSS）
COPYFILE_DISABLE=1 tar czf /tmp/lynse-cn-web.tar.gz -C "$BUNDLE" .
shasum -a 256 /tmp/lynse-cn-web.tar.gz
aliyun oss cp /tmp/lynse-cn-web.tar.gz oss://dting-02/tmp/lynse-web-cn.tar.gz -e oss-cn-shenzhen.aliyuncs.com -f
aliyun oss sign "oss://dting-02/tmp/lynse-web-cn.tar.gz" -e oss-cn-shenzhen.aliyuncs.com --timeout 7200
```

ECS 无 SSH（安全组未开 22）：全部通过云助手执行 —— `python3 scripts/aliyun_cli.py --instance i-uf6j5zu4kakq7pwsnxpt run <script> --timeout 600` + `poll <InvokeId>`（lynse-mcp 仓库脚本）。ECS 上 wget OSS 公网签名 URL 下载（bucket 深圳 region，ECS 上海，内网不通）。

发版后验证小灵助手头像：`curl -s -o /dev/null -w "%{http_code}\n" https://www.lynse.cn/app/assistant/default.gif` 应为 200（2026-11-16 曾因 bundle 不带 public/ 全线 404，图标裂图）。

## ECS 侧

- release 目录 `/opt/lynse-web-cn/releases/<ts>`，`current` symlink；bundle 解压后 sha256 校验（macOS tar 的 provenance xattr 头会产生无害告警）。
- systemd 服务 `lynse-web-app.service`：`node apps/web/server.js`，`PORT=3103`、`HOSTNAME=127.0.0.1`（ECS 自带 node v20，未用容器——避免国内拉镜像）。
- nginx 片段 `/etc/nginx/snippets/lynse-web-app-cn.conf`，include 注入 gw.conf 的 443 块（`server_name api.lynse.cn;` 行后——该块同时兜底服务 www.lynse.cn 的 HTTPS）。改前备份到 `/opt/lynse-web-cn/backups/`，`nginx -t` 通过才 reload。
- **`location ^~ /app/` 的 `^~` 必须保留**：gw.conf 有站点级正则 location（`~* \.(css|js|...)$`），普通前缀匹配会被它抢占，`/app/_next/static/*` 会 404。
- 兼容跳转：`location = /bind → 302 /app/bind`（后端 Nacos 的 web-bind-url 无论配 `/bind` 还是 `/app/bind` 都可用）。

## Web App、MCP 和 CLI 登录

用户从 `https://www.lynse.cn/app` 打开 Web App。CLI 在 `https://www.lynse.cn/login/device` 使用同一套登录表单，登录后输入设备码。MCP 客户端配置 `https://mcp.lynse.cn/mcp`，连接时在官网确认当前账号和所需权限。

Agent 配置的版本号和下载文件名由 `packages/views/agent-config/shared.ts` 定义。打包时把以下已验证的产物放进 `apps/web/public/downloads/`，并让部署包带上 `public/`。更新时合并上一版的下载目录，继续服务已分发的版本链接。

| 官网文件 | 构建产物 |
| --- | --- |
| `lynse_cli-1.8.12-py3-none-any.whl` | `lynse-cli/dist/lynse-cli-agent-bundle-1.8.12/wheel/lynse_cli-1.8.12-py3-none-any.whl` |
| `lynse-cli-skill-1.8.12.zip` | `lynse-cli/dist/lynse-cli-skill-1.8.12.zip` |
| `lynse-cli-skill-workbuddy-1.8.12.zip` | `lynse-cli/dist/lynse-cli-skill-workbuddy-1.8.12.zip` |
| `lynse-mcp-workbuddy-cn-0.2.2.zip` | `lynse-mcp/dist/lynse-workbuddy-cn.zip` |

启用共用登录时，先部署含 `/app/login/authorize` 的 Web App，再在承接 MCP `/authorize` 与网站 `/platform/oauth/api/` 的授权网关中设置 `LYNSE_MCP_WEB_CONSENT_PATH=/app/login/authorize`。保持这两个入口指向共享授权存储的实例。Web 反代关闭该页面的访问日志，避免记录 `ticket`。灰度使用同一浏览器验证从 Web 登录后打开 MCP 授权直接显示已登录账号。另验证 CLI 六位码授权和 MCP 客户端回调。

国内已于 2026-11-19 启用共用登录。浏览器授权请求由 `lynse-agent-auth-20261119-185530-web-0.1.1-browser-auth-r2` 在 `127.0.0.1:18096` 处理。公网已验证 MCP 发起授权、进入官网确认页和拒绝后返回客户端，CLI 设备授权的发现接口可用。

回退浏览器授权流时，用 `/opt/lynse-agent-auth/releases/20261119-185530-web-0.1.1-browser-auth-r2/nginx-lynse-cn-before.conf` 恢复当前的 `nginx-lynse-cn.conf`，通过 `nginx -t` 后重载。切换期间保持两个授权页面可访问，直到已发起的 MCP 授权请求过期。

## 三种登录状态（2026-11-11 调试结论）

| 方式 | 状态 | 依赖 |
| --- | --- | --- |
| 手机验证码 | ✅ 可用 | 无（api.lynse.cn 既有接口，实测发送成功） |
| Apple | ⏳ 后端配置 | CN Nacos `auth.apple` 仍为占位符（your-client-id）、callback 500，见下清单 |
| 微信扫码 | ✅ 可用（2026-11-19） | redirect_uri 受开放平台回调域约束只能是 `https://api.lynse.cn/auth/login`；在 **api 服务器 ECS `i-uf6ilaofl2s8dg1faay0`（139.224.25.20）** 的 nginx `gw.conf` 中将该路径 302 到 `https://www.lynse.cn/app/auth/wechat$is_args$args`，由前端回调页调 `POST /api/auth/login` 换 code（与桌面端一致）。备份 `/opt/lynse-backups/gw.conf.20261119-175747` |

前端行为：未就绪的入口点击后 toast 提示（「Apple 登录配置中」「微信扫码登录正在接入」）；微信入口按 `redirect_uri` 的 origin 判定放行（`wechatWebFlowReady`）。微信扫码落地回调页 `apps/web/app/auth/wechat/page.tsx` 用后端签发的 state 做校验后兑换 code。

## 给后端的修改清单

> 微信 web 流架构 2026-11-18 定案为**后端回调**（redirect_uri 固定 api.lynse.cn/auth/login，与开放平台回调域一致），完整契约见 `docs/cn-wechat-scan-web-login-backend-contract.md`（含 curl 验收命令）。

1. ~~**微信 `GET /auth/login` 浏览器回调落地**（P0）~~ **已于 2026-11-19 用 api 服务器 nginx 转发解决**（见上表），无需再实现 dting-auth controller / Nacos web-success-url / web-bind-url。完整背景见 `docs/cn-wechat-scan-web-login-backend-contract.md` 顶部 2026-11-19 更新。
2. **CN Nacos `dting-auth` 的 `auth.apple` 节点**（现为占位符，照 Apple 网页接入文档配真值）：
   - client-id=com.lynse.web、team-id=76HBB34PNK、key-id=Q2M7PBW9G7、private-key=.p8 内容
   - redirect-uri=https://api.lynse.cn/api/auth/apple/callback（与 Apple 后台 Return URL 逐字一致）
   - scope=name email、response-type=code id_token、**response_mode=form_post**（gapp 实测缺它被 Apple 拒绝 invalid_request）
3. **gapp 测试后端同步**：Apple 授权 URL 补 response_mode=form_post；web-success-url=https://www.lynse.ai/app/home、web-bind-url=https://www.lynse.ai/app/bind。
4. **Google（intl）**：后端 Firebase Admin SDK 的项目必须与前端 `lynse-6312d` 一致（前端已送出真实 token，后端返回 error.google.identity.token.invalid——项目不匹配的典型症状）。

## 版本序列

web 端版本号从 **0.1.0** 起（`apps/web/package.json` 的 `@lynse/web`），独立于桌面端（根 `lynse-webapp` 1.2.x）与 MCP 服务（lynse-mcp 0.2.0）的版本序列。www.lynse.cn 的发布以 apps/web 版本号为准。

## 桌面端发版与录音卡私有插件（2026-11-20）

- 官方 tag→CI 发版为公开版安装包（不含录音卡设备页）；带设备页的安装包须在本机私有目录（`recording_card_private/` 等私有路径，见 www-lynse-ai README 同名小节）在位时构建，上传 GitHub Release 后刷新 dl.lynse.cn `updates/latest/`。
