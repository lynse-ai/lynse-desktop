# Pocket 桌面端逆向分析（2026-10-02）

> 对象：Open Vision Engineering 的 **Pocket**（heypocket.com）桌面 app v0.3.129，`/Applications/Pocket.app`。
> Pocket = AI 录音硬件（MagSafe 挂件）+ 手机/桌面伴侣 app，WIRED 2026「Best AI Notetakers」亚军，$129 硬件 + 订阅。
> 与 Lynse 同赛道（会议录音 → 转写 → AI 总结/问答）。本文仅用于架构学习，不复制其代码/资产/提示词。

## 一、逆向方法与可信度

桌面端是 Tauri 2 应用（同 Lynse 技术栈），未 strip 符号（8.2 万符号），前端资产 brotli 压缩嵌入二进制。

| 层 | 手段 | 可信度 |
|---|---|---|
| 数据层 | 直接读 `~/Library/Application Support/.../pocket.db`（SQLite + sqlx migrations） | 高，含真实用户数据验证 |
| Rust 层 | `nm` 符号 + strings + cargo registry 路径 | 高（依赖表、模块名、错误消息） |
| 前端层 | 解码 dyld chained fixups 定位 phf 资产表 → 逐个 brotli 解压，还原完整 Vite 产物（414 个文件，主 bundle 5.8MB） | 高（可读的 minified 源码） |
| 后端 | 前端 JS 里的 REST 端点 + Tauri CSP 白名单 | 中（只有接口面，无实现） |

## 二、总体架构

```
┌─ macOS app (Tauri 2, universal binary 168MB) ─────────────────────┐
│  Rust: cpal/CoreAudio Process Tap(系统音频) + mic 双路捕获         │
│        ringbuf 无锁环形缓冲 → WebRTC audio-processing(降噪/AGC)    │
│        → audiopus 编码 OGG/Opus → local_recordings/xxx.ogg        │
│  Rust: sqlx + SQLite(pocket.db) = 本地 source of truth            │
│        upload_queue 状态机(分片上传 S3) + cache_entries 资源缓存   │
│  Rust: meeting_intent 检测 / meeting_reminder_scheduler /          │
│        tray_icon / nap_hold(App Nap 抑制) / osakit(AppleScript)    │
│  前端: React + Vite + TanStack Query，Adapter 模式分层             │
│        (Platform/Storage/Network/FileSystem/RecordingCommands)     │
│  可观测: Sentry(Rust minidumper + JS) + PostHog(全链路埋点+AB)      │
└───────────────────────────────────────────────────────────────────┘
        │ https://production.heypocketai.com/api/v1/*
        ▼
  后端 REST + S3(us-west-1) 分片签名上传；转写/总结/聊天全部服务端
  更新链: updater API + releases.heypocketai.com + S3 兜底, minisign 验签
```

桌面端**没有任何本地转写模型**（无 whisper/onnx），转写、总结、Ask Pocket 全部服务端完成。这是与 Lynse（本地 MLX Qwen3-ASR）最大的差异。

## 三、数据模型（pocket.db，13 个 sqlx migration）

- `recordings` — 列表轻行：title/duration/folder/gradient_data(波形)/has_summarization；`recording_details` — 详情大 JSON（转写+总结）**按 recording_id 单独一张表**，列表查询永不拖详情。
- `ask_pocket_sessions` / `ask_pocket_messages` — 会话列表做了反范式：`last_message_at/preview/role/message_count` 冗余在 session 行，列表零 N+1；消息带 `source_recordings_json / source_tags_json / source_speakers_json`（聊天作用域绑定录音/标签/说话人集合）、`attachments_json`、`deep_research_json`。
- `meetings` — 日历事件缓存：provider/event_id/meeting_link/attendee_count + `classification_json`（会议分类）+ `recording_json`（关联录音）。
- `local_recordings` — 本地录音与上传解耦：`upload_status/upload_progress/retry_count/last_attempt/last_error/user_id`。
- `upload_queue` — 通用上传队列：`status/priority/retry_count/next_attempt_at/last_error/payload_json/recovery_count`，`(status, next_attempt_at)` 复合索引 = 定时扫表重试。
- `cache_entries` — **通用服务端资源缓存表**：`(resource, cache_key) → data_json + fetched_at/expires_at/invalidated_at/version/source`。
- 所有表带 `local_updated_at`；排序列表用 `COALESCE(recording_at, created_at) DESC, id ASC` 的表达式索引保证稳定分页。

## 四、API 面（/api/v1，从 JS 提取）

- 录音/转写：`recordings`、`transcript-edit/`、`transcript-agent/session`（AI 修转写，session+seq 乐观锁）、`speakers/merge`、`custom-vocabulary`（热词）、`summary-comparisons`（总结对比）。
- 聊天：`chat/message/stream`（流式）、`chat/ephemeral/...`、`global-chat`（跨录音问答）+ `deep-research/availability`（深度研究开关 + 进度事件）+ `attachments/upload-url`。
- 行动项：`global-action-items` + `/labels` + `/hierarchy` + `/search` + `/bulk-complete|delete`（跨录音行动项管理系统）。
- 会议：`calendar/sync`、`calendar/events/smart`、`calendar/events/by-range`、`meetings/range`。
- 记忆画像：`users/current/user-profile` + `/versions` + **`/import-chatgpt-memory`**（导入用户的 ChatGPT 记忆，版本化）。
- 平台：`storage/{type}/multipart/start|sign|complete`（S3 分片，服务端逐片签名）、`sync/initial|upload|complete`（设备同步，deviceId+bindKey）、`devices/files`、`folders`、`tags`、`search`、`recycle-bin/bulk-restore`、`share/shared/recording`、`mindmaps/generate`、`custom-templates`、`integrations/api-keys|webhooks`、`organization/invites/accept`、`referral/me|claim`、`subscription/checkout|management-url`、`app-defaults`（远程配置）。
- 增长/实验：PostHog（feature flags + surveys + product tours + early_access_features），事件命名如 `TRANSCRIPTION_SERVICE_AB_TEST`、`trackMeaningfulAction("recording_started")`，录音全链路（upload started/progress/failed/completed）都带 `privacy_mode`、时长、耗时维度。

## 五、值得 Lynse 学的（按优先级）

### P0 — 架构层，直接可落地

1. **本地 SQLite 当 source of truth + 通用上传队列**。Pocket 的可靠性完全靠 `upload_queue`（优先级/重试/退避/恢复计数）+ `local_recordings.upload_status` 状态机，断网、杀进程、升级都不丢录音。Lynse 的 cloud-sync 链是即时调用 + 手工复用 cloudFileId，建议抽成同一张队列表 + 同一套重试引擎。
2. **列表/详情分离 + 会话列表反范式**。与 Lynse 的 list-query-caching 方向一致，但 Pocket 做在 DB 层：列表行轻、详情单表、session 冗余 last_message_*。Lynse 的列表缓存可以考虑同样把「列表行」和「详情 blob」拆开持久化。
3. **cache_entries 式结构化缓存**。比 JSON 快照式 query-persistence 多了 version/invalidation/source，跨升级可失效。适合 Lynse 的 notes/folders/recordings 列表缓存演进。
4. **音频管线**：启动即 **prewarm**（实测冷启动 3.7s，预热后 <1s）、录制期间 `nap_hold` 压 App Nap、WebRTC 降噪、**Opus/OGG 存储**（5 分钟 ≈ 500KB，Lynse 的 WAV 是几十 MB 量级）、`audio_peaks` 波形数据落库做渐变缩略图。Lynse 至少可以：波形 peaks 落库 + 评估 Opus 编码上传（服务端再转码）。
5. **启动/音频诊断文件**：`startup-sentinel.json`（启动阶段打点）+ `audio-setup-trace.txt`（每步耗时：prewarm/tap/mic 分阶段）。用户报障时让这两个文件说话——正好治 Lynse 的 tray 录音链路调试痛点（现在全靠 AppleScript + log 现场考古）。
6. **Sentry + PostHog**。Pocket 崩溃有 minidump、行为有埋点、转写服务有 AB。Lynse 目前零遥测，线上问题全靠用户口述。哪怕只接 Sentry + 几个关键事件（recording_started/upload_failed）也是质变。

### P1 — 产品功能

7. **会议智能**：日历双向同步 + `calendar/events/smart` + meeting_intent 检测（URL/通话意图）+ 自动录制开关 + 提醒调度器 + **tray 直接显示今日会议并可一键加入**。Lynse 的 tray 现在只有录制控制。
8. **行动项管理面**：从各场会议提取的行动项聚合到全局列表，带标签/层级/批量/搜索/完成态。Lynse 有 todo + EventKit 写入，缺「AI 提取后的统一管理」。
9. **用户记忆画像**：`user-profile` 多版本 + ChatGPT 记忆一键导入。让助手「认识用户」，且可回滚。成本不高、感知极强。
10. **转写编辑 agent**：不是简单重生成，而是会话式（session + seq 乐观锁 + notes 持久化）让 AI 按指令修转写错字/术语。
11. **说话人 merge**：Lynse 声纹注册领先，但缺后置的合并/改名编辑面，两者互补。
12. **产品完善度全家桶**：回收站（bulk-restore）、分享链接、推荐码、隐私模式（录音前开关并贯穿埋点）、模型选择器、升级 banner。都是小活但决定产品完成度。

### P2 — 工程实践

13. S3 分片上传（start → 逐片 sign → complete），大文件断点续传；Lynse 的 OSS direct PUT 可加片化。
14. 更新链：自有 updater API + 静态 releases 文件 + S3 兜底 + minisign 验签（Lynse 的 tag-push CI 可参考其兜底思路）。
15. `tauri-unlisten-guard`：把 Tauri「双 unlisten 抛 TypeError」的已知坑在 IPC 层 patch 掉（连 HTML entry 都改名铭记）。Lynse 的前端也大量监听 Tauri 事件，值得抽同样的守卫。
16. 前端 Adapter 粒度：Platform/Storage/Network/FileSystem/RecordingCommands 五个 adapter 各自成 chunk 按平台懒加载，比 Lynse 的单一 CoreProvider 粒度细。
17. 远程配置 `app-defaults`（带 staleTime 分类 + 本地 mock 兜底）+ PostHog flags/轮播/调研，发版即实验。

## 六、Lynse 领先、不用学的

- **本地转写**（MLX Qwen3-ASR、离线可用、不扣积分）—— Pocket 完全没有。
- **Web 端 + 自有平台化**（Next.js + api.lynse.cn + OSS 多端）。
- **声纹注册**（CAM++ 注册一次长期复用）。
- **EventKit 待办 → 系统日历**。
- **i18n**（Pocket 前端纯英文，无多语言迹象）。
- 硬件设备同步链（deviceId+bindKey）—— Lynse 无硬件，不适用。

## 附：逆向产物位置

- 前端解压产物：`/tmp/pocket_src/`（414 文件，主 bundle `main-DQRVFQKz.js`）
- 资产 blob：`/tmp/pocket_assets/`（brotli 未解压），提取脚本 `/tmp/extract3.py`
- 符号表：`/tmp/pocket_syms.txt`，strings：`/tmp/pocket_strings.txt`
- 本地数据：`~/Library/Application Support/com.openvisionengineering.pocket-desktop-app/`
