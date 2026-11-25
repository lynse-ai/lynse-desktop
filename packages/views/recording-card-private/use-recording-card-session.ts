"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createRecordingCardDownloadSink,
  isUserCanceledDownload,
} from "./download-sinks";
import { fetchRecordingCardConfig } from "./credentials";
import { recordingCardDisplayName } from "./file-name";
import { loadNvEasyClient } from "./nveasy-loader";
import {
  isWebUsbAvailable,
  type NvEasyActionResult,
  type NvEasyClientLike,
  type NvEasyDeviceFile,
  type NvEasyDeviceIdentity,
  type NvEasyErrorShape,
  type NvEasyMicGain,
  type NvEasyMicMode,
  type NvEasyStorageInfo,
} from "./nveasy-types";
import { getRecordingCardAccess, requireRecordingCardAccess, verifyBrowserOwnership } from "./ownership";

/**
 * Session state machine for the recording-card management page.
 *
 * USB access is off by default. Turning it on only arms the page; the actual
 * connect pops the browser device chooser and runs the firmware password
 * handshake. Tearing down (switch off, unmount, unplug, logout — AuthGate
 * swaps the children out which unmounts this hook's owner) always releases
 * the USB interface. Downloads are strictly serial; deleting is blocked
 * while one is in flight.
 */

export type RecordingCardPhase = "off" | "connecting" | "connected" | "error";

export interface RecordingCardDownloadProgress {
  fileName: string;
  loaded: number;
  total: number;
}

type OwnedConnection = {
  phase: "owned";
  controller: AbortController;
  client: NvEasyClientLike;
  access: ReturnType<typeof getRecordingCardAccess>;
  identity: NvEasyDeviceIdentity;
};

type OpeningConnection = {
  phase: "opening";
  controller: AbortController;
  client: NvEasyClientLike | null;
};

/** Chunk target per downloadFile() round trip. Only decides when pause is
 * requested; the SDK may hand back a little more (bytes already in flight),
 * which is still contiguous valid data. */
const CHUNK_SIZE = 16 * 1024 * 1024;

// Kill switch for the pause/partial chunked protocol: flip to false if real
// hardware shows unstable pause semantics, and downloads fall back to one
// whole-file downloadFile() call (memory cost, but the protocol is plain).
const USE_CHUNKED_DOWNLOAD = true;

function isNvEasyErrorWithPartial(err: unknown): err is NvEasyErrorShape {
  return (
    err instanceof Error &&
    (err as NvEasyErrorShape).partial !== undefined &&
    (err as NvEasyErrorShape).partial instanceof Uint8Array
  );
}

/** The Chrome device chooser rejects with AbortError when the user cancels. */
function isChooserCanceled(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function isActionOk(result: NvEasyActionResult | null | undefined): boolean {
  return result?.result === 0;
}

function parseAutoOffMinutes(result: NvEasyActionResult): number | null {
  if (!isActionOk(result)) return null;
  const minutes = Number(result.detail?.[0]);
  return Number.isInteger(minutes) && minutes > 0 ? minutes : null;
}

export function useRecordingCardSession() {
  const [phase, setPhase] = useState<RecordingCardPhase>("off");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [deviceSn, setDeviceSn] = useState<string | null>(null);
  const [clockSynced, setClockSynced] = useState<boolean | null>(null);
  const [files, setFiles] = useState<NvEasyDeviceFile[]>([]);
  const [storage, setStorage] = useState<NvEasyStorageInfo | null>(null);
  const [listError, setListError] = useState(false);
  const [autoOffMinutes, setAutoOffMinutes] = useState<number | null>(null);
  const [micGain, setMicGainState] = useState<NvEasyMicGain | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [download, setDownload] = useState<RecordingCardDownloadProgress | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const connectionRef = useRef<OpeningConnection | OwnedConnection | null>(null);
  const transferringRef = useRef<OwnedConnection | null>(null);
  const mountedRef = useRef(true);

  const ownedConnection = useCallback(() => {
    const connection = connectionRef.current;
    return connection?.phase === "owned" ? connection : null;
  }, []);

  /** Drop every piece of session state and close the device if open. */
  const teardown = useCallback(async () => {
    const connection = connectionRef.current;
    connectionRef.current = null;
    connection?.controller.abort();
    if (mountedRef.current) {
      setDeviceName(null);
      setDeviceSn(null);
      setClockSynced(null);
      setFiles([]);
      setStorage(null);
      setListError(false);
      setAutoOffMinutes(null);
      setMicGainState(null);
      setSettingsLoading(false);
      setDownload(null);
      setActionError(null);
    }
    transferringRef.current = null;
    if (connection?.client) {
      try {
        await connection.client.disconnect();
      } catch {
        // Device already gone or link dead — nothing left to release.
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      void teardown();
    };
  }, [teardown]);

  const verifyActive = useCallback(async (connection: OwnedConnection) => {
    try {
      await verifyBrowserOwnership(connection.access, connection.identity, connection.controller.signal);
      return connectionRef.current === connection;
    } catch (err) {
      if (connectionRef.current === connection) {
        setPhase("error");
        setErrorMessage(err instanceof Error ? err.message : String(err));
        await teardown();
      }
      return false;
    }
  }, [teardown]);

  const refreshFiles = useCallback(async () => {
    const connection = ownedConnection();
    if (!connection || !await verifyActive(connection)) return;
    const { client } = connection;
    setListError(false);
    try {
      // getStorage waits for the device's real capacity report; both calls
      // are independent, so run them together.
      const [list, storageInfo] = await Promise.all([
        client.getFileList(),
        client.getStorage(),
      ]);
      if (connectionRef.current !== connection) return;
      requireRecordingCardAccess(connection.access);
      setFiles(list);
      setStorage(storageInfo);
    } catch {
      if (connectionRef.current === connection) setListError(true);
    }
  }, [ownedConnection, verifyActive]);

  const refreshSettings = useCallback(async () => {
    const connection = ownedConnection();
    if (!connection) return;
    const { client } = connection;
    setSettingsLoading(true);
    if (typeof client.getAutoOff !== "function") {
      setSettingsLoading(false);
      return;
    }
    const [autoOffResult, micGainResult] = await Promise.allSettled([
      client.getAutoOff(),
      typeof client.getMicGain === "function" ? client.getMicGain(0) : Promise.reject(new Error("unsupported")),
    ]);
    if (connectionRef.current !== connection) return;
    setAutoOffMinutes(
      autoOffResult.status === "fulfilled" ? parseAutoOffMinutes(autoOffResult.value) : null,
    );
    setMicGainState(
      micGainResult.status === "fulfilled" && micGainResult.value.result === 0
        ? micGainResult.value
        : null,
    );
    setSettingsLoading(false);
  }, [ownedConnection]);

  const refreshMicGain = useCallback(async (mode: NvEasyMicMode) => {
    const connection = ownedConnection();
    if (!connection || typeof connection.client.getMicGain !== "function") return;
    try {
      const result = await connection.client.getMicGain(mode);
      if (connectionRef.current === connection && result.result === 0) setMicGainState(result);
    } catch (err) {
      if (connectionRef.current === connection) {
        setActionError(err instanceof Error ? err.message : String(err));
      }
    }
  }, [ownedConnection]);

  const connect = useCallback(async () => {
    if (connectionRef.current) return;
    const controller = new AbortController();
    const attempt: OpeningConnection = { phase: "opening", controller, client: null };
    connectionRef.current = attempt;
    setPhase("connecting");
    setErrorMessage(null);
    setActionError(null);
    try {
      const access = getRecordingCardAccess();
      const [ctor, config] = await Promise.all([
        loadNvEasyClient(),
        fetchRecordingCardConfig(),
      ]);
      controller.signal.throwIfAborted();
      requireRecordingCardAccess(access);
      // Descriptor precedence: server config (per-model pair) → omit both and
      // let the SDK apply its built-in reference-hardware filter.
      const vendorId = config.vendorId;
      const productId = config.productId;
      const client = new ctor({
        password: config.password,
        ...(vendorId !== undefined && productId !== undefined
          ? { vendorId, productId }
          : {}),
        onDisconnect: () => {
          if (connectionRef.current?.controller !== controller) return;
          setPhase("off");
          void teardown();
        },
      });
      attempt.client = client;
      // connect() pops the chooser when no device was pre-picked, opens the
      // device and runs the password handshake; auth failure throws.
      const info = await client.connect();
      if (!info.authenticated) {
        throw new Error("device did not pass the firmware handshake");
      }
      controller.signal.throwIfAborted();
      const identity = await client.getIdentity?.().catch(() => null);
      if (!identity) throw new Error("recording_card_identity_unavailable");
      await verifyBrowserOwnership(access, identity, controller.signal);
      // Best-effort clock sync so listed startTimes are wall-clock times.
      let clockSynced = false;
      try {
        const clock = await client.setTime(Math.floor(Date.now() / 1000));
        clockSynced = clock.result === 0;
      } catch { /* The clock can be synced on reconnect. */ }
      controller.signal.throwIfAborted();
      requireRecordingCardAccess(access);
      connectionRef.current = { phase: "owned", controller, client, access, identity };
      setDeviceName(info.name || null);
      setDeviceSn(identity.sn);
      setClockSynced(clockSynced);
      setPhase("connected");
      await Promise.all([refreshFiles(), refreshSettings()]);
    } catch (err) {
      if (connectionRef.current?.controller !== controller) {
        // A chooser or handshake can finish after teardown.
        await attempt.client?.disconnect().catch(() => undefined);
        return;
      }
      const canceled = isChooserCanceled(err);
      setPhase(canceled ? "off" : "error");
      if (!canceled) setErrorMessage(err instanceof Error ? err.message : String(err));
      await teardown();
    }
  }, [refreshFiles, refreshSettings, teardown]);

  /** Release the device and return to the idle (off) state. */
  const disconnect = useCallback(() => {
    setErrorMessage(null);
    setPhase("off");
    void teardown();
  }, [teardown]);

  /** Run one device action, surface failures, then let the caller refresh. */
  const runAction = useCallback(
    async (action: (client: NvEasyClientLike) => Promise<void>): Promise<boolean> => {
      const connection = ownedConnection();
      if (!connection || transferringRef.current || !await verifyActive(connection)) return false;
      setActionError(null);
      setSettingsLoading(true);
      try {
        await action(connection.client);
        return connectionRef.current === connection;
      } catch (err) {
        if (connectionRef.current === connection) {
          setActionError(err instanceof Error ? err.message : String(err));
        }
        return false;
      } finally {
        if (connectionRef.current === connection) setSettingsLoading(false);
      }
    },
    [ownedConnection, verifyActive],
  );

  const deleteFile = useCallback(
    async (name: string) => {
      const ok = await runAction(async (client) => {
        const result = await client.deleteFile(name);
        if (result.result !== 0) {
          throw new Error(`device rejected the delete (code ${result.result})`);
        }
      });
      if (ok) await refreshFiles();
    },
    [refreshFiles, runAction],
  );

  const deleteFiles = useCallback(
    async (names: string[]): Promise<boolean> => {
      if (names.length === 0) return false;
      const ok = await runAction(async (active) => {
        for (const name of names) {
          const result = await active.deleteFile(name);
          if (result.result !== 0) {
            throw new Error(`device rejected deleting ${name} (code ${result.result})`);
          }
        }
      });
      if (ok) await refreshFiles();
      return ok;
    },
    [refreshFiles, runAction],
  );

  const setAutoOff = useCallback(
    async (minutes: number): Promise<boolean> => {
      const ok = await runAction(async (client) => {
        if (typeof client.setAutoOff !== "function") {
          throw new Error("this SDK build does not support auto-off settings");
        }
        const result = await client.setAutoOff(minutes);
        if (!isActionOk(result)) {
          throw new Error(`device rejected auto-off (code ${result.result})`);
        }
      });
      if (ok) await refreshSettings();
      return ok;
    },
    [refreshSettings, runAction],
  );

  const setMicGain = useCallback(
    async (mode: NvEasyMicMode, mic1: number, mic2: number): Promise<boolean> =>
      runAction(async (client) => {
        if (typeof client.setMicGain !== "function") {
          throw new Error("this SDK build does not support microphone gain");
        }
        const result = await client.setMicGain(mode, mic1, mic2);
        if (result.result !== 0) {
          throw new Error(`device rejected microphone gain (code ${result.result})`);
        }
        if (mountedRef.current) setMicGainState(result);
      }),
    [runAction],
  );

  const setBound = useCallback(
    async (bound: boolean): Promise<boolean> =>
      runAction(async (client) => {
        if (typeof client.setBound !== "function") {
          throw new Error("this SDK build does not support device binding");
        }
        const result = await client.setBound(bound);
        if (!isActionOk(result)) {
          throw new Error(`device rejected binding (code ${result.result})`);
        }
      }),
    [runAction],
  );

  const unbind = useCallback(
    async (format = false): Promise<boolean> =>
      runAction(async (client) => {
        if (typeof client.unbind !== "function") {
          throw new Error("this SDK build does not support device unbinding");
        }
        const result = await client.unbind(format);
        if (!isActionOk(result)) {
          throw new Error(`device rejected unbinding (code ${result.result})`);
        }
      }),
    [runAction],
  );

  const factoryReset = useCallback(async (): Promise<boolean> => {
    const ok = await runAction(async (active) => {
      if (typeof active.factoryReset !== "function") {
        throw new Error("this SDK build does not support factory reset");
      }
      const result = await active.factoryReset();
      if (!isActionOk(result)) {
        throw new Error(`device rejected factory reset (code ${result.result})`);
      }
    });
    if (ok) await Promise.all([refreshFiles(), refreshSettings()]);
    return ok;
  }, [refreshFiles, refreshSettings, runAction]);

  const formatStorage = useCallback(async (): Promise<boolean> => {
    const ok = await runAction(async (active) => {
      if (typeof active.formatStorage !== "function") {
        throw new Error("this SDK build does not support formatting");
      }
      const result = await active.formatStorage();
      if (!isActionOk(result)) {
        throw new Error(`device rejected formatting (code ${result.result})`);
      }
    });
    if (ok) await refreshFiles();
    return ok;
  }, [refreshFiles, runAction]);

  const downloadFile = useCallback(
    async (file: NvEasyDeviceFile) => {
      const connection = ownedConnection();
      if (!connection || transferringRef.current) return;
      const { client, controller, access } = connection;
      transferringRef.current = connection;
      setActionError(null);
      setDownload({ fileName: recordingCardDisplayName(file), loaded: 0, total: file.size });
      let sink: Awaited<ReturnType<typeof createRecordingCardDownloadSink>> | null = null;
      try {
        // Pop the save picker up front, while the click's transient
        // activation is still valid.
        sink = await createRecordingCardDownloadSink(file, () => verifyActive(connection));
        if (!sink) return;
        let written = 0;
        if (USE_CHUNKED_DOWNLOAD) {
          while (written < file.size) {
            controller.signal.throwIfAborted();
            requireRecordingCardAccess(access);
            const chunkEnd = Math.min(written + CHUNK_SIZE, file.size);
            let bytes: Uint8Array;
            try {
              bytes = await client.downloadFile(
                file,
                (loaded) => {
                  if (connectionRef.current === connection) {
                    setDownload({
                      fileName: recordingCardDisplayName(file),
                      loaded: Math.min(loaded, file.size),
                      total: file.size,
                    });
                  }
                  // Ask the SDK to stop at the next protocol wait once this
                  // chunk is in; the call then rejects with `partial`.
                  if (loaded >= chunkEnd) client.pauseDownload();
                },
                written,
              );
            } catch (err) {
              if (isNvEasyErrorWithPartial(err) && err.partial && err.partial.length > 0) {
                bytes = err.partial;
              } else {
                // Real transfer failure: tell the device to stop sending and
                // drop buffered packets, then surface the error.
                await client.stopTransfer().catch(() => undefined);
                throw err;
              }
            }
            if (written + bytes.length > file.size) {
              throw new Error("device sent more data than the file size");
            }
            controller.signal.throwIfAborted();
            requireRecordingCardAccess(access);
            await sink.write(bytes);
            written += bytes.length;
            if (connectionRef.current === connection) {
              setDownload({ fileName: recordingCardDisplayName(file), loaded: written, total: file.size });
            }
          }
        } else {
          // Whole-file fallback: one call, no pause, full buffer in memory.
          const bytes = await client.downloadFile(file, (loaded) => {
            if (connectionRef.current === connection) {
              setDownload({ fileName: recordingCardDisplayName(file), loaded, total: file.size });
            }
          }, 0);
          if (bytes.length !== file.size) {
            throw new Error("download ended before the full file arrived");
          }
          controller.signal.throwIfAborted();
          requireRecordingCardAccess(access);
          await sink.write(bytes);
          written = bytes.length;
        }
        // Length check is the completion contract: only a byte-exact file
        // counts as downloaded.
        const complete = written === file.size;
        await sink.end(complete);
        if (!complete) {
          throw new Error("download ended before the full file arrived");
        }
      } catch (err) {
        // Flush and close the sink even on failure so the file handle is
        // never left open (the sink ignores a duplicate close).
        if (sink) await sink.end(false).catch(() => undefined);
        if (connectionRef.current === connection && !isUserCanceledDownload(err)) {
          setActionError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (transferringRef.current === connection) transferringRef.current = null;
        if (connectionRef.current === connection) setDownload(null);
      }
    },
    [ownedConnection, verifyActive],
  );

  const cancelDownload = useCallback(async () => {
    if (transferringRef.current) {
      try {
        await transferringRef.current.client.stopTransfer();
      } catch {
        // best-effort
      }
    }
  }, []);

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
    supported: isWebUsbAvailable(),
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
    downloadFile: (file: NvEasyDeviceFile) => downloadFile(file),
    cancelDownload,
    downloading: download !== null,
  };
}
