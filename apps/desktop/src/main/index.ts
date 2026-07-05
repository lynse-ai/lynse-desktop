import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "path";
import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import { registerLocalTranscriptionIpc } from "./local-transcription";

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 13 },
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow?.show();
    // Only open DevTools when explicitly requested (e.g. DEBUG_DEVTOOLS=1)
    if (is.dev && process.env.DEBUG_DEVTOOLS === "1") {
      mainWindow?.webContents.openDevTools({ mode: "detach" });
    }
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    require("electron").shell.openExternal(details.url);
    return { action: "deny" };
  });

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

const DEV_APP_NAME = "Lynse Dev";

if (is.dev) {
  app.setName(DEV_APP_NAME);
  app.setPath("userData", join(app.getPath("appData"), DEV_APP_NAME));
} else {
  app.setName("Lynse");
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    electronApp.setAppUserModelId(
      is.dev ? "app.lynse.desktop.dev" : "app.lynse.desktop",
    );

    app.on("browser-window-created", (_, window) => {
      optimizer.watchWindowShortcuts(window);
    });

    ipcMain.handle("shell:openExternal", (_event, url: string) => {
      require("electron").shell.openExternal(url);
    });

    registerLocalTranscriptionIpc({
      app,
      ipcMain,
      getMainWindow: () => mainWindow,
    });

    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
