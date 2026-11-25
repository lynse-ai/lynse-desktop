"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { toast } from "sonner";
import { recordingCardDisplayName } from "./file-name";
import { getRecordingCardAccess, ownershipErrorKey, requireRecordingCardAccess } from "./ownership";
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
 * Desktop session hook backed by the native Rust USB transport.
 * The pairing password is never exposed to the webview or JavaScript environment:
 * the native Rust process securely fetches it directly from the authentication gateway
 * via Certificate Pinning, authenticates the USB device, and zeros out the credential
 * from memory immediately. All USB I/O, downloads, and file writes happen in Rust;
 * this hook only drives state and progress.
 */
export function useRecordingCardSessionDesktop(): RecordingCardSessionView {
  const { t } = useTranslation();
  const api = getRecordingCardUsbApi();
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
  const generationRef = useRef(0);

  const teardown = useCallback(async () => {
    generationRef.current++;
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

  const handleOwnershipError = useCallback((error: unknown, generation: number) => {
    if (!mountedRef.current || generationRef.current !== generation) return true;
    const message = error instanceof Error ? error.message : String(error);
    if (!ownershipErrorKey(message)) return false;
    setPhase("error");
    setErrorMessage(message);
    void teardown();
    return true;
  }, [teardown]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      void teardown();
    };
  }, [teardown]);

  /** Release the device and return to the idle (off) state. */
  const disconnect = useCallback(() => {
    setErrorMessage(null);
    setPhase("off");
    void teardown();
  }, [teardown]);

  const refreshFiles = useCallback(async () => {
    if (!api) return;
    const generation = generationRef.current;
    setListError(false);
    const [listResult, storageResult] = await Promise.allSettled([
      api.listFiles(),
      api.storage(),
    ]);
    if (!mountedRef.current || generationRef.current !== generation) return;
    if (listResult.status === "fulfilled") {
      setFiles(listResult.value);
    } else {
      if (handleOwnershipError(listResult.reason, generation)) return;
      setListError(true);
    }
    if (storageResult.status === "fulfilled") {
      setStorage(storageResult.value);
    }
  }, [api, handleOwnershipError]);

  const refreshSettings = useCallback(async () => {
    if (!api) return;
    const generation = generationRef.current;
    setSettingsLoading(true);
    const [autoOffResult, micGainResult] = await Promise.allSettled([
      api.getAutoOff(),
      api.getMicGain(0),
    ]);
    if (!mountedRef.current || generationRef.current !== generation) return;
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
      const generation = generationRef.current;
      try {
        const result = await api.getMicGain(mode);
        if (mountedRef.current && generationRef.current === generation) {
          setMicGainState(result.result === 0 ? result : null);
        }
      } catch (err) {
        if (mountedRef.current && generationRef.current === generation) {
          setActionError(err instanceof Error ? err.message : String(err));
        }
      }
    },
    [api],
  );

  const connect = useCallback(
    async () => {
      if (!api) return;
      const generation = ++generationRef.current;
      setPhase("connecting");
      setErrorMessage(null);
      setActionError(null);
      try {
        const access = getRecordingCardAccess();
        requireRecordingCardAccess(access);
        if (!mountedRef.current || generationRef.current !== generation) return;
        const result: RecordingCardConnectResult = await api.connect();
        if (!mountedRef.current || generationRef.current !== generation) return;
        requireRecordingCardAccess(access);
        setDeviceName(
          `USB ${result.vendorId.toString(16)}:${result.productId.toString(16)}`,
        );
        setDeviceSn(result.deviceSn);
        setClockSynced(result.clockSynced);
        setStorage(result.storage);
        setPhase("connected");
        await Promise.all([refreshFiles(), refreshSettings()]);
      } catch (err) {
        if (!mountedRef.current || generationRef.current !== generation) return;
        setPhase("error");
        setErrorMessage(err instanceof Error ? err.message : String(err));
        void teardown();
      }
    },
    [api, refreshFiles, refreshSettings, teardown],
  );

  /** Run one device action, surface failures, then let the caller refresh. */
  const runAction = useCallback(
    async (action: () => Promise<void>): Promise<boolean> => {
      if (!api) return false;
      const generation = generationRef.current;
      setActionError(null);
      setSettingsLoading(true);
      try {
        await action();
        return mountedRef.current && generationRef.current === generation;
      } catch (err) {
        if (!handleOwnershipError(err, generation)) {
          setActionError(err instanceof Error ? err.message : String(err));
        }
        return false;
      } finally {
        if (mountedRef.current && generationRef.current === generation) setSettingsLoading(false);
      }
    },
    [api, handleOwnershipError],
  );

  const deleteFile = useCallback(
    async (name: string) => {
      if (!api) return;
      if (await runAction(() => api.deleteFile(name))) await refreshFiles();
    },
    [api, refreshFiles, runAction],
  );

  const deleteFiles = useCallback(
    async (names: string[]): Promise<boolean> => {
      if (!api || names.length === 0) return false;
      const generation = generationRef.current;
      const ok = await runAction(async () => {
        for (const name of names) {
          if (generationRef.current !== generation) return;
          await api.deleteFile(name);
        }
      });
      if (ok) await refreshFiles();
      return ok;
    },
    [api, refreshFiles, runAction],
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

  const cancelDownload = useCallback(async () => {
    if (!api) return;
    try {
      await api.cancelDownload();
    } catch {
      // best-effort
    }
  }, [api]);

  const downloadFile = useCallback(
    async (file: RecordingCardFile): Promise<string | null> => {
      if (!api || download) return null;
      const generation = generationRef.current;
      setActionError(null);
      setDownload({ fileName: recordingCardDisplayName(file), loaded: 0, total: file.size });
      try {
        // Rust opens the native save dialog itself; no filesystem path is
        // passed from the webview. A null result means the user canceled.
        const saved = await api.download(file, {
          onmessage: (progress) => {
            if (mountedRef.current && generationRef.current === generation) setDownload(progress);
          },
        });
        if (saved) {
          toast.success(t("recordingCard.download_success"));
        }
        return saved;
      } catch (err) {
        if (!handleOwnershipError(err, generation)) {
          setActionError(err instanceof Error ? err.message : String(err));
        }
        return null;
      } finally {
        if (mountedRef.current && generationRef.current === generation) setDownload(null);
      }
    },
    [api, download, handleOwnershipError, t],
  );

  return {
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
    disconnect,
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
    downloadFile,
    cancelDownload,
    downloading: download !== null,
  };
}
