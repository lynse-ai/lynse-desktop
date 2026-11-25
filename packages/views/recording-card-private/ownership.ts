import { api } from "@lynse/core/api";
import { APP_BASE_PATH } from "@lynse/core/config";
import type { NvEasyDeviceIdentity } from "./nveasy-types";

const messages = {
  recording_card_account_required: "recordingCard.account_required",
  recording_card_identity_unavailable: "recordingCard.identity_unavailable",
  recording_card_not_bound: "recordingCard.not_bound",
  recording_card_not_owned: "recordingCard.not_owned",
  recording_card_verification_unavailable: "recordingCard.verification_unavailable",
} satisfies Record<string, string>;

export function ownershipErrorKey(message: string) {
  if (message.includes("incompatible driver") || message.includes("WinUSB")) {
    return "recordingCard.incompatible_driver";
  }
  if (message.includes("recording card not found")) {
    return "recordingCard.device_not_found";
  }
  return Object.entries(messages).find(([code]) => code === message)?.[1];
}

export function getRecordingCardAccess() {
  const client = api();
  const token = client.getToken();
  if (!token) throw new Error("recording_card_account_required");
  return { apiBaseUrl: client.getBaseUrl(), token };
}

type CardAccess = ReturnType<typeof getRecordingCardAccess>;

export function requireRecordingCardAccess(access: CardAccess) {
  const current = getRecordingCardAccess();
  if (current.token !== access.token || current.apiBaseUrl !== access.apiBaseUrl) {
    throw new Error("recording_card_account_required");
  }
}

export async function verifyBrowserOwnership(
  access: CardAccess,
  identity: NvEasyDeviceIdentity,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  requireRecordingCardAccess(access);
  const { sn, bleMac } = identity;
  if (typeof sn !== "string" || !sn || typeof bleMac !== "string" || !bleMac) {
    throw new Error("recording_card_identity_unavailable");
  }
  let response: Response;
  try {
    response = await fetch(`${APP_BASE_PATH}/api/recording-card/ownership`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: access.token },
      body: JSON.stringify({ apiBaseUrl: access.apiBaseUrl, authSn: sn, bleMac }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
  } catch {
    signal.throwIfAborted();
    throw new Error("recording_card_verification_unavailable");
  }
  signal.throwIfAborted();
  requireRecordingCardAccess(access);
  switch (response.status) {
    case 204:
      return;
    case 401:
      throw new Error("recording_card_account_required");
    case 403:
      throw new Error("recording_card_not_owned");
    default:
      throw new Error("recording_card_verification_unavailable");
  }
}
