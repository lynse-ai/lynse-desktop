# 应用内自动更新（Auto-Update）

应用已从「跳转 GitHub Releases 手动下载」升级为 **tauri-plugin-updater 驱动的全自动更新**：
检测更新 → 应用内下载 → minisign 签名校验 → 自动安装 → 自动重启进入新版本。无需用户手动下载任何文件。

## 工作原理

```
客户端 (tauri-plugin-updater)
   │  轮询 endpoint（每 30 分钟 + 手动"检查更新"）
   ▼
https://dl.lynse.cn/updates/latest.json   ← 腾讯云 CloudBase 静态托管（唯一更新源，自定义域名）
   │  返回 { version, platforms: { "<target>": { url, signature } } }
   ▼
客户端比较版本 → 有新版本 → UI 提示（通知中心 / 侧边栏卡片 / 设置页）
   │  用户点"立即更新"（或后续接静默更新）
   ▼
从 latest.json 内 url 下载安装包（CloudBase）→ 用 tauri.conf.json 中的 pubkey 校验 .sig 签名
   → 安装 → relaunch()
```

发布链路：GitHub Actions 负责构建、Developer ID 签名 + 公证、minisign 签名，并把产物发布到
GitHub Release（构建源头 + 回滚依据）；随后 `mirror-cloudbase` 任务把 Release 资产镜像到
腾讯云 CloudBase 静态托管（环境 `lynse-d8g49o1i956741f9e`，上海，自定义域名
`dl.lynse.cn`），并将 `latest.json` 内的
下载地址改写为 `https://dl.lynse.cn/updates/...` 后发布。客户端只轮询
`https://dl.lynse.cn/updates/latest.json` 这一个 endpoint（早先配置的
GitHub 兜底 endpoint 因仓库私有匿名 404、从未可用，已从 `tauri.conf.json` 移除；仅历史
编译包内仍残留）。

关键文件：

| 文件 | 作用 |
| --- | --- |
| `apps/tauri/src-tauri/tauri.conf.json` | `plugins.updater`：公钥 + endpoints；`bundle.createUpdaterArtifacts: true` |
| `apps/tauri/src-tauri/src/lib.rs` | 注册 `tauri_plugin_updater` / `tauri_plugin_process` |
| `apps/tauri/src/tauri-bridge.ts` | `check()` 检测 + `downloadAndInstall()` 进度 + `relaunch()`，暴露为 `window.desktopAPI.app.*` |
| `packages/views/app-update.ts` | 更新轮询、安装进度状态（全局单例），`useAppUpdate()` 供 UI 使用 |
| `packages/views/settings/settings-dialog.tsx` | 设置页"关于"卡片：安装按钮 + 进度条 |
| `packages/views/layout/app-sidebar.tsx` | 侧边栏 `UpdateReminder` 卡片：安装按钮 + 进度条 |
| `.github/workflows/release.yml` | 打 tag 自动构建、签名、生成并上传 `latest.json` 到 Release；`mirror-cloudbase` 任务改写 URL 后镜像到 CloudBase 静态托管 |
| `apps/tauri/src-tauri/src/lib.rs` | 离线转写运行时包下载：CloudBase 镜像优先（`LYNSE_UPDATES_MIRROR_BASE` 编译期注入）→ GitHub → ghproxy 镜像 |

## 分发渠道：官网直发（TestFlight 已退役）

自 v1.1.8 起采用与常见桌面应用一致的直发模式：**官网下载页负责首次安装，应用内自动更新
负责后续升级**，不再向 TestFlight 上传新版本。

- `scripts/build-appstore.sh`（App Store/TestFlight 通道）保留但停用；`Entitlements-appstore.plist`
  等沙盒产物链路仅作存档参考。
- **存量 TestFlight 用户迁移**：TestFlight 装的包运行在 macOS App Sandbox 下，永远无法
  应用内自更新（`APP_SANDBOX_CONTAINER_ID` → `get_app_info` 返回 `sandboxed: true`）。
  更新弹窗与通知中心对这类构建不再引导 TestFlight，而是引导到官网下载页
  （`packages/views/about/links.ts` 的 `DOWNLOAD_URL`，即 `https://www.lynse.cn/download`），
  手动安装一次直发版后即永久脱离 TestFlight，之后全部走应用内自动更新。

### Developer ID 签名 + 公证（一次性配置）

官网分发必须 Developer ID 签名并公证，否则 Gatekeeper 拦截（用户需右键打开）且每次更新后
麦克风/录屏等 TCC 授权丢失。`release.yml` 已内置检测：配置下列 Secrets 即自动签名 + 公证，
缺省则退回 ad-hoc 签名（仅限测试）。

| Secret | 说明 |
| --- | --- |
| `APPLE_CERTIFICATE` | Developer ID Application 证书 .p12 的 base64（`base64 -i cert.p12`） |
| `APPLE_CERTIFICATE_PASSWORD` | 导出 .p12 时设置的密码 |
| `APPLE_SIGNING_IDENTITY` | 证书全名，如 `Developer ID Application: Lynse (76HBB34PNK)` |
| `APPLE_ID` | 公证用 Apple ID |
| `APPLE_PASSWORD` | 该 Apple ID 的 app-specific password（appleid.apple.com 生成） |
| `APPLE_TEAM_ID` | `76HBB34PNK` |

证书在 developer.apple.com → Certificates → 创建 **Developer ID Application**（非 Apple
Distribution）。公证由 tauri 打包器自动完成（notarytool 提交 + 订书 DMG），updater 产物
`.app.tar.gz` 由签名后的 .app 打包而来，无需单独公证。

⚠️ 直发版一经 Developer ID 签名，后续版本必须持续使用同一证书签名（换证书 = 用户的 TCC
授权重置）；minisign 更新私钥 `~/.tauri/lynse-desktop.key` 同理不可更换（见下文密钥管理）。

### 官网下载页接入（lynse.cn/download）

官网页面无需托管安装包，读更新清单动态给出链接即可（清单与安装包同在 CloudBase，URL 200 可直下）：

```
GET https://dl.lynse.cn/updates/latest.json
{
  "version": "1.1.8",
  "notes": "…",                       // 取自 CHANGELOG
  "pub_date": "2026-10-07T…Z",
  "platforms": {
    "darwin-aarch64": {               // macOS（Apple Silicon，macOS 15+）
      "signature": "…minisign…",
      "url": "https://dl.lynse.cn/updates/v1.1.8/Lynse_1.1.8_aarch64.dmg"
    },
    "windows-x86_64": {               // Windows x64
      "signature": "…",
      "url": "https://dl.lynse.cn/updates/v1.1.8/Lynse_1.1.8_x64_en-US.msi"
    }
  }
}
```

- 页面按 UA / 手动切换展示对应平台的 `platforms.<key>.url`；同目录下还有
  `Lynse_<版本>_aarch64.app.tar.gz(.sig)`（updater 专用，无需在下载页露出）。
- 该清单同时是应用内「新内容」说明的来源（`packages/views/app-update.ts` 的
  `fetchLatestReleaseNotes`），官网展示的版本号/更新说明与应用内保持一致。
- `CORS` 已放通（网关反射 Origin），浏览器 fetch 可直接读。

## 腾讯云 CloudBase 配置（一次性）

更新分发使用 CloudBase 静态托管（环境 `lynse-d8g49o1i956741f9e`，地域上海），
对外统一走绑定的自定义域名 `dl.lynse.cn`（原生域名
`lynse-d8g49o1i956741f9e-1401959758.tcloudbaseapp.com` 继续可用、指向同一 bucket，
仅作备用入口）。已实测匿名公网可读、单文件 100MB+ 可上传、CORS 反射 Origin。

只需在仓库 Secrets 配置一个变量：

| Secret | 说明 |
| --- | --- |
| `CLOUDBASE_API_KEY` | 环境级 API 密钥，在 云开发控制台 → 环境设置 → API 密钥 创建（仅授予该环境，风险小于腾讯云主账号密钥） |

未配置该 secret 时，`mirror-cloudbase` 跳过，随后的 `verify-updates` 会因为线上清单仍是旧版本
而**让发版流水线失败**。这是有意的：镜像没做成就必须响亮地失败，而不是构建全绿、客户端却
永远收不到更新。下面「更新链的自检与修复工具」给出补救方式。

CloudBase 静态托管上的目录结构（由 CI 维护，无需手工操作）：

```
updates/latest.json                  ← 客户端轮询的稳定入口
updates/v1.0.4/Lynse_1.0.4_x64_en-US.msi(.sig)
updates/v1.0.4/Lynse_1.0.4_aarch64.app.tar.gz(.sig)
updates/v1.0.4/Lynse_1.0.4_aarch64.dmg
updates/v1.0.4/lynse-stt-runtime-*.tar.gz   ← 离线转写运行时包（lib.rs 同地址优先拉取）
```

`mirror-cloudbase` 会先上传每个 tag 的产物目录，最后才发布 `updates/latest.json`，
并校验两个平台的条目齐全，避免发布半成品。

## 更新链的自检与修复工具

镜像这一步一旦缺失，症状是**静默的**：GitHub Release 照常发出，构建全绿，但所有已安装
客户端读到的仍是旧版本，永远收不到更新提示。`48602a24`（2026-09-26）误删 `mirror-cloudbase`
任务后，线上 `updates/latest.json` 就停在 1.1.0，连续几个版本都没被发现。为此加了三道机制：

| 机制 | 位置 | 作用 |
| --- | --- | --- |
| 镜像脚本（CI 与人工共用同一实现） | `apps/tauri/scripts/mirror-release-to-cloudbase.sh` | 取已发布且已签名的 GitHub Release，改写 URL → 先传 `updates/<tag>/` → 断言每个产物可下载 → 最后翻 `updates/latest.json` → **回读线上清单确认自己成功** |
| 发版后断言 | `release.yml` 的 `verify-updates` 任务 | 读**线上**清单（不是构建产物），断言 `version` 等于本次 tag、两个平台条目齐全、清单里每个 url 返回 200 |
| 陈旧巡检 | `.github/workflows/updater-staleness.yml`（每日 03:00） | 比较「最新 release tag」与「线上清单实际服务的版本」，漂移即失败；新 tag 发布 6 小时内视为流水线在跑，只告警不失败 |

手工修复某个已发布版本（不重新构建）：

```bash
gh workflow run remirror-updates.yml -f tag=v1.1.6              # 推荐：CI 上跑，先 dry-run
# 或本地（需 gh 已登录 + CLOUDBASE_API_KEY）：
pnpm --filter @lynse/tauri mirror:cloudbase -- v1.1.6 --dry-run # 只校验与改写，不上传
pnpm --filter @lynse/tauri mirror:cloudbase -- v1.1.6           # 校验通过后上传并翻牌
```

脚本会拒绝三种半成品状态：清单缺任一平台条目、缺 minisign 签名、清单引用的产物没下载下来。

**流量配额提醒**：当前环境为「体验版」套餐，静态托管 CDN 流量配额很小；安装包
100–300MB，少量用户更新即可耗尽配额。发布正式版前请升级套餐（或改用独立
COS 桶直读）。endpoint 已是单源（GitHub 兜底已移除），配额耗尽期间客户端检查更新会
失败并在 UI 显示检查失败，配额恢复后自动继续——不影响已安装应用的使用。

## 密钥管理（重要！）

- 私钥：`~/.tauri/lynse-desktop.key`（**绝不提交到仓库**，已配置为 GitHub Secret `TAURI_SIGNING_PRIVATE_KEY`）
- 公钥：`~/.tauri/lynse-desktop.key.pub`，内容已写入 `tauri.conf.json` 的 `plugins.updater.pubkey`
- 私钥无密码，对应 Secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 为空字符串

⚠️ **私钥丢失 = 已发布客户端永远无法自动更新**（签名对不上，用户只能重新手动安装）。
请务必备份 `~/.tauri/lynse-desktop.key` 到密码管理器/安全存储。若私钥泄露，需生成新密钥对、
更换 `pubkey` 并引导用户手动安装一次新版本。

## 发布流程（全自动）

```bash
# 1. 更新版本号（三处需一致）
#    apps/tauri/src-tauri/tauri.conf.json → "version"
#    apps/tauri/src-tauri/Cargo.toml      → [package] version
#    apps/tauri/package.json              → "version"
# 2. CHANGELOG.md 顶部加条目（latest.json 的 notes 由 mirror 脚本取自这里）
# 3. 提交 + 打 tag 推送
git commit -am "release: v1.1.8"
git tag v1.1.8
git push origin main v1.1.8
# 4. GitHub Actions「Release」工作流自动：
#    - 构建 Windows (msi) + macOS (dmg)，Developer ID 签名 + 公证（已配 APPLE_* Secrets 时）
#    - 用 minisign 私钥签名，生成 .sig 文件
#    - 生成 latest.json 并连同安装包上传到该 tag 的 Release
#    - mirror-cloudbase 任务把资产镜像到 CloudBase 静态托管，改写 URL 后发布 updates/latest.json
#    - verify-updates 断言线上清单版本/平台/可下载性，不过则发版失败
# 5. 已发布的客户端在下次轮询时自动收到更新并一键升级；
#    官网下载页读 latest.json 自动展示新版本，无需改官网代码
```

## 本地构建签名包（可选）

设置了 `createUpdaterArtifacts: true` 后，`tauri build` 必须能拿到私钥，否则打包失败：

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/lynse-desktop.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
pnpm --filter @lynse/tauri build
```

（`tauri dev` 不打包，不受影响。）

## 注意事项

- **旧版本兼容**：`v0.1.29` 及更早的客户端仍通过 `https://api.lynse.cn/v1/client/latest-version`
  代理接口做版本检查（旧 check_app_update 命令）。该后端接口需保留至旧版本基本淘汰。
- **历史编译包内的 GitHub endpoint**：`1.0.x` 等旧包编译时带有 GitHub 兜底 endpoint，但该
  仓库私有、匿名 404，从来不是可用兜底；新包已移除（`tauri.conf.json` 只保留 CloudBase）。
  一旦 CloudBase 镜像断更，旧版本没有任何兜底，只能靠用户从官网重装——`verify-updates` /
  `updater-staleness.yml` 就是为拦截这种静默断更而设。
- **缓存**：原生域名走网关直读 COS，`no-store, no-cache` 强一致。自定义域名
  `dl.lynse.cn` 带 CDN 缓存（实测响应头 `max-age=300, s-maxage=600`），清单与安装包
  最多延迟 5–10 分钟生效——在可接受范围内，换版本后立刻自检若未提示更新可稍等重试。
- **发布页链接**：更新弹窗里的"查看发布"与沙盒（TestFlight）构建的引导按钮都指向官网
  下载页 `https://www.lynse.cn/download`（`tauri-bridge.ts` 的 `RELEASES_PAGE_URL` 与
  `packages/views/about/links.ts` 的 `DOWNLOAD_URL`）。
- **macOS 签名**：配置 APPLE_* Secrets 后为 Developer ID 签名 + 公证（官网直发的正式形态）；
  Secrets 缺省时退回 ad-hoc 签名，仅限内部测试（Gatekeeper 需右键打开、更新后 TCC 授权
  丢失）。`capabilities/default.json` 的 opener 白名单只放行 `https://www.lynse.cn/*`。
- **版本比较**：由 updater 插件按 semver 判断，`version` 字段必须是合法 semver（如 `1.1.8`）。
