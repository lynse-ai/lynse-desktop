/**
 * Registry of in-flight bot turns. The auth supervisor aborts everything here
 * when the user logs out — previously an answer kept running (up to its 120s
 * timeout) with a dead token after logout.
 */
const active = new Set<AbortController>();

/** Track a turn's controller; returns the unregister function. */
export function trackTurn(controller: AbortController): () => void {
  active.add(controller);
  return () => active.delete(controller);
}

export function abortAllTurns(): void {
  for (const controller of active) controller.abort();
  active.clear();
}
