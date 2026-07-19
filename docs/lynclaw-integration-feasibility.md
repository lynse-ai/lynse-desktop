# lynclaw 集成到 lynse-desktop AI 助手——可行性与实施计划

> 分析日期：2026-07-17  
> 目标：把 `/Users/lynse/Documents/lynclaw`（本地多智能体系统）接入 lynse-desktop 右侧 AI 助手（ChatPanel），复用会议搜索、报告、待办、可视化卡片、记忆和受控写操作等能力。

## 结论

**可以集成，推荐采用“由 Tauri 管理的常驻 lynclaw HTTP sidecar”，而不是每条消息启动一次 `lynclaw_agent.py ask` 子进程。**

lynclaw 已经提供 `/api/chat` 和 `/api/chat/stream`，并具备 `session_id`、`user_id`、指定会议、进度事件、附件、多轮记忆和写操作确认状态等能力。直接复用这一层，比无状态 CLI 更接近完整产品能力，也能避免重复实现会话和确认桥。**Chatbot 必须支持端到端真流式输出，不能在完整答案生成后再切片伪装流式。**

已确定的产品决策：

1. **LLM 采用 BYOK（用户自带 API Key）**：在桌面端设置中提供模型和 API Key 配置。
2. **会话级选择助手**：新会话显式选择云端助手或 LynClaw 本地助手；同一会话不按关键词来回切换。
3. **先查询、后生成、最后写入**：先上线不修改 Lynse 业务数据的能力，再增加报告/卡片，最后开放需要确认的写操作。
4. **正式版本交付独立 sidecar 运行时**：不直接复制开发机 venv，也不要求普通用户预装 Python。
5. **流式输出是硬性要求**：模型产生的文本 delta 要实时经过 lynclaw、SSE、Rust IPC Channel 到达 ChatPanel；`done` 只负责结束和元数据收口。

如果只需要快速验证链路，可以先用一次性 CLI 做 smoke test；该方式不作为正式架构继续扩展。

---

## 两端现状

### lynclaw

- Python 3.10+，基于 OpenAI Agents SDK 和 LiteLLM。
- 现有 CLI 入口：`tools/lynclaw_agent.py`。
- 非交互命令：`ask`、`search`、`weekly`、`visual`、`patch`，结果以 JSON 输出。
- 非交互 CLI 每次都是独立运行，默认不携带桌面会话的完整历史，不适合直接承载多轮聊天和跨轮确认。
- 已有 HTTP API：`runtime/api_server.py`。
  - `POST /api/chat`
  - `POST /api/chat/stream`
  - 请求支持 `query`、`session_id`、`user_id`、`file_ids`、`user_specified_file` 和 Lynse access token。
  - 响应支持正文、sources、报告/图片附件和人工支持链接。
  - SSE 支持 `round_start`、`content`、`meta`、`done`、`error` 等事件。
- **现有正文输出仍不是真流式**：当前实现主要在 Agent 完成后将完整正文切块发送；进度事件可以提前到达，但用户回答的文本 token/delta 没有从模型实时透传。正式接入前必须改造这一点。
- `runtime/http_chat.py` 已处理多轮历史、磁盘记忆、待确认状态、指定会议、报告/卡片附件和受控写操作。
- 本地推理需要模型、Base URL 和 API Key；默认配置使用 DeepSeek，也可接 OpenAI-compatible 服务。

### lynse-desktop

- UI：`packages/views/workspace/right-panel/chat-panel.tsx`。
- 聊天状态：`packages/views/workspace/hooks/use-chat.ts`。
- 当前云端路径：`/api/business/ai/chat/stream`。
- Tauri 桥：`apps/tauri/src/tauri-bridge.ts`。
- Rust 命令：`apps/tauri/src-tauri/src/lib.rs`。
- 设置入口：`packages/views/settings/settings-dialog.tsx`。
- 当前 ChatPanel 只渲染纯文本，尚未支持 sources、图片、PDF 附件和结构化确认卡片。
- 当前 `useChat` 需要先修正：
  - `seesionId` 拼写错误；
  - 通过“内容短时间不变化”猜测流结束；
  - 缺少 typed SSE 事件处理；
  - 选中文件只传 ID，没有明确的 `user_specified_file` 语义。

---

## 推荐架构

```text
ChatPanel
   │
   │ 新会话选择：Cloud / LynClaw Local
   ▼
ChatTransport（会话期间固定）
   ├─ CloudChatTransport
   │     └─ /api/business/ai/chat/stream
   │
   └─ LocalLynclawTransport
         └─ desktopAPI.ai / Tauri IPC Channel
                ▼
           Rust LynclawSupervisor
           - 启动、健康检查、重启、退出清理
           - loopback 随机端口与临时 bearer secret
           - Keychain 读取 LLM Key
           - 实时转发并解析 SSE delta
                ▼
           lynclaw HTTP sidecar
           - /api/chat/stream
           - true streaming / session / memory
           - confirmation / attachments
```

### 为什么不在前端做关键词路由

“会议”“周报”“卡片”等关键词无法覆盖“第二个呢”“改成上周”“就按这个生成”等追问。如果同一个会话在云端与本地之间切换，两边会各自只拥有一部分上下文。

第一版采用会话级显式模式：

- 新建会话时选择“云端助手”或“LynClaw 本地助手”。
- 选定后该会话始终使用同一个 transport。
- 本地助手没有配置或启动失败时，明确提示用户处理，不静默把会议内容转发到云端。
- 将来确实需要自动路由时，应在统一 Agent/服务层完成，并保证完整上下文只有一个权威来源。

---

## LLM 设置与鉴权（已确定）

### 设置项

在 `packages/views/settings/settings-dialog.tsx` 增加“本地 AI 模型”区域：

1. **模型服务商**
   - DeepSeek（预设）
   - OpenAI-compatible / 自定义
2. **模型**
   - 服务商预设模型下拉选择；
   - 自定义服务允许手动填写模型名。
3. **Base URL**
   - 预设服务自动填写；
   - 自定义服务可编辑，放在高级设置中。
4. **API Key**
   - 密码输入框；
   - 保存后只显示掩码和“已配置”状态；
   - 支持更新和删除，但不能从前端重新读取明文。
5. **测试连接**
   - 使用当前模型、Base URL 和 Key 发起最小流式请求；
   - 确认服务商实际返回增量 delta，而不是只在结束时返回完整正文；
   - 分别提示无效 Key、模型不存在、Base URL 不可达和超时；
   - 连接和流式能力都验证成功后才允许启用本地助手。

建议的设置数据结构：

```ts
type LocalLlmSettings = {
  provider: "deepseek" | "openai-compatible";
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  maskedApiKey?: string;
};
```

API Key 不出现在读取模型中；保存请求可单独携带新的 Key。

### 凭据保存与注入

- **LLM API Key**：通过 Rust 保存到 macOS Keychain；不存 localStorage、普通 JSON、日志或 app resources。
- **普通设置**：provider、model、baseUrl 可保存到 Tauri app config/app data。
- **Lynse 鉴权**：沿用桌面端当前短期 access token，通过每次本地聊天请求传给 lynclaw；不向 sidecar 暴露长期 `LYNSE_API_KEY`。
- **sidecar 注入**：Rust 启动 sidecar 时读取 Keychain，并注入模型相关环境变量；前端永远不需要获得 LLM Key 明文。
- **日志**：Rust、Python 和前端日志都不得打印 Key、Authorization、完整 access token 或带凭据的请求体。

建议新增的 Tauri 能力：

- `llm_settings_get`：返回普通设置、`hasApiKey` 和掩码；
- `llm_settings_save`：保存普通设置，并按需更新 Keychain；
- `llm_settings_test`：在 Rust/sidecar 侧验证连接；
- `llm_settings_clear_key`：删除 Keychain 中的 Key；
- `lynclaw_status`：返回配置、启动和健康状态。

未来支持 Windows/Linux 时，只替换 CredentialStore 实现，不改变前端设置协议。

---

## sidecar 生命周期与安全

### Rust LynclawSupervisor

建议在 Tauri Rust 层实现一个单实例 supervisor：

- 首次进入本地助手或点击“测试连接”时懒启动；
- 启动后轮询健康检查，ready 后再接收聊天请求；
- 防止同一应用启动多个 sidecar；
- 记录 PID，应用退出时终止子进程；
- 异常退出后允许有限次数自动重启；
- 区分“配置错误、运行时缺失、端口失败、进程崩溃、模型请求失败”；
- stderr 写入受控日志，且进行敏感信息脱敏；
- 一次只允许同一会话执行一个 turn，避免会话文件并发写入。

### 本地 HTTP 安全

lynclaw HTTP API 当前开发默认值不能原样用于发行版。桌面嵌入模式要求：

- 只绑定 `127.0.0.1`，不能绑定 `0.0.0.0`；
- 使用动态空闲端口，避免固定端口冲突；
- 每次启动生成临时 bearer secret；
- Rust 持有端口和 secret，尽量不暴露给普通页面代码；
- 由 Rust 转发 SSE 到 Tauri IPC Channel，而不是让 WebView 任意访问本地端口；
- 收紧或关闭 `allow_origins=["*"]`；
- 对请求设置大小、超时和并发限制。

### 停止与取消

当前前端 `AbortController` 只能停止读取响应，不一定会停止 Python 中正在执行的 Agent。需要明确第一版语义：

- 最低要求：停止 UI 流并忽略后续结果，按钮文案避免承诺已停止计费；
- 正式要求：为 turn 分配 ID，增加 cancel 协议，使 sidecar 能取消模型流、工具执行或对应子进程；
- 报告/卡片生成阶段要清理未完成的临时文件。

---

## ChatPanel 与协议改造

### 端到端真流式要求

目标链路：

```text
LLM Provider stream=true
   → OpenAI Agents SDK streamed runner
   → lynclaw text delta
   → HTTP SSE（立即 flush）
   → Rust 增量读取
   → Tauri IPC Channel
   → ChatPanel 逐 delta 追加
```

需要改造 lynclaw 当前执行路径：

- `LynclawAgentRunner` / `openai_agents_adapter` 使用 Agents SDK streamed runner，而不是等待同步 run 完成；
- 模型每产生一个用户可见文本 delta，就立即发出 `content` SSE 事件；
- 工具调用、handoff 和报告生成期间发送独立 `status` 事件，不能把内部思考或工具参数作为回答正文展示；
- 工具完成后的最终回答继续流式输出，不能等整个 Agent turn 完成后统一切片；
- sidecar 在服务端累计最终正文，用于会话历史和记忆，但不能因此阻塞向客户端发送 delta；
- `done` 不再携带一份供 UI 追加的完整正文；可以携带最终长度、sources 和 attachments，用于一致性校验和收口；
- Rust 和前端都不得按行、固定时间窗口或完整 JSON 响应缓冲正文；
- 正确处理跨 chunk UTF-8 字符、SSE 半行、背压和中途断线；
- 客户端取消时同步取消上游模型流，停止继续生成和计费；
- 不支持流式的自定义模型端点不能通过“测试连接”，也不能启用本地 Chatbot。

“先显示思考中，结束后一次性填入答案”只能作为故障降级提示，不算完成流式输出要求。

### Transport 抽象

`packages/views` 保持共享，不直接 import Tauri API。新增统一聊天 transport 接口，由 Web 和 Tauri 平台分别提供实现：

```ts
type ChatStreamEvent =
  | { type: "status"; text: string }
  | { type: "content"; delta: string }
  | { type: "meta"; sources: string[]; attachments: ChatAttachment[] }
  | { type: "done" }
  | { type: "error"; message: string };
```

会话模型至少包含：

- `sessionId`：新会话创建时生成并从第一条消息开始传递；
- `userId`：使用当前登录用户 ID，保证记忆隔离；
- `provider`：`cloud` 或 `lynclaw-local`，会话期间不可自动切换；
- `fileIds` 和 `userSpecifiedFile`：明确是否限定当前选中会议；
- `sources`、`attachments` 和当前状态。

### SSE 处理

- 每收到一个 `content` delta 就立即追加正文并触发渲染；
- `round_start` 转为状态文案，不追加到最终回答；
- `meta` 更新 sources 和 attachments；
- `done` 明确结束 loading，不能再通过内容稳定性猜测；
- `error` 结束 loading 并保留已经收到的正文；
- 防止 `done.text` 与之前的 content chunks 重复追加。

流式实现验收：

- 使用可控 mock provider，每隔固定时间返回至少 3 个文本 delta；在 `done` 前能观察到 ChatPanel 至少 3 次渐进更新；
- provider 发出首个文本 delta 后，桌面链路不应再引入明显的人为缓冲；记录 provider、sidecar、Rust 和 UI 四个时间点用于定位延迟；
- 中文、emoji 和 Markdown 跨 chunk 时不乱码、不丢字、不重复；
- 工具执行期间显示状态，工具结束后正文继续流式追加；
- `done` 到达后最终正文与 sidecar 累计正文一致；
- 点击停止后不再出现新 delta，并确认上游模型请求已取消；
- 中途断网或模型报错时保留已显示内容，并给出可重试错误状态。

### UI 能力

第二阶段前补齐：

- Markdown 和安全链接渲染；
- sources 展示；
- 图片卡片预览；
- PDF/附件下载；
- 进度状态；
- 结构化确认卡片，包括操作摘要、影响对象、确认和取消按钮。

---

## Python 运行环境与资源交付

### 开发模式

- sidecar 代码指向 `/Users/lynse/Documents/lynclaw`；
- 优先使用该项目 `.venv/bin/python -m runtime.api_server`；
- 允许通过环境变量覆盖 Python 和项目路径；
- POC 阶段不把开发机绝对路径写进发行配置。

### 正式打包

不直接复制开发机 venv。推荐产出按目标架构构建的独立 sidecar，或者打包受控 Python runtime 与锁定依赖。

需要盘点并打包：

- `runtime/`、必要配置和知识库；
- `skills/lynse-cli`；
- 报告和可视化需要的 skills、模板、字体和静态资源；
- OpenAI Agents SDK、LiteLLM、FastAPI、uvicorn、oss2；
- 报告/卡片所需 WeasyPrint、Playwright 和 Chromium 等运行时依赖；
- arm64/x86_64 对应的原生依赖和 sidecar 文件。

代码和模板放只读 resources；以下内容必须写入 Tauri `app_data_dir`：

- 会话历史与长期记忆；
- workspace 绑定；
- 日志；
- 临时文件和生成结果；
- 模型/浏览器缓存；
- 可变配置。

发行前必须验证：

- 在没有系统 Python 的干净 macOS 上运行；
- Apple Silicon 和 Intel 架构；
- `.app` 签名、公证和 DMG 安装；
- sidecar 和 Chromium 等嵌套二进制签名；
- 安装包体积增量和第三方许可证；
- 离线、代理和网络超时行为。

---

## 能力分阶段

### 阶段 0：协议与设置 POC

范围：

- 设置页完成模型、Base URL、API Key 和测试连接；
- Keychain 保存 LLM Key；
- 手动或开发态启动现有 lynclaw HTTP API；
- 将 lynclaw 从“完成后切片”改为 Agents SDK 真流式 delta 输出；
- ChatPanel 增加显式本地助手模式；
- 走通 access token、`session_id`、端到端文本 delta、SSE `done`、取消和错误处理。

验收：

- Key 保存后重开设置页只能看到掩码；
- 无 Key、错误 Key、错误模型和不可达 Base URL 都有明确提示；
- 第一条消息即携带稳定 session ID；
- 同一会话连续追问能继承上下文；
- ChatPanel 在模型请求完成前持续收到并渲染文本 delta；
- 工具执行期间有状态事件，工具完成后回答恢复流式输出；
- 消息不会因为 `content`/`done` 重复；
- 停止操作能够取消上游流，而不只是停止 UI 显示；
- 云端助手原有路径不受影响。

### 阶段 1：不修改 Lynse 业务数据

范围：

- 自然语言问答；
- 会议搜索、详情和总结；
- 待办查询；
- 指定当前选中会议；
- sources 展示。

本阶段禁止修改、删除、移动和重命名 Lynse 数据，也不开放报告/卡片生成。

验收：

- 指定会议时答案只使用选定范围；
- 普通搜索不会被当前 UI 选中项意外限制；
- user ID 和 session ID 正确隔离记忆；
- sidecar 崩溃后 UI 能报告并恢复；
- 日志中没有 API Key 和完整 access token。

### 阶段 2：生成型能力

范围：

- 周报、月报、季报；
- 可视化卡片；
- 图片/PDF 附件；
- 下载链接刷新；
- 生成进度和失败重试。

这类能力虽然不修改会议/待办，但会生成本地文件，部分流程会上传 OSS，因此不定义为“只读”。

验收：

- 图片可预览、PDF 可下载；
- 附件与当前用户和会话关联；
- 过期下载链接可刷新；
- 失败不留下不可控临时文件；
- 应用重启后历史附件仍可识别。

### 阶段 3：受控写操作

范围：

- 发言人改名；
- 待办删除/清理；
- 会议分组和移动；
- 其他 `patch` 类操作。

要求：

- Agent 只能准备操作，不能绕过确认直接写入；
- ChatPanel 展示结构化操作摘要；
- 用户点击确认后使用原 pending context 执行；
- token 单次使用、防重放，取消后不可再次执行；
- sidecar 重启导致 token 失效时要求重新准备，不能降级为直接执行；
- 每个操作记录可审计结果，但不记录敏感凭据。

---

## 方案对比

| 方案 | 定位 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| 常驻 HTTP sidecar | 正式本地方案 | 复用 session、记忆、SSE、附件和确认逻辑 | 需要 supervisor 和运行时打包 | **推荐** |
| 每消息调用 CLI | 快速 smoke test | 改动少，便于验证基础链路 | 无状态、启动慢、难取消、确认 token 跨进程不可靠 | 仅限 POC |
| 服务端托管 lynclaw | 零本地运行时方案 | 鉴权、升级和运维统一 | 需要后端改造，不符合当前 BYOK 本地方案 | 备选 |
| TypeScript 重写 | 原生重构 | 无 Python sidecar | 工作量大，重复已有能力 | 不建议 |

---

## 实施顺序与交付物

1. **设置与协议 POC**
   - LLM 设置 UI、Keychain、测试连接；
   - Agents SDK streamed runner 与真实文本 delta；
   - LocalLynclawTransport；
   - 手动启动 HTTP API，完成真流式、取消、单轮和多轮验证。
2. **sidecar supervisor**
   - Rust 生命周期管理、健康检查、随机端口和临时 bearer；
   - Tauri IPC Channel 无缓冲转发 typed SSE delta。
3. **阶段 1 查询能力**
   - 指定会议、搜索、待办查询、sources；
   - 会话与用户隔离测试。
4. **正式运行时打包**
   - 独立 sidecar、只读 resources、可写 app data；
   - 双架构、签名、公证、体积与许可证验证。
5. **阶段 2 生成能力**
   - 报告、卡片、图片/PDF 附件及 UI。
6. **阶段 3 写操作**
   - 结构化确认、执行、取消、防重放和审计。

完成以上步骤后，lynclaw 才算从“本地开发工具”稳定转化为 lynse-desktop 的产品级本地 AI 能力。
