# Windows 会议双路录音：共享契约与实施说明

对应实施方案：《Windows 会议双路录音与回声消除实施方案》。本文记录两端共享契约的落点、Windows 侧实现结构、功能开关与验收前置条件。

> 契约对齐说明：macOS sidecar 侧的迁移（`audio-capture/dsp/lynse_aec.h/.cc` C 桥、`TrackManifest.swift`、`DualChannelProcessor` 等）与 Windows 侧共享同一套冻结契约——`tracks.json` schema 字段名与 `lynse_aec` C ABI 两端一致，Windows 引擎逐条镜像了 macOS 处理器的配对/降级语义。

## 1. 契约的落点

| 契约 | 代码位置 | 说明 |
|---|---|---|
| 音轨清单 schema | `src-tauri/src/audio_contract/manifest.rs` ⇄ `audio-capture/.../TrackManifest.swift` | `tracks.json`（v1）**字段名已冻结**：`version/engine/sampleRate/tracks[{id,file,role,processed,sampleRate,channels}]/degradedIntervalsMs` |
| 有状态重采样 | `audio_contract/resampler.rs` ⇄ `Decimator48to16.swift` | 48k→16k 3:1 精确抽取；48k↔44.1k 保相位 |
| 20ms 分帧 | `audio_contract/framer.rs` | 16 kHz 单声道 s16、640 字节帧；缺口按时间位置补静音，绝不拼接 |
| 轨落盘与断头修复 | `audio_contract/wav.rs` | 流式写、`close()` 修 RIFF 头；崩溃后可 `repair_header` |
| 回声消除 C ABI | `dsp/lynse_aec.h/.cc`（唯一实现）⇄ `audio_contract/aec.rs/aec3.rs` | 一套 ABI、两个后端（gate / aec3） |
| 处理器语义 | `DualChannelProcessor.swift` ⇄ `windows_capture/engine.rs`（AecBridge） | 48k 样本位置配对、30 帧参考停顿上限、500 帧队列上限、参考丢失时静默参考直通 + 降级标记 |

## 2. 音轨清单（tracks.json）

- 会话目录在开始时写入、结束（引擎 stop、全线程 join、修 WAV 头）后补全。
- 轨表（冻结）：`mic_raw.wav`（48k/单声道 s16）、`system_raw.wav`（48k/立体声 s16）、`mic_processed.wav`（16k，消回声后的本机识别/回放轨）、`system.wav`（16k 系统识别轨，`processed:false`）。
- `degradedIntervalsMs`：无法消回声的半开区间（参考丢失/引擎拒帧），相邻合并。
- Windows 增量字段（macOS 写端不产出，读端缺省容忍）：`sessionId`、`createdAt`、`devices[{endpointId,name,rawMode,asRequested}]`、`gaps[{track,startMs,endMs,reason}]`（设备重连/位置跳变/时间戳错误等全部补位区间）。
- 固定归属：`mic → 本地`、`system → 远端`，声纹/模型标签不得改写。
- 录音完成后清单整体嵌入 `local-transcriptions` 记录的 `trackManifest` 字段；`persist_session` 的默认混音取 `system.wav + mic_processed.wav`（兼容旧 `mic.wav`）。

## 3. 回声消除 C ABI（dsp/lynse_aec.h，冻结）

```c
lynse_aec_t *lynse_aec_create(int sample_rate_hz);   // 16k/32k/48k
void         lynse_aec_destroy(lynse_aec_t*);
const char  *lynse_aec_engine_id(void);              // "webrtc-aec3-1.3"
int  lynse_aec_process_reverse(lynse_aec_t*, const float* samples, int frame_count);
int  lynse_aec_process_near(lynse_aec_t*, float* samples, int frame_count, int delay_ms);
void lynse_aec_reset(lynse_aec_t*);
```

- 10 ms 单声道帧；参考为降混后的系统播放；`process_near` 原地处理并携带调用方延迟提示。
- 后端：
  - `aec3`（`--features aec3`）：静态链接固定版本 WebRTC APM（AGC/强降噪关闭）。静态库由 `scripts/build-lynse-aec3.ps1` 产出（Windows，编译**共享的** `dsp/lynse_aec.cc`），macOS 由 `audio-capture/scripts/build-webrtc-aec.sh` 产出 `liblynse_dsp.a`。
  - `gate`（默认，纯 Rust）：相关性门控（macOS EchoGate 语义）——麦克风信号可被系统播放解释为回声时输出静音，原始轨始终保留；48k 处理、16k 判定、250ms 决策窗 + 非对称滞回。
- 参考丢失：喂静默参考保持块对齐，麦克风直通（绝不丢本机语音），区间记 `degradedIntervalsMs`。
- **未通过真实设备验收前不默认启用 aec3**（方案 §5）；`cargo build --features aec3` 时 build.rs 校验静态库存在。
- Windows 侧 delay 提示暂传 0（帧已按位置对齐，AEC3 内部延迟估计器吸收残余声学延迟）；macOS 的 `AcousticDelayEstimator` 相关法移植为后续优化项。

## 4. Windows 引擎结构（windows_capture/）

- `device.rs`：端点枚举（稳定 endpoint id + 友名 + 默认/通信默认标记）、麦克风隐私开关（ConsentStore 注册表）、`ms-settings:privacy-microphone` 跳转、`IMMNotificationClient` 全局注册（回调只置标志，重建由采集线程决策）。
- `engine.rs`：每源一线程（各自 COM 初始化；共享模式 + 事件驱动；loopback 双声道、mic 优先 RAW，失败回退共享并记录）；GetBuffer QPC 映射到会话时间轴（暂停冻结）；设备通知触发代际重建，固定设备不静默换设备，重开失败每秒重试。
- 控制面：`live_translation_pause/resume` 直达引擎；stop 先 join 全部线程、修 WAV 头、写 `tracks.json`，再 `persist_session`。
- 静音自动停：同时检查本机与系统电平（远端独讲不触发提前结束）。
- 开始前任一请求源不可用 → 整次启动明确报错（附权限跳转）；录音中单路失效 → 另一轨继续 + 缺口标记。

## 5. 设备选择

- 命令 `live_translation_audio_devices`：Windows 返回输入/输出端点列表；macOS 返回空列表，UI 据此隐藏选择器。
- `StartRequest` 新增可选 `micDeviceId` / `systemDeviceId`（省略 = 跟随系统默认，且跟随默认在录音中响应默认设备变化）。
- 前端持久化 `localStorage`（`lynse_recording_mic_device` / `lynse_recording_system_device`），存 endpoint id 而非设备名；`desktop-api.ts` 在 start 唯一收口点注入——页面/托盘/一键录制/会议自动录制四个入口全部生效。
- 设置页「录音设备」卡片（`settings/recording-devices-card.tsx`），仅枚举到设备时显示。

## 6. 测试与验收现状

- `cargo test --lib audio_contract`：21 项——含「逐字解析 macOS 冻结 JSON」回归（防两端漂移）、轨表与 macOS `dualChannel` 表一致、缺口/降级区间合并、重采样跨块相位、分帧补位、WAV 修复、gate 行为。
- 双平台 `cargo check`：macOS host + `x86_64-pc-windows-gnu` 交叉检查通过；CI 新增 `windows-audio` job 兜底（该代码 macOS CI 永远不编译）。
- 待真实设备验收（方案 §5 门槛表）：回声衰减 ≥20 dB、重复转写 ≤1%、两小时对齐 ≤50 ms、10ms 帧 P95 <10ms 等。`gate` 后端语义等同 macOS 现网；`aec3` 量化指标需启用 feature 后按方案素材集测试。
- 设置页实时电平为后续项（需常开采集探针）；录音页电平已接引擎。

## 7. 集成状态（macOS 侧完成后核对）

macOS sidecar 迁移已完成并核验（自测通过、打包 sidecar 为 AEC3 版本、静态链入 lynse_aec）：

- 轨文件与 `tracks.json` 字段和本文 §2 逐字一致；legacy 回退（无 `--aec`）写 `mic.wav`/`system.wav`，`persist_session` 双向兼容。
- 功能开关 `StartRequest.dual_channel`（缺省 true，false 回退 legacy）**跨平台生效**：macOS 门 `--aec`；Windows 门 `CaptureConfig.aec_enabled`（无 AEC 桥、无原始轨，各流直写 16k 轨，`tracks.json` 记 `dual_legacy`）。
- 双通道会话跳过文本级 `deduplicate_echoes`（回声已由 AEC 声学消除；旧录音保留既有 echo 标记）。
- `--process <dir>` 离线重处理已接入恢复链路（`ensure_dual_channel_processed`：mic_processed 缺失/为空且原始轨在时经 sidecar 重建，300s 上限）；该 helper 目前 macOS-only（Windows 侧在引擎重处理落地前返回 Ok，persist 回退现有音频）。
- sidecar shutdown 顺序：停采集 → `processor.flush()` → 各 writer 关闭（时间轴完整）→ 写 `tracks.json` → emit stopped；stdout 协议（ready/paused/resumed/levels/stopped/diagnostic）与 socket 帧格式不变，新增 `ready.dualChannel` 字段。

## 8. 后续

1. Windows 侧移植 `AcousticDelayEstimator` 相关法延迟估计（替换 delay=0 提示）。
2. Windows 引擎内 `--process` 等价重处理（从 `*_raw.wav` 重建 processed 轨）。
3. 详情页「全部／本机／远端」试听切换（消费 `trackManifest` 轨表）。
