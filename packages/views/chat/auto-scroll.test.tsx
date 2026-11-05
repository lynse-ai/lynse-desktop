/* @vitest-environment jsdom */

import { useLayoutEffect, useRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoScroll } from "@lynse/ui/hooks/use-auto-scroll";

const metrics = { height: 1200, viewport: 300 };
const callbacks = new Set<ResizeObserverCallback>();
const scrollTo = vi.fn();

function Harness({ conversation = "first" }: { conversation?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    let top = 0;
    Object.defineProperties(el, {
      clientHeight: { get: () => metrics.viewport },
      scrollHeight: { get: () => metrics.height },
      scrollTop: {
        get: () => top,
        set: (value: number) => { top = Math.max(0, Math.min(metrics.height - metrics.viewport, value)); },
      },
      scrollTo: { value: scrollTo },
    });
  }, []);
  const { pinnedToBottom, scrollToBottom } = useAutoScroll(ref, { resetKey: conversation });
  return (
    <>
      <div ref={ref} data-testid="messages"><div>Conversation</div></div>
      <span>{pinnedToBottom ? "Following" : "Reading"}</span>
      <button onClick={scrollToBottom}>Latest</button>
      <input aria-label="Draft" />
    </>
  );
}

function resizeContent() {
  act(() => {
    for (const callback of callbacks) callback([], {} as ResizeObserver);
    vi.runAllTimers();
  });
}

beforeEach(() => {
  metrics.height = 1200;
  metrics.viewport = 300;
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: ResizeObserverCallback) { callbacks.add(callback); }
    observe() {}
    unobserve() {}
    disconnect() { callbacks.delete(this.callback); }
  });
});

afterEach(() => {
  cleanup();
  callbacks.clear();
  scrollTo.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("conversation scroll continuity", () => {
  it("follows content and viewport growth while keeping draft focus", () => {
    render(<Harness />);
    const messages = screen.getByTestId("messages");
    const draft = screen.getByRole("textbox", { name: "Draft" });
    draft.focus();
    expect(messages.scrollTop).toBe(900);
    metrics.height = 1800;
    metrics.viewport = 250;
    resizeContent();
    expect(messages.scrollTop).toBe(1550);
    expect(document.activeElement).toBe(draft);
    expect(screen.getByText("Following")).toBeTruthy();
  });

  it("preserves a reader's position during streaming and resets on conversation switch", () => {
    const view = render(<Harness />);
    const messages = screen.getByTestId("messages");
    messages.scrollTop = 240;
    fireEvent.scroll(messages);
    metrics.height = 1800;
    resizeContent();
    expect(messages.scrollTop).toBe(240);
    expect(screen.getByText("Reading")).toBeTruthy();
    view.rerender(<Harness conversation="second" />);
    expect(screen.getByTestId("messages")).toBe(messages);
    expect(messages.scrollTop).toBe(1500);
    expect(screen.getByText("Following")).toBeTruthy();
  });

  it("uses instant explicit scrolling when reduced motion is requested", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Latest" }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 1200, behavior: "auto" });
  });
});
