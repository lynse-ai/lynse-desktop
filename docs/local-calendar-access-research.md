# 本地系统日历访问调研（macOS / Windows）

日期：2026-10-05 · 背景：权限引导页（第二页）新增"日历"授权项前的可行性调研。

## 结论速览

| 平台 | 操作 | 可行性 | 路径 | 备注 |
| --- | --- | --- | --- | --- |
| macOS（沙盒 + 公证） | 读 | ✅ 高 | EventKit `requestFullAccessToEvents`（`highlandcows-eventkit` 已在依赖中） | 本机 + iCloud + 系统互联网账户里的 Google/Exchange/CalDAV 全覆盖 |
| macOS | 写 | ✅ 高（**已上线**） | 同上，`add_todo_to_system_calendar`（`lib.rs`） | 待办"加入日历"即此链路，请求 Full Access |
| Windows（非 MSIX Win32） | 读/写系统日历 | ❌ 不可行 | 无 | WinRT Appointments 需 package identity + restricted capability；新 Outlook 不写本地 store |
| Windows | 读/写 Outlook | ⚠️ 有条件 | Microsoft Graph（`graph-rs-sdk`）或经典 Outlook COM（`outlook-mapi`） | 云端 OAuth 需应用注册；COM 要求装经典 Outlook |
| 双平台 | ICS 导入导出 | ✅ | `icalendar` crate | 仅文件层，无同步语义 |

## macOS：EventKit

- 权限模型（macOS 14+，本项目最低系统版本 15.0，无需旧 API 分支）：
  - `EKEventStore.requestFullAccessToEvents`（读 + 写）／`requestWriteOnlyAccessToEvents`（仅写）。
  - `requestAccess(to:)` 已弃用。旧的 `NSCalendarsUsageDescription` 已弃用。
  - Info.plist 必须声明 `NSCalendarsFullAccessUsageDescription` / `NSCalendarsWriteOnlyAccessUsageDescription`，否则不弹框直接 denied —— **本项目两个 key 均已配置**。
- 沙盒 entitlement：`com.apple.security.personal-information.calendars` —— **`Entitlements-appstore.plist` 已配置**；非沙盒 DMG 构建不需要。
- 可见范围：`EKEventStore` 暴露所有账户日历（`.local` 本机、`.calDAV` iCloud/Google、`.exchange`、`.subscribed`、`.birthdays`）——凡系统日历 App 能看到的都能读写。
- Rust 生态（已在用）：`highlandcows-eventkit 0.5.8`（底层 `objc2-event-kit`）。
  - `CalendarStore::authorization_status() -> EkAuthStatus`：静态、不弹窗（NotDetermined/Restricted/Denied/FullAccess/WriteOnly）。
  - `store.authorize() -> EventKitResult<CalendarFullAccessToken>`：阻塞至用户答复；已决定则不弹框直接返回。
  - 读取：`fetch_in_range` + `CalendarEvent`（Send+Sync，含 title/notes/start/end/all_day/location）——本次未启用，留给后续功能。
  - 无官方/社区 Tauri 日历插件（crates.io 搜 `tauri-plugin-calendar` 为 0）。
- 来源：Apple EventKit 文档、docs.rs/objc2-event-kit、docs.rs/highlandcows-eventkit、WWDC23 "Discover Calendar and EventKit"。

## Windows：本地不可行，云端替代

- `Windows.ApplicationModel.Appointments`（WinRT）：
  - `AppointmentManager.RequestStoreAsync` 需要 `appointmentsSystem`（restricted，上架基本不批）或 `appointments` capability —— capability 只对有 package identity（MSIX）的应用有效，本项目是普通 MSI/Win32 打包，无法声明。
  - 即便打包：本地 appointment store 数据来自已被砍掉的经典 Mail & Calendar 应用；新版 Outlook（Monarch，WebView2 云端架构）不写本地 store，第三方读出来是空的。
- 可行替代：
  1. **Microsoft Graph API**（`graph-rs-sdk`，支持 interactive OAuth）：读写 Outlook/M365 云端日历；需 Azure 应用注册，企业租户可能要管理员同意。
  2. 经典 Outlook COM interop（`outlook-mapi`）：要求用户装有经典 Outlook，微软已指引迁移 Graph。
  3. CalDAV 直连 / ICS 文件（`icalendar` crate）：账户配置复杂度转嫁给用户。
- **本项目现成方案**：Connections 已有 google-calendar / outlook-calendar / feishu-calendar 的服务端 OAuth 只读同步（`services/integrations-bff`），Windows 用户的日历需求由它承接，不做本地日历。

## 已落地的改动（2026-10-05）

权限页新增**可选**的 macOS 日历行（Windows/旧构建返回 `unsupported` 或缺字段时自动隐藏，不计入 Continue 解锁条件）：

- Rust `lib.rs`：`calendar_permission_state()`（EkAuthStatus → granted/denied/notDetermined 三态映射）+ `request_calendar_permission()`（EventKit Full Access 弹窗）。
- Rust `live_translation.rs`：`PermissionStatus` 加 `calendar` 字段；`live_translation_request_permission` 加 `calendar` 分支；`live_translation_open_privacy_pane` 加 `Privacy_Calendars` anchor。
- 前端：`LivePermissionStatus.calendar?`；`permission-onboarding.tsx` 第三行（`required=false` 不带红星）+ 轮询覆盖可选行；5 语言文案。
- 副产品：授权后待办"加入日历"不再弹 TCC 框（`authorize()` 对已授权状态短路）。

## 后续路线（不在本次范围）

- **读日程**：`CalendarStore::fetch_in_range` 现成，最小命令 `calendar_fetch_events(start, end)` 即可服务 Goal 规划/会前上下文（对接 `docs/todo-to-goal-plan.md`）。
- **Windows 云端日历**：如需在权限页呈现，引导到 Connections（联动 `featureFlags.connections`）。
- 跨平台没有"系统本地日历"统一库这一事实不变：EventKit / Graph / CalDAV 各自是平台专属后端。
