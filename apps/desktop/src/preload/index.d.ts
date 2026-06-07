import type { ElectronAPI } from "@electron-toolkit/preload";

interface DesktopAPI {
  openExternal: (url: string) => Promise<void>;
  appInfo: {
    version: string;
    platform: string;
  };
}

declare global {
  interface Window {
    electron: ElectronAPI;
    desktopAPI: DesktopAPI;
  }
}
