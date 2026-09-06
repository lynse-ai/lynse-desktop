# 应用内自动更新（Auto-Update）

应用已从「跳转 GitHub Releases 手动下载」升级为 **tauri-plugin-updater 驱动的全自动更新**：
检测更新 → 应用内下载 → minisign 签名校验 → 自动安装 → 自动重启进入新版本。无需用户手动下载任何文件。

## 工作原理

```
客户端 (tauri-plugin-updater)
   │  轮询 endpoints（每 30 分钟 + 手动"检查更新"）
   ▼
https://github.com/lynse-ai/lynse-desktop/releases/latest/download/latest.json
   │  返回 { version, platforms: { "<target>": { url, signature } } }
   ▼
客户端比较版本 → 有新版本 → UI 提示（通知中心 / 侧边栏卡片 / 设置页）
   │  用户点"立即更新"（或后续接静默更新）
   ▼
下载安装包 → 用 tauri.conf.json 中的 pubkey 校验 .sig 签名 → 安装 → relaunch()
```

关键文件：

| 文件 | 作用 |
| --- | --- |
| `apps/tauri/src-tauri/tauri.conf.json` | `plugins.updater`：公钥 + endpoints；`bundle.createUpdaterArtifacts: true` |
| `apps/tauri/src-tauri/src/lib.rs` | 注册 `tauri_plugin_updater` / `tauri_plugin_process` |
| `apps/tauri/src/tauri-bridge.ts` | `check()` 检测 + `downloadAndInstall()` 进度 + `relaunch()`，暴露为 `window.desktopAPI.app.*` |
| `packages/views/app-update.ts` | 更新轮询、安装进度状态（全局单例），`useAppUpdate()` 供 UI 使用 |
| `packages/views/settings/settings-dialog.tsx` | 设置页"关于"卡片：安装按钮 + 进度条 |
| `packages/views/layout/app-sidebar.tsx` | 侧边栏 `UpdateReminder` 卡片：安装按钮 + 进度条 |
| `.github/workflows/release.yml` | 打 tag 自动构建、签名、生成并上传 `latest.json` |

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
# 4. 已发布的客户端在下次轮询时自动收到更新
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
- **GitHub 缓存延迟**：`releases/latest/download/latest.json` 有约 5 分钟的 CDN 缓存，
  发布后老客户端最长延迟几分钟才能检测到，属正常现象。
- **macOS 签名**：当前为 ad-hoc 签名。如需 Developer ID 公证分发，在 release.yml 中补充
  `APPLE_CERTIFICATE` 等环境变量即可，updater 流程不受影响。
- **版本比较**：由 updater 插件按 semver 判断，`version` 字段必须是合法 semver（如 `0.1.30`）。
