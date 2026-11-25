/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRecordingCardSessionDesktop } from "./use-recording-card-session-desktop";
import type { RecordingCardFile } from "./transport";

const mock = vi.hoisted(() => {
  const state = {
    listError: null as string | null,
    storageError: null as string | null,
    listCalls: 0,
    storageCalls: 0,
    disconnectCalls: 0,
    autoOffCalls: [] as number[],
    deletedNames: [] as string[],
  };
  const file: RecordingCardFile = {
    sn: 1,
    name: "rec01.wav",
    size: 123,
    scene: 0,
    startTime: 111,
    endTime: 222,
    crc: "0",
    frameSize: 80,
  };
  const api = {
    async connect() {
      return {
        vendorId: 0x3654,
        productId: 0x4155,
        deviceSn: "LYNSE2603LSN0100NV000558",
        storage: { freeSpace: 1024, totalSpace: 4096 },
        clockSynced: true,
      };
    },
    async disconnect() {
      state.disconnectCalls++;
    },
    async state() {
      return true;
    },
    async listFiles() {
      state.listCalls++;
      if (state.listError) throw new Error(state.listError);
      return [file];
    },
    async storage() {
      state.storageCalls++;
      if (state.storageError) throw new Error(state.storageError);
      return { freeSpace: 1024, totalSpace: 4096 };
    },
    async deleteFile(name: string) {
      state.deletedNames.push(name);
    },
    async getAutoOff() {
      return 10;
    },
    async setAutoOff(minutes: number) {
      state.autoOffCalls.push(minutes);
    },
    async getMicGain(mode: 0 | 1) {
      return { result: 0, mode, mic1: 5, mic2: 6 };
    },
    async setMicGain(mode: 0 | 1, mic1: number, mic2: number) {
      return { result: 0, mode, mic1, mic2 };
    },
    async setBound() {},
    async unbind() {},
    async factoryReset() {},
    async formatStorage() {},
    async download() {
      return null;
    },
    async cancelDownload() {},
  };
  return { state, api, file };
});

vi.mock("./credentials", () => ({
  fetchRecordingCardConfig: async () => ({
    password: "paired-key-123",
    vendorId: 0x3654,
    productId: 0x4155,
  }),
}));

vi.mock("@lynse/core/api", () => ({
  api: () => ({
    getToken: () => "valid-session",
    getBaseUrl: () => "https://api.lynse.cn",
  }),
}));

vi.mock("@lynse/core/i18n/react", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

type DesktopWindow = Window & {
  desktopAPI?: { recordingCardUsb?: typeof mock.api };
};

beforeEach(() => {
  mock.state.listError = null;
  mock.state.storageError = null;
  mock.state.listCalls = 0;
  mock.state.storageCalls = 0;
  mock.state.disconnectCalls = 0;
  mock.state.autoOffCalls = [];
  mock.state.deletedNames = [];
  (window as DesktopWindow).desktopAPI = { recordingCardUsb: mock.api };
});

afterEach(() => {
  delete (window as DesktopWindow).desktopAPI;
});

describe("desktop recording-card session refresh", () => {
  it("keeps a successful file list when the parallel storage call fails", async () => {
    mock.state.storageError = "USB error: endpoint already in use";
    const { result } = renderHook(() => useRecordingCardSessionDesktop());

    expect(result.current.supported).toBe(true);
    await act(async () => {
      result.current.refreshFiles();
    });
    await waitFor(() => expect(result.current.files).toEqual([mock.file]));

    expect(result.current.listError).toBe(false);
    expect(result.current.storage).toBeNull();
    expect(mock.state.listCalls).toBe(1);
    expect(mock.state.storageCalls).toBe(1);
  });

  it("marks listError only when the list itself fails", async () => {
    mock.state.listError = "no response for command getlist";
    const { result } = renderHook(() => useRecordingCardSessionDesktop());

    await act(async () => {
      result.current.refreshFiles();
    });
    await waitFor(() => expect(result.current.listError).toBe(true));

    expect(result.current.files).toEqual([]);
    expect(result.current.storage).toEqual({ freeSpace: 1024, totalSpace: 4096 });
  });

  it("uses the authsn serial reported by Rust on connect", async () => {
    const { result } = renderHook(() => useRecordingCardSessionDesktop());

    await act(async () => {
      await result.current.connect();
    });
    await waitFor(() => expect(result.current.phase).toBe("connected"));

    expect(result.current.deviceName).toBe("USB 3654:4155");
    expect(result.current.deviceSn).toBe("LYNSE2603LSN0100NV000558");
    expect(result.current.clockSynced).toBe(true);
    expect(result.current.autoOffMinutes).toBe(10);
    expect(result.current.micGain).toEqual({ result: 0, mode: 0, mic1: 5, mic2: 6 });
    expect(result.current.files).toEqual([mock.file]);
  });

  it("clears a prior file list when the native verifier revokes the session", async () => {
    const { result } = renderHook(() => useRecordingCardSessionDesktop());
    await act(async () => { await result.current.connect(); });
    expect(result.current.files).toEqual([mock.file]);

    mock.state.listError = "recording_card_not_owned";
    await act(async () => { result.current.refreshFiles(); });

    expect(result.current.phase).toBe("error");
    expect(result.current.errorMessage).toBe("recording_card_not_owned");
    expect(result.current.files).toEqual([]);
    expect(mock.state.disconnectCalls).toBe(1);
  });

  it("saves settings and deletes a batch through the desktop bridge", async () => {
    const { result } = renderHook(() => useRecordingCardSessionDesktop());

    await act(async () => {
      expect(await result.current.setAutoOff(30)).toBe(true);
      expect(
        await result.current.setMicGain(1, 7, 8),
      ).toBe(true);
      expect(await result.current.deleteFiles([mock.file.name])).toBe(true);
    });

    expect(mock.state.autoOffCalls).toEqual([30]);
    expect(mock.state.deletedNames).toEqual([mock.file.name]);
    expect(result.current.micGain).toEqual({ result: 0, mode: 1, mic1: 7, mic2: 8 });
  });
});
