# 待办 → 目标 · 功能计划（2026-10-06）

> 状态：**计划落盘，未实施**。实现需另行批准。
> 背景：待办模块加「转为目标」，目标在首页持续追踪；追踪智能层由 lynclaw 完成（定时任务）；lynclaw → 桌面的消息传送机制采用轮询拉取。

---

## 1. 探索结论（硬事实，2026-10-06 实查）

### 1.1 目标后端已存在：lynse-memory 服务

- 部署：CloudRun `https://lynse-memory-321192-9-1401959758.sh.run.tcloudbase.com`（v022，env `lynse-d8g49o1i956741f9e`），`LYNSE_API_HOST=https://gapp.lynse.cn` **绑测试服**（正式服 api.lynse.cn 尚无对应部署）。
- 源码：lynclaw-main 仓库 `services/lynse-memory/`，`core/goal_service.py` 功能完备。
- 与聊天服务 lynclaw-api（`lynclaw-api-321192-9`）是**两个独立部署**。

### 1.2 Goal API 契约

| 端点 | 说明 |
|---|---|
| `POST /v1/goals/actions` | 8 个 action：create / update / complete / reopen / delete / add_entry / set_pushable / set_attention。**幂等路由，必须带 `Operation-Id` 头**（可用 `todo-goal-${todoId}` 天然防重） |
| `GET /v1/goals?status=active` | 活跃目标列表 |
| `GET /v1/goals/due` | 待关注目标：`reason=attention`（needs_attention）+ `reason=review_due`（next_due_at 已到）；pushable=false 和 completed 不出现 |
| `GET /v1/goals/{id}` | 详情 + 进度 entries |

- create 关键字段：`title`(≤200) / `description`(≤2000) / `next_due_at`(ISO，parse_time 接受 Z/+00:00) / `review_cadence`(none|daily|weekly|monthly) / `pushable`(默认 true) / `source`(可标记来源，如 `user_todo`) / WOOP 四件套。
- 变更自动进 `/v1/sync`（entity goal/goal_entry）。
- `_view` 返回 17 字段（goal_id/title/description/status/category/woop/review_cadence/next_review_question/next_due_at/attention_kind/attention_updated_at/pushable/momentum/version/source/created_at/updated_at/completed_at）。
- 服务是**确定性存储**，从不判断"目标是否需要关注"——判断属于调用方（agent turn 或 pipeline，即下一批的 cron）。

### 1.3 认证

- 接受 Lynse 业务 token，但必须是 `Authorization: Bearer <token>` 形式（`bearer_token` 只认 Bearer 前缀，**裸 token 401**——桌面共享 ApiClient 默认发裸 token，需 per-call header 覆盖）。
- 服务端经 `{LYNSE_API_HOST}/api/business/customer/current` 验 token 换 user_id（gapp 收裸 token、api 收 Bearer，两种都试）。无 client user_id 分支。

### 1.4 CORS 是硬前置

- lynse-memory 无 CORS（实测 OPTIONS 返回网关 501），桌面 WebView 直连会被拦。
- lynclaw-api 有 `allow_origins=["*"]`，聊天直连不受影响。
- 我曾写好一版 CORS 改动（5 文件 + 4 测试，27 测试全过）后按用户要求回退；恢复即可，见 §4.1。

### 1.5 桌面端接线点

- `core/config/index.ts` 的 `agentUrlForApiUrl` 映射模式；`core/api/client.ts` 的 `integrationsBaseUrl` per-call override 模式；`core-provider.tsx` initCore 接线。
- TodoEditSheet 已是 edit/calendar 双视图（加第三视图 goal 顺理成章）。
- 云端待办元数据走 localStorage overrides（`lynse.todos.overrides`）在 load 时合并。
- 首页 = 问候头 + 今日摘要条 + 最近记录 feed；通知中心（`views/notifications`、`use-notification-store`）现成。
- `featureFlags` 单一开关源；五语言 locale。

---

## 2. 消息传送机制（已拍板 2026-10-06）

**lynclaw 不「推」，桌面端「拉」：定时任务产生的是状态，不是消息。**

```
【服务端】lynclaw-api 进程内 cron（MinNum=1 单实例，无并发问题）
   到点 tick：
   1. GET /v1/goals/due（内部 token）→ 复盘到期 + 需关注目标
   2. 每个目标跑 agent 复盘 → set_attention / add_entry 写回结论
   3. 一切落 lynse-memory（proactive_service 已带 pushable 开关、
      免打扰时间窗、每日上限——节流现成）

【客户端】桌面端 Rust 侧定时器（app 运行期都活着，含托盘常驻）
   每 5–10 分钟带用户 token：GET /v1/goals/due
   → 本地 diff：attention_updated_at / next_due_at > 上次拉取时间 = 新提醒
   → tauri-plugin-notification 发 macOS 系统通知（点击→聚焦窗口/目标卡片）
   → 同步进应用内通知中心 + 首页目标卡片角标

【桌面端没开时】消息不丢（就是服务端状态），下次启动拉取补展示
```

设计要点：
1. **消息即状态，不建通知队列表**——attention_kind/next_due_at/proactive 台账就是通知本体，多端天然一致。
2. **轮询放 Rust 不放 WebView JS**——托盘常驻时 WebView 可能关闭/节流；reqwest 无 CORS 限制，还与 CORS 决策解耦。
3. **服务端管节流（proactive 每日上限/时间窗），客户端管去重（时间戳 diff）**。

排除项：
- WebSocket/SSE 长连接：poll-only 是既有拍板（灵光机 APP 后台切换杀长连接教训），不再提。
- **Webhook：不适用于「通知桌面客户端」**——webhook 接收方必须是公网可达服务器，桌面端在 NAT 后无公网地址打不到；顶多做服务端中转一跳（lynclaw→某服务器），最后一公里到桌面仍只能轮询，多一跳多份数据无收益。
- APNs 真离线推送（app 没开也能收）：需 Apple 推送证书+设备 token 注册+服务端推送模块，二期增强，架构不冲突（只是把"拉"升级为"系统级推"，状态仍落 lynse-memory）。

---

## 3. 分批与决策记录

| 决策点 | 结论 | 状态 |
|---|---|---|
| 消息传送机制 | 轮询拉取 + 本地系统通知 | ✅ 用户拍板 |
| webhook | 排除（打不到 NAT 后桌面端） | ✅ 用户确认 |
| APNs | 二期 | ✅ 用户确认 |
| 范围 | **分两批**：首批=桌面端全部+通知链路（基于截止时间）；二批=lynclaw cron（agent 复盘/set_attention/proactive） | 推荐，待确认 |
| API 通道 | WebView 直连 + lynse-memory CORS 白名单（备选：全走 Rust bridge，免部署但 web 永不可用） | 推荐，待确认 |
| 转目标交互 | TodoEditSheet 第三视图（预填+确认），幂等防重（备选：列表行 ⭐ 一键直转） | 推荐，待确认 |
| 首页呈现 | 独立「目标追踪」卡片（备选：并入今日摘要轮播） | 推荐，待确认 |

---

## 4. 首批详细设计（桌面端 + 通知链路）

### 4.1 lynclaw-main：CORS 白名单（本批唯一服务端改动，5 文件）

- `services/lynse-memory/lynse_memory/config.py`：`cors_origins` 字段 + `LYNSE_MEMORY_CORS_ORIGINS` env（逗号分隔白名单，默认空=CORS 关）。
- `.../httpapp/httpd.py`：`_preflight`/`_cors_headers`；OPTIONS 预检不进路由不鉴权；**X-Memory-Internal-Token 永不出现在 Allow-Headers**；未列 origin 预检 403。
- `.../httpapp/server.py`：`do_OPTIONS` + 204 null-body 处理。
- `.../httpapp/app.py`：一行接线 `app.cors_origins = config.cors_origins`。
- `tests/test_lynse_memory_http.py`：CorsHttpTests 4 用例（白名单预检 204 带头 / 未知 origin 403 / 真实响应带 Allow-Origin / 默认关闭）。

部署（一次）：`deploy/cloudbase/build-and-push-images.sh` 重建镜像 → lynse-memory v023，EnvParams 追加：
`LYNSE_MEMORY_CORS_ORIGINS=tauri://localhost,http://tauri.localhost,https://tauri.localhost,http://localhost:1420,http://localhost:3000`

### 4.2 lynse-desktop core：通道接线（3 文件）

- `core/config/index.ts`：`CLOUDRUN_MEMORY_URL` 常量 + `memoryUrlForApiUrl()`（gapp 测试服→memory URL；**正式服→null，功能自动不可用**）。
- `core/api/client.ts`：`memoryBaseUrl` + `set/getMemoryBaseUrl()`（镜像 integrationsBaseUrl 模式）。
- `core/platform/core-provider.tsx`：initCore 接线。

### 4.3 views/goals 模块（新建 3 文件）

**goal-api.ts**
- `GoalView` 类型（对齐服务端 17 字段）。
- `createGoalFromTodo(todo)`：POST actions `{action:"create", title, description: notes+来源拼接, next_due_at: dueDate||calendarStartAt（无则省略）, review_cadence:"none", pushable:true, source:"user_todo"}`，headers：`Operation-Id: todo-goal-${todo.id}` + `Authorization: Bearer ${token}`。
- `fetchActiveGoals()` / `getGoalEntries(id)` / `completeGoal(id)`。
- 统一走 `api()` + `{baseUrl: getMemoryBaseUrl()}`；null 抛 NotConfiguredError。
- goal-api.test.ts：payload 形状 + Bearer/Operation-Id 头断言。

**use-goals.ts**：TanStack Query `["goals","active"]`，staleTime 60s，`enabled = 已登录 && baseUrl 非空`，失败静默。

### 4.4 待办页（todo 2 文件）

- `todo-api.ts`：`TodoItem` 加 `goalId?/goalAddedAt?`；`normalizeStored` 带新字段；云待办走现有 localStorage overrides。
- `page.tsx` TodoEditSheet：
  - actions 行三按钮：加入日历 | **转为目标** | 删除；已转→「已加入目标 ✓」状态条，不可重复转。
  - 第三视图 "goal"：标题（预填可改）/截止（预填）/备注 + 提示「创建后 AI 助手将持续追踪」→ 确认创建。
  - 成功：toast + `saveTodo({...todo, goalId})` 打标 + invalidate `["goals"]`。
  - 转目标**不删待办**（完成待办≠完成目标，独立追踪）。
- 列表行：有 goalId 的待办显示小 🎯 角标。

### 4.5 首页目标卡片（home 2 文件）

- `goals-card.tsx`：摘要条与「最近记录」之间。
  - 行：标题 + 截止徽章（复用 `home.badge_due_date`/`badge_overdue`）+ `needs_attention` 黄点 ⚠。
  - 行尾完成勾选（`completeGoal`，乐观更新+回滚）。
  - 点行展开进度时间线（`getGoalEntries` 按日期排）。
  - 无目标/未配置/失败 → 整卡隐藏。
- `page.tsx` 接入（featureFlags.goals 门控）。

### 4.6 Rust 通知链路（轮询 + 系统通知）

- `apps/tauri/src-tauri` 新增 notification scheduler 模块：
  - WebView 启动且已登录时调 Rust 命令配置（token + memoryUrl + 偏好），登出停。
  - tokio 定时器每 5 分钟 `GET /v1/goals/due`（reqwest，Bearer 头）。
  - diff 判新：`attention_updated_at`/`next_due_at` 晚于本地 last-seen（app data JSON 持久化）；401 静默停。
  - `tauri-plugin-notification` 发系统通知（**需先确认依赖是否已装**）；点击→聚焦主窗口。
- `main.tsx`：登录态变化接线。
- 应用内同步落通知中心（`use-notification-store`）。
- Settings 通知开关（默认开）。
- 首期通知源：截止到期（review_due）+ 需关注（needs_attention，本批由用户/助手对话产生；二批后由 agent 自动产生）。

### 4.7 开关 + 文案

- `feature-flags.ts`：`goals: true`（待办动作/首页卡/通知统一门控，一处回滚）。
- 5 语言 locale 各 ~10 key。

### 4.8 验证

1. lynclaw：`python3 -m unittest tests.test_lynse_memory_http`（27+ 全过）。
2. desktop：`pnpm typecheck && pnpm test`。
3. 部署 v023 后手动 E2E：gapp 登录 → 待办转目标 → 首页卡片出现 → next_due_at 改过期 → ≤5 分钟收到系统通知 → 点击聚焦。
4. 回归：正式服登录（baseUrl=null）→ 无转目标按钮、无卡片、无轮询。

---

## 5. 二批概要（lynclaw cron，另立计划）

- lynclaw-api 进程内 cron worker（MinNum=1 单实例；asyncio 循环或内部令牌保护的 `/internal/scheduler/tick`）。
- 到点扫 `/v1/goals/due`（内部 token）→ agent 复盘（add_entry 记进度 / set_attention 标关注）→ proactive 台账（节流）。
- 参考：skills/lynse-schedule 已有 cron 模式先例（check_reminders.py）。
- agent 复盘的 prompt 设计、LLM 成本控制、复盘节奏（review_cadence 字段已预留）届时细化。
- APNs 离线推送（可选三期）。

## 6. 明确不做（首批）

- lynclaw cron（agent 复盘智能层）。
- APNs。
- web 端目标 UI（通道就绪，UI 不做）。
- 目标独立管理页（编辑/删除/子目标——卡片+助手对话够首期）。

## 7. 风险与注意

- CORS 未部署前功能不可用 → flag 关闭或 UI 隐藏（`memoryUrlForApiUrl` 返回 null 已兜底）。
- Bearer vs 裸 token 差异必须在 goal-api 封装层处理，勿泄漏到调用方。
- Operation-Id 幂等依赖 todo.id 稳定（云端 id 与本地 uuid 均稳定，OK）。
- lynse-memory REST 通道 RLS 不生效（README 已知事实，租户隔离靠应用层）——不影响本计划，保持认知。
- 轮询 token 过期：401 → 静默停，等下次配置。
- 多端一致：状态在服务端，将来 mobile 接同一套。

## 8. 改动面汇总（首批）

| 仓库 | 文件 |
|---|---|
| lynclaw-main | 5 文件（CORS）+ 1 次部署 |
| lynse-desktop core | 3 文件 |
| lynse-desktop views | 新建 5（goal-api/use-goals/test/goals-card 等）+ 修改 9（todo 2 / home 2 / flags 1 / locales 5）|
| lynse-desktop tauri | 3（lib.rs / Cargo 或 plugin / main.tsx）|

全部可由 `featureFlags.goals` 一键关闭；正式服天然不受影响（无映射）。
