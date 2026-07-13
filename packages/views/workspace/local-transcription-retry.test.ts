import { describe, expect, it, vi } from "vitest";
import { retryLocalTranscription } from "./local-transcription-retry";
import type { DesktopLocalTranscriptionApi } from "./local-transcription";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("retryLocalTranscription", () => {
  it("marks a local record as retrying before the retry finishes", async () => {
    const pending = deferred<Awaited<ReturnType<DesktopLocalTranscriptionApi["retry"]>>>();
    const api = { retry: vi.fn(() => pending.promise) } as unknown as DesktopLocalTranscriptionApi;
    const refresh = vi.fn();
    const setRetrying = vi.fn();
    const setError = vi.fn();

    const retryTask = retryLocalTranscription({
      fileId: "local:failed",
      api,
      refresh,
      setRetrying,
      setError,
    });

    expect(setError).toHaveBeenCalledWith(null);
    expect(setRetrying).toHaveBeenCalledWith("local:failed", true);
    expect(refresh).toHaveBeenCalledWith("local:failed");

    pending.resolve({} as Awaited<ReturnType<DesktopLocalTranscriptionApi["retry"]>>);
    await retryTask;

    expect(setRetrying).toHaveBeenLastCalledWith("local:failed", false);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("surfaces retry failures and clears retrying state", async () => {
    const api = {
      retry: vi.fn().mockRejectedValue(new Error("model missing")),
    } as unknown as DesktopLocalTranscriptionApi;
    const setError = vi.fn();
    const setRetrying = vi.fn();

    await retryLocalTranscription({
      fileId: "local:failed",
      api,
      refresh: vi.fn(),
      setRetrying,
      setError,
    });

    expect(setError).toHaveBeenCalledWith("model missing");
    expect(setRetrying).toHaveBeenLastCalledWith("local:failed", false);
  });
});
