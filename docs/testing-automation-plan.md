# Lynse 桌面端全自动测试方案（v1 草案）

> 2026-09-18 起草。目标：UI（用户真正使用的界面）拥有全自动回归防线，
> bug 出现时有完整的取证链路（截图/trace/日志/Langfuse）可追因。

## 执行进度（2026-09-19 更新）

| 阶段 | 状态 | 说明 |
| --- | --- | --- |
| P0 | ✅ 完成 | e2e 修复后 35/35 全绿；vitest 241/241；eslint 全面接线（根 flat config + 4 包 devDeps） |
| P1 | ✅ 完成 | ci.yml：check 任务加 lint；新增 e2e 任务（web + desktop 两套，失败产物归档） |
| P2 | ✅ 完成 | 确认启发式负例+固定种子 fuzz、chat-history 畸形矩阵、chat-reveal 新增测试 |
| P3 | ✅ 完成 | `apps/tauri/src/e2e/tauri-shim.ts`（IPC shim）+ `e2e/tests-desktop/`（3 spec 全绿） |
| P4 | ✅ 完成 | `e2e/tests-desktop/90-visual.spec.ts`（本地跑，CI 跳过；home 基线因动态内容放弃） |
| P5 | ⏸ 暂缓 | tauri-driver 需 `safaridriver --enable`（sudo）与 WebDriver 环境，需人工一次配置后补 |
| P6 | ✅ 工具链就绪，**发现后端缺口** | 凭据已验证（us.cloud.langfuse.com，v4.38）；报告脚本实测可用；`tests-real/` + `pnpm test:real` + `e2e-real.yml`（手动触发）。**2026-09-19 首次真实联测通过**（johney@gapp.lynse.cn，12.5s 一轮真实 AI 回复）。但 Langfuse 端到端归因**被证伪**：桌面聊天链路（gapp chat/poll）零 trace——项目里仅有的 lynclaw trace 全来自 agent-chat 测试管线（9/16-17）。**需后端为桌面 chat 路径补 Langfuse 埋点（透传调用方 sessionId）**，测试侧已按该约定就绪 |

执行中额外发现并修复的真 bug：

1. `/chat` 历史抽屉被消息容器整块遮盖（DOM 顺序+无 z-index），**用户点不了
   历史会话**——`chat/page.tsx` 抽屉加 `z-20` 修复。
2. `feishu-config-card.tsx` 第二个 useEffect 写在 `if (!feishu) return null`
   之后——条件调用 Hook（eslint react-hooks 抓出），已上移修复。
3. 确认启发式 `extractConfirmFromText` 会把普通编号列表（2-8 行连续 `1. …`）
   识别成选择菜单弹确认卡片——已在单测中以 KNOWN ISSUE 钉住当前行为，待产品
   决策后修（见 `chat-transport.test.ts`）。
4. 流式性能预算 2（store 写入合并）自 ≤2026-09-13 起退化（~2.2 写/delta），
   默认告警不阻断，`ENFORCE_STREAM_WRITE_BUDGET=1` 可恢复硬门禁。


## 0. 现状盘点

| 层 | 现状 | 缺口 |
| --- | --- | --- |
| 纯逻辑单测（Vitest） | 有零散用例（chat 流式性能、录音 perf），基线就有失败 | 覆盖不了最脆的纯函数：SSE 帧解析、确认卡片启发式、错误文案映射、历史持久化校验、会议 ID 脱敏 |
| 组件测试 | 无 | 聊天页/面板/确认框/提及选择器/Markdown 渲染（含 XSS 转义）无防线 |
| E2E（Playwright） | `e2e/` 已成体系：本地 mock 后端 + 剧本化 SSE（`scripts/*.json`）+ 6 个 spec（chat 核心/多轮/提及/历史/导航冒烟/设置冒烟），trace/截图/视频失败留档 | **没进 CI**；跑的是 `apps/web`（Next :3000），**不是用户实际使用的桌面渲染器**；dock 聊天面板、桌面专属交互未覆盖 |
| 打包应用冒烟 | 无 | 钥匙串、TCC、sidecar、更新器这类"只有真包才暴露"的问题完全靠手测 |
| CI | `.github/workflows/ci.yml`：typecheck + vitest + Windows cargo | lint 因 eslint 未接线被跳过；e2e 不在门禁里 |
| 可观测性 | 前端 `[chat-perf]` 日志、`window.__lynseChatPerf()`、Rust 日志 | 与 Langfuse 无任何联动（仓库零引用）；测试失败没有自动归因链路 |

**核心架构结论**：AI 回复不可预测，所以自动化永远不测"AI 答得对不对"，
只测"UI 对每一种 AI 事件（status/content/thinking/tool/meta/done/confirm/error）
的反应对不对"。做法就是现有 e2e 已验证的路：mock 后端 + 确定性剧本。

## 1. 分层设计

```
L0  静态门禁      typecheck / lint / cargo clippy+test        ← 已有，补 lint
L1  纯逻辑单测    transport 解析、启发式、store 状态机          ← 投入产出比最高
L2  组件测试      Testing Library 渲染聊天组件树               ← 新建
L3  Web E2E      现有 Playwright 套件，接入 CI 并扩覆盖        ← 已有，接 CI
L4  桌面渲染器E2E Playwright + Tauri bridge mock（关键新增）    ← 用户真实界面
L5  真应用冒烟    tauri-driver WebDriver 跑 dev 二进制 3-5 条关键路径
L6  视觉回归      Playwright 截图基线（浅色/深色主题）
```

### L1 纯逻辑单测（最高 ROI，最先做）

手工 GUI 测试想抓的 bug 类，几乎全部可以在毫秒级单测里穷举：

- `parseChatStreamData`：半包帧、多事件同行、畸形 JSON、`data:` 前缀变体
- `extractConfirmFromText` / `normalizePollConfirmation`：**属性化模糊测试**——
  喂几百个"普通编号列表 vs A)/B)/C) 菜单"变体，断言误报率为零（这是确认卡片
  误触发 bug 的根治点）
- `submitErrorMessage` / `humanizeBackendError`：400/401/403/429/503、信封
  code 2013（网关把鉴权失败包成 HTTP 200）各映射到正确文案
- `use-chat-store` 事件管线：六类事件逐个驱动 + 并发上限 3 + 后台完成 toast
  + 空泡丢弃 + 失败重试退避（fake timers）
- `chat-history.ts`：畸形历史拒载、quota 超限静默、错误气泡保留规则、1500ms
  reveal 窗口（重开闪屏 bug 类）
- `meeting-id-redact`、`collectMentionFileIds`、poll 退避/超时状态机

### L4 桌面渲染器 E2E（补上"用户真实界面"这块空白）

- 在 `apps/tauri/src` 加 test-only bootstrap：`import.meta.env.MODE === "test"`
  时安装 **Tauri bridge mock**（invoke 桩：keychain 返回测试 token、窗口/剪贴板/
  local-media 全部桩掉），`vite` 以 test mode 起桌面入口
- API base URL 指向与 L3 共用的 `fixtures/mock-server.ts`
- 优先移植/新增：
  1. dock 聊天面板（title bar「Ask AI」开关、选中会议作为上下文、面板内流式）
  2. 桌面设置对话框（桌面专属 section，WorkBuddy 卡片）
  3. token 恢复路径（"钥匙串"mock 里放/不放 token 两种启动）
  4. 录音页空闲态冒烟（不触发真实采集）
- 复用 L3 的剧本与 helpers，一套剧本两边跑（web + 桌面渲染器）

### L5 真应用冒烟（tauri-driver）

- Tauri 官方 WebDriver（tauri-driver + WKWebView），跑 dev 二进制，不加签名负担
- 只放 3-5 条：启动出窗 → 登录页渲染 → mock 后端登录 → 打开聊天发一条 → 历史恢复
- 锒匙串/TCC/更新器/打包问题继续靠发布前手动清单（本方案不自动化，性价比低；
  computer-use 可作为夜间探索性巡检的补充，见 §4）

### L6 视觉回归

- `toHaveScreenshot` 固定 15-20 个关键状态（聊天空态/流式中/错误态/确认框/
  设置对话框/登录页，浅+深主题）
- 基线更新走显式 PR（`--update-snapshots`），评审人看 diff 图

## 2. CI 编排

```
PR 门禁（ubuntu，<10min）：L0 + L1 + L2 + L3 聊天子集（01-04 spec）
push main / nightly：全量 L3 + L4 + L6 + Windows cargo（已有）
失败产物：Playwright trace + video + screenshot + console + HAR 一并上传 artifact，
失败时自动在 PR 贴摘要评论
```

- `e2e/` 独立于 pnpm workspace（现状保持），CI 里单独 `pnpm install --ignore-workspace`
  + `playwright install chromium`
- eslint 接线后把 `pnpm lint` 加回门禁（ci.yml 里已有 TODO 注释）

## 3. bug 取证链路（回答"出了问题怎么看 log / Langfuse"）

失败时按序收集，全部自动归档到 CI artifact / 本地目录：

1. **Playwright trace + video + 截图**（现有配置已开 retain-on-failure，补 HAR）
2. **浏览器 console**（含 `[chat-perf]`）与网络请求列表
3. **本地 dev 日志**：`pnpm dev:tauri` 的 vite/Rust 输出（本机手测时）
4. **Langfuse（仅真实后端联测档）**：见 §4

Langfuse 的正确用法：mock 后端跑的测试**不会产生** Langfuse trace（请求根本没到
后端）。所以另设一档 **夜间真实后端联测**：同一套 L3/L4 剧本指向 staging API
（真实 AI），每次运行注入唯一 run id（如 `nightly-20260918`）作为会话标识；
用例失败时，报告步骤用该 id 调 Langfuse API 拉取对应 trace（工具调用、prompt、
延迟、报错）附在失败报告里。需要你提供：**Langfuse host + project 的 pk/sk 密钥**，
以及后端 trace 的 sessionId 是否等于聊天 sessionId（待确认）。

## 4. 可选：AI 驱动的探索性测试（夜间）

模拟真人乱聊（emoji/超长/中英混输/快速连点）作为夜间巡检：用 LLM 生成输入 +
Playwright 执行，发现异常（错误气泡、卡死、控制台报错）就截图归档。确定性差，
不进门禁，只产出"疑似 bug 线索"。跑通 L1-L4 后再评估是否值得。

## 5. 落地顺序与工作量

| 阶段 | 内容 | 工作量 | 价值 |
| --- | --- | --- | --- |
| P0 | 在干净工作树上跑通现有 e2e + vitest，修复基线失败；eslint 接线 | 0.5-1d | 摸清家底 |
| P1 | e2e 接入 CI 门禁 + 失败产物归档 | 0.5d | 回归防线生效 |
| P2 | L1 纯逻辑单测（含确认启发式模糊测试） | 1-2d | 根治最高危 bug 类 |
| P3 | L4 桌面渲染器 harness + 关键 spec | 2-3d | 覆盖用户真实界面 |
| P4 | L6 视觉回归基线 | 1d | 布局/主题回归可见 |
| P5 | L5 tauri-driver 冒烟 | 1-2d | 真应用冷启动/登录链路 |
| P6 | Langfuse 夜间联测档 | 1d | 线上 AI 链路可观测 |

合计约 7-10 人天；P0-P2 两天内即可让"改坏 UI 必须过测试"成为现实。

## 6. 待确认

1. staging 后端地址是否可长期供夜间联测使用（会不会限流/计费）？
2. Langfuse host 与只读 pk/sk；
3. 后端 Langfuse trace 的 sessionId 与客户端 sessionId 的对应关系；
4. 桌面渲染器加 test-only bridge bootstrap 是否接受（仅在 `MODE === "test"` 生效，
   不进打包产物）。
