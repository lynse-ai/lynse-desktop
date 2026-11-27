# NvEasy WebUSB → Rust 协议参考（2026-11-17 实测/静态还原）

来源：`NvEasy-WebUSB-SDK_20261107/sdk/dist/index.js`（270KB ESM，javascript-obfuscator 混淆但无控制流平坦化/无域名锁）、`sdk/dist/index.d.ts`、`doc/接口说明.md`，以及在 Node 中用 mock USBDevice + SDK 真实运行抓到的传输日志（`/tmp/nveasy-capture2.mjs`、`/tmp/nveasy-auth2.mjs`、`/tmp/nveasy-prefix-probe/filelist-success.mjs`、`/tmp/nveasy-prefix-probe/readtext.mjs`）。

> 本文件是本地工程参考，不进发布物。任何字段如与真机不符，以真机为准并回来修订。

## 设备枚举 / 接口

- VID/PID 默认 `0x3654` / `0x4155`（页面输入框可改，服务端预填可选）
- SDK 选厂商专用接口：`claimInterface` 找到 **interface 0**，其 bulk endpoint **OUT=2 (0x02) / IN=2 (0x82)**（web 端 `navigator.usb.getDevices()` 真机描述符实锤：两个端点 `endpointNumber` 都是 2，仅 direction 不同）。Rust 不再硬编码，按 `0xff` interface + bulk IN/OUT 动态发现地址
- 接口寻找逻辑：遍历 `configuration.interfaces[].alternates[]`，按接口类/端点方向配对（Proxy trace 实锤：读 `configurationValue`/`interfaceClass`/`endpoints[].direction/type`）
- SDK 调用 `selectConfiguration(1)` 后占用接口。桌面端在 Windows 下使用系统已激活的配置，在 macOS 下先设置选中的配置，再调用 `claim_interface`。

## 口令握手（关键，实锤）

```
connection.control_out(
  request_type=Standard, recipient=Interface,
  request=0x12, value=0, index=0,
  data = UTF-8(password)          // 裸字节，不加 #、不加 NUL
)
connection.control_in(
  request_type=Standard, recipient=Interface,
  request=0x13, value=0, index=0, length=?
)
// 成功应答 = 单字节 0x01；失败/错口令 = 0x00 → SDK 关闭设备并抛 NvEasyError("口令校验失败，已断开连接")
```

抓帧证据：
- `CTRL_OUT setup={"requestType":"standard","recipient":"interface","value":0,"index":0,"request":18} bytes=[31 32 33 34 35 36 37 38]`
- CTRL_IN(req=0x13) 返回 `[0x01]` → 进入后续流程（「设备未连接」是下一阶段 mock 没数据导致）；返回 `[0x00]` → 「口令校验失败」

**注意**：connect() 在发口令前会先 drain 一批 BULK IN 帧（设备启动日志/版本上报），真机 Rust 实现要先 `drainQuiet`（短超时读空）再做 control 握手。

## 文本帧

- 编码：UTF-8，`<PREFIX>#<cmd>#<p1>#…#<pn>#`（尾部 `#` 结尾）
- 解析：`text.replace(/\0/g,'').trim().split('#')` → NUL 填充/补齐到定长，解析前必须去 NUL + trim
- PREFIX：SDK 反混淆 + mock 运行实锤：请求帧固定 `*APP#…#`，设备应答固定 `*DEV#…#`；`readTextFrame()` 只接受 `*DEV#<cmd>#`。旧笔记里「待真机替换」的说法已作废。
- 命令表（`C` 映射，name → 期望应答段数，来自 SDK 原文）：
  `version:2, battery:3, mem:2, getlist:1, flist:2, authsn:4, rtc:2, cmicgain:4, micgain:4, filecmd:1, default:1, format:1, fmtret:3, bound:2, unbound:2, delfile:3, offtime:2, cofftime:2, upgrade:1, otareq:2`
- 应答命令名：多数命令同名应答；`format→fmtret`。`getlist` 不是直接回整张列表，而是先回 `*DEV#getlist#0#` 状态，再回 `*DEV#flist#<bytes>#<packets>#` 头，随后走 `listreq` JSON 分包（见下）

## 二进制帧（下载）

- 帧头：文本 `<prefix>#<cmd>#<len>#<crc32>#` + 原始 payload 字节（拼接在同一缓冲区）
- CRC32：反射实现，poly `0xEDB88320`，init `0xFFFFFFFF`，末尾 `^ 0xFFFFFFFF`
- 传输：1024B chunk（SDK 常量 `y=0x400`），每文件带 `frameSize` 字段按帧读取
- 下载续传：`downloadFile(file, onProgress, offset)`，中断错误带 `partial: Uint8Array`（已收连续数据），下次 `offset=partial.length` 续传
- `offset == file.size` → 立即返回空数据
- 停止：`pauseDownload()`（下一等待点停）、`cancelTransfer()`、`stopTransfer()`（通知设备停发并清缓冲）

## 文件列表 / 其他

- `getFileList()` → `DeviceFile[]`：`{sn, name, size, scene, startTime, endTime, crc, frameSize}`，设备无索引时返回空数组
- 实锤分包序列（Node mock 中运行 SDK `getFileList()` 抓到，`/tmp/nveasy-prefix-probe/filelist-success.mjs`）：
  1. 写 `*APP#getlist#`
  2. 读 `*DEV#getlist#0#`（`1` 会让 SDK 抛「设备拒绝返回文件列表」）
  3. 读 `*DEV#flist#<totalPayloadBytes>#<packetCount>#`
  4. 写 `*APP#flist#0#`
  5. 对 `i = 1..packetCount`：写 `*APP#listreq#0#<i>#`，读 `*DEV#listreq#<i>#<payloadLength>#<crc>#<payloadBytes>`；`parts[2]` 必须等于 `i`，`parts[3]` 是这段 JSON 字节数
  6. 写 `*APP#listreq#0#0#` 收尾，拼接所有 payload 后按顶层 JSON 数组解析
- SDK 的 `P()`：只接受顶层数组；数字字段的数字字符串会转 number，缺失字段补 `0` / `""`；`{files:[...]}` 会得到 `[]`。真机 JSON 的 `start_time` / `end_time` / `frame_size` 会被映射成 `startTime` / `endTime` / `frameSize`（`/tmp/nveasy-prefix-probe/p-snake.mjs` 实锤），Rust 解析需做 camelCase 优先 + snake_case 兜底
- `getStorage()` → `{freeSpace, totalSpace}` KB；设备先回占位 `(0,0)`，SDK 等待真正容量上报（20s 超时常量 `0x4e20` 在列表路径）
- `deleteFile(name)` → `{result, detail[]}`，`result==0` 成功
- `setTime(unix_secs)`、`getVersion`、`getBattery`、`getIdentity`、`getMicGain/setMicGain`、`setBound/unbind`、`factoryReset`、`formatStorage`、`getAutoOff/setAutoOff`、`custom`、`upgradeFirmware` 均走同一文本帧通道

### 已落地的设备管理帧（SDK mock 实锤）

| 功能 | 请求 | 应答 |
| --- | --- | --- |
| 空闲自动关机查询 | `*APP#cofftime#` | `*DEV#cofftime#0#<minutes>#` |
| 空闲自动关机设置 | `*APP#offtime#<minutes>#` | `*DEV#offtime#0#<minutes>#` |
| 麦克风增益查询 | `*APP#cmicgain#<mode>#` | `*DEV#cmicgain#0#<mode>#<mic1>#<mic2>#` |
| 麦克风增益设置 | `*APP#micgain#<mode>#<mic1>#<mic2>#` | `*DEV#micgain#0#<mode>#<mic1>#<mic2>#` |
| 绑定 | `*APP#bound#1#` | `*DEV#bound#0#1#` |
| 解绑（不格式化） | `*APP#unbound#1#0#` | `*DEV#unbound#0#1#0#` |
| 解绑并格式化 | `*APP#unbound#2#1#` | 同上 |
| 恢复出厂 | `*APP#default#` | `*DEV#default#0#` |
| 格式化存储 | `*APP#format#` | `*DEV#fmtret#0#<...>#` |

`mode`：`0` 会议 / `1` 通话；增益有效范围 `0..19`。自动关机分钟数限制 `1..36000`。格式化只等 `fmtret` 的结果位，不再等待容量上报；成功后 UI 主动刷新存储与文件列表。设备概览中的「对时状态」使用连接时 `rtc` 的应答结果位，连接仍为 best-effort，失败不阻断会话。

## Rust 实现要点

- 依赖：`nusb`（枚举/control/bulk）+ `crc32fast`（或手写，唯一必须 CRC 算法已定）+ 已有 `tokio`/`serde`/`thiserror`
- 握手顺序：打开前先从描述符找 `0xff` vendor interface 的 bulk IN/OUT 地址 → open → set_config → claim(interface) → drainQuiet(bulk IN) → control_out(0x12, password) → control_in(0x13) 判 0x01 → authenticated
- 文本帧收发：bulk IN 地址 `0x82` / OUT 地址 `0x02`（endpointNumber 都是 2）；请求用 `*APP`，应答应按 `*DEV` 解析；`0x00` 去填充后按 `#` split。一次 bulk IN 可能含多帧或半帧，需维护 pending 缓冲并跳过非目标帧
- 端点生命周期：nusb 的 `Interface::endpoint::<Bulk, _>()` 对端点独占；把 IN/OUT 端点句柄长期保存在 `CardDevice` 中复用，不能每次读写都重新 `endpoint()`，否则并发命令会得到 `endpoint already in use`
- 并发：用 session 级 I/O mutex 串行化 `listFiles` / `storage` / `delete` / download，避免两个命令争抢同一个 pending 帧缓冲；Web SDK 的 `exclusive(fn)` 队列也是这个语义
- 文件列表：按上面的 `getlist / flist / listreq` 序列读 JSON 分包；用 `serde_json` 解析顶层数组，数字字符串/缺失字段按 SDK `P()` 兼容，并映射 `start_time` / `end_time` / `frame_size`
- 下载帧序列（SDK mock 实锤，`/tmp/nveasy-prefix-probe/download-probe.mjs`）：请求 `*APP#filect#0#<sn>#1#0#<offset>#`；数据帧 `*DEV#filect#<sn>#<totalPackets>#<packetIndex>#<len>#<crc>#<payload>`，`packetIndex` 从 1 开始，收齐 `1..=totalPackets` 后结束；取消帧是 `*APP#filecmd#0#`，旧 BLE 的 `filecmd#1#...` 不适用
- 下载转码：卡内文件是定长裸 Opus packet（`frameSize` 字节/包，通常 80 = 40ms / 16kHz stereo），没有容器/帧头；Rust 下载后按旧 NewView 集成的做法解成 16kHz mono PCM，再写带 RIFF/WAVE 头的 `.wav`，保存对话框建议名也改为 `.wav`
- 文件命名：设备名是随机 hex（如 `c84714.raw`），列表和进度条改用 `start_time` 转成本地时间 `YYYY-MM-DD HH:MM:SS`（半角冒号，与 web 端一致），时间戳无效时才回退设备名；列表同时用时钟图标 + `end_time - start_time` 显示录音时长；Web 下载保留原扩展名，桌面端保存为 `.wav`
- 下载：连续 bulk IN 拼帧 → 校验长度/CRC → 直写磁盘（tmp 文件）→ 进度 Channel → 校验字节数 == file.size → 完成
- 内存：不再整文件驻留（Web JS 版是整 Uint8Array）；Rust 流式写盘天然无此问题
- 会话安全：拔线 / 插件停用 / 关闭开关 → 取消任务 + release_interface + close；口令由 Rust 直接调 `lynse-agent-auth` `POST /platform/oauth/api/agent/device/recording-card/credential`（用已保存 token），不下发前端

## 待真机确认（4 项已全部解完）

1. ✅ control setup 四字段（standard/interface/0/0, req 0x12→口令, req 0x13→0x01 成功）
2. ✅ 鉴权成功应答（0x01）
3. ✅ bulk endpoint（IN `0x82` / OUT `0x02`；web 端真机描述符实锤，两个 endpointNumber 都是 2）
4. ✅ 文本帧 PREFIX token：请求 `*APP`，应答 `*DEV`（反混淆 + SDK mock 双向验证）
