# 助手改名后转写发言人未刷新

## 已确认的客户端问题

侧栏在选中会议后发起改名，初始用户消息保存了该会议的 `fileIds`。本机当前会话的脱敏元数据确认，改名卡片类型为 `speaker_patch_confirm`，已携带确认令牌并被点击；随后“确认”用户消息的 `fileIds` 却为空。

`use-chat-store.ts` 的 `answerConfirm` 未将原请求的会议传给确认后的聊天回合。与此同时，助手回合完成时未触发 `file-transcription` 查询刷新。转写页面通过 `useFileTranscription` 读取这个查询，而应用默认 `staleTime: Infinity`，因此页面可以一直显示改名前的缓存。

## 修复行为

- 确认卡片后续请求保留产生该卡片的原用户请求中的会议 ID 和指定标记，继续携带原确认令牌。
- 小灵助手每轮完成后，按该轮会议 ID 失效对应转写缓存。当前展示的转写立即重新请求；未展示的会议标记为过期，重新打开时获取。
- 不从“已完成”等回复文字中猜测名称，不直接改写转写数据，页面显示重新查询到的后端结果。
- 同一回合重复完成事件只刷新一次；错误、请求中断或旧账号的迟到事件不触发刷新；其它会议不被一并失效。

## 验证

新增回归在修复前复现三项失败：确认后会议丢失、已展示转写未重新获取、后台会话结束未标记原会议数据过期。修复后，聊天 store、WorkBuddy 隔离、流式与轮询传输及侧栏相关的 122 项测试通过，类型检查、修改文件 lint 和 `git diff --check` 通过。

转写刷新回归使用真实 QueryClient 与 QueryObserver，保持与应用相同的无限缓存时间，模拟后端保存新名称，验证查询订阅实际收到新数据。

本次生产服只读核验在 macOS 钥匙串读取时超时，未取得 token、未发起转写查询。因此尚未核实截图中改名在生产后端的实际状态，也没有重放改名请求。

## 测试安装包

本机测试客户端仍为 1.1.14 arm64，包含此前登录绑定和指定会议修复。最新安装包为 `apps/tauri/src-tauri/target/release/bundle/dmg/Lynse_1.1.14_speaker-refresh-fix_aarch64.dmg`，使用本地 ad-hoc 签名，未公开发布或进行 Apple 公证。

DMG 完整性检查、包内应用严格签名检查和主程序一致性检查均通过。DMG SHA-256：`2eecf9b890fc6a2a8d4a68d4b936fd433d646f8ef238109594b85c2937445eca`。

后续又补充笔记会话隔离，最新测试包为 `Lynse_1.1.14_current-note-startup-fix_aarch64.dmg`，见 [笔记会话隔离记录](cloudbase-note-session-isolation.md)。
