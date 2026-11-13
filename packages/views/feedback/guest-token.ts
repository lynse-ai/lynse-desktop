/**
 * Local cache of the FeedLog anonymous guest session token.
 *
 * Guest identity is per-device and deliberately independent of the Lynse
 * session: it survives logout (a suggestion filed earlier keeps its thread),
 * and posting stays possible while signed out. Stored in plain localStorage
 * — it only ever speaks to the suggestion board, never to user data.
 */

import { mintFeedlogGuestToken, type FeedlogTransport } from "@lynse/core/api";

const GUEST_TOKEN_KEY = "lynse_feedlog_guest_token";

export function getStoredFeedlogGuestToken(): string | null {
  try {
    return window.localStorage.getItem(GUEST_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function storeFeedlogGuestToken(token: string): void {
  try {
    window.localStorage.setItem(GUEST_TOKEN_KEY, token);
  } catch {
    // Storage unavailable (private mode): the token still works for this
    // dialog run, it just won't survive a reload.
  }
}

/** Reuse the cached guest session, minting one when absent. */
export async function ensureFeedlogGuestToken(
  baseUrl: string,
  transport: FeedlogTransport,
): Promise<string | null> {
  const stored = getStoredFeedlogGuestToken();
  if (stored) return stored;
  const minted = await mintFeedlogGuestToken(baseUrl, transport);
  if (minted) storeFeedlogGuestToken(minted);
  return minted;
}
