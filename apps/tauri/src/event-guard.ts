// Guard the Tauri event-plugin teardown path.
//
// Why this exists: `@tauri-apps/api/event`'s unlisten helper runs
// `window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener(event, id)` and the
// generated unlisten function is *not* idempotent — removing the same listener id
// twice throws a TypeError from inside the plugin internals (the handler entry is
// already gone). Because `_unlisten` is async, that throw becomes an unhandled
// promise rejection rather than something a caller can notice, so every React
// effect that can race its own cleanup (unmount before `listen()` resolves, StrictMode
// double-invoke, a cleanup closure captured by two unmount paths) pollutes the log
// and, worse, skips the `plugin:event|unlisten` IPC that would actually release the
// native handler.
//
// The patch is deliberately narrow: a TypeError is only swallowed for a
// (event, id) pair this wrapper has already removed successfully once, i.e. a
// genuine duplicate. A failure on a first removal is rethrown so real bugs stay
// visible instead of being masked by a catch-all.
import { listen, type EventName, type Options, type UnlistenFn } from "@tauri-apps/api/event";

interface UnregisterListener {
  (event: string, eventId: number): void;
}

interface EventPluginInternals {
  unregisterListener: UnregisterListener;
  /** Set once this guard has wrapped `unregisterListener`, so re-running is a no-op. */
  lynseUnlistenGuardInstalled?: boolean;
}

interface WindowWithInternals extends Window {
  __TAURI_EVENT_PLUGIN_INTERNALS__?: EventPluginInternals;
}

/**
 * Wrap the event plugin's `unregisterListener`. Returns true when the guard was
 * installed, false when there was nothing to guard (not a Tauri webview, or the
 * e2e shim has not installed its stub yet, or already patched).
 */
export function installEventUnlistenGuard(target: Window = window): boolean {
  const internals = (target as WindowWithInternals).__TAURI_EVENT_PLUGIN_INTERNALS__;
  if (!internals || typeof internals.unregisterListener !== "function") return false;
  if (internals.lynseUnlistenGuardInstalled) return false;

  const unregister = internals.unregisterListener.bind(internals);
  const removed = new Set<string>();
  let reported = false;

  internals.unregisterListener = (event: string, eventId: number): void => {
    const key = `${event}:${eventId}`;
    const duplicate = removed.has(key);
    try {
      unregister(event, eventId);
      removed.add(key);
    } catch (error) {
      // Only a second removal of an already-removed id is expected. Anything
      // else — including a TypeError on a first removal — must keep propagating.
      if (duplicate && error instanceof TypeError) {
        if (!reported) {
          reported = true;
          console.debug(`[event-guard] ignored duplicate unlisten for "${event}"`);
        }
        return;
      }
      throw error;
    }
  };

  internals.lynseUnlistenGuardInstalled = true;
  return true;
}

/**
 * `listen` with cleanup that is safe to call twice and safe to call before the
 * underlying registration resolves. New code should prefer this over raw
 * `listen()` inside effects; the existing call sites stay as they are until
 * touched for another reason.
 */
export async function safeListen<T>(
  event: EventName | (string & {}),
  handler: (payload: T) => void,
  options?: Options,
): Promise<UnlistenFn> {
  let unlisten: UnlistenFn | undefined;
  let disposed = false;

  const ready = listen<T>(event as string, (e) => handler(e.payload), options).then((fn) => {
    if (disposed) fn();
    else unlisten = fn;
  });

  await ready;

  return () => {
    disposed = true;
    const fn = unlisten;
    unlisten = undefined;
    fn?.();
  };
}

export type { EventName, UnlistenFn };
