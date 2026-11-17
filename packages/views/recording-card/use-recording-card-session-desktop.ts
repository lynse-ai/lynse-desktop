"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchRecordingCardConfig } from "./credentials";
import { recordingCardDisplayName } from "./file-name";
import {
  getRecordingCardUsbApi,
  type RecordingCardConnectResult,
  type RecordingCardDownloadProgress,
  type RecordingCardFile,
  type RecordingCardMicGain,
  type RecordingCardMicMode,
  type RecordingCardSessionView,
  type RecordingCardStorage,
} from "./transport";

/**
 * Desktop session hook backed by the native Rust USB transport. The pairing
 * password is fetched from the authenticated web session and handed to Rust
 * at connect time — never stored or logged. All USB I/O, downloads and file
 * writes happen in Rust; this hook only drives state and progress.
 */
export function useRecordingCardSessionDesktop(): RecordingCardSessionView {
  const api = getRecordingCardUsbApi();
  const [usbEnabled, setUsbEnabledState] = useState(false);
  const [phase, setPhase] = useState<RecordingCardSessionView["phase"]>("off");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [deviceSn, setDeviceSn] = useState<string | null>(null);
  const [clockSynced, setClockSynced] = useState<boolean | null>(null);
  const [files, setFiles] = useState<RecordingCardFile[]>([]);
  const [storage, setStorage] = useState<RecordingCardStorage | null>(null);
  const [listError, setListError] = useState(false);
  const [autoOffMinutes, setAutoOffMinutes] = useState<number | null>(null);
  const [micGain, setMicGainState] = useState<RecordingCardMicGain | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [download, setDownload] = useState<RecordingCardDownloadProgress | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const teardown = useCallback(async () => {
    if (mountedRef.current) {
      setDeviceName(null);
      setDeviceSn(null);
      setClockSynced(null);
      setFiles([]);
      setStorage(null);
      setDownload(null);
      setListError(false);
      setAutoOffMinutes(null);
      setMicGainState(null);
      setSettingsLoading(false);
      setActionError(null);
    }
    try {
      await api?.disconnect();
    } catch {
      // device already gone
    }
  }, [api]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      void api?.disconnect().catch(() => undefined);
    };
  }, [api]);

  const setAccess = useCallback(
    (enabled: boolean) => {
      setUsbEnabledState(enabled);
      if (!enabled) {
        setErrorMessage(null);
        void teardown().then(() => {
          if (mountedRef.current) setPhase("off");
        });
      }
    },
    [teardown],
  );

  const refreshFiles = useCallback(async () => {
    if (!api) return;
    setListError(false);
    const [listResult, storageResult] = await Promise.allSettled([
      api.listFiles(),
      api.storage(),
    ]);
    if (!mountedRef.current) return;
    if (listResult.status === "fulfilled") {
      setFiles(listResult.value);
    } else {
      setListError(true);
    }
    if (storageResult.status === "fulfilled") {
      setStorage(storageResult.value);
    }
  }, [api]);

  const refreshSettings = useCallback(async () => {
    if (!api) return;
    setSettingsLoading(true);
    const [autoOffResult, micGainResult] = await Promise.allSettled([
      api.getAutoOff(),
      api.getMicGain(0),
    ]);
    if (!mountedRef.current) return;
    setAutoOffMinutes(autoOffResult.status === "fulfilled" ? autoOffResult.value : null);
    setMicGainState(
      micGainResult.status === "fulfilled" && micGainResult.value.result === 0
        ? micGainResult.value
        : null,
    );
    setSettingsLoading(false);
  }, [api]);

  const refreshMicGain = useCallback(
    async (mode: RecordingCardMicMode) => {
      if (!api) return;
      try {
        const result = await api.getMicGain(mode);
        if (mountedRef.current) {
          setMicGainState(result.result === 0 ? result : null);
        }
      } catch (err) {
        if (mountedRef.current) {
          setActionError(err instanceof Error ? err.message : String(err));
        }
      }
    },
    [api],
  );

  const connect = useCallback(
    async (descriptor?: { vendorId: number; productId: number }) => {
      if (!usbEnabled || !api) return;
      setPhase("connecting");
      setErrorMessage(null);
      setActionError(null);
      try {
        const config = await fetchRecordingCardConfig();
        const result: RecordingCardConnectResult = await api.connect(
          config.password,
          descriptor?.vendorId ?? config.vendorId,
          descriptor?.productId ?? config.productId,
        );
        if (!mountedRef.current) return;
        setDeviceName(
          `USB ${result.vendorId.toString(16)}:${result.productId.toString(16)}`,
        );
        setDeviceSn(result.deviceSn);
        setClockSynced(result.clockSynced);
        setStorage(result.storage);
        setPhase("connected");
        await Promise.all([refreshFiles(), refreshSettings()]);
      } catch (err) {
        if (!mountedRef.current) return;
        setPhase("error");
        setErrorMessage(err instanceof Error ? err.message : String(err));
      }
    },
    [usbEnabled, api, refreshFiles, refreshSettings],
  );

  /** Run one device action, surface failures, then let the caller refresh. */
  const runAction = useCallback(
    async (action: () => Promise<void>): Promise<boolean> => {
      if (!api) return false;
      setActionError(null);
      setSettingsLoading(true);
      try {
        await action();
        return true;
      } catch (err) {
        if (mountedRef.current) {
          setActionError(err instanceof Error ? err.message : String(err));
        }
        return false;
      } finally {
        if (mountedRef.current) setSettingsLoading(false);
      }
    },
    [api],
  );

  const deleteFile = useCallback(
    async (name: string) => {
      if (!api) return;
      setActionError(null);
      try {
        await api.deleteFile(name);
        await refreshFiles();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      }
    },
    [api, refreshFiles],
  );

  const deleteFiles = useCallback(
    async (names: string[]): Promise<boolean> => {
      if (!api || names.length === 0) return false;
      setActionError(null);
      setSettingsLoading(true);
      try {
        for (const name of names) {
          await api.deleteFile(name);
        }
        await refreshFiles();
        return true;
      } catch (err) {
        if (mountedRef.current) {
          setActionError(err instanceof Error ? err.message : String(err));
        }
        return false;
      } finally {
        if (mountedRef.current) setSettingsLoading(false);
      }
    },
    [api, refreshFiles],
  );

  const setAutoOff = useCallback(
    async (minutes: number): Promise<boolean> => {
      if (!api) return false;
      const ok = await runAction(() => api.setAutoOff(minutes));
      if (ok) await refreshSettings();
      return ok;
    },
    [api, refreshSettings, runAction],
  );

  const setMicGain = useCallback(
    async (mode: RecordingCardMicMode, mic1: number, mic2: number): Promise<boolean> => {
      if (!api) return false;
      const ok = await runAction(async () => {
        const result = await api.setMicGain(mode, mic1, mic2);
        if (result.result !== 0) {
          throw new Error(`device rejected microphone gain (code ${result.result})`);
        }
        if (mountedRef.current) setMicGainState(result);
      });
      return ok;
    },
    [api, runAction],
  );

  const setBound = useCallback(
    async (bound: boolean): Promise<boolean> =>
      runAction(async () => {
        await api?.setBound(bound);
      }),
    [api, runAction],
  );

  const unbind = useCallback(
    async (format = false): Promise<boolean> =>
      runAction(async () => {
        await api?.unbind(format);
      }),
    [api, runAction],
  );

  const factoryReset = useCallback(async (): Promise<boolean> => {
    const ok = await runAction(async () => {
      await api?.factoryReset();
    });
    if (ok) await Promise.all([refreshFiles(), refreshSettings()]);
    return ok;
  }, [api, refreshFiles, refreshSettings, runAction]);

  const formatStorage = useCallback(async (): Promise<boolean> => {
    const ok = await runAction(async () => {
      await api?.formatStorage();
    });
    if (ok) await refreshFiles();
    return ok;
  }, [api, refreshFiles, runAction]);

  const downloadFile = useCallback(
    async (file: RecordingCardFile) => {
      if (!api || download) return;
      setActionError(null);
      setDownload({ fileName: recordingCardDisplayName(file), loaded: 0, total: file.size });
      try {
        // Rust opens the native save dialog itself; no filesystem path is
        // passed from the webview. A null result means the user canceled.
        const saved = await api.download(file, {
          onmessage: (progress) => {
            if (mountedRef.current) setDownload(progress);
          },
        });
        void saved;
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        if (mountedRef.current) setDownload(null);
      }
    },
    [api, download],
  );

  return {
    usbEnabled,
    setAccess,
    phase,
    errorMessage,
    deviceName,
    deviceSn,
    clockSynced,
    files,
    storage,
    listError,
    autoOffMinutes,
    micGain,
    settingsLoading,
    download,
    actionError,
    supported: !!api,
    connect,
    refreshFiles: () => void refreshFiles(),
    refreshSettings: () => void refreshSettings(),
    refreshMicGain,
    deleteFile: (name: string) => void deleteFile(name),
    deleteFiles,
    setAutoOff,
    setMicGain,
    setBound,
    unbind,
    factoryReset,
    formatStorage,
    downloadFile: (file: RecordingCardFile) => void downloadFile(file),
    downloading: download !== null,
  };
}
