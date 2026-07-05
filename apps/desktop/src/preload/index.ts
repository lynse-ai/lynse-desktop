import { contextBridge, ipcRenderer } from "electron";
import { electronAPI } from "@electron-toolkit/preload";

const desktopAPI = {
  openExternal: (url: string) => ipcRenderer.invoke("shell:openExternal", url),
  localTranscription: {
    pickAudioFile: () => ipcRenderer.invoke("local-transcription:pickAudioFile"),
    transcribe: (audioPath: string, options?: unknown) => ipcRenderer.invoke("local-transcription:transcribe", audioPath, options),
    list: () => ipcRenderer.invoke("local-transcription:list"),
    get: (id: string) => ipcRenderer.invoke("local-transcription:get", id),
    retry: (id: string) => ipcRenderer.invoke("local-transcription:retry", id),
    delete: (id: string) => ipcRenderer.invoke("local-transcription:delete", id),
    getAudioUrl: (id: string) => ipcRenderer.invoke("local-transcription:getAudioUrl", id),
    getModelStatus: () => ipcRenderer.invoke("local-transcription:getModelStatus"),
    downloadModel: () => ipcRenderer.invoke("local-transcription:downloadModel"),
    deleteModel: () => ipcRenderer.invoke("local-transcription:deleteModel"),
    listHotwordPackages: () => ipcRenderer.invoke("local-transcription:listHotwordPackages"),
    saveHotwordPackage: (pkg: unknown) => ipcRenderer.invoke("local-transcription:saveHotwordPackage", pkg),
    deleteHotwordPackage: (id: string) => ipcRenderer.invoke("local-transcription:deleteHotwordPackage", id),
    listVoiceprints: () => ipcRenderer.invoke("local-transcription:listVoiceprints"),
    createVoiceprint: (input: unknown) => ipcRenderer.invoke("local-transcription:createVoiceprint", input),
    updateVoiceprint: (voiceprint: unknown) => ipcRenderer.invoke("local-transcription:updateVoiceprint", voiceprint),
    deleteVoiceprint: (id: string) => ipcRenderer.invoke("local-transcription:deleteVoiceprint", id),
  },
  appInfo: {
    version: "0.1.0",
    platform: process.platform,
  },
};

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld("electron", electronAPI);
  contextBridge.exposeInMainWorld("desktopAPI", desktopAPI);
} else {
  // @ts-expect-error - fallback for non-isolated context
  window.electron = electronAPI;
  // @ts-expect-error - fallback for non-isolated context
  window.desktopAPI = desktopAPI;
}
