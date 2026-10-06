import { describe, expect, it, vi } from "vitest";
import { installEventUnlistenGuard } from "./event-guard";

interface FakeInternals {
  unregisterListener(event: string, eventId: number): void;
  lynseUnlistenGuardInstalled?: boolean;
}

/**
 * Mirrors the real event-plugin internals: unregistering an id whose handler
 * entry is already gone dereferences undefined and throws a TypeError. That is
 * what an unlisten called twice hits.
 */
function makeTarget(registeredKeys: string[] = ["recording-progress:1", "error:2"]) {
  const registered = new Set(registeredKeys);
  const calls: Array<[string, number]> = [];
  const internals: FakeInternals = {
    unregisterListener(event: string, eventId: number) {
      calls.push([event, eventId]);
      const key = `${event}:${eventId}`;
      if (!registered.has(key)) {
        throw new TypeError("Cannot read properties of undefined (reading 'handler')");
      }
      registered.delete(key);
    },
  };
  return { target: { __TAURI_EVENT_PLUGIN_INTERNALS__: internals } as unknown as Window, internals, calls };
}

describe("installEventUnlistenGuard", () => {
  it("does nothing outside a Tauri webview", () => {
    expect(installEventUnlistenGuard({} as Window)).toBe(false);
    expect(installEventUnlistenGuard({ __TAURI_EVENT_PLUGIN_INTERNALS__: {} } as unknown as Window)).toBe(false);
  });

  it("installs once and never wraps twice", () => {
    const { target } = makeTarget();
    expect(installEventUnlistenGuard(target)).toBe(true);
    expect(installEventUnlistenGuard(target)).toBe(false);
  });

  it("swallows only the duplicate removal, not the first one", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const { target, internals, calls } = makeTarget();
    installEventUnlistenGuard(target);
    const wrapped = internals.unregisterListener!;

    expect(() => wrapped("recording-progress", 1)).not.toThrow();
    // Second teardown of the same id: expected to be ignored.
    expect(() => wrapped("recording-progress", 1)).not.toThrow();
    expect(calls).toHaveLength(2);
    expect(debug).toHaveBeenCalledTimes(1);
    debug.mockRestore();
  });

  it("rethrows a TypeError on a first removal so real bugs stay visible", () => {
    const { target, internals } = makeTarget([]);
    installEventUnlistenGuard(target);
    expect(() => internals.unregisterListener!("never-listened", 42)).toThrow(TypeError);
  });

  it("never masks errors that are not the duplicate TypeError", () => {
    const registered = new Set(["a:1"]);
    const internals: FakeInternals = {
      unregisterListener(event: string, eventId: number) {
        const key = `${event}:${eventId}`;
        if (!registered.has(key)) throw new RangeError("boom");
        registered.delete(key);
      },
    };
    const target = { __TAURI_EVENT_PLUGIN_INTERNALS__: internals } as unknown as Window;
    installEventUnlistenGuard(target);
    internals.unregisterListener!("a", 1);
    expect(() => internals.unregisterListener!("a", 1)).toThrow(RangeError);
  });

  it("reports the duplicate only once per install", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const { target, internals } = makeTarget(["a:1", "b:2"]);
    installEventUnlistenGuard(target);
    const wrapped = internals.unregisterListener!;
    wrapped("a", 1);
    wrapped("a", 1);
    wrapped("b", 2);
    wrapped("b", 2);
    expect(debug).toHaveBeenCalledTimes(1);
    debug.mockRestore();
  });
});
