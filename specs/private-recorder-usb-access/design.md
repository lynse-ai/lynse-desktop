# Lynse 内访问录音卡的技术评估

方案 1 可以进入实机验证。现有 SDK 能在独立进程中通过兼容 WebUSB 的原生 USB 库枚举设备，Tauri 可以沿用现有的桌面桥接层。量产卡的鉴权、文件下载和 Windows 驱动绑定是下一阶段的判断依据。

## 已验证

| 验证项 | 结果 |
| --- | --- |
| macOS 的 WKWebView | 本地安全上下文中 `navigator.usb` 为 `undefined`。 |
| SDK 配合 `node-usb` 3.2.1 | Apple Silicon 上加载原生模块后成功枚举本机 USB 设备。SDK 的 `isSupported()` 返回 `true`，`requestDevice()` 用无匹配的测试 VID/PID 返回未选中设备。覆盖了连接所需的方法和断开事件注册。 |
| SDK 接入模拟设备 | SDK 选取厂商专用接口，连接中执行接口级 control 鉴权和 Bulk `usbauth`。模拟鉴权通过后直接发出 `getlist`。模拟鉴权失败后释放接口、关闭设备并移除断开监听，列表请求被拦截。 |
| Rust `nusb` 0.2.9 | Apple Silicon 上执行了只读设备枚举并创建插拔监听。包含接口占用、Bulk 端点和 control 读写的探针交叉编译生成 Windows x64 GNU 可执行文件。Windows 上的运行和驱动绑定待验证。 |

用户插入录音卡后，Mac 的 USB 枚举未出现录音卡，系统也未挂载新的存储卷。真机鉴权、列表和下载需要先让设备枚举。

## 读取开关的作用

厂商 Demo 用模拟设备通过口令校验后，文件同步区直接提供「获取文件列表」和「批量下载」。Lynse 的「USB 访问」开关可在开启时调用 `connect()`，鉴权成功后允许读取，关闭时调用 `disconnect()`。这版 SDK 的公开接口从设备已枚举开始工作。若量产卡默认关闭 USB 数据接口，需要确认卡片按键、其他通信通道或配套固件的启用方式。旧版安卓的 `querySwitch` 对应会议与通话录音模式。

## 最短实机验证路径

1. 使用与量产版本一致的测试卡、VID/PID 和配套口令。先通过厂商 Chrome/Edge demo 验证鉴权、录音列表和一份短录音下载，建立参考结果。
2. 在独立 Node 进程里把 `node-usb` 提供的 `USBDevice` 交给 `NvEasyClient`。使用真实 VID/PID 精确筛选设备，凭证在本机输入。依次执行 `connect`、`getFileList`、`downloadFile`、`disconnect`，将样本存到临时目录，用长度和 SHA-256 与参考下载比较。macOS 和 Windows 各跑一遍，Windows 核对目标接口的 WinUSB 绑定。
3. 用 `ffprobe` 识别音频容器和编码，并验证播放与现有导入。旧移动端的蓝牙下载会将设备 Opus 数据解码并转为 MP3。USB 样本如果也是裸帧，需要硬件方确认帧边界、采样率、声道数和对应解码方式。
4. 用长录音测量下载峰值内存。模拟拔线与重连，比较续传合并和一次性下载的结果。还要确认录音中和手机同步中时，设备允许的操作和占用状态。

## 桌面端实现边界

- 设置中提供「录音卡」入口。开关开启后，桌面端识别匹配设备，鉴权成功后显示录音列表。列表操作包含复制到本地、导入 Lynse，以及明确确认后删除原件。
- 界面沿用 `window.desktopAPI`。桌面桥接暴露连接、状态、列表、下载、取消和删除。USB 会话限定为录音卡的 VID/PID 和厂商接口。会话中串行执行传输，设备断开和开关关闭时结束任务并释放接口。
- `node-usb` 和现有 JS SDK 适合先做实机探针。正式版优先评估厂商原生 SDK，或根据正式协议使用 Tauri/Rust 的 `nusb` 后端。若厂商只提供 JS SDK，则以实机兼容性、安装体积、打包签名和长录音内存为依据，评估随应用打包隔离进程。生产打包前确认 SDK 再分发方式。
- 文件由桌面后端写到选定位置的临时文件，校验后再交付给用户或导入流程。导入应保留应用管理的本地副本，现有本地转写记录会引用传入的路径。界面只接收进度和结果。SDK V1.0.0 的 `downloadFile` 在返回时持有整个文件，需要厂商流式接口或经长录音测试验证的文件大小上限。

## 何时评估方案 2

在量产固件上优先验证方案 1。若目标平台无法获得可交付的厂商 USB 接口、兼容驱动或稳定的完整下载，且硬件方无法补齐，再检查固件能否提供可挂载的 USB 大容量存储卷。方案 2 仍需验证 MSC 切换、安全弹出与切回，以及卷中录音能否由用户直接打开。

资料见 [Node USB](https://node-usb.github.io/node-usb-rs/)、[nusb 平台支持](https://docs.rs/nusb/0.2.9/nusb/#platform-support)、[微软 WinUSB 绑定](https://learn.microsoft.com/en-us/windows-hardware/drivers/usbcon/automatic-installation-of-winusb)。
