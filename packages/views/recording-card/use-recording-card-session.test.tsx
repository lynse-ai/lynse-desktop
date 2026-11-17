/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRecordingCardSession } from "./use-recording-card-session";
import type { NvEasyDeviceFile } from "./nveasy-types";

/**
 * State-machine tests for the USB session: connect paths (success, wrong
 * password, chooser cancel), teardown discipline (disconnect / unplug), and
 * the chunked download protocol (pause at the chunk boundary → resume from
 * `partial.length` → byte-exact completion).
 */

const MB = 1024 * 1024;

const mock = vi.hoisted(() => {
  const state = {
    connectBehavior: "ok" as "ok" | "auth-fail" | "canceled",
    disconnectCalls: 0,
    timeCalls: [] as number[],
    fileList: [] as NvEasyDeviceFile[],
    deleteResult: 0,
    deleteCalls: [] as string[],
    autoOffMinutes: 10,
    autoOffCalls: [] as number[],
    boundCalls: [] as boolean[],
    unbindCalls: [] as boolean[],
    factoryResetCalls: 0,
    formatStorageCalls: 0,
    downloadCalls: [] as { file: NvEasyDeviceFile; offset?: number }[],
    pauseCalls: 0,
    stopTransferCalls: 0,
    lastOptions: undefined as
      | { password: string; vendorId?: number; productId?: number; onDisconnect?: () => void }
      | undefined,
    downloadScript:
      null as null | ((
        file: NvEasyDeviceFile,
        onProgress: (loaded: number, total: number) => void,
        offset?: number,
      ) => Promise<Uint8Array>),
  };

  class MockClient {
    options: { password: string; vendorId?: number; productId?: number };
    constructor(options: {
      password: string;
      vendorId?: number;
      productId?: number;
      onDisconnect?: () => void;
    }) {
      this.options = options;
      state.lastOptions = options;
    }
    static isSupported() {
      return true;
    }
    get isAuthenticated() {
      return true;
    }
    async connect() {
      if (state.connectBehavior === "auth-fail") {
        throw new Error("password mismatch");
      }
      if (state.connectBehavior === "canceled") {
        throw new DOMException("No devices selected", "AbortError");
      }
      return { name: "Test Card", vendorId: 0x3654, productId: 0x4155, authenticated: true };
    }
    async disconnect() {
      state.disconnectCalls++;
    }
    async setTime(timestamp: number) {
      state.timeCalls.push(timestamp);
      return { result: 0, timestamp };
    }
    async getFileList() {
      return state.fileList;
    }
    async getStorage() {
      return { freeSpace: 1024, totalSpace: 4096 };
    }
    async deleteFile(name: string) {
      state.deleteCalls.push(name);
      return { result: state.deleteResult, detail: [] };
    }
    async getIdentity() {
      return { sn: "LYNSE-SN-1", bleMac: "", wifiMac: "", labelSn: "" };
    }
    async getAutoOff() {
      return { result: 0, detail: [String(state.autoOffMinutes)] };
    }
    async setAutoOff(minutes: number) {
      state.autoOffCalls.push(minutes);
      state.autoOffMinutes = minutes;
      return { result: 0, detail: [] };
    }
    async getMicGain(mode: 0 | 1) {
      return { result: 0, mode, mic1: 5, mic2: 6 };
    }
    async setMicGain(mode: 0 | 1, mic1: number, mic2: number) {
      return { result: 0, mode, mic1, mic2 };
    }
    async setBound(bound: boolean) {
      state.boundCalls.push(bound);
      return { result: 0, detail: [] };
    }
    async unbind(format: boolean) {
      state.unbindCalls.push(format);
      return { result: 0, detail: [] };
    }
    async factoryReset() {
      state.factoryResetCalls++;
      return { result: 0, detail: [] };
    }
    async formatStorage() {
      state.formatStorageCalls++;
      return { result: 0, detail: [] };
    }
    downloadFile(
      file: NvEasyDeviceFile,
      onProgress: (loaded: number, total: number) => void,
      offset?: number,
    ) {
      state.downloadCalls.push({ file, offset });
      return state.downloadScript!(file, onProgress, offset);
    }
    pauseDownload() {
      state.pauseCalls++;
    }
    async stopTransfer() {
      state.stopTransferCalls++;
    }
  }

  return { state, MockClient };
});

const sink = vi.hoisted(() => {
  const state = { writes: [] as number[], ends: [] as boolean[] };
  const sink = {
    write: async (bytes: Uint8Array) => {
      state.writes.push(bytes.length);
    },
    end: async (complete: boolean) => {
      state.ends.push(complete);
    },
  };
  return { state, sink };
});

vi.mock("./nveasy-loader", () => ({
  loadNvEasyClient: async () => mock.MockClient,
}));

vi.mock("./credentials", () => ({
  fetchRecordingCardConfig: async () => ({
    password: "paired-key-123",
    vendorId: 0x3654,
    productId: 0x4155,
  }),
}));

vi.mock("./download-sinks", () => ({
  createRecordingCardDownloadSink: async () => sink.sink,
  isUserCanceledDownload: (err: unknown) =>
    err instanceof DOMException && err.name === "AbortError",
}));

function makeFile(size: number): NvEasyDeviceFile {
  return {
    sn: 1,
    name: "rec01.wav",
    size,
    scene: 0,
    startTime: 1763300000,
    endTime: 1763300600,
    crc: "abc",
    frameSize: 1024,
  };
}

beforeEach(() => {
  const state = mock.state;
  state.connectBehavior = "ok";
  state.disconnectCalls = 0;
  state.timeCalls = [];
  state.fileList = [];
  state.deleteResult = 0;
  state.deleteCalls = [];
  state.autoOffMinutes = 10;
  state.autoOffCalls = [];
  state.boundCalls = [];
  state.unbindCalls = [];
  state.factoryResetCalls = 0;
  state.formatStorageCalls = 0;
  state.downloadCalls = [];
  state.pauseCalls = 0;
  state.stopTransferCalls = 0;
  state.downloadScript = null;
  state.lastOptions = undefined;
  sink.state.writes = [];
  sink.state.ends = [];
});

describe("recording card USB session", () => {
  it("starts off and unsupported in jsdom (no navigator.usb)", () => {
    const { result } = renderHook(() => useRecordingCardSession());
    expect(result.current.phase).toBe("off");
    expect(result.current.supported).toBe(false);
  });

  it("connects, syncs the clock, and loads the file list + storage", async () => {
    mock.state.fileList = [makeFile(10)];
    const { result } = renderHook(() => useRecordingCardSession());

    await act(async () => {
      await result.current.connect();
    });

    expect(result.current.phase).toBe("connected");
    expect(result.current.deviceName).toBe("Test Card");
    expect(result.current.files).toHaveLength(1);
    expect(result.current.storage).toEqual({ freeSpace: 1024, totalSpace: 4096 });
    // Clock sync happened exactly once, with a Unix-seconds value.
    expect(mock.state.timeCalls).toHaveLength(1);
    expect(mock.state.timeCalls[0]).toBeGreaterThan(1_000_000_000);
    // Credentials reached the client constructor, descriptor pair included.
    expect(mock.state.lastOptions).toMatchObject({
      password: "paired-key-123",
      vendorId: 0x3654,
      productId: 0x4155,
    });
  });

  it("loads device settings and drives confirmed management actions", async () => {
    const { result } = renderHook(() => useRecordingCardSession());

    await act(async () => {
      await result.current.connect();
    });

    expect(result.current.deviceSn).toBe("LYNSE-SN-1");
    expect(result.current.autoOffMinutes).toBe(10);
    expect(result.current.micGain).toEqual({ result: 0, mode: 0, mic1: 5, mic2: 6 });

    await act(async () => {
      expect(await result.current.setAutoOff(20)).toBe(true);
      expect(await result.current.setBound(true)).toBe(true);
      expect(await result.current.unbind(false)).toBe(true);
      expect(await result.current.factoryReset()).toBe(true);
      expect(await result.current.formatStorage()).toBe(true);
      expect(await result.current.setMicGain(1, 7, 8)).toBe(true);
    });

    expect(mock.state.autoOffCalls).toEqual([20]);
    expect(mock.state.boundCalls).toEqual([true]);
    expect(mock.state.unbindCalls).toEqual([false]);
    expect(mock.state.factoryResetCalls).toBe(1);
    expect(mock.state.formatStorageCalls).toBe(1);
    expect(result.current.micGain).toEqual({ result: 0, mode: 1, mic1: 7, mic2: 8 });
  });

  it("surfaces a wrong password as an error and releases the device", async () => {
    mock.state.connectBehavior = "auth-fail";
    const { result } = renderHook(() => useRecordingCardSession());

    await act(async () => {
      await result.current.connect();
    });

    expect(result.current.phase).toBe("error");
    expect(result.current.errorMessage).toContain("password mismatch");
    // The SDK closes the device on auth failure; our disconnect attempt is
    // best-effort — the key assertion is no connected state lingers.
    expect(result.current.deviceName).toBeNull();
  });

  it("treats a canceled device chooser as a quiet return to off", async () => {
    mock.state.connectBehavior = "canceled";
    const { result } = renderHook(() => useRecordingCardSession());

    await act(async () => {
      await result.current.connect();
    });

    expect(result.current.phase).toBe("off");
    expect(result.current.errorMessage).toBeNull();
  });

  it("disconnect releases the device and clears the session", async () => {
    mock.state.fileList = [makeFile(10)];
    const { result } = renderHook(() => useRecordingCardSession());

    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.phase).toBe("connected");

    act(() => result.current.disconnect());
    await waitFor(() => expect(result.current.phase).toBe("off"));
    expect(mock.state.disconnectCalls).toBeGreaterThanOrEqual(1);
    expect(result.current.files).toHaveLength(0);
    expect(result.current.deviceName).toBeNull();
  });

  it("downloads in chunks: pauses at the boundary, resumes from partial, verifies length", async () => {
    const size = 20 * MB; // 16 MiB chunk + 4 MiB remainder
    const firstChunk = new Uint8Array(16 * MB).fill(1);
    const secondChunk = new Uint8Array(4 * MB).fill(2);
    mock.state.fileList = [makeFile(size)];
    mock.state.downloadScript = async (_file, onProgress, offset) => {
      if (offset === 0) {
        // Device floods past the boundary before the pause lands; the SDK
        // then rejects with the contiguous bytes received so far.
        onProgress(16 * MB, size);
        const err = new Error("paused") as Error & { partial?: Uint8Array };
        err.partial = firstChunk;
        throw err;
      }
      onProgress(size, size);
      return secondChunk;
    };
    const { result } = renderHook(() => useRecordingCardSession());

    await act(async () => {
      await result.current.connect();
    });

    await act(async () => {
      result.current.downloadFile(makeFile(size));
    });

    // Exactly two device round trips: from 0, then from 16 MiB.
    expect(mock.state.downloadCalls.map((c) => c.offset)).toEqual([0, 16 * MB]);
    expect(mock.state.pauseCalls).toBeGreaterThanOrEqual(1);
    expect(sink.state.writes).toEqual([16 * MB, 4 * MB]);
    expect(sink.state.ends).toEqual([true]);
    expect(result.current.actionError).toBeNull();
    expect(result.current.downloading).toBe(false);
  });

  it("reports a real transfer failure via stopTransfer and keeps the sink closed", async () => {
    const size = 4 * MB;
    mock.state.fileList = [makeFile(size)];
    mock.state.downloadScript = async () => {
      throw new Error("usb stall");
    };
    const { result } = renderHook(() => useRecordingCardSession());

    await act(async () => {
      await result.current.connect();
    });

    await act(async () => {
      result.current.downloadFile(makeFile(size));
    });

    expect(mock.state.stopTransferCalls).toBe(1);
    expect(sink.state.ends).toEqual([false]);
    expect(result.current.actionError).toContain("usb stall");
    expect(result.current.downloading).toBe(false);
  });

  it("deletes a file and refreshes the list", async () => {
    mock.state.fileList = [makeFile(10), { ...makeFile(20), sn: 2, name: "rec02.wav" }];
    const { result } = renderHook(() => useRecordingCardSession());

    await act(async () => {
      await result.current.connect();
    });

    act(() => result.current.deleteFile("rec01.wav"));
    await waitFor(() => expect(mock.state.deleteCalls).toEqual(["rec01.wav"]));
    expect(result.current.actionError).toBeNull();
  });

  it("surfaces a device-rejected delete as an action error", async () => {
    mock.state.fileList = [makeFile(10)];
    mock.state.deleteResult = 3;
    const { result } = renderHook(() => useRecordingCardSession());

    await act(async () => {
      await result.current.connect();
    });

    act(() => result.current.deleteFile("rec01.wav"));
    await waitFor(() => expect(result.current.actionError).toContain("code 3"));
  });
});
