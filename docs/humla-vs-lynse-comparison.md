# Humla vs Lynse 逐模块对比与吸收建议

> 日期：2026-07-19
> 目的：评估开源项目 Humla（michaelwilhelmsen/humla，MIT）哪些模块值得吸收进 lynse-desktop。
> 结论先行：**两者表面都是「Tauri + Rust + React 会议转录应用」，但架构哲学根本不同**。Humla = 实时双流录制 + 全本地优先；Lynse = 文件导入 + 本地 FunASR(可选) + 云端 LLM 摘要 + 极薄 Rust 壳 + 自有后端/Web/同步的平台。

---

## 一、逐模块对比表

| 模块 | Humla | Lynse-desktop | 差距判断 |
|---|---|---|---|
| **音频捕获** | Swift 侧车 `audio-capture`：AVAudioEngine 抓 mic + ScreenCaptureKit 抓系统音频，**双流分离、实时录制** | 仅 `dialog` 选已有音视频文件，**单流、无实时录制** | 根本差异。Lynse 无录制能力，这是最大分叉 |
| **VAD / 切块** | Rust 层按语音停顿自然切块（1–15s，500ms 静音触发） | 由 FunASR FSMN VAD 在 Python 侧完成（`max_single_segment_time=30s`） | Humla 在应用层可控；Lynse 交给模型 |
| **STT 引擎** | 4 家统一抽象 `BatchSttAdapter`：本地 Whisper / OpenAI / Deepgram / Groq | 本地仅 **FunASR**(Paraformer)；云端转写由 `api.lynse.cn` 后端决定，前端不感知 | Humla 可插拔多引擎；Lynse 本地单引擎 |
| **per-language 路由** | `transcribe_config` 单一真相源：per-note → per-language → default | 无客户端路由；`modelId/languageId` 纯透传后端 | Humla 有完整路由层；Lynse 无 |
| **prior_context 防幻觉** | 每块带同源上一块 ~150 词作 `initial_prompt`，**mic/sys 各自独立 trail** | 无此机制 | Humla 明显更优的质量工程 |
| **custom vocabulary** | 注入 ASR（Whisper `initial_prompt` / Deepgram `keyterms`） | 有 **热词**（`--hotword` + 后处理 `apply_hotwords` 替换），注入 ASR | 能力相当，Lynse 已实现 |
| **说话人分离** | Swift `speaker-diarize`：FluidAudio Community-1 / NVIDIA Sortformer；双流时 mic 标 `You:`、仅对 sys 做分离 | FunASR CAM++ 聚类 + **声纹注册命名**（余弦匹配回填姓名，跨录音持久） | **各有千秋**：Humla 离线分离引擎更优；Lynse 的「声纹持久命名」反而更实用（注册一次长期复用） |
| **摘要 LLM** | 双源融合（笔记 + 转录）；支持 OpenAI 或**本地 Ollama 原生 `/api/chat`**（`num_ctx` 自适应、`keep_alive:0` 释放） | 云端 LLM 黑盒（透传 `modelId`）；**无本地 LLM**；有 50+ 模板系统 | Humla 本地优先；Lynse 模板更丰富 |
| **场景预设 prompt** | 6 种内置（Meeting/1:1/Lecture/Interview/Brainstorm/Voice memo）+ 自定义 | 50+ 模板（拉取 `prompt/categories`，有 add/rerun/replace） | **Lynse 领先**，模板体系更成熟 |
| **数据存储** | SQLite（WAL，rusqlite）单文件 | JSON 文件（`local-transcriptions/index.json` 等）+ 浏览器 `localStorage` | 各有利弊，Humla 更工程化 |
| **密钥存储** | macOS **Keychain**（per-provider 条目） | **明文存 localStorage**（key `lynse_api_key`/`lynse_token`），随每个请求 `X-API-Key` 发出 | **Lynse 有明显安全隐患**，应吸收 Keychain |
| **遥测** | 无 | 无（已 grep 验证） | 持平 |
| **侧车/权限** | Swift 侧车 `setsid` 脱离沙盒使 TCC 权限绑定 app + PPID watchdog | 仅 FunASR Python 子进程（`std::process::Command`，非 Tauri sidecar） | Humla 权限处理更稳；Lynse 暂不需要（无实时录制） |
| **跨设备/同步** | 可选 PocketBase 自托管 或 Humla Cloud（$7/月） | 自有后端 `api.lynse.cn` + Web(Next.js) + OSS，天然多端 | **Lynse 领先**（平台化） |
| **macOS 专属** | 无 EventKit | `highlandcows-eventkit`：待办写入系统日历 | **Lynse 独有** |
| **前端编辑器** | Tiptap | Milkdown（ProseMirror/Markdown） | 不同选择，非优劣 |

---

## 二、值得吸收的模块（按优先级）

### P0 — 高价值、低风险、可立即落地

1. **API Key 改存 macOS Keychain（安全隐患修复）**
   - 现状：Lynse 把 `lynse_api_key`/`lynse_token` 明文存浏览器 `localStorage`，且作为 `X-API-Key` 头随每个请求发出。桌面端应移入 Keychain。
   - 做法：Rust 加 `tauri-plugin-keyring`（或 `keyring` crate），前端通过命令读写；Web 端保留 `localStorage` 抽象（`StorageAdapter` 已是抽象，无需动）。
   - 价值：**安全合规**，几乎零架构风险。建议作为首个吸收项。

2. **prior_context 防幻觉（移植到摘要环节）**
   - Humla 在块转写时带同源上一块文本；Lynse 虽不做实时切块，但可在**摘要 prompt 组装**时把「前文 N 段」作为上下文带进 LLM 请求，显著减少跨段幻觉与专有名词漂移。
   - 做法：在 `use-files.ts` 的 `addSummaryPipeline` / `resummarize-dialog.tsx` 组装时，附带前序 transcript 片段；若要做实时本地转写防幻觉，可在 `funasr_transcribe.py` 的 chunk 循环里把上一块文本回灌（Paraformer 支持 `prompt`）。
   - 价值：摘要/转写质量提升，改动小。

3. **per-language / per-note 路由配置（客户端侧）**
   - 现状：Lynse 本地仅 FunASR；云端由后端决定。
   - 做法：在本地转写配置里增加「语言 → 引擎/模型」映射（即便目前本地只有一个 FunASR，也可为未来接 Whisper/Ollama 预留 `transcribe_config` 式结构）。云端侧路由由后端控制，无需客户端改。

### P1 — 高价值、中等成本

4. **本地 LLM（Ollama 原生 `/api/chat`）支持**
   - 若你想让 Lynse 支持「完全离线摘要」，吸收 Humla 的 Ollama 原生路径 + `num_ctx` 自适应 + `keep_alive:0` + Qwen 反循环采样。
   - 做法：在 `api/client.ts` 增加「本地 LLM provider」分支（仅桌面端），绕过 `api.lynse.cn` 直连本地服务。
   - 成本：需新增 provider 抽象 + 设置 UI + 与现有云端模板系统兼容。中等。

5. **SQLite 化本地存储（替代 JSON 文件）**
   - 现状：`local-transcriptions/index.json`、`local-hotwords`、`local-voiceprints`、`local-todos` 均为 JSON 文件读写。
   - 做法：引入 `rusqlite`（Humla 已验证可行）或沿用现有 JSON 但加原子写。若暂不需要复杂查询，可保持 JSON 但统一到单库。低优先。

### P2 — 战略级、需大改（谨慎评估）

6. **实时双流录制（Swift 侧车 + ScreenCaptureKit）**
   - 这是 Humla 与 Lynse 最本质的差别。吸收它意味着 Lynse 从「文件导入式平台」转变为「实时录制式工具」，**几乎是对桌面端架构的重写**，且与 Lynse 的「云端平台/多端同步」定位冲突。
   - 建议：**不要盲目吸收**。除非你明确要做「本地优先实时会议记录」与 Humla 正面竞争。当前 Lynse 的差异化优势（云端同步、Web、声纹命名、成熟模板、EventKit）才是护城河。
   - 若真要做，可作为一个**独立的「实时录制」模式/子产品**，复用 Lynse 现有的转写与摘要后端，而非照搬 Humla 全本地栈。

---

## 三、Lynse 反过来领先 Humla 的点（避免妄自菲薄）

- **声纹持久命名**：Lynse 的 CAM++ 声纹注册 + 余弦匹配回填姓名，比 Humla 的「每次会议重标 Speaker N」更实用（注册一次长期复用）。
- **模板系统**：50+ 场景模板 + add/rerun/replace 工作流，比 Humla 的 6 种预设更丰富。
- **平台化**：自有后端 + Web(Next.js) + OSS 多端同步，Humla 仅 PocketBase 可选同步。
- **EventKit 待办→系统日历**：Lynse 独有。

---

## 四、建议的下一步

1. **先做 P0-1（Keychain 存 key）**——安全刚需，半天可落地。
2. **做 P0-2（prior_context 摘要防幻觉）**——质量提升，与现有架构无缝。
3. **预留 P1-3 的 `transcribe_config` 结构**——为将来接 Whisper/Ollama 铺路，不急于实现。
4. **P2 实时录制暂不动**，除非产品方向调整。

> 一句话：Humla 值得学的不是「整套照搬」，而是它**在隐私（Keychain）、质量（prior_context）、可扩展（多引擎路由）上的工程细节**；而 Lynse 在「平台化与声纹命名」上本来就更强，应保持差异。

---

## 五、P0 实施记录（2026-07-19，已落地）

以下 P0 项已实际写入代码并通过 `cargo check`（Rust 端零警告；TS 改动仅桌面端，web 端不动）。

### ✅ P0-1 · API key 改存 macOS Keychain
- Rust：新增 `keyring = "3"` 依赖 + 三个命令 `secure_set_secret` / `secure_get_secret` / `secure_delete_secret`（用 `keyring::Entry`，按 `target_os` 自动选 macOS Keychain / Windows Credential Manager / Linux secret-service）。
- 桌面端适配器 `apps/tauri/src/secure-storage.ts`：`StorageAdapter` 实现，密钥类（`lynse_api_key`/`lynse_token`）走 Keychain（内存缓存 + 启动期异步 hydrate），其余键走 localStorage。**保持了 `StorageAdapter` 同步契约**，因此共享 core 包与 web 端零改动。
- 升级迁移：`hydrateSecrets()` 在 `installTauriBridge` 中 await，能把旧版 localStorage 明文密钥迁移进 Keychain 并清除明文。
- 接线：`App.tsx` 给 `CoreProvider` 传 `storage={secureStorage}`。
- 安全收益：密钥不再以明文驻留 localStorage，单点泄露风险消除；跨平台（含 Windows msi）均受保护。

### ✅ P0-3 · 本地 STT 引入 BatchSttAdapter + per-language 路由
- 新增 `apps/tauri/src-tauri/src/stt.rs`，对齐 Humla 的 `BatchSttAdapter`：
  - `trait BatchSttAdapter`（provider-agnostic，未来 Whisper/Ollama 可实现）。
  - `ProviderConfig` 标签枚举（目前仅 `Funasr`）。
  - `TranscribeConfig { default, per_language: BTreeMap }` —— **单一真相源**，解析顺序 `per_note → per_language[lang] → default → Funasr`，与 Humla 一致。
  - `FunasrAdapter` 实现：复用既有 `run_funasr` 调 Python，并把 `prior_context` 作为 `--prompt` 注入。
- `transcribe_record` 重构为：加载 `TranscribeConfig` → 按 `language`/`providerConfig` 路由 → 取适配器 → 转写。
- 新增 `local_stt_config_get` / `local_stt_config_save` 命令（配置持久化在 `app_data_dir/local-stt-config/config.json`）。
- `create_queued_record` 把 `options` 里的 `language`/`providerConfig`/`priorContext` 写入 record，供路由与防幻觉使用。

### ✅ P0-2 · prior_context 防幻觉（机制已接入）
- 链路贯通：record 的 `priorContext` → `SttRequest.prior_context` → FunASR `--prompt`（Paraformer 上下文偏置）。
- **当前为单文件整体 prompt 注入**（低风险、可验证）；真正的"逐块带同源上一块文本"需把 FunASR 改为分块 generate，因本机无 FunASR 运行环境、无法回归测试，列为后续增强（见下）。

### 尚未做（明确的后续项，非本次范围）
- **P0-2 加强**：FunASR 分块 generate，每块带上一块 prior_context（per-chunk 防幻觉，最贴近 Humla）。
- **P1-④**：本地 Ollama 原生 `/api/chat` 摘要（需新增 LLM provider 抽象 + 设置 UI）。
- **P1-⑤**：本地存储 SQLite 化（可选）。
- **P2-⑥**：实时双流录制（Swift 侧车 + ScreenCaptureKit）——战略级，不建议照搬。
- STT 配置的 **设置 UI**：命令已就绪，但前端还没做语言/引擎路由的可视化编辑界面。

### 文件清单
- 新增：`apps/tauri/src-tauri/src/stt.rs`、`apps/tauri/src/secure-storage.ts`
- 改：`apps/tauri/src-tauri/src/lib.rs`、`apps/tauri/src-tauri/Cargo.toml`、`apps/tauri/src-tauri/resources/funasr_transcribe.py`、`apps/tauri/src/tauri-bridge.ts`、`apps/tauri/src/App.tsx`
