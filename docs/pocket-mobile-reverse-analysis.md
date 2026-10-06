# Pocket 移动端逆向分析（2026-10-03）

> 对象：**Pocket – AI Personal Assistant**，Android `com.heypocket.app`，样本 **v0.6.84 / versionCode 5921**（商店当前 0.6.86，本样本落后两个构建）。
> 来源：用户提供的 XAPK 逆向包（`~/Downloads/pocket-re.zip`，在 macOS 上产出：`blutter.log` 路径为 `/Users/johney/Downloads/pocket-re/`）。
> 姊妹篇：`docs/pocket-desktop-reverse-analysis.md`（macOS 桌面）、`docs/pocket-desktop-reverse-analysis-windows.md`（Windows 桌面）。
> 仅架构学习，不复制其代码/资产/提示词。**全程只读静态分析，未运行任何来自该包的代码。**

## 一、方法与可信度

| 层 | 手段 | 可信度 |
|---|---|---|
| 清单/权限 | `aapt2 dump badging` + `dump xmltree AndroidManifest.xml`（Android SDK build-tools 36.0.0） | 高，权威 |
| 原生库 | XAPK split 解压 → `lib/*.so` 名单 + `strings` | 高 |
| Java/Kotlin 层 | 对方已跑的 `jadx-out/`（反编译源码）+ `pocket-classes.txt` | 高 |
| Dart 层 | **Blutter 失败**（`_kDartVmSnapshotData` 不在 dynsym，libapp.so 已剥离符号）→ 只能用 `libapp-strings.txt` / `strings-clean.txt` 的字符串启发 | 中，需交叉印证 |
| Flutter 资源 | `res-out/resources/assets/flutter_assets/`（含 `shorebird.yaml`、`packages/`、`AssetManifest.bin`） | 高 |

## 二、最重要的结论：手机**不是**第二台录音设备

```
RECORD_AUDIO          : 0 次（权限列表 + 整个 AndroidManifest 都没有）
FOREGROUND_SERVICE_MICROPHONE : 无
MediaRecorder / AudioRecord   : 0 / 1（仅权限文案）
声明的前台服务类型      : FOREGROUND_SERVICE_DATA_SYNC + FOREGROUND_SERVICE_CONNECTED_DEVICE
```

手机**无法采集音频**。所有录音发生在 **MagSafe 硬件挂件**上，手机只负责发现/连接设备、同步文件、播放、AI 处理、推送与提醒。字符串证据完全吻合：
`sync not available during recording`、`sync after device started recording`、`for device-initiated recording`、`checklist_system_not_recording_before_first_binding`、`press the button to start recording`。

→ **这不是「移动端 vs 桌面端」的错配，而是一个生态内部的采集分工。** Pocket 自己就把它拆成两种模型：**桌面端自采**（系统音频 + 麦克风双路），**手机端完全不采**（连 `RECORD_AUDIO` 都不申请），只从硬件同步。刻意不给手机麦克风，换来两件事：绕开 Android 14+ 后台麦克风的合规与稳定性泥潭，以及不把手机变成硬件的竞品。
→ **Lynse 同样是「硬件 + 移动端 + 桌面端」三腿生态**（桌面端只是其中一条腿），所以这条硬件伴侣链路是**同赛道、可直接对标**的一等公民，不是可跳过的部分。
→ ⚠️ 但本文档**无法据此判断 Lynse 移动端的现状**：本工作目录只有桌面端代码，Lynse 的 App 与固件在别的仓库，本机那个 `lynse-1.0.4(95).apk` 实际是 1.9 KB 的下载页 HTML，不是安装包。要做真正的对位评估，需要 **Lynse 移动端 APK 或移动端仓库**。

## 三、技术栈

- **Flutter（Dart AOT）** + **Pigeon** 做类型安全 IPC（`pigeon` 156 次命中，`PocketCableSyncFlutterApi` / `PocketCableSyncHostApi` 是 Pigeon 命名规范）。
- **Shorebird**：`assets/flutter_assets/shorebird.yaml` → `app_id: 793588cd-b042-4ce5-96c0-a6e7c26c1853`。**移动侧走 Shorebird code-push 做热修复/增量更新**，与桌面端的 tauri minisign updater 是两条完全独立的更新链。
- 原生库（armeabi-v7a split）：`libflutter.so` 10.0 MB、`libapp.so` **35.1 MB**（Dot AOT，说明 Dart 代码体量很大）、`librive_native.so` 6.0 MB（**Rive 动画**，附带其自带的 `libmodft2.so`/`libmodpng.so`/`libmodpdfium.so`+`libjniPdfium.so` PDF 渲染）、`libsentry.so`+`libsentry-android.so`、`libdartjni.so`、`libdatastore_shared_counter.so`、`libc++_shared.so`。
- 从 `flutter_assets/packages/` 可见使用的 Flutter 包资源：`flutter_math_fork`（LaTeX 公式渲染）、`golden_toolkit`（**widget 级截图测试**，说明有 UI 回归测试）、`flutter_map`（地图）、`glass_kit` + `liquid_glass_renderer`（**iOS 液态玻璃风格 UI**）、`fluttertoast`、`wakelock_plus`；shaders 含 `ink_sparkle.frag` + `stretch_effect.frag`（Flutter 3.27+ 默认 M3 效果）。
- 版本约束：**minSdk 29（Android 10）**，**targetSdk 36 / compileSdk 36**。
  ⚠️ Google Play 页面显示「Requires Android 7.0 and up」，与 APK 实际 minSdk 29 **不一致**——商店文案不可信，以清单为准。

## 四、设备链路（Lynse 用不上，但工程做法值得看）

类名证据（`pocket-classes.txt`，其自有类）：

- **BLE 栈**：`PocketBle` / `PocketBluetoothPlatform` / `PocketPlatformGattSession` / `PocketGattCharacteristic` / `PocketScanFilter|Mode|Phase|Result|Snapshot|StopReason` / `PocketDiscoveredDevice` / `PocketDeviceAdvertisement` / `PocketConnectionWorkflow|Phase` / `PocketBindingPhase` / `PocketReadinessPhase`。
- **协议可观测**：`PocketProtocolTraceEvent` / `PocketProtocolTraceDirection` —— 每条 BLE 报文有方向标记的 trace，配合 `PocketBleLogEvent|Level`，是硬件排障的标准做法。
- **三条传输通道**：BLE（控制）、**Wi-Fi**（大文件：`PocketWifiFirmwareTransport` / `PocketWifiStreamMode` / `PocketWifiPrewarmOutcome|Phase` / `PocketWifiTransferPreparationStep`）、**USB 线连**（`PocketCableSync*`，另有 `assets/lotties/cable_sync_connect_ios_*.json` 引导动画）。
- **OTA 固件**：`PocketFirmwarePackage|Phase|Progress|Result|Outcome|Target|WireTarget|TransferPhase`。
- **断点续传下载**：`PocketDownloadDestination|Options|Outcome|Phase|Progress|Result|**Resume**|StopIntent` —— 显式的 Resume + StopIntent 语义。
- **完整性校验**：`PocketFileCompleteness` / `PocketFileTransferPhase` / `PocketSyncFailureReason` / `PocketSyncSkipReason` / `PocketStorageSnapshot`。
- **邻近感知（产品创意点）**：`PocketProximitySample` / `PocketProximityTarget` / `PocketProximitySearchTerminalReason` / `PocketSignalHapticBand`（RSSI 分档振动反馈）/ `PocketLeftBehindAnchor|AnchorStore` + `PocketNotifyWhenLeftBehind` —— 基于 RSSI 锚点的「**你把 Pocket 落下了**」提醒。
- **iOS 实时活动**：`PocketLiveActivity` / `PocketLiveActivityMode`（灵动岛显示同步进度/录制状态）。
- **Android 桌面小组件**：`PocketHomeWidget` / `PocketTodosWidget` + 清单里 `androidx.glance.appwidget.GlanceRemoteViewsService`（Glance 写的待办小组件）+ `home_widget` 包。
- **适配就绪状态机**：`PocketPlatformAdapterReadiness|Requirement|State`、`PocketLocationPermissionIssue` —— 把「权限/蓝牙/网络是否就绪」建模成显式状态，而不是散落的 if。

## 五、后台唤醒与推送（这块是移动端真正的工程难度所在）

- 前台服务实现：`com.pravera.flutter_foreground_task.service.ForegroundService`（**flutter_foreground_task**）；`PocketSessionPolicy` / `PocketSessionId` / `PocketSessionSnapshot` 说明服务生命周期被会话策略约束。
- 任务调度：`androidx.work.*`（WorkManager：SystemAlarmService / SystemJobService / ForceStopRunnable）+ `RECEIVE_BOOT_COMPLETED`（开机重启同步）+ `WAKE_LOCK`。
- **推送是双供应商**：`FCM`（`FlutterFirebaseMessagingService`、`C2D_MESSAGE`、`firebase-auth.properties`）**加 OneSignal**（`strings` 54 次 / 清单 12 次，含 `com.onesignal.notifications.services.HmsMessageServiceOneSignal` = **华为 HMS 通道**、`SyncJobService`、`PermissionsActivity`）。
  → 目的很清楚：**绕过中国/华为设备的推送不可达问题**，让「会议提醒 / 同步完成」在 App 被杀后仍能触发。
- 本地通知：`com.dexterous.flutterlocalnotifications`（含 `ScheduledNotificationRepeatFrequency`、`NotificationChannelDetails`、多种 `styles/`）→ **移动端的提醒调度器落在本地通知**，配合 `POST_NOTIFICATIONS`。
- 定位：`ACCESS_FINE/COARSE/**BACKGROUND**_LOCATION` + `NEARBY_WIFI_DEVICES` + `geolocator`（`GeolocatorLocationService`）+ `appauth`（OAuth 通用 IdP）。注意 `BLUETOOTH_SCAN` 带了 `neverForLocation` 标志，但 `ACCESS_BACKGROUND_LOCATION` 仍然声明——这是隐私审查上的一个明显攻击点（对应 Data Safety 只声明了 Device IDs/Audio/Calendar/Personal info，**未申报 Location**）。

## 六、本地数据与商业

- 本地库：`isar`(19) + `hive`(13) + `sqflite`(4) + `drift`(1) 字符串 + 清单里的 `androidx.room` / `androidx.datastore`。**与桌面端（Rust `sqlx` + SQLite）不同栈**——两端只有「服务端 schema」共享，本地持久化是各写各的。
- 计费：`com.android.vending.BILLING` + `CHECK_LICENSE` + **`com.amazon.device.iap`**（Amazon Appstore 内购，见 jadx-out 里的 `ResponseReceiver`/`simplesignin`）+ `purchases_flutter`(**RevenueCat**) + `firebase-appcheck`/`safetynet` attestation + `AD_ID`。
- 观测与实验：`sentry` 109 次（原生 so + android so 双份）、`posthog` 29 次 + 清单 `com.posthog.posthog.AUTO_INIT`（自动初始化）。
- 本地 mock：`assets/mock_fixtures/` → 桌面端发现的「请求拦截式 mock 层」在移动端同样存在，**是团队级约定而非临时手段**。
- 运营资源：`assets/november/`（按月份打包的运营素材）、`assets/post_onb_user_education/`（Onboarding 后教育）、大量 lottie。
- 公开端点：`production.heypocketai.com`（主 API）、`app.heypocket.com`、**`public.heypocketai.com/mcp`**、`public.heypocketai.com/docs`、`heypocket.com/refer/<code>`、`feedback.heypocket.com`、`community.heypocket.com/invites/`（Discord）、`releases.heypocketai.com/Pocket_Setup.exe`。
- **`/mcp` 是已上线的公开服务**，且与桌面端的 `/api/v1/integrations/api-keys` + 前端路由 `/app/settings/api-keys`、`/app/settings/developers` 成套 —— 他们把「让 Agent 接入笔记」当产品特性在发。

## 七、桌面端没有、移动端却有的能力

| 能力 | 证据 | 对 Lynse **桌面端**的意义（移动端腿尚未评估，勿由此推断 Lynse 整体） |
|---|---|---|
| 模型选择 | `PocketModelPicker` / `PocketModelTier` / `PocketChatProvider` / `PocketResearchMode` | 桌面只有**本地 STT 引擎**选择器，云端 LLM 无选择；`chat-transport.ts` 请求体不带 `model` |
| 用户记忆 | `PocketMemory` | 与桌面 `/user-profile` + `/import-chatgpt-memory` 呼应，Lynse 桌面端无此链路 |
| 系统级入口 | `PocketTodosWidget` + `PocketLiveActivity` | 桌面的 tray 只有录制控制；手机侧小组件/实时活动是否等价，需要 Lynse 移动端样本才能比 |
| 多语言 | 19 个 `config.<lang>` split（zh/ja/ko/ru/de/es/fr/pt/vi/th/ar/hi/my/tr/in/en…） | 「Pocket 只有英文」这条**桌面端结论对移动端不成立**；Lynse 的 5 语言 i18n 优势被追平 |
| 热更新 | Shorebird code-push | 桌面端无等价机制（Lynse 已排除热更新路线，两端一致） |
| 生物识别锁 | `USE_BIOMETRIC` + `USE_FINGERPRINT` + `DETECT_SCREEN_CAPTURE` | 桌面端无 App 锁；`DETECT_SCREEN_CAPTURE`（防截屏）是隐私模式的配套件，移动端是否有等价物待查 |

## 八、需要修正的既有说法

1. ~~「Lynse 没有硬件，Pocket 移动端不可比」——**这条是我判错了的**（原稿写过，已作废）。Lynse 有硬件也有移动端，桌面端只是生态的一条腿。正确结论是：Pocket 移动端**可比如**，且是必须对标的一条腿；真正的问题是**本仓库看不到 Lynse 移动端**，所以现状差距无法从这里的代码推断。
2. 「Pocket 前端纯英文、无多语言」——**仅桌面成立**，移动端 19 个语言 split。
3. 「会议提醒靠 tray/常驻图标」——移动端靠 **WorkManager + flutter_local_notifications + FCM + OneSignal(含华为)** 四件套，桌面端靠原生 `notify.rs` 自建窗口。两端方案完全不同，不能互相照抄。
4. 「本地库用 SQLite 就当 source of truth」——桌面是 `sqlx`，移动是 **Isar/Hive/DataStore/Room**，两端只是理念一致。

## 九、样本限制（结论适用边界）

- 样本落后两个版本（0.6.84 vs 商店 0.6.86）。
- 只含 **armeabi-v7a** split（无 arm64），且 base APK 的 `locales` 只解析出占位值——语言信息来自 split 列表。
- **Blutter 未成功** → Dart 侧类名/方法名来自 strings 与类清单启发，不是完整反编译；若要坐实 Dart 业务逻辑（尤其同步状态机、隐私模式开关的传播路径），需要 arm64 样本 + 修好符号提取，或直接对 `libapp.so` 做 snapshot 手工解析。
- 未做任何动态验证：不安装、不抓包、不使用其凭证。

## 十、Lynse 移动端对位（实测 `com.lynse.sparknote` 1.2.0 与 1.3.3）

样本来自两条通道：`download.lynse.cn/source/latestapk/latest.apk`（**1.2.0 / versionCode 180 / 178.3 MiB**）与用户提供的 **1.3.3 / versionCode 233 / 144.8 MiB**。用 `aapt2 dump badging` + `xmltree AndroidManifest.xml` 直接读，和上面 Pocket 的方法一致，因此可比。

### 硬件伴侣端：形态不同，链路更宽

| | Pocket 手机 | Lynse 手机 |
|---|---|---|
| 硬件 | MagSafe 挂件 | **SparkCard 录音卡**（29 g / 64 GB 板载 / MagSafe / Knowles 硅麦 + 通话降噪） |
| 传输 | BLE + Wi-Fi + **USB 线连**（`PocketCableSync*`） | **BLE + Wi-Fi-P2P**（`libnveasysdk` / `libnveasyopus`，`nveasy.NeasyWifiHelper`：`startWifiPrewarm` / `connectWifiDirect` / `startServer` / `readProtocolTraceFile`） |
| 采集 | 手机**完全不采**（无 `RECORD_AUDIO`） | 手机**能自采**（有 `RECORD_AUDIO`）**且卡片独立采** |
| 前台服务 | `flutter_foreground_task`，类型 DATA_SYNC + CONNECTED_DEVICE | 自有 `nveasy.CardFileTransferForegroundService`，权限侧只声明 CONNECTED_DEVICE |

**Lynse 独有一条：片上语音链路。** `libneonui_shared.so`（arm64 8.7 MB + v7a 7.1 MB，思必驰系）+ `assets/kws.bin`（关键词唤醒）+ `assets/vad.bin`（端点检测）+ `assets/tts/languagedata_embedded.bin`（4.9 MB 离线 TTS）+ `liblame-mp3.so` / `libopus.so`。Pocket 移动端**一个都没有**，它把音频全部交给硬件与云端。这是「手机端能不能离线兜底、能不能本地判断有没有人在说话」级别的差异，不是功能点差异。

### 技术栈同源，差异在分发方式

两边都是 **Flutter（`libflutter.so` + `libapp.so`）+ Pigeon**。体积差主要来自分发：Play 走 **split APK**（base 50 MB + 单 ABI v7a 56 MB），Lynse 走**单包多 ABI**（1.2.0 塞了 v7a + arm64 + x86_64；**1.3.3 已砍掉 x86_64**，包体从 178.3 MiB 降到 144.8 MiB）。要继续降体积就得走 AAB/split 或按渠道出包。

热更新：**Pocket 移动端有 Shorebird code-push，Lynse 没有** —— 所以 Lynse 移动端唯一的更新方式是下载整包 APK，这也让下面的通道问题影响面更大。

### 推送：Lynse 的国内覆盖更强

Lynse = **友盟 U-Push + 阿里 accs/agoo（`libtnet-3.1.14.so`）+ 华为/荣耀 + OPPO(Heytap/MCS) + vivo + 魅族 + freemme**。Pocket = FCM + OneSignal(含 HMS)。在国内无 GMS 设备上，Lynse 这套可达性更好。
崩溃捕获：**Lynse 移动端已带 `libsentry.so` + `libsentry-android.so`，而 Lynse 桌面端是零遥测** —— 移动端的现成 Sentry 集成可以直接复用到桌面端。

### 三个清单问题（1.3.3 复核结果）

1. ❌ **仍在**：`AndroidManifest.xml:131` 是 `Manifest.permission.CAPTURE_AUDIO_OUTPUT`（前缀应为 `android.`）。这行现在是死串。顺带说明：即使写对，该权限是 `signature|privileged`，普通 App 也拿不到 —— 手机端**无法采集通话对端音频**，这条能力上不去，建议直接删掉而非改正拼写。
2. ❌ **仍在**：有 `RECORD_AUDIO` 且 `targetSdk 36`，但**没有 `FOREGROUND_SERVICE_MICROPHONE`**，也没有任何服务声明 microphone 类型。目前靠卡片录所以不出事，但**任何「手机后台录音」需求在 Android 14+ 会抛 `MissingForegroundServiceTypeException`**。
3. ✅ **已修**：1.3.3 补上了 `USE_BIOMETRIC`（1.2.0 只有 `USE_FINGERPRINT`，在无指纹的设备上门禁会静默失效）。

1.3.3 相对 1.2.0 的权限增量：**新增 `CAMERA`、`USE_BIOMETRIC`、`READ_GSERVICES`；删除 0 项**（41 → 44）。

### Lynse 移动端相对 Pocket 的确定缺口（最新包复核）

- **日历**：`READ_CALENDAR` / `WRITE_CALENDAR` **仍然为 0**，Pocket 两项都有 → 会议智能那条腿在手机侧是空的。
- **系统级入口**：1.3.3 清单里 `appwidget` / `TileService` / `NotificationListener` / shortcuts **全部 0 命中**；Pocket 有 Glance 待办小组件 + iOS Live Activity。
- **隐私/安全面**：Lynse 有 `USE_BIOMETRIC`（新增）但无 `DETECT_SCREEN_CAPTURE`；Pocket 有 `DETECT_SCREEN_CAPTURE`。
- **后台定位**：两边都声明 `ACCESS_BACKGROUND_LOCATION`，都做卡片邻近感知；但 **Lynse 没有 Pocket 那套 `LeftBehindAnchor` / `NotifyWhenLeftBehind` 的显式建模**（以类名为准，Dart 层未证实）。

### 发布通道：本次分析暴露的最实际问题

PGYer 已 **1.3.3 / Build 233**，而对外直链 `download.lynse.cn/source/latestapk/latest.apk` 仍是 **1.2.0 / 180**（差 53 个 build）。该通道是**明文 HTTP**，App 又声明了 `REQUEST_INSTALL_PACKAGES`（自更新即下载该包并唤起安装），**全程无签名/哈希校验** → 既是发布流程问题（用户拿不到新版），也是完整性问题（中间人可换包）。与桌面端 `latest.json` 卡在 1.1.0 属同一根因：**「最新」指针不随发布更新**。

### 更正本文档早先两处说法

- 「`14.so` 是异常文件」——**错**，那是我正则漏了文件名中的点；实为 **`libtnet-3.1.14.so`**（阿里 accs 网络栈），1.2.0/1.3.3 都有。
- 「包体掉了约 42 MB」——**算错**，混淆了 MB 与 MiB。PGYer 的 144.8 是 **MiB**；实际 1.2.0=178.3 MiB → 1.3.3=144.8 MiB，**降 33.5 MiB**。

## 附：本次分析产物

- `C:\Users\johne\Documents\Work\pocket-re\mobile\pocket-re\`：`manifest.xmltree.txt`（861 行完整清单）、`com.heypocket.app.apk`(50.7MB base)、`xapk/manifest.json`、`strings-clean.txt`(1.8MB)、`libapp-strings.txt`(2.4MB)、`pocket-classes.txt`、`blutter.log`(失败记录)、`jadx.log`
- 原始包：`C:\Users\johne\Downloads\pocket-re.zip`（236MB，20,356 条目，含 `jadx-out/` 反编译源码与 `res-out/` 资源，尚未全部展开）
