/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  t: (key: string) => key,
  create: vi.fn(),
  listBoards: vi.fn(),
  listMine: vi.fn(),
  mint: vi.fn(),
}));

vi.mock("@lynse/core/i18n/react", () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock("@lynse/core/i18n", () => ({ initI18n: vi.fn() }));
vi.mock("i18next", () => ({ default: { isInitialized: true, t: mocks.t } }));
vi.mock("../locales", () => ({ RESOURCES: {} }));
vi.mock("../layout/use-maximized", () => ({ isTauri: false, isMacDesktop: false }));
vi.mock("../app-update", () => ({
  getAppInfoSync: () => ({ version: "1.2.10", platform: "darwin" }),
  getDesktopAppApi: () => null,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@lynse/core/auth", () => ({
  useAuthStore: (selector: (state: { user?: unknown }) => unknown) =>
    selector({ user: { id: "u1", name: "张三", email: "z@l.cn" } }),
}));
vi.mock("@lynse/core/api", () => ({
  api: () => ({ getToken: () => "test-token" }),
  FEEDLOG_BASE_URL: "https://feedback.lynse.ai",
  FEEDLOG_FEATURE_BOARD_HINT: /^feature/i,
  mintFeedlogGuestToken: mocks.mint,
  listFeedlogBoards: mocks.listBoards,
  createFeedlogPost: mocks.create,
  listFeedlogMyPosts: mocks.listMine,
  feedlogPostUrl: (slug: string) => `https://feedback.lynse.ai/p/${slug}`,
}));
// Real diagnostics store (open/preset flow) with the transport stubbed: the
// form talks to FeedLog through the mocked core functions above, so the
// transport itself is never invoked.
vi.mock("../diagnostics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../diagnostics")>();
  return {
    ...actual,
    getDesktopDiagnosticsApi: () => ({ feedlogRequest: vi.fn() }),
  };
});

import { ReportProblemDialog } from "../report-problem-dialog";
import { closeReportProblemDialog, openFeatureRequests } from "../diagnostics";

const featureBoards = [
  { id: "board-feature", name: "Feature Requests", description: null, position: 0, postCount: 0 },
  { id: "board-bug", name: "Bug Report", description: null, position: 1, postCount: 0 },
];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.listBoards.mockResolvedValue(featureBoards);
  mocks.mint.mockResolvedValue("guest-token-1");
  mocks.create.mockResolvedValue({
    status: 201,
    post: { id: "p1", slug: "hello", title: "t", content: "c", status: "open", boardId: "board-feature", voteCount: 0 },
  });
  mocks.listMine.mockResolvedValue([]);
  vi.spyOn(window, "open").mockImplementation(() => null);
});

afterEach(() => {
  cleanup();
  closeReportProblemDialog();
  vi.restoreAllMocks();
});

function openCenter() {
  act(() => {
    openFeatureRequests();
  });
  render(<ReportProblemDialog />);
}

function fillForm(title: string, description: string) {
  fireEvent.change(screen.getByLabelText("settings.feedback_suggestion_title_label"), {
    target: { value: title },
  });
  fireEvent.change(screen.getByLabelText("settings.feedback_suggestion_desc_label"), {
    target: { value: description },
  });
}

describe("feature suggestion center", () => {
  it("opens on the submit tab; signed-in users default to identified posting", () => {
    openCenter();
    expect(screen.getByText("settings.feedback_center_title")).toBeTruthy();
    // Base UI renders the checkbox as a button — checked state lives in
    // aria-checked, not the .checked property.
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("false");
  });

  it("submits anonymously as a guest post into the feature board", async () => {
    openCenter();
    fireEvent.click(screen.getByRole("checkbox"));
    fillForm("希望支持批量导出", "需要一次导出所有会议记录");
    fireEvent.click(screen.getByText("settings.feedback_suggestion_submit"));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.mint).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledWith(
      "https://feedback.lynse.ai",
      expect.any(Function),
      "guest-token-1",
      expect.objectContaining({ title: "希望支持批量导出", boardId: "board-feature" }),
    );
    const input = mocks.create.mock.calls[0]?.[3] as { content: string };
    expect(input.content).not.toContain("张三");
    // Success hands over to the list tab, which shows the empty state for a
    // device with no prior posts.
    await waitFor(() => expect(screen.getByText("settings.feedback_tickets_empty_title")).toBeTruthy());
    expect(mocks.listMine).toHaveBeenCalled();
  });

  it("keeps the user signature in the content when not posting anonymously", async () => {
    openCenter();
    fillForm("希望支持批量导出", "需要一次导出所有会议记录");
    fireEvent.click(screen.getByText("settings.feedback_suggestion_submit"));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    const input = mocks.create.mock.calls[0]?.[3] as { content: string };
    expect(input.content).toContain("张三");
  });

  it("surfaces a submission failure instead of flipping to the list", async () => {
    openCenter();
    fillForm("希望支持批量导出", "需要一次导出所有会议记录");
    mocks.create.mockResolvedValue({ status: 500, post: null });
    fireEvent.click(screen.getByText("settings.feedback_suggestion_submit"));
    await waitFor(() => expect(screen.getByText("settings.feedback_suggestion_failed")).toBeTruthy());
    expect(mocks.listMine).not.toHaveBeenCalled();
  });

  it("lists the device's own posts with localized workflow statuses", async () => {
    mocks.listMine.mockResolvedValue([
      {
        id: "p1",
        slug: "batch-export",
        title: "批量导出会议记录",
        status: "in_progress",
        voteCount: 3,
        createdAt: "2026-11-12T00:00:00Z",
      },
    ]);
    act(() => {
      openFeatureRequests({ tab: "tickets" });
    });
    render(<ReportProblemDialog />);
    await waitFor(() => expect(mocks.listMine).toHaveBeenCalled());
    expect(screen.getByText("批量导出会议记录")).toBeTruthy();
    expect(screen.getByText("settings.feedback_post_status_in_progress")).toBeTruthy();
  });
});
