/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResizableHandle } from "./resizable-handle";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ResizableHandle", () => {
  it("resizes the panel with the arrow keys", () => {
    const onResize = vi.fn();
    render(<ResizableHandle label="Resize notes" onResize={onResize} side="right" />);

    const handle = screen.getByRole("separator", { name: "Resize notes" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });

    expect(onResize).toHaveBeenNthCalledWith(1, 16);
    expect(onResize).toHaveBeenNthCalledWith(2, -16);
  });

  it("reverses the delta for a handle on the left side of a panel", () => {
    const onResize = vi.fn();
    render(<ResizableHandle label="Resize chat" onResize={onResize} side="left" />);

    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize chat" }), {
      key: "ArrowRight",
    });

    expect(onResize).toHaveBeenCalledWith(-16);
  });

  it("tracks pointer movement while the pointer is captured", () => {
    let frameCallback: FrameRequestCallback | undefined;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frameCallback = callback;
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const onResize = vi.fn();
    render(<ResizableHandle label="Resize notes" onResize={onResize} />);
    const handle = screen.getByRole("separator", { name: "Resize notes" });
    Object.assign(handle, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
      releasePointerCapture: vi.fn(),
    });

    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 7 });
    fireEvent.pointerMove(handle, { clientX: 148, pointerId: 7 });
    frameCallback?.(0);
    fireEvent.pointerUp(handle, { clientX: 148, pointerId: 7 });

    expect(onResize).toHaveBeenCalledWith(48);
  });
});
