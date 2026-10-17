/* @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UploadDialog } from "./upload-dialog";

const mocks = vi.hoisted(() => ({
  local: { pickAudioFile: vi.fn(), getSttConfig: vi.fn(), listSttModels: vi.fn(),
    listHotwordPackages: vi.fn(), start: vi.fn() },
  success: vi.fn(), error: vi.fn(), transfer: vi.fn(),
}));
vi.mock("@lynse/core/i18n/react", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }) }));
vi.mock("@lynse/core/auth", () => ({ useAuthStore: (select: (state: { isAuthenticated: boolean }) => unknown) => select({ isAuthenticated: true }) }));
vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock("../layout/use-user-credits", () => ({
  useMembership: () => ({ data: { memberLevel: "free" }, isPending: false }),
  useUserCredits: () => ({ data: {}, isPending: false }),
  isInsufficientCreditsError: () => false,
}));
vi.mock("./hooks/use-files", () => ({
  useTransferFile: () => ({ mutateAsync: mocks.transfer }), uploadFileToOSS: vi.fn(),
  waitForTranscriptionCompletion: vi.fn(),
}));
vi.mock("./local-transcription", async (importOriginal) => ({
  ...await importOriginal<typeof import("./local-transcription")>(),
  getDesktopLocalTranscriptionApi: () => mocks.local,
  OFFLINE_TRANSCRIPTION_ENABLED_KEY: "lynse_offline_transcription_enabled",
  resolveSttProvider: () => ({ provider: "whisper", model: "installed" }),
  findModelStatus: () => ({ status: "installed" }),
}));
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear();
  mocks.local.pickAudioFile.mockResolvedValue("/tmp/meeting.wav");
  mocks.local.getSttConfig.mockResolvedValue({ default: null, per_language: {} });
  mocks.local.listSttModels.mockResolvedValue({ models: [] });
  mocks.local.listHotwordPackages.mockResolvedValue([]);
});
afterEach(cleanup);
function showDialog(onOpenChange = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><UploadDialog open onOpenChange={onOpenChange} /></QueryClientProvider>);
  return onOpenChange;
}
async function chooseLocalFile() {
  fireEvent.click(screen.getByText("upload.local_pick_hint"));
  await screen.findByText("meeting.wav");
}
describe("local import queueing", () => {
  it("blocks rapid duplicate submissions and closes as soon as the queued record returns", async () => {
    let finish!: (record: { id: string; title: string }) => void;
    mocks.local.start.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const onOpenChange = showDialog();
    await chooseLocalFile();
    const configReadsBeforeSubmit = mocks.local.getSttConfig.mock.calls.length;
    const start = screen.getByRole("button", { name: "upload.local_start" });
    act(() => { fireEvent.click(start); fireEvent.click(start); });
    await waitFor(() => expect(mocks.local.start).toHaveBeenCalledTimes(1));
    expect(mocks.local.getSttConfig).toHaveBeenCalledTimes(configReadsBeforeSubmit + 1);
    expect((start as HTMLButtonElement).disabled).toBe(true);
    expect(onOpenChange).not.toHaveBeenCalled();
    await act(async () => finish({ id: "local:queued", title: "meeting.wav" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mocks.success).toHaveBeenCalledWith("upload.local_queued");
    expect(mocks.transfer).not.toHaveBeenCalled();
  });
  it("unlocks a failed enqueue so the user can retry once", async () => {
    mocks.local.start.mockRejectedValueOnce(new Error("queue unavailable"))
      .mockResolvedValueOnce({ id: "local:retry", title: "meeting.wav" });
    const onOpenChange = showDialog();
    await chooseLocalFile();
    fireEvent.click(screen.getByRole("button", { name: "upload.local_start" }));
    await screen.findByText("queue unavailable");
    const retry = screen.getByRole("button", { name: "upload.local_start" });
    await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(retry);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(mocks.local.start).toHaveBeenCalledTimes(2);
  });
});
