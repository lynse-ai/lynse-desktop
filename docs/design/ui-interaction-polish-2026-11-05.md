# Lynse 布局与交互优化记录

日期：2026 年 11 月 5 日

本轮根据 Magpie 研究中可迁移的交互原则，优化 Lynse 自己的聊天和录音详情流程。布局依据现有侧栏、标题栏、内容区与任务状态组织。

## 已实现的变化

### 聊天历史、正文和输入区同步

- 历史抽屉与两个内容区共用 200ms 时长和现有 drawer 曲线。
- 用可中断的 CSS transition 处理快速开关，从当前画面继续。
- 抽屉保持挂载，关闭再打开后保留历史列表位置；关闭时不可聚焦，也不进入辅助技术的可用区域。
- 打开后焦点进入历史面板；Escape 或关闭按钮将焦点交还标题栏入口。
- 可用内容宽度小于 672px 时，历史覆盖显示，输入区保持完整宽度。点击外部或选择会话后关闭覆盖面板。
- 系统减少动态设置下直接切换布局。
- 隐藏的历史面板暂停活动图标；流式消息内容变化时，列表只在实际元信息改变后重绘。

实现：[聊天页](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/views/chat/page.tsx)、[布局与过渡](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/views/chat/chat-layout.css)、[历史列表](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/views/chat/chat-history-sidebar.tsx)。

### 标题栏和内容分隔线对齐

桌面图标栏实际宽度为 48px，Web 侧栏为 208px；标题栏原先使用另一组固定数字。现由两处共享宽度定义，并计入原生材质模式下内容卡片的内缩和边框，避免打开历史或文件列表后分隔线错位。

实现：[共享尺寸](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/views/layout/sidebar-metrics.ts)、[标题栏](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/views/layout/app-title-bar.tsx)、[侧栏](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/views/layout/lynse-sidebar.tsx)。

### 阅读位置与新消息跟随

聊天页和录音侧栏共用滚动逻辑：

- 位于底部时，跟随流式内容、延后加载的图片以及窗口尺寸变化。
- 上翻阅读旧内容时，更新不会强制滚到底部。
- 切换会话后定位到新会话最新内容。
- 通过 ResizeObserver 观察内容和可视区域，用 requestAnimationFrame 合并更新。
- 只观察顶层节点变化，避免为每个流式文本节点注册观察。
- 主动返回最新内容时遵循系统减少动态设置。

实现：[共享滚动逻辑](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/ui/hooks/use-auto-scroll.ts)、[录音聊天侧栏](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/views/workspace/right-panel/chat-panel.tsx)。

### 总结失败在对应标签内恢复

- 新增总结失败后，错误只占据失败标签，原有总结、大纲和转写仍可查看。
- 失败标签提供重试入口；取消模板选择后保留失败状态。
- 真正开始重试时复用原标签位置，避免累积失败标签。
- 总结任务回包与查询刷新无论按什么顺序到达，完成的总结只显示一次。
- 完成后台任务时，用户已切换到大纲、转写或其他文件的，不主动抢回总结页。
- 本地重新总结先进入忙碌状态；完成后检查文件与标签是否仍是用户原先的目标。

实现：[录音详情与总结状态](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/views/workspace/content-panel.tsx)。

### 任务反馈与输入表面统一

- 总结生成和本地转写使用同一任务状态布局和活动指示器。
- 等待文字保持静止，状态由文字与图形共同表达。
- 生成、转写、上传、重试复用共享 Button 的焦点、禁用和按压反馈。
- 为单色主要操作增加 contrast 变体。
- 聊天输入框使用主题卡片、输入边界与焦点颜色，阴影提取为共享语义变量。
- 历史元信息采用 11px 等宽数字，补充完整标题提示和键盘焦点样式。

实现：[任务状态组件](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/views/workspace/task-state.tsx)、[共享按钮](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/ui/components/ui/button.tsx)、[主题变量](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/ui/styles/tokens.css)。

### 更新说明分类与阅读布局

- 更新弹窗直接显示目标版本和当前版本，按“新功能、改进、错误修复”等真实标题展示列表与条目数量。
- 正文采用更宽的阅读区域、悬挂缩进和分组间距；长内容独立滚动，版本标题和底部操作区固定可见。
- 兼容既有纯文本、项目符号和未知标题；保留未知内容，使用安全的 React 文本和有限行内格式。
- About 页面复用同一说明组件。五种语言均有对应分类标签，本地 1.3.0 说明已按原有内容重新归类。
- 修复主界面中更新弹窗重复挂载的问题，避免两个对话框同时争夺焦点和辅助技术的可见区域。
- 检查失败时提供重新检查；下载中显示实际进度并阻止关闭或重复安装，失败后可重试。

当前更新源只提供目标版本说明，因此界面如实标注“此版本更新内容”。跨版本合并和逐条版本出处尚未接入；本地分类文案尚未发布到线上更新源。

实现：[更新弹窗](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/views/app-update-dialog.tsx)、[说明组件](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/views/release-notes-content.tsx)、[格式解析](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/views/release-notes.ts)。

## 验证

| 检查 | 结果 |
| --- | --- |
| 工作区 TypeScript 检查 | 通过 |
| 修改的 TS/TSX 文件 ESLint | 通过 |
| 相关单元与组件测试 | 49 项通过，含流式渲染工作量检查 |
| 桌面渲染器界面测试 | 8 项通过 |
| 更新说明及相关布局、语言测试 | 30 项通过 |
| 更新说明界面测试 | 3 项通过，含长正文、400px 深色中文窗口、下载失败与重试 |
| 桌面前端生产构建 | 通过 |

界面测试覆盖深色常用窗口、浅色 560px 窄窗、快速关闭重开、抽屉与内容逐帧对齐、标题栏分隔线、草稿与列表位置保留、焦点返回、减少动态、总结失败和原位重试，以及任务完成后继续阅读原内容。

浏览器检查运行真实桌面渲染器，使用测试专用 IPC 和本地模拟后端。未执行 macOS 原生窗口/WebKit 实机验收或安装包发布；上述结果不代表原生性能或全站无障碍审查。

复查入口：

- [滚动行为测试](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/views/chat/auto-scroll.test.tsx)
- [聊天组件测试](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/views/chat/page.test.tsx)
- [界面交互测试](/Users/lynse/Documents/lynse-app/lynse-desktop/e2e/tests-desktop/07-ui-interaction.spec.ts)
- [更新说明界面测试](/Users/lynse/Documents/lynse-app/lynse-desktop/e2e/tests-desktop/10-update-details.spec.ts)

主要验证命令：

```sh
pnpm typecheck
pnpm --filter @lynse/views exec vitest run chat/auto-scroll.test.tsx chat/page.test.tsx chat/page.streaming-perf.test.tsx workspace/right-panel/chat-panel.test.tsx workspace/hooks/use-files.test.ts
cd e2e
pnpm exec playwright test --config playwright.desktop.config.ts 07-ui-interaction 01-desktop-chat 05-chat-progress --workers=2
cd ..
pnpm --filter @lynse/tauri exec vite build
```

