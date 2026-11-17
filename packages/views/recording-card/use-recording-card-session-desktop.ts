"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchRecordingCardConfig } from "./credentials";
import {
  getRecordingCardUsbApi,
  type RecordingCardConnectResult,
  type RecordingCardDownloadProgress,
  type RecordingCardFile,
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
  const [files, setFiles] = useState<RecordingCardFile[]>([]);
  const [storage, setStorage] = useState<RecordingCardStorage | null>(null);
  const [listError, setListError] = useState(false);
  const [download, setDownload] = useState<RecordingCardDownloadProgress | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const teardown = useCallback(async () => {
    if (mountedRef.current) {
      setDeviceName(null);
      setFiles([]);
      setStorage(null);
      setDownload(null);
      setListError(false);
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
        setDeviceName(`USB ${result.vendorId.toString(16)}:${result.productId.toString(16)}`);
        setStorage(result.storage);
        setPhase("connected");
        await refreshFiles();
      } catch (err) {
        if (!mountedRef.current) return;
        setPhase("error");
        setErrorMessage(err instanceof Error ? err.message : String(err));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [usbEnabled, api],
  );

  const refreshFiles = useCallback(async () => {
    if (!api) return;
    setListError(false);
    try {
      const [list, storageInfo] = await Promise.all([api.listFiles(), api.storage()]);
      if (mountedRef.current) {
        setFiles(list);
        setStorage(storageInfo);
      }
    } catch {
      if (mountedRef.current) setListError(true);
    }
  }, [api]);

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

  const downloadFile = useCallback(
    async (file: RecordingCardFile) => {
      if (!api || download) return;
      setActionError(null);
      setDownload({ fileName: file.name, loaded: 0, total: file.size });
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
    files,
    storage,
    listError,
    download,
    actionError,
    supported: !!api,
    connect,
    refreshFiles: () => void refreshFiles(),
    deleteFile: (name: string) => void deleteFile(name),
    downloadFile: (file: RecordingCardFile) => void downloadFile(file),
    downloading: download !== null,
  };
}
