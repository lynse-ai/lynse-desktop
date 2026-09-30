import { afterEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

const toastMocks = vi.hoisted(() => ({
  info: vi.fn(),
}));

const tMock = vi.hoisted(() =>
  vi.fn((key: string, opts?: { points?: number }) => `${key}:${opts?.points ?? ""}`),
);

vi.mock("@lynse/core/api/client", () => ({
  api: () => ({ get: apiMocks.get, post: apiMocks.post }),
}));

vi.mock("sonner", () => ({
  toast: { info: toastMocks.info },
}));

vi.mock("i18next", () => ({ default: { t: tMock } }));

import { transcribeWithCreditsToast } from "./transcription-credits";

afterEach(() => {
  vi.clearAllMocks();
});

describe("transcribeWithCreditsToast", () => {
  it("toasts the requiredPoints receipt without a second balance fetch", async () => {
    apiMocks.get.mockResolvedValue({ pointsAmount: 1000, usedPointsAmount: 400 });
    apiMocks.post.mockResolvedValue({ taskId: "t1", requiredPoints: 25 });

    const result = await transcribeWithCreditsToast(() => apiMocks.post());

    expect(result).toEqual({ taskId: "t1", requiredPoints: 25 });
    expect(apiMocks.get).toHaveBeenCalledTimes(1);
    expect(toastMocks.info).toHaveBeenCalledWith("workspace.transcription_credits_consumed:25");
  });

  it("falls back to diffing the balance when the receipt is absent", async () => {
    apiMocks.get
      .mockResolvedValueOnce({ pointsAmount: 1000, usedPointsAmount: 400 }) // before: 600
      .mockResolvedValueOnce({ pointsAmount: 1000, usedPointsAmount: 430 }); // after: 570
    apiMocks.post.mockResolvedValue({ taskId: "t2" });

    await transcribeWithCreditsToast(() => apiMocks.post());

    expect(apiMocks.get).toHaveBeenCalledTimes(2);
    expect(toastMocks.info).toHaveBeenCalledWith("workspace.transcription_credits_consumed:30");
  });

  it("stays silent when the balance did not drop (e.g. minutes billing)", async () => {
    apiMocks.get.mockResolvedValue({ pointsAmount: 1000, usedPointsAmount: 400 });
    apiMocks.post.mockResolvedValue({ taskId: "t3" });

    await transcribeWithCreditsToast(() => apiMocks.post());

    expect(toastMocks.info).not.toHaveBeenCalled();
  });

  it("stays silent when the balance snapshot is unavailable", async () => {
    apiMocks.get.mockRejectedValue(new Error("network down"));
    apiMocks.post.mockResolvedValue({ taskId: "t4" });

    await transcribeWithCreditsToast(() => apiMocks.post());

    expect(toastMocks.info).not.toHaveBeenCalled();
  });

  it("propagates submission failures untouched", async () => {
    apiMocks.get.mockResolvedValue({ pointsAmount: 1000, usedPointsAmount: 400 });
    apiMocks.post.mockRejectedValue(new Error("insufficient credits"));

    await expect(transcribeWithCreditsToast(() => apiMocks.post())).rejects.toThrow(
      "insufficient credits",
    );
    expect(toastMocks.info).not.toHaveBeenCalled();
  });
});
