# 本机启动联测与钥匙串等待

日期：2026-10-17。

打开最新本机安装包测试时，主窗口不响应。对本次启动进程进行 1 秒线程采样，主线程位于 `secure_get_secret → secret_get → keyring → SecKeychainFindGenericPassword → SecurityServer → mach_msg`。原同步 Tauri command 在界面线程等待系统钥匙串，导致窗口和 WebKit IPC 无法响应。

四个前端安全存储命令改为 async，由 `spawn_blocking` 执行读取、写入、删除以及单项 vault 更新。vault 的进程级锁仍在后台闭包内保护完整读改写；读取失败仍返回错误，不作为空 vault 保存。本次没有修改钥匙串内容、ACL、签名信任或凭据存储策略。

新增 3 项原生回归：后台线程执行、读取拒绝仍为错误、缺失项结果保留。原生离线回归 228 项通过、1 项忽略、1 项外部 WorkBuddy 联机测试排除；完整包构建和严格验签通过。测试日志为 `/private/tmp/lynse-secret-io-native-offline-20261017.log`。

修复后打包版窗口可通过自动化正常读取和截图，但在本机仍等待系统钥匙串授权，React 初始化尚未完成。系统 SecurityAgent 窗口禁止自动化操作，需用户自行处理系统授权。

项目现有开发测试客户端使用已有的开发存储文件，无需修改正式版存储策略；该客户端已正常打开，当前在手机号登录页。已有登录状态在初始化阶段曾显示首页或笔记页面，随后回到登录界面，因此尚不能声称完整侧栏界面联测通过。需要用户完成客户端登录后，继续实际验证 A 对话、草稿、关闭侧栏、切 B 再打开清空及同篇重开保留。

新版本机安装包：`apps/tauri/src-tauri/target/release/bundle/dmg/Lynse_1.1.14_current-note-startup-fix_aarch64.dmg`。DMG 完整性、包内签名及与构建程序一致性均通过，SHA-256：`5e9a42ab4c3c68d11dc08f92c6283c965e7bc189d80d422ef604f43e1a48f171`。本地 ad-hoc 签名，未公开发布或 Apple 公证。
