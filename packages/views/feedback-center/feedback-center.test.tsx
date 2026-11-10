/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeReportProblemDialog, openReportProblem, setReportChannel } from "../diagnostics";
import { FeedbackCenterDialog } from "./feedback-center-dialog";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(), create: vi.fn(), listTickets: vi.fn(), getTicket: vi.fn(),
  addMessage: vi.fn(), toastError: vi.fn(), t: (key: string) => key,
}));
vi.mock("@lynse/core/i18n/react", () => ({ useTranslation: () => ({ t: mocks.t, i18n: { language: "zh-CN" } }) }));
vi.mock("@lynse/core/i18n", () => ({ initI18n: vi.fn() }));
vi.mock("i18next", () => ({ default: { isInitialized: true, t: mocks.t } }));
vi.mock("../locales", () => ({ RESOURCES: {} }));
vi.mock("../layout/use-maximized", () => ({ isTauri: false, isMacDesktop: false }));
vi.mock("../app-update", () => ({
  getAppInfoSync: () => ({ version: "test", platform: "darwin" }), openExternalUrl: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));
vi.mock("@lynse/core/api", () => ({
  api: () => ({ getToken: () => "test-token" }),
  createFeedbackTicket: mocks.create,
  listFeedbackTickets: mocks.listTickets,
  getFeedbackTicket: mocks.getTicket,
  addFeedbackMessage: mocks.addMessage,
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.capture.mockResolvedValue({ path: "/tmp/staging/report.jpg", url: "http://local-media.localhost/staging%3Areport.jpg" });
  mocks.listTickets.mockResolvedValue({
    items: [
      { ticket_id: "recA", title: "录音保存失败", type: "bug", status: "处理中", created_at: Date.now() },
    ],
    total: 1,
  });
  mocks.getTicket.mockResolvedValue({
    ticket: {
      ticket_id: "recA", title: "录音保存失败", description: "点保存没反应", type: "bug",
      module: "录音与转写", severity: "P1-高", status: "处理中", screenshot_url: "", created_at: Date.now(),
    },
    messages: [
      { message_id: "m1", sender: "staff", content: "已收到，正在排查", created_at: Date.now() },
    ],
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  setReportChannel({ endpoint: "https://dl.lynse.cn/cnb-report" });
});

afterEach(() => {
  cleanup();
  closeReportProblemDialog();
  setReportChannel(null);
  Reflect.deleteProperty(window, "desktopAPI");
  vi.restoreAllMocks();
});

function renderCenter() {
  render(<FeedbackCenterDialog />);
}

describe("feedback center", () => {
  it("opens on the submit tab and switches to the tickets tab on demand", async () => {
    mocks.listTickets.mockResolvedValue({ items: [], total: 0 });
    renderCenter();
    act(() => openReportProblem());
    await screen.findByLabelText("settings.report_problem_label");
    expect(screen.getByText("settings.feedback_tab_submit")).toBeTruthy();
    expect(screen.queryByText("settings.feedback_tickets_empty_title")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "settings.feedback_tab_tickets" }));
    await screen.findByText("settings.feedback_tickets_empty_title");
    expect(mocks.listTickets).toHaveBeenCalled();
  });

  it("shows ticket status in the list and opens the detail with the staff timeline", async () => {
    renderCenter();
    act(() => openReportProblem(undefined, { tab: "tickets" }));
    await screen.findByText("录音保存失败");
    expect(screen.getByText("settings.feedback_status_in_progress")).toBeTruthy();

    fireEvent.click(screen.getByText("录音保存失败"));
    await screen.findByText("已收到，正在排查");
    expect(screen.getByText("settings.feedback_timeline_staff_replied")).toBeTruthy();
    expect(screen.getByText("点保存没反应")).toBeTruthy();
  });

  it("sends a user supplement from the detail and appends it to the timeline", async () => {
    mocks.addMessage.mockResolvedValue({
      message_id: "m2", sender: "user", content: "又复现了一次", created_at: Date.now(),
    });
    renderCenter();
    act(() => openReportProblem(undefined, { tab: "tickets" }));
    fireEvent.click(await screen.findByText("录音保存失败"));
    fireEvent.change(await screen.findByPlaceholderText("settings.feedback_supplement_placeholder"), {
      target: { value: "又复现了一次" },
    });
    fireEvent.click(screen.getByRole("button", { name: "settings.feedback_supplement_send" }));
    await waitFor(() =>
      expect(mocks.addMessage).toHaveBeenCalledWith("recA", "又复现了一次", "test-token"),
    );
    await screen.findByText("又复现了一次");
  });

  it("surfaces a submission failure with the manual browser fallback", async () => {
    mocks.create.mockRejectedValue(new Error("反馈通道未配置"));
    renderCenter();
    act(() => openReportProblem());
    fireEvent.change(await screen.findByLabelText("settings.report_problem_label"), {
      target: { value: "Crash on save" },
    });
    fireEvent.click(screen.getByRole("button", { name: "settings.report_submit" }));
    await screen.findByText((content) => content.includes("settings.report_submit_failed"));
    expect(screen.getByRole("button", { name: "settings.report_browser_fallback" })).toBeTruthy();
  });

  it("presets the feature category when opened through the feature-request entry", async () => {
    renderCenter();
    act(() => openReportProblem(undefined, { tab: "submit", category: "feature" }));
    const category = await screen.findByLabelText("settings.feedback_category_label");
    expect((category as HTMLSelectElement).value).toBe("feature");
  });
});
