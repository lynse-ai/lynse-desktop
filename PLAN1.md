# Plan: Lynse Webapp V1 Workspace

## Summary

第一阶段做一个可连接真实 Lynse 后端的桌面版 workspace：Settings 手动填写 API Base URL 和 API Key 完成鉴权；主工作区使用三栏布局；左栏按后台分组展示文件；中栏只读预览大纲/总结；右栏只做 AI Chat 前端占位。

暂不做真实 AI 聊天、编辑保存、移动文件、移动端适配。

## Key Changes

### Settings 鉴权

- Settings 的 API Configuration 表单改为真实连接入口。
- 用户输入 `API Base URL` 和 `API Key(dk_xxx)` 后，调用 `POST /api/auth/apikey/token`。
- Token exchange 请求只带 `X-API-Key` header。
- 后续业务请求使用两个 header：
  - `Authorization: <accessToken>`
  - `X-API-Key: <apiKey>`
- `Authorization` 不加 `Bearer` 前缀。
- 本地保存并恢复：
  - `lynse_api_base_url`
  - `lynse_api_key`
  - `lynse_token`
- 连接成功后调用 `/api/business/customer/current` 获取当前用户信息，并更新 auth state。

### API Client

- `packages/core/api/client.ts` 增加运行时设置能力：
  - `setBaseUrl(baseUrl)`
  - `setApiKey(apiKey)`
  - existing `setToken(token)`
- 统一处理 Lynse 响应：
  - `{ code: 200, data }` 返回 `data`
  - `{ code != 200, message }` 抛 `ApiError`
- 保留非 Lynse 响应兼容能力，避免破坏现有普通 JSON 调用。
- 增加 query params helper，例如 `getWithParams<T>(path, params)`。
- 文件分页结果兼容常见列表字段：
  - `records`
  - `list`
  - `rows`
  - `items`
  - array payload
- 401 时清理 token；baseUrl 和 apiKey 保留在 Settings 中，方便用户重新连接。

### Workspace 三栏

- 新增 `packages/views/workspace/*`，导出 `WorkspaceLayout`。
- 以下 route 都渲染同一个三栏 workspace：
  - `/recordings`
  - `/meetings`
  - `/knowledge`
  - `/files`
- Settings 和独立 `/chat` 保持现有单页布局。
- `DashboardLayout`、`AppSidebar` 继续作为外层导航，不在第一阶段重构。

### 左栏后台分组

- 用 `/api/business/file/folder/list` 获取后台已有分组。
- 左栏分组名称和顺序以后台返回为准。
- 用 `/api/business/file/page` 获取文件列表。
- 文件按 `folderId` 放入对应后台分组。
- 无分组或无法匹配分组的文件进入固定兜底组：
  - English: `Ungrouped`
  - Chinese: `未分组`
- 搜索通过 `originalFilename` 请求后端过滤。
- 第一阶段不做：
  - 新建分组
  - 重命名分组
  - 删除分组
  - 移动文件

### 中栏只读预览

- 第一阶段不引入 Milkdown。
- 不提供编辑和保存。
- 通过以下接口组合 Markdown 预览内容：
  - `/api/business/file/outline/get`
  - `/api/business/file/conclusion/list`
- 中栏需要覆盖四种状态：
  - 未选中文件
  - 加载中
  - 加载失败
  - 无大纲/无总结内容
- 若后端返回结构有差异，先做窄 normalization，把常见文本字段合成为 Markdown。
- 不接写回接口，不展示会让用户误以为可保存的编辑控件。

### 右栏 Chat 占位

- 只实现前端样式：
  - 当前文件上下文 header
  - message list
  - user / assistant bubble
  - input bar
  - disabled send state
- 点击发送只追加：
  - 本地用户消息
  - 固定占位助手回复
- 占位回复示例：
  - `AI chat will be available in a later version.`
  - `AI 助手将在后续版本开放。`
- 第一阶段不接真实 chat endpoint，不做 streaming，不新增后端契约。

## Files

### Modify

- `packages/core/api/client.ts`
- `packages/core/auth/index.ts`
- `packages/core/platform/core-provider.tsx`
- `packages/views/settings/page.tsx`
- `packages/views/package.json`
- `apps/web/app/(dashboard)/recordings/page.tsx`
- `apps/web/app/(dashboard)/meetings/page.tsx`
- `apps/web/app/(dashboard)/knowledge/page.tsx`
- `apps/web/app/(dashboard)/files/page.tsx`
- `packages/views/locales/en.ts`
- `packages/views/locales/zh.ts`

### Create

- `packages/views/workspace/index.ts`
- `packages/views/workspace/types.ts`
- `packages/views/workspace/store.ts`
- `packages/views/workspace/hooks/use-files.ts`
- `packages/views/workspace/hooks/use-folders.ts`
- `packages/views/workspace/hooks/use-file-content.ts`
- `packages/views/workspace/left-panel/item-directory.tsx`
- `packages/views/workspace/center-panel/preview-panel.tsx`
- `packages/views/workspace/right-panel/chat-panel.tsx`
- `packages/views/workspace/workspace-layout.tsx`

### Do Not Add In V1

- Milkdown dependencies
- Real AI chat endpoint integration
- Streaming chat mutation
- Edit/save APIs
- File move/folder mutation UI
- Mobile responsive behavior

## Implementation Order

1. **API Client**
   - Add runtime baseUrl/apiKey/token handling.
   - Add Lynse response unwrapping and error handling.
   - Add query params helper.

2. **Auth + Settings**
   - Change auth login flow to API Key token exchange.
   - Persist and restore baseUrl/apiKey/token.
   - Wire Settings API Configuration form to the auth flow.
   - Fetch current customer after successful connection.

3. **Workspace Data Layer**
   - Add workspace types.
   - Add UI-only Zustand store for selected file, collapsed groups, search query.
   - Add file list, folder list, and file content hooks.
   - Normalize file pagination payloads.

4. **Left Panel**
   - Render backend folders in backend order.
   - Group files by `folderId`.
   - Add Ungrouped fallback.
   - Add backend search by `originalFilename`.

5. **Center Preview Panel**
   - Load outline and conclusions for selected file.
   - Render combined Markdown as read-only preview.
   - Cover empty/loading/error/no-content states.

6. **Right Chat Placeholder**
   - Build chat panel visual shell.
   - Keep messages local only.
   - Add fixed placeholder assistant reply.

7. **Workspace Assembly + Routing**
   - Assemble three resizable panels.
   - Export `WorkspaceLayout`.
   - Wire workspace routes to `WorkspaceLayout`.
   - Keep Settings and standalone Chat unchanged structurally.

8. **i18n + Verification**
   - Add English and Chinese UI strings.
   - Run typecheck/tests.
   - Manually verify Settings connection and `/recordings` workspace layout.

## Test Plan

### API/Auth

- API Key token exchange sends `X-API-Key`.
- Business requests include both:
  - `Authorization: <token>`
  - `X-API-Key: <apiKey>`
- `Authorization` does not include `Bearer`.
- `{ code: 200, data }` unwraps to `data`.
- `{ code != 200, message }` throws `ApiError`.
- Query params serialize `pageNum`、`pageSize`、`originalFilename`.
- CoreProvider refresh restores baseUrl、apiKey、token.

### Workspace

- File list normalization supports:
  - `records`
  - `list`
  - `rows`
  - `items`
  - array payload
- Left panel folder order follows `/api/business/file/folder/list`.
- Files with matched `folderId` appear in the matching backend folder.
- Files with unknown or missing `folderId` appear in Ungrouped.
- Selecting a file loads outline/conclusions preview.
- Preview panel handles no selected file, loading, error, and no-content states.
- Chat panel only produces local placeholder replies.

### Manual

- `pnpm typecheck`
- `pnpm test`
- `pnpm dev:web`
- `/settings` can connect to backend with API Base URL + `dk_xxx`.
- `/recordings` shows directory | preview | chat placeholder.
- `/meetings`、`/knowledge`、`/files` show the same workspace shell.
- `/settings` remains a single-page settings layout.
- `/chat` remains the existing standalone chat layout.

## Assumptions

- V1 的 API Base URL 由用户在 Settings 手动填写。
- 后台 folder list 是左栏分组唯一来源。
- 文件类型分组暂缓，当前 v1 以后台分组为准。
- 编辑保存进入后续阶段。
- 真实 AI Chat 进入后续阶段。
- 移动端适配暂缓。
