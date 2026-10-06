# Connections 后端 API 契约（供冻结）

| 项 | 内容 |
|---|---|
| 版本 | v0.1（前端提案，待后端确认） |
| 日期 | 2026-10-03 |
| 依据 | `connections-prd-v1.1.md` §6.5、`connections-desktop-impl-assessment-v1.1.md` §五.1 |
| 参考实现 | `e2e/fixtures/integrations-mock.ts`（本契约的可执行版本，前端 e2e 已按它跑通） |
| 客户端 | `packages/core/integrations/{types,api,errors}.ts` |

## 0. 为什么要先冻结这份

前端 P0 采用 mock 先行：e2e 直接对着 `integrations-mock.ts` 开发，后端就绪后只换 `lynse_api_url`。因此**这份文档里的字段名、状态码和错误键就是前端已依赖的接口**，任何偏离都会变成前端返工。命名对齐 Pocket 以便两端文档互通。

## 1. 通用约定

- 前缀：`/api/v2/integrations/{provider}/…`，日历消费走 `/api/v2/calendar/…`。
- 信封：与其它 Lynse 接口一致，HTTP 200 携带 `{ code, data, msg }`；`code != 200` 由客户端 `ApiClient` 抛出为 `ApiError`（`packages/core/api/client.ts:154-178`）。**网关业务码放在 `code`（进入 `ApiError.status`），点状错误键放在 `msg`（进入 `ApiError.message`）**。
- 鉴权：沿用现有 `Authorization` 头，无需新机制。
- **响应体中绝不含第三方 access/refresh token**（PRD §6.3）。客户端只拿账号元数据。
- provider 取值：`google-calendar`、`outlook-calendar`、`notion`、`todoist`、`google-tasks`。

## 2. 端点

### 2.1 `GET /api/v2/integrations/{provider}/status`

```jsonc
{
  "connected": true,
  "provider": "google-calendar",
  "requires_pro": false,          // 见 §4，客户端据此决定是否显示 Upgrade
  "accounts": [ {
    "id": "acct-google-calendar-1",
    "email": "wang@corp.com",
    "display_name": "wang",
    "workspace_name": "Lynse",     // notion 专用，其它 provider 省略
    "is_primary": true,
    "sync_enabled": true,          // 日历类
    "notify_enabled": true,        // 日历类
    "auto_export": false,
    "default_destination_id": null // 任务/文档类
  } ]
}
```

### 2.2 OAuth 三段式（P0：轮询通道）

| 步骤 | 端点 | 说明 |
|---|---|---|
| ① | `GET …/oauth-state?platform=desktop\|web&origin=…` | 返回 `{ state, client_id, scope, redirect_uri, authorization_url }`。`redirect_uri` 桌面为 `lynse://integration-callback`（P1 深链）或 web 中转页 |
| ② | `GET …/oauth-result?state=…` | 客户端退避轮询 `[0,4s,10s,20s,40s]` 后稳定 20s，超时 10 分钟。返回 `{ status: "pending" \| "done" \| "error", account_id?, error? }` |
| ③ | `POST …/exchange-code { code, state, redirect_uri }` | **P1 深链通道**：客户端拿到 code 后代换。P0 由后端在 web 中转页完成换取，客户端只轮询 |

`state` 必须一次性、带 TTL（建议 30 分钟）、含 provider/origin/platform；重放或过期返回 400 `state_invalid`。

### 2.3 `DELETE …/disconnect?account_id=…`

返回 `{ connected, remaining }`。只删指定账号，多账号互不影响（PRD AC-2）。未知账号 404 `unknown_account`。

### 2.4 `PUT …/auto-export { account_id, auto_export }`

返回 `{ ok, auto_export }`。幂等；auto-export 的导出必须只发生一次（PRD AC-3）。

### 2.5 `PUT …/default-destination { account_id, destination_id }`

**新增端点**（PRD/评估未列出，但 FR-2/FR-3 的"连接后必选一次默认目标"必须有落点）。校验 `destination_id` 属于该账号可见目标，否则 400 `unknown_destination`。返回 `{ ok, destination_id }`。

### 2.6 `GET …/destinations`

返回 `{ destinations: [{ id, name }] }`。Todoist→projects、Google Tasks→task-lists、Notion→database 列表（含"已分享给 Lynse"过滤）。未连接时 409 `not_connected`。

### 2.7 `POST …/export { action_item_ids, default_project_id | default_task_list_id | default_database_id }`

**部分成功语义（Pocket 同款）**：HTTP 200 +

```jsonc
{ "succeeded": [ { "id": "todo-1", "external_id": "ext-todo-1" } ],
  "failed":    [ { "id": "todo-2", "reason": "error.integrations.export_item_failed" } ],
  "destination_id": "proj-work" }
```

无默认目标 → 409 `no_destination`（客户端弹出选择器，不静默挑一个）。未连接 → 409 `not_connected`。

### 2.8 日历消费

- `GET /api/v2/calendar/events?from=&to=` → `{ connected, events: [{ id, title, start_time, end_time, meeting_url, account_id }] }`，ISO-8601 瞬时。`meeting_url` 非空即"带链接会议"，是自动录制与会前提醒的判据。
- `PUT /api/v2/calendar/accounts/{id}/toggles { sync_enabled, notify_enabled }` → `{ ok }`。

## 3. 错误键（客户端已按这些写文案，5 语言齐备）

| HTTP | `msg` 键 | 客户端行为 |
|---|---|---|
| 403 | `error.integrations.requires_pro` | 显示升级引导 |
| 503 | `error.integrations.not_configured` | "该集成尚未开通" |
| 400 | `error.integrations.state_invalid` | 重新发起授权 |
| 409 | `error.integrations.no_destination` | 弹出目标选择器 |
| 409 | `error.integrations.not_connected` | 引导连接 |
| 404 | `error.integrations.unknown_account` | 刷新状态 |
| 400 | `error.integrations.unknown_destination` | 刷新目标列表 |
| — | `error.integrations.export_item_failed` | 出现在 `export.failed[].reason` |

前端的键表与谓词在 `packages/core/integrations/errors.ts`；文案在 5 个 locale 的 `connections.error.*`。

## 4. 门控（需要后端回答的问题）

`status.requires_pro` 是**服务端事实**。客户端不做免费/付费矩阵的原因：`benefitType` / `memberLevel`（`packages/views/layout/use-user-credits.ts:5-29`）是带 `[key: string]: unknown` 的未校验字符串，全仓只有两处把它映射成显示名（`app-sidebar.tsx:244-254`、`settings/member-badges.ts:21-27`），**没有任何 capability 字段**。若后端希望客户端本地判定，请给出稳定的 capability 列表而不是等级字符串。

建议默认矩阵（PRD §6.4）：日历 / Todoist / Google Tasks 免费；Notion 及 OneDrive/GDrive/Linear/Asana/ClickUp 为 Pro。

## 5. 数据库

`integrations` 表：`user_id, provider, account_id, account_email, workspace_name, scopes, access_token(加密), refresh_token(加密), expiry, status, default_destination_id, auto_export, sync_enabled, notify_enabled`。

FR-1 闭环还需（P1）：`file` 元数据新增 `calendar_event_id`、`meeting_title` 两列 —— 注意 Lynse **没有** `local_recordings` 表，PRD v1.0 那句"字段已存在"是误抄 Pocket 的本地库结构。

## 6. 尚未解决、需要后端答复

1. OAuth client_id 申请与 Google 验证进度（PRD R1，阻塞 P0 真机联调）。
2. 第三方直连的 CORS 实测结论：Notion 返回 `ACAO: *`、Todoist 回显 origin，**技术上可直连**；本契约仍要求全部经后端代理，理由是 token 不落客户端（§6.3），不是 CORS。
3. auto-export 的触发方（后端事件/定时）与幂等键。
4. Notion 导出的 upsert 语义（同页更新不重复建页，PRD FR-3 AC）。
5. 飞书/钉钉适配层的时间表（P1，PRD R2）。
