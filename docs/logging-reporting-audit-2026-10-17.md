# 日志与问题上报检查

检查日期：2026-10-17。范围：当前桌面客户端、共享 API 客户端、CNB 上报云函数，以及本机 Lynclaw 的 HTTP 日志与追踪入口。依据为当前源码、当天已有客户端日志和离线模拟验证。

本次未修改业务代码、未部署云函数、未读取上报通道的真实凭据，也未创建真实工单。线上函数版本、网关鉴权、日志开关、Langfuse 实际入库和告警配置未做线上核验。

## 结论

现有系统能保存部分错误并接收手动反馈，但尚不足以完成“问题发生 → 证据完整到达 → 关联客户端和服务端 → 修复 → 验证受影响版本恢复”的闭环。

**软件版本在手动反馈中有；精确操作系统版本没有明确采集和上报。普通业务请求也没有发送软件版本。**

| 信息 / 能力 | 当前情况 |
| --- | --- |
| 手动反馈的软件版本 | 有，读取宿主包版本，CNB 正文和 GitHub 预填链接都包含 |
| 平台 | 反馈包含 darwin / win32 / linux；业务请求带 desktop / web 标识 |
| 系统版本与系统构建号 | 没有独立字段；User-Agent 不能作为精确系统版本的可靠来源 |
| 软件构建号 | 宿主在 macOS 已读取 CFBundleVersion，但报告正文丢弃了这个字段；其他平台当前返回空值 |
| CPU 架构 / 发布渠道 / 源码提交 | 当前反馈没有这些字段 |
| 普通业务与流式请求的客户端版本 | identity 中虽有 version / os 类型，实际只发送 X-Client-Platform |
| 前端错误落盘 | 捕获未处理错误、Promise rejection、console.warn / error；不捕获 console.info / log |
| 原生日志 | 每日文件、启动时清理 30 天前未修改的文件、Rust panic 记录、关闭输出管道容错 |
| 服务端日志 | Lynclaw 有分类日志、异常和降级记录、阶段耗时、Langfuse trace 与子进程上下文传递 |
| 自动故障上报 | 未发现通用自动崩溃上报、卡死检测与下次启动补报闭环；Rust panic 落盘不等于覆盖全部崩溃 |
| 手动反馈回执 | 成功后显示工单编号；当前 UI 无报告历史、状态查询或修复版本验证 |

版本字段来源：[宿主信息](/Users/lynse/Documents/lynse-app/lynse-desktop/apps/tauri/src-tauri/src/lib.rs:4253)、[反馈正文](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/views/report-problem-dialog.tsx:49)、[GitHub 环境正文](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/views/diagnostics.ts:158)、[业务请求头](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/core/api/client.ts:266)。

## 需要补齐的问题

### P0：上报通道下发 CNB 写入凭据

云函数 GET 分支直接返回环境变量中的 CNB_TOKEN，没有函数内鉴权、有效期或单次使用限制。原生客户端获取它时只带 Accept 请求头，再持此凭据直接创建 CNB 工单。每次重新获取并不会让这个环境变量中的 token 自动变成短期凭据。

离线运行原函数、使用模拟环境变量，已复现无 Authorization 的 GET 返回配置的模拟 token。该结论证明本地源码行为；没有访问线上 GET，线上部署是否同版、外层网关是否限制访问仍待核验。

应改为服务端持有 CNB 凭据，客户端提交经过验证的报告；截图通过受限、短期有效的上传授权处理，不向客户端返回长期 CNB 凭据。部署核对后，若确认线上也存在此暴露路径，应关闭入口并轮换相关凭据。

证据：[云函数 GET](/Users/lynse/Documents/lynse-app/lynse-desktop/cloudfunctions/cnb-report/index.js:109)、[原生获取凭据](/Users/lynse/Documents/lynse-app/lynse-desktop/apps/tauri/src-tauri/src/cnb_report.rs:96)。

> 处置记录（2026-10-17 当天）：已按本节方案改造并部署。云函数移除 GET 凭据入口（两个线上域名实测均返回 405），新增 `action: "upload"` 返回 CNB 预签名上传槽位（客户端凭匿名 PUT 直传字节，不接触凭据），工单改由函数服务端创建；客户端 Rust 路径同步改为「申请槽位 → 直传 → 提交」两段式，不再持有任何 CNB 凭据；cargo 3 项单测通过；线上 upload→PUT→submit 端到端验证通过（验证工单 lynse.ai/lynse-desktop#9，确认后可关闭）。**token 轮换已全部完成（2026-10-17）**：新令牌（名 "issue"，repo-issue:rw 仅限 lynse.ai/lynse-desktop）已写入函数 env 并经线上建单回归确认生效（验证工单 #10）；旧令牌（名 "Issue"）已从 CNB 令牌列表删除，直连验证返回 401（已失效）。**本 P0 关闭**。令牌管理入口：cnb.cool → 头像 → 个人设置 → 访问令牌（cnb.cool/profile/token）；CNB OpenAPI 无令牌管理端点，吊销只能网页端操作。另注：账户下还有一个名 "MacBook air" 的令牌（应用于全部仓库，registry-package:rw + repo-code:rw），从未经过上报通道暴露，不涉本次事件，但其范围较宽，可自行评估是否收紧。已发布客户端（v1.1.14）的直连路径随 GET 关闭失效，报告自动降级为 GitHub 预填链接，属预期。另注意：CloudBase getFunctionDetail 接口会在返回中明文回显 env 变量值，查询函数详情时不要把输出原样转发。

### P1：版本信息无法区分同版本的不同测试包

报告有 appVersion，但没有 build、commit、channel、arch、osVersion、osBuild。启动日志也没有统一环境摘要。检查当天本机日志，只发现 7 条前端启动标记，没有明确的软件或系统版本字段。本机当前包的 version 和 build 都是 1.1.14，仅凭报告中的版本号无法区分多个同版本测试包。

应由宿主统一生成经过允许字段筛选的环境信息，写入启动记录、诊断报告，并随必要请求传到服务端。Web 无法可靠获取的系统字段应显式标为不可用，不根据 UA 猜测。

### P1：客户端、服务端与工单没有贯穿的关联信息

聊天已生成 requestId，服务端也有 session_id、task_id 和 Langfuse trace；这些是已有基础，但反馈正文没有收集相关标识，也没有统一启动会话和报告标识。通用 API 客户端没有统一请求开始、结束、耗时、错误码的结构化记录。

针对近期笔记和侧栏问题，至少应能按一次操作查到：当前笔记范围、聊天会话、请求、写操作实际目标、执行结果、缓存失效与界面刷新结果。记录资源标识和状态即可，不需要记录笔记正文或完整对话。

建议贯穿 bootId → actionId / requestId → taskId / traceId → reportId；仅有聊天去重 requestId 不等于诊断链路已打通。

服务端证据：[HTTP 记录](/Users/lynse/Documents/lynclaw/runtime/api_server.py:703)、[Langfuse 会话和 trace](/Users/lynse/Documents/lynclaw/runtime/langfuse_tracing.py:159)。分类日志在未设置相关开关时默认关闭，不能据源码存在就认定线上已采集。

### P1：报告成功不保证证据完整

反馈窗口挂载时只读一次日志，失败静默忽略；提交前没有重新读取。CNB 正文最多保留最近 6000 个字符，GitHub 预填链接保留 4000 个字符。日志快速增长、反馈窗口打开后继续复现等情况下，关键上下文可能丢失。

宿主 tail 默认输出 16 KiB、最大 64 KiB，但当前实现先读完整文件再截尾，没有限制读取成本。源码中的本地报告包导出能复制原始日志，但当前反馈提交并没有调用这一导出路径。

应在提交时刷新采集，按故障时间保留有限的前后文，并显示日志、截图是否采集和上传成功。报告元数据应包含时间范围、截断情况和附件缺失原因。

证据：[读日志与静默失败](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/views/report-problem-dialog.tsx:124)、[正文截断](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/views/report-problem-dialog.tsx:61)、[宿主读取实现](/Users/lynse/Documents/lynse-app/lynse-desktop/apps/tauri/src-tauri/src/lib.rs:4314)。

### P1：持久采集有盲区，且没有统一脱敏

助手耗时使用 console.info，当前前端日志桥只接管 warn / error，导致该耗时记录不会进入持久文件。日志桥任何一次发送失败后，会在该窗口存活期间停止后续发送，没有恢复和健康状态提示。原生文件写入失败也采用静默容错。

前端格式化、tail 读取、报告正文和 GitHub 链接均没有统一敏感字段清洗。离线模拟已验证 token 字段中的模拟标记会原样进入日志和报告。此测试说明缺少保护，不表示本次已发现或导出真实 token。备用本地导出路径只替换 home 目录，也不能替代敏感信息清洗。Lynclaw 服务端已有按字段名处理 token / password 等的清洗逻辑，但这不覆盖客户端，亦不等于自由文本中的敏感信息都会被清洗。

应统一结构化事件与字段白名单，在落盘和上传前分别过滤凭据、个人路径及不必要正文；提供诊断内容预览与附件选择。日志写入失败应有不递归的健康状态，短暂故障恢复后能继续记录。

证据：[前端日志桥](/Users/lynse/Documents/lynse-app/lynse-desktop/apps/tauri/src/logger.ts:13)、[助手耗时](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/views/workspace/hooks/use-chat-store.ts:738)。

### P1 / P2：离线、重复提交和修复验证缺少闭环

当前提交没有持久待发送队列、reportId 幂等键和服务端去重。网络在工单已创建但回执未返回时断开，用户重试可能重复创建。云函数离线模拟中，两次相同 POST 创建了两个模拟工单；原生直连路径同样没有提交幂等机制。

成功后 UI 只显示编号，没有保存可查询的报告回执；views 接口声明 issueUrl，但原生实际只返回 number。仓库还缺少 GitHub 备用链接引用的 bug_report.yml，需核对远端对应模板，才能确认该降级路径能完整预填。

建议补齐报告持久保存、可控重试、幂等提交、稳定回执和处理状态，并把工单与修复构建、验证结果关联。日志保留另需总容量限制；仅按日期清理不能限制单日异常刷屏占用。

## 验证记录

- 原生 logging 相关测试：3 项通过，覆盖健康输出、关闭输出管道、日志文件被清理后的重建。
- 原生 cnb_report 相关测试：3 项通过，覆盖目标域名、仓库路径和工单编号解析。
- 现有关闭输出管道回归：旧实现退出码 -6，生产安全 writer 退出码 0。
- 离线执行真实 TS 编译结果，模拟宿主元数据：两条反馈路径均有软件版本，均遗漏构建号和独立系统版本；模拟敏感标记未过滤。
- 离线执行真实 API 客户端：传入 identity.version / os 后，请求中仍只有平台标识，没有发送这两个字段。
- 离线执行真实前端日志桥：错误和 rejection 可捕获，console.info 不落入该桥；一次投递失败会停用后续发送。
- 离线执行真实云函数，所有 fetch 均被模拟：无鉴权 GET 返回模拟凭据；相同 POST 未去重；没有任何真实外部写入。
- 检查当前实际日志时只输出文件大小和匹配计数，没有展示原始日志内容。

这些检查验证现状与缺口，不能作为真实线上投递、告警、修复闭环已经成功的证明。

## 最小闭环验收条件

1. 报告稳定包含 appVersion、build、channel、commit、OS 名称 / 版本 / 构建号、arch，以及故障时间和时区；无法获得的字段明确为空。
2. 一次测试操作能从客户端 actionId / requestId 查到服务端任务与 trace，并在工单中找到对应 reportId 和受影响构建；含笔记范围切换、写操作结果与刷新状态。
3. 模拟断网、超时和回执丢失后，报告仍保留，重试最终只创建一个工单；附件缺失清楚标记。
4. 模拟凭据、个人路径和正文标记不会进入不允许的日志 / 上报字段；客户端无法取得长期 CNB 写入凭据。
5. 未处理错误、受控错误、原生 panic、卡死 / 非正常退出分别有明确采集与补报策略；日志通道短暂失败后可恢复。
6. 线上能确认日志与 trace 实际到达、错误可被发现，工单关联到修复构建，并记录同一场景在该构建中的验证结果。
