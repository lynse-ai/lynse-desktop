# Lynse E2E — 自动化 UI 测试系统

Playwright 端到端测试，覆盖 AI 助手全部功能（含 ≥5 轮多轮对话剧本）与全站冒烟。
完全独立于主 workspace（`pnpm-workspace.yaml` 不包含 `e2e/`）。

## 运行

```bash
cd e2e
pnpm install --ignore-workspace        # 首次
pnpm exec playwright install chromium  # 首次

pnpm test            # 全量（自动拉起 pnpm dev:web，若 3000 端口空闲）
pnpm test:headed     # 有头模式观察
pnpm test:chat       # 只跑 AI 助手
pnpm report          # HTML 报告
```

- **不需要真实后端、不需要登录**：测试为每个用例启动本地 mock 后端
  （`fixtures/mock-server.ts`），通过 `localStorage.lynse_api_url` 让 Next 的
  `/api/proxy` 转发到它。SSE 流式对话由 `scripts/*.json` 剧本驱动，逐 chunk
  真实推送。
- 若端口 3000 已有 dev server 在跑，Playwright 会直接复用。

## 目录

```
playwright.config.ts        # baseURL :3000，webServer 自动拉起，clipboard 权限
fixtures/
  mock-server.ts            # 本地 Lynse 后端 mock：JSON 路由 + 剧本化 SSE 流
  api-mocks.ts              # 默认 mock 数据（用户/文件夹/文件/待办）
  chat-script.ts            # 剧本 TypeScript 类型
  lynse-fixture.ts          # Playwright fixtures：mockServer + openChat
helpers/
  chat.ts                   # 选择器字典 + 发送/等待/断言公共动作
scripts/                    # ★ 结构化对话剧本（可直接编辑，见 scripts/README.md）
tests/
  01-chat-core.spec.ts      # 发送/流式/停止/错误/复制/澄清确认/来源
  02-chat-multiturn.spec.ts # 自动发现 scripts/ 下所有 multiturn 剧本并回放
  03-chat-mentions.spec.ts  # @/# 提及：picker、键盘导航、chip 删除
  04-chat-history.spec.ts   # 历史侧栏、新会话、切换恢复
  10-nav-smoke.spec.ts      # 全站路由冒烟
  20-settings-smoke.spec.ts # 设置对话框
```

## 剧本（scripts/*.json）

每人可编辑的对话数据文件。字段说明见 `scripts/README.md`。
`suite: "multiturn"` 的文件会被 `02-chat-multiturn.spec.ts` **自动**逐轮回放，
无需改测试代码；每个 multiturn 剧本必须 ≥5 轮。

响应类型：`stream`（分片流式+可选来源）、`clarify`（弹确认对话框）、
`error`（SSE 错误）、`stream-abort`（慢速无 done，测停止按钮）、`http-error`。

## 覆盖的 AI 助手功能清单

- 发送（Enter / 按钮）、流式逐字渲染、状态提示、停止流式、错误气泡（SSE/HTTP）
- 8 条快捷指令逐个触发
- 复制回复（Copied 状态）、助手头像切换入口
- 知识来源 chips（meta 事件）
- 澄清确认对话框（确认 / 取消）
- @ 笔记 / # 群组提及（picker + ↑↓/Enter/Tab/Esc + chip 删除）
- 历史会话侧栏、新会话、会话切换、刷新后恢复并续聊
- 10 个多轮剧本：单录音深挖、中英混用、澄清×2、两次中断续聊、错误恢复、
  快捷指令全集、提及工作流、富 Markdown（标题/列表/代码/表格/引用）、
  待办提取链路、刷新恢复

## 已知边界

- 登录流程不测（按约定跳过；如需真实后端联测可去掉 `bootstrapApp`）。
- 附件上传不测（功能未实现，聊天页入口已在 UI 上屏蔽，
  见 `packages/views/chat/page.tsx`）。
- `/todo`、`/notes`、`/notifications` 在 web 端无路由（侧栏链接 404），冒烟未含。
