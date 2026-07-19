# Lynse

**本地优先的会议纪要工具** —— 导入音视频 / 文档，自动转写并生成结构化纪要。

Lynse 是一个跨平台桌面应用（同时提供 Web 端）。核心思路是 **“文件导入式”**：把已有的会议录音、视频或文档丢进来，由本地引擎做语音转写、可选说话人分离，再交给云端大模型生成纪要，全程可审计、可离线。

> 当前稳定版：**v0.1.10**（Windows `.msi` + macOS `.dmg` 双平台发布）。

---

## 功能特性

- **本地语音转写（STT）**：基于 FunASR（Paraformer 大模型 + FSMN VAD + CAM++ 声纹）在本地运行，音频不出机器。
- **Provider 抽象与按语言路由**：`BatchSttAdapter` 把转写引擎抽象成统一 trait，配置 `{ default, per_language }` 即可为不同语言（如 `zh` / `en`）指定不同引擎与参数。
- **可选说话人分离**：本地声纹（voiceprint）管理，把转写结果按说话人分段。
- **本地热词包（hotword）**：针对专有名词、人名、产品名提升识别准确率。
- **云端大模型摘要**：转写文本交给可配置的云端 LLM 生成结构化纪要（标题、要点、行动项）。
- **密钥安全存储**：API Key / Token 不再写进 `localStorage` 明文，而是存入 **操作系统 Keychain**（macOS 钥匙串 / Windows 凭据管理器）。
- **STT 路由配置 UI**：设置页内可视化编辑默认引擎与逐语言覆盖，实时保存生效。
- **Markdown 编辑器**：基于 Milkdown 的纪要编辑与渲染。

---

## 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面外壳 | **Tauri 2**（Rust 1.97 + WebView） |
| 前端框架 | **React 19** + **Vite** |
| Web 端 | **Next.js 16** |
| 样式 | **Tailwind CSS 4** + shadcn/ui |
| 状态 / 数据 | **zustand** + TanStack Query + **zod** |
| 编辑器 | **Milkdown** |
| 本地转写 | **FunASR**（Python 子进程：Paraformer + FSMN VAD + CAM++） |
| 密钥存储 | **keyring** crate → OS Keychain |
| 工程化 | pnpm workspaces + **Turborepo** |

---

## 仓库结构

```
lynse-desktop/
├── apps/
│   ├── tauri/        # 桌面应用（Tauri 2 + React 19 + Vite）
│   │   └── src-tauri/ # Rust 后端：命令、STT 适配器、Keychain
│   └── web/          # Web 端（Next.js 16）
├── packages/
│   ├── core/         # 共享逻辑：store、StorageAdapter、i18n、api client
│   ├── ui/           # shadcn/ui 组件库（Tailwind 4）
│   ├── views/        # 跨端视图：设置对话框、Markdown、本地转写 API
│   └── tsconfig/     # 共享 TS 配置
└── docs/             # 调研与对比文档
```

---

## 快速开始

### 前置要求

- Node.js ≥ 18（推荐 22）+ pnpm ≥ 9
- Rust 工具链（仅桌面端开发需要）：`rustup`
- macOS：Xcode Command Line Tools
- Windows：Visual Studio Build Tools（C++ 桌面开发）
- 本地转写可选：Python 3.10+，并准备好 FunASR 模型目录

### 安装与运行

```bash
# 安装依赖
pnpm install

# 启动桌面应用（默认 http://127.0.0.1:5174/，原生窗口同步弹出）
pnpm dev:desktop

# 启动 Web 端
pnpm dev:web
```

其他常用脚本：

```bash
pnpm build        # 全量构建（turbo build）
pnpm typecheck    # 类型检查
pnpm lint         # 代码检查
pnpm test         # 运行测试
pnpm ui:add       # 通过 shadcn 添加组件
```

---

## 本地转写（FunASR）配置

本地转写在桌面端的 **设置 → Offline Transcription** 中开启：

1. **启用离线转写** 开关。
2. **下载本地模型**（Paraformer / VAD / CAM++）——首次使用需联网拉取。
3. 可选：**本地热词包**（提升专有名词识别）、**本地声纹**（说话人分离）。
4. 在 **STT 路由配置** 区块设置：
   - **默认引擎**（当前为 FunASR）及其参数：`expected_speakers`（预期说话人数）、`hotword_package_id`（热词包）。
   - **按语言覆盖**：为 `zh` / `en` 等语言单独指定引擎与参数，未命中的语言回退到 default。

配置通过 `local_stt_config_get` / `local_stt_config_save` 命令持久化到用户目录，转写时按 `per_note → per_language → default → Funasr` 的优先级解析。

---

## 密钥安全

桌面端通过 `secure-storage` 模块把 `lynse_api_key` / `lynse_token` 等敏感字段存入 **操作系统 Keychain**：

- 应用启动时从 Keychain 拉入内存缓存，并自动迁移 / 清除历史 `localStorage` 明文。
- 非敏感配置仍走本地存储，保持 `StorageAdapter` 同步契约，Web 端零改动。

---

## 构建与发布（双平台）

发版采用 **“打 tag 触发 CI 双平台构建”** 的约定：推送 `v*` 形式的 tag 后，GitHub Actions 在 matrix 中分别构建：

- `windows-latest` → `Lynse_x.x.x_x64_en-US.msi`
- `macos-latest` → `Lynse_x.x.x_aarch64.dmg`

两个产物上传到**同一个 GitHub Release**。

```bash
# 1. 提交改动
git add -A && git commit -m "release: v0.1.x — ..."

# 2. 升级版本号（tauri.conf.json / package.json / apps/tauri/package.json 保持一致）

# 3. 打 tag 并推送，触发双平台构建
git tag v0.1.x
git push origin main
git push origin v0.1.x
```

> 本机无法直接编译 Windows，因此“双平台编译”实际由这次 push 触发的 CI 完成，产物可在 Release 页面下载。

---

## 说明

- 当前本地 STT 仅内置 **FunASR** 一种引擎，`BatchSttAdapter` 已预留多引擎扩展位（OpenAI / Deepgram / Groq 等可按同样 trait 接入）。
- 转写块的 `prior_context` 防幻觉、本地 Ollama 原生摘要、本地存储 SQLite 化等为后续规划项。
- macOS 安装包目前为**未签名 dmg**，首次打开需在“系统设置 → 隐私与安全性”中允许。

---

## License

MIT
