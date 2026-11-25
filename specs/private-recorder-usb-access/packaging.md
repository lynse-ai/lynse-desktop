# 录音卡插件打包

公开工作区可以独立构建。私有构建需要把以下目录放到工作区中的相同位置，目录均已加入 Git 忽略规则。

- `apps/tauri/src/private-plugins/` 提供桌面插件注册和 IPC 接线。
- `apps/tauri/src-tauri/src/recording_card_private/` 提供原生 USB 会话。
- `apps/tauri/src-tauri/recording-card-ownership/` 提供按 Rust target 选择的预编译静态库。
- `apps/web/app/plugins/(private-plugins)/recording-card/` 提供 Web 页面。
- `apps/web/app/api/(private-plugins)/recording-card/` 提供 Web 服务端接口及 `verify.wasm`。
- `packages/views/recording-card-private/` 提供共享页面和插件清单。
- `.recording-card-ownership/` 保存校验器源码和本机编译脚本。改动校验器后，运行 `bash .recording-card-ownership/build.sh` 更新私有输入中的全部二进制。

在私有发布工作区将 `LYNSE_REQUIRE_PRIVATE_RECORDING_CARD=1` 加到现有桌面和 Web 构建命令。输入缺失时构建会失败。桌面插件沿用原安装 ID 和设备页，Web 沿用 `/app/plugins/recording-card`。Web 的 standalone 产物需带上输出追踪收集的 `verify.wasm`。

USB 握手后，两个入口从设备读取身份，再用当前会话查询账号后台的绑定。连接、刷新文件列表、开始下载和修改卡内文件都需要成功验证；退出账号、断开设备或复验被拒绝会关闭会话。现有固件的密码握手仍适用于 USB 传输。卡本身的账号授权需要固件支持。
