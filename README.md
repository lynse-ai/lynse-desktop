# Lynse

**本地优先的会议知识管理工具** —— 录音与音视频导入、本地语音转写、结构化会议纪要、AI 助手。

**Local-first meeting knowledge platform** — recording & audio/video import, on-device speech transcription, structured meeting minutes, and an AI assistant.

---

## 中文

Lynse 是一个跨平台桌面应用（同时提供 Web 版）：把会议录音、音视频或文档导入进来，由**本地引擎**完成语音转写与说话人识别，再结合云端大模型生成结构化纪要。本地优先意味着音频可以不出设备——转写、声纹、热词全部在本机运行。

### 核心特性

- **本地语音转写**：多引擎可插拔，按语言路由——
  - Qwen3-ASR（Apple Silicon · MLX，默认引擎，0.6B / 1.7B 两档）
  - whisper.cpp sidecar（Windows · Vulkan 加速）
  - FunASR（Paraformer + FSMN VAD）、MLX-Whisper、WhisperX（词级对齐）、MOSS-Transcribe（说话人分离）、VibeVoice-ASR-BitNet（CPU）
- **本地声纹识别**：sherpa-onnx + 3D-Speaker CAM++（Apache-2.0，约 28 MB 模型），按声纹自动标注/匹配说话人，全程本机运行
- **实时翻译**：录音/会议进行中的多语种实时转写与翻译
- **热词包**：针对专有名词、人名、产品名提升识别准确率
- **会议纪要与 AI 助手**：结构化纪要（标题、要点、行动项）、Markdown 编辑、可追问整场会议的 AI 对话
- **云同步与备份**：录音云端同步（断点续传）、WebDAV 备份
- **安全的密钥存储**：API Key / Token 存入操作系统钥匙串（macOS Keychain / Windows 凭据管理器），不落明文
- **自动更新**：Tauri updater + minisign 签名清单，GitHub Releases 为主源，中国大陆走 CloudBase 镜像

### 仓库结构

pnpm workspaces + Turborepo 单仓，内部包以源码形式直接发布给各端 bundler 编译。

| 目录 | 说明 |
| --- | --- |
| `apps/web` | Next.js Web 版（App Router） |
| `apps/tauri` | Tauri 2 桌面端（Vite 渲染层 + Rust 外壳，本地引擎桥接在 `src-tauri`） |
| `packages/core` | 无头业务逻辑：API 客户端、认证、导航、平台层 |
| `packages/views` | 共享业务页面与组件（不依赖任何路由框架） |
| `packages/ui` | 基础 UI 组件（shadcn / Base UI） |
| `packages/tsconfig` | 共享 TypeScript 配置 |

### 本地开发

要求：Node 22+、pnpm 10、Rust stable（桌面端）。本地转写引擎在应用内首次使用时自动下载并自建 Python 环境，无需预装。

```bash
pnpm install

pnpm dev:desktop        # Tauri 桌面端开发
pnpm dev:web            # Next.js Web 版开发（端口 3000）

pnpm typecheck          # TypeScript 全仓检查
pnpm lint               # ESLint
pnpm test               # Vitest 单测
pnpm build              # 构建全部应用

pnpm --filter @lynse/tauri build   # 打包桌面端（.app/.dmg/msi）
```

### 发布

推送 `v*` 格式的 tag（如 `v1.1.6`）即触发 GitHub Actions：构建 macOS（dmg + app）与 Windows（msi）安装包、生成签名的更新清单（latest.json）、发布 GitHub Release 并镜像到 CloudBase 更新源。**不要**在本地用 `gh release create` 手工建 Release。

## English

Lynse is a cross-platform desktop app (with a Web edition): import meeting recordings, audio/video, or documents — **on-device engines** handle speech transcription and speaker identification, then a cloud LLM turns the transcript into structured minutes. Local-first means your audio can stay on your machine: transcription, voiceprints, and hotwords all run locally.

### Highlights

- **On-device transcription** with pluggable, per-language routed engines:
  - Qwen3-ASR (Apple Silicon · MLX, the default engine, 0.6B / 1.7B variants)
  - whisper.cpp sidecar (Windows · Vulkan accelerated)
  - FunASR (Paraformer + FSMN VAD), MLX-Whisper, WhisperX (word-level alignment), MOSS-Transcribe (diarization), VibeVoice-ASR-BitNet (CPU)
- **Local voiceprint recognition**: sherpa-onnx + 3D-Speaker CAM++ (Apache-2.0, ~28 MB model) labels and matches speakers automatically — fully on-device
- **Live translation**: real-time transcription and translation while a meeting is in progress
- **Hotword packages**: boost accuracy for proper nouns, names, and product terms
- **Minutes & AI assistant**: structured minutes (title, takeaways, action items), Markdown editing, and a chat that can answer questions about the whole meeting
- **Cloud sync & backup**: recording cloud sync with resumable uploads, plus WebDAV backup
- **Secure secrets**: API keys / tokens live in the OS keychain (macOS Keychain / Windows Credential Manager), never in plaintext
- **Auto-update**: Tauri updater with minisign-signed manifests — GitHub Releases as the primary source, a CloudBase mirror for mainland China

### Repository layout

A pnpm-workspaces + Turborepo monorepo; internal packages ship raw source that each app's bundler compiles.

| Directory | Purpose |
| --- | --- |
| `apps/web` | Next.js web edition (App Router) |
| `apps/tauri` | Tauri 2 desktop app (Vite renderer + Rust shell; native engine bridges in `src-tauri`) |
| `packages/core` | Headless business logic: API client, auth, navigation, platform layer |
| `packages/views` | Shared business pages/components (framework-agnostic routing) |
| `packages/ui` | Base UI components (shadcn / Base UI) |
| `packages/tsconfig` | Shared TypeScript configurations |

### Development

Requirements: Node 22+, pnpm 10, Rust stable (desktop). Local transcription engines download on first use inside the app and set up their own Python environments — nothing to preinstall.

```bash
pnpm install

pnpm dev:desktop        # Tauri desktop development
pnpm dev:web            # Next.js web development (port 3000)

pnpm typecheck          # Repo-wide TypeScript check
pnpm lint               # ESLint
pnpm test               # Vitest unit tests
pnpm build              # Build all apps

pnpm --filter @lynse/tauri build   # Bundle the desktop app (.app/.dmg/msi)
```

### Releasing

Pushing a `v*` tag (e.g. `v1.1.6`) triggers GitHub Actions: it builds the macOS (dmg + app) and Windows (msi) bundles, generates the signed update manifest (latest.json), publishes the GitHub Release, and mirrors it to the CloudBase update source. Do **not** create releases manually with `gh release create`.

---

## License

[AGPL-3.0-only](LICENSE) © 2026 上海天启灵光科技有限公司 (Shanghai RevelSpark Technologies Co., Ltd.). Bundled third-party components and their licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Scope of the grant: the AGPL covers the desktop and web clients (`apps/tauri`, `apps/web`, `packages/`) and the repository tooling. `services/` and `cloudfunctions/` are separate programs — Lynse's closed server-side code — and are **not** licensed under the AGPL; each carries its own proprietary `LICENSE`.

AGPL §13 applies to network use: anyone who offers a modified version of this software to users over a network must also make its corresponding source available to them.
