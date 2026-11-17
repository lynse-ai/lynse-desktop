# NvEasy WebUSB → Rust 协议参考（2026-11-17 实测/静态还原）

来源：`NvEasy-WebUSB-SDK_20261107/sdk/dist/index.js`（270KB ESM，javascript-obfuscator 混淆但无控制流平坦化/无域名锁）、`sdk/dist/index.d.ts`、`doc/接口说明.md`，以及在 Node 中用 mock USBDevice + SDK 真实运行抓到的传输日志（`/tmp/nveasy-capture2.mjs`、`/tmp/nveasy-auth2.mjs`）。

> 本文件是本地工程参考，不进发布物。任何字段如与真机不符，以真机为准并回来修订。

## 设备枚举 / 接口

- VID/PID 默认 `0x3654` / `0x4155`（页面输入框可改，服务端预填可选）
- SDK 选厂商专用接口：`claimInterface` 找到 **interface 0**，其 bulk endpoint **OUT=1 / IN=2**（抓帧日志：`[nveasy] 已声明接口 0，OUT 1 / IN 2`）
- 接口寻找逻辑：遍历 `configuration.interfaces[].alternates[]`，按接口类/端点方向配对（Proxy trace 实锤：读 `configurationValue`/`interfaceClass`/`endpoints[].direction/type`）
- `selectConfiguration(1)` 后 claim；Rust nusb 对应 `device.set_config(1)` + `claim_interface(0)`

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
- PREFIX：混淆串表里（旧 BLE 版是 `*APP#`/`*DEV#`；WebUSB 版相同思路但 token 需真机抓一帧或反混淆确认——**实现时先用旧 `*APP#` 做可配置常量，真机抓帧后替换**）
- 命令表（`C` 映射，name → 期望应答段数，来自 SDK 原文）：
  `version:2, battery:3, mem:2, getlist:1, flist:2, authsn:4, rtc:2, cmicgain:4, micgain:4, filecmd:1, default:1, format:1, fmtret:3, bound:2, unbound:2, delfile:3, offtime:2, cofftime:2, upgrade:1, otareq:2`
- 应答命令名与请求不同（如 `getlist→flist`、`format→fmtret`、`bound/unbound`），实现按映射表核对

## 二进制帧（下载）

- 帧头：文本 `<prefix>#<cmd>#<len>#<crc32>#` + 原始 payload 字节（拼接在同一缓冲区）
- CRC32：反射实现，poly `0xEDB88320`，init `0xFFFFFFFF`，末尾 `^ 0xFFFFFFFF`
- 传输：1024B chunk（SDK 常量 `y=0x400`），每文件带 `frameSize` 字段按帧读取
- 下载续传：`downloadFile(file, onProgress, offset)`，中断错误带 `partial: Uint8Array`（已收连续数据），下次 `offset=partial.length` 续传
- `offset == file.size` → 立即返回空数据
- 停止：`pauseDownload()`（下一等待点停）、`cancelTransfer()`、`stopTransfer()`（通知设备停发并清缓冲）

## 文件列表 / 其他

- `getFileList()` → `DeviceFile[]`：`{sn, name, size, scene, startTime, endTime, crc, frameSize}`，设备无索引时返回空数组
- `getStorage()` → `{freeSpace, totalSpace}` KB；设备先回占位 `(0,0)`，SDK 等待真正容量上报（20s 超时常量 `0x4e20` 在列表路径）
- `deleteFile(name)` → `{result, detail[]}`，`result==0` 成功
- `setTime(unix_secs)`、`getVersion`、`getBattery`、`getIdentity`、`getMicGain/setMicGain`、`setBound/unbind`、`factoryReset`、`formatStorage`、`getAutoOff/setAutoOff`、`custom`、`upgradeFirmware` 均走同一文本帧通道

## Rust 实现要点

- 依赖：`nusb`（枚举/control/bulk）+ `crc32fast`（或手写，唯一必须 CRC 算法已定）+ 已有 `tokio`/`serde`/`thiserror`
- 握手顺序：open → set_config → claim(0) → drainQuiet(bulk IN) → control_out(0x12, password) → control_in(0x13) 判 0x01 → authenticated
- 文本帧收发：bulk IN ep=2 / OUT ep=1；NUL 去填充按 `#` split
- 下载：连续 bulk IN 拼帧 → 校验长度/CRC → 直写磁盘（tmp 文件）→ 进度 Channel → 校验字节数 == file.size → 完成
- 内存：不再整文件驻留（Web JS 版是整 Uint8Array）；Rust 流式写盘天然无此问题
- 会话安全：拔线 / 插件停用 / 关闭开关 → 取消任务 + release_interface + close；口令由 Rust 直接调 lynclaw `/api/desktop/recording-card/config`（用已保存 token），不下发前端

## 待真机确认（4 项里已解 3 项）

1. ✅ control setup 四字段（standard/interface/0/0, req 0x12→口令, req 0x13→0x01 成功）
2. ✅ 鉴权成功应答（0x01）
3. ✅ bulk endpoint（IN 2 / OUT 1）
4. ⚠️ 文本帧 PREFIX token（可从真机任意命令帧抓一次，或允许 `NVEASY_FRAME_PREFIX` 常量配置后现场替换）
