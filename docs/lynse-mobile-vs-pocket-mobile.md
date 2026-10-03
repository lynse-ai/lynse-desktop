# Lynse 移动端 1.3.3 审计 & 与 Pocket 移动端对比

> 日期：2026-10-03　作者：Qoder agent（静态分析）
> 样本：`com.lynse.sparknote` **1.3.3 / versionCode 233 / 144.8 MiB**（用户提供 `~/Downloads/Lynse_1.3.3.apk`）＋ **1.2.0 / 180 / 178.3 MiB**（官网直链 `http://download.lynse.cn/source/latestapk/latest.apk`）
> 对照：`com.heypocket.app` **0.6.84 / versionCode 5921**（用户提供的 XAPK 逆向包），详见 `pocket-mobile-reverse-analysis.md`
> 方法：`aapt2 dump badging` / `xmltree AndroidManifest.xml`（Android SDK build-tools 36.0.0）、APK 条目枚举、`libapp.so`（Dart AOT）与 `classes*.dex` 的字符串扫描。**纯静态，未安装、未运行、未使用任何凭证。**
>
> ⚠️ **本文刻意不写完整密钥值**（截断显示），不要把完整值补进仓库或 issue。密钥详情见内部工单，且已建议轮换。

---

## 一、1.3.3 问题清单（按严重度）

### P0-1　硬编码密钥进入客户端产物

| # | 形态 | 位置 | 出现范围 |
|---|---|---|---|
| 1 | `sk-39c0…d213`（32 hex，**阿里云 DashScope / 通义 key 格式**） | `lib/arm64-v8a/libapp.so` `@0x96454` | **1.2.0 与 1.3.3 均存在** |
| 2 | `AIza…qmXlA`（**Google API key 格式**） | `lib/arm64-v8a/libapp.so` `@0x302cda` | **仅 1.3.3（新版本引入的回归）** |

- 这两个包已经通过 Google Play / PGYer / 官网直链公开分发，任何人都能解包提取 → **按已泄露处理，立即轮换**。
- 上下文里出现 `AndroidInitializationSettings`，但 **Dart 字符串池是共享区，相邻不代表调用关系**；实际调用点需 Dart 层确认（Blutter 对 Lynse 这份同样需要试，Pocket 那份因符号剥离失败）。
- 1.2.0 的 `classes*.dex`、`libnveasysdk.so`、`libneonuijni_public.so`、`assets/cei.json` 扫描**均无命中** → 泄露面集中在 Dart 侧。

### P0-2　明文流量 + 无验签自更新 = 可被换包

三个事实叠加才构成危险，缺一都不算严重：

1. `<application android:usesCleartextTraffic="true">`（**全 App 允许明文**）
2. 声明 `REQUEST_INSTALL_PACKAGES` → App 内自更新就是「下载 APK 再唤起安装」
3. 自更新源 `http://download.lynse.cn/…`：**明文 HTTP、无签名/哈希校验**，且**停在 1.2.0/180，比 PGYer 的 1.3.3/233 落后 53 个 build**

→ 中间人替换 APK 即等于在用户设备上执行任意代码。这已经不是「更新不及时」的体验问题。
→ 另一个独立问题：**Play 分发包携带 `REQUEST_INSTALL_PACKAGES` + 自更新本身是政策风险**，Play flavour 应当裁掉。

### P1　清单与合规

| 问题 | 证据 | 影响 |
|---|---|---|
| `android:allowBackup` **完全未声明** | manifest 中出现 0 次 → 取默认 `true` | 录音、登录态可被 `adb backup` 提取。应显式 `false` + `dataExtractionRules` |
| **23 个组件 `exported="true"`**（62 个 false） | `xmltree` 统计；含 4 个 FileProvider：`com.lynse.sparknote.fileprovider`、`com.jarvan.fluwx.FluwxFileProvider`、`io.flutter.plugins.imagepicker.ImagePickerFileProvider`、`com.crazecoder.openfile.FileProvider` | 需逐个确认权限保护；`openfile` 这类第三方插件 provider 常配 `path="."`，会暴露整个外部存储 |
| deep link 同时注册 **`http` 与 `https`** | `host="com.lynse.sparknote"`、`path="/thirdpush"` | `http` scheme 可被其它 App 抢注；建议只留 https + App Links（`assetlinks.json`）验证 |
| **`Manifest.permission.CAPTURE_AUDIO_OUTPUT` 拼写错误** | `AndroidManifest.xml:131`，1.3.3 **仍未修**（正确前缀是 `android.`） | 当前是死串。且该权限为 `signature\|privileged`，普通 App 即使写对也拿不到 → **手机侧无法采集通话对端音频**是确定的能力上限。**建议直接删除，而不是改正拼写** |
| 有 `RECORD_AUDIO` + `targetSdk 36`，**无 `FOREGROUND_SERVICE_MICROPHONE`** | 1.3.3 **仍缺**；自定义服务只有 `com.lynse.sparknote.nveasy.CardFileTransferForegroundService` | 现在靠卡片录所以不报错；一旦做「手机后台直录」，Android 14+ 会抛 `MissingForegroundServiceTypeException` |
| 前台服务类型选择 | 权限侧仅 `FOREGROUND_SERVICE_CONNECTED_DEVICE`，无 `FOREGROUND_SERVICE_DATA_SYNC` | 卡片大文件 Wi-Fi P2P 传输语义上更接近 `dataSync`（Pocket 是 DATA_SYNC + CONNECTED_DEVICE 两个都声明） |
| 权限面偏大 | **41 → 44**（1.3.3 新增 `CAMERA`、`USE_BIOMETRIC`、`READ_GSERVICES`；**删除 0 项**）；含 `ACCESS_BACKGROUND_LOCATION`、`READ_PHONE_STATE`、`WRITE_EXTERNAL_STORAGE`、`requestLegacyExternalStorage` | Play 人工审核风险；后台定位需要能说明用途 |
| ✅ 已修 | 1.2.0 只有 `USE_FINGERPRINT`（无指纹设备的门禁会**静默失效**），1.3.3 补上了 `USE_BIOMETRIC` | 这类"看起来有锁其实没锁"的问题值得在移动仓库做一次同类排查 |

### P2　体积与配置残留

- 1.2.0 → 1.3.3 从 178.3 MiB 降到 **144.8 MiB**，原因是 **砍掉 x86_64**（`native-code` 现仅 `arm64-v8a` + `armeabi-v7a`）。方向正确，但仍是**单包多 ABI**：`libapp.so` 22.7 + 25.4 MB、`libflutter.so` 11.7 + 8.6 MB、`libneonui_shared.so` 15.9 MB。走 AAB / split 还能再降约一半。
- `assets/flutter_assets/assets/gif/拍手.gif` 单文件 **7.48 MB 未压缩** → 建议转 lottie 或短视频。
- **`assets/cei.json` 残留思必驰车机 demo 配置**：`cei_param_device_type: "car"`、`cei_param_debug_path: "asr_debug"`；同时 `is_vad_active / is_kws_active / is_sr_active` **三项全为 true**。需确认是否有意（`sr=true` 意味着片上识别引擎被配置启用）。
- `minSdk` 29 → **26**：覆盖变宽，注意 Android 8/9 无细粒度权限模型、`exported` 强制声明规则也不同。
- `dex`：`classes.dex`…`classes5.dex`（1.2.0 是 3 个）→ 方法数增长，注意 multidex 与启动 baseline profile（`assets/dexopt/baseline.prof` 已存在，✅）。

---

## 二、Lynse 1.3.3 ↔ Pocket 0.6.84 对比表

| 维度 | Lynse 1.3.3 | Pocket 0.6.84 | 占优 |
|---|---|---|---|
| 硬件 | SparkCard 录音卡：29 g / **64 GB 板载** / MagSafe / Knowles 硅麦 + 通话降噪 / 绑定 1000 分钟每月 | MagSafe 挂件，$129 + 订阅 | 打平（板载容量是你们的优势） |
| 技术栈 | Flutter（`libflutter.so`+`libapp.so`）+ **Pigeon** | Flutter + **Pigeon** + **Shorebird** | 同源 |
| **手机能否自采音频** | **能**（有 `RECORD_AUDIO`） | **完全不能**（清单 0 次，`MediaRecorder` 0） | **Lynse** |
| **片上语音链路** | **`libneonui_shared` 15.9 MB** + `kws.bin`(唤醒) + `vad.bin`(端点) + `assets/tts/languagedata_embedded.bin` 4.9 MB(离线 TTS) + `libopus` / `libnveasyopus` / `liblame-mp3` | **全无**，音频完全交给硬件+云端 | **Lynse（代差）** |
| 设备传输 | BLE + **Wi-Fi-P2P**：`connectWifiDirect` / `startServer` / **`startWifiPrewarm`**（预热血缘清楚） / `readProtocolTraceFile`（报文落盘可回溯） | BLE + Wi-Fi + **USB 线连**（`PocketCableSync*` + `cable_sync_connect_ios_*.json`） | 打平：你们多 prewarm/trace，他们多一条物理通道 |
| 固件 OTA | 后端有 `/api/business/ota/check`、`/ota/presign`、`/ota/function/list`；客户端未见显式类名 | `PocketFirmwarePackage\|Phase\|Progress\|Target\|WireTarget\|TransferPhase` 完整状态机 | **Pocket**（建模更细） |
| 断点续传 | 未见显式 Resume 语义 | `PocketDownload**Resume**` + `StopIntent` + `PocketFileCompleteness` + `PocketSyncFailureReason` | **Pocket** |
| 邻近 / 遗落提醒 | 有 BLE + 后台定位，但无显式建模 | `PocketProximitySample` / `PocketLeftBehindAnchor(Store)` / `NotifyWhenLeftBehind` / `PocketSignalHapticBand`（RSSI 分档振动） | **Pocket** |
| 系统级入口 | `appwidget` / `TileService` / `NotificationListener` / shortcuts **全部 0 命中** | **Glance 待办小组件**（`PocketTodosWidget`、`androidx.glance.appwidget`）+ iOS **Live Activity** | **Pocket** |
| 日历 | **`READ_CALENDAR` / `WRITE_CALENDAR` 全 0** | **两项都有**（且 `Calendar events` 在 Data Safety 标为 Optional） | **Pocket** |
| 模型选择 | 客户端未见证据；**但后端已有 `getAvailableAIModelList`** | `PocketModelPicker` + `PocketModelTier` + `PocketChatProvider` + `PocketResearchMode` | **Pocket**（差距在实现，不在后端） |
| 用户记忆画像 | 未见 | `PocketMemory` + 桌面 `/user-profile` + `/import-chatgpt-memory` | **Pocket** |
| 协议可观测 | `readProtocolTraceFile` ✅ | `PocketProtocolTraceEvent/Direction` + `PocketBleLogEvent/Level` ✅ | 打平 |
| 就绪状态建模 | 未见 | `PocketPlatformAdapterReadiness\|Requirement\|State`、`PocketLocationPermissionIssue` | **Pocket** |
| 推送 | **友盟 U-Push + 阿里 accs/agoo(`libtnet-3.1.14.so`) + 华为/荣耀 + OPPO(Heytap/MCS) + vivo + 魅族 + freemme** | FCM + OneSignal(含 `HmsMessageServiceOneSignal`) | **Lynse**（国内无 GMS 设备可达性） |
| 崩溃上报 | `libsentry.so` + `libsentry-android.so` ✅ | Sentry（+ 桌面 `crash-handler`/`minidumper`） | 打平（但**你们桌面端是零遥测**，见第四节） |
| 本地存储 | **MMKV** + DataStore(`libdatastore_shared_counter`) | Isar + Hive + DataStore + Room | 各有取舍 |
| 热更新 | **无 Shorebird** → 唯一更新方式是下载整包 APK（因此通道滞后影响面被放大） | **Shorebird code-push**（`shorebird.yaml`，app_id `793588cd-…`） | **Pocket** |
| 分发方式 | Play + PGYer + **官网明文直链**；单包 2 ABI | Play **split APK**（base 50 MB + 单 ABI v7a 56 MB），Android 仅 Play、无镜像可查 | **Pocket**（通道干净） |
| 支付/商业化 | `/api/pay/google/verify`、`/api/pay/order/*`、`com.android.vending.BILLING` | Play Billing + **Amazon IAP** + **RevenueCat** + App Check/SafetNet + `AD_ID` | **Pocket**（渠道与防刷更全） |
| 生物识别 / 防窥 | `USE_BIOMETRIC` + `USE_FINGERPRINT`（1.3.3 修好），**无** `DETECT_SCREEN_CAPTURE` | 同两项 **+ `DETECT_SCREEN_CAPTURE`** | 打平，Pocket 多一道防截屏 |
| 内购/运营内容 | `/api/business/activity/list`、`/redemption/redeem`、`/points` | `assets/november/`（按月运营素材）、`referral/*`、`share-og-*` | 打平 |
| 密钥卫生 | ❌ **两条真实 key 在包内** | 未发现（其 libapp 符号被剥离，未穷尽验证） | **Pocket** |
| 明文流量 | ❌ `usesCleartextTraffic=true` | 未发现 | **Pocket** |
| 系统版本 | minSdk **26** / targetSdk **36** / compileSdk 36 | minSdk **29** / target **36** / compile 36 | 你们覆盖更宽 |
| i18n | `application-label-*` 覆盖数十 locale（多为依赖库贡献，**不足以证明 App 级翻译**）；`copylist.txt` 存在 | **19 个 `config.<lang>` 资源 split**（zh/ja/ko/ru/de/es/fr/pt/vi/th/ar/hi/my/tr/in/en…） | **Pocket**（可证） |

**一句话结论**：移动端你们在**采集能力与片上语音**上对 Pocket 是代差优势；输给它的全在**"生态外围工程"**——系统级入口、日历、断点续传/OTA 的状态建模、热更新、分发通道卫生、密钥卫生。这些恰恰是投入小、感知强的那类活。

---

## 三、桌面端缺的能力 vs 后端已有接口（本次分析最有价值的表）

从 `libapp.so` 提取到 **120 条 Lynse 自有 API 路径**，等价于后端能力清单。与桌面端审计结果对照：

| 桌面端现状 | 移动端在调用的后端接口 | 结论 |
|---|---|---|
| **Trash 是可见的死 UI**（`packages/views/workspace/middle-panel/file-list-filter.ts:13` 对 `"__trash__"` 恒 `return false`；`use-files.ts:226-245` 从不发送 trash 过滤；全仓无 `restore`/`purge` 调用） | **`/api/business/file/recover`**、**`/file/cleanBin`**、**`/file/cleanBinAll`**、`/file/todo/recover`、`/file/delete`(软删) | ♻️ **回收站后端早已存在，移动端在用**。桌面从"新建能力"降级为"补 4 个调用 + 一个列表查询" |
| **转写段是只读 `<p>`**（`packages/views/workspace/content-panel.tsx:1141-1144`），说话人不能改名/合并 | **`/file/trans/edit`**、**`/file/trans/speaker`**、`/file/trans/get`、`/file/trans/status`、**`/api/business/translate/speaker/history`**；改名契约 `PUT /api/business/file/trans/speaker`，body `{taskId, speakerInfoList:[{speakerId, speakerName}]}`（原 `skills/lynse-cli` 已在 `574eee21 清理过期仓库文件` 中删除，故在此内联记录，避免引用悬空） | ✏️ **编辑与说话人接口都在**，且 `speaker/history` 意味着改动可回溯。桌面是纯 UI 活 |
| 聊天不能选模型（`chat-transport.ts:511-514` 请求体只有 `query/sessionId/fileIds`） | **`/file/getAvailableAIModelList`**、`/file/getSummaryOutputLanguage`、`/file/getSupportLanguage`、`/customer/outPutLanguage` | 🎛️ **模型列表接口已存在**，选择器不用等后端 |
| 「报告问题」只跳 GitHub 预填，**无提交路径** | **`/api/business/feedback/submit`** | 📮 **反馈提交接口已存在**，直接对齐 2026-10-03 的优先级 |
| 无分享链接 | **`/api/business/share`** | 🔗 后端有，UI 无 |
| 无推荐/兑换码 | **`/api/business/redemption/redeem`** | 🎁 后端有 |
| `featureFlags.devices: false`（设备页隐藏） | **`/device/bind`、`/device/unbind`、`/device/isBound`、`/device/mine`、`/device/update`** | 📟 硬件配对后端齐全，桌面那页在等的就是它 |
| 发布通道靠人工上传静态 `latest.json`（**卡在 1.1.0，App 已 1.1.6**） | **`/api/business/ota/app/check`**、`/ota/check`、`/ota/presign`、`/ota/function/list` | 🚀 **你们有 OTA 服务端点**。桌面的"最新指针"应由 `/ota/app/check` 提供，而不是一个会遗忘的静态文件 |
| 桌面零遥测 | `/push/init`、`/audit/text`（文本合规审核） | 移动端 Sentry 已就位，桌面可复用同一套 DSN/组织 |
| 无开放 API / MCP 战略 | **`/api/auth/apikey/generate`** | 🔑 **API key 签发能力你们已经有了** —— Pocket 当战略在发的 `/mcp`，你们地基已就位 |
| 无远程配置/实验体系 | **`/api/business/activity/list`**、`/error-messages`、`/api/test` | 📊 有活动接口，可演化成 `app-defaults` 式远程配置 |
| 大文件上传：整文件读进内存 + 单次 PUT（`apps/tauri/src-tauri/src/sync_upload.rs:64-90`） | 移动端也只有 `presign/upload`、`presign/uploadPublic`、`file/sync/pre/{create,sts,notify}` | ⚠️ **分片上传两边后端都没有** —— 这条**确实需要后端配合**（Pocket 有 `storage/{type}/multipart/start\|sign\|complete`），不要误判成 UI 活 |

其余值得记录的后端能力（桌面尚未使用）：`/file/audio/merge(+status)`、`/file/pdf/export`、`/file/mark/image/*`（标注图 CRUD + presign）、`/file/outline/get`、`/file/conclusion/{list,get,batch}`、`/file/category/list`、`/folder/batch-update-sort`、`/file/evaluation/add` + `getEvaluationList`、`/translate/prompt/{categories,custom,detail,favorite,polish}`、`/ai/vocabulary/{bind,bound,enabled}`（桌面已有 ✅）、`/ai/chat/{stream,poll,sessions,recommendations}`（桌面已有 ✅）、`/pointsLog/queryPointsLog`（桌面已有 ✅）、`/customer/membership/refresh`（桌面已有 ✅）、`/error-messages`。

---

## 四、针对桌面端的建议

### 1. 把「密钥泄露」当全公司审计，不是移动端单点

- 立即轮换本文 §P0-1 两条 key；改为服务端代理 + 短期凭证；Google key 加包名/证书 SHA-1 与 referrer 限制。
- **用同一套扫描扫桌面端**：`apps/tauri/src-tauri` 产物、`resources/`，以及 **git 历史**（仓库里的腾讯云 ASR key 需实测确认；历史中出现过的 key 同样要轮换）。
- CI 增加 secret gate，**扫描对象包含最终产物**（不只是源码文本）。
- 顺带复查 OSS 签名 URL 那条遗留项（前端已收口，后端代理仍未做）。

### 2. 发布通道一致性 —— 桌面与移动是同一个根因

- 桌面 `latest.json` 卡 1.1.0 / App 1.1.6；移动 `latest.apk` 卡 1.2.0 / PGYer 1.3.3。**别各修各的**：把「更新 latest 指针」做成发布 CI 的必经步骤，并在发布后自动拉一次 manifest 比对版本号（失败即红）。
- 桌面的终态解法是**把权威指针收进服务**：用你们已有的 `/ota/app/check` 返回下载地址，`tauri.conf.json` 的 endpoint 指向它。现有 minisign pubkey + 双 endpoint 兜底 + `createUpdaterArtifacts` + CI 都不用重写，只缺这一步。
- 移动端：全通道 HTTPS、安装前校验 APK 签名、关掉 `usesCleartextTraffic`（例外用 `network_security_config` 精确到域）、Play flavour 移除 `REQUEST_INSTALL_PACKAGES`。

### 3. 便宜且感知强的桌面功能（全部是接已存在的后端）

| 顺序 | 事项 | 要接的接口 | 涉及代码 |
|---|---|---|---|
| ① | **回收站** | `file/recover`、`cleanBin`、`cleanBinAll` | 替换 `file-list-filter.ts:13` 的恒 false；`use-files.ts` 增加 trash 查询 |
| ② | **说话人合并 / 改名** | `file/trans/speaker`、`translate/speaker/history` | `content-panel.tsx:1123-1195` 段级标签区；声纹注册已领先，补后置编辑面即闭环 |
| ③ | **反馈提交** | `feedback/submit` | 桌面「报告问题」由 GitHub 预填改为提交（GitHub 保留为次要出口） |
| ④ | **模型选择器** | `getAvailableAIModelList` | `chat-transport.ts` 请求体补 `model` 字段 |

> **转写可编辑**建议排在②之后：先有 `trans/edit` 的段落级编辑，再谈 Pocket 式 `transcript-agent`（session + `seq` 乐观锁 + notes 持久化）。
> **分片上传**是唯一需要后端先动的一条，保持 P2。

### 4. 架构（一次性投入，长期收益）

- **拆 Adapter**。桌面现状是单个 `CoreProvider`（`packages/core/platform/core-provider.tsx:75-93` 里 `wsUrl`/`localeAdapter` 还是没人消费的死参数）+ `window.desktopAPI` 全局对象 ~14 命名空间 + views 里 `isWebPlatform()` 和类型断言。Pocket 侧 `TauriPlatformAdapter` **527 B**，Storage/FileSystem/RecordingCommands/Attachment 各 **0.5–2.5 KB 且按平台两份实现**（Tauri/Web）各自成懒加载 chunk —— 证明这件事成本极低，收益是 Web 构建不再携带桌面代码 + **编译器替你查契约**。你们移动端已用 Pigeon 做类型安全双端契约，桌面端理应有同等约束。
- **`tauri-unlisten-guard`**：入口一次性 monkey-patch（包住 `window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener`，只吞判定条件命中的错误、用 Symbol 保证幂等、首次吞掉时打一条 debug），**<20 行**。桌面现状：11 处 `listen` 各自手写 `disposed` 竞态标志、unlisten 裸调无幂等、`apps/tauri/src/main.tsx:55` 的监听从不解除；同一个 TypeError 只在 `apps/tauri/src/e2e/tauri-shim.ts:176-184` 被承认过（仅测试桩）。
- **桌面补 Sentry，复用移动端资产**。移动已有 `libsentry.so`/`libsentry-android.so`，桌面零遥测 → 这条从"要不要引入 SDK"的成本讨论，变成"同一账号再加一个 platform + 符号上传"。
- **音频格式对齐**。移动端在用 `libopus`/`libnveasyopus`/`liblame-mp3`，桌面仍是 WAV 整文件读内存上传 → 按移动端编码器选型收口桌面方案（Downloads 里的 `opus-transcode-upload-plan.md`），带宽与内存两头一起解决。
- **借鉴 Pocket 的两条数据层做法**（与平台无关，桌面可直接用）：`upload_queue(status, next_attempt_at)` 复合索引做定时扫表重试（治你们 `syncStatus:"pending"` 永不重试的问题），以及远程资源的 `{resource, classification, staleTimeMs, gcTimeMs, maxAgeMs, durable, persistStrategy, version}` 策略注册表（演进你们现有的 query-persistence）。

---

## 五、如何复核（复现命令）

```bash
A="/c/Users/johne/AppData/Local/Android/Sdk/build-tools/36.0.0/aapt2.exe"
"$A" dump badging Lynse_1.3.3.apk                       # 包名/版本/sdk/权限/native-code
"$A" dump xmltree --file AndroidManifest.xml <apk>      # 组件、exported、intent-filter、application 属性
unzip -l <apk> | sort -rn -k1 | head                    # 体积热点
node scan-secrets.mjs ex133/lib/arm64-v8a/libapp.so ex133/classes*.dex
node -e '…'   # libapp.so 中提取 /api/ 路径（见本文第三节）
```

产物位置（仓库外，不会被 grep 到）：
- `C:\Users\johne\Documents\Work\pocket-re\lynse-apk\` — `m133.txt`（1.3.3 完整清单 xmltree，925 行）、`p120.txt`/`p133.txt`（权限差集）、`ex133/`、`ex120/`、`scan-secrets.mjs`
- `C:\Users\johne\Documents\Work\pocket-re\mobile\` — Pocket XAPK 相关
- `C:\Users\johne\Documents\Work\pocket-re\extracted\` — Pocket Windows 桌面前端（406 文件）

## 六、本文的边界与更正记录

**未证实**：Dart 层业务逻辑（同步状态机、隐私模式开关如何传播到埋点、那两个 key 的实际调用点）——需要 `libapp.so` snapshot 解析或移动端仓库源码。本文所有结论来自清单、文件名、字符串与资源，**没有动态验证**。

**已更正**（记录以免以讹传讹）：
- ~~"`14.so` 是异常/加固产物"~~ → 我的正则漏了文件名中的点，实为 **`libtnet-3.1.14.so`**（阿里 accs 网络栈），1.2.0/1.3.3 均有。
- ~~"包体掉了约 42 MB"~~ → 混淆 MB/MiB。PGYer 的 144.8 是 **MiB**；实际 178.3 MiB → 144.8 MiB，**降 33.5 MiB**。
- ~~"Lynse 无硬件，Pocket 移动端不可比"~~ → **Lynse 有硬件与移动端，桌面端只是生态的一条腿**。该结论已作废，本文即为修正后的对位分析。
