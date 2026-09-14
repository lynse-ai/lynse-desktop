# 应用内自动更新（Auto-Update）

应用已从「跳转 GitHub Releases 手动下载」升级为 **tauri-plugin-updater 驱动的全自动更新**：
检测更新 → 应用内下载 → minisign 签名校验 → 自动安装 → 自动重启进入新版本。无需用户手动下载任何文件。

## 工作原理

```
客户端 (tauri-plugin-updater)
   │  轮询 endpoints（每 30 分钟 + 手动"检查更新"，按顺序尝试）
   ▼
① https://lynse-d8g49o1i956741f9e-1401959758.tcloudbaseapp.com/updates/latest.json   ← 腾讯云 CloudBase 静态托管（主）
② https://github.com/lynse-ai/lynse-desktop/releases/latest/download/latest.json   ← 兜底
   │  返回 { version, platforms: { "<target>": { url, signature } } }
   ▼
客户端比较版本 → 有新版本 → UI 提示（通知中心 / 侧边栏卡片 / 设置页）
   │  用户点"立即更新"（或后续接静默更新）
   ▼
从 latest.json 内 url 下载安装包（CloudBase）→ 用 tauri.conf.json 中的 pubkey 校验 .sig 签名
   → 安装 → relaunch()
```

发布链路：GitHub Actions 仍然负责构建、minisign 签名并把产物发布到 GitHub Release（源头 +
回滚依据）；随后 `mirror-cloudbase` 任务把 Release 资产镜像到腾讯云 CloudBase 静态托管
（环境 `lynse-d8g49o1i956741f9e`，上海），并将 `latest.json` 内的下载地址改写为
CloudBase 地址后发布。客户端更新流量走 CloudBase，GitHub 仅在不可用时兜底。

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

## 腾讯云 CloudBase 配置（一次性）

更新分发使用 CloudBase 静态托管（环境 `lynse-d8g49o1i956741f9e`，地域上海，
域名 `lynse-d8g49o1i956741f9e-1401959758.tcloudbaseapp.com`，已实测匿名公网可读、
单文件 100MB+ 可上传、网关直读 COS 强一致无缓存延迟）。

只需在仓库 Secrets 配置一个变量：

| Secret | 说明 |
| --- | --- |
| `CLOUDBASE_API_KEY` | 环境级 API 密钥，在 云开发控制台 → 环境设置 → API 密钥 创建（仅授予该环境，风险小于腾讯云主账号密钥） |

未配置该 secret 时，CI 自动跳过镜像，行为与迁移前完全一致（仅 GitHub）。

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

**流量配额提醒**：当前环境为「体验版」套餐，静态托管 CDN 流量配额很小；安装包
100–300MB，少量用户更新即可耗尽配额。发布正式版前请升级套餐（或改用独立
COS 桶直读），配额耗尽时 updater 会自动回退到 GitHub endpoint，更新不会中断。

## 密钥管理（重要！）

- 私钥：`~/.tauri/lynse-desktop.key`（**绝不提交到仓库**，已配置为 GitHub Secret `TAURI_SIGNING_PRIVATE_KEY`）
- 公钥：`~/.tauri/lynse-desktop.key.pub`，内容已写入 `tauri.conf.json` 的 `plugins.updater.pubkey`
- 私钥无密码，对应 Secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 为空字符串

⚠️ **私钥丢失 = 已发布客户端永远无法自动更新**（签名对不上，用户只能重新手动安装）。
请务必备份 `~/.tauri/lynse-desktop.key` 到密码管理器/安全存储。若私钥泄露，需生成新密钥对、
更换 `pubkey` 并引导用户手动安装一次新版本。

## 发布流程（全自动）

```bash
# 1. 更新版本号（两处需一致）
#    apps/tauri/src-tauri/tauri.conf.json → "version"
#    apps/tauri/src-tauri/Cargo.toml      → [package] version
# 2. 提交 + 打 tag 推送
git commit -am "release: v0.1.30"
git tag v0.1.30
git push origin main v0.1.30
# 3. GitHub Actions「Release」工作流自动：
#    - 构建 Windows (msi) + macOS (dmg)
#    - 用私钥签名，生成 .sig 文件
#    - 生成 latest.json 并连同安装包上传到该 tag 的 Release
#    - mirror-cloudbase 任务把资产镜像到 CloudBase 静态托管，改写 URL 后发布 updates/latest.json
# 4. 已发布的客户端在下次轮询时自动收到更新（CloudBase 主、GitHub 兜底）
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
- **迁移过渡**：endpoint 列表编译进客户端，因此 `1.0.3` 及更早的版本仍只轮询 GitHub；
  本改动发布后，该版更新必须能从 GitHub 下载（兜底保证），之后的更新流量才切到 CloudBase。
- **缓存**：GitHub 的 `releases/latest/download/latest.json` 有约 5 分钟 CDN 缓存；
  CloudBase 静态托管网关返回 `no-store, no-cache`（直读 COS，强一致），发版即时生效。
  代价是没有边缘缓存，大文件下载每次回源 COS；若日后接入自定义 CDN 域名，
  需为 `updates/latest.json` 配置短 TTL（如 60–300 秒）。
- **发布页链接**：更新弹窗里的"查看发布"仍指向 GitHub Releases 页面
  （`tauri-bridge.ts` 的 `RELEASES_PAGE_URL`），仅为浏览用途，不影响更新流程。
- **macOS 签名**：当前为 ad-hoc 签名。如需 Developer ID 公证分发，在 release.yml 中补充
  `APPLE_CERTIFICATE` 等环境变量即可，updater 流程不受影响。
- **版本比较**：由 updater 插件按 semver 判断，`version` 字段必须是合法 semver（如 `0.1.30`）。
