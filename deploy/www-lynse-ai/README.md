# www.lynse.ai web 应用部署（/app/ 子路径）

测试环境 www.lynse.ai 的同源子路径部署：Next standalone 跑在 VPS 的 docker 容器（127.0.0.1:3102），nginx 把 `/app/` 反代过去。子路径是硬约束——MCP 桥接（`/platform/oauth/api/*`）不发 CORS 头且校验 Origin 必须等于 `https://www.lynse.ai`，授权管理页必须同源才能调用。

## 构建与部署

```sh
# 1. 构建（basePath /app + gapp 测试后端 + 正式登录渠道）
NEXT_PUBLIC_BASE_PATH=/app NEXT_PUBLIC_API_URL=https://gapp.lynse.cn \
  NEXT_PUBLIC_BUILD_CHANNEL=official pnpm --filter @lynse/web build

# 2. 组装 standalone bundle（monorepo 布局：server.js 在 apps/web/ 下）
BUNDLE=/tmp/lynse-web-bundle
rsync -a apps/web/.next/standalone/ "$BUNDLE"/
mkdir -p "$BUNDLE/apps/web/.next"
cp -R apps/web/.next/static "$BUNDLE/apps/web/.next/static"

# 3. 部署（rsync → docker compose → nginx 幂等注入 → 健康检查）
deploy/www-lynse-ai/deploy.sh "$BUNDLE"
```

前置：`ssh tencent` 别名（`ubuntu@43.130.12.243`，密钥 `~/.ssh/lynseWbEd25519.pem`）与免密 sudo（与 `scripts/deploy-revelspark.sh` 同模式，RevelSpark 仓库）。

## nginx 行为

- `/app` 与 `/app/` 302 到 `/app/home`：Next 默认去尾斜杠（`trailingSlash: false`）而 nginx 入口会补回，直接代理会形成重定向死循环。
- `/app/<route>` 反代 `127.0.0.1:3102`；静态资源走同前缀（`/app/_next/...`）。
- include 片段安装为 `/etc/nginx/snippets/lynse-web-app.conf`，注入 `revelspark` 站点 443 server 块，修改前备份到远端 `~/apps/lynse-web/backups/`。

## 与 MCP 桥接的关系

- 授权管理页 `/app/authorizations` 同源调用 `/platform/oauth/api/authorizations` 等动作；桥接会话 cookie（path=/platform/oauth）与网页版账号 token 相互独立，通过桥接的 `token-login` 动作静默打通（用当前账号 token 换桥接会话，见 lynse-mcp 仓库 `docs/authorization-records-api.md`）。
- 登录环境需与 MCP 实例一致：本部署指向 `gapp.lynse.cn`（测试账号系统），对应 lynse-mcp 测试环境。
