/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeReportProblemDialog, openReportProblem, setReportChannel, takePendingScreenshot,
  type DesktopDiagnosticsApi,
} from "./diagnostics";
import { ReportProblemDialog } from "./report-problem-dialog";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(), submit: vi.fn(), toastError: vi.fn(), t: (key: string) => key,
}));
vi.mock("@lynse/core/i18n/react", () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock("@lynse/core/i18n", () => ({ initI18n: vi.fn() }));
vi.mock("i18next", () => ({ default: { isInitialized: true, t: mocks.t } }));
vi.mock("./locales", () => ({ RESOURCES: {} }));
vi.mock("./layout/use-maximized", () => ({ isTauri: false, isMacDesktop: false }));
vi.mock("./app-update", () => ({
  getAppInfoSync: () => ({ version: "test", platform: "win32" }), openExternalUrl: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));

const screenshot = {
  path: "C:\\Lynse\\inspirations\\staging\\report-example.jpg",
  url: "http://local-media.localhost/staging%3Areport-example.jpg",
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.capture.mockResolvedValue(screenshot);
  mocks.submit.mockResolvedValue({ number: 42 });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const api: DesktopDiagnosticsApi = {
    captureScreenshot: mocks.capture,
    submitCnbIssue: mocks.submit,
    readLogs: async () => ({ dir: "logs", tail: "", truncated: false, files: 0 }),
    prepareReport: async () => ({ dir: "report" }),
    revealReportFolder: async () => {},
  };
  Object.assign(window, { desktopAPI: { app: api } });
  setReportChannel({ endpoint: "https://dl.lynse.cn/cnb-report" });
});

afterEach(() => {
  cleanup();
  closeReportProblemDialog();
  takePendingScreenshot();
  setReportChannel(null);
  Reflect.deleteProperty(window, "desktopAPI");
  vi.restoreAllMocks();
});

function openDialog() {
  render(<ReportProblemDialog />);
  act(() => openReportProblem());
}

describe("problem report screenshot recovery", () => {
  it("prefills organization diagnostics for review without submitting automatically", async () => {
    render(<ReportProblemDialog />);
    const description = "Knowledge organization failed: Launch\nquote_not_found\n2026-10-31T01:46:35Z";
    act(() => openReportProblem(description));
    await waitFor(() => expect((screen.getByLabelText("settings.report_problem_label") as HTMLTextAreaElement).value).toBe(description));
    expect(mocks.submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "settings.report_submit" }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining(description) })));
  });

  it("replaces a broken preview with a retry hint while retaining the JPEG for submission", async () => {
    openDialog();
    const image = await screen.findByRole("img", { name: "settings.report_screenshot_label" });
    expect(image.getAttribute("src")).toBe(screenshot.url);

    fireEvent.error(image);

    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("settings.report_preview_failed")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("settings.report_problem_label"), { target: { value: "Broken preview" } });
    fireEvent.click(screen.getByRole("button", { name: "settings.report_submit" }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledWith(expect.objectContaining({
      screenshotPath: screenshot.path,
    })));
  });

  it("surfaces an initial capture failure and recovers after retaking", async () => {
    mocks.capture.mockRejectedValueOnce(new Error("PrintWindow failed for the main window"));
    openDialog();

    await screen.findByText("settings.report_capture_missing");
    expect(mocks.toastError).toHaveBeenCalledWith("settings.report_capture_failed");
    expect(console.warn).toHaveBeenCalledWith("[report-screenshot] capture failed:", expect.any(Error));
    fireEvent.click(screen.getByRole("button", { name: "settings.report_retake" }));

    const image = await screen.findByRole("img", { name: "settings.report_screenshot_label" });
    expect(image.getAttribute("src")).toBe(screenshot.url);
    expect(mocks.capture).toHaveBeenCalledTimes(2);
  });

  it("clears a failed preview when a new screenshot is captured", async () => {
    openDialog();
    fireEvent.error(await screen.findByRole("img"));
    const nextScreenshot = { ...screenshot, url: screenshot.url.replace("example", "retake") };
    mocks.capture.mockResolvedValueOnce(nextScreenshot);
    fireEvent.click(screen.getByRole("button", { name: "settings.report_preview_failed" }));

    const image = await screen.findByRole("img", { name: "settings.report_screenshot_label" });
    expect(image.getAttribute("src")).toBe(nextScreenshot.url);
    expect(screen.queryByText("settings.report_preview_failed")).toBeNull();
  });
});
