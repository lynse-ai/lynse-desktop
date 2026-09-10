import { api } from "../api/client";
import type { AuthSession } from "./session";

/**
 * Own-app QR-code sign-in ("scan to log in") for the desktop and web shells.
 * The Lynse mobile app acts as the authorizer — no WeChat/SMS involved.
 *
 * Flow:
 *  1. Desktop requests a login challenge:
 *     `POST /api/auth/qrcode/create` → `{ qrId, qrToken, expireIn }`.
 *  2. The QR image encodes a deep link for the Lynse mobile app:
 *     `lynse://auth/qr?qrId=...&token=...`. `token` is the secret that
 *     authorizes the confirmation, so only whoever scanned the QR (or a
 *     logged-in app user) can approve the desktop sign-in.
 *  3. The mobile app scans the QR and calls, authenticated with the mobile
 *     user's `Authorization` token:
 *       - `POST /api/auth/qrcode/scan`    body `{ qrId, qrToken }` — flips
 *         the challenge to "scanned" (desktop shows "confirm on your phone");
 *       - `POST /api/auth/qrcode/confirm` body `{ qrId, qrToken }` — flips it
 *         to "confirmed" and mints a session for the desktop.
 *  4. The desktop polls `GET /api/auth/qrcode/session?qrId=...` until the
 *     challenge is confirmed or expired, then persists the session like any
 *     other login channel.
 *
 * Expected backend contract (ApiClient unwraps the `{ code, data }` envelope):
 *  - `POST /api/auth/qrcode/create`                       →
 *      `{ qrId, qrToken, expireIn }`        (expireIn in seconds)
 *  - `GET  /api/auth/qrcode/session?qrId=...`             →
 *      `{ status: "pending"  }`
 *      `{ status: "scanned"  }`
 *      `{ status: "expired"  }`
 *      `{ status: "confirmed", token, customerId? }`
 *  - `POST /api/auth/qrcode/scan`    (mobile user token)  → data ignored
 *  - `POST /api/auth/qrcode/confirm` (mobile user token)  → data ignored
 */

export interface QrLoginChallenge {
  qrId: string;
  qrToken: string;
  /** Seconds until the QR expires; callers may fall back to a default. */
  expireIn: number;
}

export const QR_LOGIN_DEFAULT_EXPIRE_SECONDS = 120;

/** Deep-link payload encoded into the QR image for the Lynse mobile app. */
export function buildQrLoginPayload(challenge: QrLoginChallenge): string {
  const params = new URLSearchParams({
    qrId: challenge.qrId,
    token: challenge.qrToken,
  });
  return `lynse://auth/qr?${params.toString()}`;
}

/** Ask the backend for a fresh login QR challenge. */
export function createQrLogin(): Promise<QrLoginChallenge> {
  return api().post<QrLoginChallenge>("/api/auth/qrcode/create");
}

export type QrLoginPoll =
  | { status: "pending" | "scanned" | "expired" }
  | { status: "confirmed"; token: string; customerId?: string };

/** Read the current state of a QR login challenge (one poll round). */
export function fetchQrLoginStatus(qrId: string): Promise<QrLoginPoll> {
  return api().getWithParams<QrLoginPoll>("/api/auth/qrcode/session", { qrId });
}

/** Thrown when the challenge expired (or polled past its deadline). */
export class QrLoginExpiredError extends Error {
  constructor() {
    super("QR login challenge expired");
    this.name = "QrLoginExpiredError";
  }
}

function sessionFromPoll(poll: Extract<QrLoginPoll, { status: "confirmed" }>): AuthSession {
  return {
    accessToken: poll.token,
    user: { id: poll.customerId ?? "", name: "", email: "" },
  };
}

/**
 * Poll until the challenge is confirmed. Invokes `onStatus("scanned")` once
 * the mobile app has scanned the QR. Rejects with `QrLoginExpiredError` when
 * the backend reports expiry or `expiresInSeconds` elapse. Transient network
 * errors are tolerated until the deadline so a flaky connection does not
 * abort the login.
 */
export async function pollQrLogin(
  qrId: string,
  opts: {
    intervalMs?: number;
    expiresInSeconds?: number;
    onScanned?: () => void;
    isCancelled?: () => boolean;
  } = {},
): Promise<AuthSession> {
  const intervalMs = opts.intervalMs ?? 2000;
  const expiresAt =
    Date.now() +
    (opts.expiresInSeconds || QR_LOGIN_DEFAULT_EXPIRE_SECONDS) * 1000;
  let scannedNotified = false;

  while (Date.now() < expiresAt) {
    if (opts.isCancelled?.()) throw new Error("cancelled");
    let poll: QrLoginPoll;
    try {
      poll = await fetchQrLoginStatus(qrId);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      continue;
    }
    if (poll.status === "confirmed") return sessionFromPoll(poll);
    if (poll.status === "expired") throw new QrLoginExpiredError();
    if (poll.status === "scanned" && !scannedNotified) {
      scannedNotified = true;
      opts.onScanned?.();
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new QrLoginExpiredError();
}

/**
 * Mobile-app side of the contract (kept here as the reference client for the
 * documented endpoints; the Lynse mobile app calls these with the logged-in
 * user's token in the `Authorization` header).
 */
export function scanQrLogin(qrId: string, qrToken: string): Promise<unknown> {
  return api().post("/api/auth/qrcode/scan", { qrId, qrToken });
}

export function confirmQrLogin(qrId: string, qrToken: string): Promise<unknown> {
  return api().post("/api/auth/qrcode/confirm", { qrId, qrToken });
}
