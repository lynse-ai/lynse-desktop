# Lynse「Connections 连接」功能 PRD

| 项 | 内容 |
|---|---|
| 版本 | v1.0（评审稿） |
| 日期 | 2026-10-02 |
| 状态 | 待排期 |
| 调研方法 | Pocket 桌面端 v0.3.129 实测 UI + 前端 bundle 逆向 + Lynse 代码库探索 |

## 0. 竞品调研结论（Pocket 桌面端 v0.3.129）

Pocket（heypocket.com，AI 会议录音硬件+App）是 Lynse 同赛道标杆。其 Connections = 设置内"集成中心"，事实如下：

**产品形态**：Tauri 壳 + 远程前端（app.heypocket.com）；后端 production.heypocketai.com；Firebase Auth（Google 登录）+ Firestore + Stripe/RevenueCat 订阅 + PostHog 埋点；深链 scheme `pocket://`；连接状态全存云端（本地 sqlite 无连接表），第三方 OAuth token（含 Google 的 access/refresh token）由后端在 exchange-code 时换取并存储在云端账号数据库，客户端不落任何密钥（本地唯一相关数据是 OAuth 流程 30 分钟 TTL 的临时 state，用于防 CSRF）。

**页面**：设置 → Connections（路由 `/app/settings/integrations`，副标题 "Manage your integrations"），左侧与 Referral/General/Profile/Team/Summary/Storage/Support/Developers 并列；Developers 下另有 API Keys + Webhooks。页面五区块：

| 区块 | 供应商 | 关键行为 |
|---|---|---|
| Import | ChatGPT Memory / Claude Memory | 弹窗给一段"导出你的记忆"prompt（三层：Core Identity(EA)/Strategic Context(Coach)/Recursive Patterns(Therapist)），一键 `chatgpt.com/?q=<prompt>` 打开（URL>2000 字则复制 prompt），用户粘贴结果 → 提交 |
| Calendar | Google Calendar、Outlook Calendar | 多账号；每账号 Sync（拉日程）+ Notify（会前提醒）两个开关 + 删除；Add 连第二账号；Disconnect 红色二次确认弹窗（"Are you sure you want to disconnect X? You can reconnect at any time."） |
| Sync | Notion(PRO)、OneDrive(PRO)、Google Drive(PRO)、Obsidian(外链社区插件 pocket-sync) | Notion 按 workspace 展示账号行 + Default database 下拉（"Choose where Pocket exports conversations"，空态提示去 Notion 分享数据库后 Refresh） |
| Task Management | Google Tasks、Todoist、TickTick（免费）；Linear、Asana、ClickUp（PRO） | 连接后：默认目标（project/list）下拉 + Auto-export 开关（"Auto-export action items after meetings"）；行动项可手动多选导出 |
| External AI | ChatGPT、Claude Connector、Cursor Tool、Littlebird(flag)、MCP | 出向开放：远程 MCP `https://public.heypocketai.com/mcp`（`Authorization: Bearer pk_…`），工具 4 个：get_pocket_conversation / search_pocket_conversations / search_pocket_conversations_timerange / search_pocket_actionitems；Claude Connector 弹窗给 Name+URL 复制 + "Open Claude"(claude.ai/customize/connectors)；Cursor 指向 cursor.com/en-US/install-mcp |

**OAuth 统一三段式**：① `GET {apiPrefix}/oauth-state?platform=desktop|web&origin=…` → `{state, client_id, scope, redirect_uri, authorization_url?}`（state 为含 provider/origin/platform 的 base64 JWT 头）；② 桌面用系统浏览器打开授权页，redirect_uri=`pocket://integration-callback`，web 域名下的 `/oauth/callback?code&state` 中转页解码 state 发现 platform=desktop 后 302 到深链；③ 桌面 Tauri `onOpenUrl`+`deep-link-received` 事件接住，pending state 存 localStorage（30min TTL），校验后 `POST {apiPrefix}/exchange-code {code,state,redirect_uri}` → toast "X connected successfully" → 状态刷新退避轮询 [0,4s,10s,20s,40s]。错误映射：503→"integration is not configured"；403 requires_pro→"X is a Pocket Pro feature"。exchange 全部由服务端执行，token 只存云端。

**API 合同**：`GET /api/v2/integrations/{provider}/status → {connected, accounts:[{id,email,display_name,workspace_name,auto_export,default_project_id|default_list_id|default_task_list_id|default_database_id,is_primary}]}`；`PUT …/auto-export {account_id,auto_export}`；`DELETE …/disconnect?account_id=`；`POST …/export {action_item_ids, default_project_id|default_list_id|default_task_list_id}`；Notion 专用 listDatabases/setDefaultDatabase；日历 `/api/v2/calendar/{google|outlook}/{status,accounts,oauth-state,exchange-code}`（Google 授权带 access_type=offline&prompt=consent；Microsoft 带 response_mode=query&prompt=select_account）；目标列表 `{todoist,asana}/projects`、`clickup/{workspaces,spaces,lists}`、`google-tasks/task-lists`。

**记忆导入背后是用户画像系统**：`GET/PUT /api/v1/users/current/user-profile`（{profile,version}）+ `/versions` 版本历史 + `POST …/import-chatgpt-memory {importedMemory}`，导入即生成新版本。

**门控**：日历+3 家任务工具免费；Notion/OneDrive/GDrive/Linear/Asana/ClickUp=Pro，未订阅点击 → toast + Upgrade 按钮；Notion 行受 feature flag 控制。埋点：connect_start/success/fail（带 flow=settings|onboarding、source）。

**日历的消费闭环**（General 设置）：Meeting Reminders（带链接会议前 1 分钟提醒）、Meeting Detection（Zoom/Teams/Slack Huddle/Webex 检测）、Auto Record（检测到会议自动录制，依赖 Detection 开启）、Privacy Mode（只留转写不留音频）。

## 1. 背景与机会

Lynse 已有会议录制/转写/笔记/AI 助手，但会议前的日程上下文和会后的产出分发都断在产品边界外：用户手动对日历、手动把行动项抄进待办工具、手动把总结贴到文档库。Pocket 验证了"Connections 集成中心"以一个设置页收口全部第三方连接的模式，且其三段式 OAuth/门控/埋点范式可直接借鉴。Lynse 已有可复用地基：WorkBuddy OAuth 三段式（`packages/core/auth/workbuddy.ts`：authorize URL→系统浏览器→轮询，refresh token 不落客户端）、Keychain vault（`lynse_secrets_v1` + `registerSecretKeys`）、设置分区模式（`settings-dialog.tsx` SettingsSection 数组）、会员等级/积分体系。

## 2. 目标与非目标

**目标**：
- G1 一个设置分区收口所有第三方连接，5 分钟内完成首个连接
- G2 日历驱动会议闭环（会前提醒→录制→笔记关联日程）
- G3 行动项/总结一键或自动分发到任务/文档工具
- G4 导入外部 AI 记忆形成用户画像，个性化总结与助手
- G5 对外 MCP 开放（后期）

**非目标**：不做团队级共享连接（组织/席位后续单独评估）；不做集成市场/第三方开发者自建集成；P0-P2 不做 Web 端 UI（后端合同两端通用，Web 复用点见 §6.6）；不动现有 macOS 系统日历写入（`todo_add_to_calendar`）。

## 3. 用户故事（关键 6 条）

- US1 销售王琳连上 Google Calendar 后，Lynse 在会议开始前 1 分钟提醒并一键开始录制，结束后笔记自动挂到该日程。
- US2 产品阿强全选会议行动项导出到 Todoist 指定项目，之后开启 Auto-export 免手动。
- US3 外贸周姐把会议总结自动写入飞书多维表格给团队看。
- US4 老用户把 ChatGPT 三年记忆一键迁入，Lynse 总结立刻带个人风格。
- US5 顾问把 Pocket 式 Claude Connector 配好，在 Claude 里直接问"上周和 A 客户聊了什么"。
- US6 免费用户点 Notion 连接被引导升级。

## 4. 信息架构与 UI 规格

设置弹窗（`packages/views/settings/settings-dialog.tsx`）新增 `connections` 分区（icon+label 用 i18n key `settings.sections.connections`），新建目录 `packages/views/settings/connections/`：
- `connections-card.tsx`：分区宿主，五个子卡片分组=区块顺序：导入 / 日历 / 同步 / 任务 / 外部 AI（与 Pocket 顺序一致）
- `provider-row.tsx`：通用行组件（logo+名称+状态点+右侧按钮：Connect/Add/Disconnect/Upgrade），已连接显示绿色 "Connected" + 账号列表；Disconnect 走红色二次确认弹窗（文案"断开 {email}？可随时重新连接"）
- `calendar-account-row.tsx`：每账号 Sync/Notify 开关 + 删除（仿 Pocket）
- `default-destination-select.tsx`：Notion 数据库 / 各任务工具 project-list 下拉 + Refresh 空态
- `memory-import-dialog.tsx`：prompt 展示/复制 + "打开 ChatGPT/Claude" + 粘贴 textarea + 保存
- `mcp-info-dialog.tsx`：P3，展示 MCP URL + API key 引导
- 骨架态/加载态：行级 spinner；状态获取失败静默重试（30s 退避，同 Pocket）

## 5. 功能需求

### FR-1 日历连接（P0 Google，P1 Outlook/飞书/钉钉/企微）
- 连接：点击 Connect → GET `oauth-state` → `openExternalUrl(授权页)`（复用 `packages/views/app-update.ts` openExternalUrl）→ 回调换取连接（见 §6.2 回调双通道）→ toast 成功 → 刷新状态
- 多账号：每供应商可连多个账号；账号行含 Sync（该账号日程拉入 Lynse 用于会议关联/检测）与 Notify（会前提醒）开关，默认双开；可单独删除
- 消费闭环：接入现有 `meeting_detector`（apps/tauri 已有 meeting_detector_* 命令）与自动录制设置（`auto-record-config-card.tsx`）：日历事件命中带链接会议 → 会前 N 分钟提醒 → 一键录制 → 录音/笔记元数据写 calendar_event_id（`local_recordings.calendar_event_id` 字段已存在）
- AC：连接成功后 30s 内日程出现；断开后停止拉取且不再提醒；双账号独立开关生效；token 失效自动刷新且对用户无感，刷新失败行上显示"重新授权"

### FR-2 任务工具连接 + 行动项导出（P0 用 Todoist 验证链路；P1 全量 6 家+飞书任务）
- 手动导出：行动项多选 → "导出到…" → `POST /api/v2/integrations/{provider}/export {action_item_ids, [default_project_id|default_list_id|default_task_list_id]}` → 部分成功按 Pocket 语义返回 succeeded/failed 并 toast
- Auto-export：每账号开关 `PUT …/auto-export`；开启后会议总结完成即自动导出新增行动项（后端定时/事件触发），文案"会后自动导出行动项"
- 默认目标：连接后必选一次默认 project/list；`GET …/projects|task-lists` 拉取，支持 Refresh
- AC：导出成功在工具内可见标题+勾选态；auto-export 只导一次不重复；无默认目标时导出前置引导选择

### FR-3 文档/云同步连接（P0 Notion；P1 飞书多维表格、OneDrive、Google Drive）
- Notion：连接后选 Default database（空态文案"请在 Notion 中将该数据库分享给 Lynse 后点击刷新"）；导出对象=会议总结（结构化字段对齐数据库属性）
- 门控见 §6.4
- AC：导出后的 Notion 页面含总结+行动项；再次导出更新同页不重复建页

### FR-4 记忆导入 → 用户画像（P2）
- 弹窗流程同 Pocket（prompt 三层结构直接借鉴）；`POST /api/v1/users/current/user-profile/import-memory {imported_memory, source: chatgpt|claude}`；画像版本化 `/versions` 可回滚
- 画像消费：总结与 AI 助手 system prompt 注入画像摘要（可开关，默认开）
- AC：导入后生成新版本；空粘贴被拦截；画像可在设置中查看/编辑/回滚

### FR-5 External AI / MCP server（P3，与 lynclaw MCP 服务端草案合流）
- 提供 `https://<public>/mcp` 远程 MCP；API key（`pk_` 前缀）在 Developers 页创建/吊销；首批工具：get_meeting_note / search_meeting_notes / search_action_items / get_speaker_profile
- AC：Claude Connector 配置后能完成一次真实检索；key 吊销后 401

## 6. 技术方案（Lynse 落地）

**6.1 前端**：新模块 `packages/core/integrations/`（types + api + hooks）；hooks 用 TanStack Query，queryKey 域 `["connections", provider]` / `["connections", provider, "accounts"]` / `["connections", "status"]`，staleTime 60s（参照 `use-files.ts` 的 LIST_STALE_TIME_MS 惯例）；不进 query-persistence 白名单（连接状态不本地持久化，对标 Pocket 云端存储）。

**6.2 OAuth 回调双通道**：P0 沿用 WorkBuddy 范式（后端中转 + `pollXxx` 轮询，零桌面改动）；P1 引入 deep-link：加 `tauri-plugin-deep-link` 依赖 + Info.plist `CFBundleURLTypes`（scheme `lynse`，identifier 保持 com.lynse.sparknote 不动，不破坏 TestFlight 签名链）+ capabilities deep-link 权限 + `tauri-bridge.ts` 新增 `onDeepLink(cb)`（沿用 tray-action 的 pending 队列模式解决冷启动早于 React 挂载）+ single-instance argv 兜底；后端 `oauth-state` 返回 `redirect_uri=lynse://integration-callback`（desktop）或 web 域中转页（web）。

**6.3 token 安全**：对标 WorkBuddy+Pocket——Google/Outlook 等所有第三方 token（access/refresh）由后端在 exchange-code 时换取，只存云端账号数据库；客户端仅拉取 status/accounts，本地与 Keychain 均不落任何第三方密钥；若个别供应商必须本地存，走 secure-storage vault key + `registerSecretKeys` 动态注册（先例：`lynse_live_translation_<provider>_<field>`）。

**6.4 门控**：不引入新订阅体系，按现有会员等级（`useUserCredits` 的 benefitType/memberLevel）映射免费/付费供应商矩阵（默认：日历免费；Notion/Todoist/Google Tasks 免费体验；OneDrive/GDrive/Linear/Asana/ClickUp 高级）；付费拦截 toast + 升级引导；服务端 403 requires_pro 与 503 not_configured 错误语义照抄 Pocket；导出动作可选积分消耗（复用 402 `isInsufficientCreditsError`）。

**6.5 后端 API 合同**（新增 /api/v2/integrations/*，命名对齐 Pocket 以便文档互通）：每 provider 五件套 oauth-state/exchange-code/status/disconnect/auto-export + export + 目标列表端点；日历独立前缀 /api/v2/calendar/{google|outlook}/…；integrations 表：user_id, provider, account_id, account_email, workspace_name, scopes, access_token(加密), refresh_token(加密), expiry, status, default_destination_id, auto_export, sync_enabled, notify_enabled；日程同步 job + auto-export job。

**6.6 Web 复用点**：API 全部两端通用；Web 端回调走 `origin` 参数回跳（Pocket 的 /oauth/callback 中转页模式），UI 后续直接复用 connections/ 组件（无 next/* 依赖）。

**6.7 埋点**（对齐 Pocket）：connections_connect_start/success/fail（provider, flow, source, error_code）、auto_export_toggled、export_to_provider（provider, count, success）、memory_imported（source）、calendar_toggles_changed；护栏指标：连接失败率、exchange 失败率。

**6.8 i18n**：5 个 locale 文件（en/zh/zh-Hant/ja/ko）新增 `connections:` 命名空间（供应商名不翻译）。

## 7. 里程碑

- **P0 链路打通（~3 周）**：后端五件套+integrations 表；前端 Connections 分区+通用行组件；Google Calendar 连接+多账号+Sync/Notify；Notion 连接+默认库+总结导出；Todoist 连接+手动导出。出口标准：US1/US2 全流程可用。
- **P1 广度+自动化（~3 周）**：Outlook、Google Tasks/TickTick/Linear/Asana/ClickUp；auto-export；飞书（日历+多维表格）+钉钉日历；deep-link 升级（lynse://）；门控付费墙。
- **P2 记忆导入（~2 周）**：FR-4 全部 + 画像消费开关。
- **P3 开放（~2 周）**：MCP server + Developers API key 页。

## 8. 总验收清单（节选）

- AC-1 全新用户 5 分钟内完成 Google Calendar 连接且日历出现在会前提醒链路
- AC-2 每供应商断开/重连/多账号不串数据
- AC-3 auto-export 幂等
- AC-4 未登录/Token 过期/503/403 四种错误各有明确文案（i18n 5 语言）
- AC-5 token 不落客户端磁盘（审计 Keychain/localStorage）
- AC-6 付费矩阵拦截前后端双保险
- AC-7 埋点全量上报

## 9. 指标

北极星：连接用户 7 日留存差（连接 vs 未连接）。过程：连接渗透率（目标 8 周内 25% 活跃用户≥1 连接）、auto-export 开启率（>30%）、导出成功率（>98%）、记忆导入完成率（>60%）、会议提醒→录制转化率。

## 10. 风险

- R1 Google/Microsoft OAuth 审核（隐私政策+验证流程，P0 需并行启动申请）
- R2 国内供应商 API 差异（飞书/钉钉 OAuth 与 token 语义不同，P1 预留适配层）
- R3 深链冷启动时序（pending 队列+argv 兜底已在方案内）
- R4 后端排期是硬依赖（P0 前端可用 mock contract 先行）
- R5 记忆导入的敏感信息合规（明示用途+本地可删+版本回滚）
