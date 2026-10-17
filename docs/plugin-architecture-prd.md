# PRD：Lynse 桌面端插件化架构与插件社区

> 版本：v0.5（草案，待评审）
> **实施状态（2026-09-18）：P0–P5 全部落地**——插件地基、WorkBuddy/飞书两个功能插件、转写模型社区（FunASR/WhisperX/Qwen3，MOSS 延后）、WhisperX 新引擎（Rust 适配器 + Python 桥接，cargo check 通过，端到端转写待真机回归）、远程目录已上线（`plugins/catalog.json` 已发布并 curl 验证）。P6 可选项（routes 贡献点、ContentKind.Plugins）暂缓。灰度开关：`featureFlags.pluginMarketplace`。
> 日期：2026-09-18
> 范围：`apps/tauri` 桌面端（`packages/views` / `packages/core` 共享层同步改造）
> 关联文档：`docs/auto-update.md`（CloudBase 托管目录）、`docs/superpowers/specs/2026-07-04-offline-funasr-transcription-design.md`

---

## 1. 背景与目标

### 1.1 背景

桌面端功能持续累积：离线语音转写（Qwen3/MOSS/Whisper 等六引擎）、飞书机器人、WorkBuddy 助手、WebDAV 同步、会议自动录音等。这些功能目前全部硬编码在主程序里：

- 设置页分区手工维护在 `settings-dialog.tsx`（`SettingsSectionId` 联合类型 + 命令式 push 数组）；
- 菜单项硬编码在 `lynse-sidebar.tsx` 的 `topItems/bottomItems` 数组；
- 转写设置的状态与处理函数内联在 `settings-dialog.tsx`（103–229 行）。

结果：所有用户被迫接收全部功能，设置页越来越长，功能之间耦合面扩大（如 `notes/page.tsx`、`workspace/content-panel.tsx` 直接 import 飞书推送逻辑）。

### 1.2 目标

1. **插件化**：将独立价值的功能拆分为自包含插件模块，与宿主之间只通过明确定义的扩展点交互。
2. **插件社区**：设置里新增「插件」社区页，用户可浏览、安装、启用/停用、卸载插件。
3. **模型即插件**：离线转写只把「模型」做成插件——每个离线模型（Qwen3-ASR、MOSS、Whisper 等）是独立的「模型插件」，在插件社区按需安装（下载）、单独卸载；转写功能本体（引擎适配、转写管线、设置分区）**不插件化**，保留在核心（见 §4.1、§5.3）。
4. **安装即生效**：插件安装启用后，其菜单入口（设置分区 / 侧边栏项）自动出现；停用/卸载后自动消失。
5. **平滑迁移**：老用户已配置的功能升级后自动恢复——已绑定飞书/WorkBuddy → 「已安装 + 已启用」，已下载的转写模型 → 对应模型插件「已安装」，配置无损。

### 1.3 非目标（本期不做）

- **本期不做运行时第三方 JS 插件加载**（不在 Webview 里 eval 远程 JS、不 dlopen 动态库）；插件生态先以「内置插件 + 模型/资产插件 + 远程目录」运转，JS 插件运行时列入二期路线（§7），manifest 自设计起按运行时可加载兼容。理由见 §4.1。
- 不做插件付费/授权体系、插件间通信 API、移动端（iOS/Flutter）插件体系。
- 不拆分核心链路：录音、云转写、笔记、AI 对话、知识库保持宿主核心。
- Web 端（`apps/web`）本期只保证不回归：桌面专属插件在 Web 上隐藏或显示「仅桌面可用」。

---

## 2. 术语

| 术语 | 定义 |
|---|---|
| 宿主（Host） | Lynse 应用本体，提供扩展点与插件运行环境 |
| 插件（Plugin） | 一个自包含功能模块，通过 manifest 声明能力与贡献点 |
| 扩展点（Extension Point） | 宿主预留的挂载位置：设置分区、侧边栏菜单、路由页、事件订阅 |
| 内置插件 | 随应用打包发布、但默认未安装/未启用的插件（Obsidian core plugin 模式） |
| 资产包（Asset Pack） | 按需下载安装的纯数据插件（离线转写模型等），复用现有下载管线 |
| 社区目录（Catalog） | 插件元数据清单（JSON），托管在 CloudBase 静态托管，用于插件社区展示 |

---

## 3. 现状盘点（插件化的原始材料）

以下路径均已核实，是各阶段的改造对象。

### 3.1 三个目标功能的现状

**① 离线语音转写（耦合最深）**

- Rust：`stt.rs` 六引擎 `BatchSttAdapter` 静态分发（`ProviderConfig::adapter()`）、`STT_MODELS` 模型目录（`lib.rs:680-753`）、模型下载 + SHA-256 校验、共享运行时下载（`download_runtime`，CloudBase → GitHub → 镜像三级候选）；磁盘布局 `local-asr-models/{engine}/{model_id}`、`stt-runtimes/`、`mlx-venv/`。
- 热词/声纹：转写后处理，引擎无关（`apply_hotwords` / `apply_voiceprints`，在 `transcribe_single_track` 末尾调用）。
- 前端：桥接类型 `packages/views/workspace/local-transcription.ts`；引擎选择/模型管理 UI `packages/views/settings/stt-config-section.tsx`（575 行，`ENGINE_OPTIONS`）；**设置状态与下载/热词/声纹处理函数内联在 `settings-dialog.tsx:103-229`**；总开关存 localStorage `OFFLINE_TRANSCRIPTION_ENABLED_KEY`。
- 结果消费方（保持核心，不随插件迁移）：workspace 转写详情页、notes、content-panel——它们消费转写结果数据，与插件管理解耦。

**② 飞书机器人（已有半插件形态）**

- 通道无关框架已存在：`packages/views/bots/`（`BOT_CHANNELS = ["feishu"]`、`BotAgent`、`BotAuthSupervisor`、`ChannelCardShell`、TanStack Query hooks）+ Rust `bots.rs`（`CHANNELS` 常量 + `dispatch(channel)`）。
- 飞书实现：Rust `feishu/`（WS 长连接、`{app_data}/feishu/config.json`、secret 存钥匙串 `lynse_feishu_app_secret`、注册/发卡/流式 Cardkit 等约 18 个命令）；前端 `packages/views/feishu/`（桥接类型、`FeishuConfigCard`、`feishu-push.ts`）。
- **耦合点**：`feishu-push.ts` 的 `useFeishuTranscriptionCompletedWatcher` 被 `notes/page.tsx:36,498-500` 和 `workspace/content-panel.tsx:24,724-728` 直接 import；`BotAgent`/`BotAuthSupervisor` 挂在 `App.tsx:196,218`。

**③ WorkBuddy（耦合最浅，适合首发）**

- 纯 TS：`packages/core/auth/workbuddy.ts`（203 行，仅依赖 api client；浏览器 OAuth + 后端托管 token + 直连 `workbuddy.cn/openapi/v2`）+ `packages/views/settings/workbuddy-config-card.tsx`（221 行）+ `workbuddy.*` i18n 命名空间（~25 键 × 5 语言）。
- 无 Rust 参与、无 store、无路由。业务接口（助手任务等）尚未接入，本期只搬授权与配置卡。

### 3.2 宿主侧可复用的既有机制

| 机制 | 位置 | 复用方式 |
|---|---|---|
| 能力探测 | `window.desktopAPI.<feature>` + `getDesktop*Api()` 返回 null 的惯例 | 插件可用性判定（平台/平台能力门控） |
| 功能开关 | `packages/views/feature-flags.ts` | 插件社区整体灰度开关 `pluginMarketplace` |
| 通道注册表 | `bots.rs` `CHANNELS` + `dispatch()` | bot 类插件的 Rust 侧注册表范式 |
| 引擎注册表 | `stt.rs` `BatchSttAdapter` 静态表 | ASR 引擎作为转写插件的子能力 |
| 统一内容根 | `vault.rs` `content_dir(ContentKind)` | 新插件数据目录的落位规则 |
| 下载管线 | curl + SHA-256 + 三级镜像（`lib.rs:1260-1309`） | 未来资产包/目录清单下载 |
| CloudBase 托管 | updater 端点 `…tcloudbaseapp.com/updates/` | 插件社区目录 JSON 的托管位 |
| i18n | 单 translation 命名空间 + 顶层前缀（5 语言） | 插件文案按 `plugins.*` / `<pluginId>.*` 前缀贡献 |

### 3.3 宿主侧需要新增/改造的接缝

目前**不存在**模块注册/容器机制，以下四处为手工登记，是本 PRD 的主要改造面：

1. 路由：`apps/tauri/src/App.tsx:61-98` `PageRouter` if/else 链 + 路由名联合类型；
2. 侧边栏：`packages/views/layout/lynse-sidebar.tsx:66-110` 静态数组 + filter；
3. 设置页：`packages/views/settings/settings-dialog.tsx:69-77,233-465`；
4. i18n 资源：`packages/views/locales/index.ts` `RESOURCES`（`App.tsx:260` 注入）。

---

## 4. 总体设计

### 4.1 核心决策：内置插件 + 资产包，而非动态代码加载

Tauri 应用的 Rust 能力是编译期固化的（`generate_handler!` 静态列表，~130 个命令），安全的动态代码加载（远程 JS 注入 Webview / dlopen）会带来不可控的安全与崩溃风险，且现有代码零 code-splitting 基建。因此：

- **v1 插件 = 随包发布的内置模块**：代码在应用内，但默认「未安装」——用户在插件社区安装后才注册其贡献点（菜单/设置分区/事件订阅）。功能隔离通过 manifest + 注册表实现，而非进程/加载隔离。
- **转写只插件化「模型」，不插件化「能力」**：转写需要按模型深度适配（Rust 六引擎适配器 + 各自的 Python 桥接/venv/下载流程），且是实时转写、自动录音、总结推送等多条链路的公共管线——这类深度耦合的能力**不做插件**，留在核心；只有离线**模型**是纯数据资产（适配在引擎代码里、随应用发版），做成模型插件进社区安装/卸载。现有按需下载管线（ModelScope/HF 分区域、SHA-256、CloudBase 镜像、`stt-download-progress` 进度事件）直接复用为模型插件的安装管线，无需新增。
- **收益即时兑现**：设置页瘦身、菜单按需出现、功能可整体启停、新增功能按插件模板开发；为未来真正的第三方分发（远端 JS 沙箱或独立进程插件）预留 manifest 与目录格式，但本期不实现。

### 4.2 概念模型

```
宿主 (App Shell)
 ├─ PluginRegistry        插件注册表（编译期内置插件 → definePlugin 声明）
 ├─ PluginStateStore      安装/启用状态（zustand + StorageAdapter 持久化）
 ├─ Extension Points
 │   ├─ settingsSections  → 设置对话框分区（含插件各自的设置组件）
 │   ├─ sidebarItems      → 侧边栏菜单项（可选贡献）
 │   ├─ routes            → 独立页面（可选贡献，P5）
 │   └─ eventBus          → 领域事件订阅（转写完成等）
 ├─ PluginHost            按 安装+启用 状态挂载插件的 headless 组件与订阅
 ├─ ModelPlugins          模型插件（离线转写模型：安装=下载资产包，卸载=删模型文件）
 └─ MarketplacePage       设置 → 插件（社区 UI）
      └─ CatalogService   CloudBase 目录 JSON（可选元数据更新）
```

### 4.3 插件 Manifest（v1 为代码内类型声明，非远程 JSON）

内置插件在各自目录用 `definePlugin()` 声明，编译期注册。字段设计兼容未来远程分发：

```ts
// packages/core/plugins/types.ts
export interface PluginManifest {
  id: string;                       // "lynse.feishu-bot" / 模型插件 "lynse.model.qwen3-asr-1.7b-8bit"
  kind: "app" | "model";            // app=功能插件（有 UI 贡献）；model=模型插件（纯资产，无 UI）
  version: string;                  // semver
  minAppVersion: string;
  name: string;                     // i18n key, 如 "plugins.feishu-bot.name"
  description: string;
  icon: string;                     // icons.ts 既有图标名，避免新增资源
  category: "transcription" | "integration" | "assistant" | "sync" | "tool";
  platforms: Array<"desktop" | "web">;   // web 不可用的插件在 Web 端隐藏
  permissions: PluginPermission[];  // 见 §8，v1 仅作展示与代码评审清单
  contributions: {
    settingsSection?: SettingsSectionContribution;  // 组件懒加载 + 排序权重
    sidebarItem?: SidebarItemContribution;          // key/label/icon/path
    routes?: RouteContribution[];                   // P5 启用
    eventSubscriptions?: EventSubscriptionName[];   // "transcription-completed" 等
  };
  availability: () => boolean;      // 替代现有 getDesktop*Api() 门控，如平台能力
  lifecycle?: {
    onInstall?: () => Promise<void>;    // 如触发 STT 运行时下载确认
    onEnable?: () => Promise<void>;     // 如 feishu_bot_start
    onDisable?: () => Promise<void>;    // 如 feishu_bot_stop + 清理
    onUninstall?: () => Promise<void>;  // 如可选清除本地配置
  };
  migrate?: () => Promise<boolean>; // 老配置探测 → 返回是否自动标记为已安装启用
}
```

约定：

- 插件 UI 组件一律 `React.lazy` 懒加载（宿主引入 code-splitting 基建，这是本次改造顺带补齐的能力）；
- 插件不得反向 import 宿主页面模块；对宿主领域事件的依赖只允许声明 `eventSubscriptions`；
- i18n 键以插件命名空间隔离（`plugins.feishuBot.*`、`feishu.*` 保留既有前缀不动，避免 5 个语言文件大面积 churn）；
- 模型插件无 UI 贡献，其 manifest 由 Rust 侧 `STT_MODELS` 目录（`lib.rs:680-753`）映射生成：id、引擎归属、体积、能力标签（说话人分离/热词偏置）、磁盘路径；社区卡片渲染与安装/卸载命令由宿主按 `kind` 统一分发；
- 模型差异（参数配置、能力、运行时需求）以「模型描述符」数据化（§5.3②）——引擎层适配是**代码**、随应用发版；模型层差异是**数据**、随插件分发，适配器统一读描述符，不做 per-model 硬编码。

### 4.4 插件状态与持久化

```
lynse_plugins_state（经 StorageAdapter 持久化）
{
  "lynse.feishu-bot":        { installedAt: 1730000000, enabled: true },
  "lynse.workbuddy":         { installedAt: 1730000000, enabled: true },
  "lynse.model.qwen3-asr-1.7b-8bit": { installedAt: 1730000000 }  // 模型插件只有安装态
}
```

- zustand 模块单例 store，遵循仓库既有模式（不用 persist 中间件，启动时从 StorageAdapter 读、写路径直写）。
- 状态只存前端；Rust 侧不新增插件状态模块。**停用插件时由 `onDisable` 负责调用对应 Rust stop/清理命令**（如 `feishu_bot_stop`），保证 Rust 常驻进程（如飞书 WS）真正停下。

### 4.5 扩展点改造明细

**设置对话框**（`settings-dialog.tsx`）

- `SettingsSectionId` 联合类型扩展为 `"account" | "plugins" | …核心分区 | ...插件贡献分区`；
- 既有命令式 `sections.push(...)` 改为：核心分区保留内置声明 + `PluginRegistry.getSettingsSections()` 合并（按 `order` 权重排序）；
- 「插件」作为固定分区进入设置导航（account 之后、about 之前）；
- STT 分区**保留为核心分区**（转写不插件化，见 §5.3），仅把内联的状态与处理函数（103–229 行）抽成独立组件 `stt-settings-section.tsx`，settings-dialog 瘦身约 150 行——纯代码整理，无插件语义。

**侧边栏**（`lynse-sidebar.tsx`）

- `topItems/bottomItems` 增加一段：`PluginRegistry.getSidebarItems().filter(已安装且启用)`，渲染复用现有 `NavButton`；
- 核心菜单项不动。首批三个插件默认不贡献侧边栏项（它们的价值入口在设置与工作流内），但机制本期落地——是否给某个插件配侧边栏入口见 §12 待确认。

**路由**（`App.tsx` PageRouter）

- 本期不改 if/else 结构（核心页面占绝大多数，收益低风险高）；`routes` 贡献点在 P5 作为可选能力实现：插件路由统一挂 `/plugin/<id>/…` 前缀，避免与核心路由冲突。

**事件订阅**（解除飞书与页面的硬耦合）

- 新增轻量领域事件：`packages/core/plugins/events.ts` 定义 `emitTranscriptionCompleted(payload)`；
- `notes/page.tsx` 与 `workspace/content-panel.tsx` 中直接调用飞书推送的位置改为 emit 事件；
- 飞书插件通过 `eventSubscriptions` 注册 `useFeishuTranscriptionCompletedWatcher` 等价逻辑，由宿主 `<PluginHost />`（挂在 `App.tsx` 现有 `BotAgent` 位置）渲染 headless 订阅组件；
- `BotAgent` / `BotAuthSupervisor` 留在宿主（bot 通道框架是核心设施），但遍历 `BOT_CHANNELS` 改为遍历「已启用且已安装的 bot 类插件」。

### 4.6 插件社区 UI（设置 → 插件）

- 入口：设置导航新增「插件」分区（`featureFlags.pluginMarketplace` 灰度控制，默认随版本开启）。
- 布局：插件卡片网格（图标、名称、一句话描述、分类、状态徽标），复用 shadcn 既有卡片/开关组件，遵循面板无投影偏好。
- 卡片状态机：`未安装` →（安装）→ `已停用` →（启用）→ `已启用`；已启用卡片提供「设置」直达该插件分区、「停用」；已停用提供「启用」「卸载」。
- 安装语义按插件类型分两类，卡片描述需写明：
  - **轻量启用型**（飞书、WorkBuddy）：安装即注册，无下载；
  - **模型插件**（Qwen3/MOSS/Whisper 等，归入「转写模型」分类）：安装 = 下载模型资产包——卡片展示体积、能力标签（说话人分离/热词偏置/推荐场景）、下载进度（复用 `stt-download-progress`）、安装后磁盘占用；卸载即删除模型文件。安装某引擎的首个模型时先引导准备该引擎运行时（mlx-venv/pip 包或 whisper 共享运行时），运行时对用户不可见、不单独成插件。
- 模型安装/卸载收敛到插件社区这一处入口：转写设置分区只保留默认引擎选择（列已装模型）+ 总开关 + 热词/声纹，并提供「获取更多模型」深链到社区；现有设置内的 ModelManager 列表随迁移挪入社区，避免双入口。
- 卸载：移除注册与状态；`onUninstall` 可选清理本地配置（默认保留用户数据，卡片上说明）。
- 远程目录（P5）：启动后异步拉取 CloudBase `plugins/catalog.json`（结构 = manifest 的元数据子集 + 公告位），用于展示新插件推荐与文案热更新；拉取失败静默回退内置目录，不阻塞 UI。

---

## 5. 首批插件清单与拆分方案

### 5.1 `lynse.workbuddy` — WorkBuddy 助手（首发，验证全链路）

| 项 | 内容 |
|---|---|
| 迁入 | `packages/core/auth/workbuddy.ts` → `packages/core/plugins/builtin/workbuddy/`；`workbuddy-config-card.tsx` → 插件 section 组件（懒加载） |
| 贡献 | settingsSection（替代现在 328–333 行的无条件挂载）；无侧边栏项 |
| 可用性 | 已登录（沿用现状：无 desktopAPI 门控，Web 亦可展示） |
| onDisable | 清内存 token 缓存（`getWorkBuddyAccessToken` 的 cache） |
| 迁移探测 | 后端绑定状态查询成功 → 自动标记已安装+启用 |

### 5.2 `lynse.feishu-bot` — 飞书机器人（bot 通道插件的第一个实现）

| 项 | 内容 |
|---|---|
| 迁入 | `packages/views/feishu/` → `packages/views/plugins/builtin/feishu-bot/`；`bots/` 框架留在宿主作为「bot 通道宿主设施」 |
| 贡献 | settingsSection（`FeishuConfigCard`，替换 `getDesktopFeishuApi()` 门控为插件安装门控）；eventSubscriptions: `transcription-completed`（原 `feishu-push.ts` 推送逻辑） |
| 可用性 | `getDesktopFeishuApi()` 非 null（仅桌面） |
| onEnable | `feishu_bot_start`（若配置完整）；onDisable | `feishu_bot_stop` |
| 迁移探测 | `{app_data}/feishu/config.json` 存在或钥匙串有 secret → 自动安装+启用 |
| Rust | 零改动（`bots.rs` 通道表与 feishu 命令原样保留） |
| 页面改造 | `notes/page.tsx`、`content-panel.tsx` 去 feishu import，改 emit 事件（§4.5） |

### 5.3 离线语音转写 — 能力不插件化，模型插件化

评审结论（v0.3）：转写需按模型深度适配（Rust 六引擎适配器 + 各自 Python 桥接/venv），且是实时转写、自动录音、总结推送等多条链路的公共管线——**转写功能本体不做插件**，留在核心；只有离线**模型**是纯数据资产（深度适配在引擎代码里、随应用发版），做成模型插件进社区。这一刀把原方案风险最大的部分（对核心转写链路做安装门控）整体移除。

**① 留在核心（行为不变）**

- Rust 六引擎适配器、转写管线、热词/声纹后处理、结果消费（workspace 详情、notes 列表）：原样保留，不做任何安装门控；
- 设置「语音识别」分区保留原位置，总开关 `OFFLINE_TRANSCRIPTION_ENABLED_KEY` 不迁移；仅把 settings-dialog 内联的状态与处理函数（103–229 行）抽成 `stt-settings-section.tsx` 独立组件（纯代码整理）；
- 默认引擎选择器改为只列已安装模型插件所属引擎，附「获取更多模型」深链到插件社区。

**② 模型插件（`kind: "model"`，映射 Rust `STT_MODELS` 目录）**

| 模型插件 id | 引擎 | 上架状态 | 说明 |
|---|---|---|---|
| `lynse.model.funasr-latest` | funasr | **首批推荐** | FunASR 最新版模型包（既有引擎，Paraformer/SenseVoice 转写 + CAM++ 声纹）——安装它即声纹能力就绪，接替原「funasr-voiceprint 隐性依赖包」的角色 |
| `lynse.model.whisperx-latest` | whisperx | **首批推荐** | WhisperX 最新版：faster-whisper 底座 + wav2vec2 对齐 + pyannote 说话人分离——**新引擎**，适配工作独立成 §9 P5；Apple Silicon 上走 CPU 推理（CTranslate2 无 Metal 后端），以速度换分离与对齐能力 |
| `lynse.model.qwen3-asr-1.7b-8bit` / `0.6b-4bit` | qwen3 | 保留上架 | 现役默认引擎，已可用；是否撤出社区首批清单见 §12 Q8 |
| `lynse.model.moss-transcribe-8bit` | moss | **延后上架** | 量化与适配未完成；MLX 量化工作收尾后再进社区 |
| 原生 whisper / vibeasr / mlx-whisper 档位 | — | 暂不进社区 | 引擎与 `STT_MODELS` 目录保留、已装模型继续可用，仅不进社区首批清单，避免选择过载 |

**模型描述符（`kind: "model"` 的核心契约，初稿字段）**

不同模型的参数配置不同、效果不同，这些差异必须从适配器的分支逻辑里搬进描述符数据。运行时字段（`runtime`/`invokeDefaults`）源在 Rust `STT_MODELS` 条目（适配器直接读取），展示字段（体积/能力）镜像进前端 manifest 供社区卡片使用：

```ts
interface SttModelDescriptor {
  engine: "qwen3" | "moss" | "whisper" | "whisperx" | "vibeasr" | "mlx" | "funasr";
  quantization: string;            // 8bit / 4bit …
  sizeBytes: number;               // 下载体积与磁盘占用（社区卡片展示）
  minMemoryGb: number;             // 建议可用内存门槛（低配机引导）
  capabilities: {
    diarization: boolean;          // 说话人分离（MOSS 为 true，其余 false）
    hotwordBias: boolean;          // 引擎级热词偏置（Qwen3 context 热词；MOSS/Whisper 仅靠后处理替换）
    languages: string[];           // 覆盖语言（配合核心 TranscribeConfig.per_language 路由）
    timestamps: boolean;
    priorContext: boolean;         // SttRequest.prior_context 是否生效
  };
  runtime: {
    venvPackages?: string[];       // 该模型所需 pip 包（mlx-qwen3-asr / mlx-lm、tokenizers…）
    sharedRuntime?: "whisper";     // 所需共享运行时
    device: "mps" | "cpu";         // 推理设备默认值（如 MOSS 的 --device mps 需显式传）
  };
  invokeDefaults: Record<string, number | string | boolean>;  // 传给适配器的默认参数
  minAppVersion: string;           // 参数需要新适配器代码时，旧 App 安装即阻止并提示升级
}
```

描述符的三个消费方：① 社区卡片展示（体积/能力/推荐场景）；② 管线决策（引擎选择器可用性、能力缺口引导、per_language 路由校验）；③ 适配器运行参数（`invokeDefaults` + `runtime`，替代 per-model 分支）。

规则：

- 安装 = 既有 `local_stt_download_model`（Qwen3/MOSS 经 Python 桥接按网络区域从 ModelScope/HF 下载；FunASR/WhisperX/Whisper/VibeASR 包走 curl + SHA-256 共享运行时管线，CloudBase 镜像优先），进度经 `stt-download-progress` 上社区卡片；卸载 = 既有 `local_stt_delete_model`；
- 卸载保护覆盖两处引用：当前默认引擎的模型、`TranscribeConfig.per_language` 路由引用的模型——阻止并引导先切换/改路由；
- 能力缺口显性引导：开启声纹但未装 `funasr-voiceprint`、需要说话人分离但当前引擎不支持 → 转写界面/设置给「去插件社区安装对应模型」深链（把现状「声纹静默跳过」的暗行为显性化）；
- 效果与可复现性：换模型效果不同是产品预期（模型选型 = 效果/速度/体积的权衡）；既有机制保留——任务创建时冻结 ProviderConfig（序列化随记录存档，lib.rs），转写结果与所用配置一起持久化，卸载模型后历史结果仍可查看、重跑时才提示重装对应模型；
- 引擎运行时（`mlx-venv`、pip 包、whisper 共享运行时）在该引擎首个模型安装时按描述符 `runtime.venvPackages` 引导准备，不单独成插件；
- 「不发版上新模型」边界：同一引擎内、描述符参数不超出当前适配器能力的新模型 = 数据 + 目录条目，可经远程目录下发（P5 可选项，见 §12）；需要新适配参数或新引擎的模型必须发版（`minAppVersion` 在安装时校验，防止「装了但跑不对」）。

**③ 迁移探测**：`local-asr-models/` 下已有模型 → 对应模型插件自动标记已安装（转写设置与管线零迁移、零行为变化）。

### 5.4 后续候选（不在本期承诺，按同一模板扩展）

WebDAV 同步、会议自动录音、音频编辑器、灵感语音。二期优先级建议：WebDAV → 会议自动录音（按耦合度从低到高）。

---

## 6. 数据迁移与兼容

1. **升级自动迁移**：首次启动时依次执行各插件 `migrate()`；探测命中 → 写入 installed+enabled。迁移结果一次性写入 `lynse_plugins_state`，之后不再重复探测（避免用户主动卸载后被复活）。
2. **配置零搬家**：飞书 config.json、钥匙串 secret、WorkBuddy 后端 token、STT 模型目录均不挪位置，插件沿用既有命令与路径。
3. **灰度开关**：`featureFlags.pluginMarketplace = false` 时，插件社区入口隐藏，已迁移插件按「安装+启用」默认状态运行——等价于现状，保证可随时回退 UI。
4. **Web 端**：`platforms` 不含 `web` 的插件在 Web 设置中不渲染分区（现状即如此，无回归）。

---

## 7. 目录服务（插件社区后端）

- 托管位：复用 updater 所在 CloudBase 静态托管环境（`lynse-d8g49o1i956741f9e-1401959758.tcloudbaseapp.com`），新增 `plugins/catalog.json`；CI 的 `mirror-cloudbase` 流水线同步扩展（参照 `docs/auto-update.md`）。
- 目录结构：`{ catalogVersion, updatedAt, plugins: [{ id, name, description, category, icon, minAppVersion, highlight? }] }`。
- 客户端策略：内置目录为准，远程目录仅覆盖展示文案与新增「敬请期待」占位卡；SHA-256 校验沿用 `download_runtime` 模式；失败静默。
- 插件开发文档：`docs/plugin-development-guide.md`（随本 PRD 产出初版）——面向插件开发者的 manifest / 扩展点 / 模型描述符 / 事件参考与验收清单，是插件生态的对外入口；
- 分发路线：当前 = 内置插件（随源码构建，fork 即可自带插件）；近期 = 远程目录上架（元数据 + 模型/资产包，无代码、无需发版）；二期【规划】= JS 插件运行时（第三方插件以 ESM 包 + 能力 API 沙箱分发，manifest 自设计起按运行时可加载兼容）。

---

## 8. 安全与权限模型（v1）

- 内置插件代码随包发布，与应用同签名，无额外攻击面；
- `permissions` 字段 v1 的作用：① 插件社区卡片上向用户明示能力（网络、钥匙串、本地存储、后台连接）；② 作为代码评审清单约束插件不得越界访问其他插件数据；
- 数据隔离：插件本地数据落 `content_dir` 下新增 `Plugins/<pluginId>/` 约定（`ContentKind` 扩展一个成员），密钥一律走既有 `secure_get/set_secret` 钥匙串命令；
- 新窗口类贡献（若未来插件社区独立成窗）必须同步登记 `capabilities/default.json`——本期社区是设置分区，无新窗口，不涉及。

---

## 9. 分阶段实施计划

> 工作量为单人估算（含自测）。每阶段独立可发布，阶段间不阻塞并行会话的其他工作。
> 每阶段通用验收：`pnpm typecheck`、`pnpm lint`、`pnpm test` 通过；5 个语言文件键完整；设置页/侧边栏在启用、停用、卸载三种状态下渲染正确。

### P0 插件地基（2–3 天）

- 新建 `packages/core/plugins/`：`types.ts`（Manifest/贡献点类型）、`events.ts`（领域事件）、`store.ts`（状态 store + StorageAdapter 持久化）、`registry.ts`（内置插件注册表 + `definePlugin`）；
- `packages/views/plugins/`：`plugin-host.tsx`（headless 挂载点）、懒加载工具；
- 单测：store 持久化、registry 合并逻辑、状态机（未安装→安装→启用→停用→卸载）。
- **验收**：无任何功能行为变化，纯基建合入。

### P1 WorkBuddy 首发迁移（1–2 天）

- 按 §5.1 迁移；settings-dialog 的 workbuddy 分支改读注册表；
- 迁移探测 + `lynse_plugins_state` 写入。
- **验收**：全新安装 → 设置中无 WorkBuddy 分区、插件社区显示「未安装」；安装启用后分区出现且授权流程（浏览器 OAuth → 轮询 → 绑定面板）与现状一致；老用户（已绑定）升级 → 自动已启用，绑定状态无损。

### P2 插件社区 UI（3–4 天）

- 「插件」设置分区：卡片网格 + 状态机操作 + 空态/加载态；
- i18n：`plugins.*` 键 × 5 语言；`featureFlags.pluginMarketplace` 灰度；
- **验收**：灰度关闭时设置页与现状完全一致；开启后可完成 WorkBuddy 的完整安装/停用/卸载循环；社区在 Web 端正常降级展示。

### P3 飞书机器人插件化（3–4 天）

- 按 §5.2 迁移；事件总线落地（`transcription-completed`）；`notes/page.tsx`、`content-panel.tsx` 去 feishu 化；`BotAgent`/`BotAuthSupervisor` 改读启用的 bot 插件；
- **验收**：全新安装无飞书痕迹（无设置分区、无 WS 连接——日志验证 `feishu::spawn` 后无连接尝试）；安装后一键注册、收发消息、总结推送（转写完成 → 飞书卡片）全链路通；停用后 WS 断开且推送停止；已配置老用户自动迁移。

### P4 转写模型插件化基建 + FunASR 首发（3–4 天）

- 前置整理：settings-dialog 内联 STT 状态/处理函数抽成 `stt-settings-section.tsx`（无插件语义，可提前到 P2 期间并行做）；
- 模型插件基建：`STT_MODELS` 目录映射进插件社区（「转写模型」分类，卡片含体积/能力标签/下载进度/卸载），安装走既有 `local_stt_download_model`、卸载走 `local_stt_delete_model`；引擎运行时在该引擎首个模型安装时引导准备；设置内 ModelManager 挪入社区，设置分区保留默认引擎选择 + 「获取更多模型」深链；
- 首发模型：FunASR 最新版包（既有引擎，`lynse.model.funasr-latest`，装它即声纹 CAM++ 就绪）+ Qwen3 两档保留上架；MOSS 延后（量化与适配未完成）；
- **验收**：设置「语音识别」分区与现状逐项对照一致；社区安装 FunASR → 进度可见 → 本地转写端到端可用、声纹可用；卸载双引用保护（默认引擎 + per_language 引用）生效；老用户已有模型自动映射为已安装的模型插件；实时转写/自动录音/云端转写全链路无感知。

### P5 WhisperX 引擎适配与上架（4–6 天）

- 新引擎接入：Rust `BatchSttAdapter` 新增 whisperx 适配器 + `whisperx_transcribe.py` Python 桥接；运行时依赖（faster-whisper/CTranslate2、wav2vec2 对齐模型、pyannote 分离模型）走共享运行时下载管线（curl + SHA-256，CloudBase 镜像优先）；
- 前置拍板：pyannote 分离模型的分发方式（HF token 用户提供 vs 我方核许许可后代理托管 vs 首版后置分离，见 §12 Q7）；
- 描述符上架：`lynse.model.whisperx-latest`（capabilities: diarization=true、hotwordBias=false）进社区；
- **验收**：WhisperX 端到端（转写 + 说话人分离 + 对齐时间戳）；与 FunASR/Qwen3 互切默认引擎回归；记录 Apple Silicon CPU 推理 RTF 基线（无 Metal 后端，速度预期明确写入社区卡片）；卸载/重装循环干净。

### P6 生态收尾（2–3 天）

- CloudBase `plugins/catalog.json` 上线 + 客户端远程目录拉取；
- 插件开发文档正式化：`docs/plugin-development-guide.md` 初版已随 PRD 产出，本期与实现对齐（API 签名、模板工程、验收清单），作为对外生态入口；
- （可选）`routes` 贡献点落地；`ContentKind.Plugins` 数据目录约定落地。
- **验收**：断网/目录损坏时社区 UI 正常（回退内置目录）；按开发文档新增一个 demo 插件全流程 ≤ 半天。

**总计约 18–26 人天（4–5 自然周）。** 发布顺序建议：P0+P1+P2 一个版本（含灰度开关），P3 一个版本，P4 一个版本（转写模型社区），P5（WhisperX）与 P6 可合并发版或搭车。

---

## 10. 测试计划

| 层 | 内容 |
|---|---|
| 单测（Vitest） | registry 合并、store 状态机与持久化、事件总线分发、迁移探测函数（注入假 StorageAdapter 与假 desktopAPI） |
| 集成自测（每阶段手动清单） | 安装/启用/停用/卸载循环 × 3 插件；灰度开关前后对比截图 |
| 转写回归（P4/P5） | Qwen3-1.7B、FunASR-latest 各一轮端到端（本地 + 实时 + 云端对照）；WhisperX 转写 + 说话人分离 + 对齐时间戳一轮（P5）；模型插件安装（进度）/卸载（磁盘回收）/切换默认引擎循环；设置「语音识别」分区与现状逐项对照；能力缺口深链引导与双处卸载保护用例 |
| 飞书回归（P3） | 一键注册、消息问答、流式卡片、总结推送、登出暂停（BotAuthSupervisor） |
| 升级迁移 | 用 v1.0.4 构造已配置态 → 安装新版 → 校验自动迁移与配置无损 |

---

## 11. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| 转写模型社区入口与设置内模型管理双入口造成困惑 | 低 | 安装/卸载收敛到社区「转写模型」分类；设置分区保留默认引擎选择 + 「获取更多模型」深链（见 §5.3①） |
| `feishu-push` 与 notes/content-panel 解耦遗漏边界（如灵感语音完成是否也推送） | 中 | P3 迁移前先枚举 `useFeishuTranscriptionCompletedWatcher` 全部调用点（当前已知 2 处），事件 payload 保持向后兼容 |
| workbuddy 文件是未提交 WIP（并行会话在改） | 中 | P1 开工前与并行会话确认 workbuddy.ts/config-card 基线；迁移用「移动 + 保持导出兼容」而非重写 |
| 插件状态经桌面 secureStorage 持久化造成钥匙串条目膨胀 | 低 | 状态为单键 JSON；如实测有膨胀，换普通 localStorage 键（一行改动） |
| `React.lazy` 首次引入带来打包配置回归 | 低 | P0 只在插件组件上启用并验证 Tauri 打包；不扩散到既有页面 |
| 插件社区让「功能去哪了」产生支持成本（用户找不到停用的功能） | 低 | 卸载确认弹窗列明影响；未安装功能的入口位置在社区卡片描述中写明 |

---

## 12. 待确认问题（评审时需拍板）

1. **侧边栏菜单项**：首批三插件是否需要侧边栏入口？若需要，给哪个？（机制 P0 已含，配项只是声明成本；目前默认都不配，插件仅出现在设置里。）
2. **插件社区是否独立成窗**：本期做成设置分区；若想要独立大窗（类应用商店观感），P2 工作量 +2 天且需登记 capabilities（新窗口 label）。
3. **卸载语义**：卸载 WorkBuddy 是否清后端绑定？卸载飞书是否清本地 config.json + 钥匙串 secret？（当前建议：默认保留，卡片提示可手动清理。）
4. **二期名单确认**：WebDAV → 会议自动录音 的顺序是否符合预期。
5. **模型插件远程上新**：P6 的远程目录是否同时下发「现有引擎的新模型」条目，实现不发版上新模型（纯数据，Rust 侧 `STT_MODELS` 合并远程条目放行；远程条目必须携带完整描述符，`minAppVersion` 不满足时对旧 App 直接隐藏该条目而非置灰）；需要新适配参数或新引擎仍必须发版。若确认，P6 增加 Rust 目录合并远程条目的工作（约 +1 天）。
6. **WhisperX 说话人分离的模型分发**：pyannote 分离模型在 HuggingFace 有许可门控（用户需接受条款 + token）。三选一：① 引导用户填自己的 HF token；② 我方核对许可条款后经 CloudBase 代理托管分发；③ 首版 WhisperX 只上转写 + 对齐，分离功能后置。
7. **Qwen3 是否保留在社区清单**：本 PRD 按保留处理（现役默认引擎、低配机选项已可用）；若社区首批只想突出 FunASR + WhisperX，可将 Qwen3 移出清单，已装用户不受影响。

---

## 13. 真机验收记录（2026-09-19，dev 环境 com.lynse.sparknote）

> 方式：`pnpm dev:desktop` 运行 + 日志取证 + 与 Rust 命令同参的桥接直调 + 组件测试（jsdom 真事件）。本机截屏/AppleScript TCC 授权受限，像素级 UI 点击不可用，社区卡片交互以组件测试取证。

| 验收项 | 结果 | 证据 |
|---|---|---|
| P3 停用后重启不自启 | ✅ | 注入测试凭据（enabled=true）重启 → 日志 `[feishu] bot enabled at startup — starting WS session`；翻转为 enabled=false（即 onDisable 持久化的状态）重启 → `[feishu] bot disabled at startup — not starting`，WS 零启动 |
| P3 停用/启用/迁移前端接线 | ✅ | 组件测试 8 项全绿：onDisable → saveConfig(enabled=false)+stop；无凭据 onEnable 不落标志不启动；有凭据则翻转并 start；migrate 探测配置 |
| P3 运行中停用 → WS 瞬时断开 | ⚠️ 部分 | stop() 调用已由组件测试断言；「在线→断开」瞬态需真实飞书凭据 + UI 点击，本会话无法驱动，留待日常使用观察 |
| P4 FunASR 下载+转写 | ✅ | 按 `local_stt_download_model` 同参直调桥接：模型（1.13GB）下载到应用真实目录并产生 `.ready`（社区卡片判定已安装的依据）；测试语音转写全文正确（RTF 0.113，词级时间戳 + CAM++ 说话人） |
| P4 社区模型卡交互 | ✅ | 组件测试：下载按钮路由到 `downloadSttModel(funasr, funasr-paraformer)`；默认引擎引用中的模型删除被 toast 阻止且不调删除命令；无引用时正常删除 |
| P5 WhisperX 端到端 | ✅ | python3.12 venv + 桥接直调：模型下载（HF 源失败自动回退镜像，生效）→ CPU 推理 → 测试语音全文正确（`各位好 今天下午三点我们在会议室开产品评审会议 请准时参加`，词级对齐 0.03–7.22s），输出 JSON 契约与 Rust `normalize_whisper_output` 一致 |
| P5 真机缺陷与修复 | ✅ | 缺陷：系统 `python3`(3.14) 无 whisperx/ctranslate2 兼容轮子，venv 创建后 pip 失败。修复：`ensure_whisperx_venv` 按 python3.12→3.11→3.13→python3 顺序选择解释器（已在 dev 实例验证重建） |
| 可观测性补强 | ✅ | feishu `spawn` 此前对「自启」与「不自启」均静默，无法验收——已补两条 info 日志（与既有 `enabled but not starting` 同风格） |

环境备注：测试凭据已清理、密钥文件恢复原状；FunASR 模型（~1.1GB）保留在应用模型目录（可在设置 → 存储管理清除）；仓库根新增 `.venv-whisperx`（1.3GB）/`.venv-funasr`（1.4GB）——均被 `.gitignore`（`.venv-*/`）忽略，且是 Rust dev 回退路径，开发实例会自动采用。
