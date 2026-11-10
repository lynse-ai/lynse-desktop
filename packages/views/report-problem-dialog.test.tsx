/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeReportProblemDialog, openReportProblem, setReportChannel, takePendingScreenshot,
  type DesktopDiagnosticsApi,
} from "./diagnostics";
import { ReportProblemDialog } from "./report-problem-dialog";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(), submit: vi.fn(), annotate: vi.fn(), toastError: vi.fn(),
  create: vi.fn(), listTickets: vi.fn(), upload: vi.fn(), t: (key: string) => key,
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
vi.mock("@lynse/core/api", () => ({
  api: () => ({ getToken: () => "test-token", getAgentBaseUrl: () => "https://agent.test", getBaseUrl: () => "https://api.test" }),
  createFeedbackTicket: mocks.create,
  listFeedbackTickets: mocks.listTickets,
}));

const screenshot = {
  path: "C:\\Lynse\\inspirations\\staging\\report-example.jpg",
  url: "http://local-media.localhost/staging%3Areport-example.jpg",
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.capture.mockResolvedValue(screenshot);
  mocks.create.mockResolvedValue({ ticket_id: "recSmoke", status: "已提交", created_at: 1 });
  mocks.listTickets.mockResolvedValue({ items: [], total: 0 });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const api: DesktopDiagnosticsApi = {
    captureScreenshot: mocks.capture,
    submitCnbIssue: mocks.submit,
    uploadScreenshot: mocks.upload,
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
    expect(mocks.create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "settings.report_submit" }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ description: expect.stringContaining(description) }), "test-token"));
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
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledWith(expect.objectContaining({
      path: screenshot.path,
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
    // The capture carries the theme backdrop for the vibrancy transparency
    // (jsdom can't resolve `--background`, so the host's white fallback).
    expect(mocks.capture).toHaveBeenCalledWith(null);
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

  it("keeps the preview inert on a host without the annotation command", async () => {
    openDialog();
    fireEvent.click(await screen.findByRole("img", { name: "settings.report_screenshot_label" }));
    expect(screen.queryByTestId("report-annotator")).toBeNull();
    expect(screen.queryByText("settings.report_annotate_hint")).toBeNull();
  });
});

describe("problem report screenshot annotation", () => {
  const annotated = {
    path: screenshot.path.replace("example", "annotated"),
    url: screenshot.url.replace("example", "annotated"),
  };

  beforeEach(() => {
    const host = window as Window & { desktopAPI?: { app: DesktopDiagnosticsApi } };
    host.desktopAPI!.app.saveAnnotatedScreenshot = mocks.annotate;
    mocks.annotate.mockResolvedValue(annotated);
    // jsdom has no 2D context; the editor tolerates that, and the overlay
    // export is what the host receives, so stub it with a stable payload.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,QUJD");
  });

  function description(): HTMLTextAreaElement {
    return screen.getByLabelText("settings.report_problem_label") as HTMLTextAreaElement;
  }

  /** The dialog opens once the capture resolves — wait for the form. */
  async function openDialogForm() {
    openDialog();
    await screen.findByLabelText("settings.report_problem_label");
  }

  async function openEditor() {
    fireEvent.click(await screen.findByRole("img", { name: "settings.report_screenshot_label" }));
    const editor = screen.getByTestId("report-annotator");
    const image = screen.getByRole("img", { name: "settings.report_screenshot_label" });
    Object.defineProperty(image, "naturalWidth", { value: 1200, configurable: true });
    Object.defineProperty(image, "naturalHeight", { value: 600, configurable: true });
    fireEvent.load(image);
    const canvas = screen.getByTestId("report-annotator-canvas") as HTMLCanvasElement;
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 600, height: 300, right: 600, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    canvas.setPointerCapture = vi.fn();
    return { editor, canvas };
  }

  function draw(canvas: HTMLCanvasElement) {
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 100, clientY: 50 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 220, clientY: 90 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
  }

  it("opens the editor from the preview and leaves the capture alone when nothing was drawn", async () => {
    await openDialogForm();
    fireEvent.change(description(), { target: { value: "The sidebar overlaps the toolbar" } });
    expect(screen.getByText("settings.report_annotate_hint")).toBeTruthy();

    const { editor } = await openEditor();
    expect(screen.queryByLabelText("settings.report_problem_label")).toBeNull();
    expect((screen.getByTestId("report-annotator-undo") as HTMLButtonElement).disabled).toBe(true);

    // Done without marks is just a close; the form comes back intact.
    fireEvent.click(screen.getByTestId("report-annotator-done"));
    expect(mocks.annotate).not.toHaveBeenCalled();
    expect(screen.queryByTestId("report-annotator")).toBeNull();
    expect(description().value).toBe("The sidebar overlaps the toolbar");

    // Escape closes the editor only, never the dialog hosting it.
    await openEditor();
    fireEvent.keyDown(screen.getByTestId("report-annotator"), { key: "Escape" });
    expect(screen.queryByTestId("report-annotator")).toBeNull();
    expect(description().value).toBe("The sidebar overlaps the toolbar");
    expect(editor.isConnected).toBe(false);
  });

  it("burns the marks into a fresh staged capture that the submission then uses", async () => {
    await openDialogForm();
    fireEvent.change(description(), { target: { value: "Button is misaligned" } });
    const { canvas } = await openEditor();

    fireEvent.click(screen.getByTestId("report-annotator-arrow"));
    expect(screen.getByTestId("report-annotator-arrow").getAttribute("aria-pressed")).toBe("true");
    draw(canvas);
    const undo = screen.getByTestId("report-annotator-undo") as HTMLButtonElement;
    expect(undo.disabled).toBe(false);
    fireEvent.click(undo);
    expect(undo.disabled).toBe(true);
    draw(canvas);

    fireEvent.click(screen.getByTestId("report-annotator-done"));
    await waitFor(() =>
      expect(mocks.annotate).toHaveBeenCalledWith(screenshot.path, "data:image/png;base64,QUJD"),
    );
    const preview = await screen.findByRole("img", { name: "settings.report_screenshot_label" });
    expect(preview.getAttribute("src")).toBe(annotated.url);
    expect(screen.queryByTestId("report-annotator")).toBeNull();
    expect(description().value).toBe("Button is misaligned");

    fireEvent.click(screen.getByRole("button", { name: "settings.report_submit" }));
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledWith(expect.objectContaining({
      path: annotated.path,
    })));
  });

  it("keeps the marks and reports the failure when the host cannot composite", async () => {
    mocks.annotate.mockRejectedValueOnce(new Error("annotation overlay decoding failed"));
    openDialog();
    const { canvas } = await openEditor();
    draw(canvas);

    fireEvent.click(screen.getByTestId("report-annotator-done"));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("settings.report_annotate_failed"));
    expect(console.warn).toHaveBeenCalledWith("[report-screenshot] annotation save failed:", expect.any(Error));
    // Still in the editor, the stroke still there to retry with.
    expect(screen.getByTestId("report-annotator")).toBeTruthy();
    await waitFor(() => expect((screen.getByTestId("report-annotator-undo") as HTMLButtonElement).disabled).toBe(false));
  });

  it("adds text marks that survive into the saved overlay", async () => {
    await openDialogForm();
    const { canvas } = await openEditor();
    fireEvent.click(screen.getByTestId("report-annotator-text"));

    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 200, clientY: 100 });
    const input = await screen.findByRole("textbox");
    fireEvent.change(input, { target: { value: "这一步报错" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.queryByRole("textbox")).toBeNull();
    expect((screen.getByTestId("report-annotator-undo") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId("report-annotator-done"));
    await waitFor(() => expect(mocks.annotate).toHaveBeenCalledWith(screenshot.path, "data:image/png;base64,QUJD"));
  });

  it("erases whole marks it touches and spares the rest", async () => {
    await openDialogForm();
    const { canvas } = await openEditor();
    draw(canvas);
    const undo = screen.getByTestId("report-annotator-undo") as HTMLButtonElement;
    expect(undo.disabled).toBe(false);

    fireEvent.click(screen.getByTestId("report-annotator-eraser"));
    // Off the stroke: nothing goes away.
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 2, clientX: 500, clientY: 250 });
    fireEvent.pointerUp(canvas, { pointerId: 2 });
    expect(undo.disabled).toBe(false);
    // Across the stroke: the mark is gone entirely.
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 3, clientX: 160, clientY: 70 });
    fireEvent.pointerMove(canvas, { pointerId: 3, clientX: 161, clientY: 71 });
    fireEvent.pointerUp(canvas, { pointerId: 3 });
    expect(undo.disabled).toBe(true);
  });

  it("steps zoom between fit and the ceiling and resets from the percentage", async () => {
    await openDialogForm();
    await openEditor();
    const zoomOut = screen.getByTestId("report-annotator-zoom-out") as HTMLButtonElement;
    const zoomIn = screen.getByTestId("report-annotator-zoom-in") as HTMLButtonElement;
    const label = screen.getByTestId("report-annotator-zoom-reset");
    expect(zoomOut.disabled).toBe(true);
    expect(label.textContent).toBe("100%");

    fireEvent.click(zoomIn);
    expect(label.textContent).toBe("125%");
    expect(zoomOut.disabled).toBe(false);
    // Back through the pill itself lands exactly on fit.
    fireEvent.click(zoomOut);
    expect(label.textContent).toBe("100%");
    expect(zoomOut.disabled).toBe(true);
    expect(zoomIn.disabled).toBe(false);
  });
});
