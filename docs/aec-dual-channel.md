# macOS 会议双路录音与回声消除（AEC3）实施说明

方案：录音默认双通道采集（系统音频 + 麦克风），用 vendored WebRTC AEC3 消除系统回声，
原始音轨保留本机、可随时重处理。本文记录实现位置、数据流与验收方式。

## 数据流

```text
ScreenCaptureKit（单 SCStream，48 kHz）
  ├─ 系统轨：原始 48k 立体声 → system_raw.wav；下混单声道 → 16k → system.wav（识别 + 回放混音）
  └─ 麦克风：原始 48k 单声道 → mic_raw.wav；AEC3（参考=系统下混）→ 16k → mic_processed.wav（识别 + 回放混音）

识别流（两路 16k/20ms 帧）→ Unix socket → Rust → 各 provider websocket
停录：排空 AEC/重采样尾帧 → 混音（system.wav + mic_processed.wav）→ <结束时间>.wav + tracks.json
```

- 时间轴：全部以样本 PTS（host clock）定位，双轨天然对齐；缺帧补静音，不压缩时间轴。
- 降级：参考缺失/引擎失败 → 麦克风直通并记录降级区间（tracks.json 的
  `degradedIntervalsMs`），绝不静音丢弃；重处理入口可修复。

## 关键文件

| 层 | 位置 |
|---|---|
| 引擎 vendor | `apps/tauri/audio-capture/vendor/`（webrtc-audio-processing 1.3 + abseil 20230125.1，SHA256SUMS 固定） |
| 引擎构建 | `apps/tauri/scripts/build-webrtc-aec.sh` → `vendor/build/lib/liblynse_dsp.a`（meson+ninja+libtool 合并） |
| C ABI | `apps/tauri/audio-capture/dsp/lynse_aec.h/.cc`（Windows 复用同一 ABI，见 `src/audio_contract/aec3.rs`） |
| Swift 管线 | `audio-capture/Sources/AudioCaptureCore/`：`DualChannelProcessor`（配对+AEC+降级）、`AcousticDelayEstimator`（一阶差分去包络互相关）、`Decimator48to16`、`SampleTimeline`、`TrackManifest`、`WavReader` |
| 采集进程 | `audio-capture/Sources/lynse-audio-capture/main.swift`（`--aec` 开关、`--process <dir>` 离线重处理） |
| 会话层 | `apps/tauri/src-tauri/src/live_translation.rs`：`dual_channel` 会话开关、`ensure_dual_channel_processed`（崩溃恢复自动重处理）、`live_translation_reprocess` 命令、双轨 persist/manifest |
| 转写 | `apps/tauri/src-tauri/src/lib.rs`：`transcribe_dual_tracks`（按轨串行转写+时间轴合并+`trackStatuses`）、`local_transcription_retry(…, {track})` 按轨重试、`local_transcription_track_audio_url` + media handler 分轨播放 |
| 契约 | `apps/tauri/src-tauri/src/audio_contract/`（并行会话实现的跨平台 manifest/工具；`MANIFEST_FILE = tracks.json`，与 macOS sidecar 同一文件同一 schema） |
| 前端 | `packages/views/workspace/content-panel.tsx`（全部/本机/远端试听、降级横幅+重新处理、按轨重试）、`locales/*.ts`（`workspace.track_*`、`aec_degraded_banner` 等；`live_translation.me` = 本机） |

## 回退与兼容

- `--aec` / `StartRequest.dual_channel`（默认 true，仅 macOS）是总开关：关掉只影响新录音，
  走旧 16k 管线；已生成的新格式录音继续可读（无 tracks.json 的记录走单文件流程）。
- 文本回声去重（`deduplicate_echoes`/`echoOf`）：双路会话不再应用；旧录音的 echo 标记继续兼容。
- 云同步成功后所有源文件（含新原始轨）删除，仅保留回放混音与转写。

## 验证状态

- Swift 自测（`pnpm --filter @lynse/tauri test:audio-capture`）：ERLE ≥20dB（实测 51.6）、
  双讲本机无损（−0.03dB）、缺参考直通、时间轴不压缩、重启交接、抽取器一致性。
- `cargo test --lib` 141 通过；`tsc`（views/tauri）无新增错误。
- ⚠️ 测 ERLE 必须用宽带信号（formant 噪声类）；纯音信号对 AEC3 是病态输入。

## 真机验收清单（方案第三阶段门槛）

| 项目 | 要求 |
|---|---|
| 来源归属 | 全部结果按采集来源归属，无本机/远端互换 |
| 远端独讲 | 内置扬声器外放，稳定后平均回声衰减 ≥20 dB |
| 重复转写 | 标准外放场景，远端句子在本机轨重复 ≤1% |
| 本机独讲 | 对照原始轨，同模型中文 CER/英文 WER 劣化 ≤2pp |
| 同时讲话 | 识别错误率劣化 ≤5pp，无整句本机讲话被截断 |
| 时间同步 | 两小时录音两轨对齐误差 ≤50 ms |
| 处理性能 | 10ms 帧 P95 <10ms；新增延迟 P95 ≤100ms |
| 稳定性 | 无持续内存增长、无未标记音轨缺口、无因远端独讲提前结束 |

覆盖设备：内置扬声器+麦克风、有线耳机、AirPods、USB 麦克风；Zoom / 腾讯会议 / 浏览器会议；
音量调整、耳机插拔、暂停恢复、两小时连续录音。
