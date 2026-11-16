// Copy for the recording-card USB management page (web standalone route).
// zh-Hant/ja/ko fall back for now, mirroring custom-models/locales.ts.
const en = {
  title: "Recording card",
  subtitle: "Manage the recordings on your recording card over USB.",
  unsupported_title: "This browser can't reach the recording card",
  unsupported_body:
    "USB access needs a Chromium browser (Chrome or Edge) on a secure page. Open this link in Chrome or Edge to continue.",
  unsupported_copy: "Copy link",
  unsupported_copied: "Copied",
  usb_access: "USB access",
  usb_hint:
    "Off by default. While on, this page talks to the card over USB in your browser — recordings only leave the card when you download them.",
  status_off: "Not connected",
  status_connecting: "Waiting for the card…",
  status_connected: "Connected: {{name}}",
  connect: "Connect recording card",
  disconnect: "Disconnect",
  retry: "Retry",
  err_connect_failed: "Connection failed: {{message}}",
  files_title: "Recordings on the card",
  refresh: "Refresh",
  empty: "No recordings on the card.",
  list_failed: "Could not read the file list. Check the connection and refresh.",
  storage_free: "{{free}} free of {{total}}",
  download: "Download",
  download_progress: "{{percent}}%",
  delete: "Delete",
  delete_confirm: "Confirm delete",
  delete_hint: "This permanently deletes {{name}} from the card.",
  action_failed: "Operation failed: {{message}}",
  download_incomplete:
    "Transfer interrupted — the saved file is incomplete. Retry the download to start over.",
};

const zh: typeof en = {
  title: "录音卡",
  subtitle: "通过 USB 管理录音卡内的录音。",
  unsupported_title: "当前浏览器无法访问录音卡",
  unsupported_body:
    "USB 访问需要在安全页面中使用 Chromium 内核浏览器（Chrome 或 Edge）。请在 Chrome 或 Edge 中打开此链接继续。",
  unsupported_copy: "复制链接",
  unsupported_copied: "已复制",
  usb_access: "USB 访问",
  usb_hint:
    "默认关闭。开启后本页通过浏览器 USB 直连录音卡；只有点击下载时录音才会离开卡片。",
  status_off: "未连接",
  status_connecting: "正在等待录音卡…",
  status_connected: "已连接：{{name}}",
  connect: "连接录音卡",
  disconnect: "断开连接",
  retry: "重试",
  err_connect_failed: "连接失败：{{message}}",
  files_title: "卡内录音",
  refresh: "刷新",
  empty: "卡内还没有录音。",
  list_failed: "读取文件列表失败，请检查连接后刷新。",
  storage_free: "剩余 {{free}} / 共 {{total}}",
  download: "下载",
  download_progress: "{{percent}}%",
  delete: "删除",
  delete_confirm: "确认删除",
  delete_hint: "将从卡内永久删除 {{name}}。",
  action_failed: "操作失败：{{message}}",
  download_incomplete: "传输中断，已保存的文件不完整。重新下载将从头开始。",
};

export const recordingCardLocales = {
  en,
  "zh-Hans": zh,
  "zh-Hant": zh,
  ja: en,
  ko: en,
};
