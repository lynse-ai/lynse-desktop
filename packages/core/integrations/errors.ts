import { ApiError } from "../api/client";

/**
 * Business error keys the integrations backend returns inside `ApiError.message`
 * (the gateway puts numeric codes in `.status`, dotted keys in `.message` —
 * see `packages/core/api/client.ts:154-178`).
 *
 * Mirrors the `WORKBUDDY_ERROR` precedent: core owns the key list and the
 * predicates, the consuming view owns the key → i18n copy mapping, so no screen
 * ever renders a raw dotted code.
 */
export const INTEGRATIONS_ERROR = {
  /** Free-tier wall: the provider needs a paid plan. */
  REQUIRES_PRO: "error.integrations.requires_pro",
  /** The provider is not deployed/configured server-side (HTTP 503). */
  NOT_CONFIGURED: "error.integrations.not_configured",
  /** OAuth state missing/expired/forged — the user must restart the flow. */
  STATE_INVALID: "error.integrations.state_invalid",
  /** Connected, but no default destination picked yet (HTTP 409). */
  NO_DESTINATION: "error.integrations.no_destination",
  /** Export attempted against a provider that is not connected (HTTP 409). */
  NOT_CONNECTED: "error.integrations.not_connected",
  /** The referenced account no longer exists. */
  UNKNOWN_ACCOUNT: "error.integrations.unknown_account",
  /** The chosen destination is not one the provider offered (HTTP 400). */
  UNKNOWN_DESTINATION: "error.integrations.unknown_destination",
  /** Per-item export failure inside an otherwise successful export. */
  EXPORT_ITEM_FAILED: "error.integrations.export_item_failed",
} as const;

export type IntegrationsErrorCode = (typeof INTEGRATIONS_ERROR)[keyof typeof INTEGRATIONS_ERROR];

function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : String(error ?? "");
}

function hasKey(error: unknown, key: IntegrationsErrorCode): boolean {
  return messageOf(error).includes(key);
}

export function isRequiresProError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403 && hasKey(error, INTEGRATIONS_ERROR.REQUIRES_PRO);
}

export function isNotConfiguredError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 503;
}

export function isNoDestinationError(error: unknown): boolean {
  return hasKey(error, INTEGRATIONS_ERROR.NO_DESTINATION);
}

export function isNotConnectedError(error: unknown): boolean {
  return hasKey(error, INTEGRATIONS_ERROR.NOT_CONNECTED);
}

/** The OAuth session died (expired or the tab was closed) — restart the flow. */
export function isOAuthStateInvalidError(error: unknown): boolean {
  return hasKey(error, INTEGRATIONS_ERROR.STATE_INVALID);
}

/**
 * Transient poll failures must not abort the connect flow: a dropped status
 * request while waiting for the browser round trip is expected.
 */
export function isTransientIntegrationsError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500;
}
