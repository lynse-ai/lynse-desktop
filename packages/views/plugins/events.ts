/**
 * Host-owned domain events plugins can subscribe to (PRD §4.4). Producers in
 * feature code emit without importing any plugin; subscribers register via
 * their manifest. The payload contract only ever grows (additive) — never
 * reshape a payload, add optional fields instead.
 */
export interface PluginEventMap {
  /** A transcription task finished (cloud or local engine). */
  "transcription-completed": {
    recordId: string;
    source: "cloud" | "local";
    /** Display title at emission time; consumers may fall back to their own. */
    title?: string;
    /** Freshly produced summary riding along (generate/rerun paths); absent
     * means the consumer should fetch the newest conclusion itself. */
    summary?: string | null;
  };
}

type PluginEventName = keyof PluginEventMap;

const listeners = new Map<PluginEventName, Set<(payload: unknown) => void>>();

export function emitPluginEvent<K extends PluginEventName>(
  event: K,
  payload: PluginEventMap[K],
): void {
  const set = listeners.get(event);
  if (!set) return;
  for (const handler of set) {
    try {
      handler(payload);
    } catch (error) {
      // One broken subscriber must not starve the others.
      console.error(`[plugins] listener for "${event}" failed`, error);
    }
  }
}

export function subscribePluginEvent<K extends PluginEventName>(
  event: K,
  handler: (payload: PluginEventMap[K]) => void,
): () => void {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  const wrapped = handler as (payload: unknown) => void;
  set.add(wrapped);
  return () => {
    set?.delete(wrapped);
  };
}
