import { useQuery } from "@tanstack/react-query";
import { api } from "@lynse/core/api/client";
import { useAuthStore } from "@lynse/core/auth";

export interface CustomerInfo {
  id: string;
  nickname: string;
  phone: string;
  pointsAmount: number;
  usedPointsAmount: number;
  benefitType?: string;
  avatarUrl?: string;
  [key: string]: unknown;
}

export interface MembershipQuota {
  memberLevel?: string;
  purchaseExpireTime?: string;
  cycleStartTime?: string;
  cycleEndTime?: string;
  totalMinutes?: number;
  usedMinutes?: number;
  remainingMinutes?: number;
  freeGiftRemainingMinutes?: number;
  paidPackageRemainingMinutes?: number;
  allRemainingMinutes?: number;
  unlimited?: boolean;
  [key: string]: unknown;
}

export function useUserCredits() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  return useQuery<CustomerInfo>({
    queryKey: ["user", "credits"],
    queryFn: async () => {
      const data = await api().get<Record<string, unknown>>("/api/business/customer/current");
      return data as unknown as CustomerInfo;
    },
    enabled: isAuthenticated,
    staleTime: 60_000,
  });
}

/**
 * Fetches real membership tier and quota via the refresh endpoint.
 * Returns memberLevel, remaining minutes, etc.
 */
export function useMembership() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  return useQuery<MembershipQuota>({
    queryKey: ["user", "membership"],
    queryFn: async () => {
      const data = await api().get<Record<string, unknown>>("/api/business/customer/membership/refresh");
      return data as unknown as MembershipQuota;
    },
    enabled: isAuthenticated,
    staleTime: 60_000,
  });
}

/**
 * Returns true when an error represents "insufficient credits / balance" —
 * e.g. a transcription request rejected because the user ran out of points
 * or membership minutes. The Lynse backend surfaces this either via HTTP 402
 * or a message containing credit/balance keywords (Chinese or English).
 */
export function isInsufficientCreditsError(error: unknown): boolean {
  if (!error) return false;
  const status = (error as { status?: number }).status;
  if (status === 402) return true;
  const message = error instanceof Error ? error.message : String(error);
  if (!message) return false;
  const haystack = message.toLowerCase();
  return (
    haystack.includes("积分") ||
    haystack.includes("点数") ||
    haystack.includes("余额") ||
    haystack.includes("额度") ||
    haystack.includes("时长") ||
    haystack.includes("credit") ||
    haystack.includes("insufficient") ||
    haystack.includes("not enough") ||
    haystack.includes("quota") ||
    haystack.includes("balance") ||
    haystack.includes("expired")
  );
}
