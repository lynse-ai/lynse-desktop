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
