# Lynse 桌面端 MCP Host 设计草案

> 状态：草案（待评审）
> 方向：Lynse 桌面端作为 MCP（Model Context Protocol）**宿主（Host/客户端）**，
> 接入第三方 MCP 服务器（如 Gmail 类工具服务器），把其 UI 挂载进侧边栏——
> 对齐 Codex/ChatGPT 的 Apps 体验，兼容 openai/mcp-extensions 规范的宿主侧行为。
> 注意：这是「入方向」。lynclaw 对外作为 MCP 服务端暴露给 Codex 是另一个独立需求，
> 见 lynclaw-main 仓库 `docs/lynclaw-mcp-server-design.md`，两者不互相依赖。

## 1. 背景与目标

[openai/mcp-extensions](https://github.com/openai/mcp-extensions) 是 OpenAI 为
ChatGPT/Codex 宿主定义的 MCP 扩展规范：服务器可以通过 `_meta["openai/…"]` 声明
侧边栏入口（entrypoints）、composer @提及、扩展表单、UI 元数据。用它的 SDK 构建的
"插件"本质仍是标准 MCP 服务器——**我们要做的是宿主侧**：实现标准 MCP 客户端 +
按需实现规范里的宿主行为，让生态里的 MCP 服务器（Gmail 等）接进来后：
1. 在 LynseSidebar 出现对应入口；
2. 打开后有可用的 UI（MCP Apps iframe 渲染，或通用工具面板）；
3. 后续阶段让 AI 助手也能调用这些服务器的能力。

明确的现实约束（写在前面的诚实结论）：
- 该仓库是规范 + **服务端** SDK，没有可直接复用的宿主 SDK；宿主侧照 `docs/spec.md`
  自己实现，且规范尚早期（无正式 release、基于 MCP 草案版本），必须防御性实现
  （未知 `_meta` 一律忽略、能力分级降级）。
- 挂载 UI ≠ 模型能用。模型侧集成受「工具循环在 lynclaw 服务端、poll-only」的
  架构约束，本草案将其拆为独立阶段（见 §6），不阻塞 UI 挂载。

非目标（本期）：不做 MCP 服务器目录商店、不做 lynse:// 深链、不实现
file handlers / `openai/resources/write`、不做 ChatGPT 完整 Apps 协议对齐。

## 2. 现状盘点（决定设计的既有事实）

| 事实 | 位置 | 影响 |
| --- | --- | --- |
| 实际侧边栏是 `LynseSidebar`（AppSidebar 为死代码）；`NavItem` 是硬编码数组 | `packages/views/layout/lynse-sidebar.tsx:34-126`、`dashboard-layout.tsx:26` | 侧边栏动态注入需从零接线 |
| 插件系统 `sidebarItem` 贡献点已定义类型但**全仓库无消费方** | `packages/views/plugins/types.ts:41-51`；`lynse-sidebar.tsx` 不 import plugins | 类型设计可直接沿用，缺的是 registry 收集函数 + 渲染 |
| 插件 UI 全是进程内 React 组件；无第三方代码加载；iframe 先例仅静态 HTML 附件（`sandbox=""`） | `chat-attachments.tsx:619-625`；`plugins/types.ts:38,56` | MCP Apps 的 iframe 渲染是新能力，需新建安全容器 |
| Tauri：tokio/reqwest/tungstenite/keyring 齐备，**无 rmcp/MCP crate**；无 shell 插件；sidecar 用 `std::process::Command` 手工 spawn + stdout 行协议 | `src-tauri/Cargo.toml`、`live_translation.rs:546,935-951`、`lib.rs:366` | MCP stdio 服务器托管有现成模式可抄 |
| 密钥统一存单条 vault keychain entry（`secure_update_vault_entry` 支持任意新键） | `lib.rs:3287-3523`、`apps/tauri/src/secure-storage.ts:37` | MCP 凭证（OAuth token / header 值）直接入 vault |
| CSP 为 `null`；权限模型纯声明式（"not enforced at runtime yet"） | `tauri.conf.json:27-29`；`plugins/types.ts:17-27` | MCP 是真第三方代码，运行时强制必须补上（§7） |
| chat 页无右侧面板；workspace 有成熟的可拖拽 dock 面板 | `chat/page.tsx:556-631`；`workspace/workspace-layout.tsx:58-108` | app 面板可复用 dock 模式 |
| 设置页支持插件贡献 section（`SettingsSectionId` 开放类型） | `settings-dialog.tsx:59-71,80-223` | 「MCP 服务器管理」有现成挂载点 |
| chat 已能透传 tool 事件并渲染，`/mcp/i` 归类已预留 | `chat-reasoning.tsx:23-88`、`workspace/chat-transport.ts` | 模型侧集成的 UI 基础已在 |

## 3. 总体架构

```
Tauri 进程
├── Rust 层（新增 src-tauri/src/mcp/ 模块）★ MCP 客户端核心
│   ├── registry.rs        服务器连接管理（状态机：configured→connecting→ready→error）
│   ├── transport_stdio.rs 子进程托管（参照 audio-capture sidecar 模式）
│   ├── transport_http.rs  远程 Streamable HTTP（reqwest）
│   ├── apps.rs            MCP Apps 资源解析（ui resource HTML、entrypoints、图标）
│   └── oauth.rs           (M2) OAuth 2.1 授权码流（MCP 授权规范）
├── IPC commands（invoke）: mcp_server_add/remove/list/set_enabled,
│   mcp_connect/disconnect, mcp_list_tools, mcp_call_tool,
│   mcp_list_resources/read_resource, mcp_get_app_manifest
├── Tauri events（emit）  : mcp://status, mcp://tools-changed, mcp://tool-activity
└── Webview 渲染层
    ├── 设置新 section「MCP 服务器」：添加/启停/状态/凭证录入
    ├── LynseSidebar 新「MCP Apps」区：来自已连接服务器的入口（动态注入）
    └── McpAppPage（/mcp-app/<serverId>/<entrypointId>）：
        ├── Tier A  MCP Apps UI：sandboxed iframe + postMessage JSON-RPC 桥
        └── Tier B  通用面板：工具列表/表单执行/结果/资源浏览
```

**核心决策：MCP 客户端放 Rust 层（rmcp crate），不放前端。**
理由：stdio 服务器需要子进程管理（Rust 已有 sidecar 先例，webview 做不了）；
凭证（OAuth token、header）留在 Rust + Keychain，不进 webview 内存与 localStorage；
reqwest/tokio 齐备，rmcp 的两种客户端传输（`TokioChildProcess` / HTTP client）正好
覆盖。M0 spike 先验证 rmcp 版本与本仓库 tokio 1.x 的兼容性。

服务器配置（名称/传输类型/url 或 command/args/启用状态）存 localStorage（沿用插件
state 模式）；**一切凭证存 vault**（`secure_update_vault_entry`，键约定
`mcp:<serverId>:header:<name>` / `mcp:<serverId>:env:<name>` / `mcp:<serverId>:oauth`）。

## 4. 侧边栏挂载（本需求的核心）

### 4.1 入口来源（三级降级，照 openai/mcp-extensions 语义）

1. **entrypoints**：读取 `tools/list` 与 initialize 结果里的
   `_meta["openai/ui"].entrypoints`（type `global`/`thread`，≤3 个），
   每个入口 = 一个侧边栏项（title/thumbnail 按
   `_meta["openai/title"|"openai/thumbnail"]` → annotations.title → name 取）。
2. **无 entrypoints 的 MCP 服务器**：每服务器给一个默认项（服务器名 + Plug 图标），
   打开通用面板。
3. **未连接但已配置**：不显示，或折叠进「MCP 服务器」设置入口的角标。

### 4.2 接线方式（复用插件系统既有形状，不另起炉灶）

- registry 增加收集函数 `getSidebarItems()`（对照 `getSettingsSections()` 的成熟
  模式，`registry.ts:55-69`），返回 `McpSidebarItem { key, label, icon, path }`。
- `LynseSidebar` 在 `topItems` 与 `bottomItems` 之间插入动态区（图标 20×20、
  `currentColor`，与 rail 现有规格一致；超出 N 个折叠为「更多」）。
- 路由走既有字符串 path 机制：`/mcp-app/<serverId>[/<entrypointId>]`，
  `apps/tauri/src/App.tsx` 的 PageRouter 增加对应分支（web 端本期不做，类型留在
  packages/views 保证共享层无 tauri 依赖）。

### 4.3 McpAppPage 的两级渲染

- **Tier B 通用面板（M1 先做）**：工具列表 + 按 `inputSchema` 自动生成表单 +
  执行结果（structured content / ResourceLink 渲染复用附件组件）+ 资源浏览。
  这是所有标准 MCP 服务器的兜底体验，Gmail 类服务器即使无 openai 扩展也可用。
- **Tier A MCP Apps（M2）**：工具/资源 `_meta["ui"]` 指向的 HTML resource 渲染进
  sandboxed iframe（先例：`chat-attachments.tsx` 的 `sandbox` iframe，但需升级为
  per-server 隔离 + `allow-scripts`），宿主实现 postMessage JSON-RPC 桥
  （MCP Apps 草案的 `ui/*` 请求/通知：宿主上下文、尺寸、工具调用代理、遥测）。
  工具调用代理必须过 §7 的同意模型。

## 5. 连接与凭证

- **远程 Streamable HTTP**（Gmail 类远程服务器为主流）：url + header 凭证。
- **本地 stdio**：command + args + env 注入（凭证从 vault 读取后注入环境，
  不落盘、不进 webview）；子进程生命周期跟随连接状态机，退出码/崩溃进事件流。
- **授权**：M1 手动录入（API key / token 贴入 vault）——对个人本地宿主足够务实；
  M2 实现 MCP 授权规范的 OAuth 2.1 授权码流（含 protected resource metadata 发现），
  Gmail 类 OAuth 服务器届时一键授权。
- 健壮性：连接超时/重试退避、协议版本协商失败降级提示、服务器工具列表变化事件
  驱动侧边栏刷新。

## 6. 模型/助手集成（独立阶段，不阻塞 UI）

| 阶段 | 内容 | 说明 |
| --- | --- | --- |
| M1（本草案主体） | 纯 UI 挂载，用户手动操作 app | 与 AI 助手零耦合，先交付「侧边栏有它」 |
| M2 | **远程** MCP 服务器的工具进 lynclaw：lynclaw 服务端增加 MCP 客户端连接管理（独立于桌面端的连接与凭证），工具注册进 agent 工具循环；桌面端 `ToolActivity` 的 `/mcp/i` 分类已可展示 | 服务器侧执行，架构最顺；桌面配置不自动同步（凭证归属不同） |
| M3（暂缓） | 本地 stdio 工具进模型 | 与 poll-only 服务端工具循环冲突：要么桌面自建本地 agent 循环（对应 OpenAgentCore 评估线），要么反向桥接（桌面作为 MCP server 暴露给 lynclaw，CloudRun→localhost 不可达，需额外隧道，暂不可行）。**明确挂起，待产品定义「本地工具给 AI 用」的真实需求后再立项** |

## 7. 安全边界（第三方代码首次进 app，运行时强制不可省）

1. **服务器级开关即权限**：每个 MCP 服务器默认禁用，添加 + 显式启用后才有 IPC 能力；
   工具调用一律经 Rust 层（webview 不能直连服务器），Rust 层校验 serverId 已启用。
2. **Tier A 的工具调用同意**：MCP Apps iframe 内发起的 tool call 默认需用户逐服务器
   授权（「允许此应用代你调用工具」一次性同意 + 每次调用在宿主侧显示活动条）；
   禁止 iframe 直接携带凭证（凭证只在 Rust 层）。
3. **iframe 沙箱**：`sandbox="allow-scripts"`（不给 allow-same-origin）、
   per-server 独立 origin 隔离策略、referrer 禁发；MCP Apps 的 CSP 要求按其规范配置。
   同时把「主应用 CSP 为 null」列为独立待办——MCP Apps 上线前至少要给 iframe 场景
   定下最小 CSP。
4. **凭证**：全部入 vault keychain；日志脱敏（沿用 `mask_token_for_log` 思路）；
   debug 构建的 `secrets.dev.json` 路径同样约定 `mcp:` 前缀键。
5. **stdio 隔离**：不做 shell 拼接（args 数组直传）；env 仅注入白名单键。
6. 权限声明对齐插件 PRD 的 permissions 清单，M1 起就要求服务器声明
   （`tools` 摘要 + 资源范围），并在设置页展示——为「运行时强制」补上事实依据。

## 8. 实施计划

**M0（spike，1-2 天）**：rmcp 引入验证（两种传输、与 tokio 1.x 兼容、二进制体积
增量）；用一个最小 echo MCP 服务器跑通 stdio + HTTP 双链路。

**M1（MVP）**：Rust 客户端核心 + IPC commands + 事件；设置页「MCP 服务器」section
（手动添加/凭证录入/启停/状态）；LynseSidebar 动态区接线（registry 收集函数 +
降级规则 4.1）；McpAppPage Tier B 通用面板。e2e：接入一个真实远程 MCP 服务器
（Gmail 类社区实现）+ 一个本地 stdio 测试服务器，全流程手测。
验证：`cargo check`（Rust）、`tsc --noEmit`（TS）、Vitest 新增 registry/侧边栏
映射单测；遵循「web 端不引入 tauri 依赖」的包边界。

**M2**：Tier A MCP Apps iframe + postMessage 桥；entrypoints/title/thumbnail 解析
（openai/mcp-extensions Phase 1 语义）；OAuth 2.1；工具调用同意模型；
Gmail 全流程（授权 → 侧边栏入口 → 读邮件）。

**M3（暂缓项单列）**：composer @提及（`mentions/search`）、扩展表单
（`openai/elicitation` 超集）、模型侧集成（§6 M2/M3）、lynse:// 深链。

## 9. 开放问题

1. 桌面端与 lynclaw 各自维护 MCP 连接（M2 起），配置是否要在桌面端做「同步到
   lynclaw」的引导（凭证不同步，仅同步服务器清单）？
2. MCP Apps UI 与现有插件 `ComponentType` 贡献的长期关系：iframe 化是否会取代
   进程内插件组件（倾向：并存，安全等级不同）。
3. 侧边栏容量与信息架构：MCP Apps 区与现有 6 个主导航项的排布、折叠策略。
4. rmcp 熟度与 mcp-extensions 草案版本的追平节奏——M0 spike 结论回填本文档。
