# CloudBase 侧栏指定会议丢失

## 原因与修复

侧边助手显示当前会议，`ChatPanel.handleSend` 也把选中会议 ID 与指定标记传入聊天 store。store 将它们交给 transport 后，公共请求组装函数 `chatTurnBody` 只发送了 `fileIds`，漏发 `userSpecifiedFile`。

CloudBase 的 `ChatRequest.user_specified_file` 默认值为 false。后端 `effective_file_ids` 在此标记为 false 时会忽略传入会议 ID，因此助手会认为未指定会议，并可能改查最近的其它会议。

修复后，明确指定会议时同时发送：

```json
{"fileIds":["selected-meeting-id"],"userSpecifiedFile":true}
```

流式、轮询、忙碌重试和流式断开后的轮询恢复共用这段请求组装逻辑，都会保留同一会议范围。

## 验证

- 补充协议断言后，修复前复现 5 项失败，均为请求缺少指定标记。
- 修复后，聊天 transport、store 和侧栏组件相关的 110 项测试通过；类型检查、修改文件的 lint 和 `git diff --check` 通过。
- 后端会议范围处理相关的 14 项离线测试通过，确认标记为 true 时保留指定会议，为 false 时忽略会议 ID。
- 额外的生产服真实会议信息只读复测，在系统钥匙串读取环节超时，未发送会议查询，未记为线上场景通过。

## 本机测试包

使用当前工作区重新构建 1.1.14 arm64 客户端，保留手机、微信登录入口和此前的 token 绑定补强。编译后的前端资源已确认包含指定标记。

安装包位于 `apps/tauri/src-tauri/target/release/bundle/dmg/Lynse_1.1.14_cloudbase-meeting-fix_aarch64.dmg`，使用本地 ad-hoc 签名，未公开发布或进行 Apple 公证。

DMG 完整性检查通过；只读挂载后的包内应用通过严格签名检查，主程序与最新构建一致。安装包 SHA-256 为 `8a13e683f363a302347bd06662d3a9741bbe8ac932fb916df362716824c6b5ce`。

重新安装后需退出旧应用再启动新应用，并在侧栏重新发送请求，历史回复不会自动改写。

2026-10-17 又补充了确认后保留原会议、操作完成后刷新转写与笔记会话隔离。最新测试包为 `Lynse_1.1.14_current-note-startup-fix_aarch64.dmg`，见 [发言人刷新修复记录](cloudbase-speaker-refresh.md) 和 [笔记会话隔离记录](cloudbase-note-session-isolation.md)。
