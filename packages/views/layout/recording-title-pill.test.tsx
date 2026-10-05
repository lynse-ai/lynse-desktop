/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RecordingTitleBarPill, useRecordingPillVisible } from "./recording-title-pill";

/**
 * The pill is wired to the desktop bridge through useQuickRecording and to
 * the shell route through useNavigation — both are mocked so the tests drive
 * plain state objects. SmoothTimer and IconSwap run for real (jsdom rAF is
 * available), which also exercises the freeze/spinner branches.
 */
const mocks = vi.hoisted(() => ({
  pathname: "/",
  quick: {
    available: true,
    recording: false,
    paused: false,
    stopping: false,
    elapsedMs: 0,
    lastError: undefined as string | undefined,
    start: vi.fn(),
    stop: vi.fn(),
    togglePause: vi.fn(),
  },
}));

vi.mock("../live-translation/quick-recording", () => ({
  useQuickRecording: () => mocks.quick,
}));

vi.mock("../navigation", () => ({
  useNavigation: () => ({ pathname: mocks.pathname }),
}));

vi.mock("@lynse/core/i18n/react", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

/** Reads the lane store the app title bar consumes for breadcrumb padding. */
function PillVisibleProbe() {
  const visible = useRecordingPillVisible();
  return <span data-testid="pill-visible">{String(visible)}</span>;
}

function renderPill() {
  return render(
    <>
      <RecordingTitleBarPill />
      <PillVisibleProbe />
    </>,
  );
}

beforeEach(() => {
  // A neutral inner page — "/" and "/home" are the home route, where the
  // pill deliberately stays hidden.
  mocks.pathname = "/notes";
  mocks.quick.available = true;
  mocks.quick.recording = false;
  mocks.quick.paused = false;
  mocks.quick.stopping = false;
  mocks.quick.elapsedMs = 0;
  mocks.quick.lastError = undefined;
  mocks.quick.togglePause.mockClear();
  mocks.quick.stop.mockClear();
});

afterEach(cleanup);

describe("RecordingTitleBarPill", () => {
  it("renders nothing when no session is live", () => {
    renderPill();
    expect(screen.queryByTitle("recording_mode.pause")).toBeNull();
    expect(screen.queryByTitle("recording_mode.stop_recording")).toBeNull();
    expect(screen.getByTestId("pill-visible").textContent).toBe("false");
  });

  it("renders nothing on the web (no desktop bridge)", () => {
    mocks.quick.available = false;
    mocks.quick.recording = true;
    renderPill();
    expect(screen.queryByTitle("recording_mode.pause")).toBeNull();
    expect(screen.getByTestId("pill-visible").textContent).toBe("false");
  });

  it("shows the timer and pause/stop controls while recording", () => {
    mocks.quick.recording = true;
    mocks.quick.elapsedMs = 45_000;
    renderPill();

    expect(screen.getByTitle("recording_mode.pause")).toBeTruthy();
    expect(screen.getByTitle("recording_mode.stop_recording")).toBeTruthy();
    // SmoothTimer's first paint shows the authoritative snapshot.
    expect(screen.getByText("00:45")).toBeTruthy();
    expect(screen.getByTestId("pill-visible").textContent).toBe("true");
  });

  it("offers resume instead of pause while paused", () => {
    mocks.quick.recording = false;
    mocks.quick.paused = true;
    mocks.quick.elapsedMs = 61_000;
    renderPill();

    expect(screen.queryByTitle("recording_mode.pause")).toBeNull();
    expect(screen.getByTitle("recording_mode.resume")).toBeTruthy();
    expect(screen.getByText("01:01")).toBeTruthy();
  });

  it("stays visible while the stop is finalizing in the background", () => {
    mocks.quick.stopping = true;
    const { container } = renderPill();
    expect(container.firstChild).toBeTruthy();
    expect(screen.getByTitle("recording_mode.stop_recording")).toBeTruthy();
  });

  it("hides on the recording page, whose dock owns the controls", () => {
    mocks.quick.recording = true;
    mocks.pathname = "/recording";
    renderPill();
    expect(screen.queryByTitle("recording_mode.pause")).toBeNull();
    expect(screen.getByTestId("pill-visible").textContent).toBe("false");
  });

  it("hides on the home page, which has its own floating recording capsule", () => {
    mocks.quick.recording = true;
    for (const home of ["/", "/home"]) {
      mocks.pathname = home;
      const { unmount } = renderPill();
      expect(screen.queryByTitle("recording_mode.pause")).toBeNull();
      expect(screen.getByTestId("pill-visible").textContent).toBe("false");
      unmount();
    }
  });

  it("wires the pause and stop buttons to the quick-recording controls", () => {
    mocks.quick.recording = true;
    renderPill();

    fireEvent.click(screen.getByTitle("recording_mode.pause"));
    expect(mocks.quick.togglePause).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTitle("recording_mode.stop_recording"));
    expect(mocks.quick.stop).toHaveBeenCalledTimes(1);
  });
});
