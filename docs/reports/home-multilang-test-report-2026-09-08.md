# 测试报告：主页信息流 + 多语言（繁中/韩语） + 侧边栏录音入口

- 日期：2026-09-08
- 分支：main（工作区含未提交改动）
- 验证人：ZCode（自动化验证；未做桌面端人工目检）

## 一、改动范围

| 模块 | 内容 |
|---|---|
| `packages/views/home/`（新增） | HomePage 信息流页：feed 聚合（笔记/闪记/待办，近三天按日分组）、on-this-day 人文行 + 简繁两份数据集 |
| `packages/views/locales/` | en/zh/ja 增加 `nav.home`、`home.*`、`layout.lang_*` 键；新增 zh-Hant、ko 全量翻译（各 870+ 键）；zh 显示名「灵感」→「闪记」 |
| `packages/core/i18n/` | `SUPPORTED_LOCALES` 增加 `zh-Hant`、`ko` |
| `packages/views/layout/lynse-sidebar.tsx` | 顶部新增「主页」导航项；`+` 下拉拆为常驻麦克风（一键开录）+ 导入按钮；`isNavActive` 调整 |
| `packages/views/live-translation/quick-recording.ts`（新增） | `useQuickRecording`：无头开录（权限检查 → 纯录音会话 → 跳转录音页） |
| 路由 | tauri 初始页 `/notes`→`/home`、PageRouter 增加 home 分支；web 新增 `(dashboard)/home` 薄壳、`/` 重定向 `/home` |

## 二、验证环境

- macOS（darwin，arm64）、pnpm workspace + turbo
- 注：仓库 node_modules 中未安装 eslint（历史遗留的环境问题），`pnpm lint` 无法执行，本次不含 lint 结果。

## 三、验证结果汇总

| 检查项 | 命令 | 结果 |
|---|---|---|
| 全仓类型检查 | `pnpm typecheck`（turbo：core / ui / views / web） | ✅ 4/4 通过 |
| 桌面端渲染层类型检查 | `tsc --noEmit -p apps/tauri/tsconfig.json` | ✅ 通过（exit 0） |
| 单元测试 | `pnpm test`（vitest，views 包 27 个文件 143 用例） | ⚠️ 141 通过 / 2 失败（失败项与本次改动无关，见四） |

## 四、失败用例分析（非本次改动引入）

失败的 2 个用例均在 `chat/page.test.tsx`：

- `ChatPage > uploads a picked image attachment and sends its fileId with the message`
- `ChatPage > rejects unsupported attachment types without adding a draft`

失败原因：工作区中存在一份**不属于本次改动**的本地修改（`git diff packages/views/chat/page.tsx`），该修改把聊天附件上传入口从 UI 移除（注释：`Hidden from the UI until upload is implemented; handlers kept for reuse`），测试仍按旧的 `chat.attach_files` 按钮定位，因此找不到元素。

证据链：

1. 本次改动未触碰 `chat/` 目录任何文件；
2. `git diff` 显示该文件的本地修改正是移除附件按钮与 `ChatAttachmentTray`；
3. 将该测试文件单独运行（`vitest run chat/page.test.tsx`）结果一致：8 通过 / 2 失败，失败点均为按钮定位。

处理建议：若「隐藏附件入口」是产品意图，应同步更新/跳过这 2 个用例；若非意图，恢复该文件后测试即可全绿。本次不代为修改。

## 五、与本次改动相关的专项验证

- 语言注册：`RESOURCES`（en / zh-Hans / zh-Hant / ja / ko）与 `SUPPORTED_LOCALES` 一致；两处语言选择器均含 5 种语言。
- 闪记改名：`grep -rn "灵感"` 在组件层（非 locales）无残留；zh / zh-Hant 文案均已改名。
- 路由行为（代码审读层面）：tauri 启动 pathname 为 `/home`；`/` 与 `/home` 均渲染 HomePage；web `/` 302 到 `/home`；侧边栏「主页」项在 `/` 与 `/home` 下高亮。
- 边界处理：web 无桌面桥时闪记数据不加载、麦克风按钮隐藏、待办/闪记行不可点击（避免 404）。

## 六、未覆盖项（建议后续）

1. `pnpm dev:desktop` 人工目检：主页信息流视觉、一键开录流程、语言切换后人文行显示（en/ja/ko 下该行应优雅隐藏）。
2. `pnpm dev:web` 目检：`/home` 渲染、信息流仅 笔记+待办。
3. 安装 eslint 后补跑 `pnpm lint`。
4. feed 聚合（`home/feed.ts`）与 on-this-day 尚无单元测试，建议补充（日期分组、窗口过滤、当日轮换取数均为纯函数，易测）。
