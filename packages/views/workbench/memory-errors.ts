export function memoryRequestErrorKey(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
    ? error.status : Number(message.match(/HTTP (\d{3})/)?.[1]);
  if (status === 401 || /Cloud knowledge identity (verification failed|mismatch)|Session changed|Sign in to manage memory/.test(message)) return "memory_manager.connection_auth";
  if (status === 403) return "memory_manager.connection_forbidden";
  if (status === 404 || status === 501) return "memory_manager.unavailable";
  if (status === 409 || message.includes("Cloud knowledge policy changed")) return "memory_manager.changed";
  if (status === 429) return "memory_manager.connection_busy";
  if (status >= 500 || /Cloud knowledge (offline|unavailable|connection failed|request failed|capability unavailable)|fetch|network|timed? ?out/i.test(message)) return "memory_manager.connection_failed";
  if (/Invalid (cloud knowledge|knowledge identity) response/.test(message)) return "memory_manager.connection_invalid";
  if (message.includes("Cloud knowledge policy pending synchronization")) return "memory_manager.policy_pending";
  return null;
}
