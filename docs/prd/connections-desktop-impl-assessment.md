# Lynse Desktop「Connections」落地评估

| 项 | 内容 |
|---|---|
| 版本 | v1.0 |
| 日期 | 2026-10-02 |
| 依据 | [connections-prd.md](./connections-prd.md) v1.0 |
| 范围 | lynse-desktop 桌面端（后端仅列依赖，不在本评估内展开） |

## 一、总体结论

**可行性高，桌面端 P0 零新增 Tauri 插件，约 70% 地基现成。** 四大现有范式直接复用：

1. WorkBuddy OAuth 三段式（authorize URL→系统浏览器→轮询，`packages/core/auth/workbuddy.ts`，refresh token 不落客户端）
2. SettingsSection 分区注册（`packages/views/settings/settings-dialog.tsx`）
3. chat insert 三态按钮模式（`packages/views/chat/page.tsx:580-614`：目标校验→mutate→toast 带目标名）
4. sonner toast + `DeleteConfirmDialog`（`packages/views/workspace/delete-confirm-dialog.tsx:30-64`）/ shadcn AlertDialog destructive（`bots/channel-card-shell.tsx:147-159`）

后端 integrations 服务是硬依赖（PRD R4），前端可按 PRD §6.5 合同 mock 先行、与后端并行。

**⚠️ PRD 事实修正（本评估最重要的发现）**：PRD FR-1 写"录音元数据写 calendar_event_id（`local_recordings.calendar_event_id` 字段已存在）"——该字段是 **Pocket 的本地数据库**结构（调研对象的 pocket.db），**不是 Lynse 的**。Lynse 的录音/笔记（workspace `FileDetail`、`content-panel.tsx`）没有任何日程关联字段；日程概念目前只挂在 TodoItem 上（`todo-api.ts:39` calendarEventId，由 macOS 系统日历 `todo_add_to_calendar` 写入回填）。因此 FR-1 消费闭环的"笔记挂日程"需要新建链路，建议走**云端 file 元数据扩展**（`calendar_event_id`/`meeting_title`），而非本地表。

## 二、逐 FR 桌面端落点

### FR-1 日历连接（P0 Google）

- **UI 落点**：`settings-dialog.tsx` 的 sections 数组 push 一段 `connections` 分区；新建 `packages/views/settings/connections/` 目录（PRD §4 组件清单成立）；i18n 5 个 locale 文件加 `connections:` 命名空间。
- **OAuth**：P0 完全照抄 WorkBuddy 范式（后端中转 + 轮询，零桌面改动；`openExternalUrl` 在 `packages/views/app-update.ts:136-141`）。P1 才引深链：`tauri-plugin-deep-link` 依赖 + Info.plist `CFBundleURLTypes`（scheme `lynse`，identifier 保持 `com.lynse.sparknote` 不动，不断 TestFlight 签名链）+ capabilities 权限 + `tauri-bridge.ts` 新增 `onDeepLink(cb)`（沿用 tray-action 的 pending 队列解决冷启动早于 React 挂载，`tauri-bridge.ts:272-275` 先例）+ single-instance argv 兜底。
- **会前提醒（Notify）缺口**：桌面端**没有系统通知能力**——Cargo.toml 无 `tauri-plugin-notification`，前端零使用；现状只有托盘菜单 + 应用内 toast。P1 需新增 notification 插件 + 提醒 agent。
- **与现有 meeting_detector 的关系**：现有检测器是"音频进程轮询"（每 3s 扫正在收发音的 App，`apps/tauri/src-tauri/src/meeting_detector/mod.rs:24`，白名单含腾讯会议/飞书/钉钉/Zoom），日历是**互补信号源**而非替换——日历提供"会前 N 分钟"时间维度，detector 提供"会议真的在发生"确认。整合点：`MeetingAutoRecordAgent`（`packages/views/live-translation/meeting-auto-record-agent.tsx:33-161`，挂载于 `App.tsx:211`）的 `decideAutoRecordAction`（`meeting-auto-record.ts:220-238`）增加日历事件作为触发源；新增配置项照 `lynse_auto_record_config` 的 localStorage + 即时推 Rust 模式（`meeting-auto-record.ts:11,131-139`），非 zustand。
- **笔记↔日程关联**：需新建（见 §一修正）。建议云端 `file` 元数据加 `calendar_event_id`/`meeting_title`，前端 `content-panel.tsx` 头部（现仅标题+createdAt，`:969-1017`）加日程 pill。

### FR-2 行动项导出（P0 Todoist）

- **关键事实**：Lynse 的行动项 = TodoItem（`packages/views/todo/todo-api.ts:28-46`），双源合并（云端 `/api/business/file/todo/*` + 本地 Rust store `"local-todos"`，`todo-api.ts` 顶部注释与 `fetchTodos:245-280`）。**本地 todo 没有云端 id**——后端 export 合同的 `action_item_ids` 只能指向云端 todo，P0 导出范围先限云端来源（`backend: true`），UI 上本地条目置灰提示。
- **UI 缺口**：todo 页（`packages/views/todo/page.tsx:525` 起）**没有多选 UI**（现在只有单选详情 Sheet + "清除已完成"批量）。需新建多选模式；数据层批量参照 `clearCompleted`（`use-todos.ts:217-259`）。
- **UI 模式**：照抄 chat insert 的"目标选择 + pending/success/error 三态按钮 + toast 带目标名"（`chat/page.tsx:580-614`）。

### FR-3 Notion 总结导出

- **现成先例**：`pushMeetingSummaryToFeishu`（`packages/views/feishu/feishu-push.ts:33`）已经是"把最新 conclusion 推给第三方"，UI 入口与结论取数（`file-conclusions` query）直接复用，把"推飞书"扩成"导出到 Notion/飞书表格"即可。

### FR-4 记忆导入（P2）

- 前端 `memory-import-dialog.tsx` 纯新组件（prompt 展示/复制/打开 ChatGPT/粘贴回填/保存）。
- 画像消费注入点在 AI 助手链路——注意助手走 agent base（lynclaw，`lynse_agent_api_url`），注入位置需与 lynclaw 服务端约定（前端 system prompt 注入 vs 服务端取画像），P2 设计时拍板。

### FR-5 MCP server（P3）

- 主体在服务端（与 lynclaw MCP 服务端草案合流，见 [[mcp-two-direction-designs]] 方向一）。
- 桌面端仅"API key 管理"UI（新建），可放设置独立卡片，参照 agent-server-card 模式。

## 三、新建 vs 复用清单

| 项 | 状态 |
|---|---|
| OAuth 三段式 + 轮询回调 | ✅ 复用 WorkBuddy 范式（P0 零桌面改动） |
| 设置分区 + 行组件/开关/确认弹窗/toast | ✅ 复用（SettingsSection / DeleteConfirmDialog / sonner） |
| 导出三态按钮 + 目标选择 | ✅ 复用 chat insert 模式 |
| 第三方结论推送先例 | ✅ 复用 feishu-push 模式 |
| `packages/core/integrations/` 模块 + `["connections"]` query 域 | 🆕 新建（staleTime 60s，不进 query-persistence 白名单） |
| `packages/views/settings/connections/` 六组件 | 🆕 新建 |
| todo 页多选 UI | 🆕 新建 |
| 录音↔日程关联（云端元数据 + 详情页 pill） | 🆕 新建 |
| 系统通知（会前提醒） | 🆕 P1：tauri-plugin-notification |
| 深链回调（lynse://） | 🆕 P1：tauri-plugin-deep-link + Info.plist + bridge onDeepLink |

## 四、工作量估算（前端 1 人，含联调）

| 阶段 | 明细 | 合计 |
|---|---|---|
| P0 | integrations 模块+mock 合同 1.5d；设置分区骨架+供应商行 3d；OAuth 轮询接通 2d；日历多账号+Sync/Notify 2d；Notion 默认库 1.5d；Todoist 多选+导出 3d；i18n+埋点 1.5d | **约 2.5 周** |
| P1 | deep-link 3d；notification+会前提醒 agent 4d；供应商扩展 5×1d；auto-export 开关 1d；飞书/钉钉适配 4d | **约 3 周** |
| P2 | memory-import-dialog 2d；画像设置卡 1.5d；注入链路 2d | **约 1.5 周** |
| P3 | API key 页 2d | 2d（服务端另计） |

## 五、关键风险与决策点

1. **后端合同先行**：五件套端点 + integrations 表（PRD §6.5）是 P0 前置，建议先冻结合同再写前端；mock 期间用 `RequestOptions.baseUrl`（`packages/core/api/client.ts:6-12`）可切 mock 服务。
2. **本地 todo 导不出**（无云端 id）：P0 明确只支持云端 todo，UI 上本地条目置灰提示。
3. **PRD 修正项**：FR-1 的 calendar_event_id 落点改为云端 file 元数据（本评估 §一/§二）。
4. **门控字段语义**：`benefitType/memberLevel` 值域需后端确认才能写死免费/付费矩阵（PRD §6.4）。
5. **P1 深链时序**：pending 队列 + single-instance argv 兜底已在方案内；identifier 不动，TestFlight 签名链不受影响。
6. **Google/Microsoft OAuth 审核**周期长，后端/client_id 申请需 P0 第一天就启动（PRD R1）。
