# Opus 转码上传落地计划（批次 4.3 细化版）

> 2026-10-03 依据 Pocket 逆向实锤制定（见 `docs/pocket-desktop-reverse-analysis.md` §2.5）。
> 目标：录音本地与上传链路从 WAV 切到 Ogg Opus，磁盘与上传带宽省 10–20 倍，转写质量不变。

## 0. 现状链路（已核实）

```
finalize_session (live_translation.rs:2541)
  └ build_playback_wav (:2796)  → master.wav 原样拷贝（48k s16 stereo）或 16k 双轨求和
  └ 记录写 "sourcePath": <playback.wav>   (:2693)
runCloudSync (use-recording-cloud-sync.ts:53)
  └ sync/pre/create → sts → Rust sync_upload_put_signed_file → notify
  └ POST /file/trans（计费点）
  └ finalizeLocal(true)：删 mic.wav / system.wav / mic_processed.wav
     （master.wav、原始轨、playback.wav 全部保留 → 磁盘每小时 ~2GB+）
```

关键事实：
- **Content-Type 是渲染层传参**（`SignedOssPut.content_type`，sync_upload.rs:41），V1 签名把 Content-Type 算进 string-to-sign——**切 `audio/ogg` 不需要改任何 Rust 签名代码**。
- 上传文件由 `recorded_audio_path`（sync_upload.rs:114）从记录 `sourcePath` 解析；`sync_upload_audio_size` 同源，fileSize 自动一致。
- 文件名 `deriveFilename` 取 playbackPath 文件名（现以 .wav 结尾），随 `saveFilename` 走 `sync/pre/create`；objectKey 由服务端生成（测试样例 `recording/<uid>/<fileId>.wav`，扩展名来源待确认）。
- Opus 依赖需按本方案自行引入：原先的 `opus = "0.3"` 只服务蓝牙录音卡解码，该集成已整体移除；audio_editor 的 ffmpeg 是 sidecar 条件可用，**不作为转码依赖**。

## 1. 技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| 编码器 | `opus` crate 0.3（已有依赖） | 纯 Rust 侧已有；Pocket 用 audiopus+静态 libopus，同等能力 |
| 容器 | `ogg` crate 0.9（新增，纯 Rust） | Pocket 同款（ogg-0.9.2）；`ogg::writing::PacketWriter` 流式写页 |
| 时机 | finalize 后台转码 + 上传前 ensure | Pocket 同款「sealed .ogg 复用」：转码一次，重试不重复 |
| 参数 | 源采样率/声道不变；VBR、20ms 帧；64 kbps（stereo）/32 kbps（mono）、complexity 8；常量可调 | Pocket 语音段实测 33–37 kbps（SILK WB 20ms VBR，nominal 32k）；会议语音 64k stereo 透明。Pocket 另有音乐段 192k CELT FB 双档，作为后续 content-adaptive 增强，v1 不做 |

预期收益：1 小时会话 playback.wav ≈ 690 MB → .ogg ≈ 28 MB（~4%）；上传带宽同比例下降。

## 2. Phase A：转码基建 + 本地落盘（纯客户端，默认开，无后端依赖）

**A1 新模块 `apps/tauri/src-tauri/src/audio_transcode.rs`（~0.5 天）**
- `pub fn wav_to_ogg_opus(input: &Path, output: &Path, opts: Opts) -> Result<TranscodeResult>`，返回 `{original_size, size, duration_ms}`。
- 流式：读 WAV payload 分块（复用 `audio_contract::wav` 的 inspect/格式解析），按 20ms 帧喂编码器，`PacketWriter<BufWriter<File>>` 逐包写页。
- RFC 7845 必须做对：OpusHead 的 pre-skip = 编码器 lookahead；OpusTags vendor 写 "Lynse Desktop"；granule position 按样本数累计（内部 48 kHz 基准）；末页 end-trim。

**A2 finalize 挂后台转码（~0.5 天）**
- `finalize_session` persist 之后 spawn tokio blocking task：`playback.wav → 同目录 <同名>.ogg`。
- 幂等：目标存在且非空即跳过；单飞 guard（同 session 不重复起）；**失败仅 log，不影响保存**（记录不写 localOggPath，链路自动回退 WAV）。

**A3 记录字段（additive，~0.1 天）**
- local-transcriptions 记录新增可选 `localOggPath`；转码成功后写回（复用 `update_store_value`）。

**A4 单测（~0.5 天，`cargo test`）**
- 头部字节断言：`OggS` 首页 BOS + `OpusHead` magic/channels/pre-skip + `OpusTags` vendor。
- 用 `opus` crate decoder 回读：解码时长与 WAV 时长误差 < 一个帧长。
- 压缩比 sanity：speech-ish 正弦/噪声样本 ratio < 10%。

**A5 播放验证门（~0.5 天，人工冒烟）**
- WKWebView（桌面 app）：`<audio>` 播放 .ogg + 音频编辑器 `decodeAudioData` 出波形。
- 参考：Pocket 全线用 WKWebView 播自己的 OGG（macOS 13+），实证可行；仍需自测确认。
- **通过后**启用清理策略：sync 成功后删 playback.wav 留 .ogg（本地磁盘省 ~90%）；不通过则 .ogg 仅作为上传预备件，WAV 保留。

## 3. Phase B：上传切换（flag 门，默认关，需后端确认）

**B1 前置确认清单（找后端/自查，不计工作量）**
- [ ] `POST /file/trans` 是否接受 `audio/ogg`（转写管线是按扩展名、Content-Type 还是文件嗅探？）
- [ ] `sync/pre/create` 生成的 objectKey 扩展名来源（是否取自 saveFilename？传 .ogg 会不会落 .wav 后缀）
- [ ] OSS 回源播放 URL 的 Content-Type/播放端兼容（notes 页、详情页、web 端 Safari 用户）

**B2 Rust 上传通道切换（~0.5 天）**
- `recorded_audio_path` 优先读新可选字段 `uploadAudioPath`（= .ogg 路径），缺失回退 `sourcePath`——`sync_upload_audio_size` 与 `put_signed_file` 自动同源，fileSize 即 ogg 大小。

**B3 渲染层切换 + 降级（~0.3 天）**
- `use-recording-cloud-sync.ts` / 批次 1.2 的 resume worker：上传前 ensure ogg（存在用之；转码中则等，失败或缺失 → 原样 WAV）。
- flag 开且记录有 `localOggPath`：`contentType: "audio/ogg"` + `saveFilename` 换 .ogg 扩展；否则行为与今天完全一致。

**B4 flag 与灰度**
- `lynse_opus_upload_enabled`（默认 false，走现有开关模式）；内部 dogfood 先开，观察一周转写投诉/失败率，再全量。

**B5 验收（~0.5 天）**
- 同一段音频 wav / ogg 双传，转写文本 diff 一致（重点：标点、数字、中英混排）。
- 积分扣减不变；notes 列表 trans/status 轮询正常；弱网（限速 1Mbps）上传时长对比记录进验证结论。

## 4. 与其他批次的合流点

- **批次 1.2（自动补传 worker）**：B3 的 ensure-ogg 逻辑直接长在 worker 里，两批共用；1.2 先落也不冲突（先传 WAV，后切 flag）。
- **批次 4.2（波形 peaks）**：A1 的读 pass 已经全量扫过 PCM——顺带按固定窗口取峰值，可同遍产出 `peaks.json`；若 4.2 先落地则直接复用其结果，二选一避免双读。
- **不做**：录制期流式 Opus（多轨 WAV 是 AEC 重处理/恢复的地基，架构不动）；原始轨保留策略（另议）。

## 5. 风险与回退

| 风险 | 缓解 |
|---|---|
| 服务端转写不认 ogg | Phase B 默认关；flag 关闭即回到现状，本地 .ogg 无害 |
| WKWebView 播放兼容 | A5 验证门前不删任何 WAV；Pocket 同栈实证兜底 |
| 转码 CPU（1h 音频约 40–70s） | 纯后台任务 + 单飞 + 幂等；上传 worker 显示 compressing 态 |
| objectKey/文件名不匹配 | B1 清单先确认；create 的 saveFilename 是唯一可控入口 |
| 重试一致性 | sealed .ogg 先落盘再上传（Pocket 同款），重试复用同一文件 |

## 6. 工作量汇总

Phase A ≈ 2 天（A1–A5），Phase B ≈ 1.3 天（B2–B5，后端确认另计）。建议批次顺序：1 → 2 → A →（B1 确认并行）→ B。
