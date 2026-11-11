# www.lynse.cn web 应用部署（/app/ 子路径，CN 版）

国内服生产部署：Next standalone 跑在阿里云 ECS（47.101.165.66，实例 i-uf6j5zu4kakq7pwsnxpt）的 systemd 服务（127.0.0.1:3103），nginx 从 gw.conf 的 443 块反代 /app/。后端 api.lynse.cn（生产账号系统）。

首次部署：2026-11-11（release /opt/lynse-web-cn/releases/20261111-0218，bundle sha256 89a1e57a…）。

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

# 3. 打包 → OSS 中转 → ECS 下载（云助手 SendFile 上限 32KiB，大文件走 OSS）
COPYFILE_DISABLE=1 tar czf /tmp/lynse-cn-web.tar.gz -C "$BUNDLE" .
shasum -a 256 /tmp/lynse-cn-web.tar.gz
aliyun oss cp /tmp/lynse-cn-web.tar.gz oss://dting-02/tmp/lynse-web-cn.tar.gz -e oss-cn-shenzhen.aliyuncs.com -f
aliyun oss sign "oss://dting-02/tmp/lynse-web-cn.tar.gz" -e oss-cn-shenzhen.aliyuncs.com --timeout 7200
```

ECS 无 SSH（安全组未开 22）：全部通过云助手执行 —— `python3 scripts/aliyun_cli.py --instance i-uf6j5zu4kakq7pwsnxpt run <script> --timeout 600` + `poll <InvokeId>`（lynse-mcp 仓库脚本）。ECS 上 wget OSS 公网签名 URL 下载（bucket 深圳 region，ECS 上海，内网不通）。

## ECS 侧

- release 目录 `/opt/lynse-web-cn/releases/<ts>`，`current` symlink；bundle 解压后 sha256 校验（macOS tar 的 provenance xattr 头会产生无害告警）。
- systemd 服务 `lynse-web-app.service`：`node apps/web/server.js`，`PORT=3103`、`HOSTNAME=127.0.0.1`（ECS 自带 node v20，未用容器——避免国内拉镜像）。
- nginx 片段 `/etc/nginx/snippets/lynse-web-app-cn.conf`，include 注入 gw.conf 的 443 块（`server_name api.lynse.cn;` 行后——该块同时兜底服务 www.lynse.cn 的 HTTPS）。改前备份到 `/opt/lynse-web-cn/backups/`，`nginx -t` 通过才 reload。
- **`location ^~ /app/` 的 `^~` 必须保留**：gw.conf 有站点级正则 location（`~* \.(css|js|...)$`），普通前缀匹配会被它抢占，`/app/_next/static/*` 会 404。
- 兼容跳转：`location = /bind → 302 /app/bind`（后端 Nacos 的 web-bind-url 无论配 `/bind` 还是 `/app/bind` 都可用）。

## 三种登录状态（2026-11-11 调试结论）

| 方式 | 状态 | 依赖 |
| --- | --- | --- |
| 手机验证码 | ✅ 可用 | 无（api.lynse.cn 既有接口，实测发送成功） |
| Apple | ⏳ 后端配置 | CN Nacos `auth.apple` 仍为占位符（your-client-id），见下清单 |
| 微信扫码 | ⏳ 后端配置 | WECHAT_SCAN redirect_uri 仍指向后端 /auth/login 页，见下清单 |

前端行为：未就绪的入口点击后 toast 提示（「苹果登录暂未配置」「微信扫码登录正在接入」），后端配置完成后**无需改前端**自动激活。

## 给后端的修改清单

1. **CN Nacos `dting-auth` 的 `auth.apple` 节点**（现为占位符，照 Apple 网页接入文档配真值）：
   - client-id=com.lynse.web、team-id=76HBB34PNK、key-id=Q2M7PBW9G7、private-key=.p8 内容
   - redirect-uri=https://api.lynse.cn/api/auth/apple/callback（与 Apple 后台 Return URL 逐字一致）
   - scope=name email、response-type=code id_token、**response_mode=form_post**（gapp 实测缺它被 Apple 拒绝 invalid_request）
   - web-success-url=https://www.lynse.cn/app/home、web-bind-url=https://www.lynse.cn/app/bind（或 /bind，已做兼容 302）
2. **微信 WECHAT_SCAN redirect_uri**：改为 https://www.lynse.cn/auth/wechat（前端回调页已就绪）；当前值 https://api.lynse.cn/auth/login 是后端自己的页面，web 拿不到 code。
3. **gapp 测试后端同步**：Apple 授权 URL 补 response_mode=form_post；web-success-url=https://www.lynse.ai/app/home、web-bind-url=https://www.lynse.ai/app/bind。
4. **Google（intl）**：后端 Firebase Admin SDK 的项目必须与前端 `lynse-6312d` 一致（前端已送出真实 token，后端返回 error.google.identity.token.invalid——项目不匹配的典型症状）。

## 版本序列

web 端版本号从 **0.1.0** 起（`apps/web/package.json` 的 `@lynse/web`），独立于桌面端（根 `lynse-webapp` 1.2.x）与 MCP 服务（lynse-mcp 0.2.0）的版本序列。www.lynse.cn 的发布以 apps/web 版本号为准。
