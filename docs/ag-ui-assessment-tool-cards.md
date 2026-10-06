# AG-UI 协议评估与工具卡片路线

> 调研日期：2026-10-02。结论先行：**桌面端不接入 AG-UI，改走自建工具卡片注册表（toolCardRegistry）**。
> AG-UI 的收益全部是"未来时"（多后端互操作），而"加很多卡片"不需要它；本文同时把 AG-UI 接入方案留档，
> 将来要接第二个 agent 后端时可直接复用。

## 1. 背景

两个问题触发了这次调研：

1. 学习 CopilotKit/openmuse（CopilotKit 官方个人 agent 模板）中 AG-UI 的设计理念；
2. 产品诉求：聊天回复里能不能加很多"卡片"（比如天气卡）——"接入 AG-UI 是不是就能加卡片？"

调研范围：AG-UI 官方协议仓库（ag-ui-protocol/ag-ui）与文档、openmuse 源码（克隆于 /tmp/openmuse-study，临时目录），
以及桌面端聊天栈全量摸底。

## 2. AG-UI 协议是什么

AG-UI（Agent-User Interaction Protocol）是 CopilotKit 主导的开放协议（MIT），核心抽象只有一行：

```ts
run(input: RunAgentInput): Observable<BaseEvent>
```

一次 agent 运行 = 一个类型化事件流。主要事件族（以官方 docs.ag-ui.com/concepts/events 为准，约 16+ 种）：

| 事件族 | 事件 | 说明 |
|---|---|---|
| 生命周期 | `RunStarted` / `RunFinished`（含 interrupt/resume 语义）/ `RunError` | 必发首尾事件 |
| 文本 | `TextMessageStart/Content/End`、`TextMessageChunk`（便捷三元组） | 流式文本 |
| 工具 | `ToolCallStart/Args/End/Result`、`ToolCallChunk` | 工具调用全过程，Result 一次性带回完整结果 |
| 状态 | `StateSnapshot` / `StateDelta`（RFC 6902 JSON Patch）/ `MessagesSnapshot` | 双向状态同步 |
| 推理 | `ReasoningStart/End`、`ReasoningMessage*`（取代已弃用的 THINKING_*） | 思维链流式 |
| 扩展 | `Custom{name, value}`、`Raw` | 应用自定义事件的协议内扩展点 |
| 其他 | `StepStarted/Finished`、`ActivitySnapshot/Delta`、Subagent 族 | 步骤边界/结构化活动/子代理 |

关键特性：**传输无关**（SSE、WebSocket、webhook 均可，SSE 只是参考实现）、宽松格式匹配、
互补定位（MCP 管工具、A2A 管智能体间、AG-UI 管智能体到 UI）。

**一个关键澄清：AG-UI 协议里没有"卡片"概念。** 它只有 `ToolCall*` 事件；卡片是渲染层自己的
"工具名 → 渲染组件"注册表（openmuse 里的 `useRenderToolCall` 是 CopilotKit 的 hook，也不属于协议）。
协议甚至不要求事件流必须流式——所以"接了 AG-UI 就能加卡片"是误解。

## 3. 桌面端聊天栈现状（2026-10-02 摸底）

### 3.1 传输：poll 契约，唯一接缝

- 聊天走 lynclaw poll 标准：`POST /api/chat/poll` 提交 → `GET /api/chat/poll/{task_id}` 短轮询
  （前 12s 500ms、之后 800ms，deadline 190s），见 `packages/views/workspace/chat-transport.ts:36-96`。
- **lynclaw 本来就有原生 SSE 端点** `/api/chat/stream`（`chat-transport.ts:43-46` 常量），但
  **"always poll" 是测试钉死的契约**（`chat-transport.test.ts:889,902,925`），客户端那套完整且已测试的
  `StreamChatTransport` / `parseChatStreamData`（`chat-transport.ts:800-909`）刻意未上线。
- 整个栈只有**一个事件接缝**：`SendChatOptions.onEvent(ChatStreamEvent)` 单回调（`chat-transport.ts:11-33`），
  store 的 `handleEvent`（`use-chat-store.ts:375-560`）消费。`ChatStreamEvent` 联合类型见
  `packages/views/workspace/types.ts:400-422`。

### 3.2 已经存在的"卡片"

| 卡片 | 数据来源 | 渲染 |
|---|---|---|
| 工具活动行（icon+工具名+running/done） | poll `progress_events[]`（`tool` 名、`result_summary`、`duration_ms`、`success`） | `packages/views/chat/chat-reasoning.tsx` |
| 附件/图片卡（过期 URL 懒重签） | `attachments[]` | `packages/views/chat/chat-attachments.tsx` |
| 结构化确认卡 | `confirmation` → `normalizePollConfirmation()`（含纯文本兜底 `extractConfirmFromText`） | `ConfirmDialog` |
| 来源徽章（跳转笔记） | `sources[]` | `page.tsx` SourcesBadge |
| 人工支持按钮 / 思维链块 | `humanSupportLink` / `thinking` | 同上 |

结论：**"工具产出 → 结构化数据 → 专用渲染器"这条卡片链路已经存在且工作正常**，缺的只是
（a）按工具名分发的注册表，（b）后端在 payload 里带更丰富的结构化工具数据。

### 3.3 其他关键事实

- 聊天表面：主聊天页（`packages/views/chat/page.tsx`）、笔记页 AI 面板
  （`packages/views/workspace/right-panel/chat-panel.tsx`）、Feishu bot（`packages/views/bots/bot-agent.tsx`
  直用 `PollChatTransport`，绕过 store）。WorkBuddy 是独立服务（workbuddy.cn OpenAPI + Rust relay + 服务端线程），不走 lynclaw。
- 历史持久化：localStorage 存归一化 `ChatMessage`（`chat-history.ts`），不含 poll 原始 payload。
- 并发：`MAX_CONCURRENT_CHATS=3`；后台切换回前台有 poll 唤醒机制（`chat-transport.ts:442-477`）。
- Rust 侧不参与聊天链路（WorkBuddy relay 除外）。

## 4. 收益评估

### 4.1 AG-UI 的真收益（全部"未来时"）

| 收益 | 触发条件 |
|---|---|
| 多后端即插即用：现在客户端硬编码 lynclaw poll + workbuddy 两套私有契约，每接一个新后端写一套传输+映射；AG-UI 客户端层落地后，接兼容后端 ≈ 换个 URL | 未来接 CloudBase agent-server（原生实现了 AG-UI）、LangGraph/Mastra 等，或 lynclaw 对外开放 |
| HITL 标准化：confirm 卡从自研 Custom 事件升级为协议级 interrupt/resume | 同上，且后端须说 AG-UI |
| 协议规范兜底：事件语义有官方 spec，自研事件集不漂移 | 任何时候，价值最弱 |

### 4.2 成本（全部"现在时"）

- store `handleEvent` 重写（375-560 行）+ `use-chat-store.test.ts` 等 14+ 测试文件改造；
- 事件映射表（ChatStreamEvent ↔ BaseEvent）的长期维护；
- 对"只有一个真后端（lynclaw）"的现状，用户可见价值 ≈ 0。

### 4.3 结论

**加卡片不需要 AG-UI。** 卡片的真实前置条件是：
1. 后端在 payload 里带结构化工具数据（`progress_events[]` 现已带 `tool` 名 + `result_summary`）；
2. 前端一个按工具名分发的渲染注册表。

两者都不依赖 AG-UI。AG-UI 的 `ToolCallArgs` 流式参数只是让卡片"边跑边填"更顺，前提是后端流式——
poll 契约下没有这个通道（已拍板保持 poll）。

## 5. 决策记录（2026-10-02）

1. 范围讨论中曾倾向"分阶段先客户端"接 AG-UI；在澄清"卡片 ≠ AG-UI"后最终拍板：
   **只要卡片，不接 AG-UI；传输保持 poll，不启用 stream 真流式。**
2. AG-UI 接入方案留档于本文 §7，触发条件：要接 CloudBase agent-server / LangGraph / 第三方 AG-UI agent。
3. toolCardRegistry 实施计划见 §6，待排期执行。

## 6. 路径 A：toolCardRegistry 实施计划（待执行）

**目标**：把"加一张工具卡片"变成注册一个组件的事。

**设计**：

- **注册表**（新 `packages/views/chat/tool-card-registry.tsx`）：
  条目 `{ match: string | RegExp, Card: ComponentType<ToolCardProps> }`；
  解析顺序精确名 → 正则 → 回退现有 `ToolActivity` 通用行（未注册工具 UI 与今天完全一致）；
  `ToolCardSlot` 组件供主聊天页与笔记页 AI 面板共用。
- **数据通道扩展（容忍缺失）**：`ChatToolUse`（`types.ts:261-267`）加可选 `args?: Record<string, unknown>`、
  `result?: unknown`；`emitProgressEvents()`（`chat-transport.ts:708-727`）对 `tool_start` 的 `args`/`arguments`
  与 `tool_end` 的结构化 `result` 做透传（现在后端没有这些字段，透传无感；字段上线前端零改动）；
  store 的 tool 分支在 `tool_end` 时回填 `result`。
- **首批卡片**：
  - 通用工具结果卡（fallback 增强）：工具名/服务端文案 + `result_summary` + 耗时 + 成败态，立即提升观感；
  - 天气卡骨架（`tool-cards/weather-card.tsx`）：注册 `weather|get_weather|天气`；有结构化 result 渲染
    城市/温度/预报，无数据渲染优雅空态。shadcn token + i18n。

**文件清单**：

| 操作 | 文件 |
|---|---|
| 新增 | `packages/views/chat/tool-card-registry.tsx` |
| 新增 | `packages/views/chat/tool-cards/weather-card.tsx`、`tool-cards/generic-tool-card.tsx` |
| 修改 | `packages/views/workspace/types.ts`（ChatToolUse +args/result） |
| 修改 | `packages/views/workspace/chat-transport.ts`（emitProgressEvents 容忍透传） |
| 修改 | `packages/views/workspace/hooks/use-chat-store.ts`（tool_end 回填 result） |
| 修改 | `packages/views/chat/chat-reasoning.tsx`、`packages/views/chat/page.tsx`、`packages/views/workspace/right-panel/chat-panel.tsx` |
| i18n | 相关 locale 文件 |

**测试与验证**：注册表匹配单测；transport 透传单测（带/不带 args·result 两种 fixture，后者行为与今天逐字节一致）；
weather-card 两态渲染测试；既有 930 行 transport 测试与 e2e 全绿；e2e fixture 加一个带 args/result 的工具回合
（`e2e/fixtures/chat-script.ts` + mock-server）；`pnpm test` + `pnpm typecheck` + 手工冒烟。

## 7. 路径 B：AG-UI 事件总线方案（留档备用）

若将来接第二个 agent 后端，按此方案把接缝词汇表从自研 `ChatStreamEvent` 换成 AG-UI `BaseEvent`：

```
现在:  PollChatTransport ──ChatStreamEvent──► use-chat-store.handleEvent
之后:  PollAgent(包 PollChatTransport) ──AG-UI BaseEvent──► use-chat-store.handleEvent
```

- 依赖仅 `@ag-ui/core`（纯类型，零运行时增量；`@ag-ui/client`+rxjs 留到真用 HttpAgent 时再引入）。
- 不采纳 AbstractAgent 作为消息状态宿主（store 已拥有状态，避免双份真源；OpenMuse 式 headless 仅在多后端并存时再评估）。

**事件映射表**（实施时以所装 `@ag-ui/core` 版本枚举为准，单测锁定）：

| 现有 ChatStreamEvent | AG-UI BaseEvent |
|---|---|
| 提交成功（task_id） | `RunStarted{threadId=sessionId, runId}` |
| `status`（阶段文案） | `StepStarted/StepFinished{stepName}` |
| `content` delta | `TextMessageStart→Content→End`（适配器合成 messageId，打字机 cadence 原样透传） |
| `thinking` delta（空 delta 收尾） | `ReasoningMessageChunk`（空 delta 关闭） |
| `tool`（name/id/state） | `ToolCallStart/End`；done 时补 `ToolCallResult{content=result_summary}` |
| `meta`（sources/attachments） | `Custom{name:"meta", value}` |
| `done` | 末消息 `TextMessageEnd` + `RunFinished` |
| `error` | `RunError{message}` |
| `confirm` | `Custom{name:"confirm"}`（后端说 AG-UI 时升级为 client-tool interrupt/resume） |
| `workbuddy_seen` | `Custom{name:"workbuddy_seen"}` |

**分阶段**：P1 客户端事件总线（零后端改动，wire 契约不变，always-poll 测试保持全绿）→
P2 工具卡片注册表（同 §6）→ P3 服务端 AG-UI 端点（lynclaw-main 加 `/ag-ui` SSE 端点，
desktop route-B 切 `HttpAgent`，gateway route A 保持 poll 回退）。

## 8. 给 lynclaw 后端的契约扩展需求（配合路径 A）

1. `progress_events[]` 的 `tool_start` 事件可选携带 `args`（对象，工具入参）；
2. `tool_end` 事件可选携带结构化 `result`（对象而非仅 `result_summary` 字符串）；
3. 天气类工具命名约定（如 `get_weather`），result 建议 `{city, temp, condition, forecast[]}` 形状；
4. 以上全部为可选字段，老客户端不受影响。

字段上线后，前端注册表中的天气卡即自动点亮，无需再改前端代码。
