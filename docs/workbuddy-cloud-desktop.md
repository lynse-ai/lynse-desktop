# WorkBuddy 桌面云端接入与授权排查

更新：2026-10-09。桌面云端接入已完成实现与真实聊天验收，尚未发布。

## 当前交付状态

桌面 AI 聊天可切换到「WorkBuddy 云端」，创建独立会话、在原任务中连续追问、接收 ACP SSE 文字与工具进度、显示审批/问卷与产物。保存 Lynse 会话与 `task_id` 的映射；任务凭证不写入聊天历史。选择历史会话时通过 `session/load` 恢复回放，回放与新回复分开。

真实用户已完成云端授权，并确认回复正常结束、连续追问正常。18:59:38 与 19:00:49 的真实日志确认 session/prompt 返回 HTTP 200 SSE 正文，桥接现在会处理其中的结束结果。审批、产物下载与长任务远端取消仍保留为后续真实场景验证项。

Rust 使用原生 HTTP 与 Tauri Channel 保持 SSE，POST 与 GET 使用同一任务凭证和 `Acp-Connection-Id`。连接归属原窗口，窗口销毁时关闭。请求仅允许指定 WorkBuddy/沙箱 HTTPS 域名，禁用重定向。登录用户或后端变化会废弃旧凭证和迟到事件。断线后不会自动重新提交已发送的 prompt。

Web 保留原本的本地助理模式。桌面旧的本地 WorkBuddy 历史可查看。会议记录与笔记不会自动发送给 WorkBuddy。

主要文件：

- `packages/core/auth/workbuddy.ts`：后端授权、令牌刷新、身份隔离与脱敏诊断。
- `packages/core/workbuddy/`：tasks API、产物请求、SSE 与 JSON-RPC。
- `apps/tauri/src/workbuddy-bridge.ts`、`apps/tauri/src-tauri/src/workbuddy.rs`：原生流式桥接。
- `packages/views/workspace/workbuddy-cloud-chat-transport.ts`：云端回合、历史与交互映射。
- `packages/views/workspace/hooks/use-chat-store.ts`、`chat-history.ts`：会话隔离与持久化。
- `packages/views/chat/`、`workspace/ConfirmDialog.tsx`：入口、流式消息、产物与用户选择。

## 验证

| 验证 | 结果 |
| --- | --- |
| Core 授权、tasks 与 ACP 单测 | 共 34 项通过；授权单测 24 项，包含云端入口申请读取与执行权限、联系人与积分兑换权限过滤、身份切换、取消后丢弃迟到授权、刷新与脱敏诊断 |
| 桌面原生桥接单测 | 8 项通过，新增 HTTP 200 JSON/SSE 结果结束待处理回合、忽略 ACK、关闭后丢弃迟到 POST 结果；保留中文分片与凭证脱敏验证 |
| Views 相关 8 个测试文件 | 76 项通过；后续受影响的子集 29 项再次通过 |
| 设置状态重置回归 | 3 项通过：资料权限不显示云端已连接，重置取消授权等待，迟到刷新不恢复旧状态 |
| 桌面 renderer 模拟端到端 | 2 个场景通过：两个独立任务、中文流式分片、原任务追问、同 ID 审批回复、Markdown 产物、不持久化凭证；设置中的资料授权提示与本机状态重置 |
| Core / Views TypeScript 与受影响文件 ESLint | 通过 |
| Rust cargo check 与 URL 边界单测 | 通过；新增 Cloud Studio 沙箱地址与域名伪装、HTTP、用户信息、非标准端口的边界用例通过，调试程序重新编译启动成功 |
| Vite desktop build、五种语言文案核对 | 通过 |
| 真实用户 OAuth | 18:03:35 请求显式包含任务读取与执行权限；用户确认新增读取权限后的授权成功 |
| 真实云端任务、回复结束与追问 | 用户确认正常；两轮 session/prompt 的 HTTP 200 SSE 正文已处理 |
| 真实审批、产物与远端取消 | 模拟验证与相关测试通过；尚未真实场景验收 |

提交范围的隔离 `pnpm test` 检查通过：527 项通过、1 项真实后端测试按配置跳过。修正了与已合入 Windows FunASR 支持不一致的旧测试，补充 Web 本地模式纯附件回复的兼容回归，并恢复本机缺失的 Vitest 依赖链接。`pnpm typecheck`、`pnpm lint`、`pnpm i18n:check` 与正式渠道 Vite desktop build 均通过。模拟 E2E 中录音恢复 IPC 默认返回 null 会产生既存 `.find` 控制台错误；本次 WorkBuddy 流程断言通过。

## 是否需要 mcp.lynse.cn

当前需求是 **Lynse 调用 WorkBuddy 云端**：Lynse 后端承接 WorkBuddy OAuth 回调并保管应用密钥与刷新令牌，桌面端调用 WorkBuddy tasks/ACP。

需要后端 OAuth 能力，但不要求新建独立登录服务器或采用特定域名。既有业务后端可以提供这组接口，`mcp.lynse.cn` 也可以承载，但仅新增域名不会修复参数缺失。

如果另一个目标是 **让 WorkBuddy 调用 Lynse 的会议、笔记等工具**，才涉及 Lynse MCP 服务与对应的 OAuth 资源授权。这不是当前桌面云端聊天的依赖。[WorkBuddy 连接器文档](https://open.workbuddy.cn/docs/connector)

当前桌面依赖的既有后端契约：

| 接口 | 职责 |
| --- | --- |
| `GET /api/auth/workbuddy/authorize` | 按已登录 Lynse 用户生成授权 URL 与 state，返回 `{authorizeUrl,state}` |
| 浏览器回调，实际路径由 `redirect_uri` 配置 | 接收 code/state，校验一次性 state，换取并存储该用户的凭证，重定向到结果页 |
| `GET /api/auth/workbuddy/token` | 返回当前用户授权状态、accessToken、openId、scope、expiresAt |
| `POST /api/auth/workbuddy/token/refresh` | 服务端用 refresh token 刷新 access token |

## 当前授权失败

用户返回的结果 URL：

`https://www.lynse.cn/workbuddy/bind-result?status=fail&reason=error.missing.parameters`

这个地址是结果页，不能仅凭它确定实际 `redirect_uri`、缺失字段或具体责任层。排查上述失败时，客户端从后端取得 `authorizeUrl` 后原样打开。后续按用户要求新增联系人权限过滤，说明见下文；客户端不会自行调用回调，也不持有应用密钥。

14:38:40 的本机脱敏诊断确认：授权入口是 `https://www.workbuddy.cn/openapi/v2/authorize`，实际回调入口是 `https://api.lynse.cn/api/auth/workbuddy/callback`。`response_type=code`、client_id、redirect_uri、state 均存在，URL state 与后端 DTO 一致。scope 显式包含 `user.task.invokable`，但不含 `user.task.readable`。后者是云端授权配置缺口，不足以证明是本次 `error.missing.parameters` 的原因。

重置后，14:48:22 与 14:48:48 两次授权诊断仍得到相同配置，且新增 backendOrigin 确认为 `https://api.lynse.cn`，与回调域名一致。用户再次报告相同的失败结果页。本机状态重置不能修复授权回调链路；目前没有授权开始与回调落在不同域名的证据，仍需后端核对这些时间点的回调请求参数与处理日志。

之后 17:26:04 与 17:26:24 的日志显示，授权发起后端已改为测试服 `https://gapp.lynse.cn`，但回调仍指向 `https://api.lynse.cn/api/auth/workbuddy/callback`。这些后续尝试存在请求与回调跨环境的配置迹象，应核对 state 存储与回调处理是否共享；它不能解释此前同域名尝试的所有失败。17:39 已重新启动最新版桌面调试窗口，待本次浏览器授权确认。

最新版真实重连在 17:43:08 与 17:45:24 记录 `contactReadable:false`，确认打开的授权链接已排除联系人权限。仍为测试服发起、正式服回调，必需参数存在、URL state 与 DTO 一致，`taskReadable:false` / `taskInvokable:true`。用户仍到达 `error.missing.parameters` 失败页。联系人权限过滤已完成实际验证；真实授权仍失败，应优先修正测试服回调配置，并检查对应浏览器回调实际收到的 code/state，而不是继续重置客户端或猜测具体缺失字段。

用户进一步提供的完整授权 URL 确认，scope 为 `user.profile.readable user.contact.readable user.credit.exchange user.task.invokable user.localassistant.readable user.localassistant.invokable`，缺少 `user.task.readable`。URL 中的 `+` 是查询参数中空格的编码，初始授权 URL 不携带 code 属于正常流程。当前云端聊天所需范围可配置为 `user.profile.readable user.task.readable user.task.invokable`；必须同时核对 WorkBuddy 开放平台授权列表与后端 scope 配置。本说明不保存该链接的 client ID 或 state 值。

用户随后明确要求去掉 `user.contact.readable`。`startWorkBuddyAuthorization()` 现在会从后端返回的显式 scope 列表中剔除这一项，其他权限与 client_id、redirect_uri、state 参数值保留。设置与聊天两个授权入口共用该逻辑。后端未提供显式 scope、过滤后为空时拒绝打开授权页，避免 WorkBuddy 回退为申请完整登记列表。后端配置仍应同步删除这项权限；已有服务端授权需通过新的授权结果更新，客户端过滤不会撤销既有上游授权。

### 原始回调确认的失败原因

用户提供了 WorkBuddy 实际回调的错误参数：`error=invalid_scope`，`error_description=scope "user.credit.exchange" not granted to application`。回调包含 state，但没有 code。因此本次授权在 WorkBuddy 侧就因应用未获准积分兑换权限而失败；此前结果页的 `error.missing.parameters` 与后端未区分 OAuth 错误回调、直接检查 code 的行为相符，具体分支仍须查服务端源码。

客户端现在同时排除 `user.contact.readable` 和 `user.credit.exchange`，保留其余权限与回调、state 参数值。22 项授权测试通过，包含实际打开链接不请求这两项权限、参数值保留、过滤后为空时拒绝请求的验证。该修改用于移除与聊天无关且阻塞授权的积分兑换申请，不会自动增加尚未确认获准的其他权限。

后端应同步移除这两项请求配置，并在回调中校验 state、处理 error/error_description 分支，不能把 invalid_scope 统一显示成“缺少参数”。请求和回调跨环境仍是另一个待核对的配置问题，但这条原始回调已经直接证明了本次 WorkBuddy 拒绝授权的原因。云端任务读取权限 user.task.readable 仍需在开放平台获准并加入后端配置。[WorkBuddy 权限申请说明](https://open.workbuddy.cn/docs/third-party-app)

### 授权成功后的云端权限补齐

17:57:34 日志确认请求与回调都在正式服 api.lynse.cn，联系人和积分兑换权限均为 false。用户随后确认浏览器授权成功，并提供服务端实际 grant：`user.profile.readable user.task.invokable user.localassistant.readable user.localassistant.invokable`，到期时间为 2026-10-10 17:57:45。该 grant 缺少云端任务读取权限；按原链接反复授权无法补齐。

桌面设置与云端聊天入口现向共用授权流程传入 cloud 模式，显式申请最小的三个 scopes：`user.profile.readable user.task.readable user.task.invokable`。Web 本地模式仍按后端显式列表过滤联系人与积分兑换权限。云端权限常量在 core/workbuddy/scopes.ts 中共用，避免申请列表与运行时校验分歧。回调 URI 和 state 参数值保留。

新的 task.readable 需要用户在浏览器中确认，并要求应用在 WorkBuddy 平台已获准该项。如果平台返回 `invalid_scope ... user.task.readable ... not granted`，则由应用管理者申请并获准该权限；客户端无法绕过审批。此轮修改不等于真实云端聊天已验收。

用户截图中已有绑定仅包含 `user.profile.readable`。桌面设置现在会显示「需补充云端授权」，避免把资料授权当作云端已就绪。

WorkBuddy 文档规定授权页需要 `response_type=code`、`client_id`、`redirect_uri`；state 应生成并校验。确认授权后，WorkBuddy 回调携带 **code** 与 **state**。换取 token 时须使用与授权请求字节一致的 `redirect_uri`，请求格式为 `application/x-www-form-urlencoded`。[官方 Open API 文档](https://open.workbuddy.cn/docs/openapi)

提供给后端同事的核查项：

1. 检查本次 authorize 响应的必需参数、state 与 DTO 是否一致，云端 scope 是否覆盖 `user.task.readable user.task.invokable`。不显式传 scope 时使用平台登记的完整授权列表。
2. 核对平台登记、授权 URL 与 token exchange 三处 `redirect_uri` 完全一致，并指向处理授权的后端回调；结果页由后端完成处理后跳转。
3. 找到与这次失败对应的回调访问日志，仅记录 code/state 是否存在、参数名、路由与错误键。核对控制器接受的是查询参数 `code` / `state`，以及网关是否保留查询串。不得记录 code/state/令牌完整值。
4. 如果 WorkBuddy 返回的是拒绝或错误参数，应区分“用户拒绝/平台错误”与“缺少参数”，不要进入 code 换取流程。
5. 回调不应要求浏览器携带桌面 Authorization 头。授权开始时的 state 服务端记录绑定已认证的 Lynse 用户、后端环境、过期时间与已使用状态；回调通过它定位用户。
6. 校验 state 后交换并保存凭证，仅该已登录用户可读取自己的授权。密钥和 refresh token 留在后端；令牌接口不得公开。
7. 检查测试/生产环境的 state 存储和回调是否一致，避免授权开始和回调落在不同环境。

建议后端增加按 state 查询本次授权结果的受认证接口。当前客户端只能轮询已存储绑定；无法即时展示浏览器上这次失败的原因，已绑定账号的自动刷新也可能使绑定指纹变化。

## 本机脱敏诊断

重新点击连接后，桌面日志产生 `[workbuddy-auth]` 记录：请求后端 origin、授权入口和回调入口（不含 query/fragment）、必要参数是否存在、state 是否匹配、联系人与积分兑换权限是否还被请求、云端 scope 是否显式包含。不会记录 client ID、state 值、code、access token、refresh token 或 client secret。日志入口为 macOS `~/Library/Logs/com.lynse.sparknote/`。

收到这条记录后可以判断授权起始配置；回调是否收到 code/state 仍须由后端访问日志确认。无需让用户发送授权码或令牌。

新增任务读取权限的授权成功后，实际聊天出现 `untrusted WorkBuddy cloud URL`。该错误来自 Rust `cloud_url` 校验，发生在发送 ACP HTTP 请求之前。桌面桥接记录 `[workbuddy-acp]` 的 protocol、hostname、port；不记录路径、query、fragment 或任务凭证。

18:13:45 与 18:13:49 的真实重试确认任务接口返回 `*.e2b.sh2.sandbox.cloudstudio.club`。此前白名单仅覆盖 WorkBuddy 与 agentos-run.net 子域名，遗漏了该沙箱部署。Cloud Studio 官方文档列出其平台域名为 cloudstudio.club；结合本次 WorkBuddy tasks 接口实际返回地址，白名单已补充 `*.sandbox.cloudstudio.club`，未扩展到所有 Cloud Studio 用户预览域名。继续要求 HTTPS、标准 443 端口、无 URL 用户信息，且禁用重定向。[Cloud Studio URL 说明](https://cloudstudio.net/docs/guide/code_editing/FAQ/url-configuration/)

对应 Rust 边界单测通过，包含两个区域的沙箱地址与产物路径，以及域名伪装、非沙箱 Cloud Studio 地址、HTTP、URL 用户信息、非标准端口的拒绝用例。18:15:07 新版原生调试程序已启动；尚未验收真实 ACP 首轮和连续追问。

修正域名后用户报告 `WorkBuddy ACP request failed (406)`。当前实现的 GET 已带 Accept: text/event-stream；对任务沙箱 /acp 不带令牌的 GET 探测分别使用仅 SSE 和 JSON+SSE 两种 Accept，均返回 401。这说明请求到达沙箱鉴权，但不能证明带令牌后的内容协商成功。POST 原先没有显式 Accept，现补充 `application/json, text/event-stream`，作为内容协商兼容修正；真实 406 的 GET/POST 阶段仍需重试日志确认。新增原生日志 `[workbuddy-acp-http]` 记录 method/status；POST 406 时仅记录错误体是否包含 JSON/SSE 格式名称，不记录响应正文、连接 ID 或凭证。POST 构造单测通过，验证实际发送的 Accept、Content-Type、任务凭证、连接标识与 JSON-RPC 请求体。

补齐 Accept 后，18:27:47 与 18:31:18 的真实 GET 均返回 200，紧接着第一条初始化 POST 返回 400。桌面新增仅针对 initialize 失败的 `[workbuddy-acp-initialize]` 诊断，提取错误原因并移除任务凭证、连接 ID、原生句柄、URL；不会记录后续聊天 prompt 的错误正文。18:33:24 实际错误为 `{"error":"invalid JSON-RPC"}`，因此本次 400 已确认来自 ACP 初始化，不能套用 OAuth 错误表中的 unsupported_response_type 或 device_auth expired_token。

当前客户端请求 ID 原为 lynse-1 这样的字符串，现按 WorkBuddy 官方示例改为递增数字；服务器发起的审批请求 ID 仍原样回复。initialize 参数也与示例保持一致，仅包含 protocolVersion 与 clientCapabilities。该调整已使真实初始化与加载成功、收到真实文字回复；服务端未指出具体拒绝字段，不据此断言 WorkBuddy 全面禁止字符串 ID。Core ACP 5 项与云端聊天 12 项测试通过，涵盖数字 ID 关联响应、审批 ID 保留、原任务追问与流式结束；Core/Views 类型检查和受影响文件 ESLint 通过。[官方 ACP 调用示例](https://open.workbuddy.cn/docs/openapi)

上述格式调整后用户已收到真实文字回复，初始化与加载的 POST 返回 202，后续 POST 返回 200；用户随后报告回合一直等待且点击停止无效。原桥接忽略全部成功 POST 正文，只等待 GET SSE 的终止结果；现兼容 HTTP 200 正文中的 JSON-RPC response 和 SSE frames，将它们交给同一个请求 ID 关联处理。HTTP 202 与普通 HTTP 200 ACK 仍不能结束回合，已关闭连接的迟到结果丢弃。新增 `[workbuddy-acp-post]` 只记录格式、ID 是否匹配、是否包含 stopReason 等布尔元数据，不记录响应内容。

停止按钮现立即清除本地运行状态、等待标记与 WorkBuddy 审批，保留已收到的内容并允许追问；远端取消与连接清理仍按原有有界流程进行。旧回合的迟到消息或完成不能覆盖新回合。桌面桥接 8 项、云端 transport/store 18 项、通用聊天 store 16 项共 42 项通过；Views 类型检查及受影响文件 ESLint 通过。

最后真实重试中，18:59:38 与 19:00:49 的 session/prompt 均返回 HTTP 200，桥接诊断 sse=true。用户确认「回复正常结束，追问也正常」，因此真实云端回复结束与连续追问已验收。该诊断中 rpcResponse/matchesRequest/stopReasonPresent 三个布尔值仅针对 JSON 正文计算，不表示 SSE 正文缺少结束结果。停止按钮在网络不返回时立即结束本地等待已由回归测试覆盖；用户此次未单独确认真实远端取消效果。

## 重置本机状态

设置卡片「刷新状态」旁已提供「重置状态」。它取消本轮授权等待、清除内存凭证与账号显示、回到「待重新连接」。取消或重置后的迟到响应不会覆盖新状态。重置保留聊天历史，不会调用不存在的服务端解绑接口。

点击授权可以重新连接，点击刷新则重新读取服务端已有绑定。若需要彻底删除绑定，后端需提供受认证的解绑接口，并负责删除已存凭证及适用的上游撤销操作；当前前端契约没有该接口。

## 真实服务仍需确认

- `POST /tasks` 的 prompt 是否已经执行首轮；当前按文档示例在 initialize/load 后提交一次 session/prompt，需确认不会与创建行为重复。
- WorkBuddy AskQuestion 扩展的真实 params 与 response 结构；现有模拟验证的是本实现约定。
- 实际任务返回的 sandboxDataLink / sandboxLink 与产物 URI、文件下载权限。不能从网关 `/sessions/{id}` 地址任意推导沙箱地址。
- session/cancel 的实际支持、历史回放与任务凭证到期后的恢复行为。
