# Lynse 插件开发指南

> 版本：v0.2（2026-09-18）｜配套 PRD：`docs/plugin-architecture-prd.md` v0.5
> 读者：想为 Lynse 桌面端开发插件的开发者。
> 状态：**P0–P5 已实现**（`packages/views/plugins/`）。本文描述与代码对齐；标注「【已存在】」「【规划】」区分现状与计划，引用已存在机制时给出真实代码路径。

## 实现要点（与代码的差异说明）

- 模块全部位于 `packages/views/plugins/`（PRD 原计划 core+views 分层，因 manifest 持有 React 组件收敛到 views）；
- manifest 字段为 `nameKey` / `descriptionKey`（i18n key），不是明文；
- 迁移探测从 `PluginHost` 挂载 effect 触发（Tauri 桥接在 main.tsx 主体安装，import 期探测拿不到 desktopAPI）；
- 模型插件目录见 `plugins/transcription-models.tsx`（FunASR/WhisperX/Qwen3×2；MOSS 延后），远程目录 `plugins/catalog.ts` 拉 CloudBase `plugins/catalog.json`（失败静默）。

---

## 1. 认识 Lynse 插件体系

Lynse 的插件有三种形态：

| 形态 | kind | 本质 | 分发方式 |
|---|---|---|---|
| 功能插件 | `app` | 随应用内置的功能模块，默认未安装，社区安装后注册菜单/设置入口 | 随源码构建（当前）；远程目录元数据上架（近期） |
| 模型插件 | `model` | 纯数据资产包（离线转写模型等），安装 = 下载、卸载 = 删文件 | 远程目录上架（近期），无需发版 |
| 社区分发插件 | `app` | 第三方开发的 JS 插件包 | 【二期规划】JS 插件运行时，见 §11 |

**硬边界（v1 必须知晓）：**

- 插件运行在宿主 Webview 进程内，**不能加载原生库、不能新增 Rust 命令**。Rust 侧能力（Tauri commands）编译期固化在 `apps/tauri/src-tauri/src/lib.rs` 的 `generate_handler!` 列表里，新增命令需要宿主版本发版。
- 插件之间不通信、不互相依赖；每个插件只能访问自己的数据与密钥。
- 共享包零框架依赖：`packages/views/` 禁止 `next/*` 与 `react-router-dom` 导航，路由一律走 `NavigationAdapter`（`packages/views/navigation/types.ts`【已存在】）。

---

## 2. 快速开始：10 分钟写一个内置功能插件

前置：克隆仓库 → `pnpm install` → `pnpm dev:desktop` 能跑起来。

**Step 1 — 建插件目录**【P0 落地后路径】

```
packages/views/plugins/builtin/hello/
├── index.tsx              # manifest（definePlugin）
├── settings-section.tsx   # 设置分区组件（懒加载）
└── locales.ts             # （可选）插件自带文案，或直接进全局 locales
```

**Step 2 — 声明 manifest**

```tsx
// packages/views/plugins/builtin/hello/index.tsx
import { definePlugin } from "../../registry"; // 最终签名以 P0 实现为准

export default definePlugin({
  id: "lynse.hello",                 // 命名空间：lynse.<snake-case>
  kind: "app",
  version: "1.0.0",
  minAppVersion: "1.1.0",
  nameKey: "plugins.hello.name",     // i18n key，不是明文
  descriptionKey: "plugins.hello.description",
  icon: "Sparkles",                  // 必须是 packages/views/icons.ts 已有图标名
  category: "tool",                  // transcription | integration | assistant | sync | tool
  platforms: ["desktop", "web"],     // 仅桌面的插件写 ["desktop"]
  permissions: ["storage:plugin-scope"],
  availability: () => true,          // 平台能力门控写这里，例：
                                     //   () => getDesktopFeishuApi() != null
  contributions: {
    settingsSection: {
      id: "hello",
      titleKey: "plugins.hello.title",
      order: 500,                    // 核心分区 < 400；about 固定 900
      component: HelloSettings,      // 实现期直引组件；懒加载优化后置
    },
    // sidebarItem?: { key, labelKey, icon, path },   【规划】
    // eventSubscriptions?: ["transcription-completed"],  见 §4.4
  },
  lifecycle: {
    onInstall?: async () => {},      // 如触发资源下载确认
    onEnable?: async () => {},       // 如启动后台连接
    onDisable?: async () => {},      // 必须真正停止：调对应 Rust stop 命令
    onUninstall?: async () => {},    // 可选清理；默认保留用户数据
  },
  migrate: async () => false,        // 老配置探测：命中返回 true → 自动安装+启用
});
```

**Step 3 — 注册**：在 `packages/views/plugins/builtin/index.ts` 加一行导出【P0 落地】。

**Step 4 — i18n**：在 `packages/views/locales/{en,zh,ja,ko,zh-Hant}.ts` 五个文件中添加 `plugins.hello.*` 键。五个文件必须同步，CI 有键完整性检查（见 §10）。

**Step 5 — 验证**：`pnpm dev:desktop` → 设置 → 插件：社区卡片可见「未安装」→ 安装 → 设置导航出现「hello」分区 → 停用 → 分区消失。

---

## 3. Manifest 字段参考

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 全局唯一，`lynse.<slug>`；模型插件 `lynse.model.<slug>` |
| `kind` | ✅ | `"app"` 功能插件（有 UI 贡献）/ `"model"` 模型插件（纯资产，无 UI） |
| `version` | ✅ | semver；模型插件跟随模型包版本 |
| `minAppVersion` | ✅ | 宿主最低版本；运行时加载时代用于兼容拦截 |
| `name` / `description` | ✅ | i18n key；社区卡片展示 |
| `icon` | ✅ | `packages/views/icons.ts` 已有图标名，不新增资源文件 |
| `category` | ✅ | 社区分类：`transcription` / `integration` / `assistant` / `sync` / `tool` |
| `platforms` | ✅ | 缺 `web` 时 Web 端不渲染该插件的一切入口 |
| `permissions` | ✅ | 能力声明，v1 用途 = 社区卡片展示 + 代码评审清单（§5） |
| `contributions` | — | 扩展点贡献，见 §4；`kind:"model"` 必须为空 |
| `availability` | ✅ | 返回 false 时插件所有入口隐藏（沿用 `getDesktop*Api()` 能力探测惯例，参考 `packages/views/feishu/feishu.ts:83`） |
| `lifecycle` | — | 见 §4.5 |
| `migrate` | — | 老配置迁移探测。只在升级后首次启动跑一次，命中即写入插件状态，之后不再执行（用户卸载后不会被复活） |

---

## 4. 扩展点详解

### 4.1 settingsSection（设置分区）

- 组件为默认导出、`React.lazy` 包裹（宿主靠它做代码分割——这是宿主首次引入懒加载，插件必须遵守）；
- 组件内部自管数据获取（TanStack Query，query key 以插件 id 为前缀）与本地状态；
- 样式只用 shadcn token（`packages/ui`），禁止硬编码色值；**面板不加投影**（产品已定的视觉决策）；深浅色主题都要过一遍；
- 分区出现在设置导航的位置由 `order` 决定：account 100 / 既有核心分区 200–400 / 插件 500+ / about 900。

### 4.2 sidebarItem（侧边栏菜单项）【P0 机制落地，P6 开放配置】

- 贡献 `{ key, labelKey, icon, path }`，宿主在 `packages/views/layout/lynse-sidebar.tsx` 的渲染流程中合并（`topItems/bottomItems` 之后追加一段）；
- `path` 必须以 `/plugin/<id>` 为前缀，避免与核心路由冲突；页面组件经 routes 贡献点提供（§4.3）。

### 4.3 routes（独立页面）【规划 P6】

- 插件路由统一挂 `/plugin/<id>/…`，宿主 `PageRouter`（`apps/tauri/src/App.tsx`）保留 if/else 结构处理核心页，插件路由走注册表统一分发；
- Web 端（Next.js 文件路由）本期不自动映射插件路由，插件页面在 Web 上隐藏。

### 4.4 事件订阅（headless 组件）

宿主领域事件总线【P3 随飞书插件落地】：

| 事件 | 触发时机 | payload（向后兼容承诺：只增不改） |
|---|---|---|
| `transcription-completed` | 一次转写任务完成（云端或本地） | `{ recordId, source: "cloud"\|"local", segments, conclusionText? }` |

- 插件声明 `eventSubscriptions` 后，提供一个**headless 订阅组件**（渲染返回 `null`），由宿主 `<PluginHost />` 按「已安装且启用」状态挂载/卸载；
- 参考实现：飞书插件的转写完成推送（原 `packages/views/feishu/feishu-push.ts` 的 `useFeishuTranscriptionCompletedWatcher` 逻辑迁移为订阅组件）；
- 生产方（核心代码）只负责 `emit`，不 import 任何插件——这是硬规则，违反即架构回退。

### 4.5 生命周期契约

- `onEnable` / `onDisable` **必须对称**：启了什么就停什么。启了后台连接（WS、轮询）就必须在 `onDisable` 里调对应 Rust stop 命令（参考 `feishu_bot_stop`）。宿主不负责替你清理。
- `onUninstall` 默认**保留用户数据**（数据清理要在卡片文案里明示）；确要清理时只能动自己 `lynse.<id>` 范围内的数据与密钥。
- `migrate` 必须幂等、无副作用（只读探测 + 返回布尔），写状态由宿主完成。

---

## 5. 数据、密钥与权限

- **数据目录**：目标约定 `content_dir(Plugins/<pluginId>/)`【P6 落地 `ContentKind.Plugins`】；落地前过渡期允许在 app data 下自管目录，但必须在 `permissions` 里声明 `storage:plugin-scope`。统一内容根的机制见 `apps/tauri/src-tauri/src/vault.rs`（`content_dir`）【已存在】。
- **密钥**：一律走钥匙串命令 `secure_get_secret` / `secure_set_secret` / `secure_delete_secret`（`apps/tauri/src/secure-storage.ts`【已存在】），键名约定 `lynse_<plugin短名>_<key>`（如飞书的 `lynse_feishu_app_secret`）。**禁止**把 secret 写进 StorageAdapter/localStorage/JSON 配置文件。
- **偏好与非敏感状态**：走 `StorageAdapter`（`packages/core/types/storage.ts`），键前缀 `lynse.<pluginId>.`。
- **permissions 词汇表（v1）**：`network:<host-or-domain>`（外联目标）、`storage:plugin-scope`（自有数据）、`secrets`（钥匙串）、`events:transcription`（订阅领域事件）、`background-connection`（常驻连接，卡片会显示「后台活动」徽标）。
- **禁止事项**：读其他插件的数据/密钥；绕过桥接直接 fetch 非 `permissions` 声明的外部域（评审标准，非运行时强制）；import 其他插件的模块。

---

## 6. 模型插件（转写模型）专项

模型插件没有 UI、没有生命周期，核心是**模型描述符**——它决定社区卡片展示、管线决策和适配器运行参数：

```ts
interface SttModelDescriptor {
  engine: "qwen3" | "moss" | "whisper" | "whisperx" | "vibeasr" | "mlx" | "funasr";
  quantization: string;            // "8bit" | "4bit" …
  sizeBytes: number;               // 下载体积 / 磁盘占用（卡片展示）
  minMemoryGb: number;             // 内存门槛（低配机引导）
  capabilities: {
    diarization: boolean;          // 说话人分离（whisperx/moss = true）
    hotwordBias: boolean;          // 引擎级热词偏置（qwen3 context 热词 = true）
    languages: string[];
    timestamps: boolean;
    priorContext: boolean;
  };
  runtime: {
    venvPackages?: string[];       // 所需 pip 包（首次安装该引擎模型时引导准备）
    sharedRuntime?: "whisper";     // 所需共享运行时
    device: "mps" | "cpu";
  };
  invokeDefaults: Record<string, number | string | boolean>;  // 适配器默认参数
  minAppVersion: string;           // 需要新适配器代码的模型，旧 App 安装即拦截
}
```

**上架流程**：① Rust `STT_MODELS` 目录（`lib.rs:680-753`【已存在】）加条目（含描述符运行时字段与下载源/SHA-256）→ ② 前端 manifest 由目录映射自动生成 → ③ 社区卡片自动出现。安装/卸载复用既有命令 `local_stt_download_model` / `local_stt_delete_model`，进度事件 `stt-download-progress`。

**必须遵守的保护规则（宿主强制）：**

1. 卸载保护：当前默认引擎的模型、`TranscribeConfig.per_language` 路由引用的模型，不可卸载；
2. `minAppVersion` 不满足时该模型对旧 App **隐藏**（不是置灰）；
3. 结果可复现：任务创建时冻结 ProviderConfig 随记录存档【已存在】，卸载模型后历史转写结果仍可查看，重跑才提示重装；
4. 能力缺口引导：用户开启声纹但未装含 CAM++ 的模型、或选择的任务需要说话人分离但当前引擎不支持 → UI 给「去插件社区安装」深链，不允许静默降级。

**首批社区清单（PRD v0.5 已定）**：`funasr-latest`（推荐，装它即声纹就绪）、`whisperx-latest`（推荐，需 P5 新引擎适配）、Qwen3 两档保留；**MOSS 延后**（量化与适配未完成）。

---

## 7. i18n 规范

- 单 `translation` 命名空间 + 顶层前缀（`packages/views/locales/`【已存在】）。插件统一用 `plugins.<短名>.*` 前缀；迁移进插件的历史命名空间（如 `feishu.*`、`workbuddy.*`）保留不动；
- 五个语言文件（en / zh / ja / ko / zh-Hant）必须同步增删，缺键即 CI 失败；
- 独立窗口（about/反馈类）中注意：脱离 `CoreProvider` 的窗口必须 `useMemo(() => initI18n(...))` 初始化后再用 `useTranslation`，否则永远显示裸 key（react-i18next 的既有坑）。

---

## 8. 本地开发与调试

```bash
pnpm dev:desktop        # Tauri dev，改前端即时热更
pnpm dev:web            # Web 端验证降级表现（桌面专属插件应隐藏）
pnpm typecheck && pnpm lint && pnpm test
```

- Rust 命令联调：`apps/tauri/src-tauri/src/` 下改代码后重启 dev；日志在 `lynse-YYYY-MM-DD.log`（`logging.rs`）；
- 桥接类型：桌面 API 聚合在 `apps/tauri/src/tauri-bridge.ts` 的 `DesktopApi`，插件经 `getDesktop*Api()` 访问，Web 端天然返回 null；
- 新增 Rust 命令需同步：`generate_handler!`（lib.rs）+ `tauri-bridge.ts` 类型 + （若开新窗口）`capabilities/default.json` 登记 window label——漏掉 capabilities 会得到白窗且日志被吞；
- bot 通道类插件（飞书范式）：前端基于 `packages/views/bots/` 宿主设施 + Rust `bots.rs` 通道注册表，`BOT_CHANNELS` 与 Rust `CHANNELS` 必须同步。

## 9. 验收清单（提交前自检）

- [ ] `pnpm typecheck` / `lint` / `test` 全绿
- [ ] 插件三态渲染正确：未安装（仅社区卡片）/ 已停用（无任何入口）/ 已启用
- [ ] 停用后后台活动确实停止（看日志：无 WS 重连、无轮询）
- [ ] `featureFlags.pluginMarketplace = false` 时 UI 与现状零差异
- [ ] 五语言键完整；深浅色主题过一遍
- [ ] `migrate` 探测对老配置命中一次、卸载后不再复活
- [ ] Web 端（`platforms` 不含 web 时）一切入口隐藏、无报错
- [ ] 模型插件：双引用卸载保护、`minAppVersion` 隐藏规则生效

---

## 10. 发布与上架

**内置插件（当前唯一路径）**：代码进 `packages/views/plugins/builtin/`，随宿主版本发布。fork 本仓库自行构建即可自带你的插件——这是当前对第三方开发者开放的完整能力边界。

**远程目录上架（近期）**：模型/资产包与插件元数据经 `plugins/catalog.json`（CloudBase 静态托管，与 updater 同环境）上架，无需宿主发版；提交 PR 修改目录仓库，走审核后发布。

**JS 插件运行时【二期规划】**：第三方插件以 `manifest.json + main.js (ESM)` 包形式运行时加载，宿主注入受控 API（`lynse.plugin.*`：注册贡献点、订阅事件、自有存储、钥匙串），配合权限声明、签名与社区审核。manifest 字段自 v1 起按此目标设计，内置插件届时零改动迁移为分发插件。

---

## 11. FAQ

**Q: 插件能加自己的 Rust 命令吗？**
不能。Rust 能力编译期固化，新增命令 = 宿主发版。模型插件的下载/删除命令已由宿主提供。

**Q: 插件能开新窗口吗？**
技术上可以（参考 `open_about_window` 模式），但需要 `capabilities/default.json` 登记，属宿主评审项；能用设置分区/页面解决的不要开窗。

**Q: 插件之间能互相调用吗？**
不能。需要共享能力就提升为宿主设施（参考 `bots/` 通道框架的做法）。

**Q: 为什么我的插件在 Web 端看不到？**
`platforms` 未包含 `"web"`，或 `availability()` 在 Web 返回 false（桌面 API 缺失）。这是预期降级，不是 bug。

**Q: 效果类插件（转写模型）换一个模型结果就变，正常吗？**
正常，模型选型本身就是效果/速度/体积的权衡。历史结果与当时的引擎配置一起存档，可复现；换默认引擎只影响新任务。

---

*本文由 PRD 评审过程产出；框架实现落地（P0）后，以「文档随代码同行」的方式维护：改 manifest 契约必须同步本文件。*
