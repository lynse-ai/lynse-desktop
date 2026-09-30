import i18next from "i18next";
import { toast } from "sonner";
import { api } from "@lynse/core/api/client";
import type { CustomerInfo } from "../layout/use-user-credits";

/**
 * Remaining credits as the account card renders them: total points minus
 * consumed points. Returns null when the profile endpoint fails or omits
 * the numbers — callers must stay silent rather than guess.
 */
async function fetchRemainingCredits(): Promise<number | null> {
  try {
    const data = await api().get<CustomerInfo>("/api/business/customer/current");
    const total = typeof data.pointsAmount === "number" ? data.pointsAmount : null;
    if (total === null) return null;
    const used = typeof data.usedPointsAmount === "number" ? data.usedPointsAmount : 0;
    return Math.max(0, total - used);
  } catch {
    return null;
  }
}

/**
 * Submits one cloud-transcription task and toasts the credits the server
 * charged for it. The backend deducts at submission (and refunds via the
 * points log when a transcription later fails), so the charge is known as
 * soon as the POST resolves. The response's `requiredPoints` receipt wins;
 * when the gateway omits it, fall back to diffing the remaining balance
 * across the submission. Stays silent when neither source yields a positive
 * number (e.g. members billed in minutes instead of points, or a local
 * transcription that never reaches the cloud pipeline).
 */
export async function transcribeWithCreditsToast<T extends { requiredPoints?: number }>(
  start: () => Promise<T>,
): Promise<T> {
  const before = await fetchRemainingCredits();
  const result = await start();

  let consumed: number | null =
    typeof result.requiredPoints === "number" && result.requiredPoints > 0
      ? result.requiredPoints
      : null;
  if (consumed === null && before !== null) {
    const after = await fetchRemainingCredits();
    if (after !== null && after < before) {
      consumed = before - after;
    }
  }
  if (consumed !== null) {
    toast.info(i18next.t("workspace.transcription_credits_consumed", { points: consumed }));
  }
  return result;
}
