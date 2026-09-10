/**
 * Map login/connect failures to readable copy. The gateway reports credential
 * problems as raw dotted codes in `msg` (e.g. `error.api.key.invalid`) — a
 * bare code must never reach the user.
 */
export function authErrorText(
  error: unknown,
  t: (key: string) => string,
): string {
  const fallback = t("auth.api_key_connect_failed");
  const raw = error instanceof Error && error.message ? error.message.trim() : "";
  if (!raw) return fallback;
  // A dotted lowercase code is a server key, not user-facing copy.
  if (/^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/.test(raw)) {
    if (raw === "error.api.key.invalid") return t("auth.api_key_invalid");
    return fallback;
  }
  return raw;
}
