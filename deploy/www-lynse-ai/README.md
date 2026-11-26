# www.lynse.ai web 应用部署（/app/ 子路径）

测试环境 www.lynse.ai 的同源子路径部署：Next standalone 跑在 VPS 的 docker 容器（127.0.0.1:3102），nginx 把 `/app/` 反代过去。子路径是硬约束——MCP 桥接（`/platform/oauth/api/*`）不发 CORS 头且校验 Origin 必须等于 `https://www.lynse.ai`，授权管理页必须同源才能调用。

## 构建与部署

```sh
# 1. 构建（basePath /app + 海外生产后端 api-en + intl 版 + Firebase 谷歌登录）
# ⚠️ 2026-11-18 下午定案：海外 web 后端 = api-en.lynse.ai（生产），lynse-mcp 桥接
# （/etc/lynse-mcp-ai-test/environment 的 LYNSE_ACCOUNT_API_ORIGIN）已同步切 api-en。
# 勿回退 gapp.lynse.cn：gapp 无 Google 验签，2026-11-18 上午回退过一次致谷歌登录失效。
# Firebase 四值必须带（项目 lynse-6312d，缺失则 Google 按钮消失）；
# NEXT_PUBLIC_LYNSE_EDITION=intl 必须带（缺失编译期回退 cn 版）。
# 代码层兜底（2026-11-18 起）：core/config 的 defaultApiUrlForEdition 会按
# edition 落默认网关（intl→api-en.lynse.ai / cn→api.lynse.cn），显式
# NEXT_PUBLIC_API_URL 仍优先——双保险都保留，勿因兜底省略任一环境变量。
NEXT_PUBLIC_LYNSE_EDITION=intl NEXT_PUBLIC_BASE_PATH=/app \
  NEXT_PUBLIC_API_URL=https://api-en.lynse.ai \
  NEXT_PUBLIC_BUILD_CHANNEL=official \
  NEXT_PUBLIC_FIREBASE_API_KEY=AIzaSyCbglCTXnSCd51GBKW4zlGiUogbWn-5p1A \
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=lynse-6312d.firebaseapp.com \
  NEXT_PUBLIC_FIREBASE_PROJECT_ID=lynse-6312d \
  NEXT_PUBLIC_FIREBASE_APP_ID=1:602313552538:web:344447a428d7189dbee523 \
  pnpm --filter @lynse/web build

# 2. 组装 standalone bundle（monorepo 布局：server.js 在 apps/web/ 下）
BUNDLE=/tmp/lynse-web-bundle
rsync -a apps/web/.next/standalone/ "$BUNDLE"/
mkdir -p "$BUNDLE/apps/web/.next"
cp -R apps/web/.next/static "$BUNDLE/apps/web/.next/static"
# 小灵助手头像 GIF：next.config.ts 已把 apps/tauri/public/assistant 镜像到
# apps/web/public/assistant；standalone 不会自带 public/，必须手动带上
# （next 会按 basePath 前缀在 /app/assistant/ 下伺服）。
mkdir -p "$BUNDLE/apps/web"
cp -R apps/web/public "$BUNDLE/apps/web/public"

# 3. 部署（rsync → docker compose → nginx 幂等注入 → 健康检查）
deploy/www-lynse-ai/deploy.sh "$BUNDLE"
```

前置：`ssh tencent` 别名（`ubuntu@43.130.12.243`，密钥 `~/.ssh/lynseWbEd25519.pem`）与免密 sudo（与 `scripts/deploy-revelspark.sh` 同模式，RevelSpark 仓库）。

发版后验证小灵助手头像：`curl -s -o /dev/null -w "%{http_code}\n" https://www.lynse.ai/app/assistant/default.gif` 应为 200（2026-11-16 曾因 bundle 不带 public/ 全线 404，图标裂图）。

## nginx 行为

- `/app` 与 `/app/` 302 到 `/app/home`：Next 默认去尾斜杠（`trailingSlash: false`）而 nginx 入口会补回，直接代理会形成重定向死循环。
- `/app/<route>` 反代 `127.0.0.1:3102`；静态资源走同前缀（`/app/_next/...`）。
- include 片段安装为 `/etc/nginx/snippets/lynse-web-app.conf`，注入 `revelspark` 站点 443 server 块，修改前备份到远端 `~/apps/lynse-web/backups/`。


## 发版记录

- 2026-11-25：bundle 20261125-225617。新增桌面国际版 Google 登录**独立授权窗口中继页** `/app/auth/google-desktop`（桌面 `google_auth_window` 开窗 → 页面内跑 Firebase signInWithRedirect 往返 → done 标记 `/app/auth/google-desktop/done?nonce=…#identityToken=…` 被 Rust 窗口拦截回传）。同时修复 `appleWebLandingOrigin` 的 api-en.lynse.ai → www.lynse.ai 映射（此前落到 www.lynse.cn）。验证：`/app/auth/google-desktop?nonce=x` 200、头像 GIF 200、/app/home 200。桌面侧（google_auth_window 命令 + login-page 接线）未提交待发版——旧桌面 + 本 web 无影响。注：本次构建包含工作区未提交的登录轮播 i18n 与 chat store 小改动（全部测试绿）。
- 2026-11-18 下午：bundle 20261118-132823。API 切回 **api-en.lynse.ai（生产）** + intl + Firebase 四值，Google 登录恢复（真机验证：弹窗→选账号→直接进应用）；同步把 lynse-mcp 桥接账号系统 `/etc/lynse-mcp-ai-test/environment` 的 `LYNSE_ACCOUNT_API_ORIGIN` 从 gapp 切到 api-en（授权管理页真机验证正常，授权记录从零开始）。上午 bundle 20261118-125738（3bbfa5d1 + intl，API 仍指 gapp）是为修 cn 回退问题，但其 gapp 指向 + 无 Firebase 配置导致谷歌登录失效，已由本次发版取代。
- 2026-11-18：bundle 20261118-125738，tar sha256 7b0eb78d…（3bbfa5d1 + `NEXT_PUBLIC_LYNSE_EDITION=intl`：修复登录页/连接器误用 cn 版——此前构建命令漏该环境变量，编译期回退 cn）。API 仍指向 gapp 测试后端（MCP 桥接一致性约束，见下节）。

## 版本序列

web 端版本号从 **0.1.0** 起（`apps/web/package.json` 的 `@lynse/web`），独立于桌面端（根 `lynse-webapp` 1.2.x）与 MCP 服务（lynse-mcp 0.2.0）的版本序列。www.lynse.ai 的发布以 apps/web 版本号为准。

## 与 MCP 桥接的关系

- 授权管理页 `/app/authorizations` 同源调用 `/platform/oauth/api/authorizations` 等动作；桥接会话 cookie（path=/platform/oauth）与网页版账号 token 相互独立，通过桥接的 `token-login` 动作静默打通（用当前账号 token 换桥接会话，见 lynse-mcp 仓库 `docs/authorization-records-api.md`）。
- 登录环境需与 MCP 实例一致：本部署指向 `gapp.lynse.cn`（测试账号系统），对应 lynse-mcp 测试环境。

## 桌面端发版与录音卡私有插件（2026-11-20）

- 录音卡「设备管理」插件源码不在公开仓库（`.gitignore` 私有路径：`recording_card_private/`、`recording-card-private/`、`private-plugins/`、web `(private-plugins)` 页面与校验路由、`recording-card-ownership/` 校验器、`.recording-card-ownership/` verify.c、`specs/private-recorder-usb-access/`），构建时按目录存在性自动启用；`LYNSE_REQUIRE_PRIVATE_RECORDING_CARD=1` 可强制要求私有输入，缺任一输入即构建失败。
- tag→GitHub Actions 官方发版=公开版安装包（不含设备页）。带设备页的桌面安装包必须在私有目录在位（6 目标校验器静态库 + verify.wasm + 私有源码）的本机构建，随后上传到对应 GitHub Release 并刷新 dl.lynse.cn `updates/latest/`。
- 绑定校验契约：设备文件管理前调 `GET /api/business/device/mine`，匹配 authSn + bleMac + `bindStatus==1` 才放行；连接即验、每次文件操作重验。
