# Pocket 桌面端逆向分析 — Windows 补充（2026-10-03）

> 对象：Open Vision Engineering **Pocket** Windows 桌面端 v0.3.135，`%LOCALAPPDATA%\Pocket\Pocket.exe`（单文件 81,913,344 B）。
> 姊妹篇：`docs/pocket-desktop-reverse-analysis.md`（macOS v0.3.129，2026-10-02）。本文**验证/修正**其结论，并补齐 Windows 侧与前端实现细节。
> 仅用于架构学习。**不复制其代码、资产、提示词**；下文所有机制均为行为描述，非源码摘录。
> 逆向产物（60.8 MB，406 个文件）在仓库外：`C:\Users\johne\Documents\Work\pocket-re\extracted\`。其中 `pocket-C8otYjYB.gif`(19MB)、`pocket.png`、各 hero 图是**其品牌资产，禁止引入 Lynse**。

## 一、方法与可信度

Windows 侧比 macOS 简单得多——不需要解 dyld chained fixups：

| 层 | 手段 | 可信度 |
|---|---|---|
| 数据层 | 复制 `pocket.db` 到 scratch 后用 `sqlite3` 读 schema（**不读行数据**；且实测全表 0 行，未登录） | 高 |
| 前端层 | PE 段表 → 发现资源以 `(名字, brotli 裸流)` 序列直接躺在 `.rdata`；按名字锚点切分 + `zlib.brotliDecompressSync` 解出 406 文件 | 高（可读 minified 源码） |
| Rust 层 | 全二进制 strings（216,668 条）+ cargo registry 路径 + `.cargo\registry\src\...` crate@version | 高（依赖表、模块名、SQL） |
| 后端 | 前端 JS 里的 `"/api/v1/..."` 字面量 | 中（只有接口面） |

工具链：Node 24（自带 brotli + BigInt，无需 pip 装 brotli）、Android SDK 的 `sqlite3`、`xxd`。无 binutils/7z 也可完成。

## 二、二进制结构（Windows）

```
Pocket.exe  PE32+ x64, 11 sections, imageBase 0x140000000
  .text   23.1 MB
  .rdata  56.9 MB   <-- 前端资产全在这里（.rdata 尾部含 Rust 常量池）
  .data    0.65 MB
  .pdata / .00cfg / .eh_fram / .tls / _RDATA / .rsrc(37KB 仅图标+版本) / .reloc
  .taubndl   16 B   <-- Tauri bundle 指针 { *const void = 0x1447c9620, u32 = 3 }
```

要点：
- **无 PDB**（Debug 目录只有一项 type=0，symbolTable=0）→ 符号不可用，strings 是唯一路径。
- **`.rsrc` 里没有资产**（仅 37 KB 图标/版本信息），资产不是 PE 资源，而是 `.rdata` 里的**连续容器**：`名字字符串` 紧跟其 **brotli 裸流**，下一条名字即上一条载荷的终点。Brotli 解码器在最后一个 block 结束即停止，所以「取到下一条名字之前的整段」这种宽松切分也能正确解码。
- 413 个候选名字，406 个成功解出（273 js / 37 ttf / 16 woff / 14 woff2 / 35 png / 15 svg / 5 jpg / 3 html / 2 css / 1 wasm …），共 60.8 MB 明文；7 个跳过项里 2 个是 tauri 报错常量 `Asset … not found; fallback to index.html` 造成的假阳性，其余是 shiki 语法块（ballerina / tokyo-night / mdx）与 `favicon.ico`。
- **入口 HTML 是 `notification.html` + `main-window-ghost.html` 两个独立 Vite entry**（各自 `<script type=module>` + `modulepreload` 共享 chunk）。真正的 SPA 入口 chunk 名字很特别，见第五节。

## 三、数据层：与 macOS **完全一致**

`_sqlx_migrations` 13 条，**版本号与描述逐条相同**：

```
1 create_recordings_table            8  create_upload_queue_table
2 create_recording_details_table     9  add_meta_data_to_recordings
3 create_ask_pocket_sessions_table  10  add_attachments_json_to_ask_pocket_messages
4 create_ask_pocket_messages_table  11  add_deep_research_json_to_ask_pocket_messages
5 add_has_summarization_flag…       12  add_upload_metadata_and_recovery_count
6 create_meetings_table             13  cache_entries_table_and_sort_indexes
7 create_local_recordings_table
```

8 张表 + 28 个索引，与 macOS 文档描述一致。**结论：本地数据层是跨平台同构的，Lynse 若照搬这套 schema，不存在平台分叉成本。**

值得抄的索引细节（Windows 实测）：
- `upload_queue (status, next_attempt_at)` 复合索引 → 定时扫表重试，不用内存定时器堆。
- `local_recordings (upload_status)`、`recordings (recording_at)` + `(id)`、`meetings (start_time)`；排序统一用表达式索引 `COALESCE(recording_at, created_at) DESC, id ASC` 保证分页稳定。
- `cache_entries (resource, cache_key)` + `expires_idx`。

## 四、Rust 层：Windows 依赖画像（从 `.cargo\registry` 路径提取，168 个 crate）

| 用途 | crate |
|---|---|
| 壳 | tauri 2.9.4 / tauri-runtime-wry 2.9.2 / wry 0.53.5 / tao 0.34.5 / webview2-com 0.38.0 / muda 0.17.1（菜单）/ tray-icon 0.21.2 |
| 官方插件 | updater 2.9.0、fs 2.4.5、sql 2.3.1、http 2.5.4、dialog 2.6.0、clipboard-manager 2.3.2、autostart 2.5.1、window-state 2.4.1、opener 2.5.2 |
| 音频采集 | **wasapi 0.19.0**（Windows 环回捕获，对应 macOS Process Tap）+ cpal 0.17.1 |
| 音频编码 | audiopus 0.2.0 + ogg 0.9.2 → **OGG/Opus** |
| 音频解码 | symphonia 0.5.5 全家桶（flac/mp3/aac/adpcm/alac/pcm/vorbis/isomp4/mkv/ogg/riff）→ 本地可解码用户导入的任意音视频 |
| 存储 | sqlx-core/sqlx-sqlite 0.8.6 |
| 崩溃/遥测 | sentry 0.48.5（+panic/+backtrace/+types）+ **crash-handler 0.7.0 + minidumper 0.10.1 + minidumper-child 0.3.0** + findshlibs + rustc-demangle |
| 更新验签 | **minisign-verify 0.2.4**（+ring/rustls） |
| 其它 | screenshots 0.8.10、arboard 3.6.1、infer 0.19.0（按魔数猜 MIME）、**urlpattern 0.3.0**、image/png/fdeflate、zip 4.6.1+zstd+bzip2、shared_child、os_info、phf 0.11.3 |

Rust 模块名（strings 中出现，来自 panic location）：`meeting_intent`、`meeting_reminder_scheduler`、`main_window_ghost`、`record_layer`、`audio_peaks`、`upload_queue`、`cache_entries`、`tray`、`notify`、`updater`、`wasapi`、`prewarm`、`multipart`。

**与 macOS 的差异（重要）**：
- `nap_hold`、`osakit`（AppleScript）、CoreAudio HAL 枚举相关串在 Windows 二进制里**为 0 次命中** → 这些是 macOS 专属模块，Windows 用 wasapi + 原生绘制替代。
- macOS 的「悬浮 pill 悬停预览」用一个 HTML 覆盖窗；Windows **不加载 HTML**，改由 Rust 原生 `paint_silhouette`（`src-tauri/src/main_window_ghost.rs`）绘制同一个剪影，注释明确要求「fill / hairline / corner radius 与 HTML 保持同步」。→ 跨平台视觉一致性靠**人工同步两处实现**，这是他们踩过的坑，Lynse 的 frameless/glass 补丁同样面临。
- **两端都没有任何本地 ASR**（无 whisper/onnx/mlx/sherpa 串）→ 转写、总结、Ask 全部服务端。Lynse 的本地 Qwen3-ASR 依然是真实差异化。

## 五、前端架构：Adapter 分层是**实装**而非规划

解出来的 chunk 直接命名了适配器类，每个适配器**按平台一分为二**、各自成独立懒加载 chunk：

| chunk | 体积 | 导出 |
|---|---|---|
| `PlatformAdapter-*.js` | 527 B | `TauriPlatformAdapter` |
| `StorageAdapter-*.js` | 637 B / 1,614 B | `TauriStorageAdapter` / `WebStorageAdapter` |
| `FileSystemAdapter-*.js` | 2,533 B | `TauriFileSystemAdapter`（+ Web 版） |
| `RecordingCommandsAdapter-*.js` | 2,242 B / 1,250 B | `TauriRecordingCommandsAdapter` / `WebRecordingCommandsAdapter` |
| `AttachmentAdapter-*.js` | ×2 | 同上两版 |

单个适配器只有 0.5–2.5 KB：桌面能力被压成**极小的类实现**，Web 构建完全不携带 Tauri 代码。
对照 Lynse：`CoreProvider` 一个 provider 装全部（且 `wsUrl`/`localeAdapter` 是没人消费的死参数），桌面能力是一个 `window.desktopAPI` 全局对象 ~14 个命名空间，views 侧靠 `isWebPlatform()` + 类型断言取用。→ **Lynse 的差距不在功能，在契约**：没有「同一接口两个实现」的编译期约束。

平台判定集中在入口 chunk 的几个小函数：`__TAURI__ in window` 判桌面、UA 判 windows / mac os / mobile，并对桌面端**主动禁用浏览器剪贴板**（返回 `NotAllowedError`），把剪贴板转交原生实现。

### `tauri-unlisten-guard`：坑是真的，修法值得抄

`/assets/tauri-unlisten-guard-*.js`（282 KB）+ 同名 CSS —— 这**不是**一个工具模块，而是**整个应用的入口 chunk 被改名**成这个名字（含 React、modulepreload polyfill）。也就是说他们把 bug 名字刻在了每次构建的产物名上。

机制（行为描述）：在 `window.__TAURI_EVENT_PLUGIN_INTERNALS__` 上，把 `unregisterListener` **替换为包一层 try/catch 的版本**；只对「命中判定条件的那个错误」静默吞掉，其它错误照抛；首次吞掉时打一条 `console.debug("[tauri-unlisten-guard] Suppressed double-unlisten TypeError for event:", …)`，之后不再重复；并用一个 Symbol 标记防止重复打补丁。补丁在入口执行一次，因此**覆盖所有业务代码里重复 unlisten 的路径**。

另外他们的 listen 封装把 `target` 归一化为 `{kind:"AnyLabel",label}` 或 `{kind:"Any"}`，unlisten 时先调被 patch 的 `unregisterListener` 再 `invoke("plugin:event|unlisten")`——**两处都做**，这是双 unlisten 的根因，也是为什么守卫只能打在 IPC 层而不是业务层。

> Lynse 现状：11 处 `listen` 各自手写 `disposed` 竞态标志，只覆盖 unmount-before-resolve，unlisten 本身裸调无幂等；`apps/tauri/src/main.tsx:55` 的监听从不解除。同一个 TypeError 只在 `apps/tauri/src/e2e/tauri-shim.ts:176-184` 被承认过（测试桩里禁用了该内部字段）。→ **可直接落地：入口一次 monkey-patch，成本 <20 行。**

## 六、后端接口面（Windows v0.3.135 实测，比 macOS 文档更全）

`/api/v1`：
- 转写编辑：`transcript-edit/`、`transcript-agent/session`、`transcript-agent/session/{id}/notes`（**PATCH**）
- 说话人：`speakers/merge`（`{targetSpeakerId, sourceSpeakerIds[]}`）、`transcript-edit/{id}/speaker-by-label/{label}`、`transcript-edit/{id}/segments/replace`
- 行动项：`global-action-items` + `/labels` + `/labels/create` + `/hierarchy` + `/search` + `/bulk-complete` + `/bulk-delete`
- 会议：`calendar/sync`（带 `syncDays`）、`calendar/events/smart`（`pastDays=14, futureDays=7, includeAll, provider`）、`calendar/events/by-range`、`meetings/range`
- 记忆：`users/current/user-profile`、`/versions`、`/import-chatgpt-memory`、`users/current/profile`、`users/current/analytics-traits`
- 上传：`storage/{type}/multipart/start`（`{fileName,contentType}`→`uploadId`）→ 逐片 sign → complete；`global-chat/attachments/upload-url`
- 完善度：`recycle-bin` + `/bulk-restore` + `/bulk-delete`、`share/shared/recording`、`referral/me` + `/claim`、`subscription/checkout/resolve` + `/management-url`、`custom-templates`、`mindmaps/generate`、`summary-comparisons`、`recordings/merge`、`recordings/draft-metadata`、`storage/markdown-to-docx`、`search`、`tags`、`folders`、`files`、`feedback/summary`、`chat/feedback/signal`、`configs`、`settings`、`app-defaults`
- 设备同步：`sync/initial`、`sync/upload`、`sync/complete`、`devices`、`devices/files`
- 集成：`integrations/api-keys`、`integrations/webhooks`、`organization/current`、`organization/invites/accept`

`/api/v2`：`transcript-edit/*`（v2 更活跃）、`calendar/{google,outlook}` + `/exchange-code` + `/status`、`integrations/{notion,todoist,asana,clickup,google-tasks}`（各自 default-project/list + 列表拉取）

前端路由（暴露信息架构）：`/app/ask`、`/app/recordings/live`、`/app/settings/{api-keys,developers,integrations,language,organization,profile,referral,speakers,summary,summary/word-dictionary,support,trash}`
→ `speakers`、`trash`、`referral` 是**设置页一级项**，不是隐藏功能。

## 七、三个可直接搬的机制（有代码级证据）

1. **转写编辑 agent 的乐观锁**：查询键 `["recording-notes", devicePath]`；`GET transcript-agent/session?devicePath=…` 拿 `{session:{id,notes}}`；PATCH `…/session/{id}/notes`。**成功/失败回调都比对 `seq`**：只有 `seq` 与本地 ref 相同才落库/回滚，否则丢弃这次响应（旧 seq 的响应不能覆盖新状态），失败时额外 `invalidateQueries` 拉回真值。→ 会话可持久、多端不互相踩。Lynse 侧目前**转写段是只读 `<p>`**（`content-panel.tsx:1141`），连可编辑地基都没有，这条要拆两步做。
2. **缓存策略注册表 + 本地 mock**：每个远程资源登记一条策略 `{resource, classification(cold/hot…), staleTimeMs, gcTimeMs, maxAgeMs, durable, persistStrategy, version}`；`app-defaults`、`app-config`、`global-speakers` 各一份。同时存在一个**请求拦截式 mock 层**，对 `app-defaults`/`calendar/*`/`global-action-items/{hierarchy,search}` 等返回 demo 数据（`classification_json`、`Demo tag removed locally` 等字样），使离线/Demo 模式下 UI 全程可跑。→ 对应 P2-17，且顺带解决 Lynse 后端未部署时功能只能整块隐藏（`featureFlags.connections`）的问题。
3. **埋点与隐私模式的耦合**：上传链路四个事件（started/progress/failed/completed）载荷固定带 `recording_id / file_size_bytes / duration_seconds / upload_duration_ms / source / privacy_mode`；`privacy_mode` 在失败事件里由「该记录是否为 transcript_submit」推导，并用 `recoveryCount` 阈值过滤重试噪声。特性开关是 PostHog flag（键名如 `desktop-auto-record`、`desktop-windows-pocket-sync`、`desktop-referral`、`summary-email`、`recording_editor`…），代码里带一张**默认值表**兜底（拉不到 flag 时按 false 走）。
   另有会议三开关各自持久化：`pocket-meeting-detection-enabled` / `pocket-meeting-auto-record-enabled` / `pocket-meeting-reminders-enabled`（检测 / 自动录 / 提醒分离，用户粒度更细）。
   还有原生↔渲染层的**ack 协议**：`"did not acknowledge {kind} after {n} attempts"` —— 原生下发指令要求渲染端确认，重试到上限才放弃。

## 八、对既有结论的修正

- macOS 文档第五节 P0-6「Sentry + PostHog」在 Windows 侧**全部属实**（crash-handler+minidumper+sentry 原语、`_posthogChunkIds`、Sentry debug-id 注入 minified chunk）。
- macOS 文档「WebRTC audio-processing 降噪」在 Windows 二进制里**没有对应 crate 串**，未证实；但 wasapi + cpal + audiopus + symphonia 齐全。
- 「Lynse 的 tray 现在只有录制控制」这句对比仍然成立；Pocket 侧会议能力是**独立通知窗（`notification.html`，标题 "Record with Pocket?"）+ tray + 原生调度器（`meeting_reminder_scheduler.rs`）**三件套，而不是把会议塞进 tray 菜单。→ Lynse 若要「一键加入」，做一个 frameless 通知窗比改 tray 菜单更贴近他们的做法。
- `calendar_event_id` 前提为错的判断（见 `connections-*` 评估）继续成立：Pocket 用 `calendar/sync` + `events/smart` 拉取 + 本地 `meetings` 表缓存，**没有把外部 event id 写死成会议主键**。

## 附：产物与复现

- 前端解包：`C:\Users\johne\Documents\Work\pocket-re\extracted\`（406 文件 + `_manifest.json`：name/offset/compressed/bytes/编码方式）
- 脚本：同目录 `pe-info.mjs`（PE/段/资源）、`pe2.mjs`（imageBase + `.taubndl`）、`bundle.mjs`、`ctx.mjs`（记录头取证）、`extract.mjs`（解包）、`strings.mjs` → `strings.txt`(216,668 条)、`crates.txt`(168)
- 本地数据：`%APPDATA%\com.openvisionengineering.pocket-desktop-app\pocket.db`（空库）、`startup-sentinel.json`（`{"phase":"frontend-ready","app_version":"0.3.135","attempts":0}`）、`.window-state.json`
- 未覆盖：**手机端（APP 端）无包**。本机无 Pocket APK/IPA；需用户提供安装包才能继续。桌面端已闭环。
