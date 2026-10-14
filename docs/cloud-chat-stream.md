# 云端聊天 SSE 传输

2026-10-14：云端聊天默认使用 `StreamChatTransport`，WorkBuddy 仍使用自己的传输。

## 切换依据

用户提供的当天 CloudBase 直连测量：150 字问题的 SSE 返回 70 个事件，
其中 62 个 content 块以约 100ms 间隔到达，链路没有缓冲。相同问题的
poll 使用 11 次 GET，pending 文本在约 18 秒时集中返回；更长问题出现
493 字中途文本冻结，最后被 12 字终稿替换的情况。每轮 poll 约需
11–31 次请求，而 SSE 使用一条连接。上述结果来自已有测量，本次改动
没有重新测量线上服务。

## 客户端行为

- 主后端使用 `/api/business/ai/chat/stream`；独立 agent 使用 `/api/chat/stream`。
- 提交遇到 HTTP 503、429 或 `system.error.busy` 时，最多重试两次，分别等待
  2 秒和 4 秒。身份校验失败、明确的 SSE error 帧不自动重试。
- 190 秒总截止时间从发送开始计时，包含连接、重试等待和轮询回退；回退不延长整轮时间。
- 连接报错或缺少 done 的 EOF 触发一次轮询回退；已收到 done 后的连接错误不会覆盖成功结果。
  不支持 stream 路由的 HTTP 404/405 同样可以回退。
- 回退沿用同一聊天气泡、sessionId、query、文件范围、token、确认 token 和模型配置。
  已有部分回答时，回退的 content 增量不追加到旧文本；最终 done 整段替换旧回答。
- 取消会中止 SSE 或正在进行的轮询请求，并安静结束发送；迟到事件被丢弃。
  done 之后的 confirmation 帧仍可到达确认卡片。

## API 契约与限制

`Authorization` 使用现有的裸 token 格式；身份由服务端验证 token，客户端不提交 userId。
两个提交端点使用相同的请求字段；poll 返回 `task_id` 或 `taskId`，GET 返回
pending/done/error，done 包含完整终稿、附件、来源和确认信息。

配套的 lynclaw 本地实现现已让 SSE 创建 poll task，首帧发送
`{type:"task", task_id, status}`。断流只移除读取者，客户端以原 task_id
调用 `PollChatTransport.resume()`，不重发查询。

客户端每轮生成一个随机 requestId；SSE 重试和没有收到首帧时的 poll 回退
复用同一个 ID。配套服务端按验证后的用户、会话和 requestId 去重，内容不同
返回 409。该契约须在服务端上线后才能依赖；旧部署会忽略 requestId，
无 task_id 的回退仍可能重新执行并重复已完成的工具副作用。

主动停止、切换账号及超时会对已知任务发送
`POST /api/chat/poll/{task_id}/cancel`。尚未收到 task_id 时无法显式停止
服务端任务，服务端 turn timeout 仍限制其执行时间。

服务端默认 memory 模式的任务和去重在当前进程、TTL 内有效；跨实例应使用
PG 模式。PG 模式复用现有任务主键作原子判重，判重不可用返回 503，不重新
执行。进程重启、过期或已经完成的工具操作均不由这个契约自动恢复或撤销。
配套改动尚未部署，本次没有对线上完成验证。

当天测量没有覆盖 `api.lynse.cn` 网关 SSE，也没有覆盖桌面 WKWebView 的端到端
流式读取。本次自动化测试覆盖客户端路由、传输事件、取消、重试和回退；上述真实链路
仍需单独验证。
