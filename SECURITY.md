# 安全策略

## 报告漏洞

如果你发现安全漏洞，请**不要**在公开 Issue 中提交，而是通过邮件联系：

**lynse@lynse.com**

请在邮件中包含：

- 问题类型（如代码执行、敏感信息泄漏、权限绕过）
- 复现步骤 / PoC
- 影响的版本与平台（macOS / Windows）

我们会在 3 个工作日内回复，修复后会在 Release Notes 中致谢（除非你希望匿名）。

## 支持版本

| 版本 | 状态 |
| --- | --- |
| 最新 Release（见 [Releases](https://github.com/lynse-ai/lynse-desktop/releases)） | ✅ 支持 |
| 旧版本 | ❌ 不支持，请升级到最新版 |

## 安全设计说明

- API Key / Token 存储在操作系统钥匙串（macOS Keychain / Windows 凭据管理器），不落 localStorage。
- 本地转写（FunASR / whisper）在本机运行，音频不出机器。
- Tauri 能力（capabilities）保持最小集：仅 `core:default`、dialog、opener。
- 实时字幕/翻译使用你自行配置的第三方服务凭证，凭证仅保存在本机。
