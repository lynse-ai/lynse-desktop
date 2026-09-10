/**
 * Map login/connect failures to readable copy. The gateway reports credential
 * problems as raw dotted codes in `msg` (e.g. `error.api.key.invalid`) — a
 * bare code must never reach the user.
 */
export function authErrorText(
  error: unknown,
  t: (key: string) => string,
  fallbackKey = "auth.api_key_connect_failed",
): string {
  const fallback = t(fallbackKey);
  const raw = error instanceof Error && error.message ? error.message.trim() : "";
  if (!raw) return fallback;
  // A dotted lowercase code is a server key, not user-facing copy.
  if (/^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/.test(raw)) {
    switch (raw) {
      case "error.api.key.invalid":
        return t("auth.api_key_invalid");
      case "error.phone.format.invalid":
        return t("auth.sms_phone_invalid");
      case "error.sms.send.failed":
        return t("auth.sms_send_failed");
      case "error.operation.too.frequent":
        return t("auth.sms_too_frequent");
      case "error.sms.service.not.configured":
        return t("auth.sms_service_unavailable");
      case "system.error.busy":
        return t("auth.server_busy");
      default:
        return fallback;
    }
  }
  return raw;
}
