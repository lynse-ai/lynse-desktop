# CloudBase 助手登录凭据同步

微信、手机和 API Key 登录得到的当前用户 access token，由客户端通过 HTTPS 传给独立的 Lynclaw 服务。CloudBase 管理密钥、模型密钥与用户登录 token 属于不同凭据。

当前状态：CloudBase 已更新至 `lynclaw-api-051`，固定镜像为 `lynclaw-api:e7db3d32`。使用桌面重新登录后的真实 token，业务身份、CloudBase 绑定、身份匹配、轮询聊天、SSE 聊天和内部 CLI 的会议列表读取均已通过。此次真实登录的业务后端为 `https://gapp.lynse.cn`；生产后端有效新 token 尚未单独联测。客户端已生成本机测试用的 1.1.14 arm64 应用与 DMG，尚未公开发布。

```http
POST {agentBaseUrl}/api/session/backend
Authorization: {accessToken}
Content-Type: application/json

{"host":"客户端当前配置的业务后端地址"}
```

服务端必须验证该 host 属于部署允许的后端，再到这个 host 验证 token，并绑定 token 哈希与 host。聊天继续携带用户 token；执行 lynse-CLI 时使用该用户 token 和绑定的后端地址，不把用户 token 写入全局部署配置。

## 客户端行为

- 登录和恢复会话时后台注册；流式和轮询聊天等待同一注册任务完成。
- 网络异常、429 和 5xx 最多尝试三次，重试间隔为 1 秒、2 秒。单次尝试最多 8 秒，包含读取响应；原生请求即使不响应取消也不会无限等待。
- 400、401、403、404 等永久错误不自动重试。绑定失败不改变主业务登录；聊天显示错误，下一次发送可以重新注册。
- 退出登录、更新 token、更换业务或助手服务器会废弃旧绑定。聊天提交与轮询绑定发起时的用户 token，旧响应不能结束新账号的登录。
- 同步和 CloudBase 聊天只发送用户 token，不发送账户 API Key。手机或微信登录未返回 API Key 时，清除上一次登录遗留的 API Key。
- 使用原业务网关的聊天及 WorkBuddy 继续使用原有流程。

## 2026-10-16 线上检查

客户端默认地址为 `https://lynclaw-api-319577-10-1401959758.sh.run.tcloudbase.com`。

- `GET /health` 返回 200，响应为 `{"status":"ok"}`。
- 不带凭据的 `POST /api/session/backend` 返回 404，响应为 `{"detail":"Not Found"}`。
- `GET /openapi.json` 返回 200；接口列表包含聊天与身份查询接口，但不包含 `/api/session/backend`。

首轮检查时，CloudBase 部署尚未提供绑定接口。客户端补强不能替代后端部署；绑定前置检查会明确提示“助手服务需要更新，请更新后重试”，避免未绑定时使用部署默认后端。后续部署结果见下文。

本地 Lynclaw 仓库 `runtime/api_server.py` 已有该接口，`runtime/session_binding.py` 已有绑定存储，`runtime/http_chat.py` 已将绑定 host 注入执行上下文。上线时需使用包含这些代码的镜像，并确认部署允许的后端包含客户端实际选择的业务地址。上述首轮检查没有更新 CloudBase 部署。

## 2026-10-16 构建与真实凭据检查

用户随后授权继续构建及使用已有真实凭据联测，检查结果如下：

- 后端构建源为已提交的 `139cc610`；CNB 固定镜像为 `docker.cnb.cool/lynse.ai/lynse-lynclaw/lynclaw-api:e7db3d32`，摘要为 `sha256:da708f8075957c58ffb165f1c129eab993234be79efd02090ce8c3370d2b7266`。
- 该固定标签已通过 HTTPS 匿名读取验证（HTTP 200），包含 `linux/amd64` 镜像。构建仓已恢复骨架 `ba6180b51b293c29623059e2e1e09977de261196`，精确租约保证只撤销本次临时构建提交。
- 只读核对现有 CloudBase 服务版本为 `lynclaw-api-050`，镜像为 `lynclaw-api:3b51261d`；端口 8003，实例数 1–3，已配置生产与测试两个业务后端。
- 绑定持久化表 `lynclaw_session_backend_binding` 已存在，空结果结构查询返回 HTTP 200。
- 标准 CLI 配置中的生产 Key，以及项目 CLI 配置中的测试服 Key，分别在各自已配置的业务后端换取 token，均收到 `error.api.key.invalid`。没有更换目标后端猜测凭据的签发环境。
- 标准 CLI 配置中已有的生产 access token，在当前账号查询中收到业务码 `2000`，表示会话已失效。因此真实有效凭据联测尚未通过。
- 自动审批未授权读取桌面系统钥匙串，因此没有执行该读取。CloudBase 服务更新也因缺少明确的服务更新授权被拦截，线上版本未改动。
- 桌面项目测试 697 项通过、1 项跳过，类型检查与 lint 检查通过。后端身份和绑定相关 50 项离线测试再次通过。

构建成功不代表上线成功，也不代表真实鉴权通过。该阶段尚未完成服务更新，后续授权与发布结果见下文。Key、access token 和账号个人资料均未写入本文或测试报告。

## 授权后的 CloudBase 发布结果

用户明确授权更新 CloudBase 服务，以及读取桌面系统钥匙串中的登录 token 用于本次只读联测后，已完成发布：

- 环境：`lynse-d8g49o1i956741f9e`；服务：`lynclaw-api`。
- 实际接收流量的版本：`lynclaw-api-051`；固定镜像：`docker.cnb.cool/lynse.ai/lynse-lynclaw/lynclaw-api:e7db3d32`。
- 部署记录状态为 `normal`，`HasTraffic=true`。发布前后的端口、实例数和业务后端地址一致。
- `GET /health` 返回 200；线上 OpenAPI 已包含 `/api/session/backend`。
- 不带 token 的绑定请求返回 401；非允许的后端地址返回 400；具备 JWT 格式但签名无效的 token 返回 401。
- 首次使用不符合 JWT 格式的合成字符串时返回 503。代码核对发现该输入触发 CLI 换码流程，因此它不作为“已失效 JWT”的验证样本；此现象没有被记为有效用户鉴权通过。

系统钥匙串读取实际执行后，新版集合条目 `lynse_secrets_v1` 和旧版 `lynse_token` 条目均不存在（查询返回 44）。随后确认当前运行的是开发版 `target/debug/lynse-tauri`，它使用开发版凭据文件中的嵌套 vault，而非系统钥匙串。安装版与开发版的 WebKit 配置目录也不同，联测必须配对读取当前运行版本的服务器配置和凭据。

## 重新登录后的真实用户联测

用户完成重新登录后，从开发版实际使用的嵌套 vault 读取新 token，仅在测试进程内存中使用。当前开发版配置为 `https://gapp.lynse.cn`，助手为上述 CloudBase 地址。安装版另外保存的生产地址未作为本次 token 的签发后端。

| 检查 | 结果 | 耗时 |
| --- | --- | --- |
| 业务后端当前账号身份 | HTTP 200，业务码 200 | 79 ms |
| CloudBase 登录后端绑定 | HTTP 200，host 和已验证用户一致 | 362 ms |
| CloudBase 身份查询 | HTTP 200，与业务后端用户一致 | 78 ms |
| 轮询聊天提交 | HTTP 200 | 192 ms |
| 轮询聊天完成 | HTTP 200，状态 done，用户一致 | 13.291 s |
| SSE 聊天 | HTTP 200，收到 done，无错误事件 | 7.900 s |
| 内部 CLI 会议列表读取 | `search_meetings` 工具成功，收到 done | 9.476 s |

数据读取测试明确只查询会议列表，不修改业务数据。报告仅记录状态、身份是否一致、工具名、成功标记、回答长度和耗时，不保存 token、账号资料或会议内容。聊天联测会产生测试会话记录。

独立联测脚本已按桌面协议在聊天请求体中携带 `token`，轮询查询继续在 Authorization 头中携带同一个 token。测试期间发现的开发版/安装版配置配对错误和测试脚本漏传请求体 token 已修正，它们不计为应用链路失败。

## 首轮客户端本机测试包（已被会议修复包替代）

用户要求打包后，使用当前工作区构建 macOS arm64 客户端，版本保留为 1.1.14。构建渠道为 `official`，包含手机和微信登录入口，默认业务服务器为 `https://gapp.lynse.cn`；已有安装保存的服务器选择仍然优先生效。

- 应用：`apps/tauri/src-tauri/target/release/bundle/macos/Lynse.app`。
- 安装包：`apps/tauri/src-tauri/target/release/bundle/dmg/Lynse_1.1.14_aarch64.dmg`。
- 编译后的前端资源已确认包含 `/api/session/backend`、绑定失败提示及当前 CloudBase 地址。
- 应用使用本地 ad-hoc 签名，包含麦克风和 JIT 权限，通过 `codesign --verify --deep --strict`。此包用于本机测试，未进行 Apple 公证，不生成更新推送文件，也未上传发布。
- DMG 完整性检查通过；只读挂载后，包内应用签名检查通过，主程序 SHA-256 与构建目录中的应用一致。DMG SHA-256 为 `2e94469678a342b9d4a0ed0c5b8e7814b030cb26e78fc13a383e6459c3fe3308`。
- 开发版与安装版使用不同的 WebKit 配置及凭据存储。测试时应先退出运行中的开发版，再从新应用登录，确认助手后端选择 CloudBase。

后续已补充指定会议、发言人刷新与笔记会话隔离修复。最新安装包为 `Lynse_1.1.14_current-note-startup-fix_aarch64.dmg`，见 [指定会议修复记录](cloudbase-selected-meeting-scope.md)、[发言人刷新修复记录](cloudbase-speaker-refresh.md) 和 [笔记会话隔离记录](cloudbase-note-session-isolation.md)。本节摘要值仅对应首轮构建。

## 验证入口

- `packages/core/api/agent-session.test.ts`：使用真实 ApiClient 和受控网络响应，验证等待、重试、超时、凭据隔离、账号及服务器切换、线上 404 的处理。
- `packages/core/auth/index.test.ts`：验证各登录渠道、会话恢复和旧 API Key 清理。
- `packages/views/workspace/chat-stream-transport.test.ts`：验证绑定失败不触发流式重试或轮询回退。
